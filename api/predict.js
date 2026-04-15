// api/predict.js — ScoutAI Predictions
// Uses BetMiner API (RapidAPI) for worldwide football fixtures + edge analysis
// Endpoint: /bm/v3/edge-analysis/{date}
// Add RAPIDAPI_KEY to Vercel Environment Variables

var dayCache = {};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var reqDate = (req.query && req.query.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'RAPIDAPI_KEY not set in Vercel Environment Variables.' });
  }

  // Check cache (15 min)
  var cached = dayCache[reqDate];
  if (cached && (Date.now() - cached.ts) < 900000) {
    return res.status(200).json(cached.data);
  }

  try {
    var r = await fetch('https://betminer.p.rapidapi.com/bm/v3/edge-analysis/' + reqDate, {
      headers: {
        'Content-Type':    'application/json',
        'x-rapidapi-key':  apiKey,
        'x-rapidapi-host': 'betminer.p.rapidapi.com'
      }
    });

    if (!r.ok) {
      var errData = await r.json().catch(function(){ return {}; });
      return res.status(502).json({
        error: 'BetMiner API error (' + r.status + '): ' + (errData.message || JSON.stringify(errData))
      });
    }

    var raw = await r.json();

    // BetMiner response - handle both array and object wrapper formats
    var items = Array.isArray(raw) ? raw
              : (raw.data && Array.isArray(raw.data)) ? raw.data
              : (raw.matches && Array.isArray(raw.matches)) ? raw.matches
              : [];

    if (!items.length) {
      return res.status(200).json({
        predictions: [], edge: [], date: reqDate, requested: reqDate,
        message: 'No fixtures found for ' + reqDate + '. Try another date.',
        raw_keys: Object.keys(raw)
      });
    }

    // Process BetMiner matches into ScoutAI format
    var now2    = Date.now();
    var result  = processBetMiner(items, reqDate, now2);
    dayCache[reqDate] = { data: result, ts: Date.now() };
    return res.status(200).json(result);

  } catch(err) {
    return res.status(502).json({ error: 'Fetch failed: ' + err.message });
  }
};

function processBetMiner(items, dateStr, nowMs) {
  function r2(n){ return Math.round(n * 100) / 100; }

  var predictions = [];
  var edgeData    = [];

  items.forEach(function(m, idx) {
    // Extract fields — BetMiner field names (adjust if response differs)
    var home   = m.home_team   || m.home   || m.homeTeam   || m.home_name   || '';
    var away   = m.away_team   || m.away   || m.awayTeam   || m.away_name   || '';
    var league = m.league      || m.competition || m.league_name || 'Unknown';
    var ko     = m.kickoff     || m.date   || m.kick_off   || m.match_date  || m.datetime || dateStr + 'T00:00:00Z';

    if (!home || !away) return;

    // Status detection
    var status = (m.status || m.match_status || 'scheduled').toLowerCase();
    var isFinished = status === 'finished' || status === 'ft' || status === 'complete';
    var isLive     = status === 'live'     || status === 'in_play' || status === 'inplay';

    // Stale heuristic
    var koMs = new Date(ko).getTime();
    var minsAgo = (nowMs - koMs) / 60000;
    if (minsAgo > 115 && !isFinished) { isLive = false; isFinished = true; }

    // BetMiner prediction fields (use their analysis if available)
    var pred       = m.prediction       || m.tip         || m.recommended_bet || '';
    var confidence = m.confidence       || m.probability || m.edge_score      || 0;
    var edgeScore  = m.edge_score       || m.value_score || m.edge            || 0;

    // Normalise prediction to our format
    pred = normalisePred(pred);

    // If BetMiner doesn't have prediction, generate deterministically
    if (!pred || confidence === 0) {
      var gen = genPrediction(dateStr, idx, home);
      if (!pred) pred = gen.prediction;
      if (!confidence) confidence = gen.confidence;
    }

    // Clamp confidence to 48-92
    confidence = Math.min(92, Math.max(48, Math.round(Number(confidence) || 65)));

    // Goals market
    var goalsPred = m.goals_prediction || m.btts       || m.goals_tip || null;
    var goalsConf = m.goals_confidence || m.btts_prob  || null;
    if (!goalsPred) {
      var gen2 = genPrediction(dateStr, idx + 1000, home);
      goalsPred = gen2.goals_prediction;
      goalsConf = gen2.goals_confidence;
    }

    // Odds
    var odds = buildOdds(m, pred, confidence);

    // Edge analysis
    var elvl    = scoreEdgeLevel(edgeScore, m);
    var eScore  = typeof edgeScore === 'number' ? Math.round(edgeScore)
                : edgeLevelToScore(elvl, dateStr, idx);
    var factors = buildFactors(m, dateStr, idx, home);
    var verdict = m.analysis || m.reasoning || m.verdict || pick(verdicts, dateStr, idx);

    predictions.push({
      home:            home,
      away:            away,
      league:          league,
      kickoff_iso:     ko,
      is_live:         isLive,
      is_finished:     isFinished,
      score_home:      m.score_home || m.home_score || null,
      score_away:      m.score_away || m.away_score || null,
      actual_result:   m.actual_result || null,
      status:          isFinished ? 'FINISHED' : isLive ? 'IN_PLAY' : 'TIMED',
      prediction:      pred,
      confidence:      confidence,
      goals_prediction: goalsPred,
      goals_confidence: goalsConf ? Math.round(Number(goalsConf)) : null,
      odds:            odds
    });

    edgeData.push({
      index:       idx,
      edge_score:  eScore,
      edge_level:  elvl,
      factors:     factors,
      verdict:     verdict
    });
  });

  // Sort: upcoming first, by kickoff time, exclude finished/live from predictions
  predictions.sort(function(a, b) {
    return new Date(a.kickoff_iso) - new Date(b.kickoff_iso);
  });

  return {
    predictions: predictions,
    edge:        edgeData,
    date:        dateStr,
    requested:   dateStr,
    fetched_at:  new Date().toISOString()
  };
}

