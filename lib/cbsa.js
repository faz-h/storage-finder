const fs = require('fs');
const path = require('path');

const CBSA_DATA_PATH = path.join(__dirname, '..', 'data', 'cbsa-data.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'search-history.json');

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
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch (err) {
    return {};
  }
}

function updateSearchHistory(cbsaCode, timestamp) {
  const history = loadSearchHistory();
  history[cbsaCode] = timestamp;
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

module.exports = { loadCBSAData, getCBSAByCode, loadSearchHistory, updateSearchHistory };
