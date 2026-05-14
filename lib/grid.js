const axios = require('axios');
const haversine = require('haversine-distance');

const MAX_RESULTS_PER_SEARCH = 60;
const RESULTS_PER_PAGE = 20;
const MIN_CELL_SIZE_KM = 5;
const MAX_SUBDIVISION_DEPTH = 2;
const PAGE_TOKEN_DELAY_MS = 2000;
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
  const totalDiag = cellDiagonalKm(bounds);
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

async function nearbySearchAllPages(lat, lng, keyword, apiKey) {
  const allResults = [];
  let pageToken = null;

  for (let page = 0; page < 3; page++) {
    const params = {
      keyword,
      location: `${lat},${lng}`,
      rankby: 'distance',
      key: apiKey,
    };
    if (pageToken) {
      params.pagetoken = pageToken;
    }

    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
      { params, timeout: 15000 }
    );

    if (response.data.status === 'ZERO_RESULTS') break;
    if (response.data.status !== 'OK') {
      throw new Error(`Places API error: ${response.data.status} - ${response.data.error_message || ''}`);
    }

    for (const place of response.data.results) {
      if (place.geometry && place.geometry.location && (place.vicinity || place.formatted_address)) {
        allResults.push({
          place_id: place.place_id,
          lat: place.geometry.location.lat,
          lng: place.geometry.location.lng,
          name: place.name,
          types: place.types || [],
          vicinity: place.vicinity || '',
        });
      }
    }

    pageToken = response.data.next_page_token;
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

async function adaptiveGridSearch(bounds, keyword, apiKey, onProgress) {
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
    const { bounds: cell, depth } = cellQueue.shift();
    const center = cellCenter(cell);

    let results;
    try {
      console.log(`  Cell ${cellsProcessed + 1}: searching ${center.lat.toFixed(4)},${center.lng.toFixed(4)} (${cellQueue.length} remaining)`);
      results = await nearbySearchAllPages(center.lat, center.lng, keyword, apiKey);
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

    if (results.length >= MAX_RESULTS_PER_SEARCH && depth < MAX_SUBDIVISION_DEPTH) {
      const diagKm = cellDiagonalKm(cell);
      if (diagKm > MIN_CELL_SIZE_KM) {
        const subCells = subdivide(cell);
        cellQueue.push(...subCells.map(c => ({ bounds: c, depth: depth + 1 })));
        cellsSubdivided++;
        console.log(`  -> Subdivided (depth ${depth + 1}, diag ${diagKm.toFixed(1)}km, ${cellQueue.length} in queue)`);
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

const NAME_RELEVANCE_PATTERNS = [/stor/i];

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

async function getPlaceDetails(placeIds, apiKey, onProgress) {
  const results = [];
  const batchSize = 10;

  for (let i = 0; i < placeIds.length; i += batchSize) {
    const batch = placeIds.slice(i, i + batchSize);
    const promises = batch.map(placeId =>
      axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
        params: { key: apiKey, place_id: placeId },
        timeout: 15000,
      }).then(r => r.data).catch(err => {
        console.error(`Details failed for ${placeId}: ${err.message}`);
        return null;
      })
    );

    const batchResults = await Promise.all(promises);

    for (const data of batchResults) {
      if (!data || data.status !== 'OK' || !data.result) continue;
      const place = data.result;
      if (!place.formatted_address) continue;
      results.push(place);
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
