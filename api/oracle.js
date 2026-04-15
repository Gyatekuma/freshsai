// api/oracle.js — The Oracle: End-of-Day Accuracy Report
// Scans back to find most recent date with finished matches
// Uses football-data.org (FOOTBALL_DATA_KEY in Vercel env vars)

var cache = {};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var utcHour = now.getUTCHours();

  var reqDate = (req.query && req.query.date) || null;
  var explicitDate = !!reqDate;

  if (!reqDate || !/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) {
    // Default: yesterday (always complete). Today only after 23:00 UTC.
    if (utcHour >= 23) {
      reqDate = today;
    } else {
      var y = new Date(today + 'T12:00:00Z');
      y.setUTCDate(y.getUTCDate() - 1);
      reqDate = y.toISOString().slice(0, 10);
    }
  }

  var isToday = reqDate === today;

  // Today only available after 23:00 UTC
  if (isToday && utcHour < 23) {
    return res.status(200).json({
      date: reqDate, ready: false,
      message: "Today's Oracle report is available after 23:00 UTC once all matches are complete.",
      hours_remaining: 23 - utcHour
    });
  }

  // Cache: 10 min for today, 6 hrs for past
  var cached = cache[reqDate];
  if (cached && (Date.now() - cached.ts) < (isToday ? 600000 : 21600000)) {
    return res.status(200).json(cached.data);
  }

  var apiKey = process.env.FOOTBALL_DATA_KEY;
  if (!apiKey) return res.status(500).json({ error: 'FOOTBALL_DATA_KEY not set.' });

  // If explicit date requested, just fetch that date
  if (explicitDate) {
    var result = await fetchOracleDate(reqDate, apiKey);
    if (result.error) return res.status(502).json(result);
    cache[reqDate] = { data: result, ts: Date.now() };
    return res.status(200).json(result);
  }

  // Auto-mode: scan back up to 7 days to find one with finished matches
  for (var daysBack = 0; daysBack <= 6; daysBack++) {
    var scanDate = new Date(today + 'T12:00:00Z');
    scanDate.setUTCDate(scanDate.getUTCDate() - (daysBack + (isToday ? 0 : 1)));
    var ds = scanDate.toISOString().slice(0, 10);

    // Skip today if not yet ready
    if (ds === today && utcHour < 23) continue;

    var cached2 = cache[ds];
    if (cached2 && (Date.now() - cached2.ts) < 21600000 && cached2.data.finished > 0) {
      return res.status(200).json(cached2.data);
    }

    var result2 = await fetchOracleDate(ds, apiKey);
    if (!result2.error) {
      cache[ds] = { data: result2, ts: Date.now() };
      if (result2.finished > 0) return res.status(200).json(result2);
    }
  }

  return res.status(200).json({
    date: reqDate, ready: true, total: 0, finished: 0, scored: 0,
    correct: 0, wrong: 0, postponed: 0, accuracy_pct: null,
    goals_correct: 0, goals_total: 0, goals_pct: null, matches: [],
    message: 'No finished matches found in the last 7 days for supported leagues.'
  });
};

