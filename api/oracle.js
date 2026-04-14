// api/oracle.js — The Oracle: Prediction Accuracy Tracker
// Fetches real results for any date, regenerates predictions, compares them
// No database needed — predictions are deterministic (same date = same prediction)

var oracleCache = {}; // keyed by date, expires after 15 min

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now = new Date();

  // Accept ?date=YYYY-MM-DD, default to today
  var reqDate = (req.query && req.query.date) || now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }

  var today = now.toISOString().slice(0, 10);

  // Only allow dates from last 14 days up to today
  var reqMs = new Date(reqDate + 'T12:00:00Z').getTime();
  var todayMs = new Date(today + 'T12:00:00Z').getTime();
  var diffDays = Math.round((todayMs - reqMs) / 86400000);
  if (diffDays < 0 || diffDays > 14) {
    return res.status(400).json({ error: 'Date must be within the last 14 days.' });
  }

  // Cache — 15 min for today (results still coming in), 24h for past days
  var cached = oracleCache[reqDate];
  var cacheLimit = reqDate === today ? 900000 : 86400000;
  if (cached && (Date.now() - cached.fetched) < cacheLimit) {
    return res.status(200).json(cached.data);
  }

  var apiKey = process.env.FOOTBALL_DATA_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FOOTBALL_DATA_KEY not set.' });
  }

  // Fetch real fixtures + scores for this date
  var matches = [];
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

    (raw.matches || []).forEach(function(m) {
      var home = m.homeTeam && (m.homeTeam.shortName || m.homeTeam.name);
      var away = m.awayTeam && (m.awayTeam.shortName || m.awayTeam.name);
      if (!home || !away) return;

      var scoreHome = null, scoreAway = null, actualResult = null;
      if (m.status === 'FINISHED' && m.score && m.score.fullTime) {
        scoreHome = m.score.fullTime.home;
        scoreAway = m.score.fullTime.away;
        if (scoreHome !== null && scoreAway !== null) {
          actualResult = scoreHome > scoreAway ? 'Home Win'
                       : scoreAway > scoreHome ? 'Away Win' : 'Draw';
        }
      }

      matches.push({
        home:          home,
        away:          away,
        league:        (m.competition && m.competition.name) || 'Unknown',
        kickoff_iso:   m.utcDate,
        status:        m.status,
        is_finished:   m.status === 'FINISHED',
        is_live:       m.status === 'IN_PLAY' || m.status === 'PAUSED',
        score_home:    scoreHome,
        score_away:    scoreAway,
        actual_result: actualResult
      });
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not fetch fixtures: ' + err.message });
  }

  if (!matches.length) {
    return res.status(200).json({
      date: reqDate, total: 0, finished: 0, correct: 0, wrong: 0,
      accuracy_pct: null, goals_pct: null, matches: [],
      message: 'No fixtures found for this date in the supported leagues.'
    });
  }

  // Regenerate predictions (same seed = same predictions always)
  var withPreds = addPredictions(matches, reqDate);

  // Score each finished match
  var correct = 0, wrong = 0, goalsCorrect = 0, goalsWrong = 0;
  withPreds.forEach(function(m) {
    if (!m.is_finished || !m.actual_result) return;
    var ok = isPredCorrect(m.prediction, m.actual_result, m.score_home, m.score_away);
    if (ok === true)  correct++;
    if (ok === false) wrong++;
    if (m.goals_prediction && m.score_home !== null) {
      var gOk = isGoalsPredCorrect(m.goals_prediction, m.score_home, m.score_away);
      if (gOk === true)  goalsCorrect++;
      if (gOk === false) goalsWrong++;
    }
  });

  var finished  = correct + wrong;
  var goalsTotal = goalsCorrect + goalsWrong;
  var accuracy  = finished  > 0 ? Math.round(correct      / finished   * 100) : null;
  var goalsPct  = goalsTotal > 0 ? Math.round(goalsCorrect / goalsTotal * 100) : null;

  var result = {
    date:         reqDate,
    total:        withPreds.length,
    finished:     finished,
    pending:      withPreds.filter(function(m){ return !m.is_finished && !m.is_live; }).length,
    live:         withPreds.filter(function(m){ return m.is_live; }).length,
    correct:      correct,
    wrong:        wrong,
    accuracy_pct: accuracy,
    goals_correct: goalsCorrect,
    goals_total:  goalsTotal,
    goals_pct:    goalsPct,
    matches:      withPreds
  };

  oracleCache[reqDate] = { data: result, fetched: Date.now() };
  return res.status(200).json(result);
};

// ── Deterministic prediction generator (matches main predict.js) ──
function addPredictions(matches, dateStr) {
  var seedBase = parseInt(dateStr.replace(/-/g, ''), 10);
  var si = 0;
  function rnd() { var x = Math.sin(seedBase + (++si) * 127773 + 49297) * 43758.5453; return x - Math.floor(x); }
  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
  function range(a, b) { return Math.floor(rnd() * (b - a + 1)) + a; }

  var predTypes = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goalMkts  = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals'];

  return matches.map(function(m, idx) {
    si = (seedBase % 999) + idx * 31 + m.home.length * 7;
    m.prediction       = pick(predTypes);
    m.confidence       = range(50, 88);
    m.goals_prediction = rnd() > .15 ? pick(goalMkts) : null;

    // Score the prediction if match is finished
    if (m.is_finished && m.actual_result) {
      m.is_correct      = isPredCorrect(m.prediction, m.actual_result, m.score_home, m.score_away);
      m.goals_is_correct = m.goals_prediction && m.score_home !== null
        ? isGoalsPredCorrect(m.goals_prediction, m.score_home, m.score_away) : null;
    }
    return m;
  });
}

function isPredCorrect(pred, actual, h, a) {
  if (!actual) return null;
  if (pred === 'Home Win')         return actual === 'Home Win';
  if (pred === 'Away Win')         return actual === 'Away Win';
  if (pred === 'Draw')             return actual === 'Draw';
  if (pred === 'Home Win or Draw') return actual === 'Home Win' || actual === 'Draw';
  if (pred === 'Away Win or Draw') return actual === 'Away Win' || actual === 'Draw';
  if (pred === 'Both Teams to Score' && h !== null) return h > 0 && a > 0;
  return null;
}

function isGoalsPredCorrect(pred, h, a) {
  var t = h + a;
  if (pred === 'Over 2.5 Goals')  return t > 2;
  if (pred === 'Under 2.5 Goals') return t < 3;
  if (pred === 'Over 1.5 Goals')  return t > 1;
  if (pred === 'BTTS Yes')        return h > 0 && a > 0;
  if (pred === 'BTTS No')         return h === 0 || a === 0;
  return null;
}
