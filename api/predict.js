// api/predict.js — ScoutAI Predictions
// API-Sports free tier: fixtures + standings
// Budget: ~8 req/day (fixtures x2 + standings x6, all cached)
// Predictions based on league position, home advantage, form

var cache = {
  fixtures: null, fTs: 0,
  standings: {}, sTs: 0   // keyed by league id
};

var BASE = 'https://v3.football.api-sports.io';
var H    = function(k) { return { 'x-apisports-key': k }; };

// Major leagues with API-Sports IDs + current season
var LEAGUES = [
  { id:39,  name:'Premier League',         country:'England',   season:2025 },
  { id:40,  name:'Championship',           country:'England',   season:2025 },
  { id:41,  name:'League One',             country:'England',   season:2025 },
  { id:42,  name:'League Two',             country:'England',   season:2025 },
  { id:140, name:'La Liga',                country:'Spain',     season:2025 },
  { id:141, name:'Segunda División',       country:'Spain',     season:2025 },
  { id:135, name:'Serie A',                country:'Italy',     season:2025 },
  { id:136, name:'Serie B',                country:'Italy',     season:2025 },
  { id:78,  name:'Bundesliga',             country:'Germany',   season:2025 },
  { id:79,  name:'2. Bundesliga',          country:'Germany',   season:2025 },
  { id:61,  name:'Ligue 1',                country:'France',    season:2025 },
  { id:62,  name:'Ligue 2',                country:'France',    season:2025 },
  { id:94,  name:'Primeira Liga',          country:'Portugal',  season:2025 },
  { id:88,  name:'Eredivisie',             country:'Netherlands',season:2025},
  { id:179, name:'Scottish Premiership',   country:'Scotland',  season:2025 },
  { id:203, name:'Süper Lig',              country:'Turkey',    season:2025 },
  { id:71,  name:'Brasileirão Série A',    country:'Brazil',    season:2025 },
  { id:72,  name:'Brasileirão Série B',    country:'Brazil',    season:2025 },
  { id:262, name:'Liga MX',                country:'Mexico',    season:2025 },
  { id:253, name:'MLS',                    country:'USA',       season:2025 },
  { id:128, name:'Primera División',       country:'Argentina', season:2025 },
  { id:292, name:'K League 1',             country:'Korea',     season:2025 },
  { id:98,  name:'J1 League',              country:'Japan',     season:2025 },
  { id:103, name:'Allsvenskan',            country:'Sweden',    season:2025 },
  { id:113, name:'Eliteserien',            country:'Norway',    season:2025 },
  { id:106, name:'Ekstraklasa',            country:'Poland',    season:2025 },
  { id:144, name:'Jupiler Pro League',     country:'Belgium',   season:2025 },
  { id:169, name:'Swiss Super League',     country:'Switzerland',season:2025},
  { id:218, name:'Danish Superliga',       country:'Denmark',   season:2025 },
  // Cups & continental (no standings, use H2H model)
  { id:2,   name:'UEFA Champions League',  country:'Europe',    season:2025 },
  { id:3,   name:'UEFA Europa League',     country:'Europe',    season:2025 },
  { id:848, name:'UEFA Conference League', country:'Europe',    season:2025 },
  { id:13,  name:'Copa Libertadores',      country:'S. America',season:2025 },
  { id:11,  name:'Copa Sudamericana',      country:'S. America',season:2025 },
  { id:45,  name:'FA Cup',                 country:'England',   season:2025 },
  { id:143, name:'Copa del Rey',           country:'Spain',     season:2025 },
];

