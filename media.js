// What's playing, from any app or browser tab, plus the "is this a song?" filter.
// macOS: the system Now Playing info (MediaRemote, read through osascript). Spotify still goes
// through its own AppleScript, which has the exact position and the artwork URL.
// Windows: the system media sessions (GlobalSystemMediaTransportControls), read by one long-running
// PowerShell process. Browsers publish what their tabs play to both of these.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Song or not? -----------------------------------------------------------

const MUSIC_APPS = /spotify|music|itunes|tidal|deezer|foobar|musicbee|winamp|aimp/i;
const NOT_SONG = /\b(trailer|teaser|episode|ep\.? ?\d+|season \d+|s\d+ ?e\d+|full movie|podcast|interview|reaction|review|vlog|tutorial|gameplay|walkthrough|unboxing|highlights)\b/i;

// Cheap first pass. The real test comes after: a song only shows when LRCLIB has synced lyrics
// whose title, artist and length all match, which films, shows and videos don't have.
function looksLikeSong(m) {
  if (!m || !m.title) return false;
  if (m.duration && (m.duration < 30 || m.duration > 15 * 60)) return false; // ads, films, episodes
  if (!m.artist && !m.title.includes(' - ')) return false; // streaming sites leave the artist empty
  return !NOT_SONG.test(m.title);
}

const isMusicApp = (m) => MUSIC_APPS.test((m && m.app) || '');

// Which (artist, song) pairs to look up. Music apps report them properly; browser tabs (YouTube etc.)
// report the video title and the channel, so try "Artist - Song" from the title first, then the channel.
function trackCandidates(m) {
  if (isMusicApp(m)) return [{ name: m.title, artist: m.artist || '' }];
  const title = m.title.replace(/^\(\d+\)\s*/, '').replace(/\s*[|｜].*$/, '').trim();
  const channel = (m.artist || '').replace(/\s*-\s*Topic$/i, '').replace(/\s*VEVO$/i, '').replace(/\s+official$/i, '').trim();
  const out = [];
  const dash = title.indexOf(' - ');
  if (dash > 0) out.push({ artist: title.slice(0, dash).trim(), name: title.slice(dash + 3).trim() });
  if (channel) out.push({ artist: channel, name: title });
  return out;
}

// --- macOS ------------------------------------------------------------------

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

// argv[0]: the item we already have artwork for, so the picture is only sent once per item
const NOW_PLAYING_JXA = `function run(argv) {
  ObjC.import('Foundation');
  const R = $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/').classNamed('MRNowPlayingRequest');
  if (!R) return '';
  const item = R.localNowPlayingItem;
  const info = item && item.nowPlayingInfo;
  if (!info || !info.count) return '';
  const g = (k) => { const v = info.objectForKey('kMRMediaRemoteNowPlayingInfo' + k); return v && !v.isNil() ? ObjC.unwrap(v) : null; };
  const ts = info.objectForKey('kMRMediaRemoteNowPlayingInfoTimestamp');
  const path = R.localNowPlayingPlayerPath;
  const out = {
    id: g('ContentItemIdentifier') || '', title: g('Title') || '', artist: g('Artist') || '',
    duration: +g('Duration') || 0, elapsed: +g('ElapsedTime') || 0, rate: +g('PlaybackRate') || 0,
    at: ts && !ts.isNil() ? ts.timeIntervalSince1970 * 1000 : 0,
    playing: !!R.localIsPlaying, app: path && !path.isNil() ? ObjC.unwrap(path.client.bundleIdentifier) || '' : '',
  };
  if (out.id !== argv[0]) {
    const art = info.objectForKey('kMRMediaRemoteNowPlayingInfoArtworkData');
    if (art && !art.isNil()) out.artwork = 'data:' + (g('ArtworkMIMEType') || 'image/jpeg') + ';base64,' + ObjC.unwrap(art.base64EncodedStringWithOptions(0));
  }
  return JSON.stringify(out);
}`;

let macArt = { id: null, url: '' };

