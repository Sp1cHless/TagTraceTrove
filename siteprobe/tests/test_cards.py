"""Phase 7: is a listing's repeated structure found, and can a card stand on its own?

The fixtures are three invented listings and one decoy. The decoy is the point: a page
with navigation and a tag cloud repeats *something* everywhere, and a detector that offers
those as cards has not found a listing, it has found the page's chrome.

`18comic_vip/samples/favorite_page.html` is the real shape the user's own crawl worked
from — a favourites page whose cards sit under `section.favorite-albums` while two look-alike
navigation links sit above them — so it is used here as the second opinion.

Run:  .venv/Scripts/python.exe -m pytest -q
"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder.capture import Document                      # noqa: E402
from src.builder.cards import (                               # noqa: E402
    card_page,
    cards_of,
    cards_of_group,
    find_card_groups,
    sample_card_html,
    to_html,
    _link_kind,
)
from src.builder.harvest import harvest                        # noqa: E402
from src.generic.htmltree import parse_html, select_one         # noqa: E402

BASE = "https://fixture.test/"
FAVORITE_SAMPLE = PROJECT_ROOT.parent / "18comic_vip" / "samples" / "favorite_page.html"

LISTING = """<!doctype html><html><body>
  <nav><a href="/home">Home</a><a href="/about">About</a><a href="/tags">Tags</a></nav>
  <ul id="grid">
    <li class="card"><a href="/work/11"><h3>First</h3></a>
      <img src="/c/11.jpg" width="300" height="420"></li>
    <li class="card"><a href="/work/12"><h3>Second</h3></a>
      <img src="/c/12.jpg" width="300" height="420"></li>
    <li class="card"><a href="/work/13"><h3>Third</h3></a>
      <img src="/c/13.jpg" width="300" height="420"></li>
  </ul>
</body></html>"""

# Cards that are *not* siblings: a grid that wraps every two of them in a row, which is
# what a responsive layout does and what a naive sibling scan misses.
WRAPPED = """<!doctype html><html><body>
  <div class="grid">
    <div class="row"><article class="card"><a href="/w/1">One</a><img src="/c/1.jpg"></article>
      <article class="card"><a href="/w/2">Two</a><img src="/c/2.jpg"></article></div>
    <div class="row"><article class="card"><a href="/w/3">Three</a><img src="/c/3.jpg"></article>
      <article class="card"><a href="/w/4">Four</a><img src="/c/4.jpg"></article></div>
    <div class="row"><article class="card"><a href="/w/5">Five</a><img src="/c/5.jpg"></article>
      <article class="card"><a href="/w/6">Six</a><img src="/c/6.jpg"></article></div>
  </div>
</body></html>"""

CHROME_ONLY = """<!doctype html><html><body>
  <nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a><a href="/d">D</a></nav>
  <footer><a href="/x">X</a><a href="/y">Y</a><a href="/z">Z</a></footer>
