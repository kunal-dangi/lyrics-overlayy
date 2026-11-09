const stage = document.getElementById('stage');

// --- Local state ------------------------------------------------------------

let playback = { isPlaying: false, position: 0, duration: 0, lastUpdateTs: Date.now() };
let lyricsLines = null; // [{time, text}] or null
let shownIndex = -1;    // which line is on screen (-1 = none)
let currentEl = null;

window.kaset.onTrack((data) => {
  playback.isPlaying = !!data.isPlaying;
  playback.position = typeof data.position === 'number' ? data.position : 0;
  playback.duration = typeof data.duration === 'number' ? data.duration : 0;
  playback.lastUpdateTs = Date.now();
  stage.classList.toggle('paused', !playback.isPlaying);
});

window.kaset.onLyrics((data) => {
  const next = data && data.length > 0 ? data : null;
  if (next && lyricsLines && next.length === lyricsLines.length && next[0].time === lyricsLines[0].time) {
    lyricsLines = next; // same song, translations just arrived
    shownIndex = -1;    // redraw the current line with the new text
    return;
  }
  lyricsLines = next;
  shownIndex = -1;
  if (currentEl) currentEl.remove();
  currentEl = null;
});

window.kaset.onPalette((p) => {
  const root = document.documentElement.style;
  root.setProperty('--ink', p.ink);
  root.setProperty('--box', p.box);
  root.setProperty('--box-ink', p.boxInk);
  root.setProperty('--glow', p.glow);
});

// Sync tuning: BASE_OFFSET covers polling + animation delay; syncOffset is the per-song nudge from main.js
const BASE_OFFSET = 0.25;
let syncOffset = 0;
window.kaset.onOffset((v) => {
  syncOffset = Number(v) || 0;
  shownIndex = -1; // redraw with the new timing
});

// --- Word layout: pick a hero word, size the rest around it -------------------

const SMALL = new Set((
  "a an the in on at to of and or but so if as is it its im i'm i'll i've my me you your youre you're " +
  "we he she they them his her our be was are am do dont don't can will for with that this from by up " +
  "no oh ooh yeah ya uh like just got get not too out all"
).split(' '));

function buildLine(text, translated) {
  const info = text.split(/\s+/).filter(Boolean).map((w) => {
    const k = w.toLowerCase().replace(/[^a-z0-9'’]/g, '');
    return { w, len: k.length, small: k.length <= 2 || SMALL.has(k) };
  });

  // Hero = longest content word (later one wins ties); it gets the box
  let hero = -1;
  info.forEach((o, i) => { if (!o.small && (hero < 0 || o.len >= info[hero].len)) hero = i; });
  if (hero < 0) info.forEach((o, i) => { if (hero < 0 || o.len >= info[hero].len) hero = i; });

  let second = -1;
  info.forEach((o, i) => {
    if (i !== hero && !o.small && o.len >= 5 && (second < 0 || o.len >= info[second].len)) second = i;
  });

  info.forEach((o, i) => { o.tier = i === hero ? 3 : i === second ? 2 : o.small ? 0 : 1; });

  // One word per row; on long lines, runs of small words share a row
  const rows = [];
  info.forEach((o) => {
    const last = rows[rows.length - 1];
    if (info.length > 7 && o.tier === 0 && last && last.tier === 0) last.text += ' ' + o.w;
    else rows.push({ text: o.w, tier: o.tier });
  });

  const line = document.createElement('div');
  line.className = 'line';
  const stack = document.createElement('div');
  stack.className = 'stack';
  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'row t' + r.tier;
    const w = document.createElement('span');
    w.className = 'w';
    w.textContent = r.text;
    w.style.transitionDelay = 130 + i * 55 + 'ms';
    row.appendChild(w);
    stack.appendChild(row);
  });
  if (translated && translated.trim().toLowerCase() !== text.trim().toLowerCase()) {
    const tr = document.createElement('div');
    tr.className = 'tr';
    tr.textContent = translated;
    tr.style.transitionDelay = 130 + rows.length * 55 + 'ms';
    stack.appendChild(tr);
  }
  line.appendChild(stack);
  return line;
}

// Shrink everything uniformly if the stack is too tall or too wide for the left third
function fit(line) {
  const stack = line.firstElementChild;
  line.style.setProperty('--fit', 1);
  const f = Math.min(
    1,
    (window.innerHeight * 0.78) / stack.offsetHeight,
    (window.innerWidth * 0.30) / stack.offsetWidth
  );
  line.style.setProperty('--fit', f.toFixed(3));
}

function showLine(text, translated) {
  const old = currentEl;
  const line = buildLine(text, translated);
  stage.appendChild(line);
  fit(line);
  requestAnimationFrame(() => requestAnimationFrame(() => line.classList.add('in')));
  if (old) retire(old);
  currentEl = line;
}

function retire(el) {
  el.classList.add('out');
  setTimeout(() => el.remove(), 260);
}

function hideLine() {
  if (currentEl) retire(currentEl);
  currentEl = null;
}

// --- Position interpolation + rendering ----------------------------------------

function estimatedPosition() {
  if (!playback.isPlaying) return playback.position;
  const elapsed = (Date.now() - playback.lastUpdateTs) / 1000;
  return Math.min(playback.position + elapsed, playback.duration || Infinity);
}

function findCurrentIndex(pos) {
  if (!lyricsLines) return -1;
  let idx = -1;
  for (let i = 0; i < lyricsLines.length; i++) {
    if (lyricsLines[i].time <= pos) idx = i;
    else break;
  }
  return idx;
}

function tick() {
  if (lyricsLines) {
    const pos = estimatedPosition() + BASE_OFFSET + syncOffset;
    let want = findCurrentIndex(pos);
    if (want >= 0) {
      // During long instrumental gaps, clear the line after 9s instead of leaving it stuck
      const next = lyricsLines[want + 1];
      const end = Math.min(next ? next.time : Infinity, lyricsLines[want].time + 9);
      if (pos >= end) want = -1;
    }
    if (want !== shownIndex) {
      shownIndex = want;
      if (want >= 0) showLine(lyricsLines[want].romanized || lyricsLines[want].text, lyricsLines[want].translated);
      else hideLine();
    }
  }
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