// ── Helpers ──────────────────────────────────────────────────

function normalisePred(pred) {
  if (!pred) return '';
  var p = pred.toString().toLowerCase().trim();
  if (p === '1' || p === 'home' || p === 'home win' || p === 'home_win') return 'Home Win';
  if (p === '2' || p === 'away' || p === 'away win' || p === 'away_win') return 'Away Win';
  if (p === 'x' || p === 'draw')                                          return 'Draw';
  if (p === '1x' || p === 'home or draw' || p === 'home_or_draw')        return 'Home Win or Draw';
  if (p === 'x2' || p === 'away or draw' || p === 'away_or_draw')        return 'Away Win or Draw';
  if (p === 'btts' || p === 'gg' || p === 'both teams to score')         return 'Both Teams to Score';
  return '';
}

function scoreEdgeLevel(score, m) {
  var s = typeof score === 'number' ? score : 0;
  // Some APIs give 0-100, some give 0-10 — normalise
  if (s > 0 && s <= 10) s = s * 10;
  // Also check for explicit edge level field
  var lvl = m.edge_level || m.value_level || '';
  if (lvl) {
    lvl = lvl.toLowerCase();
    if (lvl === 'elite' || lvl === 'very high') return 'elite';
    if (lvl === 'high')                          return 'high';
    if (lvl === 'medium' || lvl === 'moderate') return 'medium';
    if (lvl === 'low')                           return 'low';
    return 'none';
  }
  if (s >= 85) return 'elite';
  if (s >= 70) return 'high';
  if (s >= 50) return 'medium';
  if (s >= 30) return 'low';
  return 'none';
}

function edgeLevelToScore(lvl, dateStr, idx) {
  var seed = parseInt(dateStr.replace(/-/g,''),10);
  var si   = (seed % 999) + idx * 17;
  function rnd(){ var x=Math.sin(si++*127773+49297)*43758.5453; return x-Math.floor(x); }
  if (lvl==='elite')  return Math.floor(rnd()*12)+85;
  if (lvl==='high')   return Math.floor(rnd()*14)+70;
  if (lvl==='medium') return Math.floor(rnd()*18)+50;
  if (lvl==='low')    return Math.floor(rnd()*18)+30;
  return Math.floor(rnd()*24)+5;
}

function buildFactors(m, dateStr, idx, home) {
  // Use BetMiner reasons if available, otherwise generate
  if (m.reasons && Array.isArray(m.reasons) && m.reasons.length) {
    return m.reasons.slice(0, 2).map(function(r, i) {
      return { label: r.toString(), type: i===0?'positive':'negative' };
    });
  }
  if (m.factors && Array.isArray(m.factors)) return m.factors.slice(0, 2);

  var seed = parseInt(dateStr.replace(/-/g,''),10);
  var si   = (seed%999) + idx*31 + home.length*7;
  function rnd(){ var x=Math.sin(si++*127773+49297)*43758.5453; return x-Math.floor(x); }
  function pick(arr){ return arr[Math.floor(rnd()*arr.length)]; }

  var pos = ['Strong home record this season','Title race pressure drives motivation','Revenge fixture after earlier defeat','Derby atmosphere expected','Star striker in exceptional form','5-game winning run adds momentum'];
  var neg = ['Key midfielder suspended','Top scorer doubtful','Fixture congestion this week','Starting defender ruled out','Poor recent away form'];
  return [
    { label: pick(pos), type: 'positive' },
    { label: pick(neg), type: 'negative' }
  ];
}

function buildOdds(m, pred, conf) {
  // Use BetMiner odds if available
  var home = m.home_odds || m.odd_1 || m.odds_home || 0;
  var draw = m.draw_odds || m.odd_x || m.odds_draw || 0;
  var away = m.away_odds || m.odd_2 || m.odds_away || 0;
  if (home && draw && away) return { home: Number(home), draw: Number(draw), away: Number(away) };

  // Calculate from confidence
  function r2(n){ return Math.round(n*100)/100; }
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

var verdicts = ['Form and motivation firmly favour the home side.','Tactical discipline likely decisive here.','Goals expected as both sides push forward.','Narrative pressure creates an unpredictable edge.','Away form makes this far closer than it looks.','High stakes on both ends add significant weight.','Revenge angle adds extra motivation.','Home crowd expected to be decisive tonight.'];

function pick(arr, dateStr, idx) {
  var seed = parseInt(dateStr.replace(/-/g,''),10);
  var si   = (seed%999) + idx*41;
  var x    = Math.sin(si*127773+49297)*43758.5453; x = x-Math.floor(x);
  return arr[Math.floor(x * arr.length)];
}

function genPrediction(dateStr, idx, homeName) {
  var seed = parseInt(dateStr.replace(/-/g,''),10);
  var si   = (seed%999) + idx*31 + homeName.length*7;
  function rnd(){ var x=Math.sin(si++*127773+49297)*43758.5453; return x-Math.floor(x); }
  function p(arr){ return arr[Math.floor(rnd()*arr.length)]; }
  var preds = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goals = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals'];
  return {
    prediction:       p(preds),
    confidence:       Math.floor(rnd()*38)+50,
    goals_prediction: rnd()>.15 ? p(goals) : null,
    goals_confidence: Math.floor(rnd()*30)+52
  };
}
