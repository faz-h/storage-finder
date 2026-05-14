const { extractPlaceFields } = require('./airtable');

function escapeCSV(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function generateCSV(places) {
  const headers = ['Name', 'Address', 'City', 'State', 'Zip', 'County', 'Website', 'Google Rating', 'Google Reviews', 'Phone'];
  const rows = [headers.map(escapeCSV).join(',')];

  for (const place of places) {
    const fields = extractPlaceFields(place);
    const row = [
      place.name || '',
      fields.address,
      fields.city,
      fields.state,
      fields.zip,
      fields.county,
      place.website || '',
      place.rating || '',
      place.user_ratings_total || 0,
      place.formatted_phone_number || '',
    ];
    rows.push(row.map(escapeCSV).join(','));
  }

  return rows.join('\n');
}

module.exports = { generateCSV };
