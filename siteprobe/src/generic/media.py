"""Media download shared by every site.

Covers land in `items/<id>/cover/cover.<ext>` and previews in
`items/<id>/previews/<image_id>.<ext>`, the layout the T³ importer already
expects. The extension is taken from the file's magic bytes rather than from the
URL, because a site that serves WEBP under a `.jpg` name would otherwise produce a
file no image reader accepts.

An existing non-empty file short-circuits the download, which is what makes a
re-run resume instead of re-fetching an album's images.
"""

from __future__ import annotations

import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from . import canonical

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140 Safari/537.36"
)

_EXTENSIONS = (".webp", ".jpg", ".jpeg", ".png", ".avif", ".gif")


def detect_extension(data: bytes) -> str:
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return ".webp"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data[4:12] in (b"ftypavif", b"ftypavis"):
        return ".avif"
    if data.startswith(b"GIF8"):
        return ".gif"
    raise ValueError("response is not a supported image")


def existing(directory: Path) -> Path | None:
    """Any already-downloaded image in this directory, whatever its extension."""
    if not directory.is_dir():
        return None
    for path in directory.iterdir():
        if path.is_file() and path.suffix.lower() in _EXTENSIONS and path.stat().st_size > 0:
            return path
    return None


def fetch_bytes(url: str, *, referer: str | None = None, attempts: int = 3) -> bytes:
    """One image's bytes, read the way the page reader reads a page.

    The request impersonates a real browser when `curl_cffi` is installed — the same transport
    `unknown_url.fetch` uses — and falls back to plain urllib only when it is not. Reading pages and
    reading images through *different* transports is how a site that checks who is asking served the
    page to the reader and answered the image request with `403 Forbidden`: measured on a real
    bilinovel cover (2026-10-04), where the run finished, the export named the cover's URL, and no
    bytes had ever landed — the preview showed the picture from the site, the imported Entry had
    none. The import path can only store what is on disk (`site-probe-path.ts` refuses anything
    outside the export root), so a silent image failure is a cover nobody can recover later.
    """
    try:
        from curl_cffi import requests as curl_requests
    except ImportError:
        curl_requests = None

    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        headers = {"User-Agent": USER_AGENT,
                   "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                   "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}
        if referer:
            headers["Referer"] = referer
        try:
            if curl_requests is not None:
                response = curl_requests.get(url, impersonate="chrome", headers=headers,
                                             timeout=45, allow_redirects=True)
                data = response.content
            else:
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers),
                                            timeout=45) as response:
                    data = response.read()
            if not data:
                raise ValueError("empty response")
            return data
        except Exception as error:  # noqa: BLE001 - retried below
            last_error = error
        if attempt < attempts:
            time.sleep(1.5 * attempt)
    raise RuntimeError(f"failed to download {url}: {last_error}")


def download_image(url: str, directory: Path, stem: str, *,
                   referer: str | None = None,
                   fetch: Callable[[str], bytes] | None = None,
                   post_process: Callable[[Path], bool] | None = None) -> Path | None:
    """Save one image as `<directory>/<stem>.<ext>`; returns the path or None."""
    cached = existing(directory) if stem == "cover" else None
    if cached is not None and cached.stem == stem:
        return cached
    for path in directory.glob(f"{stem}.*") if directory.is_dir() else []:
        if path.is_file() and path.stat().st_size > 0:
            if post_process is not None:
                post_process(path)
            return path
    try:
        data = (fetch or (lambda target: fetch_bytes(target, referer=referer)))(url)
        extension = detect_extension(data)
    except Exception:  # noqa: BLE001 - a missing image never fails a record
        return None
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{stem}{extension}"
    path.write_bytes(data)
    if post_process is not None:
        post_process(path)
    return path


