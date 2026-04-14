// api/predict.js — ScoutAI
// Fetches 7 days in ONE API call to avoid rate limiting
// Returns the requested date's fixtures (or the next available date)

var cache = { data: null, fetched: 0, fromDate: null };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var reqDate = (req.query && req.query.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var apiKey = process.env.FOOTBALL_DATA_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FOOTBALL_DATA_KEY not set in Vercel Environment Variables.' });
  }

  // Fetch the whole week in ONE call (avoids rate limiting)
  // Cache for 15 minutes
  var cacheAge = Date.now() - (cache.fetched || 0);
  var weekData = null;

  if (cache.data && cacheAge < 900000 && cache.fromDate === today) {
    weekData = cache.data;
  } else {
    // dateFrom = today, dateTo = today + 7 days
    var endDate = new Date(today + 'T12:00:00Z');
    endDate.setUTCDate(endDate.getUTCDate() + 7);
    var endStr  = endDate.toISOString().slice(0, 10);

    try {
      var r = await fetch(
        'https://api.football-data.org/v4/matches?dateFrom=' + today + '&dateTo=' + endStr,
        { headers: { 'X-Auth-Token': apiKey } }
      );

      if (!r.ok) {
        var errJson = await r.json().catch(function() { return {}; });
        var errMsg  = (errJson.message) || ('football-data.org error: HTTP ' + r.status);
        return res.status(502).json({ error: errMsg });
      }

      var raw = await r.json();
      weekData = raw.matches || [];
      cache    = { data: weekData, fetched: Date.now(), fromDate: today };

    } catch (err) {
      return res.status(502).json({ error: 'Could not reach fixture data: ' + err.message });
    }
  }

  // Group matches by date
  var byDate = {};
  weekData.forEach(function(m) {
    var d = m.utcDate ? m.utcDate.slice(0, 10) : null;
    if (!d) return;
    if (['SCHEDULED','TIMED','IN_PLAY','PAUSED','FINISHED'].indexOf(m.status) === -1) return;
    var home = m.homeTeam && (m.homeTeam.shortName || m.homeTeam.name);
    var away = m.awayTeam && (m.awayTeam.shortName || m.awayTeam.name);
    if (!home || !away || home === 'null' || away === 'null') return;
    if (!byDate[d]) byDate[d] = [];
    // Extract actual score for finished matches
    var scoreHome = null, scoreAway = null, actualResult = null;
    if (m.status === 'FINISHED' && m.score && m.score.fullTime) {
      scoreHome = m.score.fullTime.home;
      scoreAway = m.score.fullTime.away;
      if (scoreHome !== null && scoreAway !== null) {
        actualResult = scoreHome > scoreAway ? 'Home Win' : scoreAway > scoreHome ? 'Away Win' : 'Draw';
      }
    }
    byDate[d].push({
      home:          home,
      away:          away,
      league:        (m.competition && m.competition.name) || 'Unknown',
      kickoff_iso:   m.utcDate,
      is_live:       m.status === 'IN_PLAY' || m.status === 'PAUSED',
      is_finished:   m.status === 'FINISHED',
      score_home:    scoreHome,
      score_away:    scoreAway,
      actual_result: actualResult,
      status:        m.status
    });
  });

  // Find the requested date or the next available date
  var datesAvailable = Object.keys(byDate).sort();
  var targetDate = null;

  // First try the exact requested date
  if (byDate[reqDate] && byDate[reqDate].length) {
    targetDate = reqDate;
  } else {
    // Find the next date >= reqDate that has fixtures
    for (var i = 0; i < datesAvailable.length; i++) {
      if (datesAvailable[i] >= reqDate) {
        targetDate = datesAvailable[i];
        break;
      }
    }
  }

  if (!targetDate) {
    return res.status(200).json({
      predictions: [], edge: [], date: reqDate, requested: reqDate,
      message: 'No fixtures found in the next 7 days. This may be an international break week.'
    });
  }

  var matches = byDate[targetDate];
  var result  = addPredictions(matches, targetDate);

  return res.status(200).json(buildResponse(result, now, targetDate, reqDate));
};

