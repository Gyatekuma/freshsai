// api/predict.js — ScoutAI Predictions via API-Sports (api-sports.io)
// Free tier: 100 req/day
// Budget: 1 fixtures call + 1 odds call per day = 2 req/day cached 24hrs
// APISPORTS_KEY in Vercel env vars

var cache = { fixtures: null, odds: null, fTs: 0, oTs: 0 };

var BASE    = 'https://v3.football.api-sports.io';
var HEADERS = function(key) { return { 'x-apisports-key': key }; };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var reqDate = (req.query && req.query.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var key = process.env.APISPORTS_KEY;
  if (!key) return res.status(500).json({ error: 'APISPORTS_KEY not set in Vercel env vars.' });

  var DAY = 86400000; // 24 hours in ms

  // ── Step 1: Fixtures (cache 24hr) ──────────────────────────
  var fixtures = [];
  if (cache.fixtures && (Date.now() - cache.fTs) < DAY) {
    fixtures = cache.fixtures;
  } else {
    try {
      // Fetch today + next 6 days in one call using a date range
      // API-Sports supports ?date= for single day; fetch today only and cache
      var end = new Date(today + 'T12:00:00Z');
      end.setUTCDate(end.getUTCDate() + 6);

      // Fetch today and tomorrow together via two parallel calls (2 req)
      var tom = new Date(today + 'T12:00:00Z');
      tom.setUTCDate(tom.getUTCDate() + 1);
      var tomStr = tom.toISOString().slice(0, 10);

      var [r1, r2] = await Promise.all([
        fetch(BASE + '/fixtures?date=' + today, { headers: HEADERS(key) }),
        fetch(BASE + '/fixtures?date=' + tomStr, { headers: HEADERS(key) })
      ]);
      var [d1, d2] = await Promise.all([r1.json(), r2.json()]);
      fixtures = (d1.response || []).concat(d2.response || []);
      cache.fixtures = fixtures;
      cache.fTs = Date.now();
    } catch(e) {
      if (cache.fixtures) fixtures = cache.fixtures;
      else return res.status(502).json({ error: 'Could not fetch fixtures: ' + e.message });
    }
  }

  // ── Step 2: Odds (cache 24hr) ───────────────────────────────
  var allOdds = [];
  if (cache.odds && (Date.now() - cache.oTs) < DAY) {
    allOdds = cache.odds;
  } else {
    try {
      var or = await fetch(BASE + '/odds?date=' + today + '&season=2025&bet=1', { headers: HEADERS(key) });
      var od = await or.json();
      allOdds = od.response || [];
      cache.odds = allOdds;
      cache.oTs  = Date.now();
    } catch(e) { allOdds = []; }
  }

  // Build odds lookup by fixture ID
  var oddsById = {};
  allOdds.forEach(function(o) {
    if (o.fixture && o.fixture.id) oddsById[o.fixture.id] = o;
  });

  // ── Filter fixtures to requested date ───────────────────────
  var nowMs   = Date.now();
  var dayMs   = new Date(reqDate + 'T00:00:00Z').getTime();
  var dayEnd  = dayMs + DAY;

  var dayFix = fixtures.filter(function(f) {
    var ko = f.fixture && f.fixture.date ? new Date(f.fixture.date).getTime() : 0;
    if (!ko) return false;
    // Only upcoming (kickoff in the future)
    if (ko <= nowMs) return false;
    // On the requested date
    return ko >= dayMs && ko < dayEnd;
  });

  // Auto-advance: if none today, find next date with fixtures
  if (!dayFix.length) {
    var byDate = {};
    fixtures.forEach(function(f) {
      var ko = f.fixture && f.fixture.date ? new Date(f.fixture.date).getTime() : 0;
      if (!ko || ko <= nowMs) return;
      var d = f.fixture.date.slice(0, 10);
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(f);
    });
    var dates = Object.keys(byDate).sort();
    if (!dates.length) {
      return res.status(200).json({ predictions:[], edge:[], date:reqDate, requested:reqDate,
        message:'No upcoming fixtures found. Try another date.' });
    }
    reqDate = dates[0];
    dayFix  = byDate[reqDate];
  }

  // Sort by kickoff
  dayFix.sort(function(a, b) {
    return new Date(a.fixture.date) - new Date(b.fixture.date);
  });

  // ── Build predictions ───────────────────────────────────────
  var predictions = [], edgeData = [];

  dayFix.forEach(function(f, idx) {
    var home   = f.teams && f.teams.home && f.teams.home.name;
    var away   = f.teams && f.teams.away && f.teams.away.name;
    if (!home || !away) return;

    var league = f.league && f.league.name || 'Unknown';
    var ko     = f.fixture && f.fixture.date;
    var fid    = f.fixture && f.fixture.id;

    var prediction = null, confidence = null, oddsObj = null;
    var goalsPred  = null, goalsConf  = null;
    var hasOdds    = false, bkCount = 0;
    var edgeScore  = 0, edgeLevel = 'none', factors = [], verdict = '';

    // Try to get real odds
    var oddsData = oddsById[fid];
    if (oddsData && oddsData.bookmakers && oddsData.bookmakers.length) {
      hasOdds = true;
      bkCount = oddsData.bookmakers.length;

      // Find Match Winner market (bet id 1)
      var best = { home:0, draw:0, away:0 };
      var sums = { home:0, draw:0, away:0 }, counts = { home:0, draw:0, away:0 };

      oddsData.bookmakers.forEach(function(bk) {
        (bk.bets || []).forEach(function(bet) {
          if (bet.id !== 1 && bet.name !== 'Match Winner') return;
          (bet.values || []).forEach(function(v) {
            var p = parseFloat(v.odd) || 0;
            if (v.value === 'Home') {
              if (p > best.home) best.home = p;
              sums.home += p; counts.home++;
            } else if (v.value === 'Away') {
              if (p > best.away) best.away = p;
              sums.away += p; counts.away++;
            } else if (v.value === 'Draw') {
              if (p > best.draw) best.draw = p;
              sums.draw += p; counts.draw++;
            }
          });
        });
      });

      if (best.home && best.away) {
        if (!best.draw) best.draw = 3.5;
        oddsObj = { home: r2(best.home), draw: r2(best.draw), away: r2(best.away) };

        // Normalised implied probabilities
        var rh = 1/best.home, rd = 1/best.draw, ra = 1/best.away, t = rh+rd+ra;
        var ph = Math.round(rh/t*100), pd = Math.round(rd/t*100), pa = Math.round(ra/t*100);

        if (ph >= pd && ph >= pa)     { prediction='Home Win'; confidence=ph; }
        else if (pa > ph && pa >= pd) { prediction='Away Win'; confidence=pa; }
        else                          { prediction='Draw';     confidence=pd; }

        // Edge: best vs average
        if (counts.home > 1) {
          var avgHome = sums.home/counts.home, avgAway = sums.away/counts.away;
          var predAvg = prediction==='Home Win'?avgHome:prediction==='Away Win'?avgAway:(sums.draw/Math.max(counts.draw,1));
          var predBest = prediction==='Home Win'?best.home:prediction==='Away Win'?best.away:best.draw;
          var edgePct = predAvg > 0 ? Math.round((predBest-predAvg)/predAvg*100) : 0;
          edgeScore = Math.min(100, Math.max(0, Math.abs(edgePct)*5));
          edgeLevel = edgeScore>=70?'elite':edgeScore>=50?'high':edgeScore>=25?'medium':edgeScore>=8?'low':'none';
          if (edgePct >= 3) factors.push({ label:'Best odds '+edgePct+'% above market average', type:'positive' });
        }
        if (bkCount >= 5) factors.push({ label:bkCount+' bookmakers pricing this match', type:'positive' });
        if (confidence >= 65) factors.push({ label:'Strong market consensus: '+prediction+' at '+confidence+'%', type:'positive' });
        else factors.push({ label:'Competitive odds — open match', type:'neutral' });

        verdict = confidence>=65
          ? 'Market strongly favours '+prediction+' — '+confidence+'% implied probability.'
          : confidence>=52 ? 'Market leans towards '+prediction+'.'
          : 'Very open contest — market sees this as uncertain.';

        goalsPred = confidence >= 60 ? 'Over 1.5 Goals' : null;
        goalsConf = goalsPred ? 63 : null;
      }
    }

    // No odds — use home advantage + league statistical model
    if (!prediction) {
      var model = homeAdvantageModel(f);
      prediction  = model.prediction;
      confidence  = model.confidence;
      goalsPred   = model.goalsPred;
      goalsConf   = model.goalsConf;
      factors.push({ label:'Statistical model — market odds not yet available', type:'neutral' });
      verdict = 'Based on home advantage model. Odds typically appear closer to kickoff.';
    }

    predictions.push({
      home:home, away:away, league:league,
      kickoff_iso:     ko,
      is_live:         false,
      is_finished:     false,
      status:          'TIMED',
      prediction:      prediction,
      confidence:      confidence,
      goals_prediction:goalsPred,
      goals_confidence:goalsConf,
      odds:            oddsObj,
      has_odds:        hasOdds,
      bookmaker_count: bkCount
    });

    edgeData.push({
      index:      idx,
      edge_score: edgeScore,
      edge_level: edgeLevel,
      factors:    factors,
      verdict:    verdict
    });
  });

  return res.status(200).json({
    predictions:  predictions,
    edge:         edgeData,
    date:         reqDate,
    requested:    (req.query && req.query.date) || today,
    fetched_at:   now.toISOString(),
    odds_matched: predictions.filter(function(p){ return p.has_odds; }).length,
    total:        predictions.length
  });
};

// ── Simple home advantage model when no odds ────────────────
function homeAdvantageModel(f) {
  // League-level home win rates (approximate global averages)
  var homeConf = 52, awayConf = 28, drawConf = 20;

  // Adjust by home/away form if available
  var hs = f.teams && f.teams.home;
  var as = f.teams && f.teams.away;

  // Default: slight home advantage
  var prediction = 'Home Win', confidence = homeConf;
  if (awayConf > homeConf) { prediction = 'Away Win'; confidence = awayConf; }
  if (drawConf > homeConf && drawConf > awayConf) { prediction = 'Draw'; confidence = drawConf; }

  return {
    prediction:  prediction,
    confidence:  confidence,
    goalsPred:   'Over 1.5 Goals',
    goalsConf:   58
  };
}

function r2(n) { return Math.round(n * 100) / 100; }
