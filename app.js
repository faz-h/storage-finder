require('dotenv').config();

const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const request = require('request');
const rp = require('request-promise');
var _ = require('lodash');
const ejsLint = require('ejs-lint');
const convert = require('xml-js');
const haversine = require('haversine-distance');
const axios = require('axios');

const { getBoundsForSearch } = require('./lib/geocode');
const { adaptiveGridSearch, getPlaceDetails, preFilterPlaces } = require('./lib/grid');
const { fetchAirtableAddresses, isAddressInAirtable, pushToAirtable } = require('./lib/airtable');
const { generateCSV } = require('./lib/csv');
const { loadCBSAData, getCBSAByCode, loadSearchHistory, updateSearchHistory } = require('./lib/cbsa');

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

const api_key = process.env.GOOGLE_API_KEY;
const AIRTABLE_ACCESS_TOKEN = process.env.AIRTABLE_ACCESS_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID;

/***** BANNED FACILITIES ******/
var bannedFacilities = [
  "Public Storage",
  "CubeSmart Self Storage",
  "Extra Space Storage",
  "SecurCare Self Storage",
  "Life Storage - ",
  "Bolt Storage",
  "Go Store It Self",
  "iStorage",
  "FreeUp",
  "10 Federal", "10Federal",
  "Iron Storage",
  "UHaul",
  "Bee Safe",
  "U-Haul",
  "Metro Self Storage -",
  "Storage Sense -",
  "Storage Zone Self Storage and Business Centers",
  "Red Dot Storage",
  "American Flag Self Storage", "Ample Storage Center",
  "Morningstar Storage",
  "Storage Rentals of America",
  "SmartStop Self Storage",
  "People's Choice Storage",
  "RightSpace Storage",
  "Storage King USA",
  "Simply Self Storage",
  "StorQuest Economy Self Storage",
  "PODS Moving & Storage",
  "Red Shark Storage",
  "Mini Mal Self Storage",
  "Prime Storage",
  "StorageMart",
  "Go Store It",
  "SecureSpace",
  "Store Space Self Storage",
  "Safeguard Self Storage",
  "StorageMax",
  "StorPlace",
  "On Track Storage",
  "SmartStop",
  "Devon",
  "StorageMax",
  "Storage Max",
  "Move It Self Storage",
  "The Storage Center",
  "Bounce Luggage Storage",
  "Midgard",
  "StorEase",
  "Storelocal",
  "Store Space Self Storage",
  "Cloud Storage Solutions",
  "Iron Mountain",
  "PODS",
  "Container King"
];


// In-memory store for long-running area searches
const searches = new Map();
const batches = new Map();

/***** STORAGE FINDER ******/

app.get('/', (req, res) => {
  const cbsaData = loadCBSAData();
  const searchHistory = loadSearchHistory();
  res.render('index', { cbsaData, searchHistory });
});

// Original coordinate-based search
app.post('/search', (req, res) => {
  firstCallParams.qs.keyword = req.body.keyword;
  firstCallParams.qs.location = req.body.coordinates;
  secondCall(req, res);
});

app.get('/detailed', (req, res) => {
  res.render('resultsD', { results: rawResults });
});

app.get('/rawresults', (req, res) => {
  res.send(rawResults);
});

/***** AREA SEARCH (zip/city/state) ******/

app.post('/area-search', async (req, res) => {
  const { searchType, searchValue, keyword, excludeAirtable, excludeBanned, setSkipTrace } = req.body;
  const searchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  searches.set(searchId, {
    status: 'running',
    searchType,
    searchValue,
    keyword: keyword || 'storage',
    excludeAirtable: excludeAirtable === 'on',
    excludeBanned: excludeBanned === 'on',
    setSkipTrace: setSkipTrace === 'on',
    cancelToken: { cancelled: false },
    progress: { phase: 'starting' },
    results: null,
    error: null,
    startedAt: new Date(),
    csv: null,
    airtableResult: null,
  });

  runAreaSearch(searchId).catch(err => {
    console.error(`Area search ${searchId} failed:`, err);
    const search = searches.get(searchId);
    if (search) {
      search.status = 'error';
      search.error = err.message;
    }
  });

  res.redirect(`/area-search/${searchId}`);
});

app.get('/area-search/:id', (req, res) => {
  const search = searches.get(req.params.id);
  if (!search) return res.status(404).send('Search not found');
  res.render('progress', { searchId: req.params.id, search });
});

