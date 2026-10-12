"""Phase C's focused check (plan §5-C): one identity reading, and a listing cannot disagree with it.

The plan's completion for this phase is two sentences — *the same work URL yields the same id through
the work target and through a listing card*, and *sort and page parameters never change a listing's
identity* — and this file is that, as a finite input table with no network:

* an id that sits **before** a slug (`/video/<id>/<slug>`), where the naive "last segment" reads the
  slug and the work target reads the id;
* a **query** id (`?id=…`), which no path-segment reading can find;
* an **artist** listing whose `sort`/`page` parameters must not change the id;
* and the runtime's own matcher agreeing with the shared reading, by construction.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder.listing import target_rule_for_id  # noqa: E402
from src.generic import identity  # noqa: E402
from src.generic.template import TargetRule  # noqa: E402


def _read_by_filter(rule: dict, href: str) -> str | None:
    """Apply a card rule's own filter to a link, the way the runtime reads the id back."""
    found = re.search(rule["filter"][0], href)
    return found.group(rule["group"]) if found else None


def test_an_id_before_a_slug_is_the_id_not_the_slug():
    pattern = r"^https?://media\.test/video/(?P<id>[^/]+)(?:/[^/]+)?"
    url = "https://media.test/video/H9fsLsKTpR1Vcx/lucilla"
    assert identity.work_id(url, pattern) == "H9fsLsKTpR1Vcx"
    # Through a card link the way the Builder narrows one: the marked answer is the absolute address,
    # and the resulting filter is applied to the (relative) link at crawl time.
    rule = target_rule_for_id({"from": "html", "select": "a", "attr": "href"}, url, pattern)
    assert rule is not None
    assert _read_by_filter(rule, "/video/H9fsLsKTpR1Vcx/lucilla") == "H9fsLsKTpR1Vcx"
    # And a genuinely relative link is resolved against the page before matching (§5-C ordering).
    assert identity.narrowing("/video/H9fsLsKTpR1Vcx/lucilla", pattern,
                              base="https://media.test/") is not None


def test_a_query_id_is_read_even_though_it_is_not_a_path_segment():
    pattern = r"[?&]id=(?P<id>\d+)"
    url = "https://q.test/watch?id=123&sort=date"
    assert identity.work_id(url, pattern) == "123"
    rule = target_rule_for_id({"from": "html", "select": "a", "attr": "href"},
                              "/watch?id=123&sort=date", pattern)
    assert rule is not None
    assert _read_by_filter(rule, "/watch?id=123&sort=date") == "123"


def test_sort_and_page_parameters_do_not_change_a_listing_identity():
    pattern = r"^https?://media\.test/profile/(?P<id>[^/]+)"
    ids = {
        identity.work_id(f"https://media.test/profile/mingminga/videos?sort=date&page={page}", pattern)
        for page in (0, 1, 2, 7)
    }
    assert ids == {"mingminga"}, "the artist is the identity; the pager is not"


def test_the_work_target_and_a_card_agree_by_construction():
    """The runtime's matcher delegates to the shared reading, so the two cannot drift."""
    pattern = re.compile(r"^https?://media\.test/video/(?P<id>[^/]+)(?:/[^/]+)?")
    rule = TargetRule(kind="work", url_pattern=pattern, id_group=None, label="Work", single=True)
    url = "https://media.test/video/H9fsLsKTpR1Vcx/lucilla"
    assert rule.match(url) == identity.extract(url, pattern)
    assert rule.match(url)["id"] == identity.work_id(url, pattern.pattern)


def test_an_explicit_id_group_wins_and_a_positional_group_is_the_fallback():
    named = re.compile(r"^https?://s\.test/(?P<slug>[^/]+)/(?P<num>\d+)")
    assert identity.extract("https://s.test/hello/42", named, id_group="num")["id"] == "42"
    assert identity.extract("https://s.test/hello/42", named)["id"] == "hello", (
        "no declared group: the first named group that matched is the id")
    positional = re.compile(r"^https?://s\.test/work/(\d+)")
    assert identity.extract("https://s.test/work/42", positional)["id"] == "42"
    # A group literally named `id` is the id, whatever order it is declared in — the reading the
    # runtime has always had, kept by construction.
    two = re.compile(r"^https?://s\.test/(?P<slug>[^/]+)/(?P<id>\d+)")
    assert identity.extract("https://s.test/hello/42", two)["id"] == "42"


def test_a_pattern_that_captures_nothing_reads_no_id():
    """The tool's own rule: a target that names nothing is refused, not accepted with a whole URL."""
    assert identity.extract("https://s.test/work/42", re.compile(r"^https?://s\.test/work")) is None


def test_two_rules_claiming_two_ids_is_reported_as_ambiguous():
    claims = identity.candidates("https://s.test/work/42", [
        ("work", re.compile(r"^https?://s\.test/work/(?P<id>\d+)"), None),
        ("album", re.compile(r"^https?://s\.test/(?P<id>work)/42"), None),
    ])
    assert identity.ambiguous(claims) is True
    assert {claim.identifier for claim in claims} == {"42", "work"}


def test_an_id_is_never_case_folded():
    """The plan is explicit: an identity change can duplicate imports, so nothing rewrites an id."""
    pattern = r"^https?://s\.test/w/(?P<id>[^/]+)"
    assert identity.extract("https://s.test/w/AbC-123", re.compile(pattern))["id"] == "AbC-123"
    assert identity.work_id("https://s.test/w/AbC-123", pattern) == "AbC-123"


if __name__ == "__main__":  # pragma: no cover
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
