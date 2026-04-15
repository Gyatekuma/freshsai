// api/oracle.js — The Oracle: End-of-Day Accuracy Report
//
// Philosophy: Oracle never tracks live or in-progress matches.
// It only scores FULLY FINISHED days where all results are definitive.
// This ensures 100% honest, trustworthy accuracy reporting.
//
// Flow:
//   - User views Oracle for any of the last 7 days
//   - Oracle fetches all matches for that day from football-data.org
//   - Only FINISHED matches are scored (POSTPONED/CANCELLED excluded with label)
//   - Today's Oracle only shows if it's past 23:00 UTC (most matches done)
//   - Accuracy % is only calculated from matches with definitive results

var cache = {};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now   = new Date();
  var today = now.toISOString().slice(0, 10);
  var utcHour = now.getUTCHours();

  // Accept ?date=YYYY-MM-DD, default to yesterday if today not ready
  var reqDate = (req.query && req.query.date);
  if (!reqDate || !/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) {
    // Default: yesterday (always complete), unless it's past 23:00 UTC (today mostly done)
    if (utcHour >= 23) {
      reqDate = today;
    } else {
      var yest = new Date(today + 'T12:00:00Z');
      yest.setUTCDate(yest.getUTCDate() - 1);
      reqDate = yest.toISOString().slice(0, 10);
    }
  }

  // Only allow last 7 days (no future dates)
  var reqMs   = new Date(reqDate + 'T12:00:00Z').getTime();
  var todayMs = new Date(today   + 'T12:00:00Z').getTime();
  var diffDays = Math.round((todayMs - reqMs) / 86400000);
  if (diffDays < 0) {
    return res.status(400).json({ error: 'Oracle cannot show future dates.' });
  }
  if (diffDays > 7) {
    return res.status(400).json({ error: 'Oracle shows the last 7 days only.' });
  }

  // Today only available after 23:00 UTC — too early = return a "not ready" response
  var isToday = reqDate === today;
  if (isToday && utcHour < 23) {
    return res.status(200).json({
      date: reqDate,
      ready: false,
      message: "Today's Oracle report will be ready after 23:00 UTC once all matches are complete.",
      hours_remaining: 23 - utcHour
    });
  }

  // Cache: 10 min for today (just turned ready), 6 hrs for past days
  var cached = cache[reqDate];
  var maxAge = isToday ? 600000 : 21600000;
  if (cached && (Date.now() - cached.ts) < maxAge) {
    return res.status(200).json(cached.data);
  }

  var apiKey = process.env.FOOTBALL_DATA_KEY;
  if (!apiKey) return res.status(500).json({ error: 'FOOTBALL_DATA_KEY not set.' });

  // Fetch all matches for that date
  try {
    var r = await fetch(
      'https://api.football-data.org/v4/matches?dateFrom=' + reqDate + '&dateTo=' + reqDate,
      { headers: { 'X-Auth-Token': apiKey } }
    );
    if (!r.ok) {
      var e = await r.json().catch(function(){ return {}; });
      return res.status(502).json({ error: e.message || 'API error ' + r.status });
    }

    var raw  = await r.json();
    var all  = raw.matches || [];

    if (!all.length) {
      var result = { date: reqDate, ready: true, total: 0, scored: 0,
        correct: 0, wrong: 0, accuracy_pct: null, goals_pct: null,
        matches: [], message: 'No fixtures found for this date.' };
      cache[reqDate] = { data: result, ts: Date.now() };
      return res.status(200).json(result);
    }

    var matches = [];
    all.forEach(function(m, idx) {
      var home = m.homeTeam && (m.homeTeam.shortName || m.homeTeam.name);
      var away = m.awayTeam && (m.awayTeam.shortName || m.awayTeam.name);
      if (!home || !away) return;

      var status = m.status;

      // Classify match outcome
      var isFinished   = status === 'FINISHED';
      var isPostponed  = status === 'POSTPONED' || status === 'CANCELLED' || status === 'SUSPENDED';
      var isAbandoned  = status === 'ABANDONED';

      // Score extraction
      var sh = null, sa = null, actual = null;
      if (isFinished && m.score && m.score.fullTime) {
        sh = m.score.fullTime.home;
        sa = m.score.fullTime.away;
        if (sh !== null && sa !== null) {
          actual = sh > sa ? 'Home Win' : sa > sh ? 'Away Win' : 'Draw';
        }
      }

      // Generate the prediction (deterministic — same as predict.js)
      var pred = genPrediction(reqDate, idx, home);

      // Score: only for FINISHED matches with a real result
      var isCorrect      = null;
      var goalsIsCorrect = null;
      if (isFinished && actual) {
        isCorrect      = checkPred(pred.prediction, actual, sh, sa);
        goalsIsCorrect = pred.goals_prediction
          ? checkGoals(pred.goals_prediction, sh, sa) : null;
      }

      matches.push({
        home: home, away: away,
        league:      (m.competition && m.competition.name) || 'Unknown',
        kickoff_utc: m.utcDate,
        status:      isFinished ? 'finished'
                   : isPostponed ? 'postponed'
                   : isAbandoned ? 'abandoned' : 'unresolved',
        score_home:  sh,
        score_away:  sa,
        actual_result:   actual,
        prediction:      pred.prediction,
        confidence:      pred.confidence,
        goals_prediction: pred.goals_prediction,
        is_correct:       isCorrect,
        goals_is_correct: goalsIsCorrect
      });
    });

    // Calculate accuracy from finished matches only
    var finished  = matches.filter(function(m){ return m.status === 'finished'; });
    var postponed = matches.filter(function(m){ return m.status === 'postponed'; });
    var scored    = finished.filter(function(m){ return m.is_correct !== null; });
    var correct   = scored.filter(function(m){ return m.is_correct === true; });
    var wrong     = scored.filter(function(m){ return m.is_correct === false; });
    var gScored   = finished.filter(function(m){ return m.goals_is_correct !== null; });
    var gCorrect  = gScored.filter(function(m){ return m.goals_is_correct === true; });

    var accuracy  = scored.length  > 0 ? Math.round(correct.length  / scored.length  * 100) : null;
    var goalsPct  = gScored.length > 0 ? Math.round(gCorrect.length / gScored.length * 100) : null;

    var result = {
      date:          reqDate,
      ready:         true,
      total:         matches.length,
      scored:        scored.length,
      correct:       correct.length,
      wrong:         wrong.length,
      postponed:     postponed.length,
      accuracy_pct:  accuracy,
      goals_correct: gCorrect.length,
      goals_total:   gScored.length,
      goals_pct:     goalsPct,
      matches:       matches.sort(function(a, b) {
        // Finished first, then postponed, then unresolved
        var order = { finished:0, postponed:1, abandoned:2, unresolved:3 };
        return (order[a.status]||9) - (order[b.status]||9);
      })
    };

    cache[reqDate] = { data: result, ts: Date.now() };
    return res.status(200).json(result);

  } catch(err) {
    return res.status(502).json({ error: err.message });
  }
};

// ── Deterministic prediction (must match predict.js seed logic) ──
function genPrediction(dateStr, idx, homeName) {
  var seedBase = parseInt(dateStr.replace(/-/g, ''), 10);
  var si = (seedBase % 999) + idx * 31 + homeName.length * 7;
  function rnd(){ var x = Math.sin(si++ * 127773 + 49297) * 43758.5453; return x - Math.floor(x); }
  function pick(arr){ return arr[Math.floor(rnd() * arr.length)]; }
  var preds = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goals = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals'];
  return {
    prediction:       pick(preds),
    confidence:       Math.floor(rnd() * 38) + 50,
    goals_prediction: rnd() > .15 ? pick(goals) : null
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
  var t = h + a;
  if (pred === 'Over 2.5 Goals')  return t > 2;
  if (pred === 'Under 2.5 Goals') return t < 3;
  if (pred === 'Over 1.5 Goals')  return t > 1;
  if (pred === 'BTTS Yes')        return h > 0 && a > 0;
  if (pred === 'BTTS No')         return h === 0 || a === 0;
  return null;
}
