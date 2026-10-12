"""Entry point: does the draft run under the runtime, and does it read the same values?

Phase 6 of the plan, whose bar is that the Builder's extraction, the generated
`site.json`, and the existing runtime's extraction all agree. Two of those are
checked here against a recorded session — offline, no network — and `--install`
puts the draft where the runtime's registry finds it, which is what a person then
runs by hand against the live page.

    python verify_adapter.py <session-dir>              compare the recorded session
    python verify_adapter.py <session-dir> --install    also install it as an adapter

`<session-dir>` is the one `learn.py` wrote `draft_site.json` into.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from src.builder import paths
from src.builder.harvest import joined_value
from src.builder.learn import load_session
from src.builder.roundtrip import (AGREE, UNRUNNABLE, compare, format_probe_report, install,
                                   probe_draft, unnameable_targets)
from src.generic import diagnostics as diag

PROJECT_ROOT = Path(__file__).resolve().parent
LEARNED_ROOT = paths.home() / "local"


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    should_install = "--install" in arguments
    directories = [Path(argument) for argument in arguments if not argument.startswith("--")]
    if not directories:
        print("Usage: python verify_adapter.py <session-dir> [--install]")
        return 3

    directory = directories[0]
    draft_path = directory / "draft_site.json"
    if not draft_path.is_file():
        print(f"[ERROR] no draft_site.json in {directory}; run learn.py first")
        return 2
    draft = json.loads(draft_path.read_text(encoding="utf-8"))

    sample = load_session(directory)
    result = compare(sample, draft, directory)

    print(f"=== {sample.url}")
    print(f"    draft  {draft_path}")
    print(f"    fields {(draft.get('work') or {}).get('fields') or '(none)'}")
    print()
    for item in result.comparisons:
        print(f"    {item.field:12} {item.verdict:10} "
              f"accepted={joined_value(item.accepted)[:28]:<30} "
              f"runtime={joined_value(item.runtime)[:28]}")
        print(f"                 {item.detail}")
    for note in result.notes:
        print(f"    note: {note}")

    unrunnable = [item.field for item in result.comparisons if item.verdict == UNRUNNABLE]
    if unrunnable:
        print(f"    unrunnable: {', '.join(unrunnable)} — a rule naming a document this "
              "reader cannot produce needs a request recipe")
    print()
    print(f"    {'PASS' if result.ok else 'FAIL'} — "
          f"{len(result.agreeing())}/{len(result.comparisons)} field(s) agree")
    disagreed = [item.field for item in result.disagreeing()]
    if disagreed:
        print(f"    disagreed: {', '.join(disagreed)} — the two sides read different "
              "values, so one of them is wrong")

    (directory / "roundtrip.json").write_text(
        json.dumps(result.to_json(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if should_install:
        if not result.ok:
            print("[STOP] the draft lost or changed an annotated field; nothing was installed.")
            return 1
        # The same gate the two interactive builders use: a draft whose target cannot name the
        # address it was learned from installs successfully and then resolves through no code path.
        unnameable = unnameable_targets(draft, [sample.url])
        if unnameable:
            print()
            for problem in unnameable:
                print(f"[STOP] {problem}")
            print("       nothing was installed: a target that cannot name its own address "
                  "would be invisible.")
            return 1
        # The round trip above compares rules against the *recorded* page; it never asks the runtime
        # to fetch. This does — one bounded probe of the live address, against the draft in a scratch
        # home, so what is measured is what would be installed and the real tree is untouched
        # (plan §5-A.3). A network failure is advisory; a data fault refuses the install.
        if "--no-probe" not in arguments:
            report = probe_draft(draft, sample.url, building="work")
            print()
            for line in format_probe_report(report):
                print(line)
            blocking = diag.blocking_findings(report.findings())
            if blocking and "--force" not in arguments:
                print()
                print("[STOP] the runtime read nothing usable from this site:")
                for finding in blocking:
                    print(f"       {finding.code}: {finding.message}")
                print("       nothing was installed; re-run with --force to install anyway.")
                return 1
        target = install(draft, LEARNED_ROOT, source=str(directories[0]))
        print()
        print(f"    installed {target}")
        print(f"    run it:   python probe.py <a work URL of {draft.get('key')}>")
        shadowed = json.loads((target / "learned.json").read_text(encoding="utf-8")).get("adapter_beside")
        if shadowed:
            print(f"    note: this site already has a written adapter ({shadowed}), so "
                  "the generated one is not the one in use")
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
