const { app, BrowserWindow, screen, nativeImage, nativeTheme, Tray, Menu, shell } = require('electron');
const { globalShortcut } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const { getNowPlaying, looksLikeSong, trackCandidates, isMusicApp, stopWatching } = require('./media');
const fs = require('fs');
const process = require('process');

// Everything reported with console.error also goes to a log file (tray > Open log), since the
// installed app has no console. Started fresh on each launch.
const LOG_PATH = path.join(app.getPath('userData'), 'overlay.log');
try { fs.writeFileSync(LOG_PATH, `started ${new Date().toISOString()} v${app.getVersion()} ${process.platform}\n`); } catch (e) { }
const consoleError = console.error;
console.error = (...args) => {
  consoleError(...args);
  try { fs.appendFileSync(LOG_PATH, `${new Date().toTimeString().slice(0, 8)} ${args.join(' ')}\n`); } catch (e) { }
};

const TRANSLATION_CACHE_PATH = path.join(app.getPath('userData'), 'translation-cache.json');
const TRANSLATE_URL = process.env.TRANSLATE_URL || 'https://lyric-overlay-api.kunaldangi.workers.dev/translate';
const POLL_INTERVAL_MS = 1000;
const TEXT_MODE = 'dark'; // 'auto' (follow macOS appearance) | 'light' text | 'dark' text
const LYRICS_SCRIPT = path.join(__dirname, 'fetch_lyrics.py');

// Windows: keep GPU rendering on. Chromium only draws a see-through window there through
// DirectComposition (GPU); software rendering paints the window gray. The black we saw with the
// GPU came from the window covering the whole monitor, which overlayBounds() now avoids.

// Only one overlay at a time: a second copy would draw the same lyrics on top of the first
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win;
let pollTimer;
let currentVideoId = null;
const retriedTracks = new Set();
// ponytail: unbounded, fine for one listening session; cap it (drop oldest) if memory ever matters
const lyricsCache = new Map(); // track id -> lines (translated once available)

const OFFSETS_PATH = path.join(app.getPath('userData'), 'sync-offsets.json');
let syncOffsets = {};
try { syncOffsets = JSON.parse(fs.readFileSync(OFFSETS_PATH, 'utf8')); } catch (e) { }

function nudgeSync(delta) {
  if (!currentVideoId) return;
  const next = delta === 0 ? 0 : Math.round(((syncOffsets[currentVideoId] || 0) + delta) * 100) / 100;
  if (next === 0) delete syncOffsets[currentVideoId]; else syncOffsets[currentVideoId] = next;
  try { fs.writeFileSync(OFFSETS_PATH, JSON.stringify(syncOffsets)); } catch (e) { console.error('[sync] save failed:', e.message); }
  if (win) win.webContents.send('offset', next);
}
let fetchGeneration = 0;

// Windows treats a borderless window exactly the size of the monitor as a full-screen app and
// stops drawing what's behind it (gray/black instead of the wallpaper). Stopping at the taskbar,
// and 1px short in case the taskbar auto-hides, keeps it an ordinary see-through window.
function overlayBounds() {
  const d = screen.getPrimaryDisplay();
  if (process.platform !== 'win32') return d.bounds;
  return { ...d.workArea, height: d.workArea.height - 1 };
}

