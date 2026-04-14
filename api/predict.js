// api/predict.js — ScoutAI
// Real fixtures from ESPN public API (no key needed, very reliable)
// Filters out matches where kickoff has already passed (GMT)

var cache = { date: null, data: null };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var now   = new Date();
  var today = now.toISOString().slice(0, 10); // YYYY-MM-DD

  // Cache per day but also store fetch time so we can re-filter
  // as time passes (don't cache for longer than 30 min)
  var cacheAge = cache._fetched ? (Date.now() - cache._fetched) : Infinity;
  if (cache.date === today && cache.data && cacheAge < 1800000) {
    // Re-filter for already-started matches on the cached data
    return res.status(200).json(filterAndRespond(cache.data, now));
  }

  // ── Seeded prediction engine ──────────────────────────────
  var seedBase = parseInt(today.replace(/-/g,''), 10);
  var si = 0;
  function rnd(){ var x=Math.sin(seedBase+(++si)*127773+49297)*43758.5453; return x-Math.floor(x); }
  function pick(arr){ return arr[Math.floor(rnd()*arr.length)]; }
  function range(a,b){ return Math.floor(rnd()*(b-a+1))+a; }

  var predTypes   = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goalMarkets = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals'];
  var edgeLevels  = ['none','none','low','medium','medium','high','elite'];
  var posFacts    = ['Strong home record this season','Title race pressure drives motivation','Revenge fixture after earlier defeat','Derby atmosphere expected','Unbeaten in last 6 home games','Star striker in top form','Momentum from recent run of wins'];
  var negFacts    = ['Key midfielder suspended','Top scorer doubtful with knock','Fixture congestion this week','Long injury list reported','Key defender missing through injury'];
  var verdicts    = ['Form and motivation firmly favour the home side.','Tactical discipline likely decisive in this tight encounter.','Goals expected as both sides push forward.','Narrative pressure creates an unpredictable edge.','Away side\'s recent form makes this closer than it looks.','High stakes on both ends add significant narrative weight.','A revenge angle adds extra motivation for the visitors.','Home crowd expected to be a decisive factor.'];

  function makePred(home, away, league, kickoffISO, idx) {
    si = (seedBase % 999) + idx * 31 + home.length * 7;
    var pred  = pick(predTypes);
    var conf  = range(50, 88);
    var gPred = rnd()>0.15 ? pick(goalMarkets) : null;
    var gConf = gPred ? range(52,83) : null;
    var elvl  = pick(edgeLevels);
    var escore = elvl==='none'?range(5,25):elvl==='low'?range(30,48):elvl==='medium'?range(50,68):elvl==='high'?range(70,84):range(85,97);
    var nf = (elvl==='none'||elvl==='low') ? 1 : 2;
    var facts=[];
    for(var f=0;f<nf;f++) facts.push({label:f===0?pick(posFacts):pick(negFacts), type:f===0?'positive':'negative'});
    return {
      match: { home:home, away:away, league:league, kickoff_iso:kickoffISO, prediction:pred, confidence:conf, goals_prediction:gPred, goals_confidence:gConf },
      edge:  { index:idx, edge_score:escore, edge_level:elvl, factors:facts, verdict:pick(verdicts) }
    };
  }

  // ── Fetch from ESPN public API ─────────────────────────────
  // ESPN league slugs (soccer)
  var ESPN_LEAGUES = [
    { slug:'eng.1',    name:'Premier League' },
    { slug:'esp.1',    name:'La Liga' },
    { slug:'ita.1',    name:'Serie A' },
    { slug:'ger.1',    name:'Bundesliga' },
    { slug:'fra.1',    name:'Ligue 1' },
    { slug:'eng.2',    name:'Championship' },
    { slug:'uefa.champions', name:'Champions League' },
    { slug:'uefa.europa',    name:'Europa League' },
    { slug:'usa.1',    name:'MLS' },
    { slug:'sco.1',    name:'Scottish Premiership' },
    { slug:'ned.1',    name:'Eredivisie' },
    { slug:'por.1',    name:'Primeira Liga' },
  ];

  var dateStr = today.replace(/-/g,''); // YYYYMMDD for ESPN
  var allEvents = [];

  try {
    // Fetch all leagues in parallel
    var fetches = ESPN_LEAGUES.map(function(lg) {
      return fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/'+lg.slug+'/scoreboard?dates='+dateStr)
        .then(function(r){ return r.json(); })
        .then(function(d){
          var events = d.events || [];
          return events.map(function(e){
            var comp = e.competitions && e.competitions[0];
            if (!comp) return null;
            var teams = comp.competitors || [];
            var home  = teams.find(function(t){return t.homeAway==='home';});
            var away  = teams.find(function(t){return t.homeAway==='away';});
            if (!home||!away) return null;
            // Only include not-started matches
            var status = comp.status && comp.status.type && comp.status.type.name;
            if (status && status !== 'STATUS_SCHEDULED' && status !== 'STATUS_POSTPONED') return null;
            return {
              home:        (home.team && home.team.displayName) || (home.team && home.team.name) || '',
              away:        (away.team && away.team.displayName) || (away.team && away.team.name) || '',
              league:      lg.name,
              kickoff_iso: e.date || comp.date || null
            };
          }).filter(Boolean);
        })
        .catch(function(){ return []; });
    });

    var results = await Promise.all(fetches);
    results.forEach(function(r){ allEvents = allEvents.concat(r); });

  } catch(err) {
    allEvents = [];
  }

  var predictions = [], edgeData = [];

  if (allEvents.length >= 4) {
    // Use real ESPN fixtures
    allEvents.forEach(function(e, idx) {
      var r = makePred(e.home, e.away, e.league, e.kickoff_iso, idx);
      predictions.push(r.match);
      edgeData.push(r.edge);
    });
  } else {
    // Fallback: generated fixtures with correct today's date and future times
    var fallbackLeagues = {
      'Premier League':  ['Arsenal','Chelsea','Manchester City','Liverpool','Manchester United','Tottenham','Newcastle','Aston Villa','West Ham','Brighton'],
      'La Liga':         ['Real Madrid','Barcelona','Atletico Madrid','Sevilla','Real Sociedad','Villarreal','Athletic Bilbao','Girona'],
      'Serie A':         ['Inter Milan','AC Milan','Juventus','Napoli','Roma','Lazio','Atalanta','Fiorentina'],
      'Bundesliga':      ['Bayern Munich','Borussia Dortmund','RB Leipzig','Bayer Leverkusen','Eintracht Frankfurt','Stuttgart'],
      'Ligue 1':         ['PSG','Monaco','Lens','Lille','Lyon','Marseille','Rennes','Nice'],
      'Championship':    ['Leeds United','Leicester City','Southampton','Sunderland','West Brom','Norwich'],
      'Champions League':['Real Madrid','Manchester City','Bayern Munich','PSG','Barcelona','Inter Milan','Arsenal','Borussia Dortmund'],
    };
    var lgNames = Object.keys(fallbackLeagues);
    var used={}, count=0;

    // Generate kickoff times starting 1 hour from now in 30-min slots
    var baseTime = new Date(now.getTime() + 60*60*1000);
    baseTime.setMinutes(baseTime.getMinutes() < 30 ? 0 : 30, 0, 0);

    while(count < 16) {
      var lg = lgNames[count % lgNames.length];
      var teams = fallbackLeagues[lg];
      si = seedBase + count*31;
      var home = pick(teams), away = pick(teams);
      var key = home+away;
      if(home===away||used[key]){count++;continue;}
      used[key]=true;

      // Kickoff: stagger by 30 min increments
      var ko = new Date(baseTime.getTime() + Math.floor(count/2)*30*60*1000);
      var koISO = ko.toISOString();

      var r = makePred(home, away, lg, koISO, count);
      predictions.push(r.match);
      edgeData.push(r.edge);
      count++;
    }
  }

  var raw = { predictions:predictions, edge:edgeData, fetched_at: now.toISOString(), source: allEvents.length>=4?'live':'generated' };
  cache = { date:today, data:raw, _fetched: Date.now() };

  return res.status(200).json(filterAndRespond(raw, now));
};

// Filter out matches that have already kicked off
function filterAndRespond(raw, now) {
  var upcoming = (raw.predictions||[]).filter(function(m) {
    if (!m.kickoff_iso) return true;
    return new Date(m.kickoff_iso) > now;
  });

  // Re-index edge data to match filtered predictions
  var edgeMap = {};
  (raw.edge||[]).forEach(function(e){ edgeMap[e.index]=e; });

  var edge = upcoming.map(function(m, i) {
    var orig = raw.predictions.indexOf(m);
    var e = edgeMap[orig] || { index:i, edge_score:20, edge_level:'none', factors:[], verdict:'' };
    return Object.assign({}, e, { index: i });
  });

  return { predictions:upcoming, edge:edge, source:raw.source, fetched_at:raw.fetched_at };
}
