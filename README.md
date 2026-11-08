# Spotify Lyrics Overlay

A floating, always-on-top synced-lyrics mini-player for macOS, driven by
[Spotify](https://github.com/sozercan/kaset) (the native YouTube Music client).

## How it works

- Every second, it runs `osascript` to ask Spotify for its player state
  (`get player info`) — current track, artist, album, artwork, position,
  duration, play/pause.
- When the track changes, it shells out to a small Python script
  (`fetch_lyrics.py`) that uses the `syncedlyrics` package, which tries
  **Musixmatch, NetEase, Lrclib, Deezer, Megalobiz, Genius, and Lyricsify**
  in turn until one has synced (line-timed) lyrics — much better coverage
  than any single source.
- If no synced lyrics are found anywhere, **the window just stays hidden**
  for that track — it won't pop up to show an empty/error state.
- Between polls it interpolates the playback position locally so the
  highlighted line moves smoothly instead of jumping once a second, then
  re-syncs on the next poll.
- The window is a small translucent "mini player" card — native macOS
  frosted-glass (vibrancy), rounded corners, draggable from anywhere on
  the card. It's scoped to the desktop/space you opened it on, so it won't
  follow you into other spaces or sit on top of fullscreen apps.

## Requirements

- macOS with [Spotify](https://github.com/sozercan/kaset) installed and running
- Node.js (18+) and npm
- Python 3, with the `syncedlyrics` package installed

## Setup

```bash
cd lyric-overlay

# one-time: install the lyrics lookup dependency
pip install syncedlyrics --break-system-packages

# one-time: install Electron
npm install
xattr -cr node_modules/electron

# run it
npm start
```

If macOS ever blocks the unsigned Electron binary as "malware" again, that's
a known false-positive pattern currently affecting Electron apps generally
(unrelated to this project's code) — the Electron version pinned in
`package.json` is one that's already confirmed working around it.

## Usage

- Play something in Spotify with synced lyrics available — the card fades in
  automatically, bottom-right corner by default.
- Drag from anywhere on the card to reposition it, or drag an edge to resize.
- Hover to reveal the × in the corner to quit.
- If a track has no synced lyrics anywhere, the card simply won't appear
  for that track — no empty box, no error message.

## Automated startup (recommended)

Instead of running `npm start` by hand every time, register a small
background watcher that starts the overlay when Spotify opens and quits it
when Spotify quits — set up once, then it's fully hands-off from then on.

```bash
python3 install_launch_agent.py
```

That's it. From now on:
- Open Spotify → the overlay starts automatically within a few seconds.
- Quit Spotify → the overlay quits automatically too.
- Restart your Mac → the watcher itself comes back on its own (it's a
  login item now), still waiting for Spotify.

If you close the overlay manually with the × while Spotify is still playing,
the watcher won't force it back open for that Spotify session — it'll wait
until Spotify restarts before showing it again.

To remove the automation later and go back to manual `npm start`:

```bash
python3 uninstall_launch_agent.py
```

Logs land in `~/Library/Logs/lyric-overlay/` if anything seems off
and you want to check without digging through Terminal.

**Note:** the watcher script assumes the project lives at
`~/Documents/lyric-overlay` (`PROJECT_DIR` in
`watcher.py`) — update that path if you move the folder.

## Notes / things you may want to tweak

- **Default position** is bottom-right (`WINDOW_WIDTH`/`x`/`y` math in
  `main.js`) — change the `x`/`y` calculation there if you want a different
  starting corner. It stays wherever you last dragged it for that session
  (position isn't saved across restarts yet).
- **Polling interval** is 1s (`POLL_INTERVAL_MS` in `main.js`).
- **Styling** lives in `style.css` — card size, blur tint, font sizes, how
  much of the previous/next line peeks through are all there.
- **Lyrics lookup timeout** is 20s (`fetchLyrics` in `main.js`) — some
  providers are slower than others; `syncedlyrics` tries them in sequence.

## Coming next (once this feels right)

- Saving window position/size across restarts.
- Whatever else comes up once you've lived with it for a bit.
