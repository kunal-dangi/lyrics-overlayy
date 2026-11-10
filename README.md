# Spotify Lyrics Overlay

A sleek, transparent, always-on desktop lyrics overlay for **macOS** and **Windows**.

It watches Spotify (or supported browsers on Windows), fetches synchronized line-by-line and word-by-word lyrics, and presents them in real-time with kinetic typography and dynamic color palettes extracted directly from album artwork. The overlay is click-through, non-focusable, and sits unobtrusively on your desktop so it never steals focus or blocks your workflow.

---

## ✨ Features

- **Cross-Platform Support**:
  - **macOS**: Native AppleScript (`osascript`) integration with Spotify. Runs at the desktop/wallpaper level behind all windows and icons.
  - **Windows**: Zero-dependency PowerShell media detection for Spotify Desktop as well as YouTube media in major browsers (Chrome, Edge, Firefox, Brave).
- **Kinetic Typography & Dynamic Styling**:
  - Multiple styling presets (Editorial, Poster, Handwritten, Pop, Card, etc.).
  - Varied kinetic entrance animations (rise, climb, drop, slide, focus blur, letter tracking, 3D flip, wipe).
  - Dynamic layouts including horizontal flow, diagonal staircase, and alternating zigzag patterns.
  - Word-by-word synchronized highlighting (karaoke mode) with fluid interpolation between poll intervals.
- **Dynamic Color Extraction**:
  - Dominant hues and accent colors are sampled automatically from the album art to theme text, glow, and badges.
