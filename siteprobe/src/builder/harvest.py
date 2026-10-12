"""Turn a capture into candidates: everything that could be a field, with provenance.

Phase 2 of `siteprobe-completion-plan.md`. The plan is explicit about what this is
for, and it is not extraction:

    Candidate Harvester 不应直接判断"这是 author / tag / title"，而应优先完成
    抓取 → 归一化 → 去重 → 类型化 → 建立来源关系 → 排序展示

So nothing here decides that a value *is* a title. It decides that a value exists,
records every place it was seen, and orders them so the plausible ones are read
first. That order is a convenience; the set is the deliverable.

Two consequences shape the code:

* **Recall over precision.** A candidate that ranks badly can still be chosen by a
  person; one that was never offered cannot be recovered. Nothing is dropped for
  looking implausible — only for being provably not a value at all.
* **One record per value, many sources.** The same title on a page arrives in the
  markup, in `og:title`, in JSON-LD and in an API response. The plan's §6.3 merges
  those into one candidate listing four sources, and §7 treats agreement between
  sources as the strongest ranking signal there is — which only works if the
  channels run before anything is scored.

Channels, in the order they were worth building (measured in Phase 1):

    markup     headings, <title>, link text, meta, attributes, data-*
    jsonld     structured data, flattened to dotted paths
    network    an API response body, flattened the same way
    inline     framework state inside a <script>, when it can be parsed at all
    media      images, with whatever size hints the page declares

The `inline` channel is honest about its own limit: framework state is minified
JavaScript with values behind positional parameters, and reading that properly
needs a JavaScript evaluator, which is later work. What it does here is parse what
*is* JSON and fall back to a bounded scan of string literals — recall, marked as
the weaker evidence it is.
"""

from __future__ import annotations

import html
import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator
from urllib.parse import urljoin, urlparse

from ..generic.htmltree import Element, parse_html, select_all, select_one
from ..generic.document import Document as RuntimeDocument, DocumentBag
from ..generic.dates import date_kind, extract_date, labelled_dates, labelled_filter
from . import text as l10n
from ..generic.select import SelectorError, _element_values, resolve, split_members
from ..generic.text_normalization import decode_entities
from ..generic.unknown_url import (
    boilerplate_reason,
    comparison_url,
    in_site_chrome,
    jsonld_nodes,
)
from .capture import Capture, Document

SCORE_AGREEMENT = 3       # an independent channel saw the same value
SCORE_STRUCTURED = 2      # meta / JSON-LD / an API: the site declared it
SCORE_SUBJECT = 3         # the response is about this page's own work
SCORE_FIELD_KEY = 3       # the path's own key names a field, not a parameter
SCORE_SHALLOW = 1         # the value sits at the top of the subject's own object
SCORE_HEADING = 2         # it was a heading, which is what a person reads first
SCORE_NAMED_COVER = 2     # the image or its URL says it is a cover
SCORE_DECLARED_COVER = 2  # the site declares this URL as *the* image
SCORE_EARLY = 2           # among the first images, where a work's own image sits
SCORE_VISIBLE = 1         # it also appears in the page's visible text
SCORE_DATE_LIKE = 3       # its value is shaped like a date, so it answers "date"
PENALTY_CHROME = 3        # it looks like site furniture
PENALTY_LIST_MEMBER = 3   # it is one entry of a list of other things
PENALTY_UNKEYED = 2       # a script literal with no key: data, but no path

# Keys whose contents are a list of *other* things: other works, other people's
# comments, other suggestions. A value under one of them is not this page's own,
# however well-formed it looks — measured on a real API, where the page's own work
# sits at the root of one response while its neighbours sit under `results[]` of
# another, and the two are shaped identically.
LIST_KEYS = ("results", "related", "recommend", "recommendations", "comments",
             "suggestions", "similar", "items", "children", "posts", "latest",
             "popular", "more")
_INDEX = re.compile(r"\[(\d+)\]")

# Keys that name a field of the thing itself, as opposed to a parameter of the
# response that carried it. The plan's §7 lists "structured data 标准 key" and
# "API key 稳定" as ranking signals; measured on a real API, this is what separates
# `title` from `limit` and `numComments`, which sit in the same object.
FIELD_KEYS = ("title", "name", "headline", "label", "cover", "image", "images",
              "thumbnail", "thumbnailurl", "poster", "preview", "author", "authors",
              "creator", "artist", "artists", "user", "username", "date", "dates",
              "published", "publishedat", "createdat", "updatedat", "uploaddate",
              "description", "summary", "body", "content", "slug", "id", "series",
              "characters", "tags", "genre", "language", "pages", "page_count")

# The document a generated adapter must expose the page's JSON-LD blocks under, for
# a `json` selector to read them at all.
JSONLD_DOCUMENT = "jsonld"

MAX_JSON_DEPTH = 6
MAX_JSON_VALUES = 3000
MAX_STRING_SCAN = 400
MAX_BLOCK_LENGTH = 400
MAX_BLOCKS = 200
# A single character is a value: a volume number is "1". The punctuation-only test
# below is what rejects noise, not a length floor, because a value that was dropped
# for looking short cannot be recovered by any amount of ranking.
MIN_TEXT_LENGTH = 1
# The string scan inside a minified bundle is the one place short junk arrives in
# bulk, so it is the one place with a floor of its own.
MIN_SCANNED_LENGTH = 2

HEADINGS = ("h1", "h2", "h3", "h4")
# Blocks that carry prose. A description is a field (plan §13.1), so its text has
# to be offered — but it is the lowest value per unit of noise, so the count and
# the length are both bounded and each one is attributed to its own element.
#
# `span` and `div` are in the list because that is where a byline lives
# (`<span class="byline">Lin Wei</span>`), and a creator is a field. They are also
# where most of a page's noise lives, which is why the bounds exist and why nothing
# here is scored as a heading or as structured data.
PROSE_BLOCKS = ("p", "li", "dd", "figcaption", "blockquote", "span", "div")
IMAGE_ATTRS = ("data-original", "data-src", "data-lazy-src", "data-actualsrc", "src")
# Where else a page keeps an image, all of them listed in the plan's §4.6.
#
#   srcset    the first candidate of a responsive set
#   poster    a video's own still
#   style     a CSS `background-image`, which is where a player keeps its poster —
#             measured on a real page, the work's very own cover was a background on
#             a `vjs-poster` div while every `<img>` on that page was a *related*
#             work, so a harvester reading only `img` offered every thumbnail except
#             the right one
_SRCSET_FIRST = re.compile(r"^\s*([^\s,]+)")
_BACKGROUND = re.compile(r"url\(\s*[\"']?([^\"')]+)", re.IGNORECASE)
#: What `_media_sources` marks a painted picture with. A style attribute is not an attribute a rule
#: can simply name, so this reading is built by hand where the rule is made (`harvest_media`).
BACKGROUND_SOURCE = "style[background-image]"


def background_urls(style: str | None) -> list[str]:
    """The URLs a style attribute paints with, in the order it paints them."""
    return [match.group(1).strip() for match in _BACKGROUND.finditer(style or "")]
_QUOTED = re.compile(r"""["']((?:[^"'\\]|\\.){2,300})["']""")
_JSON_ASSIGNMENT = re.compile(
    r"""(?P<key>[A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*=\s*(?P<body>\{.*?\}|\[.*?\])\s*[;<]""",
    re.DOTALL,
)
_JSON_SCRIPT = re.compile(r"""type\s*=\s*["']application/(?:ld\+)?json["']""", re.IGNORECASE)
_TRAILING_PUNCTUATION = "。．.,;，；:：!！?？"
NOT_A_VALUE = re.compile(r"^[\s\W_]+$")          # punctuation only
LOOKS_LIKE_MARKUP = re.compile(r"[{}<>]|;\s|\bpx\b|\bvar\s|function\s*\(")


@dataclass
class Source:
    """Where one value was seen, and the rule that would read it again.

    `detail` says it in prose, for a person reading the candidate list. `rule` says
    it in the runtime's own selector vocabulary, so that choosing a candidate *is*
    choosing a rule — without it, annotation would produce a field name and nothing
    executable, and the rule would have to be reverse-engineered from the prose.
    """

    channel: str
    document: str
    detail: str
    rule: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"channel": self.channel, "document": self.document,
                                   "detail": self.detail}
        if self.rule:
            payload["rule"] = self.rule
        return payload


@dataclass
class Candidate:
    """One value, every place it was seen, and how plausible that makes it."""

    kind: str                 # text | url | number | image
    value: str                # normalized — what deduplication compares
    display: str              # as written on the page
    sources: list[Source] = field(default_factory=list)
    context: dict[str, Any] = field(default_factory=dict)
    score: int = 0
    candidate_id: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "kind": self.kind,
            "normalized_value": self.value,
            "display_value": self.display,
            "sources": [source.to_json() for source in self.sources],
            "context": self.context,
            "score": self.score,
        }


@dataclass
class Harvest:
    """The candidates from one capture, the plan's `candidates.json`."""

    url: str
    candidates: list[Candidate] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def by_kind(self, kind: str) -> list[Candidate]:
        return [candidate for candidate in self.candidates if candidate.kind == kind]

    def values(self, kind: str | None = None) -> list[str]:
        return [candidate.value for candidate in self.candidates
                if kind is None or candidate.kind == kind]

    def to_json(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "count": len(self.candidates),
            "notes": self.notes,
            "candidates": [candidate.to_json() for candidate in self.candidates],
        }

    def write(self, path) -> Any:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_json(), ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
        return path


# --- what a value is -------------------------------------------------------- #

def normalize_text(value: str) -> str:
    """The comparison form: Unicode-normalized, whitespace-collapsed, stripped.

    Folding belongs here, on the identity — never on the value. A value the page
    writes with a full-width comma must stay written that way, because a rule reads
    the page's own characters and the two would otherwise never compare equal.
    """
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip()


