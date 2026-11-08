#!/usr/bin/env python3
"""
One-time setup: registers watcher.py as a macOS LaunchAgent so
it runs automatically in the background from login onward. After this,
you never need to run a terminal command again — the overlay starts when
Spotify starts, and quits when Spotify quits.

Run once:
    python3 install_launch_agent.py

To remove it later:
    python3 uninstall_launch_agent.py
"""

import os
import subprocess
import sys

LABEL = "com.lyric-overlay.watcher"
PLIST_PATH = os.path.expanduser(f"~/Library/LaunchAgents/{LABEL}.plist")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WATCHER_SCRIPT = os.path.join(SCRIPT_DIR, "watcher.py")
LOG_DIR = os.path.expanduser("~/Library/Logs/lyric-overlay")

PLIST_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{python}</string>
        <string>{script}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>LYRICS_PYTHON_BIN</key>
        <string>{python}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{log_dir}/watcher-out.log</string>
    <key>StandardErrorPath</key>
    <string>{log_dir}/watcher-err.log</string>
</dict>
</plist>
"""


def main():
    if not os.path.exists(WATCHER_SCRIPT):
        print(f"Can't find {WATCHER_SCRIPT} — run this from inside the project folder.", file=sys.stderr)
        sys.exit(1)

    python_path = sys.executable  # the same python3 you just used to install syncedlyrics
    os.makedirs(LOG_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(PLIST_PATH), exist_ok=True)

    plist_content = PLIST_TEMPLATE.format(
        label=LABEL, python=python_path, script=WATCHER_SCRIPT, log_dir=LOG_DIR,
    )
    with open(PLIST_PATH, "w") as f:
        f.write(plist_content)
    print(f"Wrote {PLIST_PATH}")

    # Unload first in case a previous install is already loaded, then load fresh
    subprocess.run(["launchctl", "unload", PLIST_PATH], capture_output=True)
    result = subprocess.run(["launchctl", "load", PLIST_PATH], capture_output=True, text=True)

    if result.returncode != 0:
        print("launchctl load failed:", result.stderr, file=sys.stderr)
        sys.exit(1)

    print()
    print("Installed and running in the background.")
    print("Open Spotify -> the lyrics overlay appears automatically.")
    print("Quit Spotify -> it quits automatically too.")
    print(f"Logs, if you ever need them: {LOG_DIR}")


if __name__ == "__main__":
    main()
