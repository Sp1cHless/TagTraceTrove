"""Run existing tools against a set of URLs and report what they return.

No extraction logic here — it only invokes `gallery-dl` and `yt-dlp` and summarises
their own machine-readable output, so the comparison is between those tools and not
between my parsing and theirs.

    python compare_tools.py <url> [<url> ...]
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

VENV_PY = Path(sys.executable)
TOOLS = {
    "gallery-dl": [str(VENV_PY), "-m", "gallery_dl", "-j", "--no-colors"],
    "yt-dlp": [str(VENV_PY), "-m", "yt_dlp", "--dump-single-json", "--no-warnings",
               "--no-playlist", "--skip-download"],
}
TIMEOUT = 60


def run(command: list[str], url: str) -> tuple[int, str, str]:
    try:
        done = subprocess.run(command + [url], capture_output=True, text=True,
                              timeout=TIMEOUT, encoding="utf-8", errors="replace")
        return done.returncode, done.stdout, done.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {TIMEOUT}s"


def summarize_gallery_dl(stdout: str) -> dict:
    """gallery-dl -j emits one JSON document per file, then one per gallery."""
    items = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    if not items:
        return {"items": 0}
    first = items[0]
    present = sorted(key for key, value in first.items() if value not in (None, "", [], {}))
    return {
        "items": len(items),
        "category": first.get("category"),
        "subcategory": first.get("subcategory"),
        "fields": present,
        "title": str(first.get("title") or "")[:60],
        "artist": first.get("artist") or first.get("user") or first.get("author"),
        "tags": (first.get("tags") or [])[:6],
        "date": first.get("date"),
        "image": str(first.get("url") or first.get("file_url") or "")[:80],
    }


def summarize_yt_dlp(stdout: str) -> dict:
    try:
        document = json.loads(stdout)
    except json.JSONDecodeError:
        return {"items": 0}
    if not isinstance(document, dict):
        return {"items": 0}
    entries = document.get("entries") or [document]
    first = entries[0] if entries else {}
    keys = sorted(key for key, value in first.items() if value not in (None, "", [], {}))
    return {
        "items": len(entries),
        "extractor": document.get("extractor") or document.get("extractor_key"),
        "title": str(first.get("title") or "")[:60],
        "uploader": first.get("uploader") or first.get("channel") or first.get("creator"),
        "tags": (first.get("tags") or [])[:6],
        "thumbnail": str(first.get("thumbnail") or "")[:80],
        "upload_date": first.get("upload_date"),
        "field_count": len(keys),
    }


def main(argv: list[str]) -> int:
    for url in argv:
        print(f"\n=== {url}")
        for name, command in TOOLS.items():
            code, stdout, stderr = run(command, url)
            if code != 0:
                reason = (stderr.strip().splitlines() or ["no output"])[-1][:90]
                print(f"  {name:11} exit={code}  {reason}")
                continue
            summary = summarize_gallery_dl(stdout) if name == "gallery-dl" else summarize_yt_dlp(stdout)
            print(f"  {name:11} exit=0  {json.dumps(summary, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
