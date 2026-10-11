"""Text primitives both halves of the tool share.

Offline, deterministic, no network and no LLM:

* Traditional Chinese -> Simplified, using OpenCC's ``t2s`` config — the same one the three
  separate site tools used, so migrated dictionaries keep converting identically;
* character references, resolved once, for the values that reach the runtime as JSON.

They live here rather than in the builder because the *runtime* is the other caller: a rule
that reads a value and the candidate the page offered have to end up as the same string, and
the only way to keep them from drifting is to decode in one place.
"""

from __future__ import annotations

import html

from opencc import OpenCC

_CONVERTER = OpenCC("t2s")


def to_simplified(value: object) -> str:
    """Return the simplified form of ``value``; empty input stays empty."""
    return _CONVERTER.convert(str(value or ""))


def decode_entities(value: str) -> str:
    """Resolve character references once.

    Only the JSON-shaped channels need this. Markup text and attribute values have already
    been decoded by the parser, and decoding those a second time is how ``?w=1&copy=2``
    becomes ``?w=1©=2`` — a corruption this project has already paid for once. A JSON-LD
    block, though, is written inside a ``<script>``: the parser never touches its text, so
    the page's ``&amp;`` is still in the string when a rule reads it. Measured on a real
    site (agedm.io): the candidate the harvest offered carried ``&`` and the rule read back
    ``&amp;``, so the confirm page quoted a raw address where the list beside it said
    ``图片1`` — and the same picture would have been recorded under two spellings.
    """
    return html.unescape(value) if "&" in value else value