</body></html>"""


def test_a_listing_card_set_is_found_and_named():
    groups = cards_of(LISTING)

    assert groups, "no card group found on a listing"
    best = groups[0]
    assert best.count == 3
    assert best.selector == "li.card"
    assert set(best.hints) == {"url", "cover", "title", "id"}


def test_the_navigation_is_not_a_card_set():
    """A page of links repeats too. A card carries a link *and* something to look at."""
    assert cards_of(CHROME_ONLY) == []


def test_cards_wrapped_in_rows_are_still_one_set():
    """A responsive grid wraps every two cards in a row, so the cards are not siblings —
    the row is. The set is still one set, and it is the cards that repeat."""
    groups = cards_of(WRAPPED)

    selectors = {group.selector for group in groups}
    assert groups
    assert any("article.card" in selector for selector in selectors), selectors
    # Not the row, and not the cards of one row only.
    assert max(group.count for group in groups) >= 4, [g.to_json() for g in groups]


def test_a_card_becomes_a_page_the_harvester_can_read():
    """The whole design of this phase in one assertion: a card is lifted out and harvested
    as if it were a work page, so a listing field is learned by the same code as a work
    field — which is also how the runtime reads one (`extract.read_listing` scopes every
    field rule to a row)."""
    group = cards_of(LISTING)[0]
    capture = card_page(group, f"{BASE}list")

    result = harvest(capture)

    assert result.values("text"), "the card's text never reached the harvester"
    assert "First" in result.values("text")
    assert any("/c/11.jpg" in url for url in result.values("url") + result.values("image"))

    # And the rules it offers are relative: `a`, `h3`, `img`, not the page's own path to
    # the card. (The card's *own* selector does turn up — it is a `<li>`, and a `<li>` is
    # one of the prose blocks the harvester reads — which is a rule the listing learning
    # has to reject: inside a row, `li.card` names nothing at all.)
    named = {source.rule.get("select") for candidate in result.candidates
             for source in candidate.sources if source.rule}
    assert {"a", "img"} <= named or {"a", "img"} <= {name.split()[-1] for name in named}, named
    assert not any(name.startswith("ul#grid") for name in named)


def test_a_fragment_is_written_back_well_enough_to_reparse():
    """The card is handed to the parser as markup, so the round trip has to survive quotes,
    entities and void elements — `img` without a closing tag above all, which is most of
    what a card contains."""
    html = ('<div class="card" data-q="a &amp; &quot;b&quot;">'
            '<a href="/w/1?x=1&amp;y=2">A &amp; B</a><img src="/c/1.jpg"></div>')
    element = select_one(parse_html(html), "div")

    fragment = to_html(element)
    again = select_one(parse_html(fragment), "div")

    assert again.tag == element.tag
    assert again.attr("class") == "card"
    assert again.attr("data-q") == element.attr("data-q")
    assert "<img" in fragment and "</img>" not in fragment
    assert again.text() == element.text()


def test_the_real_favourites_sample_yields_its_cards():
    """The one real page on disk: a favourites listing whose cards sit in a section while
    two look-alike navigation links sit above them."""
    if not FAVORITE_SAMPLE.is_file():       # pragma: no cover - sample is the user's
        return
    html = FAVORITE_SAMPLE.read_text(encoding="utf-8", errors="replace")
    # Two cards, because the sample is deliberately small: the default bar is three, and
    # the bar is a parameter precisely so a small page can still be read.
    groups = find_card_groups(parse_html(html), minimum=2)

    assert groups, "no card group found in the real favourites sample"
    assert groups[0].selector.startswith("div.card")
    assert groups[0].count == 2


def test_a_shared_class_elsewhere_on_the_page_does_not_hijack_the_set():
    """A class is one thing; the block is another. A group's set is read inside its own block.

    Measured on a jable.tv model page (2026-10-05): the model's videos and the site's tag cloud both
    write `div.col-6.col-sm-4` — 145 elements carried the class, 24 of them were the works. Reading the
    class across the whole page made the *set* 111 tag links while the group the person was shown said
    "24 card(s)", and the majority-link-kind narrowing then followed the tag block — so the card the
    person marked as a work was a tag, and the rule learned to read tags. The two numbers must agree.
    """
    videos = "".join(
        f'<div class="col-6 col-sm-4"><a href="/videos/v{index}">'
        f'<img src="/c/{index}.jpg">Work {index}</a></div>'
        for index in range(1, 25))
    tags = "".join(
        f'<div class="col-6 col-sm-4"><a href="/tags/t{index}">Tag {index}</a></div>'
        for index in range(1, 112))
    html = ('<!doctype html><html><body>'
            f'<section class="videos"><h2>Videos</h2>{videos}</section>'
            f'<section class="tags"><h2>Tags</h2>{tags}</section>'
            '</body></html>')

    group = next(candidate for candidate in cards_of(html) if candidate.count == 24)
    members = cards_of_group(html, group)

    assert len(members) == group.count, (
        f"the set has {len(members)} cards but the group says {group.count}")
    # A card is the `<div>`; the link is inside it, so the judgement is the same one the tool makes.
    assert all("videos" in _link_kind(member) for member in members), (
        "the set followed another block's links")


def test_a_card_page_marks_itself_as_row_scoped():
    group = cards_of(LISTING)[0]
    capture = card_page(group, BASE)

    assert capture.documents[0].format == "markup"
    assert "relative to a row" in " ".join(capture.notes)
    assert sample_card_html(group).startswith("<li")
