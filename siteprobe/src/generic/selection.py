"""Download the works a review selection names.

This is the second half of the review flow and mirrors the original tool exactly:
the scan writes a review page, the page exports a selection, and this reads that
selection and fetches only what was picked.

It is generic: the selection names its own `source_site`, so which site's exporter
runs is decided by the file, not by a menu. A site that has no exporter of its own
falls back to reading the selection's ids with the site's normal `read_work`, which
means the flow degrades to something useful instead of refusing.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from . import export_layout, site_api
from .registry import RegistryError, load_fetcher, reader_for
from .site_api import optional_export_selection

SELECTION_ID_KEYS = (
    "selected_source_ids",
    "selected_ids",
    "whitelisted_source_ids",
    "source_ids",
)


def selection_ids(document: dict[str, Any]) -> list[str]:
    """The ids a selection asks for: selected plus whitelisted, minus excluded.

    The original rule, preserved because a review page can both whitelist and
    cross out, and the exclusion must win.
    """
    chosen: list[str] = []
    for key in SELECTION_ID_KEYS:
        for value in document.get(key) or []:
            text = str(value).strip()
            if text and text not in chosen:
                chosen.append(text)
    excluded = {str(value).strip() for value in document.get("excluded_source_ids") or []}
    return [value for value in chosen if value not in excluded]


def site_key_for(document: dict[str, Any], selection_path: Path) -> str:
    """Which site this selection belongs to.

    The file says so itself (`source_site`), and for a hand-made selection the
    path is the fallback: `export/<group>/artist_x/selection_x.json`.
    """
    declared = str(document.get("source_site") or "").strip()
    if declared:
        return declared
    parts = selection_path.resolve().parts
    if "export" in parts:
        index = parts.index("export")
        if index + 1 < len(parts):
            return parts[index + 1]
    raise RegistryError(
        "the selection does not name a source_site and no export/<site>/ folder "
        "could be recognised in its path"
    )


def run_selection(selection_path: Path, *, project_root: Path, workers: int = 4,
                  progress=print) -> Path:
    path = Path(selection_path).resolve()
    if not path.is_file():
        raise ValueError(f"selection file not found: {path}")
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError(f"a selection must be a JSON object: {path}")

    key = site_key_for(document, path)
    # The key can carry two adapters, and only one of them can read a work page: a rule set learned
    # from a listing declares the same key and outranks the written adapter (`registry.reader_for`).
    template = reader_for(key)
    fetcher = load_fetcher(template)
    export_root = export_layout.site_root(project_root, template)

    chosen = selection_ids(document)
    exporter = optional_export_selection(fetcher)
    if exporter is not None:
        progress(f"{template.key}: exporting {len(chosen)} selected work(s)")
        return Path(exporter(template, path, {
            "export_root": export_root,
            "workers": workers,
            "progress": progress,
            "selection": document,
        }))

    return _export_generically(template, fetcher, document, chosen,
                              export_root=export_root, project_root=project_root,
                              workers=workers, progress=progress)


def _export_generically(template, fetcher, document: dict[str, Any],
                        chosen: list[str], *, export_root: Path, project_root: Path,
                        workers: int, progress) -> Path:
    """List the works again, keep the picks, and fetch only those.

    A generic review stores no state: the selection names the listing it came from
    (`target_kind` + `target_ref`), so re-listing resolves the ids. That keeps the
    flow stateless, and re-listing is cheap — a search page is a handful of
    requests against the hundreds of works it describes.
    """
    from . import canonical, export_layout, taxonomy
    from .extract import extract_work
    from .runner import RunOptions
    from .site_api import collect_items, iter_options, optional_list_cards

    kind = str(document.get("target_kind") or "")
    ref_fields = document.get("target_ref_fields")
    ref = ({str(key): str(value) for key, value in ref_fields.items()}
           if isinstance(ref_fields, dict) else {"id": str(document.get("target_ref") or "")})
    if not kind or not (ref.get("id") or ref.get("user")):
        raise ValueError(
            "this selection does not name the listing it came from "
            "(target_kind / target_ref), so its works cannot be re-listed"
        )
    cards_hook = optional_list_cards(fetcher)
    if cards_hook is None:
        raise ValueError(f"site {template.key!r} cannot re-list a {kind}")

    listing = export_layout.listing_dir(
        project_root, template, str(document.get("listing") or f"{kind}_{ref['id']}"),
    )
    listing.mkdir(parents=True, exist_ok=True)
    options = RunOptions(raw_input=str(document.get("source_url") or ref["id"]),
                         project_root=project_root, workers=workers, progress=progress)
    scan_options = dict(iter_options(options, listing, template))
    scan_options["export_dir"] = listing
    # The listing's own address, which a learned listing rule needs to be read again: it declares no
    # URL recipe, and the selection names where it came from.
    scan_options["target_url"] = str(document.get("source_url") or "")

    cards = list(cards_hook(template, kind, ref, scan_options))
    wanted = [card for card in cards if str(card.get("source_id")) in set(chosen)]
    missing = sorted(set(chosen) - {str(card.get("source_id")) for card in cards})
    if missing:
        progress(f"{len(missing)} selected id(s) are no longer listed: {missing[:5]}")
    if not wanted:
        raise ValueError("none of the selected works are still listed")
    progress(f"{len(wanted)} of {len(cards)} listed work(s) were selected")

    items, warnings, _listed = collect_items(
        fetcher, template, kind, ref, str(document.get("source_url") or ""),
        options, listing, progress, cards=wanted,
    )
    for warning in warnings:
        progress(f"warning: {warning}")

    records = [extract_work(template, item) for item in items]
    usable = [record for record in records if not canonical.missing_fields(record)]
    if len(usable) != len(records):
        progress(f"{len(records) - len(usable)} record(s) lacked the fields an import needs")
    if not usable:
        raise ValueError("no selected work could be read")
    records = usable

    from .runner import _refresh_dictionary

    _refresh_dictionary(export_root, records, progress)
    policy = taxonomy.load_tag_policy(export_root)
    records = [taxonomy.apply_policy_to_record(record, policy) for record in records]
    # Prefer the site's own downloader, and fall back to the shared one exactly
    # as a normal run does — otherwise a site without a hook silently lands
    # records with no covers.
    from .runner import _download_media

    _download_media(fetcher, template, records, listing, options)
    for record in records:
        canonical.scrub_fetch_urls(record)
        canonical.verify_local_files(record, listing)
        export_layout.write_json(
            export_layout.item_dir(listing, str(record["source_id"])) / "metadata.json",
            record,
        )
    manifest = export_layout.build_manifest(
        template, records, name=Path(listing).name, url=document.get("source_url"),
        origin={"kind": kind, "ref": ref["id"]}, extra={},
    )
    manifest = _selection_manifest(template, listing, manifest, records)
    export_layout.write_json(listing / "metadata.json", manifest)
    return listing


def _selection_manifest(template, listing: Path, manifest: dict[str, Any],
                        records: list[dict[str, Any]]) -> dict[str, Any]:
    from .runner import _accumulate, _accumulates
    if _accumulates(template, listing):
        return _accumulate(listing, manifest, records)
    return manifest


def main(argv: list[str] | None = None) -> int:
    import argparse

    from .runner import PROJECT_ROOT

    parser = argparse.ArgumentParser(
        prog="selection",
        description="Download the works a review selection names (drag a selection JSON here).",
    )
    parser.add_argument("selection", nargs="*", help="one or more selection_*.json files")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)
    args = parser.parse_args(argv)

    if not args.selection:
        parser.error("drag a selection_*.json onto this file (or pass its path)")

    failed = 0
    for name in args.selection:
        try:
            destination = run_selection(
                Path(name), project_root=args.project_root, workers=args.workers,
            )
            print(f"OK  {name} -> {destination}")
        except (ValueError, RegistryError) as error:
            print(f"[ERROR] {name}: {error}", file=sys.stderr)
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
