"""Give the review page covers it can actually show.

Two independent reasons a card's remote cover URL fails in a browser, both seen on
real sites:

* the URL carries a **signed, expiring token** (hanime), which is required for the
  image to be served at all — the clean URL that belongs in the export returns 403;
* the CDN requires a **Referer** (hitomi), which a page opened from `file://` cannot
  send.

Downloading the cover once at review time removes both, and it is done for every
site rather than for the two that happen to need it today: the fetch goes through
the same code the export already uses, so whatever credentials that site's images
need are already handled there. It also makes the page durable — a page full of
hotlinked images goes blank as tokens expire, and a review you keep open for an
afternoon should not.

Cost is one image per work instead of four: the review needs a cover to look at,
not the preview set.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

COVER_DIR = "review_media"


def localize_covers(cards: list[dict[str, Any]], listing: Path, template: Any,
                    progress, *, fetch=None) -> int:
    """Fetch each card's cover next to the page and point the card at the file.

    Returns how many covers are now local. A card keeps its remote URL under
    `cover_source`, so nothing about the source is lost.
    """
    from . import media

    directory = listing / COVER_DIR
    referer = str(template.raw.get("url_base") or "") or None
    saved = 0
    pending = [card for card in cards if _remote_url(card)]
    if not pending:
        return 0
    progress(
        f"fetching {len(pending)} cover(s) for the review page "
        f"(one image each; the preview set is not touched)"
    )
    for index, card in enumerate(pending, start=1):
        url = _remote_url(card)
        card.setdefault("cover_source", url)
        path = media.download_image(
            url, directory, f"cover_{card.get('source_id')}",
            referer=referer, fetch=fetch,
        )
        if path is not None:
            # A relative path is what a page opened from the filesystem can load;
            # an absolute one would be read as a different origin.
            card["cover_url"] = f"{COVER_DIR}/{path.name}"
            width, height = image_size(path)
            if width and height:
                # The file is in hand, so the card can state its shape instead of
                # being forced into one: sites differ (hitomi portrait, hanime
                # landscape) and a fixed ratio crops or pads the wrong one.
                card["cover_width"] = width
                card["cover_height"] = height
            saved += 1
        elif not _is_remote(card.get("cover_url")):
            card.pop("cover_url", None)
        if index % 25 == 0:
            progress(f"  covers {index}/{len(pending)}")
    progress(f"{saved}/{len(pending)} cover(s) available for review")
    return saved


def image_size(path: Path) -> tuple[int, int]:
    """(width, height) of a downloaded cover, or (0, 0) when it cannot be read."""
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover - the media extra provides Pillow
        return 0, 0
    try:
        with Image.open(path) as image:
            return int(image.width), int(image.height)
    except Exception:  # noqa: BLE001 - an unreadable image simply has no shape
        return 0, 0


def _remote_url(card: dict[str, Any]) -> str:
    """The URL to fetch the cover from.

    `cover_fetch_url` comes first: a site puts the signed, working URL there and
    keeps the clean one in `cover_url` for the export, because the clean one is
    exactly what the CDN refuses.
    """
    preferred = str(card.get("cover_fetch_url") or "")
    if _is_remote(preferred):
        return preferred
    current = str(card.get("cover_url") or "")
    return current if _is_remote(current) else ""


def _is_remote(url: str) -> bool:
    return url.startswith(("http://", "https://"))
