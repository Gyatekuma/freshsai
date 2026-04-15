// api/predict.js — ScoutAI REAL Predictions
// Source: BetMiner (RapidAPI) — real statistical model, real probabilities
// Cache: 24 hours strict (free tier = 100 req/day)
// RAPIDAPI_KEY in Vercel env vars

var cache = {}; // { 'YYYY-MM-DD': { data, ts } }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var reqDate = (req.query && req.query.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RAPIDAPI_KEY not set.' });

  // Strict 24hr cache — BetMiner free tier is 100 req/day
  var cached = cache[reqDate];
  if (cached && (Date.now() - cached.ts) < 86400000) {
    return res.status(200).json(filterResponse(cached.data, now, reqDate));
  }

  try {
    var r = await fetch('https://betminer.p.rapidapi.com/bm/v3/edge-analysis/' + reqDate, {
      headers: {
        'Content-Type':    'application/json',
        'x-rapidapi-key':  apiKey,
        'x-rapidapi-host': 'betminer.p.rapidapi.com'
      }
    });

    if (r.status === 429 || !r.ok) {
      if (cached) return res.status(200).json(filterResponse(cached.data, now, reqDate));
      // BetMiner quota hit — fall back to football-data.org
      return fallbackFootballData(reqDate, now, res);
    }

    var raw  = await r.json();
    var items = (raw.data && Array.isArray(raw.data)) ? raw.data
              : Array.isArray(raw) ? raw : [];

    if (!items.length) {
      return res.status(200).json({ predictions:[], edge:[], date:reqDate, requested:reqDate,
        message: 'No fixtures found for ' + reqDate });
    }

    var processed = buildPredictions(items, reqDate);
    cache[reqDate] = { data: processed, ts: Date.now() };
    return res.status(200).json(filterResponse(processed, now, reqDate));

  } catch(err) {
    if (cached) return res.status(200).json(filterResponse(cached.data, now, reqDate));
    return res.status(502).json({ error: err.message });
  }
};

