const fs = require('fs');
const os = require('os');
const path = require('path');

const CBSA_DATA_PATH = path.join(__dirname, '..', 'data', 'cbsa-data.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'search-history.json');
// App Engine's app filesystem is read-only; fall back to a writable temp path
// there so recording history never crashes a search. (Per-instance and
// ephemeral, but the bundled HISTORY_PATH still seeds reads.)
const HISTORY_FALLBACK_PATH = path.join(os.tmpdir(), 'storage-finder-search-history.json');

let cbsaCache = null;
let cbsaByCode = null;

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

function loadSearchHistory() {
  // Prefer the writable fallback (most recent on read-only hosts), then the
  // bundled file. Either missing/corrupt just yields an empty history.
  for (const p of [HISTORY_FALLBACK_PATH, HISTORY_PATH]) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      // try next source
    }
  }
  return {};
}

function updateSearchHistory(cbsaCode, timestamp) {
  // Best-effort bookkeeping: must never throw and fail the search that triggered
  // it. Try the bundled path first, then a writable temp path on read-only hosts.
  const history = loadSearchHistory();
  history[cbsaCode] = timestamp;
  const payload = JSON.stringify(history, null, 2);
  for (const p of [HISTORY_PATH, HISTORY_FALLBACK_PATH]) {
    try {
      fs.writeFileSync(p, payload);
      return;
    } catch (err) {
      // read-only or unwritable; try the next location
    }
  }
  console.warn(`Could not persist search history for ${cbsaCode}: no writable location`);
}

module.exports = { loadCBSAData, getCBSAByCode, loadSearchHistory, updateSearchHistory };
