// api/cron.js — Midnight UTC cache warmup
// Runs at 00:00 UTC daily via Vercel Cron
// Warms predict (all leagues) and oracle (yesterday's scores)

module.exports = async function handler(req, res) {
  var secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret) {
    return res.status(401).end();
  }
  var now   = new Date();
  var today = now.toISOString().slice(0, 10);
  var base  = process.env.VERCEL_URL
    ? 'https://' + process.env.VERCEL_URL
    : 'https://freshsai.vercel.app';

  var results = {};

  // Warm predictions (fetches all 51 leagues, caches 6hrs)
  try {
    var r1 = await fetch(base + '/api/predict?date=' + today);
    var d1 = await r1.json();
    results.predict = { ok: r1.ok, fixtures: d1.predictions ? d1.predictions.length : 0, leagues: d1.total_events };
  } catch(e) { results.predict = { ok:false, error:e.message }; }

  // Warm yesterday's oracle (scores are final)
  try {
    var yest = new Date(today+'T12:00:00Z'); yest.setUTCDate(yest.getUTCDate()-1);
    var r2 = await fetch(base + '/api/oracle?date=' + yest.toISOString().slice(0,10));
    var d2 = await r2.json();
    results.oracle = { ok: r2.ok, finished: d2.finished, accuracy: d2.accuracy_pct };
  } catch(e) { results.oracle = { ok:false, error:e.message }; }

  return res.status(200).json({ ok:true, ran_at:now.toISOString(), results });
};
