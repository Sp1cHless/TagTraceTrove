"""Which page an address names, and whether another address is that same page with another number.

One home for page arithmetic, because two sides need it and they must agree: the Builder reads a
pager's links to learn a rule (`listing._numbered_pager`) and the runtime follows that rule page by
page (`extract`). A disagreement between them is a rule that is learned and then reads nothing.

The shapes are the three measured on real listings (2026-10-05):

* `…/2/` — the number as its own path segment (jable.tv's model pages);
* `…weekvisit_64-63_0_0_0_0_0_0_2_0.html` — one number *inside* the last segment, changed (bilinovel's
  ranking pages: the page number is the `2` in `_2_0`, and the last number in the path is a `0`, so
  "the last number" is not the page);
* `?page=2` — a page parameter (the shape `pagination_from` already learns from two addresses).
"""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse


def page_number_of(url: str | None) -> int | None:
    """Which page an address says it is, or `None` when it does not say.

    Read from the page parameter first (it says it outright), then from a path segment that **is** a
    number (`…/2/`). `None` matters: a pager whose number lives *inside* a segment
    (`…weekvisit_…2_0.html`, where the last number in the path is a `0`) cannot be walked by re-reading
    each address, and a walk that claimed to would be a false claim — the Builder only learns this form
    when every page says its own number (`listing._numbered_pager`).
    """
    if not url:
        return None
    parsed = urlparse(url)
    for values in parse_qs(parsed.query).values():
        if values and str(values[0]).strip().isdigit() and int(values[0]) > 0:
            return int(values[0])
    for segment in reversed([part for part in parsed.path.split("/") if part]):
        if segment.isdigit() and int(segment) > 0:
            return int(segment)
    return None


def is_page_address(current: str, candidate: str, number: int) -> bool:
    """Is `candidate` this address carrying `number` as its page?

    The judgement that keeps a pager honest: a footer's `2024` is a number and points somewhere else,
    and a link is only a page of *this* listing when the address is the same page shape with that one
    number changed (or that number appended, or that page parameter).
    """
    base, other = urlparse(current), urlparse(candidate)
    if base.netloc != other.netloc:
        return False
    if base.path != other.path:
        if other.path.startswith(base.path):
            # `…/2/` — the number appended as its own segment.
            if other.path[len(base.path):].strip("/") == str(number):
                return True
        if _skeleton(base.path) != _skeleton(other.path):
            return False
        # `…_2_0.html` — exactly one number inside the path changed, to this one.
        changed = [(was, now) for was, now in zip(_numbers(base.path), _numbers(other.path))
                   if was != now]
        return len(changed) == 1 and changed[0][1] == number
    # The same address, differing by a page parameter.
    return any(values and str(values[0]).strip().isdigit() and int(values[0]) == number
               for values in parse_qs(other.query).values())


def next_page_parameter(name: str, url: str | None) -> str | None:
    """This address with that page parameter one higher — page 1 may carry no parameter at all."""
    if not url:
        return None
    parsed = urlparse(url)
    query = parse_qs(parsed.query, keep_blank_values=True)
    values = query.get(name) or []
    current = int(values[0]) if values and str(values[0]).strip().isdigit() else 1
    query[name] = [str(current + 1)]
    return urlunparse(parsed._replace(query=urlencode(query, doseq=True)))


def _skeleton(path: str) -> str:
    """The path with every number replaced, so two addresses can be compared by shape."""
    return re.sub(r"\d+", "#", path)


def _numbers(path: str) -> list[int]:
    return [int(token) for token in re.findall(r"\d+", path)]
