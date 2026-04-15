// api/debug.js — temporary diagnostic endpoint
// Visit /api/debug to see exactly what RapidAPI returns
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  var apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return res.status(200).json({ error: 'RAPIDAPI_KEY not set' });

  var today = new Date().toISOString().slice(0, 10);
  try {
    var r = await fetch('https://api-football-v1.p.rapidapi.com/v3/fixtures?date=' + today, {
      headers: {
        'X-RapidAPI-Key':  apiKey,
        'X-RapidAPI-Host': 'api-football-v1.p.rapidapi.com'
      }
    });
    var text = await r.text();
    var data;
    try { data = JSON.parse(text); } catch(e) { data = text; }
    return res.status(200).json({
      http_status: r.status,
      response_keys: typeof data === 'object' ? Object.keys(data) : 'not json',
      results_count: data && data.results,
      error_field: data && data.errors,
      first_fixture: data && data.response && data.response[0],
      raw_preview: typeof data === 'string' ? data.slice(0, 500) : undefined
    });
  } catch(err) {
    return res.status(200).json({ fetch_error: err.message });
  }
};
