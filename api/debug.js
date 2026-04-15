module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  var rapidKey = process.env.RAPIDAPI_KEY;
  var oddsKey  = process.env.ODDS_API_KEY;
  var today    = new Date().toISOString().slice(0, 10);
  var result   = { today: today };

  // Test BetMiner
  try {
    var r1 = await fetch('https://betminer.p.rapidapi.com/bm/v3/edge-analysis/' + today, {
      headers: {
        'Content-Type':    'application/json',
        'x-rapidapi-key':  rapidKey,
        'x-rapidapi-host': 'betminer.p.rapidapi.com'
      }
    });
    var text1 = await r1.text();
    var d1; try { d1 = JSON.parse(text1); } catch(e) { d1 = { raw: text1.slice(0,300) }; }
    var items = Array.isArray(d1) ? d1 : (d1.data || d1.matches || d1.results || []);
    var first = items[0] || {};
    result.betminer = {
      status: r1.status,
      count: items.length,
      top_level_keys: Object.keys(d1),
      first_item_keys: Object.keys(first),
      first_item_sample: first,
      requests_remaining: r1.headers.get('x-ratelimit-requests-remaining')
    };
  } catch(e) { result.betminer = { error: e.message }; }

  // All soccer leagues on Odds API
  try {
    var r2 = await fetch('https://api.the-odds-api.com/v4/sports/?apiKey=' + oddsKey);
    var sports = await r2.json();
    var soccer = Array.isArray(sports) ? sports.filter(function(s){ return s.group==='Soccer' && s.active; }) : [];
    result.odds_api = {
      status: r2.status,
      requests_remaining: r2.headers.get('x-requests-remaining'),
      soccer_league_count: soccer.length,
      soccer_leagues: soccer.map(function(s){ return s.key; })
    };
  } catch(e) { result.odds_api = { error: e.message }; }

  return res.status(200).json(result);
};
