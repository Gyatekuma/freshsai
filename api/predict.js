// api/predict.js — ScoutAI Predictions
// Odds API (key leagues only) + football-data.org fallback
// Quota budget: ~8 leagues × 1 fetch/day × 30 days = 240 req/month (well within 500)

var cache = { events: [], fetched: 0 };

// Only the most globally popular leagues — keeps quota low
var KEY_LEAGUES = [
  'soccer_epl',                          // Premier League
  'soccer_efl_champ',                    // Championship
  'soccer_spain_la_liga',                // La Liga
  'soccer_italy_serie_a',                // Serie A
  'soccer_germany_bundesliga',           // Bundesliga
  'soccer_france_ligue_one',             // Ligue 1
  'soccer_uefa_champs_league',           // Champions League
  'soccer_uefa_europa_league',           // Europa League
  'soccer_uefa_europa_conference_league',// Conference League
  'soccer_conmebol_copa_libertadores',   // Copa Libertadores
  'soccer_usa_mls',                      // MLS
  'soccer_brazil_campeonato',            // Brasileirão
  'soccer_netherlands_eredivisie',       // Eredivisie
  'soccer_portugal_primeira_liga',       // Primeira Liga
  'soccer_turkey_super_league'           // Süper Lig
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now     = new Date();
  var today   = now.toISOString().slice(0, 10);
  var reqDate = (req.query && req.query.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) reqDate = today;

  var oddsKey = process.env.ODDS_API_KEY;
  var fdKey   = process.env.FOOTBALL_DATA_KEY;

  // ── Fetch odds — cache 24 hours ──────────────────────────
  var oAge = Date.now() - (cache.fetched || 0);
  var allEvents = [];

  if (cache.events && cache.events.length && oAge < 86400000) {
    allEvents = cache.events;
  } else if (oddsKey) {
    try {
      var results = await Promise.all(KEY_LEAGUES.map(function(lg) {
        return fetch(
          'https://api.the-odds-api.com/v4/sports/' + lg + '/odds/' +
          '?apiKey=' + oddsKey +
          '&regions=uk,eu&markets=h2h&oddsFormat=decimal&dateFormat=iso'
        )
        .then(function(r) { return r.ok ? r.json() : []; })
        .then(function(d) { return Array.isArray(d) ? d.map(function(e){ e._lg=lg; return e; }) : []; })
        .catch(function() { return []; });
      }));
      results.forEach(function(d){ allEvents = allEvents.concat(d); });
      if (allEvents.length) cache = { events: allEvents, fetched: Date.now() };
    } catch(e) { allEvents = []; }
  }

  // ── If Odds API empty, fall back to football-data.org ───
  if (!allEvents.length && fdKey) {
    return fallback(fdKey, reqDate, now, res);
  }
  if (!allEvents.length) {
    return res.status(200).json({
      predictions:[], edge:[], date:reqDate, requested:reqDate,
      message:'No fixtures available. Try again later.'
    });
  }

  // ── Filter to requested date (or next available) ────────
  var nowMs   = Date.now();
  var dayMs   = new Date(reqDate+'T00:00:00Z').getTime();
  var dayEnd  = dayMs + 86400000;

  var dayEvents = allEvents.filter(function(e) {
    if (!e.commence_time) return false;
    var t = new Date(e.commence_time).getTime();
    if (reqDate === today) return t > nowMs && t < dayEnd;
    return t >= dayMs && t < dayEnd;
  });

  // Auto-advance if nothing today
  if (!dayEvents.length) {
    var byDate = {};
    allEvents.forEach(function(e) {
      if (!e.commence_time) return;
      var t = new Date(e.commence_time).getTime();
      if (t <= nowMs) return;
      var d = e.commence_time.slice(0,10);
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(e);
    });
    var dates = Object.keys(byDate).sort();
    if (!dates.length) return fallback(fdKey, reqDate, now, res);
    reqDate = dates[0];
    dayEvents = byDate[reqDate];
  }

  dayEvents.sort(function(a,b){ return new Date(a.commence_time)-new Date(b.commence_time); });

  // ── Build predictions from real bookmaker odds ──────────
  var predictions = [], edgeData = [];
  dayEvents.forEach(function(event, idx) {
    if (!event.bookmakers || !event.bookmakers.length) return;
    var home = event.home_team, away = event.away_team;
    if (!home||!away) return;

    var best = getBestOdds(event);
    var avg  = getAvgOdds(event);
    if (!best.home||!best.away) return;

    var rh=1/best.home, rd=best.draw?1/best.draw:0.2, ra=1/best.away, t=rh+rd+ra;
    var ph=Math.round(rh/t*100), pd=Math.round(rd/t*100), pa=Math.round(ra/t*100);

    var prediction, confidence;
    if(ph>=pd&&ph>=pa){prediction='Home Win';confidence=ph;}
    else if(pa>ph&&pa>=pd){prediction='Away Win';confidence=pa;}
    else{prediction='Draw';confidence=pd;}

    var edgePct=0, edgeScore=0, edgeLevel='none';
    if(avg){
      var pB=prediction==='Home Win'?best.home:prediction==='Away Win'?best.away:(best.draw||3.5);
      var pA=prediction==='Home Win'?avg.home :prediction==='Away Win'?avg.away :(avg.draw||3.5);
      if(pA>0) edgePct=Math.round((pB-pA)/pA*100);
      edgeScore=Math.min(100,Math.max(0,Math.abs(edgePct)*5));
      edgeLevel=edgeScore>=70?'elite':edgeScore>=50?'high':edgeScore>=25?'medium':edgeScore>=8?'low':'none';
    }

    var bk=event.bookmakers.length;
    var factors=[];
    if(edgePct>=3) factors.push({label:'Best available odds '+edgePct+'% above market average',type:'positive'});
    if(bk>=10)    factors.push({label:bk+' bookmakers have priced this match',type:'positive'});
    if(confidence>=65) factors.push({label:'Strong market consensus: '+prediction+' at '+confidence+'%',type:'positive'});
    else if(confidence<45) factors.push({label:'Open match — market prices are very close',type:'neutral'});
    if(!factors.length) factors.push({label:'Moderate market confidence — assess carefully',type:'neutral'});

    var verdict=confidence>=65?'Market strongly favours '+prediction+' — '+confidence+'% implied probability across '+bk+' bookmakers.'
      :confidence>=52?'Market leans towards '+prediction+'. Value possible with the best available odds.'
      :'Very competitive pricing — this is an open contest.';

    var gp=null,gc=null;
    var o25=getTotals(event,'Over',2.5), u25=getTotals(event,'Under',2.5);
    if(o25&&u25){var pO=Math.round(1/o25/(1/o25+1/u25)*100);if(pO>=60){gp='Over 2.5 Goals';gc=pO;}else if(pO<=40){gp='Under 2.5 Goals';gc=100-pO;}}
    if(!gp&&confidence>=60){gp='Over 1.5 Goals';gc=63;}

    predictions.push({
      home:home,away:away,league:lgName(event._lg),
      kickoff_iso:event.commence_time,
      is_live:false,is_finished:false,status:'TIMED',
      prediction:prediction,confidence:confidence,
      goals_prediction:gp,goals_confidence:gc,
      odds:{home:r2(best.home),draw:r2(best.draw||3.5),away:r2(best.away)},
      has_odds:true,bookmaker_count:bk
    });
    edgeData.push({index:idx,edge_score:edgeScore,edge_level:edgeLevel,factors:factors,verdict:verdict});
  });

  return res.status(200).json({
    predictions:predictions,edge:edgeData,
    date:reqDate,requested:req.query&&req.query.date||today,
    fetched_at:now.toISOString(),odds_matched:predictions.length
  });
};