async function fetchOracleDate(dateStr, apiKey) {
  try {
    var r = await fetch(
      'https://api.football-data.org/v4/matches?dateFrom=' + dateStr + '&dateTo=' + dateStr,
      { headers: { 'X-Auth-Token': apiKey } }
    );
    if (!r.ok) {
      var e = await r.json().catch(function(){ return {}; });
      return { error: e.message || 'football-data.org error ' + r.status };
    }
    var raw  = await r.json();
    var all  = raw.matches || [];

    var matches = [];
    all.forEach(function(m, idx) {
      var home = m.homeTeam && (m.homeTeam.shortName || m.homeTeam.name);
      var away = m.awayTeam && (m.awayTeam.shortName || m.awayTeam.name);
      if (!home || !away) return;

      var status      = m.status;
      var isFinished  = status === 'FINISHED';
      var isPostponed = ['POSTPONED','CANCELLED','SUSPENDED','ABANDONED'].indexOf(status) !== -1;

      var sh = null, sa = null, actual = null;
      if (isFinished && m.score && m.score.fullTime) {
        sh = m.score.fullTime.home;
        sa = m.score.fullTime.away;
        if (sh !== null && sa !== null)
          actual = sh > sa ? 'Home Win' : sa > sh ? 'Away Win' : 'Draw';
      }

      var pred         = genPrediction(dateStr, idx, home);
      var isCorrect    = isFinished && actual ? checkPred(pred.prediction, actual, sh, sa) : null;
      var goalsCorrect = isFinished && pred.goals_prediction && sh !== null
        ? checkGoals(pred.goals_prediction, sh, sa) : null;

      matches.push({
        home: home, away: away,
        league:      (m.competition && m.competition.name) || 'Unknown',
        kickoff_utc: m.utcDate,
        status:      isFinished ? 'finished' : isPostponed ? 'postponed' : 'unresolved',
        score_home:  sh, score_away: sa, actual_result: actual,
        prediction:  pred.prediction, confidence: pred.confidence,
        goals_prediction: pred.goals_prediction,
        is_correct: isCorrect, goals_is_correct: goalsCorrect
      });
    });

    var finished  = matches.filter(function(m){ return m.status==='finished'; });
    var postponed = matches.filter(function(m){ return m.status==='postponed'; });
    var scored    = finished.filter(function(m){ return m.is_correct!==null; });
    var correct   = scored.filter(function(m){ return m.is_correct===true; });
    var wrong     = scored.filter(function(m){ return m.is_correct===false; });
    var gScored   = finished.filter(function(m){ return m.goals_is_correct!==null; });
    var gCorrect  = gScored.filter(function(m){ return m.goals_is_correct===true; });

    return {
      date:          dateStr,
      ready:         true,
      total:         matches.length,
      finished:      finished.length,
      scored:        scored.length,
      correct:       correct.length,
      wrong:         wrong.length,
      postponed:     postponed.length,
      accuracy_pct:  scored.length  > 0 ? Math.round(correct.length  / scored.length  * 100) : null,
      goals_correct: gCorrect.length,
      goals_total:   gScored.length,
      goals_pct:     gScored.length > 0 ? Math.round(gCorrect.length / gScored.length * 100) : null,
      matches: matches.sort(function(a,b){
        var o={finished:0,postponed:1,unresolved:2};
        return (o[a.status]||9)-(o[b.status]||9);
      })
    };
  } catch(err) {
    return { error: err.message };
  }
}

function genPrediction(dateStr, idx, homeName) {
  var seedBase = parseInt(dateStr.replace(/-/g,''), 10);
  var si = (seedBase % 999) + idx * 31 + homeName.length * 7;
  function rnd(){ var x=Math.sin(si++*127773+49297)*43758.5453; return x-Math.floor(x); }
  function pick(arr){ return arr[Math.floor(rnd()*arr.length)]; }
  var preds = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goals = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals'];
  return { prediction:pick(preds), confidence:Math.floor(rnd()*38)+50, goals_prediction:rnd()>.15?pick(goals):null };
}
function checkPred(pred,actual,h,a){
  if(!actual)return null;
  if(pred==='Home Win')         return actual==='Home Win';
  if(pred==='Away Win')         return actual==='Away Win';
  if(pred==='Draw')             return actual==='Draw';
  if(pred==='Home Win or Draw') return actual==='Home Win'||actual==='Draw';
  if(pred==='Away Win or Draw') return actual==='Away Win'||actual==='Draw';
  if(pred==='Both Teams to Score'&&h!==null) return h>0&&a>0;
  return null;
}
function checkGoals(pred,h,a){
  var t=h+a;
  if(pred==='Over 2.5 Goals')  return t>2;
  if(pred==='Under 2.5 Goals') return t<3;
  if(pred==='Over 1.5 Goals')  return t>1;
  if(pred==='BTTS Yes')        return h>0&&a>0;
  if(pred==='BTTS No')         return h===0||a===0;
  return null;
}
