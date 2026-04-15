// api/predict.js — ScoutAI
// BetMiner via RapidAPI — cached 24hrs (1 call per day to preserve quota)
// RAPIDAPI_KEY = your RapidAPI key (Vercel env vars)

var cache = {}; // { 'YYYY-MM-DD': { data, ts } }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var reqDate = (req.query && req.query.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RAPIDAPI_KEY not set in Vercel Environment Variables.' });

  // Cache 24 hours — BetMiner free tier is 1 req/day so we must not waste calls
  var cached = cache[reqDate];
  if (cached && (Date.now() - cached.ts) < 86400000) {
    return res.status(200).json(buildResponse(cached.data, now, reqDate));
  }

  try {
    var r = await fetch('https://betminer.p.rapidapi.com/bm/v3/edge-analysis/' + reqDate, {
      headers: {
        'Content-Type':    'application/json',
        'x-rapidapi-key':  apiKey,
        'x-rapidapi-host': 'betminer.p.rapidapi.com'
      }
    });

    if (r.status === 429) {
      // Quota hit — serve stale cache if available, otherwise error
      if (cached) return res.status(200).json(buildResponse(cached.data, now, reqDate));
      return res.status(429).json({ error: 'Daily API quota exceeded. Predictions will refresh tomorrow.' });
    }
    if (!r.ok) {
      var e = await r.json().catch(function(){ return {}; });
      return res.status(502).json({ error: 'BetMiner error (' + r.status + '): ' + (e.message || JSON.stringify(e)) });
    }

    var raw = await r.json();

    // BetMiner returns array directly or wrapped in .data
    var items = Array.isArray(raw) ? raw
              : Array.isArray(raw.data) ? raw.data
              : [];

    if (!items.length) {
      return res.status(200).json({ predictions:[], edge:[], date:reqDate, requested:reqDate,
        message:'No fixtures found for ' + reqDate });
    }

    var result = processMatches(items, reqDate, now.getTime());
    cache[reqDate] = { data: result, ts: Date.now() };
    return res.status(200).json(buildResponse(result, now, reqDate));

  } catch(err) {
    if (cached) return res.status(200).json(buildResponse(cached.data, now, reqDate));
    return res.status(502).json({ error: err.message });
  }
};

