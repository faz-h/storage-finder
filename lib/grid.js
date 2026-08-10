const axios = require('axios');
const haversine = require('haversine-distance');

// Places API (New). The legacy Places API stopped honoring next_page_token
// in Aug 2026 (every pagetoken request returned INVALID_REQUEST), which
// silently emptied out dense markets.
const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const DETAILS_URL = 'https://places.googleapis.com/v1/places';
const SEARCH_FIELD_MASK = 'places.id,places.displayName,places.types,places.location,nextPageToken';
const DETAILS_FIELD_MASK = [
  'id', 'displayName', 'formattedAddress', 'addressComponents', 'location',
  'websiteUri', 'nationalPhoneNumber', 'rating', 'userRatingCount', 'types',
].join(',');

const MAX_RESULTS_PER_SEARCH = 60;
const RESULTS_PER_PAGE = 20;
const MIN_CELL_SIZE_KM = 5;
const MAX_SUBDIVISION_DEPTH = 2;
const PAGE_TOKEN_DELAY_MS = 1000;
const PAGE_RETRY_DELAY_MS = 2000;
const REQUEST_DELAY_MS = 150;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cellDiagonalKm(bounds) {
  const sw = { latitude: bounds.sw.lat, longitude: bounds.sw.lng };
  const ne = { latitude: bounds.ne.lat, longitude: bounds.ne.lng };
  return haversine(sw, ne) / 1000;
}

function cellCenter(bounds) {
  return {
    lat: (bounds.sw.lat + bounds.ne.lat) / 2,
    lng: (bounds.sw.lng + bounds.ne.lng) / 2,
  };
}

function subdivide(bounds) {
  const midLat = (bounds.sw.lat + bounds.ne.lat) / 2;
  const midLng = (bounds.sw.lng + bounds.ne.lng) / 2;
  return [
    { sw: { lat: bounds.sw.lat, lng: bounds.sw.lng }, ne: { lat: midLat, lng: midLng } },
    { sw: { lat: bounds.sw.lat, lng: midLng }, ne: { lat: midLat, lng: bounds.ne.lng } },
    { sw: { lat: midLat, lng: bounds.sw.lng }, ne: { lat: bounds.ne.lat, lng: midLng } },
    { sw: { lat: midLat, lng: midLng }, ne: { lat: bounds.ne.lat, lng: bounds.ne.lng } },
  ];
}

function generateInitialGrid(bounds, cellSizeKm) {
  const latRange = bounds.ne.lat - bounds.sw.lat;
  const lngRange = bounds.ne.lng - bounds.sw.lng;
  const totalHeightKm = haversine(
    { latitude: bounds.sw.lat, longitude: bounds.sw.lng },
    { latitude: bounds.ne.lat, longitude: bounds.sw.lng }
  ) / 1000;
  const totalWidthKm = haversine(
    { latitude: bounds.sw.lat, longitude: bounds.sw.lng },
    { latitude: bounds.sw.lat, longitude: bounds.ne.lng }
  ) / 1000;

  const rows = Math.max(1, Math.ceil(totalHeightKm / cellSizeKm));
  const cols = Math.max(1, Math.ceil(totalWidthKm / cellSizeKm));
  const latStep = latRange / rows;
  const lngStep = lngRange / cols;

  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        sw: { lat: bounds.sw.lat + r * latStep, lng: bounds.sw.lng + c * lngStep },
        ne: { lat: bounds.sw.lat + (r + 1) * latStep, lng: bounds.sw.lng + (c + 1) * lngStep },
      });
    }
  }

  return { cells, rows, cols };
}

async function textSearchRequest(body, apiKey) {
  try {
    const response = await axios.post(TEXT_SEARCH_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': SEARCH_FIELD_MASK,
      },
      timeout: 15000,
    });
    return response.data;
  } catch (err) {
    const apiError = err.response && err.response.data && err.response.data.error;
    throw new Error(`Places API error: ${apiError ? `${apiError.status} - ${apiError.message}` : err.message}`);
  }
}

