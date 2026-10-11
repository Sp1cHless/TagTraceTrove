"""Entry point: turn recorded samples of one site into a draft adapter.

Phase 5 of the plan. The first directory is the annotated sample (Example 1); the
rest are Examples 2 and 3, and they prune. Because a session recorded its capture,
none of this needs the network: the rules are resolved against documents that are
already on disk, which is also why this step can be tested without a browser.

    python learn.py <session-dir> <session-dir> [<session-dir> ...]

Writes into the first session's directory:

    learning.json     every hypothesis, its verdict, and why
    draft_site.json   the rules that survived, as a site.json the runtime can load
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from src.builder.learn import PRUNE, UNPROVEN, draft_site_json, learn, load_session

PROJECT_ROOT = Path(__file__).resolve().parent


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    directories = [Path(argument) for argument in arguments if not argument.startswith("--")]
    if not directories:
        print("Usage: python learn.py <session-dir> <session-dir> [<session-dir> ...]")
        return 3

    missing = [str(directory) for directory in directories
               if not (directory / "capture.json").is_file()]
    if missing:
        print(f"[ERROR] no capture.json in: {', '.join(missing)}")
        return 2

    samples = [load_session(directory) for directory in directories]
    print(f"=== {samples[0].url}")
    for sample in samples:
        fields = ", ".join(sorted(sample.annotated)) or "no annotation"
        print(f"    {sample.name:28} {len(sample.harvest.candidates):5} candidate(s)  {fields}")

    learning = learn(samples)
    root = directories[0]
    learning.write(root / "learning.json")
    draft_path = root / "draft_site.json"
    draft_path.write_text(json.dumps(draft_site_json(samples, learning),
                                     ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")

    print()
    for report in learning.fields:
        winner = report.chosen()
        mark = "→" if winner is not None and winner.verdict != PRUNE else " "
        print(f"    {report.field:12} {mark} "
              f"{json.dumps(winner.rule) if winner else 'no rule'}")
        for item in report.hypotheses:
            print(f"        {item.verdict:9} {json.dumps(item.rule)}")
            print(f"                  {item.reason()}")
    for note in learning.notes:
        print(f"    note: {note}")

    unproven = [report.field for report in learning.fields
                if report.chosen() and report.chosen().verdict == UNPROVEN]
    if unproven:
        print(f"    unproven (kept, but only one page could check them): "
              f"{', '.join(unproven)}")
    print()
    print(f"    learning {root / 'learning.json'}")
    print(f"    draft    {draft_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
