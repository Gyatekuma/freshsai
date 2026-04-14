// api/predict.js — ScoutAI
// Real fixtures from football-data.org (free forever for major leagues)
// Free key: https://www.football-data.org/client/register
// Set FOOTBALL_DATA_KEY in Vercel environment variables

var cache = { date: null, data: null, fetched: 0 };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now   = new Date();
  var today = now.toISOString().slice(0, 10); // YYYY-MM-DD

  // Re-use cache for 30 minutes (so past kickoffs get filtered live)
  var cacheAge = Date.now() - (cache.fetched || 0);
  if (cache.date === today && cache.data && cacheAge < 1800000) {
    return res.status(200).json(applyFilter(cache.data, now));
  }

  var apiKey = process.env.FOOTBALL_DATA_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'FOOTBALL_DATA_KEY not set. Get a free key at football-data.org/client/register and add it to Vercel Environment Variables.'
    });
  }

  // ── Seeded prediction layer ───────────────────────────────
  var seedBase = parseInt(today.replace(/-/g,''), 10);
  var si = 0;
  function rnd(){ var x=Math.sin(seedBase+(++si)*127773+49297)*43758.5453; return x-Math.floor(x); }
  function pick(arr){ return arr[Math.floor(rnd()*arr.length)]; }
  function range(a,b){ return Math.floor(rnd()*(b-a+1))+a; }

  var predTypes   = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goalMarkets = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals'];
  var edgeLevels  = ['none','none','low','medium','medium','high','elite'];
  var posFacts    = ['Strong home record this season','Title race pressure drives motivation','Revenge fixture — lost the reverse fixture','Derby atmosphere expected','Unbeaten in last 6 at home','Star striker in exceptional form','Momentum from a 5-game winning run'];
  var negFacts    = ['Key midfielder serving suspension','Top scorer rated doubtful','Heavy fixture congestion this week','Four players on the injury list','Starting centre-back ruled out'];
  var verdicts    = ['Form and motivation firmly favour the home side.','Tactical discipline likely to be decisive in this tight match.','Goals expected as both teams push forward with intent.','Narrative pressure creates an unpredictable edge here.','Away side\'s current form makes this far closer than it looks.','High stakes on both ends of the table add significant weight.','A revenge angle adds extra fire to the visiting side.','Home support expected to be a decisive factor tonight.'];

  function addPrediction(match, idx) {
    si = (seedBase % 999) + idx * 31 + match.home.length * 7;
    match.prediction     = pick(predTypes);
    match.confidence     = range(50, 88);
    match.goals_prediction  = rnd()>0.15 ? pick(goalMarkets) : null;
    match.goals_confidence  = match.goals_prediction ? range(52, 83) : null;
    var elvl = pick(edgeLevels);
    var escore = elvl==='none'?range(5,25):elvl==='low'?range(30,48):elvl==='medium'?range(50,68):elvl==='high'?range(70,84):range(85,97);
    var nf = (elvl==='none'||elvl==='low') ? 1 : 2;
    var facts = [];
    for(var f=0;f<nf;f++) facts.push({label:f===0?pick(posFacts):pick(negFacts),type:f===0?'positive':'negative'});
    match._edge = { index:idx, edge_score:escore, edge_level:elvl, factors:facts, verdict:pick(verdicts) };
    return match;
  }

  // ── Fetch from football-data.org ─────────────────────────
  // Free tier competitions
  var COMPETITIONS = ['PL','BL1','SA','PD','FL1','ELC','CL'];
  // PL=Premier League, BL1=Bundesliga, SA=Serie A, PD=La Liga
  // FL1=Ligue 1, ELC=Championship, CL=Champions League

  var COMP_NAMES = {
    PL:'Premier League', BL1:'Bundesliga', SA:'Serie A',
    PD:'La Liga', FL1:'Ligue 1', ELC:'Championship', CL:'Champions League'
  };

  var allMatches = [];

  try {
    var r = await fetch(
      'https://api.football-data.org/v4/matches?dateFrom='+today+'&dateTo='+today,
      { headers: { 'X-Auth-Token': apiKey } }
    );

    if (!r.ok) {
      var err = await r.json().catch(function(){ return {}; });
      return res.status(502).json({
        error: 'football-data.org error (' + r.status + '): ' + (err.message || 'Check your API key in Vercel Environment Variables.')
      });
    }

    var data = await r.json();
    var matches = data.matches || [];

    matches.forEach(function(m) {
      // Only include free tier competitions
      var compCode = m.competition && m.competition.code;
      if (!COMP_NAMES[compCode]) return;
      // Only scheduled matches (not started/finished)
      if (m.status !== 'SCHEDULED' && m.status !== 'TIMED') return;

      var home = m.homeTeam && (m.homeTeam.shortName || m.homeTeam.name);
      var away = m.awayTeam && (m.awayTeam.shortName || m.awayTeam.name);
      if (!home || !away) return;

      allMatches.push({
        home:        home,
        away:        away,
        league:      COMP_NAMES[compCode] || m.competition.name,
        kickoff_iso: m.utcDate,  // always UTC/GMT from football-data.org
        status:      m.status
      });
    });

  } catch(err) {
    return res.status(502).json({ error: 'Failed to fetch fixtures: ' + err.message });
  }

  if (!allMatches.length) {
    return res.status(200).json({
      predictions: [],
      edge: [],
      source: 'live',
      message: 'No upcoming fixtures found in the major leagues today. Check back tomorrow or try later if matches start this evening.'
    });
  }

  // Add predictions to each real match
  var predictions = allMatches.map(function(m, idx) { return addPrediction(m, idx); });
  var edgeData    = predictions.map(function(m) { return m._edge; });

  // Strip _edge from match objects (keep it separate)
  predictions.forEach(function(m) { delete m._edge; });

  var raw = { predictions:predictions, edge:edgeData, source:'live', fetched_at:now.toISOString() };
  cache = { date:today, data:raw, fetched: Date.now() };

  return res.status(200).json(applyFilter(raw, now));
};

// Remove matches that have already kicked off
function applyFilter(raw, now) {
  var upcoming = (raw.predictions||[]).filter(function(m) {
    if (!m.kickoff_iso) return true;
    return new Date(m.kickoff_iso) > now;
  });
  // Re-index edge entries
  var edgeMap = {};
  (raw.edge||[]).forEach(function(e,i){ edgeMap[i]=e; });
  var edge = upcoming.map(function(m,i) {
    var origIdx = (raw.predictions||[]).indexOf(m);
    var e = edgeMap[origIdx] || {index:i,edge_score:20,edge_level:'none',factors:[],verdict:''};
    return Object.assign({},e,{index:i});
  });
  return {
    predictions: upcoming,
    edge:        edge,
    source:      raw.source,
    fetched_at:  raw.fetched_at,
    message:     raw.message || null
  };
}
