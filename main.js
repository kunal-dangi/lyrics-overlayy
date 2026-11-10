const { app, BrowserWindow, ipcMain, screen, nativeImage, nativeTheme } = require('electron');
const { globalShortcut } = require('electron');
const path = require('path');
const { exec, execFile } = require('child_process');
const fs = require('fs');
const process = require('process');

const TRANSLATION_CACHE_PATH = path.join(app.getPath('userData'), 'translation-cache.json');
const TRANSLATE_URL = process.env.TRANSLATE_URL || 'https://lyric-overlay-api.kunaldangi.workers.dev/translate';
const POLL_INTERVAL_MS = 1000;
const TEXT_MODE = 'dark'; // 'auto' (follow macOS appearance) | 'light' text | 'dark' text
const LYRICS_SCRIPT = path.join(__dirname, 'fetch_lyrics.py');

// Only one overlay at a time: a second copy would draw the same lyrics on top of the first
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win;
let pollTimer;
let currentVideoId = null;
const retriedTracks = new Set();

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

function createWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;

  win = new BrowserWindow({
    x,
    y,
    width,
    height,
    type: process.platform === 'darwin' ? 'desktop' : 'toolbar',
    frame: false,
    transparent: true,
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

// --- Cross-Platform Media Bridge -------------------------------------------

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

// ponytail: Windows window titles carry no playback position, so we time the song from when we first
// see it (pauses subtracted). Wrong if the overlay starts mid-song; the real fix is the Windows media
// session API (GlobalSystemMediaTransportControls), which does report position.
let winClock = { id: null, start: 0, pausedAt: 0 };

function getPlayerInfo() {
  return new Promise((resolve, reject) => {

    // 🍎 macOS: AppleScript Integration
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e', SPOTIFY_SCRIPT], { timeout: 3000 }, (err, stdout) => {
        if (err) return reject(err);
        const out = stdout.trim();
        if (!out || out === 'closed' || out === 'stopped') return reject(new Error('not playing'));
        const [id, name, artist, pos, dur, state, art] = out.split('||');
        resolve({
          currentTrack: { videoId: id, name, artist, artwork: art },
          isPlaying: state === 'playing',
          position: parseFloat(pos.replace(',', '.')),
          duration: parseFloat(dur.replace(',', '.')) / 1000,
        });
      });
    }

    // 🪟 Windows: Zero-Dependency PowerShell Polling
    else if (process.platform === 'win32') {
      const psCommand = `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Name, MainWindowTitle | ConvertTo-Json -Compress`;

      exec(`powershell -NoProfile -Command "${psCommand}"`, { timeout: 3000 }, (error, stdout) => {
        if (error || !stdout) return reject(new Error('not playing'));

        try {
          const procs = JSON.parse(stdout.trim());
          const procList = Array.isArray(procs) ? procs : [procs];
          let title = '';
          let artist = '';

          // 1. Try Spotify App
          const spotify = procList.find(p => p.Name.toLowerCase() === 'spotify' && p.MainWindowTitle.includes(' - '));
          if (spotify && !spotify.MainWindowTitle.includes('Spotify Premium') && !spotify.MainWindowTitle.includes('Spotify Free')) {
            const parts = spotify.MainWindowTitle.split(' - ');
            artist = parts[0].trim();
            title = parts.slice(1).join(' - ').trim();
          }
          // 2. Try Web Browsers (YouTube Web Player)
          else {
            const browser = procList.find(p =>
              (p.Name.toLowerCase() === 'chrome' || p.Name.toLowerCase() === 'msedge' || p.Name.toLowerCase() === 'firefox' || p.Name.toLowerCase() === 'brave') &&
              p.MainWindowTitle.includes(' - YouTube')
            );
            if (browser) {
              // Cleans browser tab notification counts like "(1) Song Title - YouTube"
              title = browser.MainWindowTitle.replace(/^\(\d+\)\s*/, '').split(' - YouTube')[0].trim();
              artist = "";
            }
          }

          if (!title) {
            if (winClock.id && !winClock.pausedAt) winClock.pausedAt = Date.now(); // paused or stopped
            return reject(new Error('not playing'));
          }

          const id = 'win_' + title + '|' + artist;
          if (id !== winClock.id) winClock = { id, start: Date.now(), pausedAt: 0 };
          else if (winClock.pausedAt) { winClock.start += Date.now() - winClock.pausedAt; winClock.pausedAt = 0; }
          resolve({
            currentTrack: { videoId: id, name: title, artist: artist, artwork: "" },
            isPlaying: true,
            position: (Date.now() - winClock.start) / 1000,
            duration: 0,
          });
        } catch (e) {
          reject(e);
        }
      });
    } else {
      reject(new Error('Unsupported OS'));
    }
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
  if (!duration) return synced[0].syncedLyrics;
  synced.sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration));
  return Math.abs(synced[0].duration - duration) <= DURATION_TOLERANCE ? synced[0].syncedLyrics : null;
}

async function fetchLyrics(track, duration) {
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
  if (!PYTHON_FALLBACK) return null;
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

async function pollLoop() {
  let info;
  try {
    info = await getPlayerInfo();
  } catch (e) {
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
    win.webContents.send('offset', syncOffsets[currentVideoId] || 0);
    setPaletteFromArtwork(track.artwork);
    const myGeneration = ++fetchGeneration;

    win.webContents.send('lyrics', null);
    win.webContents.send('track', {
      track,
      isPlaying: info.isPlaying,
      position: info.position,
      duration: info.duration,
    });

    const lyrics = await fetchLyrics(track, info.duration);

    if (myGeneration !== fetchGeneration) return;

    if (!lyrics) {
      win.webContents.send('lyrics', null);
      if (!retriedTracks.has(track.videoId)) {
        retriedTracks.add(track.videoId);
        setTimeout(() => { if (currentVideoId === track.videoId) currentVideoId = null; }, 6000);
      }
      return;
    }

    win.webContents.send('lyrics', lyrics);
    // ponytail: on Windows this is a normal window, so it starts above others until you click something.
    // True desktop level there needs parenting to the WorkerW desktop window (native code, untested).
    if (!win.isVisible()) win.showInactive();
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
  // installed app (.exe / .dmg): start at login; source installs use the macOS LaunchAgent instead
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
  createWindow();
  globalShortcut.register('Control+Alt+.', () => nudgeSync(0.25));
  globalShortcut.register('Control+Alt+,', () => nudgeSync(-0.25));
  globalShortcut.register('Control+Alt+/', () => nudgeSync(0));
  fetch(TRANSLATE_URL.replace('/translate', '/health')).catch(() => { });
  pollLoop();
  pollTimer = setInterval(pollLoop, POLL_INTERVAL_MS);
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  clearInterval(pollTimer);
  app.quit();
});

ipcMain.on('close-app', () => app.quit());
