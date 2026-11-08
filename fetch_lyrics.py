#!/usr/bin/env python3
"""
Looks up synced (LRC) lyrics for a track using the `syncedlyrics` package,
which tries multiple providers (Musixmatch, NetEase, Lrclib, Deezer,
Megalobiz, Genius, Lyricsify) in turn until one has a match.

Usage: python3 fetch_lyrics.py "<artist>" "<title>"

Prints the raw LRC text to stdout on success, or the literal string
"NONE" if no synced lyrics could be found anywhere. Never raises past
main() — any failure just falls through to "NONE" so the caller doesn't
have to special-case exceptions.
"""

import sys


def main():
    if len(sys.argv) < 3:
        print("NONE")
        return

    artist = sys.argv[1].strip()
    title = sys.argv[2].strip()
    search_term = f"{title} {artist}".strip()

    if not search_term:
        print("NONE")
        return

    try:
        import syncedlyrics
    except ImportError:
        sys.stderr.write(
            "syncedlyrics is not installed. Run: pip install syncedlyrics --break-system-packages\n"
        )
        print("NONE")
        return

    try:
        lrc = syncedlyrics.search(search_term, synced_only=True)
    except Exception as e:
        sys.stderr.write(f"lyrics lookup failed: {e}\n")
        lrc = None

    if lrc:
        print(lrc)
    else:
        print("NONE")


if __name__ == "__main__":
    main()