// ── Build real predictions from BetMiner data ─────────────────
function buildPredictions(items, dateStr) {
  var predictions = [];
  var edgeData    = [];

  items.forEach(function(m, idx) {
    var home   = m.home_team && m.home_team.name;
    var away   = m.away_team && m.away_team.name;
    if (!home || !away) return;

    var comp   = m.competition || {};
    var league = comp.country && comp.country !== 'World'
               ? comp.name + ' (' + comp.country + ')' : comp.name || 'Unknown';

    var ko         = m.kickoff;
    var status     = (m.status || '').toUpperCase();
    var isFinished = status === 'FT' || status === 'FINISHED' || status === 'AET' || status === 'PEN';
    var isLive     = ['1H','HT','2H','ET','P','INT','LIVE'].indexOf(status) !== -1;

    // Real probabilities from BetMiner model
    var probs = m.probabilities || {};
    var pHome = Number(probs.home_win) || 33;
    var pDraw = Number(probs.draw)     || 33;
    var pAway = Number(probs.away_win) || 33;

    // Prediction = highest probability outcome
    var predResult  = m.predictions && m.predictions.result;
    var prediction  = mapResult(predResult, pHome, pDraw, pAway);
    var confidence  = Math.round(Math.max(pHome, pDraw, pAway));
    confidence      = Math.min(92, Math.max(35, confidence));

    // Goals market — use BetMiner's model probabilities
    var pBTTS   = Number(probs.btts)   || 50;
    var pOver25 = Number(probs.over_25)|| 50;
    var goalsPred = null, goalsConf = null;
    if (pBTTS >= 65)       { goalsPred = 'BTTS Yes';         goalsConf = Math.round(pBTTS); }
    else if (pBTTS <= 35)  { goalsPred = 'BTTS No';          goalsConf = Math.round(100-pBTTS); }
    else if (pOver25 >= 65){ goalsPred = 'Over 2.5 Goals';   goalsConf = Math.round(pOver25); }
    else if (pOver25 <= 35){ goalsPred = 'Under 2.5 Goals';  goalsConf = Math.round(100-pOver25); }

    // Real bookmaker odds from BetMiner
    var oddsRaw = m.odds || {};
    var odds = {
      home: parseFloat(oddsRaw.home_win) || 0,
      draw: parseFloat(oddsRaw.draw)     || 0,
      away: parseFloat(oddsRaw.away_win) || 0
    };

    // Edge analysis — find the best value market
    var ea         = m.edge_analysis || {};
    var edgeLevel  = 'none';
    var edgeScore  = 0;
    var edgeMarket = null;
    var factors    = [];
    var verdict    = '';

    // Find highest-rated market from edge_analysis
    var marketOrder = ['home_win','away_win','draw','btts_yes','over_25'];
    var bestEdgePct = 0;
    marketOrder.forEach(function(mkt) {
      var ea_mkt = ea[mkt];
      if (!ea_mkt) return;
      var ePct = ea_mkt.edge_pct || 0;
      var rating = ea_mkt.rating || '';
      if (ePct > bestEdgePct) {
        bestEdgePct = ePct;
        edgeMarket  = { market: mkt, pct: ePct, rating: rating, odds: ea_mkt.odds };
      }
    });

    if (edgeMarket) {
      edgeScore = Math.min(100, Math.max(0, Math.round(edgeMarket.pct)));
      edgeLevel = edgeMarket.pct >= 20 ? 'elite'
                : edgeMarket.pct >= 12 ? 'high'
                : edgeMarket.pct >= 6  ? 'medium'
                : edgeMarket.pct >= 2  ? 'low'
                : 'none';
    }

    // Form factors — use real form data
    var form = m.form || {};
    var homeForm = form.home || '';
    var awayForm = form.away || '';
    if (homeForm) {
      var homeWins = (homeForm.match(/W/g)||[]).length;
      var awayLoss = (awayForm.match(/L/g)||[]).length;
      if (homeWins >= 3) factors.push({ label:'Home side: '+homeForm+' in last 5', type:'positive' });
      if (awayLoss >= 3) factors.push({ label:'Away side poor recent form: '+awayForm, type:'negative' });
      if (homeWins <= 1) factors.push({ label:'Home side inconsistent: '+homeForm, type:'negative' });
    }
    // Add value insight if strong
    if (edgeMarket && edgeMarket.pct >= 10) {
      factors.push({ label: 'Model edge of +' + Math.round(edgeMarket.pct) + '% on ' + humanMarket(edgeMarket.market), type:'positive' });
    }
    // Trap warning
    if (m.is_trap) factors.push({ label:'Market trap detected — public money vs sharp money divergence', type:'negative' });

    if (!factors.length) factors.push({ label:'Balanced match — no significant narrative edge detected', type:'neutral' });

    // Verdict based on edge
    if (edgeMarket && edgeMarket.rating === 'strong_value') verdict = 'Strong value identified — model confidence significantly exceeds implied odds.';
    else if (edgeMarket && edgeMarket.rating === 'value')   verdict = 'Moderate value detected. Proceed with measured stake.';
    else if (edgeMarket && edgeMarket.rating === 'poor')    verdict = 'Market prices this fairly — no significant edge found.';
    else verdict = 'Even match — stick to small stakes.';

    // Score for finished matches
    var sh = null, sa = null;
    if (isFinished && m.score) { sh = m.score.home; sa = m.score.away; }

    predictions.push({
      home:            home,
      away:            away,
      league:          league,
      kickoff_iso:     ko,
      is_live:         isLive,
      is_finished:     isFinished,
      score_home:      sh,
      score_away:      sa,
      status:          status,
      prediction:      prediction,
      confidence:      confidence,
      goals_prediction: goalsPred,
      goals_confidence: goalsConf,
      odds:            odds,
      form_home:       homeForm,
      form_away:       awayForm,
      value_rating:    edgeMarket ? edgeMarket.rating : 'neutral',
      value_pct:       edgeMarket ? Math.round(edgeMarket.pct) : 0
    });

    edgeData.push({
      index:       idx,
      edge_score:  edgeScore,
      edge_level:  edgeLevel,
      factors:     factors,
      verdict:     verdict
    });
  });

  return { predictions:predictions, edge:edgeData, date:dateStr, fetched_at:new Date().toISOString() };
}

