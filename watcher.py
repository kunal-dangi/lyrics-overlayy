#!/usr/bin/env python3
"""
Watches for the Spotify process. Starts the lyrics overlay whenever Spotify is
running, stops it whenever Spotify quits. Runs forever in a loop — meant to
be registered as a background LaunchAgent by install_launch_agent.py, not
run by hand.
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
PLAYER_PROCESS_NAME = "Spotify"
POLL_SECONDS = 3

overlay_process = None
suppress_relaunch = False  # true after the user manually closes the overlay


def log(msg):
    print(f"[watcher] {msg}", flush=True)


def is_kaset_running() -> bool:
    if subprocess.run(["pgrep", "-x", PLAYER_PROCESS_NAME], capture_output=True).returncode == 0:
        return True
    # Fallback in case the executable inside Spotify.app isn't named exactly "Spotify"
    return subprocess.run(["pgrep", "-f", "Spotify.app"], capture_output=True).returncode == 0


def is_overlay_alive() -> bool:
    return overlay_process is not None and overlay_process.poll() is None


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
    global suppress_relaunch
    global overlay_process
    log(f"watching for {PLAYER_PROCESS_NAME}...")
    was_kaset_running = False

    while True:
        kaset_running = is_kaset_running()

        if kaset_running and not was_kaset_running:
            # Fresh Spotify session — clear any "user closed it" suppression
            # from a previous session so it starts fresh again this time.
            suppress_relaunch = False

        if not kaset_running:
            if is_overlay_alive():
                stop_overlay()
        else:
            if is_overlay_alive():
                pass
            elif overlay_process is not None:
                # We started it earlier and it's since exited on its own
                # while Spotify is still open — most likely you closed it
                # manually via the close button. Respect that for the rest
                # of this Spotify session instead of popping it back up.
                log("overlay closed while Spotify still running — not relaunching until Spotify restarts")
                suppress_relaunch = True
                overlay_process = None
            elif not suppress_relaunch:
                start_overlay()

        was_kaset_running = kaset_running
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        stop_overlay()
