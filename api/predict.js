var cache = { date: null, data: null };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var today = new Date().toISOString().slice(0, 10);
  if (cache.date === today && cache.data) {
    return res.status(200).json(cache.data);
  }

  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set in Vercel environment variables.' });
  }

  var now = new Date();
  var dateStr = now.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  try {
    var r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text:
            'You are a football analyst. Today is ' + dateStr + '.\n\n' +
            'Generate 16 football match predictions for today across Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Championship, Champions League, Europa League.\n\n' +
            'Also add narrative edge analysis per match.\n\n' +
            'Return ONLY raw JSON, starting with { — no markdown, no explanation:\n\n' +
            '{"predictions":[{"home":"Arsenal","away":"Chelsea","league":"Premier League","time":"15:00","prediction":"Home Win","confidence":72,"goals_prediction":"Over 2.5 Goals","goals_confidence":65}],' +
            '"edge":[{"index":0,"edge_score":65,"edge_level":"medium","factors":[{"label":"Derby atmosphere","type":"positive"}],"verdict":"Rivalry boosts home motivation."}]}\n\n' +
            'prediction values: Home Win, Away Win, Draw, Both Teams to Score, Home Win or Draw, Away Win or Draw\n' +
            'confidence: 48-91\n' +
            'goals_prediction: Over 2.5 Goals, Under 2.5 Goals, Over 1.5 Goals, BTTS Yes, BTTS No, or null\n' +
            'edge_level: none low medium high elite\n' +
            'factor type: positive negative neutral\n' +
            'Return ONLY the JSON.'
          }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 4096 }
        })
      }
    );

    var d = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: (d.error && d.error.message) || 'Gemini error ' + r.status });
    }

    var text = ((d.candidates||[])[0]||{}).content;
    text = text && text.parts ? text.parts.map(function(p){return p.text||'';}).join('') : '';
    if (!text) return res.status(502).json({ error: 'Empty Gemini response' });

    var clean = text.replace(/```json/gi,'').replace(/```/g,'').trim();
    var s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    var result = JSON.parse(clean.slice(s, e+1));

    if (!result.predictions || !result.predictions.length) {
      return res.status(502).json({ error: 'No predictions in response' });
    }

    cache = { date: today, data: result };
    return res.status(200).json(result);

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
