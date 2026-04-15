// api/debug.js — check both API responses
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  var rapidKey = process.env.RAPIDAPI_KEY;
  var oddsKey  = process.env.ODDS_API_KEY;
  var today    = new Date().toISOString().slice(0, 10);
  var result   = { today: today, rapidapi: {}, odds_api: {} };

  // 1. Test API-Football predictions endpoint
  try {
    var r1 = await fetch('https://api-football-v1.p.rapidapi.com/v3/predictions?fixture=1035133', {
      headers: {
        'x-rapidapi-key':  rapidKey,
        'x-rapidapi-host': 'api-football-v1.p.rapidapi.com'
      }
    });
    var d1 = await r1.json();
    result.rapidapi.predictions_test = {
      status: r1.status,
      keys: d1 ? Object.keys(d1) : [],
      response_length: d1 && d1.response ? d1.response.length : 0,
      first_item_keys: d1 && d1.response && d1.response[0] ? Object.keys(d1.response[0]) : [],
      errors: d1 && d1.errors
    };
  } catch(e) { result.rapidapi.predictions_test = { error: e.message }; }

  // 2. Test API-Football fixtures for today
  try {
    var r2 = await fetch('https://api-football-v1.p.rapidapi.com/v3/fixtures?date=' + today + '&league=2&season=2025', {
      headers: {
        'x-rapidapi-key':  rapidKey,
        'x-rapidapi-host': 'api-football-v1.p.rapidapi.com'
      }
    });
    var d2 = await r2.json();
    var first = d2 && d2.response && d2.response[0];
    result.rapidapi.fixtures_cl_today = {
      status: r2.status,
      count: d2 && d2.results,
      errors: d2 && d2.errors,
      first_fixture_id: first && first.fixture && first.fixture.id,
      first_teams: first ? (first.teams && first.teams.home && first.teams.home.name) + ' vs ' + (first.teams && first.teams.away && first.teams.away.name) : null
    };
  } catch(e) { result.rapidapi.fixtures_cl_today = { error: e.message }; }

  // 3. Test Odds API - get available sports
  try {
    var r3 = await fetch('https://api.the-odds-api.com/v4/sports/?apiKey=' + oddsKey);
    var d3 = await r3.json();
    var soccer = Array.isArray(d3) ? d3.filter(function(s){ return s.group === 'Soccer'; }).slice(0, 5) : [];
    result.odds_api.sports_test = {
      status: r3.status,
      total_sports: Array.isArray(d3) ? d3.length : 0,
      soccer_sample: soccer.map(function(s){ return { key: s.key, title: s.title }; }),
      error: !Array.isArray(d3) ? d3 : null
    };
  } catch(e) { result.odds_api.sports_test = { error: e.message }; }

  // 4. Test Odds API - Champions League odds
  try {
    var r4 = await fetch('https://api.the-odds-api.com/v4/sports/soccer_uefa_champs_league/odds/?apiKey=' + oddsKey + '&regions=uk&markets=h2h&oddsFormat=decimal');
    var d4 = await r4.json();
    var firstOdds = Array.isArray(d4) ? d4[0] : null;
    result.odds_api.champs_odds = {
      status: r4.status,
      count: Array.isArray(d4) ? d4.length : 0,
      first_match: firstOdds ? {
        home: firstOdds.home_team,
        away: firstOdds.away_team,
        commence: firstOdds.commence_time,
        bookmakers_count: firstOdds.bookmakers ? firstOdds.bookmakers.length : 0,
        first_bookmaker: firstOdds.bookmakers && firstOdds.bookmakers[0] && firstOdds.bookmakers[0].title,
        sample_odds: firstOdds.bookmakers && firstOdds.bookmakers[0] && firstOdds.bookmakers[0].markets && firstOdds.bookmakers[0].markets[0] && firstOdds.bookmakers[0].markets[0].outcomes
      } : null,
      error: !Array.isArray(d4) ? d4 : null
    };
  } catch(e) { result.odds_api.champs_odds = { error: e.message }; }

  return res.status(200).json(result);
};
