"""Entry point: harvest one link, then annotate it in a local page.

Phase 4 of the plan. The page is served on the loopback interface so the annotation
comes straight back to the tool — no file to download, nothing to move by hand.

    python annotate.py <url>                    harvest the page as sent
    python annotate.py --browser <url>          render it, and record its JSON too
    python annotate.py --replay <session-dir>   annotate a session already recorded
    python annotate.py --confirm-from <dir> <url>   propose and let you confirm (Example 2)

The session directory holds everything a run produced, so a failure can be looked at
afterwards and a decision can be revisited without visiting the site again:

    <home>/sessions/<host>/<session-id>/
        capture.json        what came off the page
        candidates.json     what was found in it
        annotations.json    what a person decided, and the rules it implies
        media/              candidate images, cached as they were viewed
"""

from __future__ import annotations

import sys
import time
from datetime import datetime
from pathlib import Path

from src.builder import paths
from src.builder.annotate import FIELDS, hypotheses
from src.builder.capture import Capture, capture_browser, capture_plain
from src.builder.harvest import Harvest, harvest
from src.builder.learn import apply_to, load_session
from src.builder.session_server import Session, serve

PROJECT_ROOT = Path(__file__).resolve().parent
SESSIONS = paths.home() / "sessions"


def session_directory(capture: Capture) -> Path:
    host = (capture.final_url or capture.url).split("//")[-1].split("/")[0] or "unknown"
    host = "".join(character if character.isalnum() or character in ".-" else "_"
                   for character in host)
    return SESSIONS / host / datetime.now().strftime("%Y%m%d-%H%M%S")


def record(capture: Capture, root: Path) -> tuple[Harvest, Path]:
    """Write the session's two artifacts, then return what the page needs."""
    result = harvest(capture)
    root.mkdir(parents=True, exist_ok=True)
    capture.write(root / "capture.json")
    result.write(root / "candidates.json")
    return result, root


def report(result: Harvest, root: Path) -> None:
    counts: dict[str, int] = {}
    for candidate in result.candidates:
        counts[candidate.kind] = counts.get(candidate.kind, 0) + 1
    summary = ", ".join(f"{kind} {count}" for kind, count in sorted(counts.items()))
    print(f"    {len(result.candidates)} candidate(s): {summary}")
    for note in result.notes:
        print(f"    note: {note}")
    print(f"    session {root}")


def show_annotations(root: Path) -> int:
    """What the person chose, and whether each choice carries a rule."""
    path = root / "annotations.json"
    if not path.is_file():
        print("    no annotation was submitted")
        return 1
    import json

    document = json.loads(path.read_text(encoding="utf-8"))
    chosen = document.get("hypotheses") or {}
    print()
    print(f"    {path}")
    for field, _kind, label in FIELDS:
        entry = chosen.get(field)
        if entry is None:
            continue
        rule = entry["rule"]
        readable = rule.get("path") or f"{rule.get('select') or rule.get('name')}"
        print(f"      {field:12} {label:10} {entry['value'][:40]:<42} "
              f"{rule['from']}:{readable}")
    missing = [field for field, _k, _l in FIELDS
               if field in document.get("fields", {}) and field not in chosen]
    if missing:
        print(f"      (no rule available for: {', '.join(missing)})")
    return 0


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    use_browser = "--browser" in arguments
    confirm_from = None
    if "--confirm-from" in arguments:
        index = arguments.index("--confirm-from")
        if index + 1 >= len(arguments):
            print("Usage: python annotate.py [--browser] [--confirm-from <session-dir>] <url>")
            return 3
        confirm_from = Path(arguments[index + 1])
        arguments = arguments[:index] + arguments[index + 2:]
    replay = None
    if "--replay" in arguments:
        index = arguments.index("--replay")
        if index + 1 >= len(arguments):
            print("Usage: python annotate.py [--browser] <url> | --replay <session-dir>")
            return 3
        replay = Path(arguments[index + 1])
        arguments = arguments[:index] + arguments[index + 2:]
    targets = [argument for argument in arguments if not argument.startswith("--")]

    if replay is not None:
        capture = Capture.read(replay / "capture.json")
        result, root = record(capture, replay)
        print(f"=== replay {capture.final_url or capture.url}")
        report(result, root)
        serve(Session(harvest=result, directory=root,
                      url=capture.final_url or capture.url))
        return show_annotations(root)

    if not targets:
        print("Usage: python annotate.py [--browser] <url> [<url> ...] | --replay <dir>")
        return 3

    exit_code = 0
    for url in targets:
        started = time.perf_counter()
        capture = capture_browser(url) if use_browser else capture_plain(url)
        result, root = record(capture, session_directory(capture))
        print(f"=== {capture.final_url or capture.url}  ({time.perf_counter() - started:.2f}s)")
        report(result, root)
        applied = None
        mode = "annotate"
        if confirm_from is not None:
            # Example 2: apply what the annotated page taught, and let the person
            # only confirm. The rule comes along, so a confirmed field keeps it.
            applied = apply_to(load_session(confirm_from), capture)
            mode = "confirm"
            readable = ", ".join(f"{field}={str(entry['value'])[:24]}"
                                 for field, entry in applied.items())
            print(f"    applied from {confirm_from.name}: {readable or '(nothing)'}")
        print(f"    opening the annotation page ({mode}); submit it to continue")
        serve(Session(harvest=result, directory=root, mode=mode, applied=applied,
                      url=capture.final_url or capture.url))
        exit_code = max(exit_code, show_annotations(root))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