function createWindow() {
  const { x, y, width, height } = overlayBounds();

  win = new BrowserWindow({
    x,
    y,
    width,
    height,
    type: process.platform === 'darwin' ? 'desktop' : 'toolbar',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000', // fully transparent, so nothing paints black before the page loads
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setIgnoreMouseEvents(true); // click-through
  win.loadFile('index.html');
  win.webContents.on('did-finish-load', () => {
    if (lastPalette) win.webContents.send('palette', lastPalette);
  });
}

// --- Lyrics lookup --------------------------------------------------------

function parseLRC(lrc) {
  const lines = [];
  const timeTagRe = /\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  lrc.split('\n').forEach((raw) => {
    const matches = [...raw.matchAll(timeTagRe)];
    if (matches.length === 0) return;
    const text = raw.replace(timeTagRe, '').trim();
    matches.forEach((m) => {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const ms = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
      lines.push({ time: min * 60 + sec + ms / 1000, text });
    });
  });
  lines.sort((a, b) => a.time - b.time);
  return lines.filter((l) => l.text);
}

function fetchLyricsPython(track) {
  return new Promise((resolve) => {
    const pythonBin = process.env.LYRICS_PYTHON_BIN || 'python3';
    execFile(
      pythonBin,
      [LYRICS_SCRIPT, track.artist || '', track.name || ''],
      { timeout: 45000 },
      (err, stdout, stderr) => {
        if (err) {
          console.error('[lyrics] lookup failed to run:', err.message);
          resolve(null);
          return;
        }
        if (stderr && stderr.trim()) {
          console.error('[lyrics]', stderr.trim());
        }
        const out = stdout.trim();
        if (!out || out === 'NONE') {
          resolve(null);
          return;
        }
        const parsed = parseLRC(out);
        resolve(parsed.length > 0 ? parsed : null);
      }
    );
  });
}

// --- Lyrics via LRCLIB (pure Node, works inside a packaged app) ---------

const LRCLIB_UA = 'lyrics-overlay (https://github.com/kunal-dangi/lyrics-overlayy)';
const PYTHON_FALLBACK = !__dirname.includes('.asar');

function lyricQueries(track) {
  const title = (track.name || '').trim();
  const artist = (track.artist || '').trim();
  const cleanTitle =
    title.replace(/\s*[(\[][^)\]]*[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim() || title;
  const firstArtist = artist.split(/,|&| feat\.? | ft\.? /i)[0].trim();
  const seen = new Set();
  return [[cleanTitle, firstArtist], [title, artist]].filter(([t, a]) => {
    const k = `${t}|${a}`.toLowerCase();
    if (!t || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const DURATION_TOLERANCE = 3;

const norm = (s) =>
  String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

function sameSong(r, track) {
  const rt = norm(r.trackName), ra = norm(r.artistName);
  const queries = lyricQueries(track);
  const titleOk = !!rt && queries.some(([t]) => { const n = norm(t); return n && (rt.includes(n) || n.includes(rt)); });
  const firstArtist = queries[0] ? norm(queries[0][1]) : '';
  const fullArtist = norm(track.artist);
  const artistOk = !fullArtist || (!!ra && (
    (firstArtist && (ra.includes(firstArtist) || firstArtist.includes(ra))) ||
    fullArtist.includes(ra) || ra.includes(fullArtist)
  ));
  return titleOk && artistOk;
}

async function lrclibSearch(params, duration, track) {
  const resp = await fetch('https://lrclib.net/api/search?' + new URLSearchParams(params), {
    headers: { 'User-Agent': LRCLIB_UA },
    signal: AbortSignal.timeout(10000),
  });
  if (resp.status >= 500) throw new Error('LRCLIB ' + resp.status);
  if (!resp.ok) return null;
  const results = await resp.json();
  if (!Array.isArray(results)) return null;
  const synced = results.filter(
    (r) => r && typeof r.syncedLyrics === 'string' && r.syncedLyrics.trim() && sameSong(r, track)
  );
  if (synced.length === 0) return null;
  if (!duration) {
    // no length to check against (Firefox doesn't report it): the title has to match exactly
    const titles = lyricQueries(track).map(([t]) => norm(t));
    const exact = synced.find((r) => titles.includes(norm(r.trackName)));
    return exact ? exact.syncedLyrics : null;
  }
  synced.sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration));
  return Math.abs(synced[0].duration - duration) <= DURATION_TOLERANCE ? synced[0].syncedLyrics : null;
}

async function fetchLyrics(track, duration, allowFallback) {
  const queries = lyricQueries(track).map(([t, a]) => ({ track_name: t, artist_name: a }));
  if (queries[0]) queries.push({ q: `${queries[0].track_name} ${queries[0].artist_name}`.trim() });
  for (const params of queries) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const lrc = await lrclibSearch(params, duration, track);
        const parsed = lrc ? parseLRC(lrc) : [];
        if (parsed.length > 0) return parsed;
        break;
      } catch (e) {
        console.error('[lyrics] lrclib lookup failed:', e.message);
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  }
  // syncedlyrics returns its best guess without checking it's the same song, so only trust it when a
  // music app gave us an exact title, artist and length to check it against
  if (!PYTHON_FALLBACK || !allowFallback || !duration) return null;
  const py = await fetchLyricsPython(track);
  if (py && duration && py[py.length - 1].time > duration + 3) return null;
  return py;
}

function loadTranslationCache() {
  try {
    return JSON.parse(fs.readFileSync(TRANSLATION_CACHE_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveTranslationCache(cache) {
  try {
    fs.writeFileSync(TRANSLATION_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('[translate] failed to save cache:', e.message);
  }
}

async function translateLines(lines, track) {
  const cacheKey = 'v3:' + (track.videoId || `${track.artist}::${track.name}`);
  const cache = loadTranslationCache();
  const apply = (tr, ro) => lines.map((l, i) => ({ ...l, translated: tr[i] || '', romanized: ro[i] || '' }));
  const hit = cache[cacheKey];
  if (hit) return apply(hit.translations, hit.romanized);
  try {
    const resp = await fetch(TRANSLATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: track.name, artist: track.artist, lines: lines.map((l) => l.text) }),
      signal: AbortSignal.timeout(45000),
    });
    if (!resp.ok) throw new Error(`translate server returned ${resp.status}`);
    const { translations, romanized } = await resp.json();
    if (translations.every(Boolean)) {
      cache[cacheKey] = { translations, romanized };
      saveTranslationCache(cache);
    }
    return apply(translations, romanized);
  } catch (e) {
    console.error('[translate] failed:', e.message);
    return lines;
  }
}

// --- Colors from the album art -----------------------------------------

let lastPalette = null;

function rgbToHue(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

async function setPaletteFromArtwork(url) {
  let hue = null;
  if (url && (url.startsWith('https://') || url.startsWith('data:'))) {
    try {
      let img;
      if (url.startsWith('data:')) img = nativeImage.createFromDataURL(url);
      else {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        img = nativeImage.createFromBuffer(Buffer.from(await resp.arrayBuffer()));
      }
      if (!img.isEmpty()) {
        const buf = img.resize({ width: 32, height: 32 }).toBitmap(); // BGRA
        const bins = new Array(12).fill(0);
        let total = 0;
        for (let i = 0; i < buf.length; i += 4) {
          const b = buf[i], g = buf[i + 1], r = buf[i + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          if (max < 40) continue;
          const sat = (max - min) / max;
          if (sat < 0.2) continue;
          const w = sat * (max / 255);
          bins[Math.floor(rgbToHue(r, g, b) / 30) % 12] += w;
          total += w;
        }
        if (total > 20) hue = bins.indexOf(Math.max(...bins)) * 30 + 15;
      }
    } catch (e) {
      console.error('[palette] artwork failed:', e.message);
    }
  }

  const lightText = TEXT_MODE === 'auto' ? nativeTheme.shouldUseDarkColors : TEXT_MODE === 'light';
  const h = hue === null ? 220 : hue;
  const s = hue === null ? 10 : 65;
  lastPalette = lightText
    ? { ink: `hsl(${h}, ${s}%, 92%)`, box: `hsl(${h}, ${s}%, 88%)`, boxInk: `hsl(${h}, ${s}%, 14%)`, glow: 'rgba(0,0,0,0.35)' }
    : { ink: `hsl(${h}, ${s}%, 14%)`, box: `hsl(${h}, ${s}%, 24%)`, boxInk: '#fff', glow: 'rgba(255,255,255,0.35)' };
  if (win) win.webContents.send('palette', lastPalette);
}

// --- Poll loop -------------------------------------------------------------

// first candidate with lyrics wins (browser tabs give a few guesses at artist and song)
async function findLyrics(candidates, duration, allowFallback) {
  for (const c of candidates) {
    const lyrics = await fetchLyrics(c, duration, allowFallback);
    if (lyrics) return lyrics;
  }
  return null;
}

let lastSeen = '';

async function pollLoop() {
  let m;
  try {
    m = await getNowPlaying();
  } catch (e) {
    m = null;
  }

  // nothing playing, or a film / show / video rather than a song
  const candidates = looksLikeSong(m) ? trackCandidates(m) : [];
  const seen = m ? `${m.title} / ${m.artist} (${m.app}) ${Math.round(m.duration)}s ${m.isPlaying ? 'playing' : 'paused'}` : 'nothing playing';
  if (seen !== lastSeen) {
    lastSeen = seen;
    console.error('[media]', seen, m && candidates.length === 0 ? '-> skipped, not a song' : '');
  }
  if (candidates.length === 0) {
    if (win.isVisible()) win.hide();
    currentVideoId = null;
    return;
  }

  const track = { ...candidates[0], videoId: m.id, artwork: m.artwork };
  const info = { isPlaying: m.isPlaying, position: m.position, duration: m.duration };

  if (track.videoId !== currentVideoId) {
    currentVideoId = track.videoId;
    win.webContents.send('offset', syncOffsets[currentVideoId] || 0);
    setPaletteFromArtwork(track.artwork);
    const myGeneration = ++fetchGeneration;
    const cached = lyricsCache.get(track.videoId);

    // on a cache hit the renderer keeps its current lines, so resuming a song keeps its look
    if (!cached) win.webContents.send('lyrics', null);
    win.webContents.send('track', {
      track,
      isPlaying: info.isPlaying,
      position: info.position,
      duration: info.duration,
    });

    const lyrics = cached || await findLyrics(candidates, info.duration, isMusicApp(m));

    if (myGeneration !== fetchGeneration) return;
    console.error(`[lyrics] ${m.title} / ${m.artist} (${m.app}): ${lyrics ? lyrics.length + ' lines' : 'none found'}`);

    if (!lyrics) {
      win.webContents.send('lyrics', null);
      if (!retriedTracks.has(track.videoId)) {
        retriedTracks.add(track.videoId);
        setTimeout(() => { if (currentVideoId === track.videoId) currentVideoId = null; }, 6000);
      }
      return;
    }

    lyricsCache.set(track.videoId, lyrics);
    win.webContents.send('lyrics', lyrics);
    // ponytail: on Windows this is a normal window, so it starts above others until you click something.
    // True desktop level there needs parenting to the WorkerW desktop window (native code, untested).
    if (!win.isVisible()) { win.showInactive(); console.error('[window] shown at', JSON.stringify(win.getBounds())); }
    translateLines(lyrics, track).then((translated) => {
      if (translated !== lyrics) lyricsCache.set(track.videoId, translated);
      if (myGeneration === fetchGeneration) win.webContents.send('lyrics', translated);
    });
  } else {
    win.webContents.send('track', {
      track,
      isPlaying: info.isPlaying,
      position: info.position,
      duration: info.duration,
    });
  }
}

// --- Tray: the only way to quit, since the window is click-through and off the taskbar ---

let tray; // kept global so it isn't garbage collected

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('Lyrics Overlay');
  const items = [];
  if (app.isPackaged) {
    items.push({
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    });
  }
  items.push({ label: 'Open log', click: () => shell.openPath(LOG_PATH) });
  items.push({ label: 'Quit Lyrics Overlay', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  if (process.platform === 'darwin') app.dock.hide(); // the tray replaces the dock icon
}

// --- App lifecycle ----------------------------------------------------------

app.whenReady().then(() => {
  if (!gotLock) return;
  // installed app (.exe / .dmg): start at login; source installs use the macOS LaunchAgent instead
  // only on first run, so turning it off from the tray sticks
  const loginMarker = path.join(app.getPath('userData'), 'login-item-set');
  if (app.isPackaged && !fs.existsSync(loginMarker)) {
    app.setLoginItemSettings({ openAtLogin: true });
    try { fs.writeFileSync(loginMarker, ''); } catch (e) { }
  }
  createWindow();
  createTray();
  // follow resolution changes and monitors being plugged in or out
  const fitToDisplay = () => win.setBounds(overlayBounds());
  ['display-metrics-changed', 'display-added', 'display-removed'].forEach((e) => screen.on(e, fitToDisplay));
  globalShortcut.register('Control+Alt+.', () => nudgeSync(0.5));
  globalShortcut.register('Control+Alt+,', () => nudgeSync(-0.5));
  globalShortcut.register('Control+Alt+/', () => nudgeSync(0));
  fetch(TRANSLATE_URL.replace('/translate', '/health')).catch(() => { });
  pollLoop();
  pollTimer = setInterval(pollLoop, POLL_INTERVAL_MS);
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); stopWatching(); });

app.on('window-all-closed', () => {
  clearInterval(pollTimer);
  app.quit();
});