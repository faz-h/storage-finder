const fs = require('fs');
const path = require('path');
const shapefile = require('shapefile');

const SOURCE_DIR = path.join(__dirname, 'source-data');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'cbsa-data.json');
const SHAPEFILE_PATH = path.join(SOURCE_DIR, 'cb_2023_us_cbsa_20m.shp');
const POP_CSV_PATH = path.join(SOURCE_DIR, 'cbsa-est2024-alldata.csv');
const INCOME_JSON_PATH = path.join(SOURCE_DIR, 'acs-income-cbsa.json');

function parsePopulationCSV() {
  const raw = fs.readFileSync(POP_CSV_PATH, 'utf8');
  const lines = raw.split('\n');
  const popMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.match(/(?:^|,)(?:"([^"]*(?:""[^"]*)*)"|([^",]*))/g);
    if (!parts) continue;
    const clean = parts.map(p => p.replace(/^,/, '').replace(/^"|"$/g, ''));

    const cbsa = clean[0];
    const mdiv = clean[1];
    const stcou = clean[2];
    const lsad = clean[4];
    // Column indices: 5=ESTIMATESBASE2020, 6=POPEST2020, ..., 10=POPEST2024
    const popBase2020 = parseInt(clean[5], 10);
    const pop2024 = parseInt(clean[10], 10);
    // Domestic migration columns: 36=DOMESTICMIG2020, ..., 40=DOMESTICMIG2024
    const domMig2024 = parseInt(clean[40], 10);
    // Net migration columns: 41=NETMIG2020, ..., 45=NETMIG2024
    const netMig2024 = parseInt(clean[45], 10);

    if (mdiv !== '' || stcou !== '') continue;
    if (lsad !== 'Metropolitan Statistical Area' && lsad !== 'Micropolitan Statistical Area') continue;

    const growthPct = popBase2020 > 0
      ? Math.round(((pop2024 - popBase2020) / popBase2020) * 10000) / 100
      : 0;

    const domesticMigPct = pop2024 > 0
      ? Math.round(((domMig2024 || 0) / pop2024) * 10000) / 100
      : 0;

    popMap.set(cbsa, {
      population: pop2024,
      type: lsad === 'Metropolitan Statistical Area' ? 'metro' : 'micro',
      growthPct,
      domesticMig2024: domMig2024 || 0,
      domesticMigPct,
      netMig2024: netMig2024 || 0,
    });
  }

  console.log(`Parsed ${popMap.size} CBSA population entries from CSV`);
  return popMap;
}

function parseIncomeJSON() {
  const incomeMap = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(INCOME_JSON_PATH, 'utf8'));
    const rows = data.response.data;
    // Header: [B19013_001M, GEO_ID, B19013_001EA, B19013_001E, B19013_001MA, NAME]
    for (let i = 1; i < rows.length; i++) {
      const geoId = rows[i][1]; // e.g., "310M700US26420"
      const income = parseInt(rows[i][3], 10);
      const cbsaCode = geoId.replace(/^310M[0-9]+US/, '');
      if (!isNaN(income) && income > 0) {
        incomeMap.set(cbsaCode, income);
      }
    }
    console.log(`Parsed ${incomeMap.size} CBSA income entries from ACS`);
  } catch (err) {
    console.warn('Could not parse income data:', err.message);
  }
  return incomeMap;
}

function computeBounds(geometry) {
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;

  function processCoords(coords) {
    for (const item of coords) {
      if (Array.isArray(item[0])) {
        processCoords(item);
      } else {
        const [lng, lat] = item;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
    }
  }

  processCoords(geometry.coordinates);

  return {
    sw: { lat: Math.round(minLat * 10000) / 10000, lng: Math.round(minLng * 10000) / 10000 },
    ne: { lat: Math.round(maxLat * 10000) / 10000, lng: Math.round(maxLng * 10000) / 10000 },
  };
}

async function buildCBSAData() {
  const popMap = parsePopulationCSV();
  const incomeMap = parseIncomeJSON();

  const cbsaEntries = [];
  const source = await shapefile.open(SHAPEFILE_PATH);

  while (true) {
    const result = await source.read();
    if (result.done) break;

    const props = result.value.properties;
    const code = props.CBSAFP;
    const name = props.NAME;
    const popData = popMap.get(code);

    if (!popData) continue;

    const bounds = computeBounds(result.value.geometry);

    cbsaEntries.push({
      code,
      name,
      type: popData.type,
      population: popData.population,
      growthPct: popData.growthPct,
      medianIncome: incomeMap.get(code) || null,
      domesticMig2024: popData.domesticMig2024,
      domesticMigPct: popData.domesticMigPct,
      netMig2024: popData.netMig2024,
      bounds,
    });
  }

  cbsaEntries.sort((a, b) => b.population - a.population);
  cbsaEntries.forEach((entry, i) => { entry.rank = i + 1; });

  const withIncome = cbsaEntries.filter(e => e.medianIncome !== null).length;
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(cbsaEntries, null, 2));
  console.log(`Wrote ${cbsaEntries.length} CBSA entries to ${OUTPUT_PATH}`);
  console.log(`  Metro: ${cbsaEntries.filter(e => e.type === 'metro').length}`);
  console.log(`  Micro: ${cbsaEntries.filter(e => e.type === 'micro').length}`);
  console.log(`  With income data: ${withIncome}`);
  console.log(`  Top 5: ${cbsaEntries.slice(0, 5).map(e => `${e.name} (growth: ${e.growthPct}%, income: $${e.medianIncome})`).join(', ')}`);
}

buildCBSAData().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
