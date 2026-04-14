// api/predict.js — ScoutAI
// Real fixtures from TheSportsDB (free, no key needed)
// Predictions layered on top of real match data

var cache = { date: null, data: null };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (cache.date === today && cache.data) {
    return res.status(200).json(cache.data);
  }

  // ── Seeded random (same day = same predictions) ──────────────
  var seedBase = parseInt(today.replace(/-/g, ''), 10);
  var si = 0;
  function rnd() {
    var x = Math.sin(seedBase + (++si) * 127773 + 49297) * 43758.5453;
    return x - Math.floor(x);
  }
  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
  function range(a, b) { return Math.floor(rnd() * (b - a + 1)) + a; }

  // ── Prediction data ──────────────────────────────────────────
  var predTypes   = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goalMarkets = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals','Over 1.5 Goals'];
  var edgeLevels  = ['none','none','low','medium','medium','high','elite'];
  var posFacts    = ['Strong home record this season','Title race pressure drives motivation','Revenge fixture after earlier defeat','Star striker in excellent form','Unbeaten in last 6 home games','Derby atmosphere expected','Top 4 battle intensifies','Momentum from recent cup run'];
  var negFacts    = ['Key midfielder suspended','Top scorer doubtful with knock','Away side on strong away run','Fixture congestion this week','Long injury list in camp','Key defender missing through injury'];
  var verdicts    = ['Form and motivation firmly favour the home side today.','Tactical discipline likely to be decisive in this tight encounter.','Goals expected as both sides push forward.','Narrative pressure creates an unpredictable edge.','Away side\'s recent form makes this closer than the odds suggest.','High stakes on both ends of the table add significant weight.','A revenge angle adds extra motivation for the visiting side.','Home crowd expected to be a decisive factor in a nervy affair.'];

  function makePrediction(home, away, league, time, idx) {
    si = seedBase % 1000 + idx * 17; // unique seed per match
    var pred  = pick(predTypes);
    var conf  = range(50, 88);
    var gPred = rnd() > 0.15 ? pick(goalMarkets) : null;
    var gConf = gPred ? range(52, 83) : null;
    var elvl  = pick(edgeLevels);
    var escore = elvl==='none'?range(5,25):elvl==='low'?range(30,48):elvl==='medium'?range(50,68):elvl==='high'?range(70,84):range(85,97);
    var numFacts = elvl==='none'||elvl==='low' ? 1 : 2;
    var facts = [];
    for (var f = 0; f < numFacts; f++) {
      facts.push({ label: f===0 ? pick(posFacts) : pick(negFacts), type: f===0 ? 'positive' : 'negative' });
    }
    return {
      match:    { home:home, away:away, league:league, time:time, date:today, prediction:pred, confidence:conf, goals_prediction:gPred, goals_confidence:gConf },
      edge:     { index:idx, edge_score:escore, edge_level:elvl, factors:facts, verdict:pick(verdicts) }
    };
  }

  // ── Fetch real fixtures from TheSportsDB ─────────────────────
  var MAJOR_LEAGUES = ['4328','4335','4332','4331','4334','4480','4399','4406','4481','4346'];
  // 4328=EPL 4335=La Liga 4332=Bundesliga 4331=Serie A 4334=Ligue1 4480=Championship
  // 4399=MLS 4406=Scottish Prem 4481=Eredivisie 4346=Champions League

  var allEvents = [];

  try {
    var r = await fetch('https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=' + today + '&s=Soccer');
    var d = await r.json();
    var events = (d && d.events) || [];

    // Filter to major leagues and real matches with teams
    allEvents = events.filter(function(e) {
      return e.strHomeTeam && e.strAwayTeam && e.strLeague &&
        (e.strStatus === 'NS' || e.strStatus === '' || !e.strStatus || e.strStatus === 'Not Started');
    }).slice(0, 20);

  } catch(err) {
    // TheSportsDB failed — fall back to fixture-aware generated matches
    allEvents = [];
  }

  var predictions = [], edgeData = [];

  if (allEvents.length >= 6) {
    // Use real fixtures
    allEvents.forEach(function(e, idx) {
      var timeStr = '';
      if (e.strTime) {
        timeStr = e.strTime.slice(0, 5);
      }
      var result = makePrediction(e.strHomeTeam, e.strAwayTeam, e.strLeague, timeStr, idx);
      result.match.league = e.strLeague;
      predictions.push(result.match);
      edgeData.push(result.edge);
    });
  } else {
    // Fallback: generated fixtures using real teams
    var leagueTeams = {
      'Premier League':    ['Arsenal','Chelsea','Manchester City','Liverpool','Manchester United','Tottenham','Newcastle','Aston Villa','West Ham','Brighton','Brentford','Fulham','Crystal Palace','Wolves','Everton'],
      'La Liga':           ['Real Madrid','Barcelona','Atletico Madrid','Sevilla','Real Sociedad','Villarreal','Athletic Bilbao','Girona','Betis','Osasuna'],
      'Serie A':           ['Inter Milan','AC Milan','Juventus','Napoli','Roma','Lazio','Atalanta','Fiorentina','Bologna','Torino'],
      'Bundesliga':        ['Bayern Munich','Borussia Dortmund','RB Leipzig','Bayer Leverkusen','Eintracht Frankfurt','Stuttgart','Wolfsburg','Freiburg','Hoffenheim','Mainz'],
      'Ligue 1':           ['PSG','Monaco','Lens','Lille','Lyon','Marseille','Rennes','Nice','Brest','Nantes'],
      'Championship':      ['Leeds United','Leicester City','Ipswich Town','Southampton','Sunderland','West Brom','Norwich','Middlesbrough','Coventry','Watford'],
      'Champions League':  ['Real Madrid','Manchester City','Bayern Munich','PSG','Barcelona','Inter Milan','Arsenal','Borussia Dortmund'],
      'Europa League':     ['Liverpool','Roma','Atalanta','Fiorentina','West Ham','Villarreal','Bayer Leverkusen','Sporting CP']
    };
    var lgNames = Object.keys(leagueTeams);
    var used = {}, count = 0;
    while (count < 16) {
      var lg = lgNames[count % lgNames.length];
      var teams = leagueTeams[lg];
      si = seedBase + count * 31;
      var home = pick(teams), away = pick(teams);
      var key = home + away;
      if (home === away || used[key]) { count++; continue; }
      used[key] = true;
      var timeStr = range(12, 20) + ':' + (rnd() > 0.5 ? '30' : '00');
      var result = makePrediction(home, away, lg, timeStr, count);
      predictions.push(result.match);
      edgeData.push(result.edge);
      count++;
    }
  }

  var out = { predictions: predictions, edge: edgeData, date: today, source: allEvents.length >= 6 ? 'live' : 'generated' };
  cache = { date: today, data: out };
  return res.status(200).json(out);
};
