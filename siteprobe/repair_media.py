"""Re-fetch media for an export that is missing it.

Written after a real folder turned out to hold 53 records that all claimed a cover
path while 20 of those files did not exist. The library had already been handed a
"complete" export, so the gap surfaced only at display time. This walks an export
and fetches exactly what is absent — no re-crawling of metadata, no re-picking.

    python repair_media.py [export folder] [--apply]

Default is a dry run that names what is missing; `--apply` downloads it. The site's
own media step is used when it has one, so 18comic's previews are still restored
from their shuffled strips rather than merely fetched.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic import export_layout, media  # noqa: E402
from src.generic.registry import RegistryError, adapter_root, discover, load_fetcher  # noqa: E402


def site_for(export_dir: Path):
    """The site whose export group this folder is under, by name."""
    for template in discover():
        if template.export_group == export_dir.name or template.tool == export_dir.name:
            return template
    return None


def records_under(export_dir: Path) -> list[tuple[Path, Path]]:
    """(listing dir, record path) for every work in an export tree."""
    found: list[tuple[Path, Path]] = []
    for path in sorted(export_dir.glob("**/items/*/metadata.json")):
        if "_scramble_backup" in path.parts:
            continue
        found.append((path.parent.parent, path))
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="repair_media",
        description="Fetch the covers and previews an existing export is missing.",
    )
    parser.add_argument("export_dir", nargs="?", type=Path,
                        default=Path("18comic_vip"))
    parser.add_argument("--apply", action="store_true", help="actually download")
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args(argv)

    # An export lives under the SiteProbe home, not beside the tool: a relative scope names a
    # site's export group there, and an absolute one is taken as given.
    export_root = adapter_root() / "export"
    export_dir = args.export_dir if args.export_dir.is_absolute() else (export_root / args.export_dir)
    if not export_dir.is_dir():
        print(f"[ERROR] not a folder: {export_dir}", file=sys.stderr)
        return 2

    template = site_for(export_dir)
    pairs = records_under(export_dir)
    print(f"scope    {export_dir}")
    print(f"site     {template.key if template else '(unknown: shared downloader only)'}")
    print(f"works    {len(pairs)}")
    if not pairs:
        return 0

    # Group by listing so one downloader call covers a listing, which is what the
    # site hooks expect.
    by_listing: dict[Path, list[dict]] = {}
    record_files: dict[str, Path] = {}
    for listing, record_path in pairs:
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"[WARN] unreadable: {record_path}")
            continue
        by_listing.setdefault(listing, []).append(record)
        record_files[f"{listing}\u0000{record.get('source_id')}"] = record_path

    gaps: list[str] = []
    for listing, records in by_listing.items():
        gaps.extend(media.missing_media(records, listing))
    if not gaps:
        print("\nnothing is missing; every record's media is on disk")
        return 0

    print(f"\nmissing media for {len(gaps)} work(s):")
    for entry in gaps[:25]:
        print(f"  {entry}")
    if len(gaps) > 25:
        print(f"  (+{len(gaps) - 25} more)")

    if not args.apply:
        print("\ndry run. Add --apply to download the missing files.")
        return 0

    # The site's own media step, loaded from the directory the adapter lives in — the same
    # way `load_fetcher` reads a site, because an adapter is data in the home and no longer a
    # package named `tool.<site>`.
    downloader = None
    if template is not None:
        try:
            downloader = getattr(load_fetcher(template), "download_media", None)
        except RegistryError as error:
            print(f"\n[WARN] {error}")
            print("using the shared downloader instead")
    if downloader is None:
        print("\nthis site has no media step of its own; using the shared downloader")
    print("\ndownloading ...")
    for listing, records in by_listing.items():
        options = {
            "cache_root": listing,
            "profile_dir": template.directory / "session" / "chrome-profile" if template else None,
            "refresh": False,
            "offline_dir": None,
            "progress": lambda message: None,
        }
        if downloader is not None:
            downloader(template, records, listing, options)
        else:
            for record in records:
                media.download_record_media(
                    record, export_layout.item_dir(listing, str(record["source_id"])),
                )
        # Media changed, so the records must be rewritten — and verified, so a
        # path is only claimed when the file really landed this time.
        for record in records:
            path = record_files.get(f"{listing}\u0000{record.get('source_id')}")
            if path is None:
                continue
            from src.generic import canonical
            canonical.scrub_fetch_urls(record)
            canonical.verify_local_files(record, listing)
            export_layout.write_json(path, record)

    remaining: list[str] = []
    for listing, records in by_listing.items():
        remaining.extend(media.missing_media(records, listing))
    print(f"\nfixed {len(gaps) - len(remaining)} of {len(gaps)}")
    if remaining:
        print("still missing (the site may not serve these any more):")
        for entry in remaining[:15]:
            print(f"  {entry}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