// ── Fallback: football-data.org fixtures, no odds ───────────
async function fallback(fdKey, reqDate, now, res) {
  if (!fdKey) return res.status(200).json({predictions:[],edge:[],date:reqDate,requested:reqDate,message:'No data available right now.'});
  try {
    var end=new Date(reqDate+'T12:00:00Z'); end.setUTCDate(end.getUTCDate()+6);
    var r=await fetch('https://api.football-data.org/v4/matches?dateFrom='+reqDate+'&dateTo='+end.toISOString().slice(0,10),{headers:{'X-Auth-Token':fdKey}});
    if(!r.ok) return res.status(200).json({predictions:[],edge:[],date:reqDate,requested:reqDate,message:'No fixtures available right now.'});
    var raw=await r.json(); var nowMs=now.getTime();
    var byDate={};
    (raw.matches||[]).forEach(function(m){
      var d=m.utcDate?m.utcDate.slice(0,10):null; if(!d)return;
      if(m.status!=='SCHEDULED'&&m.status!=='TIMED')return;
      if(new Date(m.utcDate).getTime()<=nowMs)return;
      var home=m.homeTeam&&(m.homeTeam.shortName||m.homeTeam.name);
      var away=m.awayTeam&&(m.awayTeam.shortName||m.awayTeam.name);
      if(!home||!away)return;
      if(!byDate[d])byDate[d]=[];
      byDate[d].push({home:home,away:away,league:(m.competition&&m.competition.name)||'Unknown',kickoff_iso:m.utcDate});
    });
    var dates=Object.keys(byDate).sort();
    var target=byDate[reqDate]&&byDate[reqDate].length?reqDate:(dates.find(function(d){return d>=reqDate&&byDate[d].length;}));
    if(!target)return res.status(200).json({predictions:[],edge:[],date:reqDate,requested:reqDate,message:'No upcoming fixtures found.'});
    var preds=byDate[target].map(function(f,i){
      return {home:f.home,away:f.away,league:f.league,kickoff_iso:f.kickoff_iso,is_live:false,is_finished:false,status:'TIMED',prediction:null,confidence:null,goals_prediction:null,goals_confidence:null,odds:null,has_odds:false,bookmaker_count:0};
    });
    return res.status(200).json({predictions:preds,edge:[],date:target,requested:reqDate,fetched_at:now.toISOString(),fallback:true});
  } catch(e){
    return res.status(200).json({predictions:[],edge:[],date:reqDate,requested:reqDate,message:'No fixtures available right now.'});
  }
}