// ── Add predictions + odds ───────────────────────────────────
function addPredictions(matches, dateStr) {
  var seedBase = parseInt(dateStr.replace(/-/g, ''), 10);
  var si = 0;
  function rnd() { var x = Math.sin(seedBase + (++si) * 127773 + 49297) * 43758.5453; return x - Math.floor(x); }
  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
  function range(a, b) { return Math.floor(rnd() * (b - a + 1)) + a; }
  function r2(n) { return Math.round(n * 100) / 100; }

  var predTypes = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goalMkts  = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals'];
  var edgeLvls  = ['none','none','low','medium','medium','high','elite'];
  var posFacts  = ['Strong home record this season','Title race pressure drives motivation','Revenge fixture after earlier defeat','Derby atmosphere expected','Unbeaten in last 6 at home','Star striker in exceptional form','5-game winning run adds momentum'];
  var negFacts  = ['Key midfielder suspended','Top scorer doubtful','Fixture congestion this week','Four players on injury list','Starting defender ruled out','Poor recent away form'];
  var verdicts  = ['Form and motivation firmly favour the home side.','Tactical discipline likely decisive here.','Goals expected as both sides push forward.','Narrative pressure creates an unpredictable edge.','Away form makes this far closer than it looks.','High stakes on both ends add significant weight.','Revenge angle adds extra motivation.','Home crowd expected to be decisive tonight.'];

  function calcOdds(pred, conf) {
    var p = conf / 100, h, d, a, M = 1.08;
    if      (pred === 'Home Win')         { h = p;      d = (1-p)*.55; a = (1-p)*.45; }
    else if (pred === 'Away Win')         { a = p;      d = (1-p)*.50; h = (1-p)*.50; }
    else if (pred === 'Draw')             { d = p;      h = (1-p)*.55; a = (1-p)*.45; }
    else if (pred === 'Home Win or Draw') { h = p*.6;   d = p*.4;      a = 1-p; }
    else if (pred === 'Away Win or Draw') { a = p*.6;   d = p*.4;      h = 1-p; }
    else                                  { h = .40;    d = .28;       a = .32; }
    var t = h + d + a; h /= t; d /= t; a /= t;
    return { home: r2(M/h), draw: r2(M/d), away: r2(M/a) };
  }

  var predictions = matches.map(function(m, idx) {
    si = (seedBase % 999) + idx * 31 + m.home.length * 7;
    m.prediction       = pick(predTypes);
    m.confidence       = range(50, 88);
    m.goals_prediction = rnd() > .15 ? pick(goalMkts) : null;
    m.goals_confidence = m.goals_prediction ? range(52, 83) : null;
    m.odds             = calcOdds(m.prediction, m.confidence);
    var elvl   = pick(edgeLvls);
    var escore = elvl==='none'?range(5,25):elvl==='low'?range(30,48):elvl==='medium'?range(50,68):elvl==='high'?range(70,84):range(85,97);
    var nf     = (elvl === 'none' || elvl === 'low') ? 1 : 2;
    var facts  = [];
    for (var f = 0; f < nf; f++) facts.push({ label: f===0?pick(posFacts):pick(negFacts), type: f===0?'positive':'negative' });
    m._edge = { index: idx, edge_score: escore, edge_level: elvl, factors: facts, verdict: pick(verdicts) };
    return m;
  });

  var edgeData = predictions.map(function(m) { var e = m._edge; delete m._edge; return e; });
  return { predictions: predictions, edge: edgeData, date: dateStr, fetched_at: new Date().toISOString() };
}

// ── Sort response: live first, then by kickoff ───────────────
function buildResponse(raw, now, scanDate, reqDate) {
  var preds = (raw.predictions || []).slice().sort(function(a, b) {
    if (a.is_live && !b.is_live)     return -1;
    if (!a.is_live && b.is_live)     return 1;
    if (a.is_finished && !b.is_finished) return 1;
    if (!a.is_finished && b.is_finished) return -1;
    return new Date(a.kickoff_iso) - new Date(b.kickoff_iso);
  });
  var em = {};
  (raw.edge || []).forEach(function(e, i) { em[i] = e; });
  var edge = preds.map(function(m, i) {
    var orig = (raw.predictions || []).indexOf(m);
    return Object.assign({}, em[orig] || { index:i, edge_score:20, edge_level:'none', factors:[], verdict:'' }, { index: i });
  });
  return { predictions: preds, edge: edge, date: scanDate, requested: reqDate, fetched_at: raw.fetched_at };
}
