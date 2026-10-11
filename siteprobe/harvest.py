"""Entry point: capture one link and list everything that could be a field.

Phase 2 of the plan says to look at this on the command line before building any
UI, so this prints the candidates and writes the two artifacts a session keeps:

    builder_sessions/<host>/<session-id>/capture.json      what came off the page
    builder_sessions/<host>/<session-id>/candidates.json    what was found in it

The capture is written first and is the input to everything after it, which is what
makes a session replayable without visiting the site again.

    python harvest.py <url> [<url> ...]        markup only, no browser
    python harvest.py --browser <url> ...      render, and record the JSON it fetched
"""

from __future__ import annotations

import sys
import time
from datetime import datetime
from pathlib import Path

from src.builder import paths
from src.builder.capture import Capture, capture_browser, capture_plain
from src.builder.harvest import harvest

PROJECT_ROOT = Path(__file__).resolve().parent
SESSIONS = paths.home() / "sessions"
PER_KIND = 5


def session_directory(capture: Capture) -> Path:
    host = (capture.final_url or capture.url).split("//")[-1].split("/")[0] or "unknown"
    host = "".join(character if character.isalnum() or character in ".-" else "_"
                   for character in host)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return SESSIONS / host / stamp


def report(capture: Capture, result, directory: Path, elapsed: float) -> None:
    """The strongest few of each kind, not one merged list.

    A title and a cover are two different fields, so scoring them on one scale and
    reading the result top-down compares things that are not competing: a
    well-confirmed text value buries the cover even when the cover is the first
    image on the page. The plan's §7 has the UI filter by type, and this is that.
    """
    kinds: dict[str, int] = {}
    for candidate in result.candidates:
        kinds[candidate.kind] = kinds.get(candidate.kind, 0) + 1

    print(f"=== {capture.final_url or capture.url}")
    print(f"    {elapsed:5.2f}s  {len(capture.documents)} document(s) "
          f"({', '.join(sorted({d.format for d in capture.documents})) or 'none'})  "
          f"status={capture.status}")
    for note in result.notes:
        print(f"    note: {note}")
    summary = ", ".join(f"{kind} {count}" for kind, count in sorted(kinds.items()))
    print(f"    {len(result.candidates)} candidate(s): {summary}")
    print()

    for kind in ("image", "collection", "url", "text", "number"):
        group = result.by_kind(kind)[:PER_KIND]
        if not group:
            continue
        print(f"    strongest {kind}")
        for candidate in group:
            channels = " | ".join(f"{source.channel}:{source.detail}"
                                  for source in candidate.sources[:2])
            more = f"  (+{len(candidate.sources) - 2})" if len(candidate.sources) > 2 else ""
            variants = candidate.context.get("variants")
            merged = f"  [{len(variants)} size(s) merged]" if variants else ""
            print(f"      {candidate.score:>4}  {candidate.value[:74]}")
            print(f"            {channels}{more}{merged}")
        print()

    print(f"    capture    {directory / 'capture.json'}")
    print(f"    candidates {directory / 'candidates.json'}")
    print()


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    use_browser = "--browser" in arguments
    targets = [argument for argument in arguments if not argument.startswith("--")]
    if not targets:
        print("Usage: python harvest.py [--browser] <url> [<url> ...]")
        return 3

    for url in targets:
        started = time.perf_counter()
        capture = capture_browser(url) if use_browser else capture_plain(url)
        result = harvest(capture)
        elapsed = time.perf_counter() - started
        directory = session_directory(capture)
        capture.write(directory / "capture.json")
        result.write(directory / "candidates.json")
        report(capture, result, directory, elapsed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
