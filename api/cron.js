// api/cron.js — Midnight UTC auto-scan
// Triggered by Vercel Cron at 00:00 UTC daily
// Pre-warms the prediction cache so first user of the day gets instant results

module.exports = async function handler(req, res) {
  // Vercel cron sends Authorization header
  if (req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var today = new Date().toISOString().slice(0, 10);

  try {
    // Hit our own predict endpoint to warm the cache
    var base = process.env.VERCEL_URL
      ? 'https://' + process.env.VERCEL_URL
      : 'http://localhost:3000';

    var r = await fetch(base + '/api/predict?date=' + today, {
      headers: { 'x-cron-warmup': '1' }
    });
    var d = await r.json();
    return res.status(200).json({
      ok: true, date: today,
      fixtures: d.predictions ? d.predictions.length : 0
    });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
