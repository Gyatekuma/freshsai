// Tests API-Sports free tier (api-sports.io)
// 100 req/day free, includes odds + predictions
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  var key   = process.env.APISPORTS_KEY;
  var today = new Date().toISOString().slice(0, 10);
  var result = { today: today, key_set: !!key };
  if (!key) return res.status(200).json({ error: 'APISPORTS_KEY not set in Vercel env vars' });

  var headers = { 'x-apisports-key': key };

  // Test 1: account status + quota
  try {
    var r1 = await fetch('https://v3.football.api-sports.io/status', { headers: headers });
    var d1 = await r1.json();
    result.account = {
      status:     r1.status,
      plan:       d1.response && d1.response.subscription && d1.response.subscription.plan,
      requests_day: d1.response && d1.response.requests && d1.response.requests.current,
      limit_day:    d1.response && d1.response.requests && d1.response.requests.limit_day,
      remaining:    d1.response && d1.response.requests && (d1.response.requests.limit_day - d1.response.requests.current)
    };
  } catch(e) { result.account = { error: e.message }; }

  // Test 2: fixtures for today
  try {
    var r2 = await fetch('https://v3.football.api-sports.io/fixtures?date=' + today, { headers: headers });
    var d2 = await r2.json();
    result.fixtures_today = {
      status:  r2.status,
      count:   d2.results,
      errors:  d2.errors,
      sample:  d2.response && d2.response.slice(0, 2).map(function(f) {
        return {
          id:      f.fixture && f.fixture.id,
          home:    f.teams && f.teams.home && f.teams.home.name,
          away:    f.teams && f.teams.away && f.teams.away.name,
          league:  f.league && f.league.name,
          date:    f.fixture && f.fixture.date
        };
      })
    };
  } catch(e) { result.fixtures_today = { error: e.message }; }

  // Test 3: odds for a sample fixture (use first fixture id if available)
  try {
    var r3 = await fetch('https://v3.football.api-sports.io/odds?date=' + today + '&bookmaker=6', { headers: headers });
    var d3 = await r3.json();
    var first = d3.response && d3.response[0];
    result.odds_sample = {
      status:   r3.status,
      count:    d3.results,
      errors:   d3.errors,
      fixture:  first && first.fixture && first.fixture.id,
      league:   first && first.league && first.league.name,
      home:     first && first.teams && first.teams.home && first.teams.home.name,
      away:     first && first.teams && first.teams.away && first.teams.away.name,
      markets:  first && first.bookmakers && first.bookmakers[0] && first.bookmakers[0].bets && first.bookmakers[0].bets.map(function(b){ return b.name; })
    };
  } catch(e) { result.odds_sample = { error: e.message }; }

  return res.status(200).json(result);
};
