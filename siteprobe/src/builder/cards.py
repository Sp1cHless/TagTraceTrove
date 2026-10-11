"""Phase 7: a listing page's repeated cards, found rather than described.

The plan's §16. A listing is a *set* of cards, and what makes one card different from the
next is only which one you are reading — so what a Builder needs is not "the selectors of
this page" but "the selector of one card, and the selectors inside it".

That is exactly how the runtime's listing contract already works: every field rule sees
**one row as its whole document** (`extract.read_listing`), so a listing field and a work
field are written in the same vocabulary. Which gives this phase its shape, and its
saving: a card can be lifted out of the page and harvested as if it were a small work
page, so the annotation page, the rule learning and the three-sample pruning all apply
unchanged. Nothing here needs a second vocabulary or a second UI.

What that leaves this module to do is the finding and the lifting:

* `find_card_groups` — which repeated structures on the page look like cards;
* `card_page` — one card as its own document, ready for `harvest`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlparse
from typing import Any

from ..generic.htmltree import Element, parse_html, select_all
from .capture import Capture, Document
from .harvest import element_selector, selector_matches

# A card set smaller than this is not a listing: three is the point at which "the same
# thing again" becomes a structure rather than a coincidence, which is the same bar the
# collection candidates use (`MIN_COLLECTION`).
MIN_CARDS = 3

# Elements that never have a closing tag, so the fragment has to write them as they are.
VOID_TAGS = frozenset(
    ("area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
     "param", "source", "track", "wbr"))

# What a card is expected to carry, in the plan's §2.3 order. Used to say on the page what
# a group looks like it is, never to decide for the person which group is the one.
CARD_HINTS = ("url", "title", "cover", "id")


@dataclass
class CardGroup:
    """One repeated structure, and what a representative member looks like it carries."""

    selector: str                 # names one card within the whole page
    count: int                    # how many cards the page carries
    container: str                # the block they repeat inside
    element: Element = field(repr=False, default=None)   # a representative card
    channel: str = "markup"
    hints: tuple[str, ...] = ()
    score: int = 0
    #: The block to read the cards *inside*, when the class alone names more than this set. Measured on
    #: a jable.tv model page (2026-10-05) whose tag cloud and video list both write
    #: `div.col-6.col-sm-4` — the person was shown 24 works while the rule written for them read 145
    #: elements, so every check and the crawl judged the wrong rows. The block is the only thing that
    #: tells the two apart (the videos carry no class the tags lack), so a shipped rule carries it too.
    scope: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {"selector": self.selector, "count": self.count, "container": self.container,
                "scope": self.scope,
                "channel": self.channel, "hints": list(self.hints), "score": self.score}


def _signature(element: Element) -> tuple[str, tuple[str, ...]]:
    """What makes two siblings the same *kind* of thing.

    The tag plus the first two classes: a page that writes `card card--wide` and `card`
    is writing the same card twice, and a page that writes `card` and `banner` is not.
    """
    classes = tuple(sorted((element.attr("class") or "").split())[:2])
    return element.tag, classes


def _looks_like_a_card(element: Element) -> bool:
    """A card holds something to read and something to go to.

    Without this, every list of `<li>`s on the page is a card set — navigation, tag chips,
    footer columns — and the person is asked to choose between forty of them. Measured on
    a real gallery page, the sections that matter carry a link and an image; the ones that
    do not are chrome.
    """
    has_link = any(True for _ in element.iter() if _.tag == "a" and _.attr("href"))
    has_image = any(True for _ in element.iter() if _.tag in ("img", "source", "picture"))
    return has_link and has_image


def _hints(element: Element, base: str = "") -> tuple[str, ...]:
    """Which of the card's fields this structure visibly carries."""
    found: list[str] = []
    if any(_.tag == "a" and _.attr("href") for _ in element.iter()):
        found.append("url")
    if any(_.tag in ("img", "source", "picture") for _ in element.iter()):
        found.append("cover")
    for child in element.iter():
        if child.tag in ("h1", "h2", "h3", "h4", "a", "span", "div", "p") \
                and len(child.text()) >= 3:
            found.append("title")
            break
    for child in element.iter():
        if child.tag == "a" and re.search(r"\d{2,}", child.attr("href") or ""):
            found.append("id")
            break
    return tuple(name for name in CARD_HINTS if name in found)


