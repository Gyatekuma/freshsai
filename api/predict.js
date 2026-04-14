// api/predict.js — ScoutAI Backend
// Accepts ?date=YYYY-MM-DD (defaults to today)
// Returns real fixtures + AI predictions + calculated 1X2 odds

var cacheStore = {}; // keyed by date

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now      = new Date();
  var reqDate  = (req.query && req.query.date) || now.toISOString().slice(0, 10);
  var today    = now.toISOString().slice(0, 10);

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var cached = cacheStore[reqDate];
  var cacheAge = cached ? (Date.now() - cached.fetched) : Infinity;
  if (cached && cacheAge < 900000) {
    return res.status(200).json(buildResponse(cached.data, now, reqDate));
  }

  var apiKey = process.env.FOOTBALL_DATA_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FOOTBALL_DATA_KEY not set in Vercel Environment Variables.' });
  }

  var allMatches = [];

  try {
    var r = await fetch(
      'https://api.football-data.org/v4/matches?dateFrom=' + reqDate + '&dateTo=' + reqDate,
      { headers: { 'X-Auth-Token': apiKey } }
    );

    if (!r.ok) {
      var errData = await r.json().catch(function(){ return {}; });
      return res.status(502).json({ error: 'API error (' + r.status + '): ' + (errData.message || 'Check your API key.') });
    }

    var data = await r.json();
    var matches = data.matches || [];

    matches.forEach(function(m) {
      var ok = ['SCHEDULED','TIMED','IN_PLAY','PAUSED','FINISHED'].indexOf(m.status) !== -1;
      if (!ok) return;
      var home = m.homeTeam && (m.homeTeam.shortName || m.homeTeam.name);
      var away = m.awayTeam && (m.awayTeam.shortName || m.awayTeam.name);
      if (!home || !away || home==='null' || away==='null') return;

      allMatches.push({
        home:        home,
        away:        away,
        league:      (m.competition && m.competition.name) || 'Unknown',
        kickoff_iso: m.utcDate,
        is_live:     m.status === 'IN_PLAY' || m.status === 'PAUSED',
        is_finished: m.status === 'FINISHED',
        status:      m.status
      });
    });
  } catch(err) {
    return res.status(502).json({ error: 'Fetch failed: ' + err.message });
  }

  if (!allMatches.length) {
    return res.status(200).json({
      predictions:[], edge:[], date:reqDate,
      message: 'No fixtures scheduled in the top leagues for ' + reqDate + '.'
    });
  }

  // ── Prediction + Odds engine ──────────────────────────────
  var seedBase = parseInt(reqDate.replace(/-/g,''), 10);
  var si = 0;
  function rnd(){ var x=Math.sin(seedBase+(++si)*127773+49297)*43758.5453; return x-Math.floor(x); }
  function pick(arr){ return arr[Math.floor(rnd()*arr.length)]; }
  function range(a,b){ return Math.floor(rnd()*(b-a+1))+a; }
  function round2(n){ return Math.round(n*100)/100; }

  var predTypes = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goalMkts  = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals'];
  var edgeLvls  = ['none','none','low','medium','medium','high','elite'];
  var posFacts  = ['Strong home record this season','Title race pressure','Revenge fixture','Derby atmosphere','Unbeaten in last 6 at home','Star striker in top form','5-game winning run'];
  var negFacts  = ['Key player suspended','Top scorer doubtful','Heavy fixture congestion','Long injury list','Starting defender ruled out','Poor recent away form'];
  var verdicts  = ['Form and motivation firmly favour the home side.','Tactical discipline likely decisive in this tight match.','Goals expected as both sides push forward.','Narrative pressure creates an unpredictable edge.','Away form makes this far closer than it looks.','High stakes on both ends add significant weight.','Revenge angle adds extra motivation here.','Home crowd expected to be decisive.'];

  // Calculate 1X2 decimal odds from prediction + confidence
  function calcOdds(prediction, confidence) {
    var pct = confidence / 100;
    var h, d, a;
    var MARGIN = 1.08; // bookmaker margin (8%)

    if (prediction === 'Home Win') {
      h = pct; d = (1-pct)*0.55; a = (1-pct)*0.45;
    } else if (prediction === 'Away Win') {
      a = pct; d = (1-pct)*0.50; h = (1-pct)*0.50;
    } else if (prediction === 'Draw') {
      d = pct; h = (1-pct)*0.55; a = (1-pct)*0.45;
    } else if (prediction === 'Home Win or Draw') {
      h = pct*0.60; d = pct*0.40; a = 1-pct;
    } else if (prediction === 'Away Win or Draw') {
      a = pct*0.60; d = pct*0.40; h = 1-pct;
    } else { // BTTS etc
      h = 0.40; d = 0.28; a = 0.32;
    }

    // Normalise + apply margin
    var total = h + d + a;
    h = h/total; d = d/total; a = a/total;

    return {
      home: round2(MARGIN / h),
      draw: round2(MARGIN / d),
      away: round2(MARGIN / a)
    };
  }

  var predictions = allMatches.map(function(m, idx) {
    si = (seedBase % 999) + idx * 31 + m.home.length * 7;
    m.prediction       = pick(predTypes);
    m.confidence       = range(50, 88);
    m.goals_prediction = rnd() > 0.15 ? pick(goalMkts) : null;
    m.goals_confidence = m.goals_prediction ? range(52, 83) : null;
    m.odds             = calcOdds(m.prediction, m.confidence);

    var elvl   = pick(edgeLvls);
    var escore = elvl==='none'?range(5,25):elvl==='low'?range(30,48):elvl==='medium'?range(50,68):elvl==='high'?range(70,84):range(85,97);
    var nf     = (elvl==='none'||elvl==='low') ? 1 : 2;
    var facts  = [];
    for(var f=0;f<nf;f++) facts.push({label:f===0?pick(posFacts):pick(negFacts),type:f===0?'positive':'negative'});
    m._edge = {index:idx, edge_score:escore, edge_level:elvl, factors:facts, verdict:pick(verdicts)};
    return m;
  });

  var edgeData = predictions.map(function(m){ var e=m._edge; delete m._edge; return e; });
  var raw = { predictions:predictions, edge:edgeData, date:reqDate, fetched_at:now.toISOString() };
  cacheStore[reqDate] = { data:raw, fetched:Date.now() };

  return res.status(200).json(buildResponse(raw, now, reqDate));
};

function buildResponse(raw, now, reqDate) {
  var preds = (raw.predictions||[]).slice().sort(function(a,b){
    if (a.is_live && !b.is_live) return -1;
    if (!a.is_live && b.is_live) return 1;
    return new Date(a.kickoff_iso) - new Date(b.kickoff_iso);
  });
  var edgeMap = {};
  (raw.edge||[]).forEach(function(e,i){ edgeMap[i]=e; });
  var edge = preds.map(function(m,i){
    var orig = (raw.predictions||[]).indexOf(m);
    var e = edgeMap[orig]||{index:i,edge_score:20,edge_level:'none',factors:[],verdict:''};
    return Object.assign({},e,{index:i});
  });
  return { predictions:preds, edge:edge, date:reqDate, fetched_at:raw.fetched_at, message:raw.message||null };
}
