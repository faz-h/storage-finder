const axios = require('axios');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeAddress(address, city, state, zip) {
  if (!address || !city || !state) return null;

  let normalized = address.toLowerCase()
    .replace(/\./g, '')
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(street|st)\b/g, 'st')
    .replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(road|rd)\b/g, 'rd')
    .replace(/\b(boulevard|blvd)\b/g, 'blvd')
    .replace(/\b(drive|dr)\b/g, 'dr')
    .replace(/\b(lane|ln)\b/g, 'ln')
    .replace(/\b(court|ct)\b/g, 'ct')
    .replace(/\b(place|pl)\b/g, 'pl')
    .trim();

  let normalizedCity = city.toLowerCase().trim();
  let normalizedState = state.toLowerCase().trim();
  let normalizedZip = zip ? zip.toString().split('-')[0] : '';

  return `${normalized}|${normalizedCity}|${normalizedState}|${normalizedZip}`;
}

async function fetchAirtableAddresses(accessToken, baseId, tableId) {
  let allRecords = [];
  let offset = null;

  console.log('Fetching addresses from Airtable...');

  do {
    const params = { fields: ['Address', 'City', 'State', 'Zip'], pageSize: 100 };
    if (offset) params.offset = offset;

    const response = await axios.get(
      `https://api.airtable.com/v0/${baseId}/${tableId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params,
      }
    );

    allRecords = allRecords.concat(response.data.records);
    offset = response.data.offset;
    console.log(`Fetched ${allRecords.length} Airtable records so far...`);
  } while (offset);

  console.log(`Total Airtable records: ${allRecords.length}`);

  const normalizedAddresses = new Set();
  allRecords.forEach(record => {
    if (record.fields) {
      const normalized = normalizeAddress(
        record.fields.Address,
        record.fields.City,
        record.fields.State,
        record.fields.Zip
      );
      if (normalized) normalizedAddresses.add(normalized);
    }
  });

  console.log(`Created ${normalizedAddresses.size} normalized addresses for matching`);
  return normalizedAddresses;
}

function extractPlaceFields(place) {
  let streetNumber = '';
  let route = '';
  let city = '';
  let state = '';
  let zip = '';
  let county = '';

  if (place.address_components) {
    for (const comp of place.address_components) {
      const types = comp.types;
      if (types.includes('street_number')) streetNumber = comp.long_name;
      else if (types.includes('route')) route = comp.long_name;
      else if (types.includes('locality')) city = comp.long_name;
      else if (types.includes('administrative_area_level_1')) state = comp.short_name;
      else if (types.includes('postal_code')) zip = comp.short_name;
      else if (types.includes('administrative_area_level_2')) county = comp.long_name;
    }
  }

  return {
    address: `${streetNumber} ${route}`.trim(),
    city,
    state,
    zip,
    county,
  };
}

function isAddressInAirtable(place, airtableAddresses) {
  if (!place || !place.formatted_address || !airtableAddresses) return false;
  const fields = extractPlaceFields(place);
  const normalized = normalizeAddress(fields.address, fields.city, fields.state, fields.zip);
  return normalized && airtableAddresses.has(normalized);
}

async function pushToAirtable(places, accessToken, baseId, tableId, onProgress) {
  const records = places.map(place => {
    const fields = extractPlaceFields(place);
    return {
      fields: {
        'Name': place.name || '',
        'Address': fields.address,
        'City': fields.city,
        'State': fields.state,
        'Zip': fields.zip,
        'County': fields.county,
        'Website': place.website || '',
        'Google Rating': place.rating || null,
        'Google Reviews': place.user_ratings_total || 0,
        'Phone': place.formatted_phone_number || '',
        'Asset Class': 'Storage',
        'Stage': 'Newly Added',
      },
    };
  });

  let created = 0;
  const batchSize = 10;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    try {
      await axios.post(
        `https://api.airtable.com/v0/${baseId}/${tableId}`,
        { records: batch },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
      created += batch.length;
    } catch (err) {
      console.error(`Airtable write failed at batch ${i}: ${err.response?.data?.error?.message || err.message}`);
    }

    if (onProgress) onProgress({ created, total: records.length });
    await delay(250);
  }

  return { created, total: records.length };
}

module.exports = {
  fetchAirtableAddresses,
  isAddressInAirtable,
  pushToAirtable,
  extractPlaceFields,
  normalizeAddress,
};
