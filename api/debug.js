// api/debug.js - check BetMiner response format
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  var apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return res.status(200).json({ error: 'RAPIDAPI_KEY not set' });

  var today = new Date().toISOString().slice(0, 10);
  try {
    var r = await fetch('https://betminer.p.rapidapi.com/bm/v3/edge-analysis/' + today, {
      headers: {
        'Content-Type':    'application/json',
        'x-rapidapi-key':  apiKey,
        'x-rapidapi-host': 'betminer.p.rapidapi.com'
      }
    });
    var text = await r.text();
    var data;
    try { data = JSON.parse(text); } catch(e) { data = { raw: text.slice(0, 1000) }; }
    return res.status(200).json({
      http_status: r.status,
      top_level_keys: typeof data === 'object' ? Object.keys(data) : [],
      total_items: Array.isArray(data) ? data.length : (data && data.length),
      first_item: Array.isArray(data) ? data[0] : (data && data.data && data.data[0]),
      sample: data
    });
  } catch(err) {
    return res.status(200).json({ fetch_error: err.message });
  }
};
