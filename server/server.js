const http = require('http');

const KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.MODEL || 'openai/gpt-oss-120b';
const MAX_LINES = 150, MAX_CHARS = 8000;
const PER_IP_HOURLY = 30, GLOBAL_DAILY = 2000;

const ipHits = new Map();
let day = { date: '', count: 0 };

function over(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (day.date !== today) day = { date: today, count: 0 };
  if (++day.count > GLOBAL_DAILY) return true;
  const now = Date.now();
  const h = ipHits.get(ip);
  if (!h || now > h.reset) { ipHits.set(ip, { n: 1, reset: now + 3600e3 }); return false; }
  return ++h.n > PER_IP_HOURLY;
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > 20000) throw new Error('too big');
  }
  return JSON.parse(raw);
}

const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 100) : '');

function buildPrompt(title, artist, lines) {
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  return (
    `You are helping someone follow along with a song${title ? `: "${title}"` : ''}${artist ? ` by ${artist}` : ''}.\n` +
    'The lyrics below are one line per item. They are probably Hindi, Urdu or Punjabi, written in Urdu or Devanagari script, or romanized Hinglish, or already English.\n\n' +
    'For each line return:\n' +
    '- "r": the line romanized in simple chat-style Latin letters (like Hinglish typed on a phone). Only when the line is in a non-Latin script; otherwise "".\n' +
    '- "t": a natural English translation of the meaning: plain and poetic, not word for word. If the line is already English, return it unchanged.\n\n' +
    'Use the whole song for context so pronouns, metaphors and repeated phrases stay consistent. One output item per input line: never merge, split or skip lines.\n' +
    `Reply with ONLY a JSON array of exactly ${lines.length} objects like [{"r":"...","t":"..."}], in the same order as the input.\n\n` +
    'Lyrics:\n' + numbered
  );
}

async function callGroq(prompt) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], ...(MODEL.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return (await r.json()).choices[0].message.content;
}

function parseResult(content, n) {
  const start = content.indexOf('['), end = content.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('no json array');
  const arr = JSON.parse(content.slice(start, end + 1));
  if (!Array.isArray(arr) || arr.length !== n) throw new Error('wrong item count');
  return arr.map((o) => ({
    r: o && typeof o.r === 'string' ? o.r.trim() : '',
    t: o && typeof o.t === 'string' ? o.t.trim() : '',
  }));
}

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/translate') return send(res, 404, { error: 'not found' });
  if (!KEY) return send(res, 500, { error: 'server not configured' });

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  if (over(ip)) return send(res, 429, { error: 'rate limited' });

  try {
    const body = await readJson(req);
    const { lines } = body;
    if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES ||
        lines.some((l) => typeof l !== 'string') || lines.join('').length > MAX_CHARS) {
      return send(res, 400, { error: 'bad input' });
    }
    const title = clean(body.title), artist = clean(body.artist);
    const CHUNK = 25;
    const chunks = [];
    for (let i = 0; i < lines.length; i += CHUNK) chunks.push(lines.slice(i, i + CHUNK));

    const translateChunk = async (chunk) => {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return parseResult(await callGroq(buildPrompt(title, artist, chunk)), chunk.length); }
        catch (e) { lastErr = e; }
      }
      console.error('[translate] chunk failed:', lastErr && lastErr.message);
      return chunk.map(() => ({ r: '', t: '' })); // blank for this chunk only
    };

    const result = (await Promise.all(chunks.map(translateChunk))).flat();
    if (result.every((x) => !x.t)) return send(res, 502, { error: 'translation failed' });
    send(res, 200, { translations: result.map((x) => x.t), romanized: result.map((x) => x.r) });
  } catch (e) {
    send(res, 400, { error: 'bad request' });
  }
}).listen(process.env.PORT || 3000);