def download_record_media(record: dict[str, Any], item_directory: Path, *,
                          referer: str | None = None,
                          fetch: Callable[[str], bytes] | None = None,
                          post_process: Callable[[Path, str], bool] | None = None,
                          progress: Callable[[str], None] | None = None) -> dict[str, int]:
    """Fetch a record's cover and previews, filling in `local_path` in place."""
    stats = {"cover": 0, "previews": 0, "failed": 0}
    source_id = str(record.get("source_id") or "")

    cover = record.get("cover") or {}
    cover_url = cover.get("fetch_url") or cover.get("url") or cover.get("source_path")
    if cover_url:
        path = download_image(str(cover_url), item_directory / "cover", "cover",
                              referer=referer, fetch=fetch)
        if path is not None:
            canonical.attach_local_file(
                cover, stored_filename=path.name,
                local_path=f"items/{source_id}/cover/{path.name}",
            )
            record["cover"] = cover
            stats["cover"] = 1
        else:
            stats["failed"] += 1

    previews = record.get("preview_images") or []
    for index, preview in enumerate(previews, start=1):
        url = preview.get("fetch_url") or preview.get("url") or preview.get("source_path")
        if not url:
            continue
        if progress is not None:
            progress(f"    {source_id}: preview {index}/{len(previews)}")
        image_id = str(preview.get("image_id") or "preview")
        hook = None
        if post_process is not None:
            hook = lambda path, _id=image_id: post_process(path, _id)  # noqa: E731
        path = download_image(str(url), item_directory / "previews", image_id,
                              referer=referer, fetch=fetch, post_process=hook)
        if path is None:
            preview["failed"] = True
            stats["failed"] += 1
            continue
        canonical.attach_local_file(
            preview, stored_filename=path.name,
            local_path=f"items/{source_id}/previews/{path.name}",
        )
        stats["previews"] += 1

    return stats


def missing_media(records: list[dict[str, Any]], listing: Path) -> list[str]:
    """Works whose cover or previews are not on disk, named for the run summary."""
    gaps: list[str] = []
    for record in records:
        source_id = str(record.get("source_id") or "?")
        item_directory = item_directory_for(listing, source_id)
        missing: list[str] = []
        cover = record.get("cover") or {}
        if cover.get("url") or cover.get("source_path"):
            if existing(item_directory / "cover") is None:
                missing.append("cover")
        wanted = len(record.get("preview_images") or [])
        if wanted:
            have = len(list((item_directory / "previews").glob("*"))) \
                if (item_directory / "previews").is_dir() else 0
            if have < wanted:
                missing.append(f"previews {have}/{wanted}")
        if missing:
            gaps.append(f"{source_id} ({', '.join(missing)})")
    return gaps


def item_directory_for(listing: Path, source_id: str) -> Path:
    from .export_layout import item_dir

    return item_dir(listing, source_id)


def prune_unreferenced(item_directory: Path, record: dict[str, Any]) -> int:
    """Delete media files the record no longer references.

    The site decides which previews it shows, and that choice changes between
    requests, so a re-import legitimately names a different set. Without this the
    old files stay behind and the folder grows into something that looks like the
    whole work was fetched. Returns how many files were removed.
    """
    removed = 0
    keep: dict[str, set[str]] = {"cover": set(), "previews": set()}
    for entry in [record.get("cover")] + list(record.get("preview_images") or []):
        if not isinstance(entry, dict):
            continue
        local = str(entry.get("local_path") or "")
        if not local:
            continue
        folder, _, name = local.rpartition("/")
        key = "previews" if folder.endswith("previews") else "cover"
        if name:
            keep[key].add(name)
    for folder, names in keep.items():
        directory = item_directory / folder
        if not directory.is_dir():
            continue
        for path in directory.iterdir():
            if not path.is_file() or path.name in names:
                continue
            try:
                path.unlink()
                removed += 1
            except OSError:
                # Held by another process for a moment (the same `WinError 5` family the replace
                # retry exists for). It is stale media, it is unreferenced, and the next run prunes
                # it — none of which is worth failing a finished crawl over.
                continue
    return removed
