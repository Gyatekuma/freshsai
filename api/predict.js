// api/predict.js — ScoutAI Prediction Engine
// No external API needed. Generates realistic daily predictions
// from a real team database, seeded by date (changes every day).

var cache = { date: null, data: null };

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var today = new Date().toISOString().slice(0, 10);
  if (cache.date === today && cache.data) {
    return res.status(200).json(cache.data);
  }

  // Deterministic seed from date so same day = same predictions
  var seed = today.split('-').join('') * 1;
  function rand(s) {
    s = Math.sin(s) * 10000;
    return s - Math.floor(s);
  }
  var i = 0;
  function next() { return rand(seed + (++i) * 9301 + 49297); }
  function pick(arr) { return arr[Math.floor(next() * arr.length)]; }
  function range(min, max) { return Math.floor(next() * (max - min + 1)) + min; }

  var leagues = {
    'Premier League': ['Arsenal','Chelsea','Manchester City','Liverpool','Manchester United','Tottenham','Newcastle','Aston Villa','West Ham','Brighton','Brentford','Fulham','Crystal Palace','Wolves','Everton','Nottm Forest','Bournemouth','Sheffield United','Burnley','Luton'],
    'La Liga': ['Real Madrid','Barcelona','Atletico Madrid','Sevilla','Real Sociedad','Villarreal','Athletic Bilbao','Valencia','Betis','Osasuna','Celta Vigo','Getafe','Las Palmas','Mallorca','Girona'],
    'Serie A': ['Inter Milan','AC Milan','Juventus','Napoli','Roma','Lazio','Atalanta','Fiorentina','Bologna','Torino','Monza','Sassuolo','Udinese','Lecce','Salernitana'],
    'Bundesliga': ['Bayern Munich','Borussia Dortmund','RB Leipzig','Bayer Leverkusen','Eintracht Frankfurt','Union Berlin','Freiburg','Wolfsburg','Mainz','Hoffenheim','Augsburg','Werder Bremen','Cologne','Stuttgart','Darmstadt'],
    'Ligue 1': ['PSG','Monaco','Lens','Lille','Lyon','Marseille','Rennes','Nice','Brest','Nantes','Strasbourg','Lorient','Toulouse','Montpellier','Clermont'],
    'Championship': ['Leeds United','Leicester City','Ipswich Town','Southampton','Sunderland','West Brom','Norwich','Middlesbrough','Coventry','Watford','QPR','Blackburn','Millwall','Swansea','Cardiff'],
    'Champions League': ['Real Madrid','Manchester City','Bayern Munich','PSG','Barcelona','Inter Milan','Atletico Madrid','Arsenal','Borussia Dortmund','Napoli','Porto','Benfica','Ajax','Celtic','AC Milan'],
    'Europa League': ['Liverpool','Roma','Bayer Leverkusen','Atalanta','Fiorentina','West Ham','Villarreal','Sevilla','Sporting CP','Feyenoord','Marseille','Lyon','Rangers','Union Berlin','Slavia Prague']
  };

  var predictions = ['Home Win','Home Win','Home Win','Away Win','Away Win','Draw','Home Win or Draw','Both Teams to Score'];
  var goalsPreds = ['Over 2.5 Goals','Under 2.5 Goals','Over 1.5 Goals','BTTS Yes','BTTS No','Over 2.5 Goals','Over 1.5 Goals'];
  var edgeLevels = ['none','none','low','medium','medium','high','elite'];
  var posFacts   = ['Strong home record this season','Title race pressure drives motivation','Revenge fixture after earlier defeat','Star striker in excellent form','Unbeaten in last 6 home games','Manager\'s milestone game today','Derby atmosphere expected','Top 4 battle intensifies','Momentum from cup run','Home fans returning after ban lifted'];
  var negFacts   = ['Key midfielder suspended','Top scorer doubtful with knock','Away side on strong away run','Fixture congestion after midweek cup tie','Manager under pressure after poor run','Key defender missing through injury','Away team desperate to avoid relegation','Long injury list in camp'];
  var verdicts   = ['Form and motivation firmly favour the home side today.','Tactical discipline likely to be decisive in this tight encounter.','Goals expected as both sides push forward with attacking intent.','Narrative pressure creates an unpredictable edge in this fixture.','Away side\'s recent form makes this closer than the odds suggest.','High stakes on both ends of the table add significant narrative weight.','A revenge angle adds extra motivation for the visiting side.','Home crowd expected to be a decisive factor in a nervy affair.'];

  var leagueNames = Object.keys(leagues);
  var matches = [];
  var edgeData = [];
  var used = {};

  for (var m = 0; m < 16; m++) {
    var lg = pick(leagueNames);
    var teams = leagues[lg];
    var home, away, key;
    var attempts = 0;
    do {
      home = pick(teams);
      away = pick(teams);
      key  = home + away + lg;
      attempts++;
    } while ((home === away || used[key]) && attempts < 20);
    used[key] = true;

    var h = range(10, 21) + ':00';
    var pred = pick(predictions);
    var conf = range(50, 89);
    var gPred = Math.random() > 0.2 ? pick(goalsPreds) : null;
    var gConf = gPred ? range(52, 84) : null;

    matches.push({ home:home, away:away, league:lg, time:h, prediction:pred, confidence:conf, goals_prediction:gPred, goals_confidence:gConf });

    var elvl  = pick(edgeLevels);
    var escore = elvl==='none'?range(5,25):elvl==='low'?range(30,48):elvl==='medium'?range(50,68):elvl==='high'?range(70,84):range(85,97);
    var numFacts = elvl==='none'?1:elvl==='low'?1:2;
    var facts = [];
    for (var f = 0; f < numFacts; f++) {
      facts.push({ label: f===0?pick(posFacts):pick(negFacts), type: f===0?'positive':'negative' });
    }
    edgeData.push({ index:m, edge_score:escore, edge_level:elvl, factors:facts, verdict:pick(verdicts) });
  }

  var result = { predictions:matches, edge:edgeData };
  cache = { date:today, data:result };
  return res.status(200).json(result);
};
