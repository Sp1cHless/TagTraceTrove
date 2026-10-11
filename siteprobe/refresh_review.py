"""Regenerate review pages that were written by an older version.

A review page is a pure function of its `cards.json`, so a fix to the page — a
cover that was being skipped, a card shape that was wrong — can be applied to
folders that already exist without crawling anything again. Re-running a search to
get a corrected page is a waste of the site's bandwidth and of the user's time.

    python refresh_review.py [export folder]     # default: every site group

The metadata a page needs is reconstructed from the folder it sits in: the export
group names the site, and the listing folder's prefix names the target kind.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder import paths  # noqa: E402
from src.generic import review  # noqa: E402
from src.generic.registry import discover  # noqa: E402

# listing folder prefix -> target kind; longest first so `sole_work` wins over
# a hypothetical `s`.
KIND_PREFIXES = (
    ("search_", "search"),
    ("artist_", "artist"),
    ("playlist_", "playlist"),
    ("favorites_", "favorite"),
    ("sole_work", "work"),
    ("single", "work"),
)


def kind_and_ref(listing: Path) -> tuple[str, str]:
    name = listing.name
    for prefix, kind in KIND_PREFIXES:
        if name.startswith(prefix):
            return kind, name[len(prefix):].lstrip("_") or name
    return "", name


def backfill_shapes(listing: Path, cards: list[dict]) -> int:
    """Fill in a cover's real size from the file, for cards written before it was
    recorded. The image is already on disk, so this costs a header read."""
    from src.generic import review_media

    filled = 0
    for card in cards:
        if card.get("cover_width") and card.get("cover_height"):
            continue
        url = str(card.get("cover_url") or "")
        if not url or url.startswith("http"):
            continue
        width, height = review_media.image_size(listing / url)
        if width and height:
            card["cover_width"], card["cover_height"] = width, height
            filled += 1
    return filled


def refresh(listing: Path, template) -> bool:
    cards_path = listing / review.CARDS_FILENAME
    if not cards_path.is_file():
        return False
    try:
        cards = json.loads(cards_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print(f"[WARN] unreadable cards: {cards_path}")
        return False
    if not isinstance(cards, list):
        return False
    shaped = backfill_shapes(listing, cards)
    if shaped:
        print(f"  filled in {shaped} cover shape(s)")
    kind, ref = kind_and_ref(listing)
    meta = {
        "source_site": template.source_site if template else "",
        "target_kind": kind,
        "target_ref": ref,
        "source_url": "",
        "language_tags": (template.raw.get("review") or {}).get("language_tags") or {}
        if template else {},
    }
    review.write_review(listing, cards, meta)
    return True


def main(argv: list[str] | None = None) -> int:
    root = Path(argv[0]) if argv else paths.home() / "export"
    if not root.is_absolute():
        root = PROJECT_ROOT / root
    if not root.is_dir():
        print(f"[ERROR] not a folder: {root}")
        return 2

    by_group = {template.export_group: template for template in discover()}
    refreshed = 0
    for cards_path in sorted(root.glob("**/cards.json")):
        listing = cards_path.parent
        group = None
        for part in listing.relative_to(root).parts:
            if part in by_group:
                group = by_group[part]
                break
        if refresh(listing, group):
            refreshed += 1
            print(f"refreshed {listing}")
    print(f"\n{refreshed} review page(s) rewritten from their cards; nothing was crawled")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