def page_text(value: str) -> str:
    """The value as the page shows it: whitespace collapsed, nothing else changed."""
    return re.sub(r"\s+", " ", value).strip()


def text_identity(value: str) -> str:
    """What deduplication compares for a text value that came from JSON."""
    return normalize_text(decode_entities(value))


# --- what a value is worth as a whole --------------------------------------- #
#
# A field's value is a string, except when it is a collection, and then it is the list
# of its members. Both shapes travel: the annotation carries a list for `tags`, the
# rule that reads tags returns a list, and the record's category list is a list. The
# three helpers below are how the two are compared, and they are here rather than in
# one module because the harvester, the annotation and the learner all need the same
# answer — three private copies of "are these the same value" disagree eventually.

def members_of(value: Any) -> list[str]:
    """A value as the members it holds.

    A list keeps its own members; anything else is a single value. `None` holds
    nothing, which is not the same as holding an empty string — a rule that read
    nothing is a finding, and the caller has to be able to tell.
    """
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [str(member) for member in value]
    return [str(value)]


def joined_value(value: Any) -> str:
    """A value written as one line, which is how a collection is shown and read back."""
    return COLLECTION_JOIN.join(members_of(value))


def same_members(one: Any, other: Any) -> bool:
    """Whether two values hold the same members, in the same order.

    Order matters because both sides come from the same document: a rule reading the
    page's own elements sees them in the page's order, which is the order the
    annotation recorded. A rule that also swept up a neighbouring list then differs in
    length rather than in order, and is pruned either way.
    """
    left, right = members_of(one), members_of(other)
    if len(left) != len(right):
        return False
    return all(normalize_text(one_member).casefold() == normalize_text(other_member).casefold()
               for one_member, other_member in zip(left, right))


def normalize_url(value: str, base: str) -> str | None:
    """An absolute http(s) address with its fragment dropped, or None.

    A fragment never changes which resource is fetched, and the plan's §6.2 keeps
    the comparison identity apart from the fetch URL for exactly this reason.
    """
    candidate = urljoin(base, value.strip())
    # A site that writes `&amp;amp;` in its own markup leaves `&amp;` after the parser's
    # one decode, and that is not a URL — it is a URL with an entity in it. Decoding
    # what remains only ever turns it into the address the markup meant.
    if "&" in candidate:
        candidate = html.unescape(candidate)
    parsed = urlparse(candidate)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return parsed._replace(fragment="").geturl()


def looks_like_a_path(value: str) -> bool:
    """Whether a string is an address rather than a name.

    Needed because `urljoin` resolves *anything*: "Lantern Season" joined to a base
    is a perfectly valid URL, so a channel that resolved every string would offer a
    fictional address for every value it saw.
    """
    text = value.strip()
    if text.startswith(("http://", "https://", "//", "/")):
        return True
    return bool(re.search(r"\.(?:jpe?g|png|webp|avif|gif|svg|mp4|webm|json)(?:$|[?#])",
                          text, re.IGNORECASE))


def classify(value: str) -> str:
    if value.startswith(("http://", "https://")):
        return "url"
    if re.fullmatch(r"\d{1,6}(?:\.\d+)?", value):
        return "number"
    return "text"


def is_a_value(raw: str) -> bool:
    """Whether a string is worth keeping at all — not whether it is a title.

    Names are short, so a long run of punctuation or a piece of markup is not a
    value under any reading; everything else is offered and ranked.
    """
    text = raw.strip()
    if len(text) < MIN_TEXT_LENGTH or NOT_A_VALUE.match(text):
        return False
    return not LOOKS_LIKE_MARKUP.search(text)


# --- flattening ------------------------------------------------------------- #

def dotted_path(parts: Iterable[Any]) -> str:
    """`a.b[0].c` — the path syntax the runtime's `json` selector already reads."""
    path = ""
    for part in parts:
        if isinstance(part, int):
            path += f"[{part}]"
        else:
            path += ("." if path else "") + str(part)
    return path


def flatten_json(payload: Any, prefix: tuple[Any, ...] = ()) -> Iterator[tuple[str, Any]]:
    """Every scalar in a JSON document, as (dotted path, value)."""
    stack: list[tuple[tuple[Any, ...], Any]] = [(prefix, payload)]
    emitted = 0
    while stack and emitted < MAX_JSON_VALUES:
        path, node = stack.pop()
        if len(path) > MAX_JSON_DEPTH:
            continue
        if isinstance(node, dict):
            for key, value in node.items():
                stack.append(((*path, key), value))
        elif isinstance(node, list):
            for index, value in enumerate(node[:50]):
                stack.append(((*path, index), value))
        else:
            emitted += 1
            yield dotted_path(path), node


def parse_loose(text: str) -> Any | None:
    """JSON out of a string that may be escaped, wrapped, or surrounded by script.

    Only what parses as JSON is returned. A minified function call is *not* JSON
    and is not guessed at here — that is the JavaScript evaluator the plan leaves
    for later.
    """
    cleaned = text.strip().rstrip(";")
    for candidate in (cleaned, cleaned.replace("\\u002F", "/"), cleaned.replace("\\/", "/")):
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = cleaned.find(opener), cleaned.rfind(closer)
        if 0 <= start < end and end - start > 1:
            try:
                return json.loads(cleaned[start:end + 1])
            except (json.JSONDecodeError, ValueError):
                continue
    return None


# --- the harvester ---------------------------------------------------------- #

class _Registry:
    """One candidate per (kind, value), however many channels saw it."""

    def __init__(self) -> None:
        self._by_key: dict[tuple[str, str], Candidate] = {}
        self.notes: list[str] = []
        self.markup_roots: dict[str, Element] = {}

    def add(self, kind: str, raw: str, source: Source,
            context: dict[str, Any] | None = None,
            identity: str | None = None) -> Candidate | None:
        """Add a value, merging it into an existing candidate by its *identity*.

        `identity` is what deduplication compares, which is not always what gets
        shown: two addresses differing only by a tracking parameter are one
        candidate, whose value is the address that was actually on the page.
        """
        raw = raw.strip()
        if not raw:
            return None
        # A URL is judged by being a URL, not by the markup test: `;jsessionid=`
        # and `<`-free query strings are ordinary in addresses. A number is judged
        # by being a number, not by length — a volume or chapter is one digit.
        if kind == "number":
            pass
        elif kind == "url":
            if len(raw) < MIN_TEXT_LENGTH:
                return None
        elif not is_a_value(raw):
            return None
        # The value stays what the page says; the *identity* is what deduplication
        # compares. NFKC-folding the value itself broke every field whose text holds
        # a full-width comma or exclamation: the rule reads the page's own characters,
        # so the stored value could never equal what the rule returned.
        identity_value = raw if kind in ("url", "number") else text_identity(raw)
        normalized = raw if kind in ("url", "number") else page_text(raw)
        if not normalized:
            return None
        if kind not in ("url", "number") and not is_a_value(normalized):
            return None
        key = (kind, identity or identity_value)
        existing = self._by_key.get(key)
        if existing is not None:
            if not any(item.channel == source.channel and item.detail == source.detail
                       for item in existing.sources):
                existing.sources.append(source)
            return existing
        candidate = Candidate(kind=kind, value=normalized, display=raw,
                              sources=[source], context=dict(context or {}))
        self._by_key[key] = candidate
        return candidate

    def all(self) -> list[Candidate]:
        return list(self._by_key.values())

    def remove(self, candidate: Candidate) -> None:
        for key, value in list(self._by_key.items()):
            if value is candidate:
                del self._by_key[key]


def _add_url(registry: _Registry, absolute: str, source: Source,
             context: dict[str, Any] | None = None) -> None:
    """Offer an address, deduplicated on what it points at rather than how it is written.

    Two addresses differing only by a fragment or a tracking parameter are one
    candidate; the value kept is the address that was actually on the page, since
    that is the one a rule would have to fetch.
    """
    registry.add("url", absolute, source, context, identity=comparison_url(absolute))


def element_selector(element: Element) -> str:
    """A selector specific enough to name this element again.

    An id beats a class beats a tag, which is the order of how much a redesign leaves
    alone. Measured in Phase 1: the rules a page actually needs look like
    `h1.detail-main-info-title` and `img.lazy`, not like `h1`.

    A bare tag is not a selector when the element carries neither, and it is what a
    real page punished: `li` matched 166 elements and `a` matched 195, so a rule
    derived from the fourth info row read the first navigation item instead. When the
    element itself says nothing, the nearest ancestor that does is what names it —
    `ul.acg-info li` describes the row, `li` describes the page.

    Of those ancestors an **id** beats a class wherever it sits, which is the second
    half of that lesson and was measured on an actual gallery: three lists — artists,
    group, series — were each `ul.comma-list` and nothing else, so all three collapsed
    into one selector that matched three elements and read the first. Each list's own
    identity was one level up and unique (`h2#artists`, `td#series`), and a class the
    page repeats is not an identity however close to the element it is.

    An id that carries a long number is skipped, because that is the one thing an id
    is not always good for: `#post-12345` names this page's post and nothing on the
    next page. The class beside it is the fallback, which is also what this returned
    before the id preference existed — so a page-specific id costs nothing, and the
    three-sample validation never sees a rule that could only ever have read one page.
    """
    own = _self_selector(element)
    if own is not None:
        return own
    fallback: str | None = None
    ancestor = element.parent
    while ancestor is not None:
        identifier = ancestor.attr("id")
        if identifier and not PAGE_SPECIFIC_ID.search(identifier):
            return f"#{identifier} {element.tag}"
        if fallback is None:
            context = _self_selector(ancestor)
            if context is not None:
                fallback = f"{context} {element.tag}"
        ancestor = ancestor.parent
    return fallback or element.tag


# `post-12345`, `comment-99`, `item-2024-07`: an id the page minted for one entry.
PAGE_SPECIFIC_ID = re.compile(r"\d{3,}")

