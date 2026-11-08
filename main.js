const { app, BrowserWindow, ipcMain, screen, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const { exec, execFile } = require('child_process');
const fs = require('fs');
const TRANSLATION_CACHE_PATH = path.join(__dirname, 'translation-cache.json');
const TRANSLATE_URL = process.env.TRANSLATE_URL || 'https://YOUR-SERVICE.onrender.com/translate';
const POLL_INTERVAL_MS = 1000;
const TEXT_MODE = 'dark'; // 'auto' (follow macOS appearance) | 'light' text | 'dark' text
const LYRICS_SCRIPT = path.join(__dirname, 'fetch_lyrics.py');
console.log('[diag] fetch is:', typeof fetch);

// Only one overlay at a time: a second copy would draw the same lyrics on top of the first
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win;
let pollTimer;
let currentVideoId = null;
let fetchGeneration = 0; // guards against a slow lookup overwriting a newer track

function createWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;

  win = new BrowserWindow({
    x, y, width, height,
    type: 'desktop', // macOS: wallpaper level, below icons and all windows
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false, // stays hidden until a track with synced lyrics is confirmed
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

// --- Spotify AppleScript bridge -------------------------------------------

const SPOTIFY_SCRIPT = `
if application "Spotify" is running then
  tell application "Spotify"
    if player state is stopped then return "stopped"
    set art to ""
    try
      set art to artwork url of current track
    end try
    return (id of current track) & "||" & (name of current track) & "||" & (artist of current track) & "||" & (player position as string) & "||" & (duration of current track as string) & "||" & (player state as string) & "||" & art
  end tell
else
  return "closed"
end if
`;

function getPlayerInfo() {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', SPOTIFY_SCRIPT], { timeout: 3000 }, (err, stdout) => {
      if (err) return reject(err);
      const out = stdout.trim();
      if (!out || out === 'closed' || out === 'stopped') return reject(new Error('not playing'));
      const [id, name, artist, pos, dur, state, art] = out.split('||');
      resolve({
        currentTrack: { videoId: id, name, artist, artwork: art },
        isPlaying: state === 'playing',
        position: parseFloat(pos.replace(',', '.')),
        duration: parseFloat(dur.replace(',', '.')) / 1000, // Spotify gives ms
      });
    });
  });
}

// --- Lyrics lookup (Python / syncedlyrics: Musixmatch, NetEase, Lrclib, ---
// --- Deezer, Megalobiz, Genius, Lyricsify — tried in turn) ----------------

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
  return lines.filter((l) => l.text); // drop blank timing-only lines
}

function fetchLyrics(track) {
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
  const cacheKey = 'v2:' + (track.videoId || `${track.artist}::${track.name}`);
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
    return lines; // lyrics still show, just without translations
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
  if (url && url.startsWith('https://')) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const img = nativeImage.createFromBuffer(Buffer.from(await resp.arrayBuffer()));
      if (!img.isEmpty()) {
        const buf = img.resize({ width: 32, height: 32 }).toBitmap(); // BGRA
        const bins = new Array(12).fill(0);
        let total = 0;
        for (let i = 0; i < buf.length; i += 4) {
          const b = buf[i], g = buf[i + 1], r = buf[i + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          if (max < 40) continue;          // skip near-black
          const sat = (max - min) / max;
          if (sat < 0.2) continue;         // skip greys and white
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
  const s = hue === null ? 10 : 65; // greyscale cover -> near-neutral colors
  lastPalette = lightText
    ? { ink: `hsl(${h}, ${s}%, 92%)`, box: `hsl(${h}, ${s}%, 88%)`, boxInk: `hsl(${h}, ${s}%, 14%)`, glow: 'rgba(0,0,0,0.35)' }
    : { ink: `hsl(${h}, ${s}%, 14%)`, box: `hsl(${h}, ${s}%, 24%)`, boxInk: '#fff', glow: 'rgba(255,255,255,0.35)' };
  if (win) win.webContents.send('palette', lastPalette);
}

// --- Poll loop -------------------------------------------------------------

async function pollLoop() {
  let info;
  try {
    info = await getPlayerInfo();
  } catch (e) {
    // Spotify not running, or nothing loaded yet
    if (win.isVisible()) win.hide();
    currentVideoId = null;
    return;
  }

  const track = info.currentTrack;

  if (!track) {
    if (win.isVisible()) win.hide();
    currentVideoId = null;
    return;
  }

  if (track.videoId !== currentVideoId) {
    currentVideoId = track.videoId;
    setPaletteFromArtwork(track.artwork);
    const myGeneration = ++fetchGeneration;

    win.hide(); // stay out of the way while we look the new track up
    win.webContents.send('track', {
      track,
      isPlaying: info.isPlaying,
      position: info.position,
      duration: info.duration,
    });

    const lyrics = await fetchLyrics(track);

    if (myGeneration !== fetchGeneration) return; // a newer track started meanwhile

    if (!lyrics) {
      win.webContents.send('lyrics', null);
      return; // no synced lyrics — leave the window hidden entirely
    }

    win.webContents.send('lyrics', lyrics);
    win.showInactive(); // show right away; translations follow in the background
    translateLines(lyrics, track).then((translated) => {
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

// --- App lifecycle ----------------------------------------------------------

app.whenReady().then(() => {
  if (!gotLock) return;
  createWindow();
  fetch(TRANSLATE_URL.replace('/translate', '/health')).catch(() => {}); // wake the free Render instance
  pollLoop();
  pollTimer = setInterval(pollLoop, POLL_INTERVAL_MS);
});

app.on('window-all-closed', () => {
  clearInterval(pollTimer);
  app.quit();
});

ipcMain.on('close-app', () => app.quit());
