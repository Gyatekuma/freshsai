module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  var key   = process.env.APISPORTS_KEY;
  var today = new Date().toISOString().slice(0, 10);
  if (!key) return res.status(200).json({ error: 'APISPORTS_KEY not set' });
  var H = { 'x-apisports-key': key };

  // Just check status + odds for a known upcoming fixture
  // Copa Libertadores: Lanus fixture ID 1488432 (tomorrow)
  try {
    var [r1, r2] = await Promise.all([
      fetch('https://v3.football.api-sports.io/status', { headers: H }),
      fetch('https://v3.football.api-sports.io/odds?league=13&season=2026&next=5', { headers: H })
    ]);
    var [d1, d2] = await Promise.all([r1.json(), r2.json()]);
    return res.status(200).json({
      today: today,
      requests_used:    d1.response && d1.response.requests && d1.response.requests.current,
      requests_remaining: d1.response && d1.response.requests && (d1.response.requests.limit_day - d1.response.requests.current),
      plan: d1.response && d1.response.subscription && d1.response.subscription.plan,
      odds_next5_cl: {
        count:  d2.results,
        errors: d2.errors,
        sample: d2.response && d2.response.slice(0,2).map(function(o){
          return {
            fixture: o.fixture && o.fixture.id,
            home:    o.teams  && o.teams.home && o.teams.home.name,
            away:    o.teams  && o.teams.away && o.teams.away.name,
            bookmakers_count: o.bookmakers && o.bookmakers.length,
            first_bk: o.bookmakers && o.bookmakers[0] && o.bookmakers[0].name,
            markets:  o.bookmakers && o.bookmakers[0] && o.bookmakers[0].bets && o.bookmakers[0].bets.map(function(b){return b.name;})
          };
        })
      }
    });
  } catch(e) {
    return res.status(200).json({ error: e.message });
  }
};
