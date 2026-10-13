"""Named raw documents and the values read out of them.

A site's fetcher hands the generic layer a bundle of *raw documents* it acquired
(HTML pages, JSON payloads, plain text) and names each one. Nothing in this
module knows which site produced them, so the same code decodes a hitomi
``galleryinfo`` payload, a hanime playlist page and an 18comic album page.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from .htmltree import Element, parse_html

# A hitomi payload is JavaScript wrapping a JSON literal
# (`var galleryinfo = { ... };`). The wrapper is a site transport detail, so the
# template declares its shape rather than the loader guessing at it.
DEFAULT_JSON_WRAPPER = r"^\s*(?:var\s+\w+\s*=\s*)?(.*?)\s*;?\s*$"


class MissingDocumentError(KeyError):
    """A named source is absent, distinct from a malformed selector or payload."""


@dataclass
class Document:
    """One raw document plus the format hints the template declared for it."""

    name: str
    text: str
    format: str = "html"  # html | json | js | text
    url: str | None = None
    json_wrapper: str | None = None
    _json: Any = field(default=None, repr=False)
    _json_loaded: bool = field(default=False, repr=False)
    _tree: Element | None = field(default=None, repr=False)

    def json(self) -> Any:
        """Parsed JSON, unwrapped from a JavaScript assignment when needed."""
        if not self._json_loaded:
            payload = self.text
            if self.format == "js" or self.json_wrapper is not None:
                pattern = re.compile(self.json_wrapper or DEFAULT_JSON_WRAPPER, re.DOTALL)
                match = pattern.search(payload)
                if match is None:
                    raise ValueError(f"{self.name}: payload does not match the declared wrapper")
                payload = match.group(1) if match.groups() else match.group(0)
            self._json = json.loads(payload)
            self._json_loaded = True
        return self._json

    def html(self) -> Element:
        if self._tree is None:
            self._tree = parse_html(self.text)
        return self._tree

    @classmethod
    def from_element(cls, name: str, element: Element, url: str | None = None) -> "Document":
        """A document whose tree is already an element.

        Listing extraction uses this to re-scope the very same selector
        vocabulary to a single row: the row *is* the document.
        """
        document = cls(name=name, text="", format="html", url=url)
        document._tree = element
        return document


@dataclass
class DocumentBag:
    """The documents available while extracting one item."""

    documents: dict[str, Document] = field(default_factory=dict)

    def add(self, document: Document) -> None:
        self.documents[document.name] = document

    def get(self, name: str) -> Document | None:
        return self.documents.get(name)

    def require(self, name: str) -> Document:
        document = self.documents.get(name)
        if document is None:
            raise MissingDocumentError(
                f"template references document {name!r}, which the fetcher did not provide")
        return document

    def names(self) -> list[str]:
        return sorted(self.documents)


def html_document(name: str, text: str, url: str | None = None) -> Document:
    return Document(name=name, text=text, format="html", url=url)


def json_document(name: str, text: str, *, url: str | None = None,
                  wrapper: str | None = None, javascript: bool = False) -> Document:
    return Document(
        name=name,
        text=text,
        format="js" if javascript else "json",
        url=url,
        json_wrapper=wrapper,
    )
