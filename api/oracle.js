// api/oracle.js — The Oracle accuracy tracker
// Fetches real results for a given date, compares with deterministic predictions

var cache = {};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var reqDate = (req.query && req.query.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var apiKey = process.env.FOOTBALL_DATA_KEY;
  if (!apiKey) return res.status(500).json({ error: 'FOOTBALL_DATA_KEY not set.' });

  // Cache: 5 min for today (results coming in), 1 hr for past days
  var cached  = cache[reqDate];
  var maxAge  = reqDate === today ? 300000 : 3600000;
  if (cached && (Date.now() - cached.ts) < maxAge) {
    return res.status(200).json(cached.data);
  }

  try {
    var r = await fetch(
      'https://api.football-data.org/v4/matches?dateFrom=' + reqDate + '&dateTo=' + reqDate,
      { headers: { 'X-Auth-Token': apiKey } }
    );
    if (!r.ok) {
      var e = await r.json().catch(function(){ return {}; });
      return res.status(502).json({ error: e.message || 'API error ' + r.status });
    }
    var raw = await r.json();

    var matches = [];
    (raw.matches || []).forEach(function(m, idx) {
      var home = m.homeTeam && (m.homeTeam.shortName || m.homeTeam.name);
      var away = m.awayTeam && (m.awayTeam.shortName || m.awayTeam.name);
      if (!home || !away) return;

      var isFinished = m.status === 'FINISHED';
      var isLive     = m.status === 'IN_PLAY' || m.status === 'PAUSED';
      var sh = null, sa = null, actual = null;

      if (isFinished && m.score && m.score.fullTime) {
        sh = m.score.fullTime.home;
        sa = m.score.fullTime.away;
        if (sh !== null && sa !== null)
          actual = sh > sa ? 'Home Win' : sa > sh ? 'Away Win' : 'Draw';
      }

      // Generate deterministic prediction for this match
      var pred = genPrediction(reqDate, idx, home);

      // Score it
      var correct = null;
      if (isFinished && actual) {
        correct = checkPred(pred.prediction, actual, sh, sa);
      }
      var goalsCorrect = null;
      if (isFinished && pred.goals_prediction && sh !== null) {
        goalsCorrect = checkGoals(pred.goals_prediction, sh, sa);
      }

      matches.push({
        home: home, away: away,
        league: (m.competition && m.competition.name) || 'Unknown',
        kickoff_utc: m.utcDate,
        is_live: isLive, is_finished: isFinished,
        score_home: sh, score_away: sa, actual_result: actual,
        prediction: pred.prediction,
        confidence: pred.confidence,
        goals_prediction: pred.goals_prediction,
        is_correct: correct,
        goals_is_correct: goalsCorrect
      });
    });

    var finished = matches.filter(function(m){ return m.is_finished; });
    var correct  = finished.filter(function(m){ return m.is_correct === true; }).length;
    var wrong    = finished.filter(function(m){ return m.is_correct === false; }).length;
    var gTotal   = finished.filter(function(m){ return m.goals_is_correct !== null; }).length;
    var gCorrect = finished.filter(function(m){ return m.goals_is_correct === true; }).length;

    var result = {
      date: reqDate,
      total: matches.length,
      finished: finished.length,
      live: matches.filter(function(m){ return m.is_live; }).length,
      pending: matches.filter(function(m){ return !m.is_finished && !m.is_live; }).length,
      correct: correct, wrong: wrong,
      accuracy_pct: (correct+wrong) > 0 ? Math.round(correct/(correct+wrong)*100) : null,
      goals_correct: gCorrect, goals_total: gTotal,
      goals_pct: gTotal > 0 ? Math.round(gCorrect/gTotal*100) : null,
      matches: matches
    };

    cache[reqDate] = { data: result, ts: Date.now() };
    return res.status(200).json(result);

  } catch(err) {
    return res.status(502).json({ error: err.message });
  }
};

function genPrediction(dateStr, idx, homeName) {
  var seedBase = parseInt(dateStr.replace(/-/g,''), 10);
  var si = (seedBase % 999) + idx * 31 + homeName.length * 7;
  function rnd(){ var x=Math.sin(si++*127773+49297)*43758.5453; return x-Math.floor(x); }
  function pick(arr){ return arr[Math.floor(rnd()*arr.length)]; }
  var predTypes = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goalMkts  = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals'];
  return {
    prediction: pick(predTypes),
    confidence: Math.floor(rnd()*38)+50,
    goals_prediction: rnd()>.15 ? pick(goalMkts) : null
  };
}

function checkPred(pred, actual, h, a) {
  if (!actual) return null;
  if (pred === 'Home Win')         return actual === 'Home Win';
  if (pred === 'Away Win')         return actual === 'Away Win';
  if (pred === 'Draw')             return actual === 'Draw';
  if (pred === 'Home Win or Draw') return actual === 'Home Win' || actual === 'Draw';
  if (pred === 'Away Win or Draw') return actual === 'Away Win' || actual === 'Draw';
  if (pred === 'Both Teams to Score' && h !== null) return h > 0 && a > 0;
  return null;
}

function checkGoals(pred, h, a) {
  var t = h+a;
  if (pred === 'Over 2.5 Goals')  return t > 2;
  if (pred === 'Under 2.5 Goals') return t < 3;
  if (pred === 'Over 1.5 Goals')  return t > 1;
  if (pred === 'BTTS Yes')        return h > 0 && a > 0;
  if (pred === 'BTTS No')         return h === 0 || a === 0;
  return null;
}
