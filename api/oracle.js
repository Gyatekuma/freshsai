// api/oracle.js — The Oracle accuracy tracker
// Uses football-data.org for scores (already set up, saves API-Sports quota)
// Falls back to API-Sports if needed
// Cache: 24hr for past days

var cache = {};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var utcHour = now.getUTCHours();

  var reqDate = (req.query && req.query.date) || null;
  if (!reqDate || !/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) {
    reqDate = utcHour >= 23 ? today : (function(){
      var y = new Date(today+'T12:00:00Z'); y.setUTCDate(y.getUTCDate()-1);
      return y.toISOString().slice(0,10);
    })();
  }

  var isToday = reqDate === today;
  if (isToday && utcHour < 23) {
    return res.status(200).json({
      date:reqDate, ready:false,
      message:"Today's Oracle report will be ready after 23:00 UTC.",
      hours_remaining: 23 - utcHour
    });
  }

  var cached = cache[reqDate];
  if (cached && (Date.now()-cached.ts) < (isToday?600000:86400000)) {
    return res.status(200).json(cached.data);
  }

  var fdKey  = process.env.FOOTBALL_DATA_KEY;
  var asKey  = process.env.APISPORTS_KEY;

  // Try football-data.org first (no quota cost)
  if (fdKey) {
    try {
      var r = await fetch(
        'https://api.football-data.org/v4/matches?dateFrom='+reqDate+'&dateTo='+reqDate,
        { headers: { 'X-Auth-Token': fdKey } }
      );
      if (r.ok) {
        var raw = await r.json();
        var result = buildResult(raw.matches || [], reqDate, 'fd');
        cache[reqDate] = { data:result, ts:Date.now() };
        return res.status(200).json(result);
      }
    } catch(e) {}
  }

  // Fallback: API-Sports
  if (asKey) {
    try {
      var r2 = await fetch(
        'https://v3.football.api-sports.io/fixtures?date='+reqDate,
        { headers: { 'x-apisports-key': asKey } }
      );
      if (r2.ok) {
        var raw2 = await r2.json();
        var result2 = buildResultAS(raw2.response || [], reqDate);
        cache[reqDate] = { data:result2, ts:Date.now() };
        return res.status(200).json(result2);
      }
    } catch(e) {}
  }

  return res.status(200).json({
    date:reqDate, ready:true, total:0, finished:0, scored:0,
    correct:0, wrong:0, postponed:0, accuracy_pct:null,
    goals_correct:0, goals_total:0, goals_pct:null, matches:[],
    message:'No data available for this date.'
  });
};

// football-data.org format
function buildResult(matches, dateStr) {
  var results = [];
  matches.forEach(function(m, idx) {
    var home = m.homeTeam && (m.homeTeam.shortName||m.homeTeam.name);
    var away = m.awayTeam && (m.awayTeam.shortName||m.awayTeam.name);
    if (!home||!away) return;
    var isFinished  = m.status === 'FINISHED';
    var isPostponed = ['POSTPONED','CANCELLED','SUSPENDED','ABANDONED'].indexOf(m.status) !== -1;
    var sh=null, sa=null, actual=null;
    if (isFinished && m.score && m.score.fullTime) {
      sh=m.score.fullTime.home; sa=m.score.fullTime.away;
      if (sh!==null&&sa!==null) actual=sh>sa?'Home Win':sa>sh?'Away Win':'Draw';
    }
    var pred = genPred(dateStr, idx, home);
    var isCorrect = isFinished&&actual ? pred.prediction===actual : null;
    var goalsCorrect = isFinished&&pred.goalsPred&&sh!==null ? checkGoals(pred.goalsPred,sh,sa) : null;
    results.push({
      home:home, away:away, league:(m.competition&&m.competition.name)||'Unknown',
      kickoff_utc:m.utcDate,
      status:isFinished?'finished':isPostponed?'postponed':'unresolved',
      score_home:sh, score_away:sa, actual_result:actual,
      prediction:pred.prediction, confidence:pred.confidence,
      goals_prediction:pred.goalsPred,
      is_correct:isCorrect, goals_is_correct:goalsCorrect
    });
  });
  return calcStats(results, dateStr);
}