function osascript(args) {
  return new Promise((resolve, reject) => {
    execFile('osascript', args, { timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

async function spotifyMac() {
  const out = await osascript(['-e', SPOTIFY_SCRIPT]);
  if (!out || out === 'closed' || out === 'stopped') throw new Error('not playing');
  const [id, name, artist, pos, dur, state, art] = out.split('||');
  return {
    id, app: 'com.spotify.client', title: name, artist, artwork: art,
    isPlaying: state === 'playing',
    position: parseFloat(pos.replace(',', '.')),
    duration: parseFloat(dur.replace(',', '.')) / 1000,
  };
}

async function macNowPlaying() {
  let np = null;
  try {
    const out = await osascript(['-l', 'JavaScript', '-e', NOW_PLAYING_JXA, macArt.id || '']);
    if (out) np = JSON.parse(out);
  } catch (e) { }
  // Spotify's own position is exact; Now Playing's can lag by seconds
  if (!np || /spotify/i.test(np.app)) return spotifyMac();
  if (np.id !== macArt.id) macArt = { id: np.id, url: np.artwork || '' };
  const position = np.playing && np.at ? np.elapsed + ((Date.now() - np.at) / 1000) * (np.rate || 1) : np.elapsed;
  return { app: np.app, title: np.title, artist: np.artist, artwork: macArt.url, isPlaying: np.playing, position, duration: np.duration };
}

// --- Windows ----------------------------------------------------------------

const WIN_WATCHER = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$M = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$P = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
$mgr = Await ($M::RequestAsync()) $M
while ($true) {
  $out = @()
  foreach ($s in $mgr.GetSessions()) {
    try {
      $p = Await ($s.TryGetMediaPropertiesAsync()) $P
      $t = $s.GetTimelineProperties()
      $out += [pscustomobject]@{
        app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist
        status = [string]$s.GetPlaybackInfo().PlaybackStatus
        pos = $t.Position.TotalSeconds; dur = ($t.EndTime - $t.StartTime).TotalSeconds
        at = $t.LastUpdatedTime.ToUnixTimeMilliseconds()
      }
    } catch { }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @($out)))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 800
}
`;

let winSessions = [];
let winWatcherOk = false; // the watcher has printed at least one line
let winWatcherStart = 0;
let winWatcher = null;
let stopped = false;

function startWinWatcher() {
  // a plain script file, not -EncodedCommand: antivirus often blocks encoded PowerShell from unsigned apps
  const script = path.join(os.tmpdir(), 'lyrics-overlay-media.ps1');
  try { fs.writeFileSync(script, '\ufeff' + WIN_WATCHER); } catch (e) { console.error('[media] could not write watcher script:', e.message); }
  console.error('[media] starting watcher');
  const ps = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); // open stdin can make PowerShell wait forever
  winWatcher = ps;
  if (!winWatcherStart) winWatcherStart = Date.now(); // first start only, so a watcher that keeps crashing still hits the 15 s limit
  let buf = '';
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (d) => {
    const lines = (buf + d).split(/\r?\n/);
    buf = lines.pop();
    for (const l of lines) {
      try { const v = JSON.parse(l); winSessions = Array.isArray(v) ? v : [v]; if (!winWatcherOk) console.error('[media] watcher is running'); winWatcherOk = true; } catch (e) { console.error('[media] bad watcher line:', l.slice(0, 200)); }
    }
  });
  ps.stderr.on('data', (d) => console.error('[media]', String(d).trim()));
  ps.on('error', (e) => console.error('[media] watcher failed:', e.message));
  ps.on('exit', (code) => {
    console.error('[media] watcher exited with code', code);
    winSessions = [];
    if (!stopped) setTimeout(startWinWatcher, 5000); // ponytail: retries forever on Windows too old for media sessions (pre-1809)
  });
}

let winCurrent = null; // title|artist of the session we showed last, so two playing tabs don't flip-flop

// Backup, used while the media watcher isn't working: read Spotify's and YouTube tabs' window titles
// (what 2.1.0 did). Titles have no position, so the song is timed from when we first see it.
let winClock = { id: null, start: 0, pausedAt: 0 };
const TITLES_PS = 'Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Name, MainWindowTitle | ConvertTo-Json -Compress';

function winTitles() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', TITLES_PS], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout.trim()) return reject(new Error('not playing'));
      let procs;
      try { procs = [].concat(JSON.parse(stdout.trim())); } catch (e) { return reject(e); }
      let title = '', artist = '', app = '';
      const spotify = procs.find((p) => /^spotify$/i.test(p.Name) && p.MainWindowTitle.includes(' - '));
      const tab = procs.find((p) => /^(chrome|msedge|firefox|brave|opera|vivaldi)$/i.test(p.Name) && / - YouTube/.test(p.MainWindowTitle));
      if (spotify) {
        const parts = spotify.MainWindowTitle.split(' - ');
        artist = parts[0].trim(); title = parts.slice(1).join(' - ').trim(); app = 'Spotify.exe';
      } else if (tab) {
        title = tab.MainWindowTitle.replace(/^\(\d+\)\s*/, '').split(' - YouTube')[0].trim(); app = tab.Name; // "Artist - Song" split later
      }
      if (!title) {
        if (winClock.id && !winClock.pausedAt) winClock.pausedAt = Date.now();
        return reject(new Error('not playing'));
      }
      const id = title + '|' + artist;
      if (id !== winClock.id) winClock = { id, start: Date.now(), pausedAt: 0 };
      else if (winClock.pausedAt) { winClock.start += Date.now() - winClock.pausedAt; winClock.pausedAt = 0; }
      resolve({ app, title, artist, artwork: '', isPlaying: true, position: (Date.now() - winClock.start) / 1000, duration: 0 });
    });
  });
}

let usingTitles = false;

async function winNowPlaying() {
  if (!winWatcher) startWinWatcher();
  // nothing from the watcher 15 s after it started: blocked or unsupported, so use window titles
  if (!winWatcherOk && Date.now() - winWatcherStart > 15000) {
    if (!usingTitles) { usingTitles = true; console.error('[media] watcher gave nothing, using window titles instead'); }
    return winTitles();
  }
  const key = (s) => s.title + '|' + s.artist;
  const playing = winSessions.filter((s) => s.status === 'Playing' && s.title);
  const s = playing.find((x) => key(x) === winCurrent) || playing[0] || winSessions.find((x) => x.title && key(x) === winCurrent);
  if (!s) throw new Error('not playing');
  winCurrent = key(s);
  const isPlaying = s.status === 'Playing';
  return {
    app: s.app, title: s.title, artist: s.artist, artwork: '', isPlaying,
    // apps that don't report a timeline send 0001-01-01 as the update time; don't count from that
    position: (s.pos || 0) + (isPlaying && s.at > 0 ? (Date.now() - s.at) / 1000 : 0),
    duration: s.dur > 0 ? s.dur : 0,
  };
}

// --- Shared -----------------------------------------------------------------

// { id, app, title, artist, artwork, isPlaying, position (s), duration (s, 0 = unknown) }
async function getNowPlaying() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('Unsupported OS');
  const m = process.platform === 'darwin' ? await macNowPlaying() : await winNowPlaying();
  // a stable id per song (not per play), used for the lyrics cache and the saved sync offsets
  m.id = m.id || `${m.title}|${m.artist}`;
  return m;
}

function stopWatching() {
  stopped = true;
  if (winWatcher) winWatcher.kill();
}

module.exports = { getNowPlaying, looksLikeSong, trackCandidates, isMusicApp, stopWatching };