app.get('/api/search/:id/status', (req, res) => {
  const search = searches.get(req.params.id);
  if (!search) return res.status(404).json({ error: 'Search not found' });
  res.json({
    status: search.status,
    progress: search.progress,
    error: search.error,
    resultCount: search.results ? search.results.length : 0,
    airtableResult: search.airtableResult,
  });
});

app.post('/api/search/:id/cancel', (req, res) => {
  const search = searches.get(req.params.id);
  if (!search) return res.status(404).json({ error: 'Search not found' });
  if (search.status !== 'running') return res.json({ message: 'Search already finished' });
  search.cancelToken.cancelled = true;
  search.status = 'cancelled';
  search.progress = { phase: 'cancelled', message: 'Search cancelled by user.' };
  console.log(`[${req.params.id}] Search cancelled by user`);
  res.json({ message: 'Search cancelled' });
});

app.get('/area-search/:id/results', (req, res) => {
  const search = searches.get(req.params.id);
  if (!search) return res.status(404).send('Search not found');
  if (search.status !== 'complete') return res.redirect(`/area-search/${req.params.id}`);
  res.render('results', {
    proptype: 'storage',
    results: search.results,
    airtableError: false,
    searchMeta: {
      searchType: search.searchType,
      searchValue: search.searchValue,
      stats: search.progress,
      airtableResult: search.airtableResult,
      searchId: req.params.id,
    },
  });
});

app.get('/api/search/:id/csv', (req, res) => {
  const search = searches.get(req.params.id);
  if (!search || !search.csv) return res.status(404).send('CSV not available');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="storage-${search.searchValue}-${Date.now()}.csv"`);
  res.send(search.csv);
});

/***** BATCH SEARCH (markets/CBSA) ******/

app.post('/batch-search', async (req, res) => {
  let cbsaCodes = req.body['cbsaCodes[]'] || req.body.cbsaCodes || [];
  if (!Array.isArray(cbsaCodes)) cbsaCodes = [cbsaCodes];
  if (cbsaCodes.length === 0) return res.redirect('/');

  const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const cbsaItems = cbsaCodes.map(code => {
    const cbsa = getCBSAByCode(code);
    return {
      code,
      name: cbsa ? cbsa.name : code,
      bounds: cbsa ? cbsa.bounds : null,
      searchId: null,
      status: 'pending',
      resultCount: 0,
    };
  });

  batches.set(batchId, {
    status: 'running',
    keyword: req.body.keyword || 'storage',
    excludeAirtable: req.body.excludeAirtable === 'on',
    excludeBanned: req.body.excludeBanned === 'on',
    setSkipTrace: req.body.setSkipTrace === 'on',
    cbsas: cbsaItems,
    currentIndex: 0,
    cancelToken: { cancelled: false },
    startedAt: new Date(),
  });

  runBatchSearch(batchId).catch(err => {
    console.error(`Batch search ${batchId} failed:`, err);
    const batch = batches.get(batchId);
    if (batch) {
      batch.status = 'error';
      batch.error = err.message;
    }
  });

  res.redirect(`/batch-search/${batchId}`);
});

app.get('/batch-search/:id', (req, res) => {
  const batch = batches.get(req.params.id);
  if (!batch) return res.status(404).send('Batch not found');
  res.render('batch-progress', { batchId: req.params.id, batch });
});

app.get('/api/batch/:id/status', (req, res) => {
  const batch = batches.get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  const currentCbsa = batch.cbsas[batch.currentIndex];
  let currentSearchProgress = null;
  if (currentCbsa && currentCbsa.searchId) {
    const currentSearch = searches.get(currentCbsa.searchId);
    if (currentSearch) currentSearchProgress = currentSearch.progress;
  }

  res.json({
    status: batch.status,
    error: batch.error || null,
    currentIndex: batch.currentIndex,
    totalCBSAs: batch.cbsas.length,
    cbsas: batch.cbsas.map(c => ({
      code: c.code,
      name: c.name,
      status: c.status,
      searchId: c.searchId,
      resultCount: c.resultCount,
    })),
    currentSearchProgress,
  });
});

app.post('/api/batch/:id/cancel', (req, res) => {
  const batch = batches.get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.status !== 'running') return res.json({ message: 'Batch already finished' });

  batch.cancelToken.cancelled = true;
  batch.status = 'cancelled';

  const currentCbsa = batch.cbsas[batch.currentIndex];
  if (currentCbsa && currentCbsa.searchId) {
    const currentSearch = searches.get(currentCbsa.searchId);
    if (currentSearch && currentSearch.status === 'running') {
      currentSearch.cancelToken.cancelled = true;
      currentSearch.status = 'cancelled';
      currentSearch.progress = { phase: 'cancelled', message: 'Search cancelled by user.' };
    }
  }

  console.log(`[batch:${req.params.id}] Batch cancelled by user`);
  res.json({ message: 'Batch cancelled' });
});

app.get('/api/batch/:id/csv', (req, res) => {
  const batch = batches.get(req.params.id);
  if (!batch) return res.status(404).send('Batch not found');

  let combined = '';
  let headerWritten = false;
  for (const cbsa of batch.cbsas) {
    if (!cbsa.searchId) continue;
    const search = searches.get(cbsa.searchId);
    if (!search || !search.csv) continue;
    const lines = search.csv.split('\n');
    if (!headerWritten) {
      combined += lines[0] + '\n';
      headerWritten = true;
    }
    combined += lines.slice(1).filter(l => l.trim()).join('\n') + '\n';
  }

  if (!combined) return res.status(404).send('No CSV data available');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="storage-batch-${Date.now()}.csv"`);
  res.send(combined);
});