# What a block says it *is*, rather than how it looks. `itemprop` and `property` are
# microdata/RDFa; `data-type` is a site writing the same idea by hand.
DECLARING_ATTRS = ("itemprop", "property", "data-type")


def _self_selectors(element: Element) -> list[str]:
    """Every way this element names itself, best first.

    An id, then each **declaring attribute**, then a class — a class being a styling hook
    a redesign moves, while `itemprop="author"` is the page stating what the block is.
    All of them, not just the best one, because which declaration discriminates is the
    page's business: measured on a real album, every tag type declared
    `itemprop="author"` (作品, 作者 and 標籤 alike) and only `data-type` told them apart,
    so the first declaration read the work's tags where the author was meant.
    """
    names: list[str] = []
    identifier = element.attr("id")
    if identifier and not PAGE_SPECIFIC_ID.search(identifier):
        names.append(f"#{identifier}")
    for name in DECLARING_ATTRS:
        value = element.attr(name)
        if value and not value.startswith(("http://", "https://")):
            names.append(f'{element.tag}[{name}="{value}"]')
    classes = (element.attr("class") or "").split()
    if classes:
        names.append(element.tag + "".join(f".{name}" for name in classes[:2]))
    return names


def _self_selector(element: Element) -> str | None:
    """This element named by the best of what it says about itself, or None."""
    names = _self_selectors(element)
    return names[0] if names else None


def selector_matches(root: Element, selector: str,
                     cache: dict[str, Any] | None = None) -> int:
    """How many elements a generated selector matches on this page.

    A rule derived from one candidate is a hypothesis, not an answer: `a` matches
    every link on the page, so it reads the first link's text rather than the one it
    was derived from. Measured here so the page can say which rules are ambiguous,
    and so the three-sample validation has something to prune on.
    """
    key = "count:" + selector
    if cache is not None and key in cache:
        return cache[key]
    try:
        counted = len(select_all(root, selector))
    except Exception:  # noqa: BLE001 - an unselectable rule is simply not unique
        counted = 0
    if cache is not None:
        cache[key] = counted
    return counted


def first_read_text(root: Element, selector: str,
                    cache: dict[str, Any] | None = None) -> str:
    """What a text rule over this selector reads: its first match's text, as an identity.

    The second half of "is this rule any good" — a selector can match one element three
    times over and still read something else — and it is asked for every candidate on the
    page, so it lives in the same cache as the count. Both are properties of the document
    rather than of whoever asks.
    """
    key = "text:" + selector
    if cache is not None and key in cache:
        return cache[key]
    try:
        matches = select_all(root, selector)
    except Exception:  # noqa: BLE001 - an unselectable rule reads nothing
        value = ""
    else:
        value = text_identity(matches[0].text()) if matches else ""
    if cache is not None:
        cache[key] = value
    return value


def _add_text(registry: _Registry, raw: str, source: Source, *,
              heading: bool = False, chrome: bool = False,
              root: Element | None = None, element: Element | None = None,
              counts: dict[str, Any] | None = None) -> None:
    """Offer a string as a text candidate unless it is really an address.

    Two second rules are offered when the first one is ambiguous, because an ambiguous
    rule reads the first of many elements and that is the failure this whole phase keeps
    hitting:

    * one anchored on the value's own label — one of the siblings, named by the text
      only it carries;
    * one built from the nearest ancestor that names itself, which is what works when
      the value is a bare name with no text to anchor on.
    """
    text = raw.strip()
    if not text or text.startswith(("http://", "https://", "//", "data:")):
        return
    context: dict[str, Any] = {}
    if heading:
        context["heading"] = True
    if chrome:
        # The plan's §7 names navigation and footer as things that must not lead.
        context["chrome"] = "site navigation"
    registry.add("text", text, source, context)
    _offer_the_row_rule(registry, element, text, source, context, root)
    if root is not None and element is not None:
        for widened in widening_rules(element, source.rule or {}, text, root, "", counts):
            registry.add("text", text,
                         Source(source.channel, source.document,
                                f"{source.detail} from {widened['select']}", widened),
                         context)
        group = group_rule(element, source.document, root, counts)
        if group:
            registry.add("text", text,
                         Source(source.channel, source.document,
                                f"{source.detail} (the whole group at "
                                f"{group['select']})", group),
                         context)
        for scoped in scoped_group_rules(element, source.document, root, counts):
            registry.add("text", text,
                         Source(source.channel, source.document,
                                f"{source.detail} (scoped group at {scoped['select']})", scoped),
                         context)

    rule = source.rule or {}
    selector = str(rule.get("select") or "")
    anchor = anchor_for(text)
    if root is None or not selector or not anchor:
        return
    if rule.get("matches", 1) <= 1 or rule.get("list"):
        return
    kept = anchored_matches(root, selector, anchor)
    if kept == 0 or kept >= rule.get("matches", 1):
        return
    registry.add("text", text,
                 Source(source.channel, source.document,
                        f"{source.detail} anchored on {anchor!r}",
                        {**rule, "filter": [re.escape(anchor)], "matches": kept}),
                 context)


