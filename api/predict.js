// api/predict.js — ScoutAI Real Predictions
// Football-data.org (fixtures + scores) + Odds API (real bookmaker odds)
// Prediction = market consensus from real bookmakers
// Confidence = implied probability from best available odds

var fixtureCache = { data: null, fetched: 0, fromDate: null };
var oddsCache    = { data: null, fetched: 0 };

// Odds API soccer league keys (matches football-data.org competitions)
var ODDS_LEAGUES = [
  'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
  'soccer_germany_bundesliga', 'soccer_france_ligue_one',
  'soccer_efl_champ', 'soccer_uefa_champs_league',
  'soccer_uefa_europa_league', 'soccer_netherlands_eredivisie',
  'soccer_portugal_primeira_liga', 'soccer_brazil_campeonato',
  'soccer_usa_mls', 'soccer_conmebol_copa_libertadores',
  'soccer_conmebol_copa_sudamericana', 'soccer_turkey_super_league',
  'soccer_mexico_ligamx', 'soccer_spl', 'soccer_england_league1',
  'soccer_england_league2', 'soccer_germany_bundesliga2',
  'soccer_italy_serie_b', 'soccer_spain_segunda_division',
  'soccer_france_ligue_two', 'soccer_korea_kleague1',
  'soccer_japan_j_league', 'soccer_sweden_allsvenskan',
  'soccer_norway_eliteserien', 'soccer_poland_ekstraklasa',
  'soccer_austria_bundesliga', 'soccer_switzerland_superleague'
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var reqDate = (req.query && req.query.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var fdKey   = process.env.FOOTBALL_DATA_KEY;
  var oddsKey = process.env.ODDS_API_KEY;
  if (!fdKey)   return res.status(500).json({ error: 'FOOTBALL_DATA_KEY not set.' });
  if (!oddsKey) return res.status(500).json({ error: 'ODDS_API_KEY not set.' });

  // ── Step 1: Get fixtures from football-data.org (cache 15 min) ──
  var byDate = null;
  var cacheAge = Date.now() - (fixtureCache.fetched || 0);
  if (fixtureCache.data && cacheAge < 900000 && fixtureCache.fromDate === today) {
    byDate = fixtureCache.data;
  } else {
    var end = new Date(today + 'T12:00:00Z');
    end.setUTCDate(end.getUTCDate() + 6);
    try {
      var r1 = await fetch(
        'https://api.football-data.org/v4/matches?dateFrom=' + today + '&dateTo=' + end.toISOString().slice(0,10),
        { headers: { 'X-Auth-Token': fdKey } }
      );
      if (!r1.ok) throw new Error('football-data.org error ' + r1.status);
      var fd = await r1.json();
      byDate = groupFixtures(fd.matches || [], now.getTime());
      fixtureCache = { data: byDate, fetched: Date.now(), fromDate: today };
    } catch(err) {
      return res.status(502).json({ error: 'Could not fetch fixtures: ' + err.message });
    }
  }

  // Find requested date or next available
  var available = Object.keys(byDate).sort();
  var targetDate = null;
  if (byDate[reqDate] && byDate[reqDate].length) {
    targetDate = reqDate;
  } else {
    for (var i = 0; i < available.length; i++) {
      if (available[i] >= reqDate && byDate[available[i]].length) {
        targetDate = available[i]; break;
      }
    }
  }

  if (!targetDate) {
    return res.status(200).json({
      predictions: [], edge: [], date: reqDate, requested: reqDate,
      message: 'No upcoming fixtures found. Try a different date.'
    });
  }

  var fixtures = byDate[targetDate];

  // ── Step 2: Get real odds from Odds API (cache 12 hours) ──
  var oddsAge = Date.now() - (oddsCache.fetched || 0);
  var allOdds = [];
  if (oddsCache.data && oddsAge < 43200000) {
    allOdds = oddsCache.data;
  } else {
    // Fetch odds for multiple leagues in parallel — batch to save quota
    // Use 'upcoming' filter to get next matches across all leagues at once
    try {
      var oddsPromises = ODDS_LEAGUES.map(function(league) {
        return fetch(
          'https://api.the-odds-api.com/v4/sports/' + league + '/odds/' +
          '?apiKey=' + oddsKey + '&regions=uk,eu&markets=h2h&oddsFormat=decimal&dateFormat=iso',
          { headers: { 'Accept': 'application/json' } }
        )
        .then(function(r) { return r.ok ? r.json() : []; })
        .then(function(d) { return Array.isArray(d) ? d : []; })
        .catch(function() { return []; });
      });
      var oddsResults = await Promise.all(oddsPromises);
      oddsResults.forEach(function(d) { allOdds = allOdds.concat(d); });
      oddsCache = { data: allOdds, fetched: Date.now() };
    } catch(err) {
      allOdds = []; // Continue with fixtures only, no odds
    }
  }

  // ── Step 3: Match fixtures to odds and build predictions ──
  var predictions = [];
  var edgeData    = [];

  fixtures.forEach(function(fix, idx) {
    // Find matching odds event
    var match = findOddsMatch(fix.home, fix.away, allOdds, fix.kickoff_iso);

    var prediction, confidence, oddsObj, goalsPred, goalsConf;
    var edgeScore = 0, edgeLevel = 'none', factors = [], verdict = '';

    if (match) {
      // Get best (lowest) odds per outcome across all bookmakers
      var best = getBestOdds(match);
      oddsObj = { home: best.home, draw: best.draw, away: best.away };

      // Implied probabilities (remove bookmaker margin for cleaner numbers)
      var rawH = 1 / best.home;
      var rawD = 1 / best.draw;
      var rawA = 1 / best.away;
      var total = rawH + rawD + rawA;
      var probH = rawH / total; // normalised — removes overround
      var probD = rawD / total;
      var probA = rawA / total;

      // Prediction = highest probability outcome
      if (probH >= probD && probH >= probA) {
        prediction = 'Home Win'; confidence = Math.round(probH * 100);
      } else if (probA > probH && probA >= probD) {
        prediction = 'Away Win'; confidence = Math.round(probA * 100);
      } else {
        prediction = 'Draw'; confidence = Math.round(probD * 100);
      }

      // Edge: compare best bookmaker odds to average odds (find value)
      var avgOdds = getAvgOdds(match);
      if (avgOdds) {
        var edgePct = 0;
        if (prediction === 'Home Win') edgePct = Math.round((best.home - avgOdds.home) / avgOdds.home * 100);
        if (prediction === 'Away Win') edgePct = Math.round((best.away - avgOdds.away) / avgOdds.away * 100);
        if (prediction === 'Draw')     edgePct = Math.round((best.draw - avgOdds.draw) / avgOdds.draw * 100);
        edgeScore = Math.max(0, Math.min(100, Math.abs(edgePct) * 3));
        edgeLevel = edgeScore >= 70 ? 'elite' : edgeScore >= 50 ? 'high' : edgeScore >= 30 ? 'medium' : edgeScore >= 10 ? 'low' : 'none';
        if (edgePct > 0) factors.push({ label: 'Best odds are ' + edgePct + '% above market average — potential value', type: 'positive' });
      }

      // Goals prediction from odds if available
      var g25 = getMarketOdds(match, 'totals', 'Over 2.5');
      if (g25) {
        var gProb = 1 / g25;
        if (gProb > 0.65) { goalsPred = 'Over 2.5 Goals'; goalsConf = Math.round(gProb * 100); }
        else if (gProb < 0.40) { goalsPred = 'Under 2.5 Goals'; goalsConf = Math.round((1-gProb)*100); }
      }

      // Bookmaker count as signal
      var bkCount = match.bookmakers ? match.bookmakers.length : 0;
      if (bkCount >= 5) factors.push({ label: bkCount + ' bookmakers pricing this match', type: 'positive' });

      verdict = confidence >= 65 ? 'Strong market consensus — ' + confidence + '% implied probability.'
              : confidence >= 55 ? 'Moderate market confidence on this outcome.'
              : 'Closely contested — market sees this as uncertain.';

    } else {
      // No odds found — fixture only, no prediction
      prediction  = null;
      confidence  = null;
      oddsObj     = null;
      factors.push({ label: 'No market odds available for this fixture yet', type: 'neutral' });
      verdict = 'Odds not yet available — check back closer to kickoff.';
    }

    if (!goalsPred) {
      // Fallback goals prediction based on confidence
      goalsPred = confidence && confidence >= 60 ? 'Over 1.5 Goals' : null;
      goalsConf = goalsPred ? 60 : null;
    }

    predictions.push({
      home:             fix.home,
      away:             fix.away,
      league:           fix.league,
      kickoff_iso:      fix.kickoff_iso,
      is_live:          false,
      is_finished:      false,
      status:           'TIMED',
      prediction:       prediction,
      confidence:       confidence,
      goals_prediction: goalsPred,
      goals_confidence: goalsConf,
      odds:             oddsObj,
      has_odds:         !!match,
      bookmakers:       match ? (match.bookmakers||[]).map(function(b){return b.title;}) : []
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
    predictions: predictions,
    edge:        edgeData,
    date:        targetDate,
    requested:   reqDate,
    fetched_at:  now.toISOString(),
    odds_matched: predictions.filter(function(p){ return p.has_odds; }).length
  });
};

// ── Group fixtures by date, upcoming only ─────────────────────
function groupFixtures(matches, nowMs) {
  var byDate = {};
  matches.forEach(function(m) {
    var d    = m.utcDate ? m.utcDate.slice(0, 10) : null;
    if (!d)  return;
    var home = m.homeTeam && (m.homeTeam.shortName || m.homeTeam.name);
    var away = m.awayTeam && (m.awayTeam.shortName || m.awayTeam.name);
    if (!home || !away) return;
    var status   = m.status;
    var minsAgo  = (nowMs - new Date(m.utcDate).getTime()) / 60000;
    if (minsAgo > 5)   return; // Already started or finished
    if (status !== 'SCHEDULED' && status !== 'TIMED') return;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({
      home:        home,
      away:        away,
      league:      (m.competition && m.competition.name) || 'Unknown',
      kickoff_iso: m.utcDate
    });
  });
  return byDate;
}

// ── Match fixture to Odds API event ──────────────────────────
function findOddsMatch(home, away, allOdds, kickoff) {
  var koMs    = kickoff ? new Date(kickoff).getTime() : 0;
  var best    = null;
  var bestScore = 0;

  allOdds.forEach(function(event) {
    // Time window: within 3 hours of fixture kickoff
    var eventMs = event.commence_time ? new Date(event.commence_time).getTime() : 0;
    if (koMs && Math.abs(eventMs - koMs) > 10800000) return;

    var eHome = event.home_team || '';
    var eAway = event.away_team || '';
    var score = matchScore(home, away, eHome, eAway);
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      best = event;
    }
  });
  return best;
}

// Fuzzy team name matching score 0-1
function matchScore(h1, a1, h2, a2) {
  var hs = nameSim(h1, h2);
  var as = nameSim(a1, a2);
  // Also try reversed (some APIs swap home/away)
  var hs2 = nameSim(h1, a2);
  var as2 = nameSim(a1, h2);
  return Math.max((hs + as) / 2, (hs2 + as2) / 2);
}

function nameSim(a, b) {
  a = normalise(a); b = normalise(b);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  // Check key words match
  var wa = a.split(' '), wb = b.split(' ');
  var common = wa.filter(function(w){ return w.length > 3 && wb.indexOf(w) !== -1; });
  if (common.length > 0) return 0.7;
  return 0;
}

function normalise(name) {
  return (name || '').toLowerCase()
    .replace(/\bfc\b|\bsc\b|\bac\b|\baf\b|\bcf\b|\bfk\b|\bsk\b|\bif\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Get best (highest) odds per outcome across bookmakers
function getBestOdds(event) {
  var best = { home: 0, draw: 0, away: 0 };
  (event.bookmakers || []).forEach(function(bk) {
    (bk.markets || []).forEach(function(mkt) {
      if (mkt.key !== 'h2h') return;
      (mkt.outcomes || []).forEach(function(o) {
        if (o.name === event.home_team && o.price > best.home) best.home = o.price;
        if (o.name === event.away_team && o.price > best.away) best.away = o.price;
        if (o.name === 'Draw'           && o.price > best.draw) best.draw = o.price;
      });
    });
  });
  // Fallback if no draw market (some events)
  if (!best.draw) best.draw = 3.5;
  return best;
}

// Get average odds across bookmakers
function getAvgOdds(event) {
  var sums = { home: 0, draw: 0, away: 0 };
  var counts = { home: 0, draw: 0, away: 0 };
  (event.bookmakers || []).forEach(function(bk) {
    (bk.markets || []).forEach(function(mkt) {
      if (mkt.key !== 'h2h') return;
      (mkt.outcomes || []).forEach(function(o) {
        if (o.name === event.home_team) { sums.home += o.price; counts.home++; }
        if (o.name === event.away_team) { sums.away += o.price; counts.away++; }
        if (o.name === 'Draw')          { sums.draw += o.price; counts.draw++; }
      });
    });
  });
  if (!counts.home) return null;
  return {
    home: sums.home / counts.home,
    draw: counts.draw ? sums.draw / counts.draw : 3.5,
    away: sums.away / counts.away
  };
}

// Get specific market odds
function getMarketOdds(event, marketKey, outcomeName) {
  var price = null;
  (event.bookmakers || []).forEach(function(bk) {
    (bk.markets || []).forEach(function(mkt) {
      if (mkt.key !== marketKey) return;
      (mkt.outcomes || []).forEach(function(o) {
        if (o.name === outcomeName && (!price || o.price < price)) price = o.price;
      });
    });
  });
  return price;
}
