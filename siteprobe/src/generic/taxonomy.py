"""Tag review: the dictionary, the review sheet, and the 保留/屏蔽 decisions.

All three site tools had grown their own copy of this pipeline with the same two
files, the same four columns and the same decision words. This is the merged
version, kept generic: it operates on canonical records, so it does not care which
site produced them.

Per site group, under ``export/<export_group>/``:

    taxonomy_dictionary.json   {series, authors, characters, types,
                                tags: {accepted: {source: zh_cn}, rejected: [...]}}
    tag_review.csv             `tag,decision,zh_cn`, UTF-8 BOM, undecided rows only

Keys are always the *source spelling*; values are the simplified form produced by
OpenCC ``t2s``. A hand-written value in the dictionary is never overwritten by
conversion, which is what makes the dictionary worth curating.

Decisions accepted in the CSV: ``保留`` / ``accept`` / ``keep`` / ``白名单`` and
``屏蔽`` / ``reject`` / ``drop`` / ``删除`` / ``黑名单``. A blank decision stays
pending, and pending tags are never silently accepted.

One behaviour was unified deliberately. The old tools disagreed about whether
``分类信息.分类标签`` is filtered by the dictionary: hitomi and 18comic kept only
accepted tags there, hanime left every tag in. Since that field is exactly what
the library imports as the Entry's tags, this version filters it everywhere,
keeping `source_tags_raw` as the place where pending tags remain visible.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import time
import tempfile
from pathlib import Path
from typing import Any, Iterable

from .text_normalization import to_simplified

TAXONOMY_FILENAME = "taxonomy_dictionary.json"
REVIEW_FILENAME = "tag_review.csv"
CSV_FIELDS = ["tag", "decision", "zh_cn"]

DEFAULT_SECTIONS: dict[str, dict[str, str]] = {
    "series": {}, "authors": {}, "characters": {}, "types": {},
}

# canonical record path -> dictionary section
SECTION_FIELDS = {
    "作品": "series",
    "作者": "authors",
    "登场人物": "characters",
    "作品类型": "types",
}

ACCEPT_DECISIONS = {"accept", "accepted", "keep", "yes", "y", "保留", "白名单"}
REJECT_DECISIONS = {"reject", "rejected", "drop", "no", "n", "屏蔽", "删除", "黑名单"}


def taxonomy_path(group_root: Path) -> Path:
    return group_root / TAXONOMY_FILENAME


def review_path(group_root: Path) -> Path:
    return group_root / REVIEW_FILENAME


def normalize_tag(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


# --- reading and writing -------------------------------------------------- #

def _atomic_text(path: Path, text: str, *, attempts: int = 4) -> None:
    """Write a file atomically, and survive the moment another process has it open.

    Windows refuses a replace onto a target someone else holds without `FILE_SHARE_DELETE`, and the
    answer is `PermissionError: [WinError 5]` — measured on this machine, on a real run whose records
    were already written, where the *dictionary* could not be replaced and the whole crawl was
    reported as a crash. A scanner or an indexer holding a file for a few milliseconds is not a
    reason to fail, so the replace is retried briefly before giving up.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
        for attempt in range(attempts):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                if attempt == attempts - 1:
                    raise
                time.sleep(0.2 * (attempt + 1))
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def read_taxonomy(group_root: Path) -> dict[str, Any]:
    path = taxonomy_path(group_root)
    if not path.is_file():
        return {}
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return document if isinstance(document, dict) else {}


def write_taxonomy(group_root: Path, document: dict[str, Any]) -> None:
    _atomic_text(taxonomy_path(group_root), json.dumps(document, ensure_ascii=False, indent=2) + "\n")


def load_tag_policy(group_root: Path) -> dict[str, Any]:
    """The accepted/rejected maps, with empty translations filled by OpenCC."""
    document = read_taxonomy(group_root)
    tags = document.get("tags") or {}
    accepted: dict[str, str] = {}
    for source, translated in (tags.get("accepted") or {}).items():
        source = normalize_tag(source)
        if source:
            accepted[source.casefold()] = str(translated or "").strip() or to_simplified(source)
    rejected = {
        normalize_tag(value).casefold()
        for value in (tags.get("rejected") or [])
        if normalize_tag(value)
    }
    return {"accepted": accepted, "rejected": rejected}


def read_review(group_root: Path) -> list[dict[str, str]]:
    path = review_path(group_root)
    if not path.is_file():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        return [dict(row) for row in csv.DictReader(stream)]


def write_review(group_root: Path, rows: Iterable[dict[str, str]]) -> None:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=CSV_FIELDS, lineterminator="\r\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({field: row.get(field, "") for field in CSV_FIELDS})
    # The BOM is kept because these sheets are edited in Excel, which otherwise
    # mangles the Chinese columns on save.
    _atomic_text(review_path(group_root), "\ufeff" + buffer.getvalue())


# --- decisions ------------------------------------------------------------ #

def _classified_tags(group_root: Path) -> set[str]:
    policy = load_tag_policy(group_root)
    return set(policy["accepted"]) | set(policy["rejected"])


