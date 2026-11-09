const MAX_LINES = 150, MAX_CHARS = 8000, CHUNK = 25;
const PER_IP_HOURLY = 30;

// Best-effort limiter: lives in one Worker instance's memory and can reset.
const ipHits = new Map();
function limited(ip) {
  const now = Date.now();
  const h = ipHits.get(ip);
  if (!h || now > h.reset) {
    if (ipHits.size > 5000) ipHits.clear();
    ipHits.set(ip, { n: 1, reset: now + 3600e3 });
    return false;
  }
  return ++h.n > PER_IP_HOURLY;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 100) : '');

function buildPrompt(title, artist, lines) {
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  return (
    `You are helping someone follow along with a song${title ? `: "${title}"` : ''}${artist ? ` by ${artist}` : ''}.\n` +
    'The lyrics below are one line per item. They can be in ANY language or script (for example Hindi, Urdu, Punjabi in Gurmukhi or Shahmukhi, Bengali, Tamil, Spanish, Korean, Japanese, Chinese, Arabic, Russian), romanized, mixed, or already English.\n\n' +
    'For each line return:\n' +
    '- "r": a romanized version in Latin letters, ONLY when the line is written in a non-Latin script. Keep it simple and readable, the way a native speaker would type it on a phone (Hinglish style for Hindi, Urdu and Punjabi; pinyin for Chinese; romaji for Japanese; standard romanization for Korean and others). If the line is already in Latin letters, use "".\n' +
    '- "t": a natural English translation of the meaning: plain and poetic, not word for word. If the line is already English, return it unchanged.\n\n' +
    'Lines in Latin letters can still be another language (Spanish, French, Portuguese, romanized Punjabi, Hinglish and so on), so translate those into English too. Use the whole song for context so pronouns, metaphors and repeated phrases stay consistent. One output item per input line: never merge, split or skip lines.\n' +
    `Reply with ONLY a JSON array of exactly ${lines.length} objects like [{"r":"...","t":"..."}], in the same order as the input.\n\n` +
    'Lyrics:\n' + numbered
  );
}

async function callGroq(env, prompt) {
  const model = env.MODEL || 'openai/gpt-oss-120b';
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
    }),
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true });
    if (request.method !== 'POST' || url.pathname !== '/translate') return json({ error: 'not found' }, 404);
    if (!env.GROQ_API_KEY) return json({ error: 'server not configured' }, 500);

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (limited(ip)) return json({ error: 'rate limited' }, 429);

    let body;
    try {
      const raw = await request.text();
      if (raw.length > 20000) return json({ error: 'too big' }, 413);
      body = JSON.parse(raw);
    } catch (e) {
      return json({ error: 'bad request' }, 400);
    }

    const { lines } = body || {};
    if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES ||
        lines.some((l) => typeof l !== 'string') || lines.join('').length > MAX_CHARS) {
      return json({ error: 'bad input' }, 400);
    }

    const title = clean(body.title), artist = clean(body.artist);
    const chunks = [];
    for (let i = 0; i < lines.length; i += CHUNK) chunks.push(lines.slice(i, i + CHUNK));

    const translateChunk = async (chunk) => {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return parseResult(await callGroq(env, buildPrompt(title, artist, chunk)), chunk.length); }
        catch (e) { lastErr = e; }
      }
      console.error('chunk failed:', lastErr && lastErr.message);
      return chunk.map(() => ({ r: '', t: '' }));
    };

    const result = (await Promise.all(chunks.map(translateChunk))).flat();
    if (result.every((x) => !x.t)) return json({ error: 'translation failed' }, 502);
    return json({ translations: result.map((x) => x.t), romanized: result.map((x) => x.r) });
  },
};
