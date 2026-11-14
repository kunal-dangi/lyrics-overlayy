#!/usr/bin/env python3
"""
Starts the lyrics overlay at login and keeps it running. The overlay hides itself
whenever no song is playing (in Spotify, a browser or any other player), so it
doesn't need Spotify to be open. Meant to be registered as a background
LaunchAgent by install_launch_agent.py, not run by hand.
"""

import os
import subprocess
import sys
import time

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
ELECTRON_BIN = os.path.join(
    PROJECT_DIR, "node_modules", "electron", "dist", "Electron.app",
    "Contents", "MacOS", "Electron",
)
LOG_DIR = os.path.expanduser("~/Library/Logs/lyric-overlay")

overlay_process = None


def log(msg):
    print(f"[watcher] {msg}", flush=True)


def start_overlay():
    global overlay_process
    if not os.path.exists(ELECTRON_BIN):
        log(f"Electron binary not found at {ELECTRON_BIN} — is the project set up at {PROJECT_DIR}?")
        return
    os.makedirs(LOG_DIR, exist_ok=True)
    out_log = open(os.path.join(LOG_DIR, "overlay-out.log"), "a")
    err_log = open(os.path.join(LOG_DIR, "overlay-err.log"), "a")

    # Pass along the python interpreter that has `syncedlyrics` installed —
    # launchd's default PATH is minimal and may not find the right python3
    # otherwise. install_launch_agent.py sets this env var for us.
    env = dict(os.environ)
    if "LYRICS_PYTHON_BIN" not in env:
        env["LYRICS_PYTHON_BIN"] = sys.executable

    overlay_process = subprocess.Popen(
        [ELECTRON_BIN, "."],
        cwd=PROJECT_DIR,
        stdout=out_log,
        stderr=err_log,
        env=env,
    )
    log(f"started overlay (pid {overlay_process.pid})")


def stop_overlay():
    global overlay_process
    if overlay_process is None or overlay_process.poll() is not None:
        overlay_process = None
        return
    log(f"stopping overlay (pid {overlay_process.pid})")
    overlay_process.terminate()
    try:
        overlay_process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        overlay_process.kill()
    overlay_process = None


def main():
    start_overlay()
    if overlay_process is not None:
        overlay_process.wait()
        log("overlay closed (tray Quit) — it stays closed until the next login")
    # launchd's KeepAlive would restart us (and the overlay) if we exited, so idle instead
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        stop_overlay()
