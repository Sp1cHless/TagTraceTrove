"""Phase 7: do the learned card rules read the same cards the runtime reads?

The plan's §2.3 asks for ten things; this file is the ones that can be checked without a
network. The fixture is a listing of three cards, and the field rules are written the way
the card annotation would produce them — which is the whole design of the phase: a card is
harvested as a page, so its rules are already row-scoped and need no translation.

The pagination cases are the plan's §17 order: a URL parameter, an explicit next link, a
numbered list — and, deliberately, the two it says must be reported rather than
approximated: no second page, and a page whose page 2 comes from a button.

Run:  .venv/Scripts/python.exe -m pytest -q
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder import text as l10n                                      # noqa: E402
from src.builder.annotate import LISTING_FIELDS, hypotheses, page       # noqa: E402
from src.builder.capture import Capture, Document, plain_documents      # noqa: E402
from src.builder.cards import card_page, cards_of                      # noqa: E402
from src.builder.harvest import harvest                               # noqa: E402
from src.builder.learn import Sample, learn                           # noqa: E402
from src.builder.listing import (                                      # noqa: E402
    _as_shipped,
    _rows,
    _score_over_cards,
    _values_over_rows,
    card_rule_for_id,
    cards_as_read_by_the_runtime,
    check_over_cards,
    id_rule_for,
    listing_draft,
    pagination_from,
    listing_rules,
    rule_from,
    target_rule_for_id,
)
from src.generic.document import Document as RuntimeDocument           # noqa: E402
from src.generic.document import DocumentBag                           # noqa: E402
from src.generic.select import resolve                                 # noqa: E402

BASE = "https://fixture.test"
LISTING = (PROJECT_ROOT / "fixtures" / "repeated_listing" / "page.html").read_text(
    encoding="utf-8")

NEXT_LINK = """<!doctype html><html><body>
  <ul id="grid">
    <li class="card"><a href="/work/1"><h3>First</h3></a><img src="/c/1.jpg"></li>
    <li class="card"><a href="/work/2"><h3>Second</h3></a><img src="/c/2.jpg"></li>
    <li class="card"><a href="/work/3"><h3>Third</h3></a><img src="/c/3.jpg"></li>
  </ul>
  <a class="next" rel="next" href="/list?page=2">Next</a>
</body></html>"""

NUMBERED = """<!doctype html><html><body>
  <ul class="pagination">
    <li><a href="/list?page=1">1</a></li><li><a href="/list?page=2">2</a></li>
    <li><a href="/list?page=3">3</a></li>
  </ul>
</body></html>"""

BUTTON_ONLY = """<!doctype html><html><body>
  <div class="grid"><div class="card"><a href="/w/1">A</a><img src="/c/1.jpg"></div>
  <div class="card"><a href="/w/2">B</a><img src="/c/2.jpg"></div>
  <div class="card"><a href="/w/3">C</a><img src="/c/3.jpg"></div></div>
  <button id="load-more">Load more</button>
</body></html>"""


def card_fields() -> dict:
    """The field rules a person marking one card would produce."""
    return {
        "source_id": id_rule_for("/work/1"),
        "title": {"from": "html", "select": "h3", "text": True},
        "cover_url": {"from": "html", "select": "img", "attr": "src", "absolute": True},
    }


def bag_of(html: str) -> DocumentBag:
    bag = DocumentBag()
    bag.add(RuntimeDocument(name="page", text=html, format="html"))
    return bag


def test_the_id_comes_out_of_the_link_the_card_carries():
    """Written the way the hand-written sites write theirs: the address's own shape, with
    its number turned into a capture group."""
    rule = id_rule_for("/album/1472965/?series_sort=2")

    assert resolve(rule, bag_of('<a href="/album/1472965/?series_sort=2">x</a>'),
                   context={"url": BASE}) == "1472965"


def test_the_card_selector_becomes_the_row_selector():
    group = cards_of(LISTING)[0]
    rule = rule_from(group, card_fields())

    assert rule["row_selector"] == "li.card"
    assert rule["fields"]["title"]["select"] == "h3"
    assert rule["_builder"]["cards"] == 3
    assert rule["_builder"]["missing"] == []


def test_a_rule_naming_the_row_is_dropped_not_shipped():
    """Inside a row, `li.card` names nothing at all — the row *is* that element. The card's
    own selector turns up among the learned rules because a card is a `<li>` and a `<li>` is
    one of the prose blocks the harvester reads."""
    group = cards_of(LISTING)[0]
    fields = {**card_fields(), "title": {"from": "html", "select": group.selector,
                                         "text": True}}

    rule = rule_from(group, fields)

    assert "title" not in rule["fields"], "a rule naming the row was shipped"
    assert "title" in rule["_builder"]["missing"], rule["_builder"]


CARD_IS_LINK = """<!doctype html><html><body>
  <div class="weekly">
    <a class="book-layout" href="/novel/2906.html"><img data-src="/c/2906s.jpg"><h4 class="book-title">First</h4></a>
    <a class="book-layout" href="/novel/3095.html"><img data-src="/c/3095s.jpg"><h4 class="book-title">Second</h4></a>
    <a class="book-layout" href="/novel/3343.html"><img data-src="/c/3343s.jpg"><h4 class="book-title">Third</h4></a>
  </div>
