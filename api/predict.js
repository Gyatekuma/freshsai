// api/predict.js — ScoutAI Predictions
// Uses API-Football (RapidAPI) — 1000+ leagues, free tier 100 req/day
// Get free key: rapidapi.com/api-sports/api/api-football
// Add RAPIDAPI_KEY to Vercel Environment Variables

var weekCache = { data: null, fetched: 0, fromDate: null };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var reqDate = (req.query && req.query.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'RAPIDAPI_KEY not set. Get a free key at rapidapi.com/api-sports/api/api-football and add it to Vercel Environment Variables.'
    });
  }

  // Cache the week in one call — API-Football counts each call against daily quota
  var cacheAge = Date.now() - (weekCache.fetched || 0);
  var byDate   = null;

  if (weekCache.data && cacheAge < 900000 && weekCache.fromDate === today) {
    byDate = weekCache.data;
  } else {
    // Fetch today + 6 days in parallel (7 separate calls but we cache for 15min)
    // To save quota, fetch only the requested date + next 3 days
    var datesToFetch = [];
    for (var di = 0; di < 4; di++) {
      var fd = new Date(today + 'T12:00:00Z');
      fd.setUTCDate(fd.getUTCDate() + di);
      datesToFetch.push(fd.toISOString().slice(0, 10));
    }

    byDate = {};
    try {
      // API-Football returns all fixtures for a given date in one call
      var fetches = datesToFetch.map(function(d) {
        return fetch('https://api-football-v1.p.rapidapi.com/v3/fixtures?date=' + d, {
          headers: {
            'X-RapidAPI-Key':  apiKey,
            'X-RapidAPI-Host': 'api-football-v1.p.rapidapi.com'
          }
        })
        .then(function(r) {
          if (!r.ok) return r.json().then(function(e) { throw new Error((e && e.message) || 'HTTP ' + r.status); });
          return r.json();
        })
        .then(function(data) {
          var fixtures = (data && data.response) || [];
          byDate[d] = processFixtures(fixtures);
        })
        .catch(function(err) {
          byDate[d] = []; // don't fail entire request for one day
          console.error('Fetch failed for', d, ':', err.message);
        });
      });

      await Promise.all(fetches);
      weekCache = { data: byDate, fetched: Date.now(), fromDate: today };

    } catch (err) {
      return res.status(502).json({ error: 'Could not fetch fixtures: ' + err.message });
    }
  }

  // Find requested date or next available
  var datesAvailable = Object.keys(byDate).sort();
  var targetDate = null;

  if (byDate[reqDate] && byDate[reqDate].length) {
    targetDate = reqDate;
  } else {
    for (var i = 0; i < datesAvailable.length; i++) {
      if (datesAvailable[i] >= reqDate && byDate[datesAvailable[i]].length) {
        targetDate = datesAvailable[i]; break;
      }
    }
  }

  if (!targetDate) {
    return res.status(200).json({
      predictions: [], edge: [], date: reqDate, requested: reqDate,
      message: 'No upcoming fixtures found for this period. Try a different date.'
    });
  }

  var result = addPredictions(byDate[targetDate], targetDate);
  return res.status(200).json(buildResponse(result, now, targetDate, reqDate));
};

// ── Process raw API-Football fixtures ────────────────────────
function processFixtures(fixtures) {
  var now = Date.now();
  var items = [];

  fixtures.forEach(function(f) {
    var fix    = f.fixture;
    var teams  = f.teams;
    var goals  = f.goals;
    if (!fix || !teams) return;

    var status     = fix.status && fix.status.short; // NS, 1H, HT, 2H, FT, PST, CANC, ABD etc.
    var kickoffISO = fix.date;

    // Only include: Not Started (NS) and matches with valid teams
    // Exclude: anything already started or done
    var isScheduled = status === 'NS' || status === 'TBD';
    var isLive      = ['1H','HT','2H','ET','BT','P','INT'].indexOf(status) !== -1;
    var isFinished  = ['FT','AET','PEN'].indexOf(status) !== -1;
    var isPostponed = ['PST','CANC','ABD','WO','AWD'].indexOf(status) !== -1;

    // Stale heuristic: kickoff >115 min ago and still NS = API lag
    var koMs = kickoffISO ? new Date(kickoffISO).getTime() : 0;
    var minsAgo = (now - koMs) / 60000;
    if (isScheduled && minsAgo > 115) { isFinished = true; isScheduled = false; }
    if (isLive      && minsAgo > 115) { isFinished = true; isLive      = false; }

    var home = teams.home && teams.home.name;
    var away = teams.away && teams.away.name;
    if (!home || !away) return;

    // League info
    var league = f.league && (f.league.name || 'Unknown');
    var country = f.league && f.league.country;
    var leagueDisplay = country && country !== 'World' ? league + ' (' + country + ')' : league;

    items.push({
      home:        home,
      away:        away,
      league:      leagueDisplay,
      kickoff_iso: kickoffISO,
      is_live:     isLive,
      is_finished: isFinished,
      is_postponed: isPostponed,
      status:      status,
      score_home:  isFinished ? (goals && goals.home) : null,
      score_away:  isFinished ? (goals && goals.away) : null
    });
  });

  // Sort by kickoff time
  items.sort(function(a, b) {
    return new Date(a.kickoff_iso) - new Date(b.kickoff_iso);
  });

  return items;
}

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
    if      (pred === 'Home Win')         { h = p;    d = (1-p)*.55; a = (1-p)*.45; }
    else if (pred === 'Away Win')         { a = p;    d = (1-p)*.50; h = (1-p)*.50; }
    else if (pred === 'Draw')             { d = p;    h = (1-p)*.55; a = (1-p)*.45; }
    else if (pred === 'Home Win or Draw') { h = p*.6; d = p*.4;      a = 1-p; }
    else if (pred === 'Away Win or Draw') { a = p*.6; d = p*.4;      h = 1-p; }
    else                                  { h = .40;  d = .28;       a = .32; }
    var t = h+d+a; h/=t; d/=t; a/=t;
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
    var nf     = (elvl==='none'||elvl==='low') ? 1 : 2;
    var facts  = [];
    for (var f = 0; f < nf; f++) facts.push({ label: f===0?pick(posFacts):pick(negFacts), type: f===0?'positive':'negative' });
    m._edge = { index: idx, edge_score: escore, edge_level: elvl, factors: facts, verdict: pick(verdicts) };
    return m;
  });

  var edgeData = predictions.map(function(m) { var e = m._edge; delete m._edge; return e; });
  return { predictions: predictions, edge: edgeData, date: dateStr, fetched_at: new Date().toISOString() };
}

// ── Sort + build response ─────────────────────────────────────
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
