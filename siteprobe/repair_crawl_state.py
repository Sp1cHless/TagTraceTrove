"""Rebuild the crawl state so a crawl stops re-fetching what the library already has.

The export tree was lost on 2026-09-19, and with it every `crawl_state.json`. What
T³ holds is the part that matters: `site_works` records one row per work it imported
(source site, source id, detail url), which is exactly the inventory the crawler
prunes with. This reads that table — **read-only** — and writes each listing's
inventory back into the crawler's own tree.

    python repair_crawl_state.py [--database <path>] [--check]

The listing refs come from three places, and each is labelled with where it came
from, because two of them are second-hand:

* T³'s own `site_crawl_sources` rows — first-hand, but only two exist, because the
  cursor is only recorded for a batch that carried an origin;
* each site's own list files — hitomi's `autolistdone.txt`, first-hand;
* the export tree that was deleted, recalled — second-hand, and printed as such.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from src.generic import crawl_state, export_layout, registry  # noqa: E402

# The home, because `export_layout.site_root` appends `export/`; the migration working copy kept
# the two in one directory, so this pointed at the tool itself and looked in a tree that does not
# exist in a checkout (`<tool>/export/<group>/`).
from src.generic.registry import adapter_root  # noqa: E402
PROJECT_ROOT = adapter_root()
SITE_PROBE = PROJECT_ROOT.parent
DEFAULT_DATABASE = Path(r"D:\Project\TagTraceTrove\apps\server\.data\library.db")

# Recalled from the deleted `export/` tree, and marked as recalled rather than passed
# off as recorded. Both are printed before anything is written.
RECALLED: dict[str, list[tuple[str, str]]] = {
    "hanime1.me": [("playlist", "220566"), ("playlist", "956017"), ("search", "Rinhee")],
    "18comic.vip": [("search", term) for term in (
        "きょくちょ", "ときば", "はも", "カンナ", "夢宮すばる",
        "平つくね", "桃月すず", "西沢みずき", "角砂糖",
    )],
}


def imported_ids(database: Path) -> dict[str, set[str]]:
    """Per site, the works the library holds. Opened read-only; never written."""
    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT source_site, source_id FROM site_works").fetchall()
    finally:
        connection.close()
    per_site: dict[str, set[str]] = {}
    for source_site, source_id in rows:
        per_site.setdefault(str(source_site), set()).add(str(source_id))
    return per_site


def recorded_sources(database: Path) -> list[tuple[str, str, str, str | None]]:
    """The listings T³ itself recorded: (site, kind, ref, display name)."""
    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT source_site, source_kind, source_ref, display_name "
            "FROM site_crawl_sources").fetchall()
    finally:
        connection.close()
    return [(str(a), str(b), str(c), d) for a, b, c, d in rows]


def hitomi_names() -> list[str]:
    """The artist names this project's own tool already walked."""
    path = SITE_PROBE / "hitomi_la" / "autolistdone.txt"
    if not path.is_file():
        return []
    names: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        name = line.strip()
        if name and name not in names:
            names.append(name)
    return names


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    check_only = "--check" in arguments
    database = DEFAULT_DATABASE
    if "--database" in arguments:
        index = arguments.index("--database")
        if index + 1 >= len(arguments):
            print("Usage: python repair_crawl_state.py [--database <path>] [--check]")
            return 3
        database = Path(arguments[index + 1])

    if not database.is_file():
        print(f"[ERROR] no database at {database}; pass --database <path>")
        return 2

    per_site = imported_ids(database)
    print(f"database {database}  (opened read-only)")
    for site, ids in sorted(per_site.items()):
        print(f"  {site:22} {len(ids)} imported work(s)")
    print()

    # Every site the tool knows, so a template's own export group is used rather than
    # a name guessed here.
    by_source = {template.source_site: template for template in registry.discover()}

    listings: dict[str, list[tuple[str, str, str, str]]] = {}
    for site, kind, ref, display in recorded_sources(database):
        listings.setdefault(site, []).append((kind, ref, display or ref, "recorded by T³"))
    for name in hitomi_names():
        listings.setdefault("hitomi.la", []).append(("artist", name, name, "hitomi autolistdone.txt"))
    for site, entries in RECALLED.items():
        for kind, ref in entries:
            listings.setdefault(site, []).append((kind, ref, ref, "recalled from the deleted tree"))

    written = 0
    for site, entries in sorted(listings.items()):
        template = by_source.get(site)
        if template is None:
            print(f"  [SKIP] {site}: no template claims it")
            continue
        ids = sorted(per_site.get(site, set()))
        site_root = export_layout.site_root(PROJECT_ROOT, template)
        existing = crawl_state.load(site_root)
        print(f"  {site}  export/{template.export_group}  {len(entries)} listing(s), "
              f"{len(ids)} known work(s)")
        for kind, ref, display, provenance in entries:
            key = crawl_state.listing_key(kind, ref)
            state = existing.get(key) or crawl_state.ListingState(source_kind=kind,
                                                                 source_ref=ref)
            state.display_name = state.display_name or display
            state.source_ids = sorted(set(state.source_ids) | set(ids))
            if state.last_seen_source_id is None and ids:
                state.last_seen_source_id = ids[-1]
            existing[key] = state
            print(f"     {key:34} <- {provenance}")
            written += 1
        if not check_only:
            crawl_state.save(site_root, existing)

    print()
    print(f"  {written} listing state(s) {'checked' if check_only else 'written'}")
    if not check_only:
        print("  a crawl of any of them now skips every work the library already holds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
