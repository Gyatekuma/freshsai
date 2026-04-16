// api/debug.js — diagnostic (Odds API only, no BetMiner)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  var oddsKey = process.env.ODDS_API_KEY;
  var fdKey   = process.env.FOOTBALL_DATA_KEY;
  var today   = new Date().toISOString().slice(0, 10);
  var result  = { today: today };

  // Test football-data.org
  try {
    var r1 = await fetch('https://api.football-data.org/v4/matches?dateFrom='+today+'&dateTo='+today,
      { headers: { 'X-Auth-Token': fdKey } });
    var d1 = await r1.json();
    result.football_data = {
      status: r1.status,
      matches_today: (d1.matches||[]).length,
      leagues: [...new Set((d1.matches||[]).map(function(m){ return m.competition&&m.competition.name; }))].slice(0,10)
    };
  } catch(e) { result.football_data = { error: e.message }; }

  // Test Odds API - Copa Libertadores specifically (today's league)
  try {
    var r2 = await fetch('https://api.the-odds-api.com/v4/sports/soccer_conmebol_copa_libertadores/odds/?apiKey='+oddsKey+'&regions=uk,eu&markets=h2h&oddsFormat=decimal',
      { headers: { 'Accept': 'application/json' } });
    var d2 = await r2.json();
    result.odds_copa_lib = {
      status: r2.status,
      requests_remaining: r2.headers.get('x-requests-remaining'),
      count: Array.isArray(d2) ? d2.length : 0,
      matches: Array.isArray(d2) ? d2.map(function(e){ return { home:e.home_team, away:e.away_team, commence:e.commence_time, bookmakers:e.bookmakers&&e.bookmakers.length }; }) : d2
    };
  } catch(e) { result.odds_copa_lib = { error: e.message }; }

  // Test Odds API - Champions League
  try {
    var r3 = await fetch('https://api.the-odds-api.com/v4/sports/soccer_uefa_champs_league/odds/?apiKey='+oddsKey+'&regions=uk,eu&markets=h2h&oddsFormat=decimal',
      { headers: { 'Accept': 'application/json' } });
    var d3 = await r3.json();
    result.odds_champs = {
      status: r3.status,
      requests_remaining: r3.headers.get('x-requests-remaining'),
      count: Array.isArray(d3) ? d3.length : 0,
      matches: Array.isArray(d3) ? d3.map(function(e){ return { home:e.home_team, away:e.away_team, commence:e.commence_time }; }) : d3
    };
  } catch(e) { result.odds_champs = { error: e.message }; }

  return res.status(200).json(result);
};
