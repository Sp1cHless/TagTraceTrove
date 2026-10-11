"""The hand-off format between a site's fetcher and the generic extractor.

A fetcher's job is to acquire raw documents. It returns a ``RawBundle`` and
nothing else: no parsing, no canonical field names, no knowledge of the export
schema. The generic layer turns a bundle into canonical records. That is the
seam the whole merge is built on.

Adding a site therefore means writing a ``fetch.py`` that fills this structure,
plus a ``site.json`` that describes how to read what it fetched.
"""

from __future__ import annotations

import urllib.parse
from dataclasses import dataclass, field
from typing import Any


@dataclass
class RawItem:
    """One work's raw documents, already downloaded and named."""

    source_id: str
    # document name -> raw text. The template's `documents` section says what
    # format each name holds; the fetcher never interprets them.
    documents: dict[str, str] = field(default_factory=dict)
    # document name -> the URL it came from, so relative URLs can be resolved.
    urls: dict[str, str] = field(default_factory=dict)
    # Fields the listing already knew (a card's title/cover/author). Used as
    # fallbacks when the detail page does not carry them, which is how the old
    # tools behaved for hanime and 18comic favourite cards.
    card: dict[str, Any] = field(default_factory=dict)
    target_url: str | None = None

    def add(self, name: str, text: str, url: str | None = None) -> None:
        self.documents[name] = text
        if url:
            self.urls[name] = url


@dataclass
class RawBundle:
    """Everything one run acquired, waiting to be interpreted."""

    template_key: str
    target_kind: str
    # The site-native identifier of the listing: an artist slug, a folder id.
    target_ref: str
    target_url: str | None = None
    display_name: str | None = None
    items: list[RawItem] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def origin(self) -> dict[str, Any] | None:
        """The `origin` block the T³ importer turns into an update cursor."""
        if not self.target_ref:
            return None
        origin: dict[str, Any] = {"kind": _ORIGIN_KIND.get(self.target_kind, self.target_kind),
                                  "ref": self.target_ref}
        if self.display_name:
            origin["display_name"] = self.display_name
        # The importer declares `origin.url` as a URL, so a name-shaped input
        # (hitomi accepts a bare artist name) must not leak into it. Omitting is
        # correct: the name is already carried by `ref` and `display_name`.
        if self.target_url and self.target_url.startswith(("http://", "https://")):
            # Only the fragment goes: a copied work link carries a `#page` anchor
            # that is not part of the identity, while a query often *is* one
            # (`?list=535566` names a playlist).
            origin["url"] = urllib.parse.urlsplit(self.target_url)._replace(
                fragment=""
            ).geturl()
        return origin


# The T³ side accepts artist / folder / work / search. Site tools that name a
# listing differently (playlist, album, favorite) map onto the closest of those
# so the cursor stays comparable across sites.
_ORIGIN_KIND = {
    "playlist": "folder",
    "album": "work",
    "favorite": "folder",
}
