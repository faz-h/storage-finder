const axios = require('axios');

const STATE_BOUNDS = {
  AL: { sw: { lat: 30.22, lng: -88.47 }, ne: { lat: 35.01, lng: -84.89 } },
  AK: { sw: { lat: 51.21, lng: -179.15 }, ne: { lat: 71.39, lng: -129.98 } },
  AZ: { sw: { lat: 31.33, lng: -114.81 }, ne: { lat: 37.00, lng: -109.04 } },
  AR: { sw: { lat: 33.00, lng: -94.62 }, ne: { lat: 36.50, lng: -89.64 } },
  CA: { sw: { lat: 32.53, lng: -124.41 }, ne: { lat: 42.01, lng: -114.13 } },
  CO: { sw: { lat: 36.99, lng: -109.06 }, ne: { lat: 41.00, lng: -102.04 } },
  CT: { sw: { lat: 40.95, lng: -73.73 }, ne: { lat: 42.05, lng: -71.79 } },
  DE: { sw: { lat: 38.45, lng: -75.79 }, ne: { lat: 39.84, lng: -75.05 } },
  FL: { sw: { lat: 24.40, lng: -87.63 }, ne: { lat: 31.00, lng: -80.03 } },
  GA: { sw: { lat: 30.36, lng: -85.61 }, ne: { lat: 35.00, lng: -80.84 } },
  HI: { sw: { lat: 18.91, lng: -160.24 }, ne: { lat: 22.24, lng: -154.81 } },
  ID: { sw: { lat: 41.99, lng: -117.24 }, ne: { lat: 49.00, lng: -111.04 } },
  IL: { sw: { lat: 36.97, lng: -91.51 }, ne: { lat: 42.51, lng: -87.02 } },
  IN: { sw: { lat: 37.77, lng: -88.10 }, ne: { lat: 41.76, lng: -84.78 } },
  IA: { sw: { lat: 40.38, lng: -96.64 }, ne: { lat: 43.50, lng: -90.14 } },
  KS: { sw: { lat: 36.99, lng: -102.05 }, ne: { lat: 40.00, lng: -94.59 } },
  KY: { sw: { lat: 36.50, lng: -89.57 }, ne: { lat: 39.15, lng: -81.96 } },
  LA: { sw: { lat: 28.93, lng: -94.04 }, ne: { lat: 33.02, lng: -89.00 } },
  ME: { sw: { lat: 43.06, lng: -71.08 }, ne: { lat: 47.46, lng: -66.95 } },
  MD: { sw: { lat: 37.91, lng: -79.49 }, ne: { lat: 39.72, lng: -75.05 } },
  MA: { sw: { lat: 41.24, lng: -73.51 }, ne: { lat: 42.89, lng: -69.93 } },
  MI: { sw: { lat: 41.70, lng: -90.42 }, ne: { lat: 48.31, lng: -82.12 } },
  MN: { sw: { lat: 43.50, lng: -97.24 }, ne: { lat: 49.38, lng: -89.49 } },
  MS: { sw: { lat: 30.17, lng: -91.66 }, ne: { lat: 34.99, lng: -88.10 } },
  MO: { sw: { lat: 35.99, lng: -95.77 }, ne: { lat: 40.61, lng: -89.10 } },
  MT: { sw: { lat: 44.36, lng: -116.05 }, ne: { lat: 49.00, lng: -104.04 } },
  NE: { sw: { lat: 39.99, lng: -104.05 }, ne: { lat: 43.00, lng: -95.31 } },
  NV: { sw: { lat: 35.00, lng: -120.01 }, ne: { lat: 42.00, lng: -114.04 } },
  NH: { sw: { lat: 42.70, lng: -72.56 }, ne: { lat: 45.31, lng: -71.09 } },
  NJ: { sw: { lat: 38.93, lng: -75.56 }, ne: { lat: 41.36, lng: -73.89 } },
  NM: { sw: { lat: 31.33, lng: -109.05 }, ne: { lat: 37.00, lng: -103.00 } },
  NY: { sw: { lat: 40.50, lng: -79.76 }, ne: { lat: 45.02, lng: -71.86 } },
  NC: { sw: { lat: 33.84, lng: -84.32 }, ne: { lat: 36.59, lng: -75.46 } },
  ND: { sw: { lat: 45.94, lng: -104.05 }, ne: { lat: 49.00, lng: -96.55 } },
  OH: { sw: { lat: 38.40, lng: -84.82 }, ne: { lat: 41.98, lng: -80.52 } },
  OK: { sw: { lat: 33.62, lng: -103.00 }, ne: { lat: 37.00, lng: -94.43 } },
  OR: { sw: { lat: 41.99, lng: -124.57 }, ne: { lat: 46.29, lng: -116.46 } },
  PA: { sw: { lat: 39.72, lng: -80.52 }, ne: { lat: 42.27, lng: -74.69 } },
  RI: { sw: { lat: 41.15, lng: -71.86 }, ne: { lat: 42.02, lng: -71.12 } },
  SC: { sw: { lat: 32.05, lng: -83.35 }, ne: { lat: 35.22, lng: -78.54 } },
  SD: { sw: { lat: 42.48, lng: -104.06 }, ne: { lat: 45.95, lng: -96.44 } },
  TN: { sw: { lat: 34.98, lng: -90.31 }, ne: { lat: 36.68, lng: -81.65 } },
  TX: { sw: { lat: 25.84, lng: -106.65 }, ne: { lat: 36.50, lng: -93.51 } },
  UT: { sw: { lat: 36.99, lng: -114.05 }, ne: { lat: 42.00, lng: -109.04 } },
  VT: { sw: { lat: 42.73, lng: -73.44 }, ne: { lat: 45.02, lng: -71.46 } },
  VA: { sw: { lat: 36.54, lng: -83.68 }, ne: { lat: 39.47, lng: -75.24 } },
  WA: { sw: { lat: 45.54, lng: -124.85 }, ne: { lat: 49.00, lng: -116.92 } },
  WV: { sw: { lat: 37.20, lng: -82.64 }, ne: { lat: 40.64, lng: -77.72 } },
  WI: { sw: { lat: 42.49, lng: -92.89 }, ne: { lat: 47.08, lng: -86.25 } },
  WY: { sw: { lat: 40.99, lng: -111.06 }, ne: { lat: 45.01, lng: -104.05 } },
  DC: { sw: { lat: 38.79, lng: -77.12 }, ne: { lat: 38.99, lng: -76.91 } },
};

