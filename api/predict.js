// api/predict.js — ScoutAI Real Predictions
// Source: Odds API (51 soccer leagues, real bookmaker odds = real predictions)
// football-data.org only used by oracle.js for scores
// Cache: 6 hours (conserves 500/month quota)

var oddsCache = { data: [], fetched: 0 };

// All 51 active soccer leagues from Odds API
var SOCCER_LEAGUES = [
  'soccer_epl','soccer_efl_champ','soccer_england_league1','soccer_england_league2',
  'soccer_spain_la_liga','soccer_spain_segunda_division','soccer_spain_copa_del_rey',
  'soccer_germany_bundesliga','soccer_germany_bundesliga2','soccer_germany_liga3',
  'soccer_italy_serie_a','soccer_italy_serie_b','soccer_italy_coppa_italia',
  'soccer_france_ligue_one','soccer_france_ligue_two','soccer_france_coupe_de_france',
  'soccer_portugal_primeira_liga','soccer_netherlands_eredivisie','soccer_spl',
  'soccer_turkey_super_league','soccer_greece_super_league','soccer_russia_premier_league',
  'soccer_austria_bundesliga','soccer_switzerland_superleague','soccer_denmark_superliga',
  'soccer_finland_veikkausliiga','soccer_sweden_allsvenskan','soccer_sweden_superettan',
  'soccer_norway_eliteserien','soccer_poland_ekstraklasa','soccer_league_of_ireland',
  'soccer_brazil_campeonato','soccer_brazil_serie_b','soccer_mexico_ligamx',
  'soccer_usa_mls','soccer_argentina_primera_division','soccer_chile_campeonato',
  'soccer_korea_kleague1','soccer_japan_j_league','soccer_china_superleague',
  'soccer_australia_aleague','soccer_conmebol_copa_libertadores',
  'soccer_conmebol_copa_sudamericana','soccer_uefa_champs_league',
  'soccer_uefa_europa_league','soccer_uefa_europa_conference_league',
  'soccer_germany_dfb_pokal','soccer_fa_cup','soccer_fifa_world_cup'
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var reqDate = (req.query && req.query.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var oddsKey = process.env.ODDS_API_KEY;
  if (!oddsKey) return res.status(500).json({ error: 'ODDS_API_KEY not set.' });

  // ── Fetch all odds (cache 6 hours) ──────────────────────────
  var oAge = Date.now() - (oddsCache.fetched || 0);
  var allEvents = [];

  if (oddsCache.data && oddsCache.data.length && oAge < 21600000) {
    allEvents = oddsCache.data;
  } else {
    // Batch leagues to reduce API calls — fetch all at once in parallel
    try {
      var results = await Promise.all(SOCCER_LEAGUES.map(function(lg) {
        return fetch(
          'https://api.the-odds-api.com/v4/sports/' + lg + '/odds/' +
          '?apiKey=' + oddsKey +
          '&regions=uk,eu&markets=h2h&oddsFormat=decimal&dateFormat=iso',
          { headers: { 'Accept': 'application/json' } }
        )
        .then(function(r) {
          return r.ok ? r.json() : [];
        })
        .then(function(d) {
          return Array.isArray(d) ? d.map(function(e) {
            e._sport = lg; return e;
          }) : [];
        })
        .catch(function() { return []; });
      }));
      results.forEach(function(d) { allEvents = allEvents.concat(d); });
      oddsCache = { data: allEvents, fetched: Date.now() };
    } catch(err) {
      return res.status(502).json({ error: 'Could not fetch odds: ' + err.message });
    }
  }

  if (!allEvents.length) {
    return res.status(200).json({
      predictions: [], edge: [], date: reqDate, requested: reqDate,
      message: 'No fixtures available right now.'
    });
  }

  // ── Filter to requested date ─────────────────────────────────
  var reqMs    = new Date(reqDate + 'T00:00:00Z').getTime();
  var reqEndMs = reqMs + 86400000; // end of that day

  var dayEvents = allEvents.filter(function(e) {
    if (!e.commence_time) return false;
    var t = new Date(e.commence_time).getTime();
    // For today: only show matches that haven't started yet
    if (reqDate === today) {
      return t >= reqEndMs - 86400000 && t > Date.now() + 60000 && t < reqEndMs;
    }
    // For future dates: show all matches on that day
    return t >= reqMs && t < reqEndMs;
  });

  // If no matches on requested date, find next available date
  if (!dayEvents.length) {
    // Group all future events by date
    var byDate = {};
    var nowMs   = Date.now();
    allEvents.forEach(function(e) {
      if (!e.commence_time) return;
      var t = new Date(e.commence_time).getTime();
      if (t <= nowMs) return;
      var d = e.commence_time.slice(0, 10);
      if (d < reqDate) return;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(e);
    });
    var dates = Object.keys(byDate).sort();
    if (!dates.length) {
      return res.status(200).json({
        predictions: [], edge: [], date: reqDate, requested: reqDate,
        message: 'No upcoming fixtures found. Try a different date.'
      });
    }
    var targetDate = dates[0];
    dayEvents = byDate[targetDate];
    reqDate   = targetDate;
  }

  // ── Build predictions from real bookmaker odds ───────────────
  var predictions = [], edgeData = [];

  // Sort by kickoff time
  dayEvents.sort(function(a, b) {
    return new Date(a.commence_time) - new Date(b.commence_time);
  });

  dayEvents.forEach(function(event, idx) {
    if (!event.bookmakers || !event.bookmakers.length) return;

    var home   = event.home_team;
    var away   = event.away_team;
    var league = leagueName(event._sport);

    if (!home || !away) return;

    // Get best and average odds across all bookmakers
    var best = getBestOdds(event);
    var avg  = getAvgOdds(event);

    if (!best.home || !best.away) return; // skip if no valid odds

    var oddsObj = { home: round2(best.home), draw: round2(best.draw || 3.5), away: round2(best.away) };

    // Normalised implied probabilities (removes bookmaker margin)
    var rh = 1 / best.home;
    var rd = best.draw ? 1 / best.draw : 0.2;
    var ra = 1 / best.away;
    var t  = rh + rd + ra;
    var ph = Math.round(rh / t * 100);
    var pd = Math.round(rd / t * 100);
    var pa = Math.round(ra / t * 100);

    // Prediction = market consensus (highest implied probability)
    var prediction, confidence;
    if (ph >= pd && ph >= pa)     { prediction = 'Home Win'; confidence = ph; }
    else if (pa > ph && pa >= pd) { prediction = 'Away Win'; confidence = pa; }
    else                          { prediction = 'Draw';     confidence = pd; }

    // Edge: how much better is the best odds vs market average
    var edgePct = 0, edgeScore = 0, edgeLevel = 'none';
    if (avg) {
      var predBest = prediction==='Home Win'?best.home:prediction==='Away Win'?best.away:(best.draw||3.5);
      var predAvg  = prediction==='Home Win'?avg.home :prediction==='Away Win'?avg.away :(avg.draw||3.5);
      if (predAvg > 0) edgePct = Math.round((predBest - predAvg) / predAvg * 100);
      edgeScore = Math.min(100, Math.max(0, Math.abs(edgePct) * 5));
      edgeLevel = edgeScore>=70?'elite':edgeScore>=50?'high':edgeScore>=25?'medium':edgeScore>=8?'low':'none';
    }

    var bkCount = event.bookmakers.length;
    var factors = [];
    if (edgePct >= 3) factors.push({ label: 'Best available odds '+edgePct+'% above market average', type:'positive' });
    if (bkCount >= 10) factors.push({ label: bkCount+' bookmakers have priced this match', type:'positive' });
    if (confidence >= 65) factors.push({ label: 'Strong market consensus: '+prediction+' at '+confidence+'%', type:'positive' });
    else if (confidence < 45) factors.push({ label: 'Open match — market uncertain, prices close', type:'neutral' });
    if (!factors.length) factors.push({ label: 'Moderate market confidence — assess carefully', type:'neutral' });

    var verdict = confidence >= 65
      ? 'Market strongly favours '+prediction+' — '+confidence+'% implied probability across '+bkCount+' bookmakers.'
      : confidence >= 52
      ? 'Market leans towards '+prediction+'. Value possible with the best available odds.'
      : 'Very competitive pricing — this is an open contest.';

    // Goals market from totals if available
    var goalsPred = null, goalsConf = null;
    var o25 = getTotalsOdds(event, 'Over', 2.5);
    var u25 = getTotalsOdds(event, 'Under', 2.5);
    if (o25 && u25) {
      var pOver = Math.round(1/o25 / (1/o25 + 1/u25) * 100);
      if (pOver >= 60)      { goalsPred = 'Over 2.5 Goals';  goalsConf = pOver; }
      else if (pOver <= 40) { goalsPred = 'Under 2.5 Goals'; goalsConf = 100-pOver; }
    }
    if (!goalsPred) {
      goalsPred = confidence >= 60 ? 'Over 1.5 Goals' : null;
      goalsConf = goalsPred ? 63 : null;
    }

    predictions.push({
      home: home, away: away, league: league,
      kickoff_iso:      event.commence_time,
      is_live:          false,
      is_finished:      false,
      status:           'TIMED',
      prediction:       prediction,
      confidence:       confidence,
      goals_prediction: goalsPred,
      goals_confidence: goalsConf,
      odds:             oddsObj,
      has_odds:         true,
      bookmaker_count:  bkCount
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
    requested:    req.query && req.query.date || today,
    fetched_at:   now.toISOString(),
    total_events: allEvents.length,
    odds_matched: predictions.length
  });
};

// ── Helpers ───────────────────────────────────────────────────
function getBestOdds(event) {
  var b = { home:0, draw:0, away:0 };
  (event.bookmakers||[]).forEach(function(bk) {
    (bk.markets||[]).forEach(function(mkt) {
      if (mkt.key !== 'h2h') return;
      (mkt.outcomes||[]).forEach(function(o) {
        if (o.name === event.home_team && o.price > b.home) b.home = o.price;
        if (o.name === event.away_team && o.price > b.away) b.away = o.price;
        if (o.name === 'Draw'           && o.price > b.draw) b.draw = o.price;
      });
    });
  });
  return b;
}

function getAvgOdds(event) {
  var s={home:0,draw:0,away:0}, n={home:0,draw:0,away:0};
  (event.bookmakers||[]).forEach(function(bk) {
    (bk.markets||[]).forEach(function(mkt) {
      if (mkt.key !== 'h2h') return;
      (mkt.outcomes||[]).forEach(function(o) {
        if (o.name===event.home_team){s.home+=o.price;n.home++;}
        if (o.name===event.away_team){s.away+=o.price;n.away++;}
        if (o.name==='Draw')         {s.draw+=o.price;n.draw++;}
      });
    });
  });
  if (!n.home) return null;
  return { home:s.home/n.home, draw:n.draw?s.draw/n.draw:0, away:s.away/n.away };
}

function getTotalsOdds(event, side, points) {
  var price = null;
  (event.bookmakers||[]).forEach(function(bk) {
    (bk.markets||[]).forEach(function(mkt) {
      if (mkt.key !== 'totals') return;
      (mkt.outcomes||[]).forEach(function(o) {
        if (o.name===side && o.point===points && (!price||o.price<price)) price=o.price;
      });
    });
  });
  return price;
}

function leagueName(sportKey) {
  var map = {
    'soccer_epl':'Premier League (England)',
    'soccer_efl_champ':'Championship (England)',
    'soccer_england_league1':'League One (England)',
    'soccer_england_league2':'League Two (England)',
    'soccer_spain_la_liga':'La Liga (Spain)',
    'soccer_spain_segunda_division':'Segunda División (Spain)',
    'soccer_spain_copa_del_rey':'Copa del Rey (Spain)',
    'soccer_germany_bundesliga':'Bundesliga (Germany)',
    'soccer_germany_bundesliga2':'2. Bundesliga (Germany)',
    'soccer_germany_liga3':'3. Liga (Germany)',
    'soccer_germany_dfb_pokal':'DFB-Pokal (Germany)',
    'soccer_italy_serie_a':'Serie A (Italy)',
    'soccer_italy_serie_b':'Serie B (Italy)',
    'soccer_italy_coppa_italia':'Coppa Italia',
    'soccer_france_ligue_one':'Ligue 1 (France)',
    'soccer_france_ligue_two':'Ligue 2 (France)',
    'soccer_france_coupe_de_france':'Coupe de France',
    'soccer_portugal_primeira_liga':'Primeira Liga (Portugal)',
    'soccer_netherlands_eredivisie':'Eredivisie (Netherlands)',
    'soccer_spl':'Scottish Premiership',
    'soccer_turkey_super_league':'Süper Lig (Turkey)',
    'soccer_greece_super_league':'Super League (Greece)',
    'soccer_russia_premier_league':'Premier League (Russia)',
    'soccer_austria_bundesliga':'Bundesliga (Austria)',
    'soccer_switzerland_superleague':'Super League (Switzerland)',
    'soccer_denmark_superliga':'Superliga (Denmark)',
    'soccer_finland_veikkausliiga':'Veikkausliiga (Finland)',
    'soccer_sweden_allsvenskan':'Allsvenskan (Sweden)',
    'soccer_sweden_superettan':'Superettan (Sweden)',
    'soccer_norway_eliteserien':'Eliteserien (Norway)',
    'soccer_poland_ekstraklasa':'Ekstraklasa (Poland)',
    'soccer_league_of_ireland':'League of Ireland',
    'soccer_brazil_campeonato':'Brasileirão Série A',
    'soccer_brazil_serie_b':'Brasileirão Série B',
    'soccer_mexico_ligamx':'Liga MX (Mexico)',
    'soccer_usa_mls':'MLS (USA)',
    'soccer_argentina_primera_division':'Primera División (Argentina)',
    'soccer_chile_campeonato':'Primera División (Chile)',
    'soccer_korea_kleague1':'K League 1 (South Korea)',
    'soccer_japan_j_league':'J1 League (Japan)',
    'soccer_china_superleague':'Super League (China)',
    'soccer_australia_aleague':'A-League (Australia)',
    'soccer_conmebol_copa_libertadores':'Copa Libertadores',
    'soccer_conmebol_copa_sudamericana':'Copa Sudamericana',
    'soccer_uefa_champs_league':'UEFA Champions League',
    'soccer_uefa_europa_league':'UEFA Europa League',
    'soccer_uefa_europa_conference_league':'UEFA Conference League',
    'soccer_fa_cup':'FA Cup (England)',
    'soccer_fifa_world_cup':'FIFA World Cup'
  };
  return map[sportKey] || sportKey;
}

function round2(n) { return Math.round(n * 100) / 100; }