// Text Search (New) with a rectangle restriction returns only places inside
// the cell, paged 20 at a time up to 60.
async function textSearchAllPages(cellBounds, keyword, apiKey) {
  const allResults = [];
  let pageToken = null;

  for (let page = 0; page < MAX_RESULTS_PER_SEARCH / RESULTS_PER_PAGE; page++) {
    const body = {
      textQuery: keyword,
      pageSize: RESULTS_PER_PAGE,
      locationRestriction: {
        rectangle: {
          low: { latitude: cellBounds.sw.lat, longitude: cellBounds.sw.lng },
          high: { latitude: cellBounds.ne.lat, longitude: cellBounds.ne.lng },
        },
      },
    };
    if (pageToken) body.pageToken = pageToken;

    let data;
    try {
      data = await textSearchRequest(body, apiKey);
    } catch (err) {
      if (page === 0) throw err;
      // Never discard pages already fetched: retry once (token may not be
      // active yet), then keep what we have.
      await delay(PAGE_RETRY_DELAY_MS);
      try {
        data = await textSearchRequest(body, apiKey);
      } catch (retryErr) {
        console.error(`  Page ${page + 1} failed twice (${retryErr.message}); keeping ${allResults.length} results from earlier pages`);
        break;
      }
    }

    for (const place of data.places || []) {
      if (place.id && place.location) {
        allResults.push({
          place_id: place.id,
          lat: place.location.latitude,
          lng: place.location.longitude,
          name: place.displayName ? place.displayName.text : '',
          types: place.types || [],
        });
      }
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
    await delay(PAGE_TOKEN_DELAY_MS);
  }

  return allResults;
}

function chooseCellSize(bounds) {
  const diag = cellDiagonalKm(bounds);
  if (diag < 10) return null;
  if (diag < 50) return 8;
  if (diag < 200) return 15;
  if (diag < 500) return 30;
  return 50;
}

async function adaptiveGridSearch(bounds, keyword, apiKey, onProgress, cancelToken) {
  const allPlaceIds = new Map();
  let searchesMade = 0;
  let cellsProcessed = 0;
  let cellsSubdivided = 0;

  const cellSize = chooseCellSize(bounds);
  let cellQueue;

  if (cellSize === null) {
    cellQueue = [{ bounds, depth: 0 }];
  } else {
    const grid = generateInitialGrid(bounds, cellSize);
    cellQueue = grid.cells.map(c => ({ bounds: c, depth: 0 }));
  }

  const totalInitialCells = cellQueue.length;

  const progress = () => ({
    searchesMade,
    cellsProcessed,
    cellsSubdivided,
    totalInitialCells,
    uniquePlacesFound: allPlaceIds.size,
    remainingCells: cellQueue.length,
  });

  if (onProgress) onProgress(progress());

  while (cellQueue.length > 0) {
    if (cancelToken && cancelToken.cancelled) {
      console.log('  Search cancelled by user');
      break;
    }
    const { bounds: cell, depth } = cellQueue.shift();
    const center = cellCenter(cell);

    let results;
    try {
      console.log(`  Cell ${cellsProcessed + 1}: searching ${center.lat.toFixed(4)},${center.lng.toFixed(4)} (${cellQueue.length} remaining)`);
      results = await textSearchAllPages(cell, keyword, apiKey);
      console.log(`  Cell ${cellsProcessed + 1}: found ${results.length} results`);
      searchesMade++;
    } catch (err) {
      console.error(`Search failed at ${center.lat},${center.lng}: ${err.message}`);
      searchesMade++;
      cellsProcessed++;
      if (onProgress) onProgress(progress());
      await delay(REQUEST_DELAY_MS);
      continue;
    }

    for (const place of results) {
      if (!allPlaceIds.has(place.place_id)) {
        allPlaceIds.set(place.place_id, place);
      }
    }

    // The rectangle restriction means every result is inside the cell, so
    // hitting the 60-result cap signals possible truncation -- subdivide.
    if (results.length >= MAX_RESULTS_PER_SEARCH && depth < MAX_SUBDIVISION_DEPTH) {
      const diagKm = cellDiagonalKm(cell);
      if (diagKm > MIN_CELL_SIZE_KM) {
        const subCells = subdivide(cell);
        cellQueue.push(...subCells.map(c => ({ bounds: c, depth: depth + 1 })));
        cellsSubdivided++;
        console.log(`  -> Subdivided (depth ${depth + 1}, diag ${diagKm.toFixed(1)}km, ${cellQueue.length} in queue)`);
      } else {
        console.log(`  -> Cell hit ${results.length}-result cap but is too small to subdivide (diag ${diagKm.toFixed(1)}km); results may be truncated`);
      }
    }

    cellsProcessed++;
    if (onProgress) onProgress(progress());
    await delay(REQUEST_DELAY_MS);
  }

  return {
    placeIds: Array.from(allPlaceIds.keys()),
    places: Array.from(allPlaceIds.values()),
    stats: progress(),
  };
}

const NAME_RELEVANCE_PATTERNS = [/stor/i, /mini[- ]?warehouses?/i];

function preFilterPlaces(places, { bannedFacilities, bounds, requiredTypes, requireRelevantName }) {
  const before = places.length;
  let filtered = places;

  if (requireRelevantName) {
    const beforeName = filtered.length;
    const rejected = [];
    filtered = filtered.filter(p => {
      if (!p.name) return false;
      const match = NAME_RELEVANCE_PATTERNS.some(re => re.test(p.name));
      if (!match) rejected.push(p.name);
      return match;
    });
    if (beforeName - filtered.length > 0) {
      console.log(`  Pre-filter: name relevance removed ${beforeName - filtered.length} (${filtered.length} remain)`);
      if (rejected.length <= 20) {
        rejected.forEach(n => console.log(`    rejected: "${n}"`));
      }
    }
  }

  if (bannedFacilities && bannedFacilities.length > 0) {
    const beforeBanned = filtered.length;
    filtered = filtered.filter(p => {
      for (const banned of bannedFacilities) {
        if (p.name && p.name.includes(banned)) return false;
      }
      return true;
    });
    if (beforeBanned - filtered.length > 0) {
      console.log(`  Pre-filter: banned names removed ${beforeBanned - filtered.length} (${filtered.length} remain)`);
    }
  }

  if (bounds) {
    const beforeBounds = filtered.length;
    filtered = filtered.filter(p =>
      p.lat >= bounds.sw.lat && p.lat <= bounds.ne.lat &&
      p.lng >= bounds.sw.lng && p.lng <= bounds.ne.lng
    );
    if (beforeBounds - filtered.length > 0) {
      console.log(`  Pre-filter: out-of-bounds removed ${beforeBounds - filtered.length} (${filtered.length} remain)`);
    }
  }

  if (requiredTypes && requiredTypes.length > 0) {
    const beforeTypes = filtered.length;
    filtered = filtered.filter(p =>
      p.types && p.types.some(t => requiredTypes.includes(t))
    );
    if (beforeTypes - filtered.length > 0) {
      console.log(`  Pre-filter: type mismatch removed ${beforeTypes - filtered.length} (${filtered.length} remain)`);
    }
  }

  console.log(`  Pre-filter total: ${before} -> ${filtered.length} (saved ${before - filtered.length} Details calls)`);
  return filtered;
}

// Downstream code (views, CSV export, Airtable push) was written against the
// legacy Place Details response shape; keep serving that shape.
function toLegacyPlace(p) {
  return {
    place_id: p.id,
    name: p.displayName ? p.displayName.text : '',
    formatted_address: p.formattedAddress,
    address_components: (p.addressComponents || []).map(c => ({
      long_name: c.longText,
      short_name: c.shortText,
      types: c.types || [],
    })),
    geometry: p.location
      ? { location: { lat: p.location.latitude, lng: p.location.longitude } }
      : undefined,
    website: p.websiteUri || '',
    formatted_phone_number: p.nationalPhoneNumber || '',
    rating: p.rating || null,
    user_ratings_total: p.userRatingCount || 0,
    types: p.types || [],
  };
}

async function getPlaceDetails(placeIds, apiKey, onProgress) {
  const results = [];
  const batchSize = 10;

  for (let i = 0; i < placeIds.length; i += batchSize) {
    const batch = placeIds.slice(i, i + batchSize);
    const promises = batch.map(placeId =>
      axios.get(`${DETAILS_URL}/${placeId}`, {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': DETAILS_FIELD_MASK,
        },
        timeout: 15000,
      }).then(r => r.data).catch(err => {
        const apiError = err.response && err.response.data && err.response.data.error;
        console.error(`Details failed for ${placeId}: ${apiError ? apiError.message : err.message}`);
        return null;
      })
    );

    const batchResults = await Promise.all(promises);

    for (const place of batchResults) {
      if (!place || !place.formattedAddress) continue;
      results.push(toLegacyPlace(place));
    }

    if (onProgress) {
      onProgress({
        detailsFetched: Math.min(i + batchSize, placeIds.length),
        totalToFetch: placeIds.length,
        validResults: results.length,
      });
    }

    await delay(REQUEST_DELAY_MS);
  }

  return results;
}

module.exports = {
  adaptiveGridSearch,
  getPlaceDetails,
  preFilterPlaces,
  generateInitialGrid,
  cellDiagonalKm,
};
