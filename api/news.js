// api/news.js — Football news from free RSS feeds
// No API key needed. Cached 30 minutes.

var cache = { data: null, fetched: 0 };

var FEEDS = [
  { name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  { name: 'Sky Sports', url: 'https://www.skysports.com/rss/12040' },
  { name: 'The Guardian', url: 'https://www.theguardian.com/football/rss' },
  { name: 'ESPN FC', url: 'https://www.espn.com/espn/rss/soccer/news' }
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (cache.data && (Date.now() - cache.fetched) < 1800000) {
    return res.status(200).json(cache.data);
  }

  var allItems = [];

  await Promise.all(FEEDS.map(async function(feed) {
    try {
      var r = await fetch(feed.url, {
        headers: { 'User-Agent': 'ScoutAI/1.0 (news aggregator)' }
      });
      if (!r.ok) return;
      var xml = await r.text();

      // Parse RSS items
      var items = [];
      var itemRe = /<item>([\s\S]*?)<\/item>/g;
      var match;
      while ((match = itemRe.exec(xml)) !== null && items.length < 6) {
        var block = match[1];
        var title = extract(block, 'title');
        var link  = extract(block, 'link') || extract(block, 'guid');
        var pubDate = extract(block, 'pubDate');
        var desc = extract(block, 'description');
        if (!title || !link) continue;

        // Clean CDATA and HTML
        title = clean(title);
        desc  = clean(desc).slice(0, 120);
        if (desc.length === 120) desc += '…';

        var ts = pubDate ? new Date(pubDate).getTime() : 0;
        items.push({ title:title, link:link, desc:desc, source:feed.name, ts:ts });
      }
      allItems = allItems.concat(items);
    } catch(e) { /* skip failed feed */ }
  }));

  // Sort by date desc, deduplicate by title similarity, take top 20
  allItems.sort(function(a,b){ return b.ts - a.ts; });
  var seen = {};
  var deduped = allItems.filter(function(item) {
    var key = item.title.slice(0,30).toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  }).slice(0, 20);

  var result = { articles: deduped, fetched_at: new Date().toISOString() };
  cache = { data: result, fetched: Date.now() };
  return res.status(200).json(result);
};

function extract(xml, tag) {
  var re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  var m  = xml.match(re);
  return m ? m[1].trim() : '';
}
function clean(str) {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/\s+/g,' ').trim();
}