- **Pure Node.js Lyrics Engine**:
  - Fast, direct lookups via [LRCLIB](https://lrclib.net) with fuzzy track/artist matching and duration verification.
  - Packaged applications require **no Python runtime**.
  - Python fallback via [`syncedlyrics`](https://github.com/rahiel/syncedlyrics) (Musixmatch, NetEase, Deezer, Genius, etc.) when running in development mode.
- **On-the-Fly Sync Nudging**:
  - Finely adjust timing for off-beat lyrics using keyboard shortcuts. Adjustments are saved persistently per song.
- **Smart Multilingual Support**:
  - Optional translation and romanization for non-English songs powered by an optional Cloudflare Worker.

---

## ⌨️ Shortcuts (Sync Nudge)

Adjust lyrics timing on the fly if a song's timestamp is slightly ahead or behind:

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>.</kbd> *(macOS: <kbd>Ctrl</kbd>+<kbd>⌥ Opt</kbd>+<kbd>.</kbd>)* | Nudge lyrics **earlier** (+0.25s) |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>,</kbd> *(macOS: <kbd>Ctrl</kbd>+<kbd>⌥ Opt</kbd>+<kbd>,</kbd>)* | Nudge lyrics **later** (-0.25s) |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>/</kbd> *(macOS: <kbd>Ctrl</kbd>+<kbd>⌥ Opt</kbd>+<kbd>/</kbd>)* | Reset sync offset to 0 |

Offsets are automatically remembered in `sync-offsets.json` so you never have to adjust the same song twice.

---

## 🛠️ How It Works

1. **Media Polling**:
   - On **macOS**, an AppleScript query polls Spotify every second for the track name, artist, album art URL, playback state, position, and duration.
   - On **Windows**, a lightweight PowerShell command inspects running processes for Spotify Desktop or browser windows playing YouTube.
2. **Lyrics Lookup**:
   - Queries LRCLIB's API using intelligent query variations (clean title, first artist, combined search).
   - Verifies track duration and title similarity before accepting synchronized LRC data.
   - If in development and LRCLIB returns no result, invokes `fetch_lyrics.py` (`syncedlyrics`) as fallback.
   - If no synced lyrics exist, the overlay remains completely hidden.
3. **Smooth Rendering**:
   - Between 1-second polls, local clock interpolation ensures smooth progression through lyric lines and word highlights without jumpiness.
4. **Translation & Romanization (Optional)**:
   - When a track is detected in a foreign language, lines are sent to the translation API worker to fetch English translations and romanized lyrics (pinyin, romaji, etc.).

---

## 📦 Requirements

- **macOS** (10.15+) or **Windows** (10/11)
- **Spotify** desktop app (or supported Chromium/Gecko browsers playing YouTube on Windows)
- **Node.js** 18 or newer + `npm`
- *(Optional for developer fallback)*: **Python 3** with `syncedlyrics`

---

## 🚀 Installation & Setup

### 1. Clone the repository

```bash
git clone https://github.com/kunal-dangi/lyrics-overlayy.git
cd lyrics-overlayy
```

### 2. Install Node dependencies

```bash
npm install
```

*(macOS only)* Clear the quarantine attribute so macOS doesn't block Electron during development:
```bash
xattr -cr node_modules/electron
```

### 3. (Optional) Python Fallback Setup

If you want the secondary multi-provider fallback when developing locally:
```bash
pip3 install syncedlyrics --break-system-packages
```

### 4. (Optional) Translation & Romanization Worker

If you want English translations + romanization for non-English songs:
1. Deploy the Cloudflare Worker located in `worker/` (configured with a free [Groq API key](https://console.groq.com/)).
2. Set the environment variable before starting:
   ```bash
   export TRANSLATE_URL="https://your-worker-name.workers.dev/translate"
   ```
   *(or customize `TRANSLATE_URL` in `main.js`)*.

---

## 💻 Running the App

```bash
npm start
```

Start playing a song with synced lyrics on Spotify. The overlay will appear automatically.

---

## 🍏 macOS Automation (LaunchAgent)

Instead of launching the overlay manually from a terminal, you can set up a background watcher that automatically launches the overlay when Spotify opens and quits it when Spotify closes:

```bash
python3 install_launch_agent.py
```

- **Open Spotify** → overlay opens within seconds.
- **Quit Spotify** → overlay gracefully quits.
- **Reboot / Login** → watcher resumes automatically.

To uninstall the watcher:
```bash
python3 uninstall_launch_agent.py
```

Watcher logs are stored at:
```
~/Library/Logs/lyric-overlay/
```

---

## 🔨 Packaging & Distribution

Build standalone installers using `electron-builder`:

- **macOS DMG**:
  ```bash
  npm run dist
  ```
  Generates a DMG installer in `dist/`.

- **Windows NSIS Installer**:
  ```bash
  npx electron-builder --win nsis
  ```
  Generates a Windows `.exe` installer in `dist/`.

> **Note for macOS users installing prebuilt DMGs:**
> If macOS displays a *"file is damaged and cannot be opened"* error due to Gatekeeper not recognizing self-signed apps, run:
> ```bash
> xattr -cr /Applications/Lyrics\ Overlay.app
> ```

---

## ⚙️ Configuration

| Setting | Location | Description / Default |
|---|---|---|
| Polling Interval | `main.js` → `POLL_INTERVAL_MS` | `1000` ms |
| Text Mode | `main.js` → `TEXT_MODE` | `'dark'` (`'light'` / `'auto'` also supported) |
| Python Fallback Binary | Env var `LYRICS_PYTHON_BIN` | Defaults to `python3` |
| Translation Endpoint | Env var `TRANSLATE_URL` or `main.js` | Cloudflare Worker endpoint |
| Kinetic Animations & Fonts | `style.css` / `renderer.js` | Styling presets, font pairings, transition timings |

---

## 📁 Project Structure

```
lyrics-overlayy/
├── build/
│   └── icon.png            # Application icon asset
├── worker/                 # Cloudflare Worker for AI translation & romanization
├── main.js                 # Electron main process (OS media bridge, LRCLIB client, window management)
├── preload.js              # Secure IPC bridge between main and renderer
├── renderer.js             # Kinetics, typography styles, interpolation, and rendering
├── style.css               # Styling themes, font stacks, layout classes, animations
├── index.html              # Overlay DOM structure
├── fetch_lyrics.py         # Python multi-provider fallback script
├── watcher.py              # macOS Spotify lifecycle monitor
├── install_launch_agent.py # LaunchAgent installer
├── uninstall_launch_agent.py
├── package.json
└── requirements.txt
```

---

## 📄 License

[MIT](LICENSE)
