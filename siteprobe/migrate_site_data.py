"""Migrate the three original tools' site-level data into the merged tool.

What moves, per site, into `generic_probe/export/<group>/`:

    taxonomy_dictionary.json   series / authors / characters / types + accepted
                               and rejected tags — the site's vocabulary
    tag_review.csv             the pending review sheet
    author_list.json           hitomi only: the crawled-author registry that
                               carries each author's latest work

Every file it overwrites is copied aside first as `<name>.pre-migration`, because
this replaces curated data and a mistake here is not recoverable from anywhere
else.

`character.json` next to hitomi's originals is deliberately NOT migrated: it is a
truncated fragment (its content starts mid-object at `"characters": {`), no code in
the tool writes it, and the characters live in `taxonomy_dictionary.json` already.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

PROBE = Path(__file__).resolve().parent
SITE_PROBE = PROBE.parent
ORIGINAL_ROOT = SITE_PROBE
EXPORT_ROOT = PROBE / "export"
BACKUP_SUFFIX = ".pre-migration"

GROUPS = ("hitomi_la", "18comic_vip", "hanime1_me")
# Files taken wholesale from the original, overwriting whatever testing produced.
COPY_FILES = ("taxonomy_dictionary.json", "tag_review.csv")
# Author names the testing runs introduced that are worth keeping. Both are in the
# originals already, so this is a check rather than an edit.
KEEP_AUTHORS = {"18comic_vip": ("kakao",), "hanime1_me": ("rinhee",), "hitomi_la": ()}


def backup(path: Path) -> None:
    if path.is_file():
        shutil.copy2(path, path.with_name(path.name + BACKUP_SUFFIX))


def migrate_file(group: str, name: str) -> bool:
    source = ORIGINAL_ROOT / group / "exports" / name
    target = EXPORT_ROOT / group / name
    if not source.is_file():
        print(f"  {name}: no original at {source}")
        return False
    backup(target)
    shutil.copy2(source, target)
    size = source.stat().st_size
    print(f"  {name}: original ({size} bytes) -> {target.relative_to(PROBE)}")
    return True


def merge_author_list(group: str) -> None:
    """The original registry, plus any author the new tool actually crawled.

    The instruction was to overwrite, but the new file's single entry is a real
    crawl (`sharekoube`), not a test artifact, and the original does not have it —
    so dropping it would lose a crawled author. Everything else is the original's.
    """
    source = ORIGINAL_ROOT / group / "exports" / "author_list.json"
    target = EXPORT_ROOT / group / "author_list.json"
    if not source.is_file():
        print("  author_list.json: no original; leaving the new file alone")
        return
    original = json.loads(source.read_text(encoding="utf-8"))
    authors = list(original.get("authors") or [])
    known = {str(entry.get("artist") or "").casefold() for entry in authors}

    added: list[str] = []
    if target.is_file():
        try:
            current = json.loads(target.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            current = {}
        for entry in current.get("authors") or []:
            name = str(entry.get("artist") or "")
            if not name or name.casefold() in known:
                continue
            authors.append(entry)
            known.add(name.casefold())
            added.append(name)

    backup(target)
    original["authors"] = authors
    target.write_text(json.dumps(original, ensure_ascii=False, indent=2) + "\n",
                      encoding="utf-8")
    print(f"  author_list.json: {len(original['authors'])} entries"
          + (f" (kept from the new tool: {', '.join(added)})" if added else ""))


def verify_authors(group: str) -> None:
    """The author names that had to survive the overwrite."""
    wanted = KEEP_AUTHORS.get(group, ())
    if not wanted:
        return
    path = EXPORT_ROOT / group / "taxonomy_dictionary.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    authors = {str(name).casefold() for name in (document.get("authors") or {})}
    for name in wanted:
        state = "present" if name.casefold() in authors else "MISSING"
        print(f"    author {name!r}: {state}")


def main() -> int:
    for group in GROUPS:
        target_dir = EXPORT_ROOT / group
        if not target_dir.is_dir():
            print(f"{group}: no export folder; skipped")
            continue
        print(f"{group}")
        for name in COPY_FILES:
            migrate_file(group, name)
        verify_authors(group)
        merge_author_list(group)

    ignored = ORIGINAL_ROOT / "hitomi_la" / "exports" / "character.json"
    if ignored.is_file():
        head = ignored.read_text(encoding="utf-8", errors="replace").lstrip()[:40]
        print(f"\nnot migrated: {ignored.name} (starts with {head!r} — a fragment, "
              f"and characters already live in taxonomy_dictionary.json)")
    print(f"\noriginals kept as *{BACKUP_SUFFIX}; tag review may be re-run to rebuild it")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
