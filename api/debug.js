// api/debug.js — minimal diagnostics
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  var oddsKey = process.env.ODDS_API_KEY;
  var fdKey   = process.env.FOOTBALL_DATA_KEY;
  // Just check keys are set and Odds API quota remaining
  // Uses 1 request (sports list, free endpoint)
  try {
    var r = await fetch('https://api.the-odds-api.com/v4/sports/?apiKey=' + oddsKey);
    var d = await r.json();
    var soccer = Array.isArray(d) ? d.filter(function(s){return s.group==='Soccer'&&s.active;}).length : 0;
    return res.status(200).json({
      odds_api_key:      !!oddsKey,
      football_data_key: !!fdKey,
      odds_api_status:   r.status,
      requests_remaining: r.headers.get('x-requests-remaining'),
      active_soccer_leagues: soccer
    });
  } catch(e) {
    return res.status(200).json({ error: e.message });
  }
};
