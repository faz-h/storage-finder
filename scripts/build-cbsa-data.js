const fs = require('fs');
const path = require('path');
const shapefile = require('shapefile');

const SOURCE_DIR = path.join(__dirname, 'source-data');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'cbsa-data.json');
const SHAPEFILE_PATH = path.join(SOURCE_DIR, 'cb_2023_us_cbsa_20m.shp');
const POP_CSV_PATH = path.join(SOURCE_DIR, 'cbsa-est2024-alldata.csv');

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
    const pop2024 = parseInt(clean[10], 10);

    if (mdiv !== '' || stcou !== '') continue;
    if (lsad !== 'Metropolitan Statistical Area' && lsad !== 'Micropolitan Statistical Area') continue;

    popMap.set(cbsa, {
      population: pop2024,
      type: lsad === 'Metropolitan Statistical Area' ? 'metro' : 'micro',
    });
  }

  console.log(`Parsed ${popMap.size} CBSA population entries from CSV`);
  return popMap;
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
      bounds,
    });
  }

  cbsaEntries.sort((a, b) => b.population - a.population);
  cbsaEntries.forEach((entry, i) => { entry.rank = i + 1; });

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(cbsaEntries, null, 2));
  console.log(`Wrote ${cbsaEntries.length} CBSA entries to ${OUTPUT_PATH}`);
  console.log(`  Metro: ${cbsaEntries.filter(e => e.type === 'metro').length}`);
  console.log(`  Micro: ${cbsaEntries.filter(e => e.type === 'micro').length}`);
  console.log(`  Top 5: ${cbsaEntries.slice(0, 5).map(e => e.name).join(', ')}`);
  console.log(`  Bottom 5: ${cbsaEntries.slice(-5).map(e => e.name).join(', ')}`);
}

buildCBSAData().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