def find_card_groups(root: Element, *, minimum: int = MIN_CARDS,
                     limit: int = 12) -> list[CardGroup]:
    """Every repeated structure on the page that looks like a set of cards.

    Sibling elements of one kind, three or more of them, each carrying a link and an
    image. Groups nested inside a group already kept are dropped: a card's own tag list
    repeats too, and offering it as a listing would put the person to work choosing
    between a page's cards and the chips inside one of them.
    """
    groups: list[CardGroup] = []
    for container in root.iter():
        # Two levels, not one: a responsive grid wraps every two or three cards in a row,
        # so the cards are not siblings — the row is — and a detector that only looks at
        # direct children finds three rows where the page has twelve works.
        for depth in (1, 2):
            for _shape, members in _by_shape(container, depth).items():
                # A set that mixes kinds of link is a set plus the page's own tabs. Measured
                # on a real search page: its largest group was fifteen works and four shard
                # links (`?shunt=1`), and the member the tool marked was one of the tabs.
                # Keeping the majority kind leaves the works, and the first of them is the
                # first on the page.
                majority = _majority_link_kind(members)
                if majority is not None:
                    members = [member for member in members if _link_kind(member) == majority]
                if len(members) < minimum:
                    continue
                if not all(_looks_like_a_card(member) for member in members):
                    continue
                hints = _hints(members[0])
                if "url" not in hints:
                    continue
                groups.append(CardGroup(
                    selector=element_selector(members[0]),
                    count=len(members),
                    container=(element_selector(container) if container is not root
                               else "(page)"),
                    element=members[0],
                    hints=hints,
                    # Deterministic and explicable, like every other score here: how many
                    # cards, and how much of a card each one is. A set of a hundred bare
                    # links is one field; a set of twelve cards carrying a link, a cover
                    # and a title is the listing.
                    score=min(len(members), 60) + 20 * len(hints),
                ))
    kept: list[CardGroup] = []
    for group in sorted(groups, key=lambda item: (-item.score, -item.count, item.selector)):
        if any(_inside(group.element, other.element) or _inside(other.element, group.element)
               for other in kept):
            continue
        kept.append(group)
        if len(kept) >= limit:
            break
    return kept


def _by_shape(container: Element, depth: int) -> dict[tuple[str, tuple[str, ...]], list[Element]]:
    """The elements `depth` levels under this container, grouped by shape."""
    level = [child for child in container.children if isinstance(child, Element)]
    for _ in range(depth - 1):
        level = [child for element in level
                 for child in element.children if isinstance(child, Element)]
    grouped: dict[tuple[str, tuple[str, ...]], list[Element]] = {}
    for element in level:
        grouped.setdefault(_signature(element), []).append(element)
    return grouped


def _link_kind(element: Element) -> tuple[str, str] | None:
    """What kind of page this card's own link points at: host and first path segment.

    `/album/1472965/…` and `?shunt=1` are not the same kind of thing, and a card set that
    holds both is a card set with the page's tabs in it — measured on a real search page,
    whose largest group was fifteen works and four shard links.
    """
    for child in element.iter():
        if child.tag != "a":
            continue
        href = child.attr("href")
        if not href:
            continue
        parsed = urlparse(href)
        segments = [part for part in parsed.path.split("/") if part]
        return (parsed.netloc, segments[0] if segments else "")
    return None


def _majority_link_kind(members: list[Element]) -> tuple[str, str] | None:
    """The kind of link most of these cards carry, when there is one."""
    counts: dict[tuple[str, str], int] = {}
    for member in members:
        kind = _link_kind(member)
        if kind is not None:
            counts[kind] = counts.get(kind, 0) + 1
    if not counts:
        return None
    kind, count = max(counts.items(), key=lambda pair: pair[1])
    return kind if count * 2 >= len(members) else None


def _inside(one: Element, other: Element) -> bool:
    """Whether `one` is `other` or sits inside it."""
    node: Element | None = one
    while node is not None:
        if node is other:
            return True
        node = node.parent
    return False


def to_html(element: Element) -> str:
    """One element written back as markup, which is how a card becomes its own page.

    There is no serializer in `htmltree` — the tree is read-only by design, and nothing
    before this phase needed to write a fragment back. A card does: the whole point is to
    hand it to the harvester as if it were a page, so that a listing field is learned by
    the same code as a work field.
    """
    attrs = "".join(f' {name}="{_escape(value)}"' for name, value in element.attrs.items())
    if element.tag in VOID_TAGS:
        return f"<{element.tag}{attrs}>"
    inner = "".join(child if isinstance(child, str) else to_html(child)
                    for child in element.children)
    return f"<{element.tag}{attrs}>{inner}</{element.tag}>"


