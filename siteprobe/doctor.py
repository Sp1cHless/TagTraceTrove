"""Entry point: a read-only look at a rule set, and an explicit, recoverable upgrade.

    python doctor.py <site-key | adapter-dir>          report only — no network, no writes
    python doctor.py <site-key | adapter-dir> --apply  add the missing metadata, with a backup

The plan's Phase F (§5-F): doctor answers "can this Core run this rule set?" from the files alone, and
never visits a site; an upgrade is a separate, deliberate act that previews what it will change,
saves a byte-identical backup, and replaces atomically. Real user rule sets are diagnosed, never
rewritten, unless a person passes `--apply` for one of them by name.
"""

from __future__ import annotations

import sys
from pathlib import Path

from src.generic import doctor, registry

PROJECT_ROOT = Path(__file__).resolve().parent


def resolve_directory(argument: str) -> Path | None:
    """A directory the argument names, or the directory of the adapter a site key names."""
    path = Path(argument)
    if path.is_dir() and (path / "site.json").is_file():
        return path
    for template in registry.templates_for(argument):
        return template.directory
    return None


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    apply = "--apply" in arguments
    positional = [argument for argument in arguments if not argument.startswith("--")]
    if not positional:
        print("Usage: python doctor.py <site-key | adapter-dir> [--apply]")
        return 3

    directory = resolve_directory(positional[0])
    if directory is None:
        print(f"[ERROR] no adapter found for {positional[0]!r}")
        return 2

    report = doctor.diagnose(directory)
    print(f"=== {report.site}  ({report.directory})")
    for note in report.notes:
        flag = "fixable" if note.repairable else ""
        print(f"    [{note.level:7}] {note.code}: {note.message} {flag}".rstrip())
    print(f"    {'OK' if report.ok else 'PROBLEMS'} — {len(report.notes)} note(s), "
          f"{len(report.repairable())} repairable")

    if apply:
        result = doctor.upgrade(directory, apply=True)
        if not result.changes:
            print("    nothing to upgrade")
        for change in result.changes:
            print(f"    updated {change['path']}")
        for backup in result.backups:
            print(f"    backup  {backup}")
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
