// api/cron.js — Midnight UTC auto-warmup
// Runs at 00:00 UTC daily via Vercel Cron (vercel.json)
// Pre-fetches today's BetMiner data so first user gets instant results
// Also adds CRON_SECRET to Vercel env vars for security (any random string)

module.exports = async function handler(req, res) {
  // Secure the endpoint
  var secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var today = new Date().toISOString().slice(0, 10);
  var results = { date: today, predict: null, oracle: null };

  // Determine base URL
  var base = process.env.VERCEL_URL
    ? 'https://' + process.env.VERCEL_URL
    : 'https://freshsai.vercel.app';

  // 1. Warm up today's predictions (uses BetMiner)
  try {
    var r1 = await fetch(base + '/api/predict?date=' + today);
    var d1 = await r1.json();
    results.predict = {
      ok: r1.status === 200,
      fixtures: d1.predictions ? d1.predictions.length : 0,
      date: d1.date
    };
  } catch(e) {
    results.predict = { ok: false, error: e.message };
  }

  // 2. Warm up yesterday's Oracle (scores are final by midnight)
  try {
    var yest = new Date(today + 'T12:00:00Z');
    yest.setUTCDate(yest.getUTCDate() - 1);
    var yestStr = yest.toISOString().slice(0, 10);
    var r2 = await fetch(base + '/api/oracle?date=' + yestStr);
    var d2 = await r2.json();
    results.oracle = {
      ok: r2.status === 200,
      date: yestStr,
      finished: d2.finished || 0,
      accuracy: d2.accuracy_pct
    };
  } catch(e) {
    results.oracle = { ok: false, error: e.message };
  }

  return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), results });
};