function getBestOdds(e){var b={home:0,draw:0,away:0};(e.bookmakers||[]).forEach(function(bk){(bk.markets||[]).forEach(function(m){if(m.key!=='h2h')return;(m.outcomes||[]).forEach(function(o){if(o.name===e.home_team&&o.price>b.home)b.home=o.price;if(o.name===e.away_team&&o.price>b.away)b.away=o.price;if(o.name==='Draw'&&o.price>b.draw)b.draw=o.price;});});});return b;}
function getAvgOdds(e){var s={home:0,draw:0,away:0},n={home:0,draw:0,away:0};(e.bookmakers||[]).forEach(function(bk){(bk.markets||[]).forEach(function(m){if(m.key!=='h2h')return;(m.outcomes||[]).forEach(function(o){if(o.name===e.home_team){s.home+=o.price;n.home++;}if(o.name===e.away_team){s.away+=o.price;n.away++;}if(o.name==='Draw'){s.draw+=o.price;n.draw++;}});});});if(!n.home)return null;return{home:s.home/n.home,draw:n.draw?s.draw/n.draw:0,away:s.away/n.away};}
function getTotals(e,side,pts){var p=null;(e.bookmakers||[]).forEach(function(bk){(bk.markets||[]).forEach(function(m){if(m.key!=='totals')return;(m.outcomes||[]).forEach(function(o){if(o.name===side&&o.point===pts&&(!p||o.price<p))p=o.price;});});});return p;}
function r2(n){return Math.round(n*100)/100;}
function lgName(k){var m={'soccer_epl':'Premier League','soccer_efl_champ':'Championship','soccer_england_league1':'League One','soccer_england_league2':'League Two','soccer_spain_la_liga':'La Liga','soccer_italy_serie_a':'Serie A','soccer_germany_bundesliga':'Bundesliga','soccer_france_ligue_one':'Ligue 1','soccer_portugal_primeira_liga':'Primeira Liga','soccer_netherlands_eredivisie':'Eredivisie','soccer_spl':'Scottish Premiership','soccer_turkey_super_league':'Süper Lig (Turkey)','soccer_brazil_campeonato':'Brasileirão Série A','soccer_usa_mls':'MLS','soccer_argentina_primera_division':'Primera División (Argentina)','soccer_conmebol_copa_libertadores':'Copa Libertadores','soccer_conmebol_copa_sudamericana':'Copa Sudamericana','soccer_uefa_champs_league':'UEFA Champions League','soccer_uefa_europa_league':'UEFA Europa League','soccer_uefa_europa_conference_league':'UEFA Conference League','soccer_fa_cup':'FA Cup','soccer_germany_bundesliga2':'2. Bundesliga','soccer_italy_serie_b':'Serie B (Italy)','soccer_france_ligue_two':'Ligue 2','soccer_chile_campeonato':'Primera División (Chile)'};return m[k]||k;}
