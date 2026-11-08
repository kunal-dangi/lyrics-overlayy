#!/usr/bin/env python3
"""Removes the background watcher installed by install_launch_agent.py."""

import os
import subprocess

LABEL = "com.lyric-overlay.watcher"
PLIST_PATH = os.path.expanduser(f"~/Library/LaunchAgents/{LABEL}.plist")


def main():
    subprocess.run(["launchctl", "unload", PLIST_PATH], capture_output=True)
    if os.path.exists(PLIST_PATH):
        os.remove(PLIST_PATH)
        print(f"Removed {PLIST_PATH}")
    else:
        print("Nothing was installed.")
    print("Background watcher stopped. The overlay won't auto-launch anymore —")
    print("you're back to running `npm start` manually if you want it.")


if __name__ == "__main__":
    main()
