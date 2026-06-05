const fs = require('fs');
const path = require('path');

const CBSA_DATA_PATH = path.join(__dirname, '..', 'data', 'cbsa-data.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'search-history.json');

// Durable search history:
//   - On App Engine the app filesystem is read-only, so history is stored in
//     Cloud Storage (the default App Engine bucket) and survives instance
//     restarts and is shared across instances.
//   - Locally (or anywhere not on GAE) it falls back to the bundled JSON file.
const ON_GAE = !!(process.env.GAE_ENV || process.env.GAE_APPLICATION);
const HISTORY_BUCKET = process.env.HISTORY_BUCKET ||
  (process.env.GOOGLE_CLOUD_PROJECT ? `${process.env.GOOGLE_CLOUD_PROJECT}.appspot.com` : null);
const HISTORY_OBJECT = 'search-history.json';
const USE_GCS = ON_GAE && !!HISTORY_BUCKET;

let cbsaCache = null;
let cbsaByCode = null;
let _historyFile = null;

function loadCBSAData() {
  if (!cbsaCache) {
    cbsaCache = JSON.parse(fs.readFileSync(CBSA_DATA_PATH, 'utf8'));
    cbsaByCode = new Map(cbsaCache.map(entry => [entry.code, entry]));
  }
  return cbsaCache;
}

function getCBSAByCode(code) {
  if (!cbsaByCode) loadCBSAData();
  return cbsaByCode.get(code) || null;
}

function historyFile() {
  if (!_historyFile) {
    const { Storage } = require('@google-cloud/storage');
    _historyFile = new Storage().bucket(HISTORY_BUCKET).file(HISTORY_OBJECT);
  }
  return _historyFile;
}

async function loadSearchHistory() {
  if (USE_GCS) {
    try {
      const [buf] = await historyFile().download();
      return JSON.parse(buf.toString('utf8'));
    } catch (err) {
      if (err.code !== 404) console.warn(`Could not load search history from GCS: ${err.message}`);
      return {};
    }
  }
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch (err) {
    return {};
  }
}

async function updateSearchHistory(cbsaCode, timestamp) {
  // Best-effort: must never throw and fail the search that triggered it.
  const history = await loadSearchHistory();
  history[cbsaCode] = timestamp;
  const payload = JSON.stringify(history, null, 2);

  if (USE_GCS) {
    try {
      await historyFile().save(payload, { contentType: 'application/json', resumable: false });
    } catch (err) {
      console.error(`Could not persist search history to GCS for ${cbsaCode}: ${err.message}`);
    }
    return;
  }
  try {
    fs.writeFileSync(HISTORY_PATH, payload);
  } catch (err) {
    console.warn(`Could not persist search history for ${cbsaCode}: ${err.message}`);
  }
}

module.exports = { loadCBSAData, getCBSAByCode, loadSearchHistory, updateSearchHistory };