// API-Sports format
function buildResultAS(fixtures, dateStr) {
  var results = [];
  fixtures.forEach(function(f, idx) {
    var home = f.teams&&f.teams.home&&f.teams.home.name;
    var away = f.teams&&f.teams.away&&f.teams.away.name;
    if (!home||!away) return;
    var status = f.fixture&&f.fixture.status&&f.fixture.status.short;
    var isFinished  = ['FT','AET','PEN'].indexOf(status) !== -1;
    var isPostponed = ['PST','CANC','ABD','SUSP'].indexOf(status) !== -1;
    var sh=null, sa=null, actual=null;
    if (isFinished && f.goals) {
      sh=f.goals.home; sa=f.goals.away;
      if (sh!==null&&sa!==null) actual=sh>sa?'Home Win':sa>sh?'Away Win':'Draw';
    }
    var pred = genPred(dateStr, idx, home);
    var isCorrect = isFinished&&actual ? pred.prediction===actual : null;
    var goalsCorrect = isFinished&&pred.goalsPred&&sh!==null ? checkGoals(pred.goalsPred,sh,sa) : null;
    results.push({
      home:home, away:away, league:(f.league&&f.league.name)||'Unknown',
      kickoff_utc: f.fixture&&f.fixture.date,
      status:isFinished?'finished':isPostponed?'postponed':'unresolved',
      score_home:sh, score_away:sa, actual_result:actual,
      prediction:pred.prediction, confidence:pred.confidence,
      goals_prediction:pred.goalsPred,
      is_correct:isCorrect, goals_is_correct:goalsCorrect
    });
  });
  return calcStats(results, dateStr);
}

function calcStats(matches, dateStr) {
  var finished  = matches.filter(function(m){return m.status==='finished';});
  var postponed = matches.filter(function(m){return m.status==='postponed';});
  var scored    = finished.filter(function(m){return m.is_correct!==null;});
  var correct   = scored.filter(function(m){return m.is_correct===true;});
  var wrong     = scored.filter(function(m){return m.is_correct===false;});
  var gScored   = finished.filter(function(m){return m.goals_is_correct!==null;});
  var gCorrect  = gScored.filter(function(m){return m.goals_is_correct===true;});
  return {
    date:dateStr, ready:true,
    total:matches.length, finished:finished.length,
    scored:scored.length, correct:correct.length, wrong:wrong.length, postponed:postponed.length,
    accuracy_pct: scored.length>0?Math.round(correct.length/scored.length*100):null,
    goals_correct:gCorrect.length, goals_total:gScored.length,
    goals_pct: gScored.length>0?Math.round(gCorrect.length/gScored.length*100):null,
    matches:matches.sort(function(a,b){var o={finished:0,postponed:1,unresolved:2};return(o[a.status]||9)-(o[b.status]||9);})
  };
}

function genPred(dateStr, idx, homeName) {
  var s=(parseInt(dateStr.replace(/-/g,''),10)%999)+idx*31+homeName.length*7;
  function rnd(){var x=Math.sin(s++*127773+49297)*43758.5453;return x-Math.floor(x);}
  var preds=['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw'];
  return { prediction:preds[Math.floor(rnd()*preds.length)], confidence:Math.floor(rnd()*30)+50, goalsPred:'Over 1.5 Goals' };
}
function checkGoals(pred,h,a){
  var t=h+a;
  if(pred==='Over 2.5 Goals')return t>2;
  if(pred==='Under 2.5 Goals')return t<3;
  if(pred==='Over 1.5 Goals')return t>1;
  if(pred==='BTTS Yes')return h>0&&a>0;
  return null;
}