def apply_decisions(group_root: Path) -> None:
    """Fold the review sheet's decisions into the dictionary."""
    document = read_taxonomy(group_root)
    tags = document.setdefault("tags", {})
    accepted = tags.setdefault("accepted", {})
    rejected = tags.setdefault("rejected", [])
    rejected_folded = {normalize_tag(value).casefold() for value in rejected}

    changed = False
    for row in read_review(group_root):
        tag = normalize_tag(row.get("tag"))
        if not tag:
            continue
        decision = normalize_tag(row.get("decision")).casefold()
        if decision in ACCEPT_DECISIONS:
            translated = normalize_tag(row.get("zh_cn")) or to_simplified(tag)
            if accepted.get(tag) != translated:
                accepted[tag] = translated
                changed = True
            if tag.casefold() in rejected_folded:
                rejected[:] = [value for value in rejected if normalize_tag(value).casefold()
                               != tag.casefold()]
                rejected_folded.discard(tag.casefold())
                changed = True
        elif decision in REJECT_DECISIONS:
            if tag.casefold() not in rejected_folded:
                rejected.append(tag)
                rejected_folded.add(tag.casefold())
                changed = True
            # A tag moved to rejected must not stay accepted, or the dictionary
            # would claim both and the record filter depends on the order.
            if tag in accepted:
                del accepted[tag]
                changed = True
        elif decision == "":
            continue
        else:
            raise ValueError(
                f"tag_review.csv: unknown decision {decision!r} for tag {tag!r} "
                f"(use 保留/accept or 屏蔽/reject)"
            )

    document["tags"] = {"accepted": accepted, "rejected": rejected}
    write_taxonomy(group_root, document)


def _record_paths(group_root: Path) -> list[Path]:
    """Every item record under a site group, whatever its listing folders are."""
    if not group_root.is_dir():
        return []
    return sorted(
        path for path in group_root.glob("**/items/*/metadata.json")
        if path.is_file() and "_scramble_backup" not in path.parts
    )


def _record_tags(record: dict[str, Any]) -> list[str]:
    categories = record.get("分类信息") or {}
    tags = [normalize_tag(value) for value in (record.get("source_tags_raw") or [])]
    if not tags:
        tags = [normalize_tag(value) for value in (categories.get("分类标签") or [])]
    return [tag for tag in tags if tag]


def refresh_review(group_root: Path, records: Iterable[dict[str, Any]]) -> None:
    """Add newly seen tags to the sheet, and rebuild the dictionary sections."""
    apply_decisions(group_root)
    document = read_taxonomy(group_root)
    tags = document.setdefault("tags", {})
    accepted = tags.setdefault("accepted", {})
    rejected = tags.setdefault("rejected", [])
    classified = {normalize_tag(key).casefold() for key in accepted}
    classified |= {normalize_tag(value).casefold() for value in rejected}

    # Sections accumulate across every listing folder in this site group, so a
    # translation decided once is inherited by later imports.
    for canonical_key, section in SECTION_FIELDS.items():
        target = document.setdefault(section, {})
        if not isinstance(target, dict):
            target = {}
        for record in records:
            values = (record.get("分类信息") or {}).get(canonical_key) or []
            for value in values:
                text = normalize_tag(value)
                if not text or text in target:
                    continue
                target[text] = to_simplified(text)
        document[section] = target

    pending: list[dict[str, str]] = []
    seen: set[str] = set()
    for record in records:
        for tag in _record_tags(record):
            folded = tag.casefold()
            if folded in classified or folded in seen:
                continue
            seen.add(folded)
            pending.append({"tag": tag, "decision": "", "zh_cn": to_simplified(tag)})
    # Keep decisions the user already typed but has not applied yet.
    for row in read_review(group_root):
        tag = normalize_tag(row.get("tag"))
        folded = tag.casefold()
        if not tag or folded in classified or folded in seen:
            continue
        seen.add(folded)
        pending.append({"tag": tag, "decision": row.get("decision", ""),
                        "zh_cn": row.get("zh_cn") or to_simplified(tag)})

    document["tags"] = {"accepted": accepted, "rejected": rejected}
    write_taxonomy(group_root, document)
    write_review(group_root, sorted(pending, key=lambda row: row["tag"].casefold()))


def apply_policy_to_record(record: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    """Filter a record's tags by the dictionary.

`分类标签` is what the library imports, so it drops every 屏蔽 tag but keeps the
ones still awaiting review; keeping only accepted tags would import nothing at all
from a fresh library whose dictionary is empty, which is the wrong first run.
Verified against hitomi's own exporter output on 620 recorded works.

`tags` stays the accepted-only subset, so a caller that wants the reviewed
vocabulary alone can have it without re-reading the dictionary.
"""
    rejected = policy["rejected"]
    accepted = policy["accepted"]
    result = json.loads(json.dumps(record, ensure_ascii=False))
    raw = [tag for tag in _record_tags(record) if tag.casefold() not in rejected]
    result["source_tags_raw"] = raw
    result["tags"] = [tag for tag in raw if tag.casefold() in accepted]
    categories = result.setdefault("分类信息", {})
    categories["分类标签"] = list(raw)
    return result


def apply_review_to_exports(group_root: Path) -> int:
    """Offline pass: re-apply the dictionary to every record already written."""
    apply_decisions(group_root)
    policy = load_tag_policy(group_root)
    records: list[dict[str, Any]] = []
    paths = _record_paths(group_root)
    for path in paths:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            records.append(record)
    refresh_review(group_root, records)

    updated = 0
    for path in paths:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict):
            continue
        replaced = apply_policy_to_record(record, policy)
        if replaced != record:
            path.write_text(json.dumps(replaced, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")
            updated += 1
    return updated