async function runBatchSearch(batchId) {
  const batch = batches.get(batchId);

  let airtableAddresses = null;
  if (batch.excludeAirtable) {
    try {
      airtableAddresses = await fetchAirtableAddresses(AIRTABLE_ACCESS_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID);
      console.log(`[batch:${batchId}] Pre-fetched ${airtableAddresses.size} Airtable addresses for dedup`);
    } catch (err) {
      console.error(`[batch:${batchId}] Airtable pre-fetch failed: ${err.message}`);
    }
  }

  for (let i = 0; i < batch.cbsas.length; i++) {
    if (batch.cancelToken.cancelled) break;

    const cbsaItem = batch.cbsas[i];
    batch.currentIndex = i;
    cbsaItem.status = 'running';

    const searchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    cbsaItem.searchId = searchId;

    searches.set(searchId, {
      status: 'running',
      searchType: 'cbsa',
      searchValue: cbsaItem.name,
      keyword: batch.keyword,
      excludeAirtable: batch.excludeAirtable,
      excludeBanned: batch.excludeBanned,
      setSkipTrace: batch.setSkipTrace,
      bounds: cbsaItem.bounds,
      cancelToken: batch.cancelToken,
      progress: { phase: 'starting' },
      results: null,
      error: null,
      startedAt: new Date(),
      csv: null,
      airtableResult: null,
      _airtableAddresses: airtableAddresses,
    });

    console.log(`[batch:${batchId}] Starting CBSA ${i + 1}/${batch.cbsas.length}: ${cbsaItem.name}`);

    try {
      await runAreaSearch(searchId);
      const search = searches.get(searchId);
      cbsaItem.status = search.status === 'complete' ? 'complete' : search.status;
      cbsaItem.resultCount = search.results ? search.results.length : 0;

      if (search.status === 'complete') {
        updateSearchHistory(cbsaItem.code, new Date().toISOString());
      }
    } catch (err) {
      console.error(`[batch:${batchId}] CBSA ${cbsaItem.name} failed:`, err.message);
      cbsaItem.status = 'error';
      const search = searches.get(searchId);
      if (search) {
        search.status = 'error';
        search.error = err.message;
      }
    }

    if (batch.cancelToken.cancelled) {
      cbsaItem.status = 'cancelled';
      break;
    }
  }

  if (!batch.cancelToken.cancelled) {
    batch.status = 'complete';
    console.log(`[batch:${batchId}] Batch complete`);
  }
}