// ── Filter: only upcoming (not started) ──────────────────────
function filterResponse(raw, now, reqDate) {
  var nowMs  = now.getTime();
  var preds  = (raw.predictions||[]).filter(function(m) {
    if (m.is_finished || m.is_live) return false;
    if (m.kickoff_iso && new Date(m.kickoff_iso).getTime() <= nowMs) return false;
    return true;
  }).sort(function(a,b){ return new Date(a.kickoff_iso)-new Date(b.kickoff_iso); });

  var em = {};
  (raw.edge||[]).forEach(function(e,i){ em[i]=e; });
  var edge = preds.map(function(m,i){
    var orig = (raw.predictions||[]).indexOf(m);
    return Object.assign({},em[orig]||{index:i,edge_score:0,edge_level:'none',factors:[],verdict:''},{ index:i });
  });

  return { predictions:preds, edge:edge, date:raw.date||reqDate, requested:reqDate, fetched_at:raw.fetched_at };
}

// ── Helpers ──────────────────────────────────────────────────
function mapResult(result, pHome, pDraw, pAway) {
  if (result === 'home_win') return 'Home Win';
  if (result === 'away_win') return 'Away Win';
  if (result === 'draw')     return 'Draw';
  // Fallback: use highest probability
  if (pHome >= pDraw && pHome >= pAway) return 'Home Win';
  if (pAway > pHome && pAway >= pDraw)  return 'Away Win';
  return 'Draw';
}

function humanMarket(mkt) {
  var map = { home_win:'Home Win', away_win:'Away Win', draw:'Draw',
    btts_yes:'BTTS Yes', over_25:'Over 2.5 Goals', over_15:'Over 1.5 Goals',
    dc_1x:'Home Win or Draw', dc_x2:'Away Win or Draw' };
  return map[mkt] || mkt;
}

// ── Fallback: football-data.org when BetMiner quota is hit ──
async function fallbackFootballData(reqDate, now, res) {
  var fdKey = process.env.FOOTBALL_DATA_KEY;
  if (!fdKey) return res.status(503).json({ error: 'BetMiner quota reached and no fallback key set. Predictions resume tomorrow.' });

  try {
    var end = new Date(reqDate+'T12:00:00Z'); end.setUTCDate(end.getUTCDate()+6);
    var endStr = end.toISOString().slice(0,10);
    var r = await fetch('https://api.football-data.org/v4/matches?dateFrom='+reqDate+'&dateTo='+endStr, {
      headers: { 'X-Auth-Token': fdKey }
    });
    if (!r.ok) return res.status(503).json({ error: 'BetMiner quota reached. Predictions will refresh tomorrow at midnight UTC.' });
    var raw = await r.json();
    var byDate = {};
    (raw.matches||[]).forEach(function(m) {
      var d = m.utcDate ? m.utcDate.slice(0,10) : null;
      if (!d) return;
      var home = m.homeTeam&&(m.homeTeam.shortName||m.homeTeam.name);
      var away = m.awayTeam&&(m.awayTeam.shortName||m.awayTeam.name);
      if (!home||!away) return;
      var minsAgo = (now.getTime()-new Date(m.utcDate).getTime())/60000;
      if ((m.status==='SCHEDULED'||m.status==='TIMED') && minsAgo < 0) {
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push({ home:home, away:away,
          league:(m.competition&&m.competition.name)||'Unknown',
          kickoff_iso:m.utcDate, is_live:false, is_finished:false, status:'TIMED',
          prediction:'—', confidence:0, odds:null, value_rating:'neutral', value_pct:0 });
      }
    });
    var dates = Object.keys(byDate).sort();
    var target = byDate[reqDate] ? reqDate : dates.find(function(d){ return d >= reqDate && byDate[d].length; });
    if (!target) return res.status(200).json({ predictions:[], edge:[], date:reqDate, requested:reqDate,
      message:'No upcoming fixtures found. Try a different date.' });
    var preds = byDate[target];
    return res.status(200).json({ predictions:preds, edge:[], date:target, requested:reqDate,
      fetched_at:now.toISOString() });
  } catch(err) {
    return res.status(200).json({ predictions:[], edge:[], date:reqDate, requested:reqDate, message:'No fixtures available for this date. Try another date.' });
  }
}
