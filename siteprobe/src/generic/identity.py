"""Where a work's identity comes from — one reading, shared by the runtime and the Builder.

The plan's Phase C (§5-C) is that the *same* work URL yields the *same* id whether it is resolved as
a work target or narrowed out of a listing card, and that a listing's sort/page parameters never
change what a work is. Before this, two code paths decided that independently: the runtime's
`TargetRule.match` (a URL against the site's own pattern) and the Builder's card narrowing (a card's
link against the already-learned work pattern). They agreed by luck, not by construction.

So the pieces are here, once:

* `extract` — the runtime's reading of an id out of a URL: the declared `id_group`, else the first
  named group that matched, else the first positional group. A pattern that matches but captures
  nothing yields `None` (the tool's own rule: a target must name the work).
* `work_id` / `narrowing` — the Builder's reading of the *same* id out of a **card link**, plus the
  filter that reads exactly that id back at crawl time. A card link is often relative, so the path is
  what is matched; it is resolved against the page only when a rule asks for the absolute address.
* `candidates` — every target rule that claims a URL, so a genuine ambiguity is reported instead of a
  silent pick.

Nothing here folds case, rewrites an id, or changes an existing one: the plan is explicit that an
identity change can duplicate imports and must be shown, never done quietly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import unquote, urljoin, urlparse


def extract(url: str, pattern: re.Pattern[str] | None, *, id_group: str | None = None
            ) -> dict[str, str] | None:
    """The id a target pattern reads from a URL, with every named group beside it.

    A pattern may offer several ways to find the id, and only one branch captures. The declared group
    wins; else the first named group that actually matched; else the first positional group. A pattern
    that matches but captures nothing is `None` — "a target pattern must capture an id" is this tool's
    own rule, measured once as a learned search target that resolved through no code path at all while
    the adapter installed and reported success.
    """
    if pattern is None:
        return None
    found = pattern.search(url)
    if found is None:
        return None
    named = {key: value for key, value in found.groupdict().items() if value}
    if id_group and named.get(id_group):
        return {"id": named[id_group], **named}
    if named:
        first = next(iter(named.values()))
        return {"id": first, **named}
    if found.groups() and found.group(1):
        return {"id": found.group(1)}
    return None


def work_id(url: str, work_url_pattern: str, *, base: str | None = None) -> str | None:
    """The work id a card link holds, read by the site's already-learned work pattern.

    The same reading as `extract`, against a raw card href rather than an absolute URL — the pattern
    the Builder writes for a card keeps a relative path for exactly this reason. A **relative** href is
    resolved against `base` (the page it was read on) *before* matching, which is the order the plan
    fixes (§5-C): a card link is a path until it is made absolute, never an id glued onto a page.
    """
    target = url
    if base and not urlparse(url).scheme:
        target = urljoin(base, url)
    try:
        matched = re.compile(work_url_pattern, re.IGNORECASE).search(target)
    except re.error:
        return None
    if matched is None:
        return None
    if matched.groupdict().get("id") is not None:
        return matched.group("id")
    if matched.groups() and matched.group(1) is not None:
        return matched.group(1)
    return None


def narrowing(url: str, work_url_pattern: str, *, base: str | None = None
              ) -> tuple[str, int] | None:
    """The `(filter, group)` that reads the work id back out of a card link.

    Where the id lives decides the filter. Usually it is a path segment — `/video/<id>/<slug>`, where
    the id sits *before* a human slug and a naive "last segment" rule would read the slug. Sometimes it
    is a query parameter (`?id=…`), which no path-segment reading can find. Both are returned as a
    `filter` regex plus the group that holds the id, which is the vocabulary a card rule already uses.
    """
    identifier = work_id(url, work_url_pattern, base=base)
    if identifier is None:
        return None
    parsed = urlparse(url)
    path = parsed.path or url
    segments = [part for part in path.split("/") if part]
    if identifier in segments:
        index = segments.index(identifier)
        prefix = (re.escape(segments[index - 1]) + "/") if index else ""
        return r"(?:^|/)" + prefix + r"([^/?#]+)(?=/|[?#]|$)", 1
    # Not a path segment: a query id. The parameter's own name is the anchor, so the filter reads the
    # value of the parameter the id actually came from rather than any number in the link.
    for pair in parsed.query.split("&"):
        name, _, value = pair.partition("=")
        if name and unquote(value) == identifier:
            return r"[?&]" + re.escape(name) + r"=([^&#]+)", 1
    return None


@dataclass(frozen=True)
class Claim:
    """One target rule's answer for one URL."""

    kind: str
    identifier: str
    named: dict[str, str]


def candidates(url: str, rules: Iterable[tuple[str, re.Pattern[str] | None, str | None]]
               ) -> list[Claim]:
    """Every target rule that claims this URL, as `(kind, pattern, id_group)` triples.

    Two rules claiming one address with two different ids is a genuine ambiguity — the plan's
    `TARGET_ID_AMBIGUOUS`. Reported as a list so the caller can show both and let a person choose,
    rather than taking whichever rule the iteration happened to reach first.
    """
    found: list[Claim] = []
    for kind, pattern, id_group in rules:
        matched = extract(url, pattern, id_group=id_group)
        if matched is None:
            continue
        found.append(Claim(kind=kind, identifier=matched["id"],
                           named={key: value for key, value in matched.items() if key != "id"}))
    return found


def ambiguous(claims: list[Claim]) -> bool:
    """Whether two claims disagree about the id — the only case worth asking a person about."""
    return len({claim.identifier for claim in claims}) > 1


def absolute(href: str, page_url: str) -> str:
    """A card's address made absolute against the page it was read on.

    Ordering matters and the plan names it: a relative href is matched *as a path* first (that is how a
    card filter is written), and only the `detail_url` is made absolute — never "extract an id and then
    glue the page onto it".
    """
    return urljoin(page_url, href)