async function runAreaSearch(searchId) {
  const search = searches.get(searchId);

  // Phase 1: Geocode the search area (or use pre-supplied bounds for CBSA batch searches)
  let bounds;
  if (search.bounds) {
    bounds = search.bounds;
    console.log(`[${searchId}] Using pre-supplied bounds for: ${search.searchValue}`);
  } else {
    search.progress = { phase: 'geocoding', message: `Geocoding ${search.searchType}: ${search.searchValue}` };
    console.log(`[${searchId}] Geocoding ${search.searchType}: ${search.searchValue}`);
    const geocodeResult = await getBoundsForSearch(search.searchType, search.searchValue, api_key);
    bounds = geocodeResult.bounds;
  }
  console.log(`[${searchId}] Bounds: SW(${bounds.sw.lat},${bounds.sw.lng}) NE(${bounds.ne.lat},${bounds.ne.lng})`);

  // Phase 2: Adaptive grid search
  search.progress = { phase: 'searching', message: 'Starting grid search...' };
  console.log(`[${searchId}] Starting adaptive grid search`);

  const gridResult = await adaptiveGridSearch(bounds, search.keyword, api_key, (prog) => {
    search.progress = {
      phase: 'searching',
      message: `Searched ${prog.cellsProcessed}/${prog.totalInitialCells + (prog.cellsSubdivided * 3)} cells, found ${prog.uniquePlacesFound} unique places (${prog.cellsSubdivided} subdivisions)`,
      ...prog,
    };
  }, search.cancelToken);

  if (search.cancelToken.cancelled) return;

  console.log(`[${searchId}] Grid search complete: ${gridResult.placeIds.length} unique places from ${gridResult.stats.searchesMade} searches`);

  // Phase 3: Pre-filter before Details (saves API calls)
  search.progress = { phase: 'pre-filter', message: 'Pre-filtering to reduce Details API calls...' };
  console.log(`[${searchId}] Pre-filtering ${gridResult.places.length} places`);

  let placesToDetail = gridResult.places;

  placesToDetail = preFilterPlaces(placesToDetail, {
    bannedFacilities: search.excludeBanned ? bannedFacilities : null,
    bounds,
    requiredTypes: ['storage'],
    requireRelevantName: true,
  });

  // Airtable pre-dedup using name+vicinity (rough match to avoid Details calls)
  if (search.excludeAirtable) {
    search.progress = { phase: 'airtable-dedup', message: 'Checking against Airtable for duplicates...' };
    try {
      const airtableAddresses = await fetchAirtableAddresses(AIRTABLE_ACCESS_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID);
      // Store for post-Details dedup too
      search._airtableAddresses = airtableAddresses;
      console.log(`[${searchId}] Loaded ${airtableAddresses.size} Airtable addresses for dedup`);
    } catch (err) {
      console.error(`[${searchId}] Airtable dedup failed: ${err.message}`);
    }
  }

  const placeIdsToDetail = placesToDetail.map(p => p.place_id);
  console.log(`[${searchId}] Fetching details for ${placeIdsToDetail.length} places (saved ${gridResult.placeIds.length - placeIdsToDetail.length} Details calls)`);

  // Phase 4: Fetch place details
  search.progress = { phase: 'details', message: `Fetching details for ${placeIdsToDetail.length} places...` };

  const detailedResults = await getPlaceDetails(placeIdsToDetail, api_key, (prog) => {
    search.progress = {
      phase: 'details',
      message: `Fetched details: ${prog.detailsFetched}/${prog.totalToFetch} (${prog.validResults} valid)`,
      ...prog,
    };
  });

  console.log(`[${searchId}] Got ${detailedResults.length} detailed results`);

  let filteredResults = detailedResults;

  // Phase 5: Precise Airtable dedup using full address from Details
  if (search.excludeAirtable && search._airtableAddresses) {
    filteredResults = filteredResults.filter(x => !isAddressInAirtable(x, search._airtableAddresses));
    console.log(`[${searchId}] After Airtable dedup: ${filteredResults.length}`);
  }

  // Remove duplicates by formatted_address
  const seen = new Set();
  filteredResults = filteredResults.filter(place => {
    if (seen.has(place.formatted_address)) return false;
    seen.add(place.formatted_address);
    return true;
  });
  console.log(`[${searchId}] Final result count: ${filteredResults.length}`);

  // Phase 6: Generate CSV
  search.progress = { phase: 'csv', message: 'Generating CSV...' };
  search.csv = generateCSV(filteredResults);

  // Phase 7: Push to Airtable
  search.progress = { phase: 'airtable-push', message: `Pushing ${filteredResults.length} records to Airtable...` };
  console.log(`[${searchId}] Pushing ${filteredResults.length} records to Airtable`);

  try {
    const stage = search.setSkipTrace ? 'Skip Trace' : 'Newly Added';
    search.airtableResult = await pushToAirtable(
      filteredResults,
      AIRTABLE_ACCESS_TOKEN,
      AIRTABLE_BASE_ID,
      AIRTABLE_TABLE_ID,
      (prog) => {
        search.progress = {
          phase: 'airtable-push',
          message: `Pushed ${prog.created}/${prog.total} records to Airtable`,
          ...prog,
        };
      },
      stage
    );
    console.log(`[${searchId}] Airtable push complete: ${search.airtableResult.created}/${search.airtableResult.total}`);
  } catch (err) {
    console.error(`[${searchId}] Airtable push failed: ${err.message}`);
    search.airtableResult = { created: 0, total: filteredResults.length, error: err.message };
  }

  // Done
  search.results = filteredResults;
  search.status = 'complete';
  search.progress = {
    phase: 'complete',
    message: `Done! Found ${filteredResults.length} facilities.`,
    ...gridResult.stats,
    finalCount: filteredResults.length,
  };
}