const STATE_NAMES = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC',
};

async function geocodeToCenter(query, apiKey) {
  const url = 'https://maps.googleapis.com/maps/api/geocode/json';
  const response = await axios.get(url, { params: { address: query, key: apiKey } });

  if (response.data.status !== 'OK' || !response.data.results.length) {
    throw new Error(`Geocoding failed for "${query}": ${response.data.status}`);
  }

  const result = response.data.results[0];
  const vp = result.geometry.viewport;
  return {
    center: result.geometry.location,
    viewport: {
      sw: { lat: vp.southwest.lat, lng: vp.southwest.lng },
      ne: { lat: vp.northeast.lat, lng: vp.northeast.lng },
    },
    formattedAddress: result.formatted_address,
  };
}

function resolveStateBounds(input) {
  const normalized = input.trim().toLowerCase();
  const abbrev = normalized.length === 2 ? normalized.toUpperCase() : STATE_NAMES[normalized];
  if (!abbrev || !STATE_BOUNDS[abbrev]) {
    return null;
  }
  return { bounds: STATE_BOUNDS[abbrev], abbrev };
}

async function getBoundsForSearch(searchType, searchValue, apiKey) {
  if (searchType === 'state') {
    const stateInfo = resolveStateBounds(searchValue);
    if (stateInfo) {
      return {
        bounds: stateInfo.bounds,
        label: stateInfo.abbrev,
      };
    }
    throw new Error(`Unknown state: "${searchValue}". Use full name or two-letter abbreviation.`);
  }

  if (searchType === 'zip') {
    const geo = await geocodeToCenter(searchValue, apiKey);
    return {
      bounds: geo.viewport,
      label: searchValue,
    };
  }

  if (searchType === 'city') {
    const geo = await geocodeToCenter(searchValue, apiKey);
    return {
      bounds: geo.viewport,
      label: geo.formattedAddress,
    };
  }

  throw new Error(`Unknown search type: ${searchType}`);
}

module.exports = { getBoundsForSearch, geocodeToCenter, resolveStateBounds, STATE_BOUNDS };