def _escape(value: str) -> str:
    return (value.replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


def card_page(group: CardGroup, page_url: str, name: str = "page") -> Capture:
    """One card, as a capture the existing harvester can read.

    The card becomes the whole document, which is the same view the runtime takes of a
    row (`extract.read_listing` scopes every field rule to one row). The card's own
    absolute selector is kept in the notes rather than in the document: the harvest has to
    see what is *inside* the card, and a selector that names the card means nothing there.
    """
    html = f"<!doctype html><html><body>{to_html(group.element)}</body></html>"
    capture = Capture(url=page_url, final_url=page_url)
    capture.status = 200
    capture.content_type = "text/html"
    capture.documents = [Document(name=name, format="markup", text=html, source_url=page_url)]
    capture.notes = [
        f"harvested from one card of {group.count} ({group.selector}), so every rule "
        "here is relative to a row",
    ]
    return capture


def cards_of_group(html: str, group: CardGroup, *,
                   root: Element | None = None) -> list[Element]:
    """The group's cards, in document order, without the page's own look-alikes.

    The selector is a class, and a class can be shared: measured on a real search page, the
    four "shard" links at the top of the results carried the very same `col-xs-6 col-sm-4` as
    the works. So the members are read **inside the block the group repeats in** (`container`, which the
    detector already knows) and then narrowed to the kind of link the majority of them points at
    (`/album/…` here) — a structural judgement, not a site's — and returned in document order, which is
    what makes the first one the first on the page.

    Reading the class across the *whole page* is what made a model page's tag cloud the set: measured on
    jable.tv (2026-10-05), whose tag list and video list both write `div.col-6.col-sm-4` — 145 elements
    carried it, 24 were the works, and the set came out as **111 tag links** while the group the person
    was shown said "24 card(s)". The narrowing then judged the wrong block, so the card the person
    marked was a tag and the learned rule described tags. Scoping first, narrowing second, keeps those
    two numbers equal.
    """
    # `root` is passed by a caller that needs the same tree it already has (identity comparisons
    # between two parses of one page are meaningless: `Element.order` is a global counter).
    tree = root if root is not None else parse_html(html)
    members = _members_of(tree, group)
    majority = _majority_link_kind(members)
    if majority is not None:
        narrowed = [member for member in members if _link_kind(member) == majority]
        if narrowed:
            members = narrowed
    return members


def _members_of(root: Element, group: CardGroup) -> list[Element]:
    """The group's members: its class, read inside the block it repeats in.

    A container selector can match more than one block, and the group's own `count` is the number the
    person was shown — so the block whose members come closest to it is the block that was described.
    When no container resolves, the class is read across the page, which is what this did everywhere
    before.
    """
    blocks = [select_all(container, group.selector)
              for container in (select_all(root, group.container) if group.container else [])]
    blocks = [members for members in blocks if members]
    if not blocks:
        return select_all(root, group.selector)
    return min(blocks, key=lambda members: abs(len(members) - group.count))


def cards_of(html: str) -> list[CardGroup]:
    """The card groups of a page of markup."""
    return find_card_groups(parse_html(html))


def preview_of(group: CardGroup) -> dict[str, str]:
    """What this card set looks like, in the words a person recognises.

    The group listing used to print the selector — `div.imageset`, `div.acg` — which is the
    Builder's own vocabulary and says nothing about which block of the page it is. Measured on
    a real artist page, whose layout carries two sets of cards at once: twenty works and five of
    something else. Neither selector says which is the list, and asking a person to know what
    `acg` means is asking them to read the site's stylesheet.

    What does tell them is the card's own content: its title, where its link goes, and the
    cover's file name. Three strings, each recognisable at a glance from the page they just
    looked at.
    """
    title = ""
    for child in group.element.iter():
        if child.tag in ("h1", "h2", "h3", "h4", "a", "div", "span", "p"):
            text = child.text()
            if len(text) >= 3:
                title = text
                break
    link = ""
    for child in group.element.iter():
        href = child.attr("href") if child.tag == "a" else None
        if href:
            link = urlparse(href).path or href
            break
    cover_url = _cover_source(group.element)
    cover = urlparse(cover_url).path.rsplit("/", 1)[-1] if cover_url else ""
    return {"title": title[:64], "link": link[:52], "cover": cover[:40],
            "cover_url": cover_url}


# Where a lazy-loaded image keeps its real address, best first. `src` is last on purpose: it is
# where the placeholder lives, and measured on a real gallery the choosing page showed a blank
# strip for every card because `src` was read first and the real cover sat in `data-original`.
LAZY_ATTRS = ("data-original", "data-src", "data-lazy-src", "data-echo", "data-url", "src")

# Names a placeholder goes by. Not one site's vocabulary: every lazy loader ships something like
# one of these, and a card whose only image is `blank.jpg` has no cover to show.
PLACEHOLDER_MARKS = ("blank", "placeholder", "loading", "spacer", "pixel", "1x1", "transparent")


def _plausible_cover(url: str) -> bool:
    lowered = url.casefold()
    return bool(url) and not any(mark in lowered for mark in PLACEHOLDER_MARKS)


def _cover_source(element: Element) -> str:
    """The card's own cover address, skipping the placeholder a lazy loader leaves behind."""
    for child in element.iter():
        if child.tag not in ("img", "source"):
            continue
        candidates = [child.attr(name) for name in LAZY_ATTRS]
        srcset = child.attr("srcset") or child.attr("data-srcset") or ""
        if srcset:
            candidates.append(srcset.split(",")[0].strip().split(" ")[0])
        for candidate in candidates:
            if candidate and _plausible_cover(candidate):
                return candidate.strip()
    return ""


def selector_count(group: CardGroup, html: str) -> int:
    """How many elements the group's card selector names on the page it came from."""
    return selector_matches(parse_html(html), group.selector)


def sample_card_html(group: CardGroup) -> str:
    """The representative card as markup, for a report or a preview."""
    return to_html(group.element)


def card_elements(html: str, selector: str) -> list[Element]:
    """Every card the selector names, for checking a listing rule against a page."""
    return select_all(parse_html(html), selector)