def widening_rules(element: Element, rule: dict[str, Any], value: str, root: Element,
                   base: str = "", counts: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Rules built from the nearest ancestor that names itself, for this same value.

    Counting matches is not the property that matters; reading *this* value is, so each
    candidate is checked here, on the page the value came from, rather than hoped for on
    the next one. A rule qualifies only if **every** element it matches reads this value —
    a page may carry the same block twice (phone and desktop) and reading either is right,
    but a selector that reads the work's series in one of its two matches is not an author
    rule however well its first match agrees. Every naming of that ancestor is offered,
    because which declaration discriminates is the page's business and the three-sample
    check is what decides between them.

    Measured on a real album page: the author sat inside `<span data-type="author">` while
    every rule its value carried named a class that thirty or seventy other elements
    shared, so the annotation recorded the author and the rule read `×` — and the proposal
    the next page showed was `×` for the same reason. The same measurement caught the
    cover, whose `itemprop="image"` sits on ten images where `#album_photo_cover img`
    names one block.
    """
    if rule.get("list") or rule.get("matches", 1) <= 1:
        return []
    primary = str(rule.get("select") or "")
    # An address rule is held to the weaker test — its *first* match must read this value,
    # not every match: `#album_photo_cover img` matches eight photos and reading the first
    # one is exactly what a cover rule is for. Measured on a real album, insisting they all
    # agree left the cover with a single rule, shared by ten images and reading a logo, and
    # the page then showed 无可用规则 for a cover that had worked the round before.
    wanted = text_identity(value)
    address = bool(rule.get("attr"))
    # The element itself first, then its ancestors. Its own other declarations matter as
    # much as an ancestor's: measured on a real album, ONE span carried both
    # `itemprop="author"` (which every block on the page also carries) and
    # `data-type="actor"` (which only the characters block carries), and only looking at
    # ancestors meant the characters block never got a rule of its own — so the field was
    # learned from a selector that read the works block.
    node: Element | None = element
    while node is not None:
        found: list[tuple[int, str]] = []
        for naming in _self_selectors(node):
            candidate = naming if node is element else f"{naming} {element.tag}"
            if candidate == primary:
                continue
            reads = _rule_reads(root, rule, candidate, base, counts)
            if wanted in reads and (address or reads == {wanted}):
                found.append((selector_matches(root, naming, counts), candidate))
        if found:
            # Two namings of one ancestor can be indistinguishable by what they read — on
            # that album `span[itemprop="author"] a` and `span[data-type="author"] a` both
            # read the author on the page that offered them, and it was the *containers*
            # that differed: `itemprop="author"` is on six blocks, `data-type="author"` on
            # the two copies of the author block. So the more specific container wins, and
            # ties are all kept for the three-sample check to choose from.
            best = min(rank for rank, _candidate in found)
            return [{**rule, "select": candidate,
                     "matches": selector_matches(root, candidate, counts)}
                    for rank, candidate in found if rank == best]
        node = node.parent
    return []


def _rule_reads(root: Element, rule: dict[str, Any], selector: str, base: str,
                counts: dict[str, Any] | None) -> set[str]:
    """Every value a rule over this selector reads, as identities.

    One page may name the same block twice — a phone copy and a desktop copy — and then a
    rule reading either is right, which is why "how many elements" is the wrong question.
    What matters is whether the rule reads *this* value everywhere it looks, and the
    first match alone is not enough: on a real album every tag block declared
    `itemprop="author"`, so that selector read the work's series on the second page and
    the author on the first, and a check that stopped at the first match proposed the
    series as the author.
    """
    attr = str(rule.get("attr") or "")
    key = f"reads:{attr}:{selector}"
    if counts is not None and key in counts:
        return counts[key]
    try:
        matches = select_all(root, selector)
    except Exception:  # noqa: BLE001 - an unselectable rule reads nothing
        matches = []
    values = set()
    for element in matches:
        if not attr:
            raw = element.text()
        else:
            raw = element.attr(attr) or ""
        if not raw:
            continue
        if attr and rule.get("absolute"):
            value = normalize_url(raw, base) or ""
        elif not attr:
            value = text_identity(raw)
        else:
            value = page_text(raw)
        values.add(text_identity(value))
    result = values or {""}
    if counts is not None:
        counts[key] = result
    return result


def group_rule(element: Element, document: str, root: Element,
               counts: dict[str, Any] | None) -> dict[str, Any] | None:
    """The rule that reads every value in the group this element belongs to.

    The plan's §13.1 "mark the repeated group once", written as the rule that would do the
    marking: the nearest ancestor that names itself, read as a list. A page that declares
    its blocks is therefore groupable even when its members share nothing but that
    declaration — measured on a real album, every character chip carried the same shared
    class as every tag chip, and only `span[data-type="characters"]` said which group it
    sat in, so 登場人物 could not be marked at all and was learned as whatever block
    happened to come first.
    """
    ancestor = element.parent
    while ancestor is not None:
        # Only a declaration, because that is the naming the element's own selector can
        # miss. An id further up is already what the selector uses, and a class of a
        # wrapper is a page-wide group, not this value's — measured on a real album, where
        # `#wrapper` holds a hundred links and grouping by it would have offered the whole
        # page as one field.
        for name in DECLARING_ATTRS:
            value = ancestor.attr(name)
            if not value or value.startswith(("http://", "https://")):
                continue
            candidate = f'{naming_for(ancestor, name, value)} {element.tag}'
            if selector_matches(root, candidate, counts) > 1:
                return {"from": "html", "document": document, "select": candidate,
                        "text": True, "list": True,
                        "matches": selector_matches(root, candidate, counts)}
        ancestor = ancestor.parent
    return None


def naming_for(element: Element, name: str, value: str) -> str:
    return f'{element.tag}[{name}="{value}"]'


def scoped_group_rules(element: Element, document: str, root: Element,
                       counts: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Offer nearby structural groups, without deciding which field a group represents.

    A shared class is a styling hook and can name links in unrelated panels. Categorical
    data attributes and named ancestors provide narrower alternatives. Read the member
    element, not its wrapper containing buttons, icons and counters.
    """
    if element.tag not in ("a", "span", "li", "dd"):
        return []
    if element.tag != "a" and any(isinstance(child, Element) for child in element.children):
        return []
    classes = (element.attr("class") or "").split()
    leaf = element.tag + "".join(f".{name}" for name in classes[:2])
    leaves = list(dict.fromkeys([element.tag, leaf]))
    found: list[dict[str, Any]] = []
    seen: set[str] = set()
    ancestor = element.parent
    depth = 0
    while ancestor is not None and depth < 6 and len(found) < 6:
        categorical = [naming_for(ancestor, name, value)
                       for name, value in ancestor.attrs.items()
                       if re.fullmatch(r"data-(?:[\w-]+-)?(?:type|kind|group|role)", name)
                       and re.fullmatch(r"[A-Za-z_][\w-]{0,47}", value)]
        for naming in [*categorical, *_self_selectors(ancestor)]:
            for member_selector in leaves:
                selector = f"{naming} {member_selector}"
                if selector in seen:
                    continue
                seen.add(selector)
                matches = selector_matches(root, selector, counts)
                if matches > 0:
                    found.append({"from": "html", "document": document, "select": selector,
                                  "text": True, "list": True, "matches": matches})
        ancestor = ancestor.parent
        depth += 1
    return found


def _offer_the_row_rule(registry: _Registry, element: Element | None, text: str,
                        source: Source, context: dict[str, Any],
                        root: Element | None) -> None:
    """Offer a rule that reads this value out of the row whose label names it."""
    rule = source.rule or {}
    if root is None or element is None or element.parent is None:
        return
    if rule.get("list"):
        return
    found = labelled_value_row(element, text)
    if found is None:
        return
    label, row_selector, pattern = found
    rows = anchored_matches(root, row_selector, label)
    if rows == 0:
        return
    registry.add("text", text,
                 Source(source.channel, source.document,
                        l10n.provenance("row", l10n.lang_from_env(),
                                       detail=source.detail, label=label),
                        {"from": "html", "document": source.document,
                         "select": row_selector, "text": True,
                         "filter": [pattern], "group": 1, "matches": rows}),
                 context)


def harvest_markup(registry: _Registry, document: Document, base: str) -> None:
    root = parse_html(document.text)
    registry.markup_roots[document.name] = root
    # One count per selector for this document: the answer is a property of the page,
    # and ten thousand links asked it ten thousand times.
    counts: dict[str, Any] = {}

    for selector in HEADINGS:
        for element in select_all(root, selector):
            _add_text(registry, element.text(),
                      Source("markup", document.name, f"{selector} text",
                             {"from": "html", "document": document.name,
                              "select": element_selector(element), "text": True,
                              "matches": selector_matches(root, element_selector(element), counts)}),
                      heading=True, chrome=in_site_chrome(element), root=root, element=element,
                      counts=counts)

    title = select_one(root, "title")
    if title is not None:
        _add_text(registry, title.text(),
                  Source("markup", document.name, "title text",
                         {"from": "html", "document": document.name,
                          "select": "title", "text": True}))

    # `<time>` is how a page marks a date, and its `datetime` carries the machine
    # value even when the text is a human one ("9月30日首播").
    for element in select_all(root, "time"):
        source = Source("markup", document.name, "time[datetime]",
                        {"from": "html", "document": document.name,
                         "select": element_selector(element), "attr": "datetime"})
        stamp = (element.attr("datetime") or "").strip()
        if stamp:
            registry.add("text", stamp, source, {"date_like": True})
        if element.text():
            _add_text(registry, element.text(),
                      Source("markup", document.name, "time text",
                             {"from": "html", "document": document.name,
                              "select": element_selector(element), "text": True}),
                      chrome=in_site_chrome(element))

    # Prose: bounded, and attributed to the element it came from, so a description
    # is reachable without the candidate list becoming the page's full text.
    for selector in PROSE_BLOCKS:
        for element in select_all(root, selector)[:MAX_BLOCKS]:
            text = element.text()
            if text and len(text) <= MAX_BLOCK_LENGTH:
                _add_text(registry, text,
                          Source("markup", document.name, f"{selector} text",
                                 {"from": "html", "document": document.name,
                                  "select": element_selector(element), "text": True,
                                  "matches": selector_matches(root, element_selector(element), counts)}),
                          chrome=in_site_chrome(element), root=root, element=element,
                          counts=counts)

    for meta in select_all(root, "meta"):
        content = (meta.attr("content") or "").strip()
        if not content:
            continue
        key = (meta.attr("property") or meta.attr("name") or meta.attr("itemprop") or "").strip()
        if not key:
            continue
        # OpenGraph declares its keys as `property`, everything else as `name`, and
        # the runtime's meta selector looks for whichever one the rule names. A rule
        # that always says `name` reads nothing on a page that used `property`.
        attribute = "property" if meta.attr("property") else "name"
        source = Source("markup", document.name, f"meta[{key}]",
                        {"from": "meta", "document": document.name, attribute: key})
        if looks_like_a_path(content):
            absolute = normalize_url(content, base)
            if absolute:
                # `og:image` and `twitter:image` are *declared images*, so they are
                # offered as images: as a bare URL they get no preview, and the cover
                # is picked by eye.
                if "image" in key.lower():
                    registry.add("image", absolute, source,
                                 {"document_rank": 0})
                else:
                    _add_url(registry, absolute, source)
            continue
        _add_text(registry, content, source)

    for link in select_all(root, "a"):
        href = link.attr("href")
        if href:
            absolute = normalize_url(href, base)
            if absolute:
                selector = element_selector(link)
                _add_url(registry, absolute,
                         Source("markup", document.name, "a[href]",
                                {"from": "html", "document": document.name,
                                 "select": selector, "attr": "href", "absolute": True,
                                 "matches": selector_matches(root, selector, counts)}))
        _add_text(registry, link.text(),
                  Source("markup", document.name, "a text",
                         {"from": "html", "document": document.name,
                          "select": element_selector(link), "text": True,
                          "matches": selector_matches(root, element_selector(link), counts)}),
                  chrome=in_site_chrome(link), root=root, element=link, counts=counts)

    # A block the page names is a value in its own right, not only a container. Measured on
    # a real album: 登場人物 sat in `<span data-type="actor">美甘寧瑠 美甘妮露</span>`, and
    # the plain block's text was never offered — headings, prose, links and data-attributes
    # were, and nothing else — so the only rules the characters could be learned from were
    # the shared classes of the chips inside it, and one of them read the works block.
    for name in DECLARING_ATTRS:
        for element in select_all(root, f"[{name}]"):
            if not (element.text() or "").strip():
                continue
            selector = element_selector(element)
            _add_text(registry, element.text(),
                      Source("markup", document.name, f"{element.tag}[{name}] text",
                             {"from": "html", "document": document.name,
                              "select": selector, "text": True,
                              "matches": selector_matches(root, selector, counts)}),
                      chrome=in_site_chrome(element), root=root, element=element,
                      counts=counts)

    for element in root.iter():
        for name, value in (element.attrs or {}).items():
            if not name.startswith(("data-", "aria-")) or not value or not value.strip():
                continue
            if len(value) > 300:
                continue
            source = Source("markup", document.name, f"{element.tag}[{name}]",
                            {"from": "html", "document": document.name,
                             "select": element_selector(element), "attr": name})
            if looks_like_a_path(value):
                absolute = normalize_url(value, base)
                if absolute:
                    _add_url(registry, absolute, source)
                    continue
            # A `data-` attribute is where a site puts the field the markup does not
            # otherwise carry (`data-author="…"`), so its text is offered too rather
            # than discarded for not being an address.
            _add_text(registry, value, source, chrome=in_site_chrome(element),
                      root=root, element=element, counts=counts)


# Which elements may carry an image in `src` and its lazy cousins. Without this a
# `script[src]` and an `iframe[src]` are "images" — and the first of those scored
# well enough to sit near the top of a real page's candidates.
MEDIA_SRC_TAGS = ("img", "source")
POSTER_TAGS = ("video",)
# Attributes a rule can actually name. `srcset` needs a primitive that picks one
# candidate out of a set, and a `style` background needs one that parses `url()` out
# of a CSS value; the runtime has neither, so a rule quoting them is a rule that reads
# nothing on every page — including the one it was derived from. Measured: it was
# chosen ahead of the `og:image` that worked, and every later page confirmed a cover
# it could never read.
RULABLE_ATTRS = frozenset(IMAGE_ATTRS) | {"poster"}


def _media_sources(element: Element) -> list[tuple[str, str]]:
    """Every URL this element offers, with the attribute that carried it."""
    found: list[tuple[str, str]] = []
    if element.tag in MEDIA_SRC_TAGS:
        for attr in IMAGE_ATTRS:
            value = (element.attr(attr) or "").strip()
            if value:
                found.append((value, attr))
        srcset = element.attr("srcset")
        if srcset:
            first = _SRCSET_FIRST.match(srcset)
            if first:
                found.append((first.group(1), "srcset"))
    if element.tag in POSTER_TAGS:
        poster = (element.attr("poster") or "").strip()
        if poster:
            found.append((poster, "poster"))
    # A painted background belongs to whatever element paints it — that is the point:
    # the poster is a `div`, and no `<img>` on that page was the work's own cover.
    for url in background_urls(element.attr("style")):
        found.append((url, BACKGROUND_SOURCE))
    return found


def picture_position(root: Element, element: Element, rule: dict[str, Any],
                     cache: dict[Any, list[str]]) -> int | None:
    """Where this picture sits in the list the runtime reads for the rule's selector.

    Counted over the same first-seen list the runtime builds — it drops empties and repeats before
    it picks (`_clean_list`) — and read with the runtime's own reader, because an attribute rule also
    reads the spellings a script may have moved the value into (`data-src` for `src`). Counting the
    matched elements instead would name a different picture the moment one address appears twice on
    the page.

    Computed once per (selector, attribute): a page has one such list per rule, not one per picture.
    """
    selector = str(rule.get("select") or "")
    key = (selector, rule.get("attr"))
    values = cache.get(key)
    if values is None:
        values = []
        seen: set[str] = set()
        for candidate in select_all(root, selector):
            for value in _element_values(candidate, rule):
                text = re.sub(r"\s+", " ", str(value)).strip()
                if not text or text in seen:
                    continue
                seen.add(text)
                values.append(text)
        cache[key] = values
    for value in _element_values(element, rule):
        text = re.sub(r"\s+", " ", str(value)).strip()
        if text and text in values:
            return values.index(text)
    return None


def harvest_media(registry: _Registry, document: Document, base: str) -> None:
    """Images from every place a page keeps one, not only from `<img>`."""
    root = parse_html(document.text)
    counts: dict[str, Any] = {}
    positions: dict[Any, list[str]] = {}
    rank = 0
    for element in root.iter():
        sources = _media_sources(element)
        if not sources:
            continue
        for raw, attr in sources:
            absolute = normalize_url(raw, base)
            if not absolute:
                continue
            reason = boilerplate_reason(absolute)
            context: dict[str, Any] = {"document_rank": rank}
            if reason:
                context["chrome"] = reason
            hay = " ".join(filter(None, (element.attr("class"), element.attr("id"),
                                         element.attr("alt")))).lower()
            if any(word in hay or word in absolute.lower()
                   for word in ("cover", "poster", "thumbnail", "main", "detail")):
                context["named_cover"] = True
            for size in ("width", "height"):
                declared = element.attr(size)
                if declared and declared.isdigit():
                    context[f"declared_{size}"] = int(declared)
            rule = None
            if attr == BACKGROUND_SOURCE:
                # A picture the page *paints* is a picture the page has: measured on iwara
                # (2026-10-11), the cover the person picked had exactly one source and it carried no
                # rule at all — `div[style[background-image]]` — so the only rule recorded for that
                # candidate pointed at another picture entirely, and the next page proposed that other
                # picture. The runtime reads an attribute through a filter and a capture group already;
                # this is the same reading the harvest itself did to find the address.
                #
                # Only the first address an element paints, because a filter cannot say "the second
                # one": a rule that reads the first and was learned from the second would be pruned
                # anyway, and offering it would only invite a pick that teaches nothing.
                #
                # And never for a picture this harvest already judged to be chrome: measured from a
                # screenshot of the page (2026-10-11), a favicon painted as a background became the
                # one pickable image — `https://www.iwara.tv/favicon.ico`, score -1 — because a source
                # with a rule is a source a person is shown. The score already says it is not the
                # work's picture; a rule would only invite a pick that teaches the wrong thing.
                painted = background_urls(element.attr("style"))
                if painted and raw == painted[0] and not reason:
                    rule = {"from": "html", "document": document.name,
                            "select": element_selector(element), "attr": "style",
                            "filter": [_BACKGROUND.pattern], "group": 1, "absolute": True,
                            "matches": 1}
            elif attr in RULABLE_ATTRS:
                selector = element_selector(element)
                rule = {"from": "html", "document": document.name,
                        "select": selector, "attr": attr, "absolute": True,
                        "matches": selector_matches(root, selector, counts)}
                registry.add("image", absolute,
                             Source("markup", document.name, f"{element.tag}[{attr}]", rule),
                             context)
                # A rule reads the *first* element its selector names, so a person who picked the
                # third picture of a set annotated a value no rule could read: measured on buondua
                # (2026-10-10), the cover and the preview both read `-001` while the annotation held
                # `-002` and `-003`, and the learner pruned both fields — the import then had no
                # images at all. The same page's earlier run worked because that person had picked
                # the first picture. `index` is the runtime's own answer and has been all along;
                # nothing ever sent it. Offered *beside* the plain rule, so a page where the first
                # match is the right one keeps reading it.
                position = picture_position(root, element, rule, positions)
                if position is not None and rule["matches"] > 1:
                    registry.add("image", absolute,
                                 Source("markup", document.name,
                                        f"{element.tag}[{attr}] #{position}",
                                        {**rule, "index": position}),
                                 context)
                # An image has the same problem a text value has, and the same answer: a
                # declaration shared by ten images (`itemprop="image"`) reads the first of
                # them, while the block that holds this one names it alone.
                for widened in widening_rules(element, rule, absolute, root, base, counts):
                    registry.add("image", absolute,
                                 Source("markup", document.name,
                                        f"{element.tag}[{attr}] from {widened['select']}",
                                        widened),
                                 context)
                continue
            registry.add("image", absolute,
                         Source("markup", document.name, f"{element.tag}[{attr}]", rule),
                         context)
        rank += 1


def offer_json_lists(registry: _Registry, channel: str, document: Document,
                     pairs: list[tuple[str, Any]]) -> None:
    """An array whose entries carry the same key is a list of that key's values.

    Measured on iwara (2026-10-11): its tags arrive as `[{"id": "koikatsu", "type": …}, …]`, so the
    work's tags are `tags[].id` — a shape the harvest could read one member at a time (`tags[1].id`,
    which is how 登場人物 and 系列 were offered) but never as the whole list, which is why the tags
    field came out empty on import. The runtime has read `json_list` with `take` all along.

    Offered *beside* the per-index values, never instead of them: a site whose field is one member of
    an array keeps the rule it had, and this is one more candidate for the field that wants the list.
    """
    grouped: dict[tuple[str, str], dict[int, str]] = {}
    for path, value in pairs:
        if not isinstance(value, str) or not value.strip():
            continue
        match = re.match(r"^(.*)\[(\d+)\]\.([^.\[\]]+)$", path)
        if match is None:
            continue
        parent, index, key = match.group(1), int(match.group(2)), match.group(3)
        grouped.setdefault((parent, key), {})[index] = value.strip()
    for (parent, key), members in sorted(grouped.items()):
        if len(members) < MIN_COLLECTION:
            continue
        values = [members[index] for index in sorted(members)]
        registry.add("collection", COLLECTION_JOIN.join(values),
                     Source(channel, document.name, f"{parent}[].{key}",
                            # `list` as well as `take`: the rule reads a list, and a collection
                            # field's shape check is what looks for that key.
                            {"from": "json_list", "document": document.name,
                             "path": parent, "take": key, "list": True}))


def _stands_alone(url: str, text: str) -> bool:
    """Whether `text` occurs in `url` as a whole token, not inside a longer one.

    Measured on iwara (2026-10-11): a loose match put a number from an unrelated JSON field into the
    middle of a file id — `…bdc5-{exchangeRates.USD:02d}bcb7bb7357…`, the `01` of `-01bcb7bb7357…`
    read as the zero-padded form of `1`. So a part counts only where nothing alphanumeric touches it,
    which is exactly what makes it a part of the address rather than a run of characters inside one.
    One occurrence is required for the same reason: an address that mentions a value twice cannot say
    which one it means.
    """
    start = url.find(text)
    if start < 0:
        return False
    if url.find(text, start + 1) >= 0:
        return False
    before = url[start - 1] if start > 0 else ""
    after = url[start + len(text)] if start + len(text) < len(url) else ""
    return not before.isalnum() and not after.isalnum()


def harvest_jsonld(registry: _Registry, document: Document, base: str) -> None:
    """Structured data, read out of the markup and spoken about as its own document.

    The rule names `JSONLD_DOCUMENT` rather than the document the block was found in,
    because the runtime's `json` selector needs a JSON *document* and the markup is
    HTML. A generated adapter therefore has to expose the page's JSON-LD blocks as a
    JSON document under that name; until it does, this rule is not executable, and
    the Phase 6 round trip is what checks that it happens.
    """
    for node in jsonld_nodes(document.text):
        pairs = list(flatten_json(node))
        offer_json_lists(registry, "jsonld", document, pairs)
        for path, value in pairs:
            source = Source("jsonld", JSONLD_DOCUMENT, path,
                            {"from": "json", "document": JSONLD_DOCUMENT, "path": path})
            if isinstance(value, str):
                value = decode_entities(value)
                absolute = normalize_url(value, base)
                if absolute and looks_like_a_path(value):
                    _add_url(registry, absolute, source)
                    continue
                registry.add("text", value, source)
            elif isinstance(value, (int, float)):
                registry.add("number", str(value), source)


def harvest_network(registry: _Registry, document: Document, base: str) -> None:
    payload = parse_loose(document.text)
    if payload is None:
        registry.add("text", document.text[:200],
                     Source("network", document.name, "unparsable body"))
        return
    pairs = list(flatten_json(payload))
    offer_json_lists(registry, "network", document, pairs)
    for path, value in pairs:
        source = _json_source("network", document, path)
        if isinstance(value, str):
            value = decode_entities(value)
            absolute = normalize_url(value, base) if looks_like_a_path(value) else None
            if absolute:
                _add_url(registry, absolute, source)
                continue
            registry.add("text", value, source)
        elif isinstance(value, (int, float)):
            registry.add("number", str(value), source)
        elif isinstance(value, bool) or value is None:
            continue


def harvest_inline(registry: _Registry, document: Document, base: str) -> None:
    """Framework state, as far as it can be read without a JavaScript evaluator."""
    payload = parse_loose(document.text)
    if payload is not None:
        for path, value in flatten_json(payload):
            if isinstance(value, str):
                _add_inline_string(registry, document, base, path, value)
            elif isinstance(value, (int, float)):
                registry.add("number", str(value), Source("inline", document.name, path))
        return

    # Not JSON: minified script. A string literal with a `key:` in front of it is a
    # value at a path, which is what a candidate needs to become a rule. One with
    # no key is a string in a bundle, with no path and no evidence — kept out, and
    # counted out loud so the recall that was given up is visible rather than
    # silent, the plan's §4.4 asking for a source path for every candidate.
    scanned = 0
    skipped = 0
    for match in _QUOTED.finditer(document.text):
        if scanned >= MAX_STRING_SCAN:
            break
        raw = match.group(1)
        try:
            decoded = json.loads(f'"{raw}"')
        except (json.JSONDecodeError, ValueError):
            decoded = raw.replace("\\u002F", "/").replace("\\/", "/")
        if (len(decoded) < MIN_SCANNED_LENGTH or not is_a_value(decoded)
                or LOOKS_LIKE_MARKUP.search(decoded)):
            continue
        before = document.text[max(0, match.start() - 40):match.start()]
        hint = re.search(r"([A-Za-z_$][\w$]*)\s*[:=]\s*$", before)
        # A literal with no key is kept: minified state passes its values as
        # positional arguments, so `("A Work", "/c.jpg")` has real data and no key
        # anywhere near it. It has no path, though, so it is marked as the weaker
        # evidence it is and ranked below anything that does have one.
        detail = hint.group(1) if hint else "literal"
        if hint is None:
            skipped += 1
        else:
            scanned += 1
        _add_inline_string(registry, document, base, detail, decoded)
    if scanned or skipped:
        registry.notes.append(
            f"{document.name}: not JSON, so {scanned} literal(s) with a key and "
            f"{skipped} positional literal(s) were kept as literal evidence; "
            "decoding minified state properly needs a JavaScript evaluator"
        )


# A labelled value — `當地首播:2026-10-02`, `原著作者:許斐剛` — carries its own anchor:
# the label is the same on every page while the value changes. The runtime already has
# the primitive for it (`filter` is a list of regexes a value must match), and the
# Builder never emitted one, so every such value got a rule like `li` that matched
# dozens of siblings and read the first — which is why a date could be found by eye
# and never read on the next page.
# A label's sibling set is small; a value's is a list. Three same-shaped siblings
# is where a peer starts and a label stops.
PEER_LIMIT = 3
LABEL_SEPARATORS = (":", "：")
MAX_ANCHOR = 24
MAX_LABEL_DEPTH = 6


def anchor_for(value: str) -> str | None:
    """The stable part of a labelled value, or None when it has no label."""
    for separator in LABEL_SEPARATORS:
        head, found, tail = value.partition(separator)
        if found and 1 < len(head) <= MAX_ANCHOR and tail.strip():
            return head
    return None


def sibling_label(element: Element | None) -> tuple[str, str] | None:
    """The label this page puts beside the value, and the selector of the row holding both.

    A screen of information is a list of rows, and the row's own text is where both
    halves live:

        <div class="info"><span class="name">制作</span><span class="value">日本</span></div>

    The value's text says nothing about which row it belongs to, so a rule of
    "container plus tag" reads the first row and every field comes back as whatever
    that row held. The row, though, does say: it contains its label. The runtime can
    express that already — `filter` is a regex and `group` picks a capture group out
    of it — so the row is chosen by its label and the value captured out of it.
    """
    if element is None or element.parent is None:
        return None
    parent = element.parent
    siblings = [child for child in parent.children if isinstance(child, Element)]
    if element not in siblings or siblings.index(element) == 0:
        return None
    previous = siblings[siblings.index(element) - 1]
    label = previous.text()
    if not label or len(label) > MAX_ANCHOR:
        return None
    # A peer is not a label. Measured on a real page: a tag list put one tag before
    # the value, so the "label" became that tag — which exists on this work and not on
    # the next, so the rule read nothing everywhere else while looking the most
    # specific rule of the lot. Which is how a field came to be forever empty.
    peers = [item for item in siblings
             if item.tag == previous.tag
             and (item.attr("class") or "") == (previous.attr("class") or "")]
    if len(peers) >= PEER_LIMIT:
        return None
    return label, element_selector(parent)


def label_pattern(label: str, value: str, row_text: str) -> str | None:
    """A pattern that captures `value` out of `row_text`, or None when it cannot.

    Checked here rather than trusted: a rule that does not read the value it was
    derived from is worse than no rule, because the annotation offers it as a choice.
    """
    pattern = re.escape(label) + r"\s*[:：]?\s*(.+)$"
    match = re.search(pattern, row_text)
    if match is None or match.group(1).strip() != value.strip():
        return None
    return pattern


def labelled_value_row(element: Element, value: str) -> tuple[str, str, str] | None:
    """Find a nearby labelled row even when its value has nested markup.

    A link inside a wrapper inside a table cell has no label beside the link:
    the label is beside its cell. Climb only within the local row, and accept
    a rule only when it captures the complete selected value. Interactive peer
    chips are not field labels, even in a short two-chip list.
    """
    node = element
    boundaries = {"tr", "table", "tbody", "thead", "tfoot", "body", "html"}
    for _ in range(MAX_LABEL_DEPTH):
        if node.parent is None or node.tag in boundaries:
            break
        found = sibling_label(node)
        if found is not None:
            label, selector = found
            siblings = [child for child in node.parent.children if isinstance(child, Element)]
            previous = siblings[siblings.index(node) - 1]
            peer_link = any(
                child.tag in {"a", "button", "input", "select", "textarea"}
                for child in previous.iter()
            )
            pattern = label_pattern(label, value, node.parent.text())
            if pattern is not None and not peer_link:
                return label, selector, pattern
        node = node.parent
    return None


def anchored_matches(root: Element, selector: str, anchor: str) -> int:
    """How many elements the anchored rule would keep — the same test the runtime runs."""
    try:
        return sum(1 for element in select_all(root, selector) if anchor in element.text())
    except Exception:  # noqa: BLE001 - an unselectable rule names nothing
        return 0


def _json_source(channel: str, document: Document, path: str) -> Source:
    """The rule for a value that came out of JSON: its own dotted path.

    A positional literal in a minified script has no path, and a rule needs one. It
    gets no rule rather than a rule pointing at a name that reads nothing — the page
    shows which candidates can become rules, and one that claims a path it does not
    have would be chosen and then silently read nothing.
    """
    rule = None
    if path and path != "literal":
        rule = {"from": "json", "document": document.name, "path": path}
    return Source(channel, document.name, path, rule)


def _add_inline_string(registry: _Registry, document: Document, base: str,
                       path: str, value: str) -> None:
    source = _json_source("inline", document, path)
    value = decode_entities(value)
    absolute = normalize_url(value, base) if looks_like_a_path(value) else None
    if absolute:
        _add_url(registry, absolute, source)
        return
    registry.add("text", value, source)


# --- scoring ---------------------------------------------------------------- #

def _registrable(hostname: str | None) -> str:
    """The last two labels of a host. Cheap, so it is wrong for `co.uk` — documented,
    not hidden, because it is only used to decide whether two paths are comparable."""
    parts = (hostname or "").split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else (hostname or "")


# Segments that a resize path inserts: they say how the picture was derived, not
# which picture it is.
_DERIVED_SEGMENTS = frozenset((
    "thumb", "thumbs", "thumbnail", "thumbnails", "resize", "resized", "cache",
    "small", "medium", "large", "orig", "original", "preview", "previews", "mini",
    "scaled", "cropped",
))
_RESIZE_PREFIX = re.compile(r"^\d+px-", re.IGNORECASE)
_DIMENSION_SUFFIX = re.compile(r"[-_@]\d+x\d+(?=\.[a-z0-9]+$|$)", re.IGNORECASE)


def picture_key(url: str) -> tuple[str, tuple[str, ...]]:
    """What two addresses must share to be one picture at two sizes.

    The signature a resize leaves behind is removed: a `thumb/` directory, a
    `250px-` prefix, a `-300x400` suffix. What remains has to be *equal* rather than
    merely overlapping — the safe failure is a duplicate candidate a person can
    still choose between, while the unsafe one is collapsing two works' covers, and
    `…/book/1/cover.jpg` beside `…/book/2/cover.png` shares every segment except the
    ones that matter.
    """
    parsed = urlparse(url)
    segments = []
    for part in parsed.path.split("/"):
        if not part:
            continue
        lowered = part.casefold()
        if lowered in _DERIVED_SEGMENTS:
            continue
        normalized = _DIMENSION_SUFFIX.sub("", _RESIZE_PREFIX.sub("", lowered))
        # A resize path repeats the original name before the derived one
        # (`…/Photo.jpg/250px-Photo.jpg`), so a segment equal to the one before it
        # is the same segment said twice.
        if segments and segments[-1] == normalized:
            continue
        segments.append(normalized)
    return _registrable(parsed.hostname), tuple(segments)


def merge_image_variants(registry: _Registry) -> None:
    """Collapse one picture offered at several sizes into a single candidate.

    Measured on a real page that publishes one photograph as `…/250px-X.jpg`,
    `…/960px-X.jpg` and `…/X.jpg`: three candidates for one cover, which is the
    "URL 不同但实际同一张图" case the plan's §4.6 says not to count separately.
    """
    by_key: dict[tuple[str, tuple[str, ...]], Candidate] = {}
    for candidate in [c for c in registry.all() if c.kind == "image"]:
        key = picture_key(candidate.value)
        keeper = by_key.get(key)
        if keeper is None:
            by_key[key] = candidate
            continue
        # Keep the shortest address: it is the one without a resize step in it.
        if len(candidate.value) < len(keeper.value):
            keeper, candidate = candidate, keeper
            by_key[key] = keeper
        for source in candidate.sources:
            if source not in keeper.sources:
                keeper.sources.append(source)
        keeper.context.setdefault("variants", []).append(candidate.value)
        registry.remove(candidate)


# The plan's pipeline is 归一化 → 去重 → **类型化**: a value's *shape* is a generic hint
# about which field it answers, and the one shape worth naming first is a date. Without
# it a date field could never be found: measured on a real page, the value was offered
# as an ordinary text candidate and scored the same as the site's navigation.
DATE_LIKE = re.compile(
    r"(?:19|20)\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}"      # 2026-09-30, 2026年9月30日
    r"|(?:19|20)\d{2}-\d{2}-\d{2}T\d{2}:\d{2}"                      # an ISO timestamp
    r"|\d{1,2}\s*[-/]\s*\d{1,2}\s*[-/]\s*(?:19|20)\d{2}",          # 09/30/2026
    re.IGNORECASE,
)


def looks_like_a_date(value: str) -> bool:
    return bool(DATE_LIKE.search(value))


MIN_COLLECTION = 3
# A group the container itself names can be a collection with two members. The bar above
# keeps noise out — two links in a site's navigation are not a field — but an id in the
# selector is the page saying "this is a thing", and two is a real size there. Measured
# on three real pages of one gallery: the only two-member groups were `#series li` (a set
# page carrying two works) and `#characters li` (a work with two characters), and before
# this a two-character work could not be marked as a collection at all — its characters
# were two unrelated candidates and picking one recorded one.
MIN_COLLECTION_WHEN_NAMED = 2
MAX_COLLECTION_MEMBERS = 50

# How a collection is written when it has to be one string: the candidate's value, the
# line the annotation page shows, and the separator that page splits on again to hand
# the annotation back as the list it is. One constant because the two sides must agree
# — a page splitting on a separator the harvester did not join with records one value
# where the rule reads twelve.
COLLECTION_JOIN = " / "


def build_collections(registry: _Registry, minimum: int = MIN_COLLECTION) -> None:
    """Offer a repeated group as one collection candidate.

    The plan's §13.1 is explicit that a collection must not be marked one element at
    a time — tags are a field, not forty fields. Any selector that read several
    values is a candidate for it, and its rule is that same selector reading all of
    them at once, which is what the plan's `list` option is for.

    The candidate carries **every** member, not a preview of the first few, because
    choosing it is what the annotation records: a value stopping at the fifth tag was
    accepted as the work's tags, and the rule that read all twelve then disagreed with
    the annotation it came from and was pruned as if the rule were wrong.
    """
    groups: dict[tuple[str, str], list[Candidate]] = {}
    for candidate in registry.all():
        if candidate.kind != "text":
            continue
        # Every group this value belongs to, not just its first rule: a chip in a declared
        # block is a member of its class's group and of its block's group, and which of
        # them is the field is what the samples decide. One membership per group, however
        # many rules name it — the same value carrying the same selector twice is one
        # member, not two.
        joined: set[tuple[str, str]] = set()
        for source in candidate.sources:
            rule = source.rule or {}
            selector = str(rule.get("select") or "")
            if (source.channel != "markup" or not selector or not rule.get("text")
                    or rule.get("filter")):
                continue
            key = (source.document, selector)
            if key in joined:
                continue
            joined.add(key)
            groups.setdefault(key, []).append(candidate)
    for (document, selector), members in sorted(groups.items()):
        rule = {"from": "html", "document": document, "select": selector,
                "text": True, "list": True}
        root = registry.markup_roots.get(document)
        if root is not None:
            bag = DocumentBag()
            bag.add(RuntimeDocument.from_element(document, root))
            try:
                values = resolve(rule, bag)
            except (ValueError, KeyError):
                continue
        else:
            # Registry-only callers can construct candidates without a capture. All real
            # harvests above register their trees and use the runtime's actual result.
            values = [member.value for member in members]
        if not isinstance(values, list) or len(values) < _minimum_for(selector, minimum):
            continue
        registry.add(
            "collection", COLLECTION_JOIN.join(values),
            Source("markup", document,
                   l10n.provenance("members", l10n.lang_from_env(),
                                  selector=selector, count=len(values)), rule),
            context={"selector": selector,
                     "members": values,
                     "count": len(values)},
            identity=f"collection:{document}:{selector}",
        )


def rule_identity(rule: dict[str, Any]) -> str:
    """A rule's identity: what it reads and how, without what it happened to match here.

    `matches` is a fact about one page, so two images read by the same rule on two pages
    are the same group while their counts differ.
    """
    return json.dumps({key: value for key, value in rule.items() if key != "matches"},
                      sort_keys=True, ensure_ascii=False)


def build_date_candidates(registry: _Registry, capture: Capture) -> None:
    """Offer dates from mixed text as measured, executable rules, separated by meaning."""
    bag = DocumentBag()
    for name, root in registry.markup_roots.items():
        bag.add(RuntimeDocument.from_element(name, root))
    if capture.markup is not None:
        node = next(iter(jsonld_nodes(capture.markup.text)), None)
        if node is not None:
            bag.add(RuntimeDocument(name=JSONLD_DOCUMENT, text=json.dumps(node), format="json"))
    for document in capture.documents:
        if document.format in ("json", "script"):
            payload = parse_loose(document.text)
            if payload is not None:
                bag.add(RuntimeDocument(name=document.name, text=json.dumps(payload), format="json"))

    for candidate in list(registry.all()):
        if candidate.kind != "text":
            continue
        labelled = list(labelled_dates(candidate.value))
        single = extract_date(candidate.value)
        for source in list(candidate.sources):
            base_rule = source.rule or {}
            if not base_rule or base_rule.get("list") or base_rule.get("filter"):
                continue
            offers = []
            if labelled and base_rule.get("from") == "html" and base_rule.get("text"):
                offers = [(kind, label, value,
                           {**base_rule, "filter": [labelled_filter(label)], "group": 1})
                          for kind, label, value in labelled]
            elif single:
                meaning = date_kind(str(base_rule.get("path") or base_rule.get("property")
                                        or base_rule.get("name") or source.detail))
                # Unlabelled mixed text is only offered when exactly one date occurs.
                offers = [(meaning, "", single, dict(base_rule))]
            for meaning, label, value, rule in offers:
                rule.pop("conflict", None)
                rule["transform"] = [*(rule.get("transform") or []), "extract_date"]
                try:
                    actual = resolve(rule, bag, context={"url": capture.final_url or capture.url})
                except (ValueError, KeyError, SelectorError):
                    continue
                if actual != value:
                    continue
                display = l10n.date_meaning(meaning, l10n.lang_from_env())
                added = registry.add("text", value, Source(source.channel, source.document,
                    l10n.provenance("dateField", l10n.lang_from_env(), detail=source.detail,
                                    meaning=display, label=label or "—"), rule),
                    {"date_kind": meaning, "date_like": True},
                    identity=f"date:{meaning}:{text_identity(value)}")
                if added is not None:
                    added.display = f"{display}: {value}"


def build_image_collections(registry: _Registry, minimum: int = MIN_COLLECTION) -> None:
    """Offer a repeated image group as one candidate — the work's previews.

    Marking previews is the same act as marking a cover: a person points at an image.
    What differs is the *field*, not the technique — a cover is one picture and a preview
    set is several — so the group is offered the way tags are: one click on the whole set,
    and its rule carries `list`, which is the same `list` the runtime already reads for
    `preview_urls`.

    Grouped by the rule rather than by its selector alone. Two rules over the same
    selector with different attributes read different addresses on a lazy-loading page (a
    placeholder in `src`, the real picture in `data-original`), and a group mixing them
    would hold values its own rule never returns.

    Runs after `merge_image_variants`, so one picture published at three sizes is one
    member — the same reason that merge exists.
    """
    groups: dict[str, list[tuple[Candidate, Source]]] = {}
    for candidate in registry.all():
        if candidate.kind != "image":
            continue
        # Every group this picture belongs to, not just its first rule: the same image is
        # often inside a content block and inside a carousel, and which of them is the
        # previews is what the samples decide. One membership per rule per candidate.
        seen: set[str] = set()
        for source in candidate.sources:
            rule = source.rule or {}
            if source.channel != "markup" or not rule.get("select") or rule.get("list"):
                continue
            key = rule_identity(rule)
            if key in seen:
                continue
            seen.add(key)
            groups.setdefault(key, []).append((candidate, source))
    for key, members in sorted(groups.items()):
        rule = json.loads(key)
        selector = str(rule.get("select") or "")
        if len(members) < _minimum_for(selector, minimum):
            continue
        document = members[0][1].document
        registry.add(
            "images", COLLECTION_JOIN.join(candidate.value for candidate, _ in members),
            Source("markup", document,
                   l10n.provenance("pictures", l10n.lang_from_env(),
                                  selector=selector, count=len(members)),
                   # The rule as it read the single images, plus `list`: the field asks
                   # for all of them, so the answer is all of them. Copying rather than
                   # naming the keys keeps whatever the member rule reads with — an
                   # attribute list, a filter, a pattern — instead of re-deriving it.
                   {**rule, "list": True}),
            context={"selector": selector,
                     "members": [candidate.value
                                 for candidate, _ in members[:MAX_COLLECTION_MEMBERS]],
                     "count": len(members)},
            identity=f"images:{key}",
        )
        # The same set starting at the second picture — beside the whole set, never instead of it.
        # A work whose cover is one of a run of pictures keeps its preview in the pictures right
        # after the first, and nothing could say that: `index` names one picture and the whole-set
        # rule starts at the first one. Measured on buondua (2026-10-10) against the user's own two
        # pages: `{list, offset: 1}` reads pictures 002–004 on both, which is exactly what they had
        # been picking by hand. Offered only when two pictures remain after the first — a one-picture
        # remainder is what `index` already reads — and only beside everything else, so a page that
        # does not work this way learns precisely what it learned before.
        if len(members) > 2:
            registry.add(
                "images",
                COLLECTION_JOIN.join(candidate.value for candidate, _ in members[1:]),
                Source("markup", document,
                       l10n.provenance("picturesAfter", l10n.lang_from_env(),
                                      selector=selector, count=len(members) - 1),
                       {**rule, "list": True, "offset": 1}),
                context={"selector": selector,
                         "members": [candidate.value
                                     for candidate, _ in members[1:MAX_COLLECTION_MEMBERS + 1]],
                         "count": len(members) - 1},
                identity=f"images-after-first:{key}",
            )


def _minimum_for(selector: str, minimum: int) -> int:
    """How many members a repeated group needs before it is offered as a collection.

    An id or a declaring attribute in the selector is the page naming the container — the
    same signal `element_selector` prefers those for, and the same reason: what the
    document identifies is a thing, however few members it happens to have.
    """
    named = ("#" in selector or any(f"[{name}=" in selector for name in DECLARING_ATTRS)
             or bool(re.search(r"\[data-(?:[\w-]+-)?(?:type|kind|group|role)=", selector)))
    return MIN_COLLECTION_WHEN_NAMED if named else minimum


def score(registry: _Registry, visible_text: set[str], documents: dict[str, Document],
          page_url: str) -> None:
    """Deterministic and explicable, the plan's §7 requirement.

    Not a judgement about which field a value *is* — only how early a person should
    read it. Every signal is one the plan lists, and nothing here removes anything.

    Agreement counts **distinct channels**, not the number of sources. A value that
    a page repeats in three elements of its markup has not been confirmed by
    anything — repetition inside one channel is the signature of a template id,
    and scoring it as agreement puts site furniture above the work.
    """
    page_tokens = subject_tokens(page_url)

    for candidate in registry.all():
        points = 0
        channels = {source.channel for source in candidate.sources}
        points += SCORE_AGREEMENT * max(0, len(channels) - 1)
        if channels & {"jsonld", "network"} or any(
            source.detail.startswith("meta[") for source in candidate.sources
        ):
            points += SCORE_STRUCTURED
        if candidate.context.get("heading"):
            points += SCORE_HEADING
        if candidate.value and candidate.value in visible_text:
            points += SCORE_VISIBLE
        if candidate.kind == "text" and looks_like_a_date(candidate.value):
            points += SCORE_DATE_LIKE
        if candidate.context.get("chrome"):
            points -= PENALTY_CHROME

        for source in candidate.sources:
            if source.channel not in ("network", "inline", "jsonld"):
                continue
            if is_list_member(source.detail):
                points -= PENALTY_LIST_MEMBER
                break
            if path_field_key(source.detail):
                points += SCORE_FIELD_KEY
                if path_depth(source.detail) <= 2:
                    points += SCORE_SHALLOW
                break
        if any(subject_tokens(documents[source.document].source_url) & page_tokens
               for source in candidate.sources
               if source.document in documents
               and documents[source.document].source_url):
            # The response it came from is about this page's own work, rather than
            # about the works beside it.
            points += SCORE_SUBJECT

        if any(source.channel == "inline" and source.detail == "literal"
               for source in candidate.sources):
            points -= PENALTY_UNKEYED

        if candidate.kind in ("collection", "images"):
            # A bigger repeated group is a more plausible field than a group of three.
            # The same rule for a group of images: a previews set of twenty is the work's
            # pictures, while a group of three is more often a strip of related works.
            points += min(candidate.context.get("count", 0), 10)
        if candidate.kind == "image":
            if any(source.detail.startswith("meta[") and "image" in source.detail
                   for source in candidate.sources):
                # `og:image` is the site saying *this* is the page's image, which is a
                # stronger statement than a picture appearing in the markup.
                points += SCORE_DECLARED_COVER
            if candidate.context.get("named_cover"):
                points += SCORE_NAMED_COVER
            if candidate.context.get("document_rank", 99) < 5:
                points += SCORE_EARLY
            points += min(candidate.context.get("declared_width", 0) // 200, 4)
            points += min(candidate.context.get("declared_height", 0) // 200, 4)
        candidate.score = points


def subject_tokens(url: str) -> set[str]:
    """The id-like pieces of an address: what makes two URLs about the same thing.

    A slug or an id, never a word — `fleurdelys`, `sOAekITnnSb24p`, `104722`.
    `video`, `api` and `book` are what every address on a site shares, so matching
    on those would make every response on the site "about" every page.
    """
    tokens = set()
    for part in urlparse(url).path.split("/"):
        stem = part.rsplit(".", 1)[0]
        if len(stem) >= 8 or (len(stem) >= 4 and any(character.isdigit()
                                                     for character in stem)):
            tokens.add(stem.casefold())
    return tokens


_SEGMENT = re.compile(r"[^.\[\]]+")


def path_segments(path: str) -> list[str]:
    """The key each step of a dotted path names, in order, lowercased."""
    return [segment.casefold() for segment in _SEGMENT.findall(path)]


def path_field_key(path: str) -> bool:
    """Whether a path arrives at its value by a key that names a field."""
    segments = [segment for segment in path_segments(path) if segment]
    return bool(segments) and segments[-1] in FIELD_KEYS


def path_depth(path: str) -> int:
    return len(_SEGMENT.findall(path))


def is_list_member(path: str) -> bool:
    """Whether a path reaches its value through a list of *other* things."""
    if any(segment in LIST_KEYS for segment in path_segments(path)):
        return True
    # A second element of an array is a sibling of the subject, not the subject.
    return any(int(index) > 0 for index in _INDEX.findall(path))


_LITERAL_NOTE = re.compile(
    r"^(?P<document>\S+): not JSON, so (?P<keyed>\d+) literal\(s\) with a key "
    r"and (?P<positional>\d+) positional")


def summarize_notes(notes: list[str]) -> list[str]:
    """Fold the per-document notes into one line each.

    A page with a dozen scripts produced a dozen near-identical warnings, which
    buries the ones that differ — and the ones that differ are the ones worth
    reading.
    """
    kept: list[str] = []
    scripts = keyed = positional = 0
    for note in notes:
        match = _LITERAL_NOTE.match(note)
        if match is None:
            kept.append(note)
            continue
        scripts += 1
        keyed += int(match.group("keyed"))
        positional += int(match.group("positional"))
    if scripts:
        kept.insert(0, f"{scripts} script(s) were not JSON, so {keyed} literal(s) with a "
                       f"key and {positional} positional literal(s) were kept as literal "
                       "evidence; decoding minified state properly needs a JavaScript "
                       "evaluator")
    return kept


def _flag_conflicting_rules(registry: _Registry, root: Element, base: str) -> None:
    """Mark every markup rule that reads a *different* value at one of its matches.

    The last self-check on a rule, and the one that was missing: a rule "reads this
    value" was only ever asked of its first match, so a selector covering six blocks of
    different kinds passed on the page whose first block happened to be the right one.
    Measured on a real album: every tag block declared `itemprop="author"`, and the rule
    built from that declaration read the work's 系列 on the second page while the first
    page made it look like an author rule — it was proposed as 作者 with the series' value
    on every following page.

    A rule with a `filter` is exempt: its `matches` counts the rows carrying a label, and
    reading a different value per row is what it is for.
    """
    counts: dict[str, Any] = {}
    for candidate in registry.all():
        for source in candidate.sources:
            rule = source.rule
            if not rule or rule.get("conflict") or rule.get("filter") or rule.get("list"):
                continue
            if rule.get("attr"):
                # An address rule over a gallery reads the first of several addresses on
                # purpose; only a text rule claims "every match is this same value".
                continue
            selector = str(rule.get("select") or "")
            if not selector or rule.get("matches", 1) <= 1:
                continue
            if len(_rule_reads(root, rule, selector, base, counts)) > 1:
                rule["conflict"] = True


def harvest(capture: Capture) -> Harvest:
    """Every channel on one capture, merged, deduplicated and ordered."""
    registry = _Registry()
    result = Harvest(url=capture.final_url or capture.url)

    markup = capture.markup
    base = capture.final_url or capture.url
    visible_text: set[str] = set()
    if markup is not None:
        # The set of strings the page shows, built in one pass. This used to be one
        # long string searched once per candidate: eleven thousand candidates against
        # a two-hundred-kilobyte page is a billion comparisons, and it was most of the
        # time this step took.
        for element in parse_html(markup.text).iter():
            shown = element.text()
            if shown:
                visible_text.add(shown)

    if markup is not None:
        harvest_markup(registry, markup, base)
        harvest_media(registry, markup, base)
        harvest_jsonld(registry, markup, base)
    for document in capture.of_format("script"):
        harvest_inline(registry, document, base)
    for document in capture.of_format("json"):
        harvest_network(registry, document, base)

    build_date_candidates(registry, capture)
    build_collections(registry)
    merge_image_variants(registry)
    # After the variants are merged, so one picture is one member of its group.
    build_image_collections(registry)
    score(registry, visible_text, {d.name: d for d in capture.documents}, base)
    if markup is not None:
        _flag_conflicting_rules(registry, parse_html(markup.text), base)

    ordered = sorted(registry.all(), key=lambda c: (-c.score, c.kind, c.value))
    for index, candidate in enumerate(ordered, start=1):
        candidate.candidate_id = f"cand_{index:04d}"
    result.candidates = ordered
    result.notes = capture.notes + summarize_notes(registry.notes)
    return result
