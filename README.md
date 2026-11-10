[README.md](https://github.com/user-attachments/files/34549458/README.md)
# Spotify Lyrics Overlay

A full-screen, always-on desktop lyrics overlay for macOS.

It watches the Spotify app, fetches synced (timed) lyrics for the currently playing track, and displays them on the left side of your screen. The overlay is transparent, click-through, and sits at the desktop/wallpaper level so it never steals focus or blocks other apps. Colors are sampled from the album art. Non-English songs can optionally show an English translation and romanization.

---

## How it works

1. Every second the app runs an AppleScript (`osascript`) against the Spotify app to get:
   - Track ID, name, artist
   - Playback position & duration
   - Play / pause state
   - Album artwork URL

2. When the track changes it calls `fetch_lyrics.py`, which uses the `syncedlyrics` package. That package tries the following providers in order until it finds line-timed lyrics:
   - Musixmatch
   - NetEase
   - Lrclib
   - Deezer
   - Megalobiz
   - Genius
   - Lyricsify

3. If no synced lyrics are found, the overlay stays completely hidden for that track (no empty window, no error message).

4. Between polls the playback position is interpolated locally so the highlighted line advances smoothly instead of jumping once per second.

5. The window is a transparent, click-through, desktop-level Electron window. Lyrics appear on the left third of the screen with dynamic sizing and a highlighted “hero” word. Colors are derived from the album art.

6. Optional translation + romanization is handled by a small Cloudflare Worker (source included in `worker/`). Lyrics still appear even if the translation service is unavailable.

---

## Requirements

- macOS (tested on recent versions)
- Official Spotify desktop app installed
- Node.js 18 or newer + npm
- Python 3

---

## Installation (step-by-step)

### 1. Clone the repository

```bash
git clone https://github.com/kunal-dangi/lyrics-overlayy.git
cd lyrics-overlayy
```

### 2. Install Python dependency

```bash
pip3 install syncedlyrics --break-system-packages
```

(You can also use a virtual environment if you prefer.)

### 3. Install Node dependencies

```bash
npm install
```

After installation, clear the quarantine attribute so macOS doesn’t block Electron:

```bash
xattr -cr node_modules/electron
```

### 4. (Optional) Set up translation / romanization

Translation is optional. Without it, lyrics still work normally.

If you want English translations + romanization for non-English songs:

1. Deploy the Cloudflare Worker in the `worker/` folder (requires a free Groq API key set as `GROQ_API_KEY`).
2. Either export the URL before starting:

   ```bash
   export TRANSLATE_URL="https://your-worker-name.workers.dev/translate"
   ```

   or edit line 6 of `main.js` and replace the placeholder URL.

### 5. Run the overlay

```bash
npm start
```

Play a song in Spotify that has synced lyrics. The overlay should appear on the left side of the screen within a couple of seconds.

---
## If apple throws an error of file damaged
```bash
xattr -cr /Applications/Lyrics\ Overlay.app
```
## Automated startup (recommended)

Instead of running `npm start` every time, you can register a background watcher that automatically starts the overlay when Spotify opens and quits it when Spotify quits.

```bash
python3 install_launch_agent.py
```

After this:

- Open Spotify → overlay starts within a few seconds
- Quit Spotify → overlay quits
- Restart your Mac → the watcher comes back automatically

If you manually quit the overlay while Spotify is still running, the watcher will not relaunch it until the next Spotify session.

To remove the automation later:

```bash
python3 uninstall_launch_agent.py
```

Logs are written to:

```
~/Library/Logs/lyric-overlay/
```

---

## Usage notes

- The overlay is intentionally click-through and non-focusable.
- It only appears when synced lyrics are available.
- Pausing Spotify dims the lyrics.
- Switching to a track with no synced lyrics hides the overlay completely.
- The window lives at the desktop level, so it will not appear over fullscreen apps or on other Spaces.

---

## Configuration & customization

| Setting | Location | Default |
|---------|----------|---------|
| Polling interval | `main.js` → `POLL_INTERVAL_MS` | 1000 ms |
| Lyrics lookup timeout | `main.js` → `fetchLyrics` | 45 seconds |
| Text color mode | `main.js` → `TEXT_MODE` | `'dark'` (`'light'` / `'auto'` also supported) |
| Layout, fonts, colors, transitions | `style.css` | left-third placement, dynamic sizing |
| Translation endpoint | `main.js` → `TRANSLATE_URL` or env var | placeholder |

---

## Troubleshooting

**Overlay never appears**
- Confirm Spotify is the official desktop app and a track with synced lyrics is playing.
- Check the terminal (or `~/Library/Logs/lyric-overlay/`) for errors.
- Make sure `syncedlyrics` is installed and `fetch_lyrics.py` can be executed.

**Electron is blocked by macOS**
```bash
xattr -cr node_modules/electron
```
Then try `npm start` again.

**Translation not working**
- Lyrics should still appear. Translation only adds the extra line underneath.
- Verify `TRANSLATE_URL` points to a real deployed worker and that the worker has a valid `GROQ_API_KEY`.

**Watcher not starting the overlay**
- Run `python3 install_launch_agent.py` again.
- Check `~/Library/Logs/lyric-overlay/` for watcher output.
- Confirm the project path hasn’t been moved after installing the LaunchAgent.

---

## Project structure

```
lyrics-overlayy/
├── main.js                 # Electron main process (Spotify polling, lyrics fetch, window)
├── preload.js              # Context bridge
├── renderer.js             # Lyrics rendering + smooth position interpolation
├── index.html
├── style.css
├── fetch_lyrics.py         # Synced lyrics lookup via syncedlyrics
├── watcher.py              # Background process that starts/stops the overlay with Spotify
├── install_launch_agent.py
├── uninstall_launch_agent.py
├── worker/                 # Optional Cloudflare Worker for translation/romanization
├── package.json
└── requirements.txt
```

---

## License

MIT