</body></html>"""


def test_a_card_that_is_the_link_keeps_the_address_that_was_marked():
    """A listing's card is often the link itself, and then the marked address must survive the row.

    Measured with the bat on bilinovel (2026-10-04): its cards are `<a class="book-layout">`, the
    person marked the card's link for `作品 id` — and the tool reported `source_id` unlearned and
    read **0 cards** from the page, because the marked rule *names the row* and a row-named selector
    resolves to nothing even though the row is that element. The rule ships as the row itself now
    (`select` left out is the runtime's way of saying "this element"), narrowed to the id inside the
    address exactly as it was measured.

    The same rewrite is deliberately **not** offered to a text rule: the row's text is the whole
    card, and shipping that as a title would be worse than shipping nothing — see
    `test_a_rule_naming_the_row_is_dropped_not_shipped`.
    """
    group = cards_of(CARD_IS_LINK)[0]
    assert group.selector == "a.book-layout", "the fixture stopped describing a card that is a link"
    capture = card_page(group, f"{BASE}/list")
    result = harvest(capture)
    answer = {"source_id": f"{BASE}/novel/2906.html", "title": "First",
              "cover_url": f"{BASE}/c/2906s.jpg"}
    picks = {field: next(candidate.candidate_id for candidate in result.candidates
                        if candidate.value == value)
             for field, value in answer.items()}
    assert set(hypotheses(answer, result, picks=picks, fields=LISTING_FIELDS)) == set(answer)

    sample = Sample(name="card1", capture=capture, harvest=result, annotated=answer)
    rules = listing_rules(learn([sample], fields=LISTING_FIELDS), group,
                          pages=[(f"{BASE}/list", CARD_IS_LINK)], answers=answer)

    # What ships is what was measured: the id inside the card's own address, the way every
    # hand-written site writes it.
    assert rules["source_id"]["filter"] == [r"/novel/(\d+)"], rules["source_id"]
    # And the card carries the *address* as its own field — the id is what identifies the work, the
    # address is what the review page links, the crawl fetches and the export records.
    assert rules["detail_url"]["absolute"] is True
    assert "filter" not in rules["detail_url"] and "group" not in rules["detail_url"]
    rule = rule_from(group, rules)
    assert rule["_builder"]["missing"] == [], rule["_builder"]
    id_rule = rule["fields"]["source_id"]
    assert "select" not in id_rule, "the rule still names the row, which reads nothing"
    # And the runtime — not a private copy of the logic — reads every card's own id.
    assert [str(entry["source_id"]) for entry in _cards_read_by_the_runtime(rule, CARD_IS_LINK)] == [
        "2906", "3095", "3343"], "the cards the runtime reads are not the ones that were marked"


def _cards_read_by_the_runtime(rule: dict, html: str) -> list[dict]:
    """The cards an installed adapter reads from this page, through its own listing path."""
    import tempfile

    draft = listing_draft(host="fixture.test", kind="search",
                          url_pattern=rf"^{BASE}/list", rule=rule,
                          pagination=pagination_from([(f"{BASE}/list/1", html)]))
    site = {**draft, "schema_version": 1, "key": "fixture.test", "display_name": "fixture",
            "tool": "fixture_test", "source_site": "fixture.test",
            "export_group": "fixture.test", "media_id_prefix": "fixture.test",
            "hosts": ["fixture.test"]}
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "site.json"
        path.write_text(json.dumps(site, ensure_ascii=False), encoding="utf-8")
        return cards_as_read_by_the_runtime(path, f"{BASE}/list", html)


def test_a_listing_that_lacks_an_id_says_so():
    group = cards_of(LISTING)[0]

    rule = rule_from(group, {"title": {"from": "html", "select": "h3", "text": True}})

    assert rule["_builder"]["missing"] == ["source_id"]


# --- pagination, in the plan's order ---------------------------------------- #

def test_a_page_parameter_is_found_by_comparing_two_addresses():
    found = pagination_from([(f"{BASE}/list?page=1", LISTING),
                             (f"{BASE}/list?page=2", LISTING)])

    assert found.kind == "url_param" and found.page_param == "page"
    assert found.usable


def test_a_next_link_is_read_off_the_page():
    """When the addresses themselves do not carry the page — a path that changes instead of
    a parameter — the page's own `rel=next` is what says where to go. When they *do* carry
    it, the parameter comes first, because that is the order the plan's §17 asks for and
    because a parameter needs no click to reproduce."""
    found = pagination_from([(f"{BASE}/list/1", NEXT_LINK), (f"{BASE}/list/2", LISTING)])

    assert found.kind == "next_link"
    assert found.next_selector["select"] == "a[rel=next]"

    # The same two pages with the page in the query: the parameter wins.
    by_param = pagination_from([(f"{BASE}/list", NEXT_LINK), (f"{BASE}/list?page=2", LISTING)])
    assert by_param.kind == "url_param" and by_param.page_param == "page"


def test_a_numbered_list_is_recognised():
    found = pagination_from([(f"{BASE}/list", NUMBERED), (f"{BASE}/list?page=2", NUMBERED)])

    # The addresses differ in `page`, so the parameter is the first answer and the right
    # one; the numbered list is what a page with no parameter in its addresses falls back on.
    assert found.kind == "url_param" and found.page_param == "page"

    without_param = pagination_from([(f"{BASE}/list/1", NUMBERED),
                                     (f"{BASE}/list/2", NUMBERED)])
    assert without_param.kind == "numbered_links"


def test_a_load_more_button_is_reported_rather_than_approximated():
    """The plan's §17: 4–5 are either experimental or said to need a custom fetcher."""
    found = pagination_from([(f"{BASE}/list", BUTTON_ONLY), (f"{BASE}/list", BUTTON_ONLY)])

    assert found.kind == "unsupported"
    assert "custom fetcher" in found.detail


def test_a_pager_that_never_changes_the_address_is_walked_from_its_own_numbers():
    """The same address twice is one sample — and a link back to this page is never the way on.

    Measured on a jable.tv model page (2026-10-05): its pager marks its links `data-action="ajax"` and
    swaps the list in place, so the address bar never changes and both addresses a person can copy are
    the same one. The tool then took the page's own `href="#"` as "the next page" and learned a rule
    reading *any link containing a #* — `usable: True`, installed, walking nowhere: the adapter listed
    page 1 and nothing else. What the page *does* carry is its numbers (`01` active, `02`), so the walk
    is learned from the markup alone and needs no second address at all.
    """
    pager = ('<ul class="pagination">'
             '<li><span class="page-link active">01</span></li>'
             '<li><a class="page-link" href="/models/abc/2/" data-action="ajax">02</a></li>'
             '<li><a class="page-link" href="/models/abc/2/">最後 »</a></li></ul>'
             '<a href="#">top</a>')
    url = f"{BASE}/models/abc/"

    same = pagination_from([(url, pager), (url, pager)])

    assert same.kind == "numbered_pages" and same.usable, same.detail
    # The rule reads the pager's links and lets the runtime pick the number after this page's — the
    # page's own `#` link is not in it, which is what made the old rule read nothing.
    assert same.next_selector == {"from": "html", "document": "listing_html",
                                  "select": "a.page-link", "attr": "href", "page_numbers": True}

    # Pasting the pager's own second address does not *downgrade* it to that one address: the numbers
    # walk every page, so they stay the rule even when a second address was sampled. A rule that only
    # knows the address would stop after it — which is not what a second address is for.
    real = pagination_from([(url, pager), (f"{url}2/", pager)])
    assert real.kind == "numbered_pages" and real.usable, real.next_selector
    assert real.next_selector["page_numbers"] is True


def test_an_address_only_next_link_is_reported_as_a_limit_not_as_pagination():
    """The last resort: a page with no numbers and no `rel=next` can only teach that one address.

    Measured on 2026-10-05: such a rule reads the sampled pages and stops, so it is marked
    `exact_next` and the draft says so — a walk that ends after two pages must not look like
    pagination that was learned.
    """
    html = ('<div><a href="/list/2">»</a></div>'
            '<ul><li class="card"><a href="/work/1"><h3>W</h3></a></li></ul>')
    url = f"{BASE}/list"

    found = pagination_from([(url, html), (f"{BASE}/list/2", html)])

    assert found.kind == "next_link" and found.exact_next, found.detail
    assert found.next_selector["filter"] == ["/list/2"], found.next_selector
    draft = listing_draft(host="fixture.test", kind="search", url_pattern=rf"^{BASE}/list",
                          rule={"row_selector": "li.card", "fields": {}}, pagination=found)
    assert any("stops after it" in note for note in draft["_draft_listing"]["review"]), \
        draft["_draft_listing"]["review"]


def test_a_set_whose_class_is_shared_ships_the_block_that_tells_it_apart():
    """The rule must name the set the person was shown, not every element sharing its class.

    Measured on a jable.tv model page (2026-10-05): 145 elements carried `div.col-6.col-sm-4` and 24 of
    them were the works. The person was shown 24, the rule written for them read 145, and the `作品 id`
    they had just marked "could not be read on all cards" — the adapter installed with no id rule at
    all. The block is the only thing that tells the two sets apart (the videos carry no class the tags
    lack), so the rule carries it as `scope`, and both the checks and the crawl read the rows inside it.
    """
    import dataclasses
    import json
    import tempfile

    from build_listing import row_selector_for
    from src.builder.cards import cards_of_group, _link_kind
    from src.builder.listing import listing_draft
    from src.generic.htmltree import parse_html

    cards = "".join(
        f'<div class="col-6 col-sm-4"><a href="/videos/v{index}">'
        f'<img src="/c/{index}.jpg"><h6 class="title"><a>W{index}</a></h6></a></div>'
        for index in range(1, 25))
    tags = "".join(
        f'<div class="col-6 col-sm-4"><a href="/tags/t{index}">T{index}</a></div>'
        for index in range(1, 112))
    html = f'<section class="videos">{cards}</section><section class="tags">{tags}</section>'
    url = f"{BASE}/models/abc/"

    root = parse_html(html)
    group = next(candidate for candidate in cards_of(html) if candidate.count == 24)
    members = cards_of_group(html, group, root=root)
    scope = row_selector_for(root, group, members, picked=[group.selector])

    assert scope == "section.videos", scope
    rule = rule_from(dataclasses.replace(group, scope=scope), {
        "source_id": {"from": "html", "select": "a", "attr": "href",
                      "filter": [r"/videos/([a-z0-9-]+)"], "group": 1},
        "title": {"from": "html", "select": "h6.title a", "text": True},
        "cover_url": {"from": "html", "select": "img", "attr": "src"},
    })
    assert rule["row_selector"] == {"select": "div.col-6.col-sm-4", "scope": "section.videos"}
    # The checks judge the 24 the person saw, so nothing is reported and the id is learnable.
    assert check_over_cards(rule, [(url, html)]) == []

    # And the runtime reads the same 24 — through the file, the way an installed adapter is read.
    draft = listing_draft(host="fixture.test", kind="search", url_pattern=rf"^{BASE}/models",
                          rule=rule, pagination=pagination_from([(url, html), (url, html)]))
    site = {**draft, "schema_version": 1, "key": "fixture.test", "display_name": "fixture",
            "tool": "fixture_test", "source_site": "fixture.test",
            "export_group": "fixture.test", "media_id_prefix": "fixture.test",
            "hosts": ["fixture.test"]}
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "site.json"
        path.write_text(json.dumps(site, ensure_ascii=False), encoding="utf-8")
        read = cards_as_read_by_the_runtime(path, url, html)

    assert len(read) == 24, read
    assert [card["source_id"] for card in read][:2] == ["v1", "v2"]
    assert all(_link_kind(member) for member in members)


def test_a_drafted_rule_carries_only_what_the_runtime_reads():
    """The handover, asserted structurally: a draft's keys are the runtime rule's own fields.

    Four bugs of one class were paid for before this (a `next` key nothing writes, a `page_param`
    nothing reads, a `row_selector` naming the whole page, a `page_numbers` marker added late), so the
    *contract* is checked rather than each symptom: whatever the Builder writes at the top level of a
    listing rule must be a field of `ListingRule` (plus the diagnostics a person reads in the draft).
    """
    import json
    import tempfile

    from src.generic.template import ListingRule, load_template

    group = cards_of(LISTING)[0]
    rule = rule_from(group, card_fields())
    draft = listing_draft(host="fixture.test", kind="search", url_pattern=rf"^{BASE}/list",
                          rule=rule,
                          pagination=pagination_from([(f"{BASE}/list?page=1", LISTING),
                                                      (f"{BASE}/list?page=2", LISTING)]))
    written = set(draft["listings"]["search"])
    diagnostics = {"_builder"}

    assert written - diagnostics <= set(ListingRule.__dataclass_fields__), (
        f"the draft writes keys the runtime rule has no field for: "
        f"{sorted(written - diagnostics - set(ListingRule.__dataclass_fields__))}")

    # And every field it declares survives the file: this is the handover the `next` bug broke.
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "site.json"
        path.write_text(json.dumps({**draft, "schema_version": 1, "key": "fixture.test",
                                    "display_name": "fixture", "tool": "fixture_test",
                                    "source_site": "fixture.test", "export_group": "fixture.test",
                                    "media_id_prefix": "fixture.test", "hosts": ["fixture.test"]},
                                   ensure_ascii=False), encoding="utf-8")
        loaded = load_template(path).listings["search"]

    assert loaded.row_selector == rule["row_selector"]
    assert loaded.page_param == "page"
    assert loaded.fields.keys() == rule["fields"].keys()


def test_a_next_link_rule_walks_the_pages_it_was_learned_from(tmp_path):
    """A declared next link must actually be followed — the field being present is not enough.

    `page_param` had a reader added in the same round because nothing walked it; this holds the other
    pagination form to the same standard, through the runtime's own listing path.
    """
    from src.generic import unknown_url
    from src.generic.declarative import list_cards
    from src.generic.template import load_template

    # The second address differs by a *path*, not by a parameter: two addresses differing only in
    # `?page=` are the stronger evidence and would be learned as a parameter walk instead (correctly).
    pages = {
        f"{BASE}/list": ('<ul id="grid"><li class="card"><a href="/work/1"><h3>One</h3></a>'
                         '<img src="/c/1.jpg"></li></ul>'
                         '<a rel="next" href="/list/2">Next</a>'),
        f"{BASE}/list/2": ('<ul id="grid"><li class="card"><a href="/work/2"><h3>Two</h3></a>'
                           '<img src="/c/2.jpg"></li></ul>'),
    }
    group = cards_of(LISTING)[0]
    rule = rule_from(group, card_fields())
    draft = listing_draft(host="fixture.test", kind="search", url_pattern=rf"^{BASE}/list",
                          rule=rule,
                          pagination=pagination_from([(f"{BASE}/list", pages[f"{BASE}/list"]),
                                                      (f"{BASE}/list/2", pages[f"{BASE}/list/2"])]))
    site = {**draft, "schema_version": 1, "key": "fixture.test", "display_name": "fixture",
            "tool": "fixture_test", "source_site": "fixture.test",
            "export_group": "fixture.test", "media_id_prefix": "fixture.test",
            "hosts": ["fixture.test"]}
    path = tmp_path / "site.json"
    path.write_text(json.dumps(site, ensure_ascii=False), encoding="utf-8")

    original = unknown_url.fetch
    unknown_url.fetch = lambda url: (200, pages[url].encode("utf-8"), "text/html", url)
    try:
        cards = list_cards(load_template(path), "search", {"id": "x"}, {"target_url": f"{BASE}/list"})
    finally:
        unknown_url.fetch = original

    assert [card["source_id"] for card in cards] == ["1", "2"], cards


def test_one_page_says_so_instead_of_guessing():
    found = pagination_from([(f"{BASE}/list", NUMBERED)])
    assert not found.usable and found.pages_sampled == 1


def test_the_next_page_rule_the_builder_writes_is_the_one_the_runtime_reads():
    """The draft's pagination has to survive the handover, or every learned listing is one page.

    Measured on 2026-10-05 against every adapter on disk: the Builder writes `next_selector` (and
    `declarative.list_cards` names it in its own docstring), while `template.load_template` looked up
    `next`, a key nothing produces — so a learned listing whose pager is a next-link *silently walked
    page 1 and stopped*, which is exactly what the person saw. This holds the two ends together.
    """
    import json
    import tempfile

    from src.generic.template import load_template

    rule = {"from": "html", "document": "listing_html", "select": "a.next", "attr": "href"}
    site = {
        "schema_version": 1, "key": "fixture.test", "display_name": "fixture",
        "tool": "fixture_test", "source_site": "fixture.test",
        "export_group": "fixture.test", "media_id_prefix": "fixture.test",
        "hosts": ["fixture.test"],
        "targets": {"search": {"url_pattern": rf"^{BASE}/list", "label": "Search", "single": False}},
        "documents": {"listing": {"listing_html": {"format": "html"}}},
        "listings": {"search": {"document": "listing_html", "row_selector": "li.card",
                                "fields": {"title": {"from": "html", "select": "h3", "text": True}},
                                "next_selector": rule}},
    }
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "site.json"
        path.write_text(json.dumps(site, ensure_ascii=False), encoding="utf-8")
        loaded = load_template(path)

    assert loaded.listings["search"].next_selector == rule, (
        "the runtime did not pick up the pagination the Builder writes")


def test_a_numbered_pager_is_walked_without_a_second_address():
    """`01 02 03 …` in the links themselves: the page being read says which number is next.

    Measured on a jable.tv model page (2026-10-05): its pager swaps the list in place, so the address
    bar never changes and a person cannot paste a second address at all — both boxes get the same one.
    The numbers are in the markup, so the walk needs no second sample: the rule is learned from the
    first page alone, and the runtime takes the number one past the page it is reading.
    """
    from src.generic.extract import extract_listing_page
    from src.generic.template import ListingRule, load_template
    import json
    import tempfile

    def page(number: int) -> str:
        links = "".join(
            f'<li><a class="page-link" href="/list/{n}/">{n:02d}</a></li>'
            if n != number else f'<li><span class="page-link active">{n:02d}</span></li>'
            for n in range(1, 4))
        return (f'<ul class="pagination">{links}</ul>'
                f'<ul><li class="card"><a href="/work/{number}1"><h3>W{number}</h3></a></li></ul>')

    found = pagination_from([(f"{BASE}/list/", page(1)), (f"{BASE}/list/", page(1))])

    assert found.kind == "numbered_pages" and found.usable, found.detail
    assert found.next_selector == {"from": "html", "document": "listing_html",
                                   "select": "a.page-link", "attr": "href", "page_numbers": True}

    # The walk: 1 → 2 → 3 → stop, read through the runtime's own listing path.
    site = {
        "schema_version": 1, "key": "fixture.test", "display_name": "fixture",
        "tool": "fixture_test", "source_site": "fixture.test",
        "export_group": "fixture.test", "media_id_prefix": "fixture.test",
        "hosts": ["fixture.test"],
        "targets": {"search": {"url_pattern": rf"^{BASE}/list", "label": "Search", "single": False}},
        "documents": {"listing": {"listing_html": {"format": "html"}}},
        "listings": {"search": {"document": "listing_html", "row_selector": "li.card",
                                "fields": {"source_id": {"from": "html", "select": "a", "attr": "href",
                                                         "filter": [r"/work/(\d+)"], "group": 1},
                                           "title": {"from": "html", "select": "h3", "text": True}},
                                "next_selector": found.next_selector}},
    }
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "site.json"
        path.write_text(json.dumps(site, ensure_ascii=False), encoding="utf-8")
        template = load_template(path)

    walked: list[str] = []
    url, html, number = f"{BASE}/list/", page(1), 1
    for _ in range(5):
        cards, next_url = extract_listing_page(template, "listing_html", html, url, "search")
        assert [card["source_id"] for card in cards] == [f"{number}1"], cards
        walked.append(url)
        if next_url is None:
            break
        number += 1
        url = next_url
        html = page(number)

    assert walked == [f"{BASE}/list/", f"{BASE}/list/2/", f"{BASE}/list/3/"], walked


# --- the acceptance: what was marked is what the runtime reads -------------- #

def test_a_learned_listing_can_be_crawled_at_all(tmp_path):
    """The declarative reader's card hook — the half of Phase 7 that was never built.

    A learned listing adapter is a `site.json` with a row rule and no Python, so without this hook
    the runner answered "offers neither a review step nor card listing" and such a site could only
    ever be verified *offline* — measured on a real buondua tag page (2026-09-22), whose rules had
    been learned and checked in Phase 7 and could not be run at all. The hook walks the rule's own
    pagination, through the same `extract_listing_page` the Builder's check uses.
    """
    from src.generic import unknown_url
    from src.generic.declarative import list_cards
    from src.generic.template import load_template

    group = cards_of(LISTING)[0]
    rule = rule_from(group, card_fields())
    draft = listing_draft(host="fixture.test", kind="album",
                          url_pattern=rf"^{BASE}/tag/(?P<id>[^/]+)", rule=rule,
                          pagination=pagination_from([(f"{BASE}/tag/x?page=1", LISTING),
                                                      (f"{BASE}/tag/x?page=2", LISTING)]))
    site = {**draft, "schema_version": 1, "key": "fixture.test", "display_name": "fixture",
            "tool": "fixture_test", "source_site": "fixture.test",
            "export_group": "fixture.test", "media_id_prefix": "fixture.test",
            "hosts": ["fixture.test"]}
    path = tmp_path / "site.json"
    path.write_text(json.dumps(site, ensure_ascii=False), encoding="utf-8")

    pages = {f"{BASE}/tag/x": LISTING, f"{BASE}/tag/x?page=2": LISTING}
    asked: list[str] = []
    original = unknown_url.fetch

    def fetch(url):
        asked.append(url)
        return 200, pages.get(url, LISTING).encode("utf-8"), "text/html", url

    unknown_url.fetch = fetch
    try:
        messages: list[str] = []
        cards = list_cards(load_template(path), "album", {"id": "x"},
                           {"target_url": f"{BASE}/tag/x", "progress": messages.append})
    finally:
        unknown_url.fetch = original

    # The cards, and the walk. This fixture's rule declares `page_param`, so the walk now reads the
    # next parameter value as well — the second page repeats the same ids, which is where a listing
    # ends (that is what keeps a site whose "next" marker never moves from looping to `max_pages`).
    assert [card["source_id"] for card in cards] == ["1", "2", "3"]
    assert asked == [f"{BASE}/tag/x", f"{BASE}/tag/x?page=2"], asked
    assert any("card(s)" in message for message in messages), messages


def test_a_learned_listing_hands_the_runtime_the_work_addresses(tmp_path):
    """"Only supports a single work URL" was the answer a *learned* listing got when it was crawled.

    Measured with the bilinovel listing adapter installed (2026-10-04): the runtime read its 30 cards
    and the ids were distinct, and `probe.py <listing URL>` — the command the builder prints for the
    person to run — refused to enumerate, because `site_api` asks a site for `list_work_urls` and the
    declarative reader defined no such hook. The addresses come from the same cards the review page
    shows, so the crawl and the page cannot disagree about what the listing holds.
    """
    from src.generic import unknown_url
    from src.generic.declarative import list_work_urls
    from src.generic.template import load_template

    group = cards_of(LISTING)[0]
    rule = rule_from(group, {
        **card_fields(),
        "detail_url": {"from": "html", "select": "a", "attr": "href", "absolute": True},
    })
    draft = listing_draft(host="fixture.test", kind="album",
                          url_pattern=rf"^{BASE}/tag/(?P<id>[^/]+)", rule=rule,
                          pagination=pagination_from([(f"{BASE}/tag/x?page=1", LISTING)]))
    site = {**draft, "schema_version": 1, "key": "fixture.test", "display_name": "fixture",
            "tool": "fixture_test", "source_site": "fixture.test",
            "export_group": "fixture.test", "media_id_prefix": "fixture.test",
            "hosts": ["fixture.test"]}
    path = tmp_path / "site.json"
    path.write_text(json.dumps(site, ensure_ascii=False), encoding="utf-8")

    original = unknown_url.fetch
    unknown_url.fetch = lambda url: (200, LISTING.encode("utf-8"), "text/html", url)
    try:
        urls = list_work_urls(load_template(path), "album", {"id": "x"},
                              {"target_url": f"{BASE}/tag/x"})
    finally:
        unknown_url.fetch = original

    assert urls == [f"{BASE}/work/1", f"{BASE}/work/2", f"{BASE}/work/3"], urls


def test_a_listing_whose_cards_share_an_id_is_reported_not_swallowed():
    """The data a bad listing rule produces, caught where the data is made.

    Measured on a learned rule set whose target pattern captured a constant (`acgDetail.php`): every
    work on that site would be met as one work, and a selection of twenty of them would be refused by
    the import as a duplicate id in one batch. The Builder checks this at authoring time; this is the
    same check at runtime, so a rule set that slipped through cannot pass silently.
    """
    from src.generic.site_api import repeated_card_ids

    assert repeated_card_ids([
        {"source_id": "acgDetail.php"}, {"source_id": "acgDetail.php"}, {"source_id": "7"},
    ]) == ["acgDetail.php"]
    assert repeated_card_ids([{"source_id": "1"}, {"source_id": "2"}]) == []
    assert repeated_card_ids([{"title": "no id at all"}]) == []


def test_the_runtime_reads_the_cards_the_builder_marked(tmp_path):
    """The plan's third leg, for a listing: `extract_listing_page` — the reader an installed
    adapter uses — must produce the cards the Builder's own rules produce. Written through
    the runtime's API rather than a private copy of the logic, or it would be a rehearsal."""
    group = cards_of(LISTING)[0]
    rule = rule_from(group, card_fields())
    draft = listing_draft(host="fixture.test", kind="search",
                          url_pattern=rf"^{BASE}/list", rule=rule,
                          pagination=pagination_from([(f"{BASE}/list?page=1", LISTING),
                                                      (f"{BASE}/list?page=2", LISTING)]))
    site = {**draft, "schema_version": 1, "key": "fixture.test", "display_name": "fixture",
            "tool": "fixture_test", "source_site": "fixture.test",
            "export_group": "fixture.test", "media_id_prefix": "fixture.test",
            "hosts": ["fixture.test"]}
    path = tmp_path / "site.json"
    path.write_text(json.dumps(site, ensure_ascii=False), encoding="utf-8")

    cards = cards_as_read_by_the_runtime(path, f"{BASE}/list", LISTING)

    assert [card["source_id"] for card in cards] == ["1", "2", "3"]
    assert [card["title"] for card in cards] == ["First Work", "Second Work", "Third Work"]
    assert cards[0]["cover_url"].endswith("/c/1.jpg")
    assert draft["listings"]["search"]["page_param"] == "page"
    assert draft["documents"]["listing"] == {"listing_html": {"format": "html"}}
    assert [name for name, _kind, _label in LISTING_FIELDS][:3] == ["source_id", "title", "cover_url"]


# --- the last piece: a card marked on a page becomes a listing rule -------- #

def test_a_marked_card_becomes_the_rule_the_runtime_reads():
    """The whole phase without a browser: lift a card out, harvest it, answer for it the way
    the page would, learn, and turn the answer into the `listings` entry.

    The person marks the card's *link*, because that is what is on the page, and the id is
    the number inside it — so the rule is narrowed by the learner itself (`_as_shipped`), which is
    how every hand-written site writes `source_id` and, more to the point, is exactly the rule the
    comparison measured over the cards.
    """
    group = cards_of(LISTING)[0]
    capture = card_page(group, f"{BASE}/list")
    result = harvest(capture)
    answer = {"source_id": f"{BASE}/work/1", "title": "First Work",
              "cover_url": f"{BASE}/c/1.jpg"}
    picks = {field: next(c.candidate_id for c in result.candidates if c.value == value)
             for field, value in answer.items()}

    found = hypotheses(answer, result, picks=picks, fields=LISTING_FIELDS)

    assert set(found) == set(answer), "a marked card field produced no rule"
    sample = Sample(name="card1", capture=capture, harvest=result, annotated=answer)
    learning = learn([sample], fields=LISTING_FIELDS)
    rules = listing_rules(learning, group, answers=answer)
    # Measured over the cards as the id, not as the address: a listing whose `source_id` is a URL
    # names every export directory and every media id with one.
    assert rules["source_id"]["filter"] == [r"/work/(\d+)"], rules["source_id"]
    rule = rule_from(group, rules)

    assert rule["row_selector"] == "li.card"
    assert rule["_builder"]["missing"] == []
    assert check_over_cards(rule, [(f"{BASE}/list", LISTING)]) == []


def test_the_card_page_teaches_the_listing_job_and_says_when_it_is_done(tmp_path):
    """The card page is the work page's page with a different job, and the difference has to show.

    The C specification's 列表适配器 half asks for two text changes on the adapter's own page: the tips
    must be the listing's four (a card is one sample of a set; the work's three are about finding a
    value on one page), and the line under 保存标注 must not promise a following page — the card is
    the whole annotation for this adapter.
    """
    from src.builder.session_server import Session, start
    import urllib.request

    result = harvest(card_page(cards_of(LISTING)[0], f"{BASE}/list"))
    session = Session(harvest=result, directory=tmp_path, url=f"{BASE}/list",
                      fields=LISTING_FIELDS, vocabulary="listing", last=True)
    httpd, url = start(session)
    try:
        with urllib.request.urlopen(url) as reply:
            page_html = reply.read().decode("utf-8")
    finally:
        httpd.shutdown()
        httpd.server_close()

    payload = json.loads(page_html[page_html.index("const DATA = ") + len("const DATA = "):]
                         .split(";\nconst T")[0])
    assert payload["tips"] == list(l10n.LISTING_TIPS["zh"]), payload["tips"]
    assert len(payload["tips"]) == 4, "the listing's four points, not the work page's three"
    # The completion line is the one shown after saving, and it is the listing's own wording. The
    # page still *carries* `savedNext` (its script reads it in the branch `last` disables), but
    # nothing the card page shows promises a following page.
    assert payload["last"] is True
    assert payload["text"]["savedLast"] == l10n.LISTING_CHROME["savedLast"]["zh"]
    assert "下一个" not in payload["text"]["savedLast"]
    assert "下一个" not in payload["text"]["saveNote"]

    # And a work page is untouched by any of it: its three tips and its own chrome.
    work_capture = Capture(url=f"{BASE}/work/1", final_url=f"{BASE}/work/1",
                           documents=[Document(name="page", format="html", text=LISTING)])
    work_html = page(harvest(work_capture), url=f"{BASE}/work/1")
    work_payload = json.loads(work_html[work_html.index("const DATA = ") + len("const DATA = "):]
                              .split(";\nconst T")[0])
    assert work_payload["tips"] == list(l10n.tips("zh"))
    assert work_payload["text"]["savedLast"] == l10n.chrome("zh")["savedLast"]


def test_the_annotation_page_shows_a_listing_card_vocabulary():
    """The page takes the vocabulary as a parameter, so a listing card is marked in the
    runtime's own field names and no translation step is needed afterwards."""
    result = harvest(card_page(cards_of(LISTING)[0], BASE))

    html = page(result, url=BASE, fields=LISTING_FIELDS)
    start = html.index("const DATA = ") + len("const DATA = ")
    payload = json.loads(html[start:html.index(";", start)])

    assert [field["key"] for field in payload["fields"]][:3] == [
        "source_id", "title", "cover_url"]
    assert payload["fields"][2]["kind"] == "image"


def test_a_field_that_reads_nothing_on_the_cards_is_reported():
    """One card without a cover is a page's business; a rule that reads nothing on any of them
    is a rule pointed at the wrong element.

    Two things are *not* faults, and both are measured. A field **some** cards lack is a page's
    own unevenness. And an optional field **every** card lacks — a date, most often — is a
    listing that does not carry it: the site's own work page supplies the date when the work is
    fetched, so requiring it here would refuse listings that are perfectly crawable.
    """
    group = cards_of(LISTING)[0]
    broken = rule_from(group, {**card_fields(),
                               "title": {"from": "html", "select": "time", "text": True}})
    optional = rule_from(group, {**card_fields(),
                                 "date_added": {"from": "html", "select": "time", "text": True}})

    assert any("title" in finding for finding in
               check_over_cards(broken, [(f"{BASE}/list", LISTING)])), "a required field"
    assert not [f for f in check_over_cards(optional, [(f"{BASE}/list", LISTING)])
                if "date_added" in f], "an absent date is normal in a listing"


def test_a_second_page_with_no_new_ids_is_reported():
    """The plan's §17 terminal condition — "no new id on this page" ends a crawl — applied to
    the cards themselves: a rule reading the same ids on both pages would never end."""
    group = cards_of(LISTING)[0]
    rule = rule_from(group, card_fields())

    findings = check_over_cards(rule, [(f"{BASE}/list?page=1", LISTING),
                                       (f"{BASE}/list?page=2", LISTING)])

    assert any("adds no id" in finding for finding in findings), findings


def test_a_listing_nobody_annotated_learns_nothing():
    """The sample without an annotation offers no hypotheses — and says so, rather than
    installing a listing rule with no fields in it."""
    group = cards_of(LISTING)[0]
    capture = card_page(group, BASE)
    sample = Sample(name="card1", capture=capture, harvest=harvest(capture), annotated={})

    learning = learn([sample], fields=LISTING_FIELDS)

    assert learning.fields == []
    assert learning.notes


# --- the cards are the second sample a listing has -------------------------- #

# Measured on a real gallery: the first card is laid out differently from the rest, so the
# link the marked card carries has a class that exists on one card out of five.
UNEVEN = """<!doctype html><html><body>
  <div class="grid">
    <div class="dj"><a class="lillie" href="/work/11"><h1 class="lillie">First</h1></a>
      <img data-src="/c/11.jpg"></div>
    <div class="dj"><a class="link" href="/work/12"><h1 class="lillie">Second</h1></a>
      <img data-src="/c/12.jpg"></div>
    <div class="dj"><a class="link" href="/work/13"><h1 class="lillie">Third</h1></a>
      <img data-src="/c/13.jpg"></div>
    <div class="dj"><a class="link" href="/work/14"><h1 class="lillie">Fourth</h1></a>
      <img data-src="/c/14.jpg"></div>
    <div class="dj"><a class="link" href="/work/15"><h1 class="lillie">Fifth</h1></a>
      <img data-src="/c/15.jpg"></div>
  </div>
</body></html>"""


def test_a_rule_that_reads_one_card_only_loses_to_one_that_reads_them_all():
    """Which rule is shipped is decided by measuring it over the cards, not by the order the
    learner happened to offer them: the marked card's own class is on one card of five, and
    the element named by its tag reads every one of them with distinct ids."""
    group = cards_of(UNEVEN)[0]
    capture = card_page(group, f"{BASE}/artist")
    result = harvest(capture)
    answer = {"source_id": f"{BASE}/work/11", "title": "First"}
    picks = {field: next(c.candidate_id for c in result.candidates if c.value == value)
             for field, value in answer.items()}
    sample = Sample(name="card1", capture=capture, harvest=result, annotated=answer)

    rules = listing_rules(learn([sample], fields=LISTING_FIELDS), group,
                          [(f"{BASE}/artist", UNEVEN)])

    assert rules["source_id"]["select"] == "a", "the class-only rule was shipped"
    rule = rule_from(group, rules)
    rule["fields"]["source_id"] = card_rule_for_id(rule["fields"]["source_id"],
                                                   answer["source_id"])
    assert check_over_cards(rule, [(f"{BASE}/artist", UNEVEN)]) == []


def test_the_id_rule_drops_absolute_and_keeps_a_loose_pattern():
    """Two bugs in one rule, both measured on a real gallery.

    The pattern was the whole address around the digits, so it matched the card it came from
    and no other — a real work address carries the work's own title
    (`…-|-futa-dick-bonding-english-3547173.html`). And `absolute` stayed in the rule: the
    filter's group had already reduced the address to the id, so absolutising *that* joined the
    id to the page — every id came out as `https://hitomi.la/artist/<id>`, every one of them
    different from the others, and a check for "is it distinct" called it fine.
    """
    posted = {"from": "html", "document": "listing_html", "select": "a.lillie",
              "attr": "href", "absolute": True, "matches": 1}

    rule = card_rule_for_id(posted, "/doujinshi/futa-shigo-tsutaete-|-english-3547173.html")

    assert rule["filter"] == [r"\-(\d+)\.html(?=[?#]|$)"]
    assert rule["group"] == 1
    assert "absolute" not in rule, "the id would be url-joined to the page"

    # The **last** number, not the first: a work address carries its own title, and that title
    # carries numbers — measured on a real gallery, where the first number made every card's
    # work id a date.
    assert card_rule_for_id(posted, "/imageset/greembang--14409210--2026.09.20-4201383")["filter"]         == [r"\-(\d+)(?=[?#]|$)"]

    # A segment that *is* the id keeps its path, which is how the written sites write it.
    assert card_rule_for_id(posted, "/album/1472965/?x=1")["filter"] == ["/album/(\d+)"]


SLUG_LISTING = """<!doctype html><html><body>
  <section class="pb-3">
    <div class="col-6"><div class="img-box cover-md"><a href="/videos/snos-357/">
      <img src="/c/357.jpg"></a><h6>First</h6></div></div>
    <div class="col-6"><div class="img-box cover-md"><a href="/videos/snos-374/">
      <img src="/c/374.jpg"></a><h6>Second</h6></div></div>
    <div class="col-6"><div class="img-box cover-md"><a href="/videos/sone-560-b/">
      <img src="/c/560.jpg"></a><h6>Third</h6></div></div>
  </section>
</body></html>"""


def test_a_slug_address_reads_its_id_and_the_rule_reads_every_card():
    """A path that ends in a slash after the id is the same id.

    The id pattern was anchored to an extension, a query or the very end, and a card whose
    address is `/videos/snos-357/` has none of those after the number — so the rule matched
    nothing and read no id on any card. Measured on jable.tv's model page (2026-10-05), whose
    24 cards are all of this shape.

    The second half is the choice itself: on this page the last-number form misses
    `sone-560-b` (a slug whose number is not at the end), so the measurement has to prefer the
    form that reads *every* card rather than the simpler one that reads 23 of 24.
    """
    import re as _re
    posted = {"from": "html", "select": "div.img-box.cover-md a", "attr": "href",
              "absolute": True, "matches": 1}
    answer = f"{BASE}/videos/snos-357/"

    number = card_rule_for_id(posted, answer)
    assert number["filter"] == [r"\-(\d+)/?(?=[?#]|$)"]
    assert _re.search(number["filter"][0], "/videos/snos-357/"), "the id is not read at all"
    assert _re.search(number["filter"][0], "/videos/snos-357"), "a trailing slash must not matter"

    group = cards_of(SLUG_LISTING)[0]
    capture = card_page(group, f"{BASE}/models/1")
    result = harvest(capture)
    picks = {field: next(c.value for c in result.candidates if c.value)
             for field in ("source_id", "title", "cover_url")}
    picks["source_id"] = answer
    sample = Sample(name="card1", capture=capture, harvest=result, annotated=picks)

    rules = listing_rules(learn([sample], fields=LISTING_FIELDS), group,
                          [(f"{BASE}/models/1", SLUG_LISTING)])
    rule = rule_from(group, rules)

    rows = [(f"{BASE}/models/1", row)
            for row in _rows(SLUG_LISTING, rule["row_selector"])]
    values = [value for value in _values_over_rows(rule["fields"]["source_id"], rows)]
    assert len(rows) == 3
    assert all(values), f"the shipped id rule read nothing on a card: {values}"
    assert len(set(values)) == 3, f"the shipped id rule repeated an id: {values}"
    assert check_over_cards(rule, [(f"{BASE}/models/1", SLUG_LISTING)]) == []


def test_a_candidate_is_scored_as_the_rule_it_will_ship_as():
    """The measurement and the shipment must be the same rule.

    A `unique` variant was measured *un-narrowed* — it read the whole address in every row, so
    it was filled, distinct and looked perfect — while the rule it was written into `site.json`
    as carries the id filter as well, and that rule read nothing. Measured on jable.tv's model
    page (2026-10-05), where this false pass is exactly what the id rule was chosen on. The
    guard is the invariant itself: narrowing a candidate must not change its score, because the
    score is taken after the narrowing.
    """
    rows = [(f"{BASE}/models/1", row)
            for row in _rows(SLUG_LISTING, "div.col-6")]
    answer = f"{BASE}/videos/snos-357/"
    candidates = [
        {"from": "html", "select": "div.img-box.cover-md a", "attr": "href",
         "absolute": True, "matches": 1},
        {"from": "html", "select": "div.img-box.cover-md a", "attr": "href",
         "absolute": True, "matches": 1, "unique": True},
    ]
    for candidate in candidates:
        shipped = _as_shipped(candidate, "source_id", answer)
        assert _score_over_cards(candidate, "source_id", rows, answer) == \
            _score_over_cards(shipped, "source_id", rows, answer)


MULTI_LINK_CARDS = """<!doctype html><html><body>
  <div class="grid">
    <div class="card"><a class="lnk" href="/tag/1">tag</a>
      <a class="lnk" href="/work/101">First</a></div>
    <div class="card"><a class="lnk" href="/tag/1">tag</a>
      <a class="lnk" href="/work/102">Second</a></div>
    <div class="card"><a class="lnk" href="/tag/1">tag</a>
      <a class="lnk" href="/work/103">Third</a></div>
  </div>
</body></html>"""


def test_the_check_reads_a_unique_field_the_way_the_runtime_reads_it():
    """A card carries several links under one class, and the one that names the work is the one
    whose address appears once on the page — which is what `unique` means and what the runtime
    does across the rows, not inside one.

    The check used to read every field row by row, so on this page it read the *tag* link (the
    first match in the row), reported the same id on every card, and called a correct rule
    broken. The rule that ships and the rule that is checked have to be read the same way.
    """
    rule = {
        "row_selector": "div.card",
        "fields": {
            "source_id": {"from": "html", "select": "a.lnk", "attr": "href", "absolute": True,
                          "unique": True, "filter": [r"(\d+)(?=[?#]|$)"], "group": 1},
            "title": {"from": "html", "select": "a.lnk", "text": True, "unique": True},
            "cover_url": {"from": "html", "select": "img", "attr": "src", "absolute": True},
        },
    }
    rows = [(f"{BASE}/list", row) for row in _rows(MULTI_LINK_CARDS, "div.card")]
    ids = [value for value in _values_over_rows(rule["fields"]["source_id"], rows)]
    assert ids == ["101", "102", "103"], f"the unique pass did not pick the work links: {ids}"
    assert check_over_cards(rule, [(f"{BASE}/list", MULTI_LINK_CARDS)]) == []


def test_a_listing_that_reads_nothing_is_never_installed(tmp_path):
    """The runtime read is a gate, not a report.

    It used to be asked *after* `install`, so a draft whose rule read nothing was written into the
    registry anyway — shadowing the site's own adapter — and the answer only reached the terminal.
    Measured on jable.tv's model page (2026-10-05): the id rule read no card, the adapter installed,
    and the crawl that followed came back with 0 items. The work builder has always asked its round
    trip before installing; this is the listing half asking the same question in the same order.

    The gate is about the *rule*, not the site: the same draft with the rule the person marked
    installs.
    """
    from build_listing import install_if_the_runtime_reads

    group = cards_of(LISTING)[0]
    pagination = pagination_from([(f"{BASE}/tag/x?page=1", LISTING),
                                  (f"{BASE}/tag/x?page=2", LISTING)])

    def draft_with(rule: dict) -> dict:
        return {**listing_draft(host="fixture.test", kind="album",
                                url_pattern=rf"^{BASE}/tag/(?P<id>[^/]+)", rule=rule,
                                pagination=pagination),
                "schema_version": 1, "key": "fixture.test", "display_name": "fixture",
                "tool": "fixture_test", "source_site": "fixture.test",
                "export_group": "fixture.test", "media_id_prefix": "fixture.test",
                "hosts": ["fixture.test"]}

    root = tmp_path / "local"
    path = tmp_path / "draft_listing.json"
    good = rule_from(group, card_fields())
    assert good["fields"].get("source_id")

    broken = {**good, "fields": {**good["fields"],
                                 "source_id": {"from": "html", "select": "a.nowhere",
                                               "attr": "href"}}}
    path.write_text(json.dumps(draft_with(broken), ensure_ascii=False), encoding="utf-8")
    installed, read = install_if_the_runtime_reads(draft_with(broken), path, f"{BASE}/tag/x",
                                                   LISTING, root=root)
    assert read == [], "the broken rule was supposed to read no card"
    assert installed is None
    assert not root.exists(), "a draft that reads nothing was written into the registry"

    path.write_text(json.dumps(draft_with(good), ensure_ascii=False), encoding="utf-8")
    installed, read = install_if_the_runtime_reads(draft_with(good), path, f"{BASE}/tag/x",
                                                   LISTING, root=root)
    assert installed is not None and read, "the gate refused the rule the person marked"


# The address shapes the id rule has to read, and what the id is in each. This is a table rather
# than one case per site because the rule's contract is about *shapes*: "the id is the last number
# in the path; a segment that is the id is kept whole; a trailing slash is the path's own
# separator". Every row here is a shape a real listing has used, and the ones that were broken were
# found by a person running the tool on a site, one at a time — `/album/1472965/` and
# `/videos/snos-357/` both read **nothing** until 2026-10-05, and the second is what made jable's
# adapter crawl 0 items. A shape belongs here *before* a site is tried on it, so the next site
# reports "the table was incomplete" rather than "the crawl came back empty".
ID_SHAPES = [
    ("/album/1472965", "1472965"),                    # the id is the whole segment
    ("/album/1472965/", "1472965"),                   # …with the path's separator after it
    ("/album/1472965.html", "1472965"),               # …with an extension
    ("/album/1472965.html?x=1", "1472965"),           # …with a query
    ("/album/1472965#top", "1472965"),                # …with a fragment
    ("/doujinshi/title-3547173", "3547173"),          # the id ends a segment that carries a title
    ("/doujinshi/title-3547173/", "3547173"),
    ("/doujinshi/title-3547173.html", "3547173"),
    ("/videos/snos-357/", "357"),                     # a slug with a number, slash-terminated
    ("/imageset/t--2026.09.20-4201383", "4201383"),   # the *last* number: not the date in the title
    ("/2025/05/work-123/", "123"),                    # the *last* number: not the year in the path
    ("/view/1/2/3", "3"),
    ("/a/1/2", "2"),
    ("/work/abc", None),                              # no number at all: the rule is left alone
]


def test_the_id_rule_reads_the_last_number_across_every_address_shape():
    """One row of `ID_SHAPES` per shape, and the filter has to produce that id from that address."""
    import re as _re
    posted = {"from": "html", "select": "a", "attr": "href", "absolute": True, "matches": 1}
    wrong = []
    for path, want in ID_SHAPES:
        rule = card_rule_for_id(posted, path)
        pattern = (rule.get("filter") or [None])[0]
        got = None
        if pattern:
            found = _re.search(pattern, f"https://fixture.test{path}")
            got = found.group(rule.get("group", 0)) if found else None
        if got != want:
            wrong.append(f"{path!r} -> {got!r}, wanted {want!r} (pattern {pattern!r})")
        if pattern:
            # Only a *narrowed* rule drops `absolute`: the group has already reduced the address to
            # the id, so absolutising that would join the id to the page. An address with no number
            # in it is left exactly as the person marked it, `absolute` and all.
            assert "absolute" not in rule, f"{path}: the id would be url-joined to the page"
            assert rule.get("group") == 1, f"{path}: the id is not the captured group"
    assert not wrong, "the id rule is wrong on these shapes: " + "; ".join(wrong)


def test_the_choosing_page_serves_the_cards_and_records_a_choice():
    """The picker's clicking half, over the same loopback bargain as the annotation page: the
    cards are served, a choice is posted back to the tool, and nothing is moved by hand.

    "The first card of the set" is the default and not always the right answer — measured on a
    real search page whose first album link belonged to a recommendation block above the
    results — so the choice is made by looking at the covers.
    """
    import threading
    import time as _time
    import urllib.request
    import webbrowser

    from src.builder.session_server import choose_card

    webbrowser.open = lambda *_args, **_kwargs: False
    cards = [{"index": 0, "title": "第一张作品", "link": "/w/1",
              "cover_url": "https://x.test/c/1.jpg"},
             {"index": 1, "title": "第二张作品", "link": "/w/2", "cover_url": ""}]
    opened: list[str] = []
    box: dict[str, int] = {}

    thread = threading.Thread(
        target=lambda: box.update(chosen=choose_card("https://x.test/list", cards,
                                                     opened=opened)), daemon=True)
    thread.start()
    for _ in range(200):
        if opened:
            break
        _time.sleep(0.01)

    with urllib.request.urlopen(opened[0]) as reply:
        page = reply.read().decode("utf-8")
    assert "第一张作品" in page and "第二张作品" in page
    assert "/cover?i=0" in page, "a card with a cover URL gets a thumbnail"
    assert "/cover?i=1" not in page, "and one without does not"

    token = opened[0].split("token=")[-1]
    port = opened[0].split(":")[2].split("/")[0]
    posted = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/choose?token={token}", data=b'{"index": 1}',
        headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(posted) as reply:
        assert b'"ok": true' in reply.read()
    thread.join(timeout=10)

    assert box.get("chosen") == 1, "the choice the page made is what the tool waits for"


def test_the_choosing_page_resolves_an_iwara_protocol_relative_cover(monkeypatch):
    """The rendered Iwara card gives the chooser ``//i.iwara.tv/image/...``.

    A browser resolves that address automatically, but the chooser fetches the image through its
    loopback proxy.  The proxy must resolve it against the listing page before making the request.
    """
    from src.builder import session_server

    seen: dict[str, str | None] = {}

    def fetch(url: str, *, referer: str | None = None):
        seen.update(url=url, referer=referer)
        return 200, b"cover", "image/jpeg", url

    monkeypatch.setattr(session_server.unknown_url, "fetch", fetch)

    image = session_server.fetch_image(
        "//i.iwara.tv/image/thumbnail/file-id/thumbnail-12.jpg",
        "https://www.iwara.tv/profile/mingminga/videos",
    )

    assert image == (b"cover", ".jpg")
    assert seen == {
        "url": "https://i.iwara.tv/image/thumbnail/file-id/thumbnail-12.jpg",
        "referer": "https://www.iwara.tv/profile/mingminga/videos",
    }


def test_the_choosing_page_is_served_with_every_word_it_reads():
    """The page's script reads its words from the payload, so one missing word is a blank page.

    Measured by using the bat (2026-10-04): the chooser was handed the *annotation* page's chrome,
    which has no `count` at all. The script died on the line that reads it — the header had just
    been filled — and what a person saw after clicking the printed address was an empty page with a
    single URL on it. The page's words come from `l10n.chooser` now, and this holds the *served*
    document against the keys its own script reads, so a page cannot go out half-fed again.
    """
    import json as _json
    import re as _re
    import threading
    import time as _time
    import urllib.request
    import webbrowser

    from src.builder import text as l10n
    from src.builder.session_server import choose_card

    webbrowser.open = lambda *_args, **_kwargs: False
    cards = [{"index": 0, "title": "One", "link": "/w/1", "cover_url": None}]
    opened: list[str] = []
    box: dict[str, int] = {}

    thread = threading.Thread(
        target=lambda: box.update(chosen=choose_card("https://x.test/list", cards,
                                                     opened=opened)), daemon=True)
    thread.start()
    for _ in range(200):
        if opened:
            break
        _time.sleep(0.01)

    with urllib.request.urlopen(opened[0]) as reply:
        page = reply.read().decode("utf-8")

    payload, _end = _json.JSONDecoder().raw_decode(
        page[page.index("const DATA = ") + len("const DATA = "):])
    reads = set(_re.findall(r"\bT\.([A-Za-z][A-Za-z0-9]*)", page))
    assert reads, "a page whose script reads no words is a page whose script is gone"
    assert not (reads - set(payload["text"])), (
        f"the chooser page reads {sorted(reads - set(payload['text']))} and was not given them")

    # Its own page's words, not the annotation page's — that mix-up is exactly what emptied it.
    lang = l10n.lang_from_env()
    assert payload["text"]["docTitle"] == l10n.chooser(lang)["docTitle"]
    assert payload["text"]["docTitle"] != l10n.chrome(lang)["docTitle"]
    assert f"<title>{l10n.chooser(lang)['docTitle']}</title>" in page

    # Choosing a card is followed by the same wait the annotation page has after it is submitted
    # (the tool harvests that card and opens its page), so it is the same panel in the middle of the
    # screen — the header line it used to use is where nobody looks.
    assert 'id="veil"' in page
    assert ".veil.show { display:flex; }" in page
    assert "veil(T.submitting, '')" in page
    assert "veil(T.waitHeadline, fill(T.chosen" in page
    assert "veil(null, '')" in page

    token = opened[0].split("token=")[-1]
    port = opened[0].split(":")[2].split("/")[0]
    posted = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/choose?token={token}", data=b'{"index": 0}',
        headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(posted) as reply:
        assert b'"ok": true' in reply.read()
    thread.join(timeout=10)
    assert box.get("chosen") == 0


def test_a_sites_profile_is_its_own_directory_and_outside_the_repository_tree():
    """登录态的通用化只有一层：浏览器自己的会话。配置目录按 host 分开 ✓，放在工具目录下但被
    git 忽略 ✓ —— profile 里是 cookie 与 token ✓，属于**人**的东西，永不进仓库 ✓。工具本身
    从不接触凭据 ✗（密码是人敲进 Chrome 的 ✓）。"""
    import inspect

    from src.builder.capture import capture_browser, profile_for

    path = profile_for("18comic.vip")
    assert path.name == "18comic.vip"
    assert path.parent.name == "browser_profiles"
    assert "browser_profiles/" in (
        Path(__file__).resolve().parents[1] / ".gitignore").read_text(encoding="utf-8")

    signature = inspect.signature(capture_browser)
    assert signature.parameters["profile"].default is None, "默认行为必须一字不改"
    assert signature.parameters["login"].default is False


def test_a_browser_learned_artist_listing_keeps_opaque_ids_and_relative_dates(
        tmp_path, monkeypatch):
    """One generic path covers rendered lists, `/kind/<opaque-id>/<slug>` and recent dates."""
    from datetime import date, timedelta

    from build_listing import url_pattern_for
    from src.builder import capture as capture_module
    from src.generic.declarative import list_cards
    from src.generic.template import TargetRule, load_template

    listing_url = "https://media.test/profile/mingminga/videos?sort=date&page=0"
    work_url = "https://media.test/video/H9fsLsKTpR1Vcx/lucilla"
    work_pattern = r"^https?://media\.test(?:/video)/(?P<id>[^/]+)(?:/[^/]+)"
    html = """<main>
      <article class="card"><a href="/video/H9fsLsKTpR1Vcx/lucilla">Lucilla</a>
        <time>5 days ago</time></article>
      <article class="card"><a href="/video/bCiZIXUeR4tLq5/mornye">Mornye</a>
        <time>2026-09-01</time></article>
    </main>"""
    source_id = target_rule_for_id(
        {"from": "html", "select": "a", "attr": "href", "absolute": True},
        work_url, work_pattern)
    assert source_id is not None
    date_rule = _as_shipped(
        {"from": "html", "select": "time", "text": True}, "date_added", "5 days ago")
    rule = {
        "row_selector": "article.card",
        "fields": {
            "source_id": source_id,
            "detail_url": {"from": "html", "select": "a", "attr": "href", "absolute": True},
            "title": {"from": "html", "select": "a", "text": True},
            "date_added": date_rule,
        },
    }
    draft = listing_draft(
        host="media.test", kind="artist",
        url_pattern=url_pattern_for(listing_url, "page", "artist"),
        rule=rule, acquisition="browser")
    site = {
        "schema_version": 1, "key": "media.test", "display_name": "media.test",
        "tool": "media_test", "source_site": "media.test", "export_group": "media.test",
        "media_id_prefix": "media.test", "hosts": ["media.test"], **draft,
    }
    path = tmp_path / "site.json"
    path.write_text(json.dumps(site), encoding="utf-8")
    template = load_template(path)
    assert template.listings["artist"].acquisition == "browser"

    seen_profile = []

    def rendered(url, *, profile=None, **_kwargs):
        seen_profile.append(profile)
        return Capture(url=url, final_url=url, status=200,
                       documents=[Document(name="page", text=html, format="markup")])

    monkeypatch.setattr(capture_module, "capture_browser", rendered)
    cards = list_cards(template, "artist", {"id": "mingminga"},
                       {"target_url": listing_url, "profile_dir": tmp_path / "profile"})

    assert [card["source_id"] for card in cards] == ["H9fsLsKTpR1Vcx", "bCiZIXUeR4tLq5"]
    assert cards[0]["date_added"] == (date.today() - timedelta(days=5)).isoformat()
    assert cards[1]["date_added"] == "2026-09-01"
    assert seen_profile == [tmp_path / "profile"]
    matched = TargetRule(kind="artist", url_pattern=__import__("re").compile(
        draft["targets"]["artist"]["url_pattern"]), id_group=None, label="artist").match(listing_url)
    assert matched == {"id": "mingminga"}
