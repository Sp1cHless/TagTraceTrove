"""Crawl state belongs to the crawl, not to the library.

Deciding "do I need to fetch this again" happens when crawling to local, at which
point T³ may not be involved at all. Keeping the cursor in the library database
therefore got the layering wrong: crawling a folder and *not* importing it left no
record, so the next crawl fetched the same works again.

So a site's crawl state lives in its own export tree, next to the taxonomy:

    export/<site>/crawl_state.json

Two things are recorded per listing, because they answer different questions:

* **the inventory** — which works this listing already has on disk, derived from
  `items/<id>/` itself rather than tracked separately, so it cannot drift from what
  is actually there;
* **the cursor** — the newest work seen, for reporting and for the library side to
  read later without re-listing.

The inventory is what trimming uses. A cursor alone would be a guess about order
(the user's own spec), while an inventory is the exact answer: this work is on
disk, that one is not.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

STATE_FILENAME = "crawl_state.json"


@dataclass
class ListingState:
    """One crawled listing: what it already holds, and how far it has been read."""

    source_kind: str
    source_ref: str
    display_name: str | None = None
    url: str | None = None
    source_ids: list[str] = field(default_factory=list)
    last_seen_source_id: str | None = None
    last_seen_work_date: str | None = None
    last_seen_order_key: str | None = None
    crawl_count: int = 0
    first_crawled_at: str | None = None
    last_crawled_at: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "source_kind": self.source_kind,
            "source_ref": self.source_ref,
            "display_name": self.display_name,
            "url": self.url,
            "source_ids": self.source_ids,
            "last_seen_source_id": self.last_seen_source_id,
            "last_seen_work_date": self.last_seen_work_date,
            "last_seen_order_key": self.last_seen_order_key,
            "crawl_count": self.crawl_count,
            "first_crawled_at": self.first_crawled_at,
            "last_crawled_at": self.last_crawled_at,
        }


def state_path(site_root: Path) -> Path:
    return site_root / STATE_FILENAME


def load(site_root: Path) -> dict[str, ListingState]:
    """Every listing this site has crawled, keyed by `kind/ref`."""
    path = state_path(site_root)
    if not path.is_file():
        return {}
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    listings = document.get("listings") if isinstance(document, dict) else None
    if not isinstance(listings, dict):
        return {}
    restored: dict[str, ListingState] = {}
    for key, raw in listings.items():
        if not isinstance(raw, dict):
            continue
        restored[key] = ListingState(
            source_kind=str(raw.get("source_kind") or ""),
            source_ref=str(raw.get("source_ref") or ""),
            display_name=raw.get("display_name"),
            url=raw.get("url"),
            source_ids=[str(value) for value in (raw.get("source_ids") or [])],
            last_seen_source_id=raw.get("last_seen_source_id"),
            last_seen_work_date=raw.get("last_seen_work_date"),
            last_seen_order_key=raw.get("last_seen_order_key"),
            crawl_count=int(raw.get("crawl_count") or 0),
            first_crawled_at=raw.get("first_crawled_at"),
            last_crawled_at=raw.get("last_crawled_at"),
        )
    return restored


def save(site_root: Path, listings: dict[str, ListingState]) -> None:
    site_root.mkdir(parents=True, exist_ok=True)
    document = {
        "schema_version": 1,
        "listings": {key: value.to_json() for key, value in sorted(listings.items())},
    }
    from .export_layout import replace_with_retry

    temporary = state_path(site_root).with_suffix(".json.tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n",
                         encoding="utf-8")
    replace_with_retry(temporary, state_path(site_root))


def listing_key(kind: str, ref: str) -> str:
    return f"{kind}/{ref}"


def recorded_ids(site_root: Path, kind: str, ref: str) -> set[str]:
    """What the state file says this listing has already seen.

    The disk is still the first answer, but it is not the only one: the whole export
    tree can be lost while the library that consumed it is intact, and then "we have
    this already" lives nowhere the crawler looks. That is how a full re-crawl became
    the only way back on 2026-09-19.
    """
    listing = load(site_root).get(listing_key(kind, ref))
    return set(listing.source_ids) if listing is not None else set()


def local_work_ids(listing: Path, recorded: Iterable[str] = ()) -> set[str]:
    """The works this listing already holds: the ones on disk, plus the ones recorded.

    On disk is the answer that cannot drift — a work on disk is a directory with its
    metadata. The record is the answer that survives the disk being gone, and it
    cannot drift either: the library deletes its own record of a work when the work
    itself is deleted, so the two stay in step. The union is therefore never wrong,
    only more informed, and it is what keeps a lost export tree from costing a full
    re-crawl of everything.
    """
    items = listing / "items"
    found: set[str] = set()
    if items.is_dir():
        for item in items.iterdir():
            if item.is_dir() and (item / "metadata.json").is_file():
                found.add(item.name)
    found.update(recorded)
    return found


def crawl_clock() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def record(site_root: Path, *, kind: str, ref: str, local_ids: Iterable[str],
           seen: Iterable[tuple[str, str | None]], display_name: str | None = None,
           url: str | None = None, order_key: Any = None) -> ListingState:
    """Update one listing's state after a crawl.

    `local_ids` is the inventory after the run (everything on disk now, old and
    new). `seen` is what this run listed, as (source_id, work_date), which is what
    the cursor is computed from.
    """
    listings = load(site_root)
    key = listing_key(kind, ref)
    existing = listings.get(key) or ListingState(source_kind=kind, source_ref=ref)
    previous_key = existing.last_seen_order_key or ""

    best = previous_key
    best_id = existing.last_seen_source_id
    best_date = existing.last_seen_work_date
    for source_id, work_date in seen:
        candidate = order_key(source_id, work_date) if callable(order_key) else str(source_id)
        if candidate > best:
            best, best_id, best_date = candidate, source_id, work_date

    now = crawl_clock()
    updated = ListingState(
        source_kind=kind,
        source_ref=ref,
        display_name=display_name or existing.display_name,
        url=url or existing.url,
        source_ids=sorted({str(value) for value in local_ids}),
        last_seen_source_id=best_id,
        last_seen_work_date=best_date,
        last_seen_order_key=best or None,
        crawl_count=existing.crawl_count + 1,
        first_crawled_at=existing.first_crawled_at or now,
        last_crawled_at=now,
    )
    listings[key] = updated
    try:
        save(site_root, listings)
    except OSError:
        # The cursor is an inventory of what has been crawled, and everything it describes is already
        # on disk. Windows refuses the write while another process holds the file for a moment (the
        # same `WinError 5` family the export writers retry for), and the cost of losing the update is
        # that the next run lists the same works again — not a reason to fail a finished crawl.
        pass
    return updated
