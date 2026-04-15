// api/oracle.js — The Oracle: End-of-Day Accuracy Report
// Uses API-Football (RapidAPI) for worldwide coverage
// Only scores FINISHED matches — no live tracking, no false results

var cache = {};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var utcHour = now.getUTCHours();

  var reqDate = (req.query && req.query.date);
  if (!reqDate || !/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) {
    reqDate = utcHour >= 23 ? today : (function() {
      var y = new Date(today + 'T12:00:00Z'); y.setUTCDate(y.getUTCDate() - 1);
      return y.toISOString().slice(0, 10);
    })();
  }

  var isToday = reqDate === today;

  // Today only available after 23:00 UTC
  if (isToday && utcHour < 23) {
    return res.status(200).json({
      date: reqDate, ready: false,
      message: "Today's Oracle report will be ready after 23:00 UTC once all matches are complete.",
      hours_remaining: 23 - utcHour
    });
  }

  // Cache: 10 min for today, 6 hrs for past days
  var cached = cache[reqDate];
  if (cached && (Date.now() - cached.ts) < (isToday ? 600000 : 21600000)) {
    return res.status(200).json(cached.data);
  }

  var apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RAPIDAPI_KEY not set in Vercel Environment Variables.' });

  try {
    var r = await fetch('https://api-football-v1.p.rapidapi.com/v3/fixtures?date=' + reqDate, {
      headers: {
        'X-RapidAPI-Key':  apiKey,
        'X-RapidAPI-Host': 'api-football-v1.p.rapidapi.com'
      }
    });
    if (!r.ok) {
      var e = await r.json().catch(function(){ return {}; });
      return res.status(502).json({ error: (e && e.message) || 'API error ' + r.status });
    }

    var data    = await r.json();
    var fixtures = (data && data.response) || [];

    var matches = [];
    fixtures.forEach(function(f, idx) {
      var fix   = f.fixture;
      var teams = f.teams;
      var goals = f.goals;
      if (!fix || !teams) return;

      var status    = fix.status && fix.status.short;
      var isFinished  = ['FT','AET','PEN'].indexOf(status) !== -1;
      var isPostponed = ['PST','CANC','ABD','WO','AWD'].indexOf(status) !== -1;

      var home = teams.home && teams.home.name;
      var away = teams.away && teams.away.name;
      if (!home || !away) return;

      var league  = f.league && f.league.name;
      var country = f.league && f.league.country;
      var leagueDisplay = country && country !== 'World' ? league + ' (' + country + ')' : league;

      var sh = isFinished ? (goals && goals.home) : null;
      var sa = isFinished ? (goals && goals.away) : null;
      var actual = (isFinished && sh !== null && sa !== null)
        ? (sh > sa ? 'Home Win' : sa > sh ? 'Away Win' : 'Draw') : null;

      var pred       = genPrediction(reqDate, idx, home);
      var isCorrect  = isFinished && actual ? checkPred(pred.prediction, actual, sh, sa) : null;
      var goalsCorrect = isFinished && pred.goals_prediction && sh !== null
        ? checkGoals(pred.goals_prediction, sh, sa) : null;

      matches.push({
        home: home, away: away,
        league: leagueDisplay,
        kickoff_utc: fix.date,
        status: isFinished ? 'finished' : isPostponed ? 'postponed' : 'unresolved',
        score_home: sh, score_away: sa, actual_result: actual,
        prediction: pred.prediction,
        confidence: pred.confidence,
        goals_prediction: pred.goals_prediction,
        is_correct: isCorrect,
        goals_is_correct: goalsCorrect
      });
    });

    var finished  = matches.filter(function(m){ return m.status==='finished'; });
    var postponed = matches.filter(function(m){ return m.status==='postponed'; });
    var scored    = finished.filter(function(m){ return m.is_correct!==null; });
    var correct   = scored.filter(function(m){ return m.is_correct===true; });
    var wrong     = scored.filter(function(m){ return m.is_correct===false; });
    var gScored   = finished.filter(function(m){ return m.goals_is_correct!==null; });
    var gCorrect  = gScored.filter(function(m){ return m.goals_is_correct===true; });

    var result = {
      date: reqDate, ready: true,
      total: matches.length,
      finished: finished.length,
      scored: scored.length,
      correct: correct.length,
      wrong: wrong.length,
      postponed: postponed.length,
      accuracy_pct:  scored.length  > 0 ? Math.round(correct.length  / scored.length  * 100) : null,
      goals_correct: gCorrect.length,
      goals_total:   gScored.length,
      goals_pct:     gScored.length > 0 ? Math.round(gCorrect.length / gScored.length * 100) : null,
      matches: matches.sort(function(a, b) {
        var o = { finished:0, postponed:1, unresolved:2 };
        return (o[a.status]||9) - (o[b.status]||9);
      })
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
  var preds = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goals = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals'];
  return { prediction:pick(preds), confidence:Math.floor(rnd()*38)+50, goals_prediction:rnd()>.15?pick(goals):null };
}
function checkPred(pred, actual, h, a) {
  if (!actual) return null;
  if (pred==='Home Win')         return actual==='Home Win';
  if (pred==='Away Win')         return actual==='Away Win';
  if (pred==='Draw')             return actual==='Draw';
  if (pred==='Home Win or Draw') return actual==='Home Win'||actual==='Draw';
  if (pred==='Away Win or Draw') return actual==='Away Win'||actual==='Draw';
  if (pred==='Both Teams to Score'&&h!==null) return h>0&&a>0;
  return null;
}
function checkGoals(pred, h, a) {
  var t=h+a;
  if (pred==='Over 2.5 Goals')  return t>2;
  if (pred==='Under 2.5 Goals') return t<3;
  if (pred==='Over 1.5 Goals')  return t>1;
  if (pred==='BTTS Yes')        return h>0&&a>0;
  if (pred==='BTTS No')         return h===0||a===0;
  return null;
}
