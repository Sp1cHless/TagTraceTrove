"""Where exports land, and in which shape.

The merged tool keeps each site's existing layout, split one level by site:

    export/<export_group>/<listing>/metadata.json
    export/<export_group>/<listing>/items/<source_id>/metadata.json
    export/<export_group>/<listing>/items/<source_id>/raw/...        (raw cache)
    export/<export_group>/<listing>/items/<source_id>/cover/...
    export/<export_group>/<listing>/items/<source_id>/previews/...
    export/<export_group>/taxonomy_dictionary.json
    export/<export_group>/tag_review.csv

Splitting by site is not cosmetic: the three tools each ship their own
`taxonomy_dictionary.json` and `tag_review.csv`, and those are *different*
dictionaries for *different* tag vocabularies. Sharing one would silently merge
18comic's tags with hanime's.

The manifest shape at `<listing>/metadata.json` is the one part that genuinely
differs per site, because the T³ importer accepts two distinct manifest forms and
tells them apart by their contents:

    id_list          hitomi   {"source_site", "items": ["3220586", ...]}
    embedded_items   hanime   {"source_site", "playlist_id", ..., "items": [{...}]}
                     18comic {"source_site", "收藏夹", "items": [{...}]}

So each site declares its own manifest in `site.json` rather than the writer
guessing. `origin` is added to every manifest, which is what feeds the update
cursor the three old tools never recorded.
"""

from __future__ import annotations

import json
import time
import re
from pathlib import Path
from typing import Any

from .template import SiteTemplate


def export_root(project_root: Path) -> Path:
    return project_root / "export"


def site_root(project_root: Path, template: SiteTemplate) -> Path:
    """Where this site's exports live — the *site's* group, not this file's field.

    `export_group` is a property of the site, but it is read off a file, and one key can carry two
    files that disagree: a rule set the Builder learned writes the key itself into `export_group`, so
    a learned adapter's runs landed in `export/<key>/` while the written adapter beside it — and the
    hand-written tools before that — wrote `export/<real group>/`. One site then had two export
    trees, and every scope-driven tool (`应用Tag审核`, `修复缺失封面预览`) saw only the half that
    matched the file it happened to pick. `site_identity` settles it per key.
    """
    from .registry import site_identity

    return export_root(project_root) / site_identity(template.key)["export_group"]


def safe_component(value: str, *, fallback: str = "item") -> str:
    """A filesystem-safe single path component.

    Windows rejects a handful of characters and dislikes trailing dots, and a
    listing named after a user's folder can contain either.
    """
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value or "")).strip().rstrip(".")
    cleaned = re.sub(r"\s+", "_", cleaned)
    return cleaned[:120] or fallback


def listing_dir(project_root: Path, template: SiteTemplate, name: str) -> Path:
    """Resolve a listing name, allowing one level of nesting.

    18comic's single-album layout lives under `single/<id>`, so a name may contain
    a slash. Each component is sanitized on its own rather than the whole string.
    """
    path = site_root(project_root, template)
    for part in str(name).split("/"):
        if part:
            path = path / safe_component(part, fallback="listing")
    return path


def item_dir(listing: Path, source_id: str) -> Path:
    return listing / "items" / safe_component(source_id, fallback="work")


def replace_with_retry(source: Path, target: Path, *, attempts: int = 4) -> None:
    """Rename, surviving the moment another process holds the target.

    Windows answers a replace onto a target held without `FILE_SHARE_DELETE` with
    `PermissionError: [WinError 5]` — measured on this machine: once on a site's tag dictionary, where
    it took down a finished crawl, and once on the *record* path, where the cost is a whole work's
    data. A scanner or an indexer holding a file for a few milliseconds is not a reason to give up, so
    the rename is retried briefly before it is allowed to fail.
    """
    for attempt in range(attempts):
        try:
            source.replace(target)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.2 * (attempt + 1))


def write_json(path: Path, payload: Any) -> None:
    """Atomic write: a half-written metadata.json must never be readable."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    replace_with_retry(temporary, path)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    replace_with_retry(temporary, path)


def build_manifest(template: SiteTemplate, records: list[dict[str, Any]],
                   *, name: str, url: str | None, origin: dict[str, Any] | None,
                   extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Assemble the listing manifest in this site's declared shape."""
    manifest = template.raw.get("manifest") or {}
    style = str(manifest.get("style") or "id_list")
    entries = [str(record.get("source_id")) for record in records]
    payload: dict[str, Any] = {
        "source_site": template.source_site,
        "items": entries if style == "id_list" else records,
        "item_count": len(records),
    }
    if origin:
        payload["origin"] = origin
    for key, value in (manifest.get("static_keys") or {}).items():
        payload[key] = value
    for key, template_value in (manifest.get("keys") or {}).items():
        payload[key] = _manifest_value(template_value, name=name, url=url, records=records)
    for key, value in (extra or {}).items():
        payload[key] = value
    # `schema_version` first for readability, matching the old 18comic manifest.
    if "schema_version" in payload:
        payload = {"schema_version": payload.pop("schema_version"), **payload}
    return payload


def _manifest_value(spec: Any, *, name: str, url: str | None,
                    records: list[dict[str, Any]]) -> Any:
    if not isinstance(spec, dict):
        return spec
    source = spec.get("from")
    if source == "name":
        return name
    if source == "url":
        return url
    if source == "item_count":
        return len(records)
    if source == "const":
        return spec.get("value")
    if source == "first_item":
        field = str(spec.get("field") or "")
        return records[0].get(field) if records else None
    raise ValueError(f"unsupported manifest key source {source!r}")
