var cache = { date: null, data: null };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var today = new Date().toISOString().slice(0, 10);
  if (cache.date === today && cache.data) {
    return res.status(200).json(cache.data);
  }

  var apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY not set in Vercel environment variables.' });
  }

  var now     = new Date();
  var dateStr = now.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  var dow     = now.toLocaleDateString('en-GB', { weekday:'long' });

  try {
    var r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'HTTP-Referer':  'https://freshsai.vercel.app',
        'X-Title':       'ScoutAI'
      },
      body: JSON.stringify({
        model:       'mistralai/mistral-7b-instruct:free',
        temperature: 0.4,
        max_tokens:  4000,
        messages: [
          {
            role:    'system',
            content: 'You are a football prediction expert. Always respond with valid JSON only — no markdown, no explanation, no text before or after the JSON.'
          },
          {
            role: 'user',
            content:
              'Today is ' + dateStr + '.\n\n' +
              'Generate 16 football match predictions for ' + dow + ' fixtures across Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Championship, Champions League, Europa League, MLS.\n\n' +
              'Also add narrative edge analysis per match.\n\n' +
              'Respond with ONLY this JSON structure — start with { and end with }:\n\n' +
              '{"predictions":[{"home":"Arsenal","away":"Chelsea","league":"Premier League","time":"15:00","prediction":"Home Win","confidence":72,"goals_prediction":"Over 2.5 Goals","goals_confidence":65}],' +
              '"edge":[{"index":0,"edge_score":65,"edge_level":"medium","factors":[{"label":"London derby atmosphere","type":"positive"}],"verdict":"Derby pressure gives home side an edge."}]}\n\n' +
              'Rules:\n' +
              '- prediction: Home Win, Away Win, Draw, Both Teams to Score, Home Win or Draw, Away Win or Draw\n' +
              '- confidence: integer 48-91\n' +
              '- goals_prediction: Over 2.5 Goals, Under 2.5 Goals, Over 1.5 Goals, BTTS Yes, BTTS No, or null\n' +
              '- goals_confidence: integer or null\n' +
              '- edge_level: none(0-29) low(30-49) medium(50-69) high(70-84) elite(85-100)\n' +
              '- factor type: positive, negative, or neutral\n' +
              '- One edge entry per prediction, index is 0-based\n' +
              '- Use real current team names\n' +
              '- Return ONLY the JSON object'
          }
        ]
      })
    });

    var d = await r.json();

    if (!r.ok) {
      var msg = (d.error && (d.error.message || d.error)) || ('HTTP ' + r.status);
      return res.status(502).json({ error: 'OpenRouter error: ' + msg });
    }

    var text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!text) {
      return res.status(502).json({ error: 'Empty response from AI.' });
    }

    var clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    var s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    if (s === -1 || e === -1) {
      return res.status(502).json({ error: 'Could not parse JSON from response.', raw: text.slice(0, 300) });
    }

    var result = JSON.parse(clean.slice(s, e + 1));

    if (!result.predictions || !result.predictions.length) {
      return res.status(502).json({ error: 'No predictions found in response.', raw: text.slice(0, 300) });
    }

    cache = { date: today, data: result };
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
