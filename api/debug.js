module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  var rapidKey = process.env.RAPIDAPI_KEY;
  var today = new Date().toISOString().slice(0, 10);

  try {
    var r = await fetch('https://betminer.p.rapidapi.com/bm/v3/edge-analysis/' + today, {
      headers: {
        'Content-Type':    'application/json',
        'x-rapidapi-key':  rapidKey,
        'x-rapidapi-host': 'betminer.p.rapidapi.com'
      }
    });
    var text = await r.text();
    var data; try { data = JSON.parse(text); } catch(e) { data = { raw: text.slice(0,200) }; }
    return res.status(200).json({
      http_status: r.status,
      requests_remaining:   r.headers.get('x-ratelimit-requests-remaining'),
      requests_limit:       r.headers.get('x-ratelimit-requests-limit'),
      requests_reset:       r.headers.get('x-ratelimit-requests-reset'),
      ratelimit_reset:      r.headers.get('x-ratelimit-reset'),
      count: data && data.data ? data.data.length : 0,
      error: data && data.message,
      all_headers: Object.fromEntries([...r.headers.entries()])
    });
  } catch(e) {
    return res.status(200).json({ error: e.message });
  }
};
