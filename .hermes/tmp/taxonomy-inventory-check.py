"""Inventory-only backfill guard: fingerprint export data, then report artifacts.

Usage: python taxonomy-inventory-check.py <site_root> [--write <out.json>]

The fingerprint covers every file under exports/ EXCEPT the two generated
taxonomy artifacts, so a before/after comparison proves that an inventory-only
pass rewrote no extracted metadata.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

GENERATED = {"taxonomy_dictionary.json", "tag_review.csv"}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fingerprint(exports_root: Path) -> dict:
    entries: list[tuple[str, str]] = []
    metadata_count = 0
    for path in sorted(exports_root.rglob("*")):
        if not path.is_file() or path.name in GENERATED or path.name.startswith("."):
            continue
        rel = path.relative_to(exports_root).as_posix()
        entries.append((rel, sha256(path)))
        if path.name == "metadata.json":
            metadata_count += 1
    digest = hashlib.sha256(
        "\n".join(f"{rel}:{digest}" for rel, digest in entries).encode("utf-8")
    ).hexdigest()
    return {"fileCount": len(entries), "metadataCount": metadata_count, "aggregateSha256": digest}


def artifact_report(exports_root: Path) -> dict:
    report: dict = {}
    for name in sorted(GENERATED):
        path = exports_root / name
        report[name] = {
            "exists": path.exists(),
            "sha256": sha256(path) if path.exists() else None,
            "size": path.stat().st_size if path.exists() else 0,
        }
    return report


def main() -> None:
    site_root = Path(sys.argv[1]).resolve()
    exports_root = site_root / "exports"
    result = {
        "site": site_root.name,
        "exports": fingerprint(exports_root) if exports_root.exists() else None,
        "artifacts": artifact_report(exports_root) if exports_root.exists() else {},
    }
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if "--write" in sys.argv:
        out = Path(sys.argv[sys.argv.index("--write") + 1])
        out.write_text(text, encoding="utf-8")
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