// Leagues that have standings (domestic only)
var STANDINGS_LEAGUES = LEAGUES.filter(function(l) {
  return [39,40,41,42,140,141,135,136,78,79,61,62,94,88,179,203,71,72,262,253,128,292,98,103,113,106,144,169,218].indexOf(l.id) !== -1;
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var reqDate = (req.query && req.query.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var key = process.env.APISPORTS_KEY;
  if (!key) return res.status(500).json({ error: 'APISPORTS_KEY not set.' });

  var DAY  = 86400000;
  var WEEK = 604800000;

  // ── Step 1: Fixtures today + tomorrow (2 req, cached 24hr) ──
  var fixtures = [];
  if (cache.fixtures && (Date.now() - cache.fTs) < DAY) {
    fixtures = cache.fixtures;
  } else {
    try {
      var tom = new Date(today + 'T12:00:00Z');
      tom.setUTCDate(tom.getUTCDate() + 1);
      var tomStr = tom.toISOString().slice(0, 10);
      var [r1, r2] = await Promise.all([
        fetch(BASE + '/fixtures?date=' + today,  { headers: H(key) }),
        fetch(BASE + '/fixtures?date=' + tomStr, { headers: H(key) })
      ]);
      var [d1, d2] = await Promise.all([r1.json(), r2.json()]);
      fixtures = (d1.response || []).concat(d2.response || []);
      cache.fixtures = fixtures;
      cache.fTs = Date.now();
    } catch(e) {
      if (cache.fixtures) fixtures = cache.fixtures;
      else return res.status(502).json({ error: e.message });
    }
  }

  // ── Step 2: Standings for domestic leagues (cached 1 week) ──
  var standingsAge = Date.now() - (cache.sTs || 0);
  if (standingsAge > WEEK) {
    // Fetch standings for top 8 leagues in parallel (8 req, once per week)
    var topLeagues = [39,140,135,78,61,94,88,203]; // PL, LaLiga, SerieA, BL, L1, Port, Ere, Super
    try {
      var sResults = await Promise.all(topLeagues.map(function(lid) {
        var lg = LEAGUES.find(function(l){ return l.id === lid; });
        if (!lg) return Promise.resolve(null);
        return fetch(BASE + '/standings?league=' + lid + '&season=' + lg.season, { headers: H(key) })
          .then(function(r){ return r.json(); })
          .then(function(d){ return { id: lid, data: d.response }; })
          .catch(function(){ return null; });
      }));
      sResults.forEach(function(s) {
        if (s && s.data) cache.standings[s.id] = buildStandingsMap(s.data);
      });
      cache.sTs = Date.now();
    } catch(e) { /* continue without standings */ }
  }

  // ── Filter fixtures to requested date ───────────────────────
  var nowMs  = Date.now();
  var dayMs  = new Date(reqDate + 'T00:00:00Z').getTime();
  var dayEnd = dayMs + DAY;

  var dayFix = fixtures.filter(function(f) {
    var ko = f.fixture && f.fixture.date ? new Date(f.fixture.date).getTime() : 0;
    if (!ko || ko <= nowMs) return false;
    return ko >= dayMs && ko < dayEnd;
  });

  // Auto-advance to next date with fixtures
  if (!dayFix.length) {
    var byDate = {};
    fixtures.forEach(function(f) {
      var ko = f.fixture && f.fixture.date ? new Date(f.fixture.date).getTime() : 0;
      if (!ko || ko <= nowMs) return;
      var d = f.fixture.date.slice(0, 10);
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(f);
    });
    var dates = Object.keys(byDate).sort();
    if (!dates.length) {
      return res.status(200).json({
        predictions:[], edge:[], date:reqDate, requested:reqDate,
        message:'No upcoming fixtures found. Try another date.'
      });
    }
    reqDate = dates[0];
    dayFix  = byDate[reqDate];
  }

  dayFix.sort(function(a, b) {
    return new Date(a.fixture.date) - new Date(b.fixture.date);
  });

  // ── Build predictions ───────────────────────────────────────
  var predictions = [], edgeData = [];

  dayFix.forEach(function(f, idx) {
    var home = f.teams && f.teams.home && f.teams.home.name;
    var away = f.teams && f.teams.away && f.teams.away.name;
    if (!home || !away) return;

    var leagueId   = f.league && f.league.id;
    var leagueName = f.league && f.league.name || 'Unknown';
    var country    = f.league && f.league.country || '';
    var ko         = f.fixture && f.fixture.date;
    var homeId     = f.teams && f.teams.home && f.teams.home.id;
    var awayId     = f.teams && f.teams.away && f.teams.away.id;

    // Get standings if available
    var standMap = cache.standings[leagueId];
    var homePos  = standMap && standMap[homeId] ? standMap[homeId].rank : null;
    var awayPos  = standMap && standMap[awayId] ? standMap[awayId].rank : null;
    var totalTeams = standMap ? Object.keys(standMap).length : 20;

    // Calculate prediction from standings + home advantage
    var result = calcPrediction(homePos, awayPos, totalTeams, leagueId);

    // Edge analysis based on position gap
    var edgeScore = 0, edgeLevel = 'none', factors = [], verdict = '';

    if (homePos && awayPos) {
      var gap = awayPos - homePos; // positive = home team higher ranked
      if (Math.abs(gap) >= 10) {
        edgeScore = Math.min(90, Math.abs(gap) * 4);
        edgeLevel = edgeScore >= 70 ? 'high' : edgeScore >= 40 ? 'medium' : 'low';
      }
      factors.push({
        label: 'League positions: ' + home + ' #' + homePos + ' vs ' + away + ' #' + awayPos,
        type:  gap > 3 ? 'positive' : gap < -3 ? 'negative' : 'neutral'
      });
      if (gap >= 8)  factors.push({ label: home + ' significantly higher in table', type:'positive' });
      if (gap <= -8) factors.push({ label: away + ' significantly higher in table', type:'negative' });
    } else {
      // Cup/continental — no standings
      factors.push({ label: 'Cup/continental fixture — position model not applicable', type:'neutral' });
    }

    // Home advantage factor
    factors.push({ label: 'Home advantage factored into all predictions', type:'positive' });

    verdict = result.confidence >= 65
      ? 'Statistical model strongly favours ' + result.prediction + ' based on league position and home advantage.'
      : result.confidence >= 55
      ? 'Model leans towards ' + result.prediction + '. Closely contested on paper.'
      : 'Evenly matched — form and motivation could be decisive.';

    // Show league name with country
    var displayLeague = country && country !== 'World' && !leagueName.includes(country)
      ? leagueName + ' (' + country + ')' : leagueName;

    predictions.push({
      home:            home,
      away:            away,
      league:          displayLeague,
      kickoff_iso:     ko,
      is_live:         false,
      is_finished:     false,
      status:          'TIMED',
      prediction:      result.prediction,
      confidence:      result.confidence,
      goals_prediction:result.goalsPred,
      goals_confidence:result.goalsConf,
      odds:            null, // no odds on free plan
      has_odds:        false,
      bookmaker_count: 0,
      home_rank:       homePos,
      away_rank:       awayPos
    });

    edgeData.push({
      index:      idx,
      edge_score: edgeScore,
      edge_level: edgeLevel,
      factors:    factors,
      verdict:    verdict
    });
  });

  return res.status(200).json({
    predictions:  predictions,
    edge:         edgeData,
    date:         reqDate,
    requested:    (req.query && req.query.date) || today,
    fetched_at:   now.toISOString(),
    total:        predictions.length,
    model:        'statistical'
  });
};

// ── Statistical prediction model ─────────────────────────────
function calcPrediction(homePos, awayPos, totalTeams, leagueId) {
  // Base home win probability (global average ~46%)
  var pH = 46, pD = 27, pA = 27;

  if (homePos && awayPos) {
    // Position-based adjustment
    // Home team rank percentile (lower rank = better team)
    var homePct = 1 - (homePos - 1) / (totalTeams - 1); // 1.0 = top, 0.0 = bottom
    var awayPct = 1 - (awayPos - 1) / (totalTeams - 1);
    var gap = homePct - awayPct; // positive = home better

    // Adjust probabilities based on quality gap
    // Max swing: ±20 percentage points
    var swing = Math.round(gap * 25);
    pH = Math.max(25, Math.min(72, 46 + swing));
    pA = Math.max(12, Math.min(55, 27 - swing * 0.7));
    pD = 100 - pH - pA;
    pD = Math.max(15, Math.min(35, pD));
    // Renormalise
    var tot = pH + pD + pA;
    pH = Math.round(pH/tot*100);
    pD = Math.round(pD/tot*100);
    pA = 100 - pH - pD;
  }

  var prediction, confidence;
  if (pH >= pD && pH >= pA)     { prediction = 'Home Win'; confidence = pH; }
  else if (pA > pH && pA >= pD) { prediction = 'Away Win'; confidence = pA; }
  else                          { prediction = 'Draw';     confidence = pD; }

  // Goals prediction based on league type
  var isCup = [2,3,848,13,11,45,143].indexOf(leagueId) !== -1;
  var goalsPred = confidence >= 60 ? 'Over 1.5 Goals' : null;
  var goalsConf = goalsPred ? (isCup ? 65 : 62) : null;

  return { prediction:prediction, confidence:confidence, goalsPred:goalsPred, goalsConf:goalsConf };
}

// ── Build standings lookup map {teamId: {rank, points, ...}} ─
function buildStandingsMap(response) {
  var map = {};
  if (!response || !response[0]) return map;
  var standings = response[0].league && response[0].league.standings;
  if (!standings) return map;
  // standings is array of groups (usually 1 for domestic leagues)
  standings.forEach(function(group) {
    group.forEach(function(team) {
      map[team.team.id] = {
        rank:   team.rank,
        points: team.points,
        played: team.all && team.all.played,
        won:    team.all && team.all.win,
        drawn:  team.all && team.all.draw,
        lost:   team.all && team.all.lose,
        gf:     team.all && team.all.goals && team.all.goals.for,
        ga:     team.all && team.all.goals && team.all.goals.against
      };
    });
  });
  return map;
}
