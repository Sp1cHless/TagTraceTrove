"""The canonical export record.

This is the single vocabulary every site's tool now produces, and it is not
invented here: it is exactly the shape the T³ importer already consumes
(`apps/server/src/import/site-probe.ts`), so merging the three separate tools
cannot silently change what the library accepts. Keeping that contract fixed is
what makes the merge safe.

Field groups:

    source_site / source_id / title / detail_url     identity
    分类信息{作品,登场人物,分类标签,作者,作品类型}       classification
    language{code,name}                              language
    date_added / page_count / duration                 facts
    cover{...} / preview_images[...]                 media
    source_tags_raw / tags                           tag policy output
    video_url / author / keywords_raw                site extras (optional)
    origin                                           which listing this came from

`origin` is what feeds the update cursor added in migration 021. The three old
tools never emitted it, so every run they produced was an untracked crawl.
"""

from __future__ import annotations

import re
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlparse

CATEGORY_KEYS = ("作品", "登场人物", "分类标签", "作者", "作品类型")

# Template rule name -> canonical location. The template stays in English and
# this table is the only place the Chinese field names appear.
CATEGORY_FIELDS = {
    "works": "作品",
    "characters": "登场人物",
    "tags": "分类标签",
    "authors": "作者",
    "content_types": "作品类型",
}

# Required for a record to be usable by the importer.
REQUIRED_KEYS = ("source_site", "source_id", "title", "detail_url")


def empty_categories() -> dict[str, list[str]]:
    return {key: [] for key in CATEGORY_KEYS}


def media_id(prefix: str, source_id: str, *parts: str) -> str:
    return ":".join([prefix, source_id, *parts])


def filename_of(url: str | None) -> str | None:
    if not url:
        return None
    name = PurePosixPath(urlparse(url).path).name
    return name or None


def image_id_of(url: str | None) -> str | None:
    name = filename_of(url)
    return PurePosixPath(name).stem if name else None


def cover_record(
    *,
    prefix: str,
    source_id: str,
    url: str | None,
    source_path_key: str = "url",
) -> dict[str, Any] | None:
    """Build the cover object.

    `source_path_key` exists because the three tools historically disagreed:
    18comic and hitomi wrote `url`, hanime wrote `source_path`. The T³ importer
    reads `local_path` first and only falls back to the site URL for hanime, so
    both spellings are preserved rather than normalised away.
    """
    if not url:
        return None
    return {
        "media_id": media_id(prefix, source_id, "cover"),
        "source_filename": filename_of(url),
        "source_page": 1,
        source_path_key: url,
    }


def preview_records(*, prefix: str, source_id: str, urls: list[str]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for index, url in enumerate(urls):
        image_id = image_id_of(url) or f"{index + 1:05d}"
        records.append({
            "media_id": media_id(prefix, source_id, "preview", image_id),
            "image_id": image_id,
            "sequence": index + 1,
            "source_filename": filename_of(url),
            "url": url,
        })
    return records


def scrub_fetch_urls(record: dict[str, Any]) -> dict[str, Any]:
    """Drop the temporary download URL before the record is written.

    A site can hand back a signed, expiring image URL. It is needed to fetch the
    image and must never end up in the export, so it travels in `fetch_url` and is
    removed here — the same split the original hanime tool used, where the stored
    `source_path` had no `secure=` token while the download used one.
    """
    for entry in [record.get("cover"), *(record.get("preview_images") or [])]:
        if isinstance(entry, dict):
            entry.pop("fetch_url", None)
    return record


def verify_local_files(record: dict[str, Any], export_root: Path) -> list[str]:
    """Drop any media path whose file is not actually on disk.

    A record is written after the download step, but "the download ran" is not the
    same as "the file is there": a failed or interrupted transfer would otherwise
    leave a record asserting media that the library then cannot show. Returns the
    labels it dropped, so the caller can report them.
    """
    dropped: list[str] = []
    source_id = str(record.get("source_id") or "?")
    entries = [("cover", record.get("cover"))]
    entries += [("preview", preview) for preview in (record.get("preview_images") or [])]
    for kind, entry in entries:
        if not isinstance(entry, dict):
            continue
        local = str(entry.get("local_path") or "")
        if not local:
            continue
        if (export_root / local).is_file():
            continue
        entry.pop("local_path", None)
        entry.pop("stored_filename", None)
        dropped.append(f"{source_id}/{kind}")
    return dropped


def attach_local_file(entry: dict[str, Any], *, stored_filename: str, local_path: str) -> None:
    """Record a downloaded file on a cover or preview entry.

    `local_path` and `stored_filename` are deliberately absent until a file
    exists: the T³ importer declares them as optional strings, so writing
    `null` there is rejected outright, and an absent key is also the honest
    description of "fetched from the site, nothing kept locally yet".
    """
    entry["stored_filename"] = stored_filename
    entry["local_path"] = local_path


def local_path_for(*parts: str) -> str:
    """A POSIX path relative to the export root, the way every tool wrote it."""
    return "/".join(str(part) for part in parts if part not in (None, ""))


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def missing_fields(record: dict[str, Any]) -> list[str]:
    return [key for key in REQUIRED_KEYS if not record.get(key)]
