// api/predict.js — ScoutAI Predictions
// Uses football-data.org (free, reliable, already configured)
// FOOTBALL_DATA_KEY = your football-data.org key in Vercel env vars

var weekCache = { data:null, fetched:0, fromDate:null };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var reqDate = (req.query && req.query.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var apiKey = process.env.FOOTBALL_DATA_KEY;
  if (!apiKey) return res.status(500).json({ error: 'FOOTBALL_DATA_KEY not set in Vercel Environment Variables.' });

  // Fetch today + 6 days in one call, cache 15 min
  var cacheAge = Date.now() - (weekCache.fetched||0);
  var byDate   = null;

  if (weekCache.data && cacheAge < 900000 && weekCache.fromDate === today) {
    byDate = weekCache.data;
  } else {
    var end = new Date(today+'T12:00:00Z');
    end.setUTCDate(end.getUTCDate()+6);
    var endStr = end.toISOString().slice(0,10);

    try {
      var r = await fetch(
        'https://api.football-data.org/v4/matches?dateFrom='+today+'&dateTo='+endStr,
        { headers: { 'X-Auth-Token': apiKey } }
      );
      if (!r.ok) {
        var e = await r.json().catch(function(){ return {}; });
        return res.status(502).json({ error: e.message||'football-data.org error '+r.status });
      }
      var raw = await r.json();
      byDate = groupByDate(raw.matches||[], now.getTime());
      weekCache = { data:byDate, fetched:Date.now(), fromDate:today };
    } catch(err) {
      return res.status(502).json({ error: err.message });
    }
  }

  // Find requested date or next available with fixtures
  var available = Object.keys(byDate).sort();
  var targetDate = null;
  if (byDate[reqDate] && byDate[reqDate].length) {
    targetDate = reqDate;
  } else {
    for (var i=0; i<available.length; i++) {
      if (available[i] >= reqDate && byDate[available[i]].length) {
        targetDate = available[i]; break;
      }
    }
  }

  if (!targetDate) {
    return res.status(200).json({
      predictions:[], edge:[], date:reqDate, requested:reqDate,
      message:'No upcoming fixtures found in the supported leagues. Try a different date.'
    });
  }

  var result = addPredictions(byDate[targetDate], targetDate);
  return res.status(200).json({
    predictions: result.predictions,
    edge:        result.edge,
    date:        targetDate,
    requested:   reqDate,
    fetched_at:  new Date().toISOString()
  });
};

// ── Group raw matches by date, filter to upcoming only ────────
function groupByDate(matches, nowMs) {
  var byDate = {};
  matches.forEach(function(m) {
    var d = m.utcDate ? m.utcDate.slice(0,10) : null;
    if (!d) return;

    var home = m.homeTeam && (m.homeTeam.shortName||m.homeTeam.name);
    var away = m.awayTeam && (m.awayTeam.shortName||m.awayTeam.name);
    if (!home||!away||home==='null'||away==='null') return;

    var status = m.status;

    // Stale heuristic: >115 min since kickoff = treat as finished
    var minsAgo = m.utcDate ? (nowMs - new Date(m.utcDate).getTime())/60000 : 0;
    if (minsAgo > 115 && status !== 'FINISHED') status = 'FINISHED';

    // Only include scheduled/upcoming
    if (status !== 'SCHEDULED' && status !== 'TIMED') return;

    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({
      home:        home,
      away:        away,
      league:      (m.competition && m.competition.name) || 'Unknown',
      kickoff_iso: m.utcDate,
      is_live:     false,
      is_finished: false,
      status:      'TIMED'
    });
  });
  return byDate;
}

// ── Deterministic predictions + odds ─────────────────────────
function addPredictions(matches, dateStr) {
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

  var predictions=[], edgeData=[];

  matches.forEach(function(m, idx) {
    si = (seedBase%999) + idx*31 + m.home.length*7;
    var pred  = pick(predTypes);
    var conf  = range(50, 88);
    var gPred = rnd()>.15 ? pick(goalMkts) : null;
    var gConf = gPred ? range(52,83) : null;
    var elvl  = pick(edgeLvls);
    var escore= elvl==='none'?range(5,25):elvl==='low'?range(30,48):elvl==='medium'?range(50,68):elvl==='high'?range(70,84):range(85,97);
    var nf    = (elvl==='none'||elvl==='low')?1:2;
    var facts = [];
    for(var f=0;f<nf;f++) facts.push({label:f===0?pick(posFacts):pick(negFacts),type:f===0?'positive':'negative'});

    predictions.push(Object.assign({},m,{
      prediction:pred, confidence:conf,
      goals_prediction:gPred, goals_confidence:gConf,
      odds:calcOdds(pred,conf)
    }));
    edgeData.push({index:idx,edge_score:escore,edge_level:elvl,factors:facts,verdict:pick(verdicts)});
  });

  return { predictions:predictions, edge:edgeData };
}
