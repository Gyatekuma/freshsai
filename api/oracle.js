// api/oracle.js — The Oracle: Real Accuracy Tracker
// Uses BetMiner for both predictions AND real scores
// Same data source = perfectly matched comparison
// Cache: 24hr for past days, 10min for today (after 23:00 UTC)

var cache = {};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var utcHour = now.getUTCHours();

  var reqDate = (req.query && req.query.date) || null;
  var explicit = !!reqDate;
  if (!reqDate || !/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) {
    reqDate = utcHour >= 23 ? today : (function(){
      var y = new Date(today+'T12:00:00Z'); y.setUTCDate(y.getUTCDate()-1);
      return y.toISOString().slice(0,10);
    })();
  }

  var isToday = reqDate === today;
  if (isToday && utcHour < 23) {
    return res.status(200).json({
      date: reqDate, ready: false,
      message: "Today's Oracle report will be ready after 23:00 UTC.",
      hours_remaining: 23 - utcHour
    });
  }

  var cached = cache[reqDate];
  var maxAge = isToday ? 600000 : 86400000;
  if (cached && (Date.now()-cached.ts) < maxAge) {
    return res.status(200).json(cached.data);
  }

  var apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RAPIDAPI_KEY not set.' });

  try {
    var r = await fetch('https://betminer.p.rapidapi.com/bm/v3/edge-analysis/' + reqDate, {
      headers: {
        'Content-Type':    'application/json',
        'x-rapidapi-key':  apiKey,
        'x-rapidapi-host': 'betminer.p.rapidapi.com'
      }
    });

    if (r.status === 429) {
      if (cached) return res.status(200).json(cached.data);
      if(cached) return res.status(200).json(cached.data);
      return res.status(200).json({ date:reqDate, ready:false, message:'Report not available for this date.' });
    }
    if (!r.ok) {
      var e = await r.json().catch(function(){ return {}; });
      return res.status(502).json({ error: e.message || 'API error '+r.status });
    }

    var raw   = await r.json();
    var items = (raw.data && Array.isArray(raw.data)) ? raw.data : Array.isArray(raw) ? raw : [];

    if (!items.length) {
      var empty = { date:reqDate, ready:true, total:0, finished:0, scored:0,
        correct:0, wrong:0, postponed:0, accuracy_pct:null,
        goals_correct:0, goals_total:0, goals_pct:null, matches:[],
        message:'No fixtures found for '+reqDate };
      cache[reqDate] = { data:empty, ts:Date.now() };
      return res.status(200).json(empty);
    }

    var matches = [];
    items.forEach(function(m) {
      var home = m.home_team && m.home_team.name;
      var away = m.away_team && m.away_team.name;
      if (!home||!away) return;

      var status     = (m.status||'').toUpperCase();
      var isFinished = status==='FT'||status==='FINISHED'||status==='AET'||status==='PEN';
      var isPostponed= status==='CANC'||status==='PST'||status==='SUSP'||status==='ABD';

      // Real score from BetMiner
      var sh=null, sa=null, actual=null;
      if (isFinished && m.score) {
        sh = m.score.home; sa = m.score.away;
        if (sh!==null&&sa!==null) actual = sh>sa?'Home Win':sa>sh?'Away Win':'Draw';
      }

      // BetMiner's real prediction
      var probs = m.probabilities||{};
      var predResult = m.predictions && m.predictions.result;
      var pHome = Number(probs.home_win)||33;
      var pDraw = Number(probs.draw)||33;
      var pAway = Number(probs.away_win)||33;
      var prediction = predResult==='home_win'?'Home Win':predResult==='away_win'?'Away Win':predResult==='draw'?'Draw'
        : pHome>=pDraw&&pHome>=pAway?'Home Win':pAway>pHome&&pAway>=pDraw?'Away Win':'Draw';
      var confidence = Math.round(Math.max(pHome,pDraw,pAway));

      // Goals prediction
      var pBTTS=Number(probs.btts)||50, pOver25=Number(probs.over_25)||50;
      var goalsPred=null;
      if(pBTTS>=65)goalsPred='BTTS Yes';
      else if(pBTTS<=35)goalsPred='BTTS No';
      else if(pOver25>=65)goalsPred='Over 2.5 Goals';
      else if(pOver25<=35)goalsPred='Under 2.5 Goals';

      var isCorrect=null, goalsCorrect=null;
      if(isFinished&&actual){
        isCorrect=prediction===actual;
        if(goalsPred&&sh!==null) goalsCorrect=checkGoals(goalsPred,sh,sa);
      }

      matches.push({
        home:home, away:away,
        league:(m.competition&&m.competition.name)||'Unknown',
        kickoff_utc:m.kickoff,
        status:isFinished?'finished':isPostponed?'postponed':'unresolved',
        score_home:sh, score_away:sa, actual_result:actual,
        prediction:prediction, confidence:confidence,
        goals_prediction:goalsPred,
        is_correct:isCorrect, goals_is_correct:goalsCorrect
      });
    });

    var finished  = matches.filter(function(m){return m.status==='finished';});
    var postponed = matches.filter(function(m){return m.status==='postponed';});
    var scored    = finished.filter(function(m){return m.is_correct!==null;});
    var correct   = scored.filter(function(m){return m.is_correct===true;});
    var wrong     = scored.filter(function(m){return m.is_correct===false;});
    var gScored   = finished.filter(function(m){return m.goals_is_correct!==null;});
    var gCorrect  = gScored.filter(function(m){return m.goals_is_correct===true;});

    var result = {
      date:reqDate, ready:true,
      total:matches.length, finished:finished.length,
      scored:scored.length, correct:correct.length, wrong:wrong.length,
      postponed:postponed.length,
      accuracy_pct: scored.length>0 ? Math.round(correct.length/scored.length*100) : null,
      goals_correct:gCorrect.length, goals_total:gScored.length,
      goals_pct: gScored.length>0 ? Math.round(gCorrect.length/gScored.length*100) : null,
      matches: matches.sort(function(a,b){
        var o={finished:0,postponed:1,unresolved:2};
        return (o[a.status]||9)-(o[b.status]||9);
      })
    };

    cache[reqDate]={data:result,ts:Date.now()};
    return res.status(200).json(result);

  } catch(err) {
    if(cached) return res.status(200).json(cached.data);
    return res.status(502).json({ error:err.message });
  }
};

function checkGoals(pred,h,a){
  var t=h+a;
  if(pred==='Over 2.5 Goals')  return t>2;
  if(pred==='Under 2.5 Goals') return t<3;
  if(pred==='Over 1.5 Goals')  return t>1;
  if(pred==='BTTS Yes')        return h>0&&a>0;
  if(pred==='BTTS No')         return h===0||a===0;
  return null;
}