/***** ORIGINAL COORDINATE SEARCH (preserved) ******/

var rawResults = {};
var existingAddresses;

var searchKeyword = 'storage';
var searchLat = 38.281187576674796;
var searchLng = -78.41468841724287;
var coordinates = searchLat + ',' + searchLng;

var firstCallParams = {
  url: 'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
  json: true,
  method: 'GET',
  qs: {
    keyword: 'storage',
    location: coordinates,
    rankby: 'distance',
    key: api_key,
  },
};

async function firstCall(res) {
  let resultsArray = [];
  let callObj;
  let i = 0;

  while (i < 3) {
    try {
      callObj = await rp(firstCallParams);
      for (let j = 0; j < callObj.results.length; j++) {
        const place = callObj.results[j];
        if (place.geometry &&
          place.geometry.location &&
          (place.vicinity || place.formatted_address) &&
          place.geometry.location.lat &&
          place.geometry.location.lng) {
          resultsArray.push(place.place_id);
        } else {
          console.log(`EXCLUDED (no address): ${place.name || 'Unknown'} - ${place.vicinity || 'No vicinity'}`);
        }
      }
      var nextPage = callObj.next_page_token;
    } catch (err) {
      console.log(err);
    }

    firstCallParams.qs.pagetoken = nextPage;
    i++;
    await delay(3000);
  }

  console.log('First call had ' + resultsArray.length + ' places with valid addresses');
  return resultsArray;
}

async function secondCall(req, res) {
  const input = await firstCall();
  let resultsArray = [];
  let resultsArrayTwo = [];
  let secondCallArray = [];
  let callObj;
  let airtableAddresses = null;
  let airtableError = false;

  const excludeAirtable = req.body.excludeAirtable === 'on';
  console.log('Airtable exclusion enabled:', excludeAirtable);

  if (excludeAirtable) {
    try {
      airtableAddresses = await fetchAirtableAddresses(AIRTABLE_ACCESS_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID);
    } catch (error) {
      console.error('Failed to fetch Airtable addresses:', error.message);
      airtableError = true;
    }
  }

  for (i = 0; i < input.length; i++) {
    secondCallArray.push({
      url: 'https://maps.googleapis.com/maps/api/place/details/json',
      json: true,
      method: 'GET',
      qs: {
        key: api_key,
        place_id: input[i],
      },
    });
  }

  let requestsArray = secondCallArray.map((call) => {
    return rp(call);
  });

  const excludeBanned = req.body.excludeBanned === 'on';

  await Promise.all(requestsArray).then(allResults => {
    let resultsArray = allResults;

    if (excludeAirtable && airtableAddresses && !airtableError) {
      resultsArray = resultsArray.filter(x => !isAddressInAirtable(x.result, airtableAddresses));
      console.log('After removing Airtable duplicates: ' + resultsArray.length);
    }

    if (excludeBanned) {
      for (var i = 0; i < resultsArray.length; i++) {
        var check = true;
        for (var j = 0; j < bannedFacilities.length; j++) {
          if (resultsArray[i].result.name.includes(bannedFacilities[j])) {
            console.log(resultsArray[i].result.name);
            check = false;
          }
        }
        if (check == true) {
          resultsArrayTwo.push(resultsArray[i].result);
        }
      }
      console.log('After removing banned facilities: ' + resultsArrayTwo.length);
    } else {
      for (var i = 0; i < resultsArray.length; i++) {
        resultsArrayTwo.push(resultsArray[i].result);
      }
    }

    _.uniq(resultsArrayTwo);
    console.log('After removing dups: ' + resultsArrayTwo.length);
    rawResults = resultsArrayTwo;

  }).catch(e => res.send(e));

  res.render('results', {
    proptype: req.body.proptype,
    results: resultsArrayTwo,
    airtableError: airtableError && excludeAirtable,
    searchMeta: null,
  });
}

/***** RANDOM FUNCS ******/

function delay(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

/***********/

app.listen(process.env.PORT || 300, async () => {
  console.log('STORAGE FINDER');
});
