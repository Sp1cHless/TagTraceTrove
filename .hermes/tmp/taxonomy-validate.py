"""Validate generated taxonomy artifacts for 18comic_vip and hanime1_me.

Usage: python taxonomy-validate.py <site_root> [<site_root> ...]

Checks the plan's output contract: full section set, tag policy shape,
no duplicate casefolded source keys, no blank canonical value, and a
representative Traditional->Simplified conversion.
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

SECTIONS = ["series", "authors", "characters", "types"]
REPRESENTATIVE = {
    "18comic_vip": [("AI繪圖", "AI绘图"), ("項圈", "项圈")],
    "hanime1_me": [("中野四葉", "中野四叶"), ("絕區零", "绝区零")],
}

failures: list[str] = []


def check(site: str, condition: bool, message: str) -> None:
    if not condition:
        failures.append(f"[{site}] {message}")


def validate(site_root: Path) -> None:
    site = site_root.name
    exports = site_root / "exports"
    taxonomy_path = exports / "taxonomy_dictionary.json"
    review_path = exports / "tag_review.csv"
    rows: list[dict[str, str]] = []

    check(site, taxonomy_path.exists(), "taxonomy_dictionary.json is missing")
    if not taxonomy_path.exists():
        return
    taxonomy = json.loads(taxonomy_path.read_text(encoding="utf-8"))
    check(site, isinstance(taxonomy, dict), "taxonomy root must be an object")

    for section in SECTIONS:
        value = taxonomy.get(section)
        check(site, isinstance(value, dict), f"section {section} must be an object")
        if not isinstance(value, dict):
            continue
        folded = [key.casefold() for key in value]
        check(site, len(folded) == len(set(folded)), f"section {section} has duplicate casefolded keys")
        blanks = [key for key, target in value.items() if not str(target or "").strip()]
        check(site, not blanks, f"section {section} has blank canonical values: {blanks[:5]}")

    tags = taxonomy.get("tags")
    check(site, isinstance(tags, dict), "tags must be an object")
    accepted = tags.get("accepted") if isinstance(tags, dict) else None
    rejected = tags.get("rejected") if isinstance(tags, dict) else None
    check(site, isinstance(accepted, dict), "tags.accepted must be an object")
    check(site, isinstance(rejected, list), "tags.rejected must be an array")
    if isinstance(accepted, dict):
        folded = [key.casefold() for key in accepted]
        check(site, len(folded) == len(set(folded)), "tags.accepted has duplicate casefolded keys")
        blanks = [key for key, target in accepted.items() if not str(target or "").strip()]
        check(site, not blanks, f"tags.accepted has blank canonical values: {blanks[:5]}")
        overlap = set(folded) & {str(tag).casefold() for tag in (rejected or [])}
        check(site, not overlap, f"tags appear as both accepted and rejected: {sorted(overlap)[:5]}")

    check(site, review_path.exists(), "tag_review.csv is missing")
    if review_path.exists():
        with review_path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            check(site, reader.fieldnames == ["tag", "decision", "zh_cn"], "review CSV header mismatch")
            rows = list(reader)
        untranslated = [row["tag"] for row in rows if not str(row.get("zh_cn") or "").strip()]
        check(site, not untranslated, f"pending rows without a Simplified target: {untranslated[:5]}")
        decided = [row for row in rows if str(row.get("decision") or "").strip()]
        check(site, not decided, f"review CSV keeps decided rows: {len(decided)}")

    flat: dict[str, str] = {}
    for section in SECTIONS:
        flat.update(taxonomy.get(section) or {})
    flat.update(accepted or {})
    # Undecided tags live only in the review CSV until a decision exists.
    for row in rows:
        flat.setdefault(row["tag"], str(row.get("zh_cn") or ""))
    for source, expected in REPRESENTATIVE.get(site, []):
        actual = flat.get(source)
        check(
            site,
            actual == expected,
            f"conversion {source!r} -> {actual!r}, expected {expected!r}",
        )

    # Hanime keeps its reviewed decisions and manual targets.
    if site == "hanime1_me":
        check(
            site,
            (accepted or {}).get("SPY×FAMILY間諜家家酒") == "SPYxFAMILY",
            "manual tag target SPY×FAMILY間諜家家酒 -> SPYxFAMILY was not preserved",
        )
        check(site, len(accepted or {}) == 205, f"accepted count changed: {len(accepted or {})}")
        check(site, len(rejected or []) == 20, f"rejected count changed: {len(rejected or [])}")

    counts = {section: len(taxonomy.get(section) or {}) for section in SECTIONS}
    print(
        f"{site}: sections={counts} "
        f"tags_accepted={len(accepted or {})} tags_rejected={len(rejected or [])} "
        f"pending={len(rows)}"
    )


def main() -> None:
    for argument in sys.argv[1:]:
        validate(Path(argument).resolve())
    if failures:
        print("\nFAILURES:")
        for failure in failures:
            print(" -", failure)
        raise SystemExit(1)
    print("\nOK: all taxonomy artifact checks passed")


if __name__ == "__main__":
    main()
