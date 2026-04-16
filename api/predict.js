// api/predict.js — ScoutAI Real Predictions
// football-data.org (fixtures) + Odds API (real bookmaker predictions)
// Smart caching: fixtures 15min, odds 6hr (conserves Odds API quota)
// No BetMiner dependency

var fixtureCache = { data:null, fetched:0, fromDate:null };
var oddsCache    = { data:[], fetched:0 };  // cached 6 hours

// Map football-data.org competition names → Odds API league keys
var LEAGUE_MAP = {
  'Premier League':           'soccer_epl',
  'Championship':             'soccer_efl_champ',
  'League One':               'soccer_england_league1',
  'League Two':               'soccer_england_league2',
  'La Liga':                  'soccer_spain_la_liga',
  'Segunda Division':         'soccer_spain_segunda_division',
  'Bundesliga':               'soccer_germany_bundesliga',
  '2. Bundesliga':            'soccer_germany_bundesliga2',
  'Serie A':                  'soccer_italy_serie_a',
  'Serie B':                  'soccer_italy_serie_b',
  'Ligue 1':                  'soccer_france_ligue_one',
  'Ligue 2':                  'soccer_france_ligue_two',
  'Primeira Liga':            'soccer_portugal_primeira_liga',
  'Eredivisie':               'soccer_netherlands_eredivisie',
  'Scottish Premiership':     'soccer_spl',
  'Süper Lig':                'soccer_turkey_super_league',
  'Brasileirão Série A':      'soccer_brazil_campeonato',
  'MLS':                      'soccer_usa_mls',
  'Liga MX':                  'soccer_mexico_ligamx',
  'K League 1':               'soccer_korea_kleague1',
  'J1 League':                'soccer_japan_j_league',
  'Allsvenskan':              'soccer_sweden_allsvenskan',
  'Eliteserien':              'soccer_norway_eliteserien',
  'Ekstraklasa':              'soccer_poland_ekstraklasa',
  'UEFA Champions League':    'soccer_uefa_champs_league',
  'UEFA Europa League':       'soccer_uefa_europa_league',
  'UEFA Europa Conference League': 'soccer_uefa_europa_conference_league',
  'Copa Libertadores':        'soccer_conmebol_copa_libertadores',
  'Copa Sudamericana':        'soccer_conmebol_copa_sudamericana',
  'Austrian Football Bundesliga': 'soccer_austria_bundesliga',
  'Swiss Super League':       'soccer_switzerland_superleague',
  'Greek Super League':       'soccer_greece_super_league'
};

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

  // ── Step 1: Fixtures from football-data.org ───────────────
  var byDate = null;
  var fAge   = Date.now() - (fixtureCache.fetched || 0);
  if (fixtureCache.data && fAge < 900000 && fixtureCache.fromDate === today) {
    byDate = fixtureCache.data;
  } else {
    var end = new Date(today + 'T12:00:00Z');
    end.setUTCDate(end.getUTCDate() + 6);
    try {
      var r1 = await fetch(
        'https://api.football-data.org/v4/matches?dateFrom=' + today + '&dateTo=' + end.toISOString().slice(0,10),
        { headers: { 'X-Auth-Token': fdKey } }
      );
      if (!r1.ok) throw new Error('football-data.org ' + r1.status);
      var fd  = await r1.json();
      byDate  = groupFixtures(fd.matches || [], now.getTime());
      fixtureCache = { data:byDate, fetched:Date.now(), fromDate:today };
    } catch(e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // Find target date
  var available = Object.keys(byDate).sort();
  var targetDate = null;
  if (byDate[reqDate] && byDate[reqDate].length) {
    targetDate = reqDate;
  } else {
    for (var i = 0; i < available.length; i++) {
      if (available[i] >= reqDate && byDate[available[i]].length) { targetDate = available[i]; break; }
    }
  }
  if (!targetDate) {
    return res.status(200).json({ predictions:[], edge:[], date:reqDate, requested:reqDate,
      message:'No upcoming fixtures found. Try a different date.' });
  }

  var fixtures = byDate[targetDate];

  // ── Step 2: Real odds — only fetch leagues in today's fixtures ──
  // Cache 6 hours to conserve Odds API quota (500/month free)
  var oAge = Date.now() - (oddsCache.fetched || 0);
  var allOdds = [];

  if (oddsCache.data && oddsCache.data.length && oAge < 21600000) {
    allOdds = oddsCache.data;
  } else {
    // Find unique league keys needed
    var leagueKeys = [];
    fixtures.forEach(function(f) {
      var key = LEAGUE_MAP[f.league];
      if (key && leagueKeys.indexOf(key) === -1) leagueKeys.push(key);
    });
    // Also add any leagues from other dates in the week
    available.forEach(function(d) {
      (byDate[d] || []).forEach(function(f) {
        var key = LEAGUE_MAP[f.league];
        if (key && leagueKeys.indexOf(key) === -1) leagueKeys.push(key);
      });
    });

    if (leagueKeys.length > 0) {
      try {
        var oddsResults = await Promise.all(leagueKeys.map(function(lg) {
          return fetch(
            'https://api.the-odds-api.com/v4/sports/' + lg + '/odds/' +
            '?apiKey=' + oddsKey + '&regions=uk,eu&markets=h2h&oddsFormat=decimal',
            { headers: { 'Accept': 'application/json' } }
          )
          .then(function(r) { return r.ok ? r.json() : []; })
          .then(function(d) { return Array.isArray(d) ? d : []; })
          .catch(function() { return []; });
        }));
        oddsResults.forEach(function(d) { allOdds = allOdds.concat(d); });
        oddsCache = { data:allOdds, fetched:Date.now() };
      } catch(e) { allOdds = []; }
    }
  }

  // ── Step 3: Match fixtures to odds, build real predictions ──
  var predictions = [], edgeData = [];

  fixtures.forEach(function(fix, idx) {
    var match = findOddsMatch(fix.home, fix.away, fix.kickoff_iso, allOdds);

    var prediction = null, confidence = null, oddsObj = null;
    var goalsPred  = null, goalsConf  = null;
    var edgeScore  = 0, edgeLevel = 'none';
    var factors    = [], verdict = '';

    if (match && match.bookmakers && match.bookmakers.length) {
      var best = getBestOdds(match);
      var avg  = getAvgOdds(match);
      oddsObj  = { home:best.home, draw:best.draw, away:best.away };

      // Implied probabilities (normalised to remove bookmaker margin)
      var rh = 1/best.home, rd = 1/best.draw, ra = 1/best.away;
      var t  = rh + rd + ra;
      var ph = Math.round(rh/t*100);
      var pd = Math.round(rd/t*100);
      var pa = Math.round(ra/t*100);

      // Prediction = highest probability
      if (ph >= pd && ph >= pa)      { prediction='Home Win'; confidence=ph; }
      else if (pa > ph && pa >= pd)  { prediction='Away Win'; confidence=pa; }
      else                           { prediction='Draw';     confidence=pd; }

      // Edge: difference between best and average odds
      var edgePct = 0;
      if (avg) {
        var predOdd = prediction==='Home Win'?best.home:prediction==='Away Win'?best.away:best.draw;
        var avgOdd  = prediction==='Home Win'?avg.home :prediction==='Away Win'?avg.away :avg.draw;
        if (avgOdd > 0) edgePct = Math.round((predOdd - avgOdd) / avgOdd * 100);
      }
      edgeScore = Math.min(100, Math.max(0, Math.abs(edgePct) * 4));
      edgeLevel = edgeScore>=70?'elite':edgeScore>=50?'high':edgeScore>=25?'medium':edgeScore>=8?'low':'none';

      var bkCount = match.bookmakers.length;
      if (edgePct > 3) factors.push({ label:'Best odds '+edgePct+'% above market average ('+bkCount+' bookmakers)', type:'positive' });
      if (bkCount >= 5) factors.push({ label:bkCount+' bookmakers pricing this match', type:'positive' });
      if (confidence >= 65) factors.push({ label:'Strong market consensus on '+prediction, type:'positive' });
      else factors.push({ label:'Closely contested — market uncertain on outcome', type:'neutral' });

      verdict = confidence>=65 ? 'Market strongly favours '+prediction+' at '+confidence+'% implied probability.'
              : confidence>=55 ? 'Moderate market lean towards '+prediction+'. Consider value in odds.'
              : 'Market sees this as very open. Approach with caution.';

      // Goals from odds if available
      var g25 = getGoalsOdds(match, 'Over 2.5');
      if (g25) {
        var gp = Math.round(1/g25/(1/g25+1/(1/g25>0?2.5:1))*100);
        if (1/g25 > 0.6) { goalsPred='Over 2.5 Goals'; goalsConf=Math.round(1/g25*100); }
        else if (1/g25 < 0.4) { goalsPred='Under 2.5 Goals'; goalsConf=Math.round((1-(1/g25))*100); }
      }
      if (!goalsPred) {
        goalsPred = confidence >= 55 ? 'Over 1.5 Goals' : null;
        goalsConf = goalsPred ? 62 : null;
      }
    } else {
      // No odds yet — show fixture without prediction
      factors.push({ label:'Odds not yet available for this fixture', type:'neutral' });
      verdict = 'Odds typically appear 24-48h before kickoff. Check back later.';
    }

    predictions.push({
      home:fix.home, away:fix.away, league:fix.league,
      kickoff_iso:fix.kickoff_iso,
      is_live:false, is_finished:false, status:'TIMED',
      prediction:prediction, confidence:confidence,
      goals_prediction:goalsPred, goals_confidence:goalsConf,
      odds:oddsObj, has_odds:!!match,
      bookmakers: match ? (match.bookmakers||[]).map(function(b){return b.title;}) : []
    });

    edgeData.push({ index:idx, edge_score:edgeScore, edge_level:edgeLevel, factors:factors, verdict:verdict });
  });

  return res.status(200).json({
    predictions:predictions, edge:edgeData,
    date:targetDate, requested:reqDate, fetched_at:now.toISOString(),
    odds_matched: predictions.filter(function(p){return p.has_odds;}).length
  });
};

// ── Helpers ──────────────────────────────────────────────────
function groupFixtures(matches, nowMs) {
  var byDate = {};
  matches.forEach(function(m) {
    var d = m.utcDate ? m.utcDate.slice(0,10) : null;
    if (!d) return;
    var home = m.homeTeam&&(m.homeTeam.shortName||m.homeTeam.name);
    var away = m.awayTeam&&(m.awayTeam.shortName||m.awayTeam.name);
    if (!home||!away) return;
    if ((nowMs - new Date(m.utcDate).getTime())/60000 > 5) return;
    if (m.status!=='SCHEDULED'&&m.status!=='TIMED') return;
    if (!byDate[d]) byDate[d]=[];
    byDate[d].push({ home:home, away:away, league:(m.competition&&m.competition.name)||'Unknown', kickoff_iso:m.utcDate });
  });
  return byDate;
}

function findOddsMatch(home, away, kickoff, events) {
  var koMs = kickoff ? new Date(kickoff).getTime() : 0;
  var best = null, bestScore = 0;
  events.forEach(function(e) {
    var eMs = e.commence_time ? new Date(e.commence_time).getTime() : 0;
    if (koMs && Math.abs(eMs-koMs) > 10800000) return; // 3hr window
    var s = Math.max(
      (sim(home,e.home_team)+sim(away,e.away_team))/2,
      (sim(home,e.away_team)+sim(away,e.home_team))/2
    );
    if (s > bestScore && s >= 0.5) { bestScore=s; best=e; }
  });
  return best;
}

function sim(a,b) {
  a=norm(a); b=norm(b);
  if(!a||!b) return 0;
  if(a===b) return 1;
  if(a.includes(b)||b.includes(a)) return 0.9;
  var wa=a.split(' ').filter(function(w){return w.length>2;});
  var wb=b.split(' ').filter(function(w){return w.length>2;});
  if(!wa.length||!wb.length) return 0;
  var common=wa.filter(function(w){return wb.indexOf(w)!==-1;});
  // Strong match if majority of shorter name's words match
  var shorter=Math.min(wa.length,wb.length);
  if(common.length>=shorter) return 0.85;
  if(common.length>0) return 0.6;
  return 0;
}
function norm(s){
  return (s||'').toLowerCase()
    // Remove common club prefixes/suffixes
    .replace(/\bfc\b|\bsc\b|\bac\b|\bcf\b|\bfk\b|\bsk\b|\bif\b|\bbk\b/g,'')
    .replace(/\bclub\b|\bsporting\b|\bdeportivo\b|\batlético\b|\batletico\b/g,'')
    .replace(/\b-rj\b|\b-sp\b|\b-mg\b|\b-pr\b/g,'') // Brazilian city suffixes
    .replace(/\bsaint\b/g,'st').replace(/\bparis\b/g,'psg')
    // Remove accents
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
}

function getBestOdds(event) {
  var b={home:0,draw:0,away:0};
  (event.bookmakers||[]).forEach(function(bk){
    (bk.markets||[]).forEach(function(mkt){
      if(mkt.key!=='h2h')return;
      (mkt.outcomes||[]).forEach(function(o){
        if(o.name===event.home_team&&o.price>b.home)b.home=o.price;
        if(o.name===event.away_team&&o.price>b.away)b.away=o.price;
        if(o.name==='Draw'&&o.price>b.draw)b.draw=o.price;
      });
    });
  });
  if(!b.draw)b.draw=3.5;
  return b;
}
function getAvgOdds(event) {
  var s={home:0,draw:0,away:0},n={home:0,draw:0,away:0};
  (event.bookmakers||[]).forEach(function(bk){
    (bk.markets||[]).forEach(function(mkt){
      if(mkt.key!=='h2h')return;
      (mkt.outcomes||[]).forEach(function(o){
        if(o.name===event.home_team){s.home+=o.price;n.home++;}
        if(o.name===event.away_team){s.away+=o.price;n.away++;}
        if(o.name==='Draw'){s.draw+=o.price;n.draw++;}
      });
    });
  });
  if(!n.home)return null;
  return{home:s.home/n.home,draw:n.draw?s.draw/n.draw:3.5,away:s.away/n.away};
}
function getGoalsOdds(event, name) {
  var price=null;
  (event.bookmakers||[]).forEach(function(bk){
    (bk.markets||[]).forEach(function(mkt){
      if(mkt.key!=='totals')return;
      (mkt.outcomes||[]).forEach(function(o){
        if(o.name===name&&(!price||o.price<price))price=o.price;
      });
    });
  });
  return price;
}