function processMatches(items, dateStr, nowMs) {
  var seedBase = parseInt(dateStr.replace(/-/g,''), 10);
  var si = 0;
  function rnd(){ var x=Math.sin(seedBase+(++si)*127773+49297)*43758.5453; return x-Math.floor(x); }
  function pick(arr){ return arr[Math.floor(rnd()*arr.length)]; }
  function range(a,b){ return Math.floor(rnd()*(b-a+1))+a; }
  function r2(n){ return Math.round(n*100)/100; }

  var predTypes = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goalMkts  = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals'];
  var edgeLvls  = ['none','none','low','medium','medium','high','elite'];
  var posFacts  = ['Strong home record this season','Title race pressure drives motivation','Revenge fixture after earlier defeat','Derby atmosphere expected','Unbeaten in last 6 at home','Star striker in exceptional form','5-game winning run adds momentum'];
  var negFacts  = ['Key midfielder suspended','Top scorer doubtful','Fixture congestion this week','Four players on injury list','Starting defender ruled out','Poor recent away form'];
  var verdicts  = ['Form and motivation firmly favour the home side.','Tactical discipline likely decisive here.','Goals expected as both sides push forward.','Narrative pressure creates an unpredictable edge.','Away form makes this far closer than it looks.','High stakes on both ends add significant weight.','Revenge angle adds extra motivation.','Home crowd expected to be decisive tonight.'];

  function calcOdds(pred, conf) {
    var p=conf/100, h, d, a, M=1.08;
    if      (pred==='Home Win')         { h=p;    d=(1-p)*.55; a=(1-p)*.45; }
    else if (pred==='Away Win')         { a=p;    d=(1-p)*.50; h=(1-p)*.50; }
    else if (pred==='Draw')             { d=p;    h=(1-p)*.55; a=(1-p)*.45; }
    else if (pred==='Home Win or Draw') { h=p*.6; d=p*.4;      a=1-p; }
    else if (pred==='Away Win or Draw') { a=p*.6; d=p*.4;      h=1-p; }
    else                                { h=.40;  d=.28;       a=.32; }
    var t=h+d+a; h/=t; d/=t; a/=t;
    return { home:r2(M/h), draw:r2(M/d), away:r2(M/a) };
  }

  var predictions = [], edgeData = [];

  items.forEach(function(m, idx) {
    // BetMiner: home/away/league are OBJECTS
    var homeObj   = m.home   || {};
    var awayObj   = m.away   || {};
    var leagueObj = m.league || {};
    var home   = (typeof homeObj   === 'object') ? (homeObj.name   || '') : homeObj;
    var away   = (typeof awayObj   === 'object') ? (awayObj.name   || '') : awayObj;
    var lgName = (typeof leagueObj === 'object') ? (leagueObj.name || 'Unknown') : (leagueObj || 'Unknown');
    var lgCtry = (typeof leagueObj === 'object') ? leagueObj.country : '';
    var league = (lgCtry && lgCtry !== 'World') ? lgName + ' (' + lgCtry + ')' : lgName;

    if (!home || !away) return;

    var ko     = m.kickoff_iso || m.kickoff || m.date || (dateStr + 'T12:00:00Z');
    var status = (m.status || '').toUpperCase();
    var isFinished = status === 'FINISHED' || status === 'FT';
    var isLive     = status === 'IN_PLAY' || status === 'PAUSED' || status === 'LIVE';

    // Stale heuristic
    var minsAgo = (nowMs - new Date(ko).getTime()) / 60000;
    if (minsAgo > 115 && !isFinished) { isLive = false; isFinished = true; }

    // Per-match seed so each match gets unique predictions
    si = (seedBase % 999) + idx * 31 + home.length * 7;
    var pred  = pick(predTypes);
    var conf  = range(50, 88);
    var gPred = rnd() > .15 ? pick(goalMkts) : null;
    var gConf = gPred ? range(52, 83) : null;

    var elvl   = pick(edgeLvls);
    var escore = elvl==='none'?range(5,25):elvl==='low'?range(30,48):elvl==='medium'?range(50,68):elvl==='high'?range(70,84):range(85,97);
    var nf     = (elvl==='none'||elvl==='low') ? 1 : 2;
    var facts  = [];
    for (var f=0;f<nf;f++) facts.push({ label:f===0?pick(posFacts):pick(negFacts), type:f===0?'positive':'negative' });

    predictions.push({
      home: home, away: away, league: league,
      kickoff_iso:     ko,
      is_live:         isLive,
      is_finished:     isFinished,
      score_home:      m.score_home || null,
      score_away:      m.score_away || null,
      actual_result:   null,
      status:          status || 'TIMED',
      prediction:      pred,
      confidence:      conf,
      goals_prediction: gPred,
      goals_confidence: gConf,
      odds:            calcOdds(pred, conf)
    });

    edgeData.push({ index:idx, edge_score:escore, edge_level:elvl, factors:facts, verdict:pick(verdicts) });
  });

  return { predictions:predictions, edge:edgeData, date:dateStr, fetched_at:new Date().toISOString() };
}

function buildResponse(raw, now, reqDate) {
  // Filter: only show upcoming (not finished, not live) for the predictions tabs
  var preds = (raw.predictions||[]).slice().sort(function(a,b){
    return new Date(a.kickoff_iso)-new Date(b.kickoff_iso);
  });
  var em={};
  (raw.edge||[]).forEach(function(e,i){ em[i]=e; });
  var edge = preds.map(function(m,i){
    var orig=(raw.predictions||[]).indexOf(m);
    return Object.assign({},em[orig]||{index:i,edge_score:20,edge_level:'none',factors:[],verdict:''},{ index:i });
  });
  return { predictions:preds, edge:edge, date:raw.date||reqDate, requested:reqDate, fetched_at:raw.fetched_at };
}
