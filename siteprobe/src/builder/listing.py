"""Phase 7: from cards to a `listings` rule, and from pages to pagination.

The plan's §15 and §17. Two things make a listing different from a work, and they are the
only two things this module handles:

* its fields are read **inside a row** — which is why a card can be harvested and
  annotated as a small page (`cards.card_page`) and the rules that come out need no
  translation at all: the runtime scopes every field rule to one row (`extract.read_listing`)
  and says so in the vocabulary's own words;
* it has a **next page** — a URL parameter, a `next` link, or a numbered list.

What is *not* here, deliberately:

* guessing whether a page is a search page, an author listing or a favourites folder. The
  plan's §15.1 puts that on the person: the Builder is told which kind it is and derives
  the pattern from the addresses;
* a search *recipe* (§15.2 Level B–D). A form, an XHR-backed search or a signed index is
  reported as needing a custom fetch adapter rather than approximated.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, parse_qsl, urlparse

from ..generic.document import Document as RuntimeDocument
from ..generic.document import DocumentBag
from ..generic.extract import extract_listing_page, rows_of
from ..generic.htmltree import Element, parse_html, select_all
from ..generic.pages import is_page_address, page_number_of
from ..generic.select import _as_list, first_unique, resolve
from ..generic.extract import narrowed
from ..generic.template import TargetRule, load_template
from .annotate import LISTING_FIELDS
from .cards import CardGroup
from .harvest import element_selector

# The two fields a card cannot be a card without: everything else is optional, and a
# listing rule with no id fetches nothing while a rule with no title exports a row of
# blanks. `extract.read_listing` drops a card with no `source_id` for the same reason.
REQUIRED_CARD_FIELDS = ("source_id", "title")

# How a numbered pagination list is written, in the shapes the plan's §17 asks for. Only
# used to recognise the links a person would click; the addresses themselves decide.
PAGE_NUMBER_RE = re.compile(r"[?&](page|p|paged|pageNo)=(\d+)", re.IGNORECASE)


@dataclass
class Pagination:
    """What the sampled pages say about the way to the next one.

    A finding, not a guess: every part of it is either declared by the page (a `rel=next`
    link, a numbered list) or measured from two addresses that differ only in one
    parameter. `pages_sampled` is recorded so a rule learned from two pages cannot
    pretend to have been checked on ten.
    """

    kind: str                       # url_param | next_link | numbered_links | numbered_pages
    page_param: str | None = None
    next_selector: dict[str, Any] | None = None
    first_page: str = ""
    second_page: str = ""
    detail: str = ""
    pages_sampled: int = 0
    #: The rule knows one exact address instead of a pattern, so the walk stops after it. True only
    #: when nothing more general was on the page; the draft says so out loud rather than passing it off
    #: as pagination.
    exact_next: bool = False

    @property
    def usable(self) -> bool:
        return self.kind in ("url_param", "next_link", "numbered_links", "numbered_pages")

    def to_json(self) -> dict[str, Any]:
        return {"kind": self.kind, "page_param": self.page_param,
                "next_selector": self.next_selector, "detail": self.detail,
                "pages_sampled": self.pages_sampled, "exact_next": self.exact_next,
                "first_page": self.first_page, "second_page": self.second_page}


def id_rule_for(href: str) -> dict[str, Any] | None:
    """A rule that reads the work's id out of the link the card carries.

    Written the way the hand-written sites write theirs: take the address's own shape and
    turn its number into a capture group, so the rule reads `/album/1472965/` as `1472965`
    without being told what an album is.
    """
    if not href:
        return None
    path = urlparse(href).path or href
    match = re.search(r"\d+", path)
    if match is None:
        return None
    pattern = re.escape(path[:match.start()]) + r"(\d+)" + re.escape(path[match.end():])
    return {"from": "html", "select": ["a[href]"], "attr": "href",
            "filter": [pattern], "group": 1}


def _inside_the_row(rule: dict[str, Any], row_selector: str,
                    document: str = "listing_html") -> dict[str, Any] | None:
    """A rule learned inside a card, written as it must read *within a row*.

    The card was harvested as a page whose root is the card itself, so every selector that
    came out of it begins by naming that root — measured on the fixture, `li.card h3` for a
    title. Inside a row that prefix names nothing (the row *is* that element), so it comes
    off; a rule that is only the prefix is dropped, which is the same rule as "a rule naming
    the row cannot be shipped".

    The document name follows for the same reason: the card was harvested as a page named
    `page`, and inside a listing the row comes from the document the listing declares. Leaving
    it behind is silent — every rule then looks for a document the reader never produced, and
    a measurement of that rule reads nothing at all, which is how a *good* rule was thrown away
    as if it were empty.

    **A rule that names the row is the case worth spelling out**, because a listing's card is
    often the link itself — measured on bilinovel, whose cards are `<a class="book-layout">` with
    the work's address on the card. Measured against the runtime on exactly that shape: a
    row-named selector resolves to **None**, even though the row *is* that element, so what the
    person marked read nothing anywhere and `source_id` — the one field a listing cannot do
    without — came out unlearned. What reads the row is the rule with `select` left out: that is
    the runtime's own way of saying "this element" (`_elements` falls back to the scope root).
    The rewrite is only offered for an **attribute** read, because the row's *text* is the whole
    card and shipping that as a title would be worse than shipping nothing.
    """
    select = str(rule.get("select") or "")
    if not select or isinstance(rule.get("select"), list):
        return {**rule, "document": document}
    if select == row_selector:
        reads_attribute = bool(rule.get("attr")) and not rule.get("text") and not rule.get("html")
        if not reads_attribute:
            return None
        return {**{key: value for key, value in rule.items() if key != "select"},
                "document": document}
    if select.startswith(row_selector + " "):
        return {**rule, "select": select[len(row_selector) + 1:], "document": document}
    return {**rule, "document": document}


def listing_rules(learning, group: CardGroup,
                  pages: list[tuple[str, str]] | None = None,
                  answers: dict[str, Any] | None = None,
                  extra: list[tuple[Any, str]] | None = None,
                  work_url_pattern: str | None = None) -> dict[str, dict[str, Any]]:
    """The rules to ship for this card: each field's best rule that survives the row.

    Two things decide "best", in this order:

    * **what it can survive.** A field can be answered by several rules and only some make
      sense inside a row. On the fixture the card's title was offered as `li.card` — the
      card's own text, which names the row and reads nothing within it — and as `li.card h3`,
      which becomes `h3`. Choosing before stripping is how the better rule gets thrown away,
      so the choice is made after.
    * **what it actually reads on the cards.** With the sampled pages in hand, every surviving
      rule is measured over each card on them: the share of cards it reads a value from, and —
      for `source_id` — the share of those values that are *distinct*. Measured on a real
      gallery: the card that was marked carried a link class that existed on one card out of
      twenty-four, so the rule learned from it alone read nothing on the other twenty-three
      and produced empty ids. A listing's own cards are the second sample it has, and this is
      what uses them.
    """
    rows: list[tuple[str, Element]] = []
    for url, html in (pages or []):
        rows.extend((url, row) for row in _rows(html, group.selector))

    # One card from each *other* block the person included, harvested as its own page. Their
    # rules are candidates for every field, scoped to their own block — because a block the
    # marked card does not belong to is a layout the marked card cannot describe. Measured on
    # a real artist page whose CG block puts the work link where the imageset block does not:
    # with only the marked card's rules, both blocks' best rule was the same one, and the
    # chain never formed.
    borrowed: list[dict[str, Any]] = []
    for harvest_result, block_selector in (extra or []):
        for candidate in getattr(harvest_result, "candidates", []):
            for source in candidate.sources:
                rule = source.rule
                if not rule:
                    continue
                scoped = _inside_the_row(rule, block_selector)
                if scoped is None or any(_same_rule(scoped, other) for other in borrowed):
                    continue
                borrowed.append(scoped)

    chosen: dict[str, dict[str, Any]] = {}
    for report in learning.fields:
        answer = (answers or {}).get(report.field)
        shaped = report.shaped(report.kept() or report.hypotheses)
        candidates: list[dict[str, Any]] = []
        for item in sorted(shaped, key=lambda entry: (entry.rule.get("matches", 1),
                                                      len(str(entry.rule)))):
            rule = _inside_the_row(item.rule, group.selector)
            if rule is None:
                continue
            candidates.append(rule)
            by_tag = _tag_only(rule)
            if by_tag is not None:
                candidates.append(by_tag)
        # The other blocks' rules come last, so a tie settles in favour of the card the
        # person actually marked.
        candidates.extend(borrowed)
        best: tuple[float, float, float] | None = None
        for attempt in candidates:
            trials = [attempt]
            if (report.field == "source_id" and isinstance(answer, str)
                    and attempt.get("attr") == "href" and work_url_pattern):
                # A work rule learned earlier is stronger evidence than "the final path segment":
                # many sites put an opaque id before a human slug (`/video/<id>/<slug>`). Reuse the
                # generic target's captured id and let the usual card measurements judge it.
                targeted = target_rule_for_id(attempt, answer, work_url_pattern)
                if targeted is not None:
                    trials.insert(0, targeted)
            if rows and attempt.get("attr") == "href" and not attempt.get("unique"):
                # Only for a rule that reads a *link*. A text rule's values differ on every card
                # already, so "the one that appears once" means nothing for it, and an image's
                # address differs on every card too without naming anything. Offered anyway they
                # win the comparison and ship the wrong thing — which is how both were found.
                # A card carries several links or headings under one class, and the one that
                # names the work is the one whose value appears once on the page. Offered as a
                # variant and judged by measurement: the plain rule stays first, so a tie keeps
                # the simpler rule.
                trials.append({**attempt, "unique": True})
            if report.field == "source_id" and isinstance(answer, str) and attempt.get("attr") == "href":
                # Two ways to read the id out of the same link, judged by the cards: the number inside
                # the address (what a numeric-id listing needs) and the whole last segment (what a
                # slug-id listing needs). Only one of them reads every card, and which one differs per
                # site — measured on jable.tv's model page (2026-10-05), whose ids are slugs.
                trials.append(segment_rule_for_id(attempt, answer))
            for trial in trials:
                scored = _score_over_cards(trial, report.field, rows, answer)
                if best is None or scored > best:
                    chosen[report.field] = _as_shipped(trial, report.field, answer)
                    best = scored
        # Two blocks rarely share a layout, and one rule then cannot read both: measured on a
        # real artist page, whose imageset block and CG block carry the work link under
        # different elements. What the runtime already has for this is `fallback` — tried when
        # the rule before it yields nothing — and a listing field is resolved per *row*, so a
        # chain falls back per row, which is exactly the shape of the problem.
        chained = _chained_rule(candidates, rows, report.field, answer)
        if chained is not None:
            scored = _score_over_cards(chained, report.field, rows, answer)
            if best is None or scored > best:
                chosen[report.field] = _as_shipped(chained, report.field, answer)
                best = scored
        if report.field == "source_id" and best is not None and rows and best[0] == 0.0:
            # Only "reads nothing at all on any card" is refused. Measured on a real
            # artist page whose two blocks have different layouts: refusing a rule that
            # read twelve ids out of twenty-five left the runtime with no cards at all,
            # which is worse than a partial crawl — the checks then name, card by card,
            # the ones it could not read.

            chosen.pop(report.field, None)
    # Every card also carries the work's **address**, which is a different thing from its id and is
    # what the rest of the run needs: the review page links it (so a selection can be downloaded),
    # `collect_items` reads it, and the export's `detail_url` is it. Derived from the same link the
    # id was narrowed out of, so the two cannot describe different elements.
    link = chosen.get("source_id")
    if "detail_url" not in chosen and link is not None and str(link.get("attr")) == "href":
        chosen["detail_url"] = {
            **{key: value for key, value in link.items() if key not in ("filter", "group")},
            "absolute": True,
        }
    return chosen


def _as_shipped(rule: dict[str, Any], field: str, answer: Any) -> dict[str, Any]:
    """The rule as it must be written into `site.json`, which is the rule that was measured.

    For `source_id` those two were not the same: the comparison narrows the rule to the id inside
    the address (`card_rule_for_id`), while it was shipping unnarrowed — so a listing whose cards
    are links produced **the whole URL as every work's id**. Measured on bilinovel's cards: ids came
    out as `https://www.bilinovel.com/novel/3095.html`, which then names the export directory and
    every media id. Every hand-written site writes `filter` plus `group` on the href; this is where
    the Builder writes the same rule.
    """
    if field == "source_id" and isinstance(answer, str):
        return card_rule_for_id(rule, answer)
    if (field == "date_added" and isinstance(answer, str)
            and re.fullmatch(r"(?:about\s+)?\d+\s+(?:second|minute|hour|day|week)s?\s+ago|today|yesterday",
                             answer.strip(), re.IGNORECASE)):
        transforms = [str(name) for name in _as_list(rule.get("transform"))]
        if "relative_date" not in transforms:
            transforms.append("relative_date")
        return {**rule, "transform": transforms}
    return rule


def target_rule_for_id(rule: dict[str, Any], href: str,
                       work_url_pattern: str) -> dict[str, Any] | None:
    """Narrow a card link with the id captured by the site's already-learned work target.

    The target pattern tells us *which path segment* is the work id.  The selector itself keeps a
    relative path pattern because card hrefs are filtered before they are absolutised.
    """
    try:
        matched = re.compile(work_url_pattern, re.IGNORECASE).search(href)
    except re.error:
        return None
    if matched is None:
        return None
    if "id" in matched.groupdict() and matched.group("id") is not None:
        identifier = matched.group("id")
    elif matched.groups():
        identifier = matched.group(1)
    else:
        return None
    path = urlparse(href).path or href
    segments = [part for part in path.split("/") if part]
    try:
        index = segments.index(identifier)
    except ValueError:
        return None
    prefix = (re.escape(segments[index - 1]) + "/") if index else ""
    pattern = (r"(?:^|/)" + prefix + r"([^/?#]+)(?=/|[?#]|$)")
    narrowed = {key: value for key, value in rule.items()
                if key not in ("absolute", "filter", "group")}
    if narrowed.get("fallback"):
        narrowed["fallback"] = [
            target_rule_for_id(branch, href, work_url_pattern) or branch
            for branch in narrowed["fallback"]
        ]
    return {**narrowed, "filter": [pattern], "group": 1}


def segment_rule_for_id(rule: dict[str, Any], href: str) -> dict[str, Any]:
    """The card's link rule, narrowed to the **whole last segment** of the address.

    The other narrowing takes the number inside the link, which is what a listing whose ids are numbers
    needs — but a site whose ids are slugs (`/videos/snos-357/`) has no number that names the work: that
    narrowing read `357` from it, which no other card carries, and the id rule was dropped for reading
    nothing on most cards. Measured on jable.tv's model page (2026-10-05), where the id is the slug and
    the check said "the same id on several cards (None)" while the adapter installed anyway.

    Both narrowings are offered as candidates and the measurement over the cards decides, which is how
    every other listing rule is chosen: on a numeric address the number form reads better (it drops the
    `.html`), on a slug address this one does.
    """
    path = urlparse(href).path or href
    segments = path.split("/")
    for index in range(len(segments) - 1, -1, -1):
        if not segments[index]:
            continue
        head = "/".join(segments[:index])
        pattern = (re.escape(head + "/") if head else "") + r"([^/]+)(?=[/?#]|$)"
        # `absolute` goes the way it goes in `card_rule_for_id`: the group has already reduced the
        # address to the id, and absolutising that joins the id to the page.
        narrowed = {key: value for key, value in rule.items() if key != "absolute"}
        return {**narrowed, "filter": [pattern], "group": 1}
    return rule


def _score_over_cards(rule: dict[str, Any], field: str,
                      rows: list[tuple[str, Element]],
                      answer: Any = None) -> tuple[float, float, float]:
    """How well a rule reads a card set: filled, distinct, and of the same shape.

    Three numbers, because each catches what the one before it cannot:

    * the share of cards it reads a value from — a rule that reads one card of twenty-four is
      not a listing rule;
    * the share of those values that are *distinct* — a rule reading the same id everywhere
      fills in beautifully and crawls nothing;
    * the share that looks like the answer the person gave (`_same_shape`) — measured on a real
      gallery, where the marked card's link was the work (`/doujinshi/…`) and the same class on
      the other cards was a tag link (`/artist/…`). Both were filled, both were distinct, and
      only the addresses' own shape told them apart.
    """
    if not rows:
        return (1.0, 1.0, 1.0)
    # For an id, the rule is measured *after* the id has been taken out of the address, not
    # before: measured on a real artist page, where the link class that reads the work on one
    # block reads a date on the other. Judged as addresses, the two are both "filled and
    # distinct" and the wrong one wins; judged as ids, the date repeats on every card.
    # The narrowing here is the one that will *ship* (`_as_shipped`), so a `unique` variant is
    # measured as the rule the runtime will actually receive — measured on jable.tv's model page
    # (2026-10-05), where the un-narrowed variant scored a perfect read and the narrowed rule it
    # became read no id on any of the 24 cards.
    scorer = card_rule_for_id(rule, answer) if field == "source_id" and isinstance(answer, str) else rule
    values = [str(value or "") for value in _values_over_rows(scorer, rows)]
    filled = [value for value in values if value]
    read_share = len(filled) / len(values)
    distinct_share = (len(set(filled)) / len(filled)) if filled else 0.0
    if answer is None or not isinstance(answer, str):
        shape_share = distinct_share if field == "source_id" else read_share
    else:
        alike = [value for value in filled if _same_shape(value, answer)]
        shape_share = len(alike) / len(filled) if filled else 0.0
    if field not in ("source_id", "cover_url"):
        # For a title or a date, "distinct" and "the same shape" are not the question: a
        # listing where two cards share a title is a listing, not a bug.
        return (read_share, read_share, read_share)
    return (read_share, distinct_share, shape_share)


def _same_shape(value: str, answer: str) -> bool:
    """Whether a value looks like the answer: the same site, the same kind of address.

    Addresses are compared by host and by the first path segment, which is the part a site
    gives its *kind* of page (`/doujinshi/`, `/artist/`, `/album/`). Anything that is not an
    address is left to the distinctness check.
    """
    one, other = urlparse(value), urlparse(answer)
    if not one.scheme or not other.scheme:
        return True
    if (one.hostname or "") != (other.hostname or ""):
        return False
    first = lambda path: [part for part in path.split("/") if part][:1]  # noqa: E731
    return first(one.path) == first(other.path)


def _blocks(selector: str) -> list[str]:
    """The separate card sets a row selector names, when it names more than one."""
    return [part.strip() for part in selector.split(",") if part.strip()]


def _chained_rule(candidates: list[dict[str, Any]], rows: list[tuple[str, Element]],
                  field: str, answer: Any) -> dict[str, Any] | None:
    """Rules chained with `fallback`, covering the cards the first one gets wrong.

    Not "one rule per block". Measured on a real artist page: its two blocks are not the
    thing that separates the good rule from the bad — the *same* rule won both, because the
    block whose work link sits elsewhere also happens to have a link that matches the id
    pattern, only a date. What separates them is which cards come out right, so the chain is
    built the other way round: take the best rule, look at the cards it reads nothing from or
    reads the same value from twice, and let the best rule *for those cards* stand behind it.
    The runtime tries a `fallback` when the rule before it yields nothing, and a listing field
    is resolved per row, so this falls back exactly where it is needed.

    At most three branches: a chain longer than that is a page whose cards have little in
    common, and saying so is better than a rule that looks like it covers everything.
    """
    if not rows or not candidates:
        return None
    remaining = list(rows)
    branches: list[dict[str, Any]] = []
    for _ in range(3):
        best_rule, best_score = None, None
        for attempt in candidates:
            if any(_same_rule(attempt, branch) for branch in branches):
                continue
            scored = _score_over_cards(attempt, field, remaining, answer)
            if best_score is None or scored > best_score:
                best_rule, best_score = attempt, scored
        if best_rule is None or best_score is None or best_score[0] == 0.0:
            break
        branches.append(best_rule)
        covered = _rows_read_by(best_rule, field, remaining, answer)
        remaining = [row for row in remaining if row not in covered]
        if not remaining:
            break
    if len(branches) < 2:
        return None
    return {**branches[0], "fallback": branches[1:]}


def _rows_read_by(rule: dict[str, Any], field: str, rows: list[tuple[str, Element]],
                  answer: Any) -> set[int]:
    """Which of these rows a rule reads a usable value from: filled, and not a repeat.

    A value that another row also gives is not a value: on that artist page the wrong links
    read the same date on every card, which fills the field and identifies nothing.
    """
    scorer = card_rule_for_id(rule, answer) if field == "source_id" and isinstance(answer, str)         else rule
    values: dict[int, str] = {}
    for index, value in enumerate(_values_over_rows(scorer, rows)):
        if value:
            values[index] = str(value)
    counts: dict[str, int] = {}
    for value in values.values():
        counts[value] = counts.get(value, 0) + 1
    return {index for index, value in values.items() if counts[value] == 1}


def _same_rule(one: dict[str, Any], other: dict[str, Any]) -> bool:
    return json.dumps(one, sort_keys=True) == json.dumps(other, sort_keys=True)


def _values_over_rows(rule: dict[str, Any], rows: list[tuple[str, Element]]) -> list[Any]:
    """What a field rule reads for these rows, decided the way the runtime decides it.

    A `unique` rule is not read inside one row at all: the reader gathers every candidate in every
    row, drops the values another row also has, and only then narrows the survivors to an id
    (`extract.read_listing`). Anything that reads such a rule row by row is measuring — or
    checking — a different rule than the one that ships. Measured on jable.tv's model page
    (2026-10-05): the `unique` variant scored a perfect read, and the narrowed rule it shipped as
    read no id on any of the 24 cards.
    """
    if isinstance(rule, dict) and rule.get("unique"):
        return list(_unique_values(rule, rows))
    return [_read_in_row(rule, row, url) for url, row in rows]


def _unique_values(rule: dict[str, Any], rows: list[tuple[str, Element]]) -> list[str | None]:
    """What a `unique` rule produces for these rows, through the runtime's own decision.

    The same three steps the listing reader takes: read every candidate in every row, drop the
    values another row also has, then apply the filter that turns the address into an id. Shared
    rather than re-implemented, because a measurement that models the reader differently from
    the reader is a measurement of something else.
    """
    probe = {key: value for key, value in rule.items()
             if key not in ("filter", "group", "unique", "list")}
    per_row = [[str(value) for value in _as_list(_read_in_row({**probe, "list": True}, row, url)
                                                 or [])]
               for url, row in rows]
    return [narrowed(value, rule) for value in first_unique(per_row)]


def _tag_only(rule: dict[str, Any]) -> dict[str, Any] | None:
    """The same rule with its element named by tag alone, when that is a different rule.

    A card laid out differently from its neighbours cannot be read by a rule that names the
    card's own class. Measured on a real gallery: the marked card's link carried a class the
    other twenty-three did not, so the rule learned from that card read nothing on them — and
    the rule that *does* read them is the one the hand-written sites write for this field, the
    element named by its tag. The cards decide which is better (`_score_over_cards`); this only
    puts the second candidate on the table.
    """
    select = str(rule.get("select") or "")
    if not select or any(mark in select for mark in (" ", "#", "[")):
        return None
    name = select.split(".")[0]
    if not name or name == select or "." not in select:
        return None
    return {**rule, "select": name, "matches": 1}


def card_rule_for_id(rule: dict[str, Any], href: str) -> dict[str, Any]:
    """The card's link rule, narrowed to the id inside the address it reads.

    A person marking a card marks the *link*, because that is what is on the page — and a
    listing's `source_id` is the number inside it. Every hand-written site writes this rule
    the same way, `filter` plus `group` on the href, so the Builder writes it that way too
    rather than inventing a second way to say the same thing.

    What the pattern may **not** be is the address itself. The first version escaped the whole
    path around the digits, so on a real gallery — whose work addresses carry the work's own
    title, `…/futa-shigo-tsutaete-|-futa-dick-bonding-english-3547173.html` — the rule only
    ever matched the card it was learned from, and read no id on any other card. A segment that
    *is* the id (`/album/1472965/`) is kept whole; digits inside a longer segment are read with
    their immediate neighbours only, which is the shortest context that still tells the id from
    the numbers a slug may contain (`c108`, `vol2`).
    """
    if rule.get("group") is not None and rule.get("filter"):
        # Already narrowed — measuring a rule narrows it, and the rule that comes out of the
        # measurement must not be narrowed a second time, which would filter the id itself.
        return rule
    path = urlparse(href).path or href
    # The **last** number in the address, not the first: a work address carries its own title,
    # and that title carries numbers — measured on a real gallery, whose work links read
    # `…-日本語-4201383` while the date links read `…-2025`, and a pattern built from the first
    # number turned every card's work id into a date.
    match = None
    for found in re.finditer(r"\d+", path):
        match = found
    if match is None:
        return rule
    head, tail = path[:match.start()], path[match.end():]
    segment = head.rsplit("/", 1)[-1]
    if not segment:
        # The digits are the whole segment: the path up to them is the stable part.
        pattern = re.escape(head) + r"(\d+)"
    else:
        separator = segment[-1] if segment[-1] in "-_.@" else ""
        extension = tail if tail.startswith(".") and not any(mark in tail for mark in "/?#") else ""
        # The id is what the address *ends* with. Measured on a real gallery: its work address
        # carries the work's own title — `…-日本語-4201383` — and a pattern without the end
        # anchor matched the first number in it instead, so every card reported a date
        # (`2026`, `2025`) or a volume number as its work id.
        # Anchored, because the numbers before it are the title's: what follows the id is an
        # extension, a query, or nothing.
        #
        # A path that *ends in a slash* after the id is the same id: `/videos/snos-357/` puts the
        # path's own separator after the number, and a pattern that only accepted an extension, a
        # query or the very end matched nothing, so the rule read no id on any card. Measured on
        # jable.tv's model page (2026-10-05), whose cards are `/videos/snos-357/`. The optional
        # slash is taken before the anchor, never inside it: put `/` in the lookahead and the
        # pattern matches the *first* number a slash follows (`/2025/05/work-123/` would read
        # `2025`), which is the defect the anchor exists for.
        suffix = "(?=[?#]|$)"
        trailing = "/?" if tail == "/" else ""
        pattern = re.escape(separator) + r"(\d+)" + re.escape(extension) + trailing + suffix
    # `absolute` has to go, and this is not a detail: the filter's group has already reduced
    # the address to the id, and absolutising *that* joins it to the page — measured on a real
    # gallery, where every id came out as `https://hitomi.la/artist/3547173`. Every id was then
    # different from every other, so a check for "is it distinct" said the rule was fine. The
    # hand-written sites never combine the two, and now neither does this.
    narrowed = {key: value for key, value in rule.items() if key != "absolute"}
    if narrowed.get("fallback"):
        # Every branch of a chain reads an address too, so every branch needs the id taken
        # out of it — the branches are the two layouts, not two ways of doing one thing.
        narrowed["fallback"] = [card_rule_for_id(branch, href)
                                for branch in narrowed["fallback"]]
    return {**narrowed, "filter": [pattern], "group": 1}


def rule_from(group: CardGroup, fields: dict[str, dict[str, Any]],
              document: str = "listing_html") -> dict[str, Any]:
    """The `listings` entry for a card set, from the rules learned inside one card.

    `fields` is what the card was learned as — the same shape a work's fields have, since
    a row *is* the document a field rule sees. The card's own selector becomes the row
    selector, and it is also excluded from the field rules: a rule naming the row reads
    nothing inside it.
    """
    relative: dict[str, dict[str, Any]] = {}
    for name, field_rule in fields.items():
        stripped = _inside_the_row(field_rule, group.selector)
        if stripped is None:
            continue
        # The card was harvested as a page of its own, so its rules name that page's
        # document; inside a listing they must name the document the row comes from, or they
        # look for a document the reader never produced and read nothing at all.
        relative[name] = {**stripped, "document": document}
    fields = relative
    missing = [name for name in REQUIRED_CARD_FIELDS if name not in fields]
    return {
        "document": document,
        # A card set is named by its class, and a class can be shared with another block on the page —
        # so when the set needs its block to be told apart, the rule carries that too (`scope` is the
        # selector vocabulary's own word for it, and the runtime reads the rows inside it).
        "row_selector": ({"select": group.selector, "scope": group.scope} if group.scope
                         else group.selector),
        "fields": fields,
        "_builder": {
            "cards": group.count,
            "hints": list(group.hints),
            "missing": missing,
        },
    }


def pagination_from(pages: list[tuple[str, str]]) -> Pagination:
    """How these sampled pages lead to one another.

    The plan's §17 order: a URL parameter, then an explicit `next` link, then a numbered
    list. `pages` is `[(url, html), ...]` in the order they were fetched; two pages are
    enough for the first two forms, and the numbered form is read off the first page's
    links.
    """
    if len(pages) < 2:
        return Pagination(kind="unsupported", pages_sampled=len(pages),
                          detail="one page was sampled, so nothing was learned about "
                                 "the way to the next one")
    (first_url, first_html), (second_url, second_html) = pages[0], pages[1]

    one, two = urlparse(first_url), urlparse(second_url)
    if one.netloc == two.netloc and one.path == two.path:
        left, right = parse_qs(one.query), parse_qs(two.query)
        differing = [key for key in right
                     if left.get(key) != right.get(key) and right[key]]
        if len(differing) == 1:
            key = differing[0]
            return Pagination(kind="url_param", page_param=key,
                              first_page=first_url, second_page=second_url,
                              pages_sampled=2,
                              detail=f"the two addresses differ only in ?{key}=")

    # An explicit next link: the page says which link leads on, and two independent
    # signals are accepted — `rel=next` and a link whose address *is* the next page.
    from ..generic.htmltree import parse_html, select_all      # local: only needed here

    root = parse_html(first_html)
    # The second address is a *sample*, and what it is for is learning a rule that walks **every**
    # page — not a rule that knows one address. So the branches are tried from the most general to the
    # least: a page's own `rel=next` declaration, then a pager whose numbers are visible (the walk
    # computes each next page from the one it is reading), and only then a link whose exact address was
    # sampled — which stops after that page, and is reported as such.
    sampled_href: str | None = None
    for element in select_all(root, "a[href]"):
        href = (element.attr("href") or "").strip()
        if not href:
            continue
        rel = (element.attr("rel") or "").lower()
        absolute = _absolute(first_url, href)
        # A link back to **this** page is not the way on: `#`, a logo, the page's own address. Taking
        # one was how a two-page model page learned a rule reading "any link containing a #" —
        # measured on jable.tv (2026-10-05), where the person pasted the same address twice because
        # that pager never changes the address bar, and the adapter installed happily while walking
        # nowhere at all. `rel=next` is a page's own declaration, so it is taken as written unless it
        # points back here.
        if absolute == first_url:
            continue
        if rel == "next":
            return Pagination(kind="next_link",
                              next_selector={"from": "html", "document": "listing_html",
                                             "select": f"a[rel={rel}]", "attr": "href",
                                             "absolute": True},
                              first_page=first_url, second_page=second_url, pages_sampled=2,
                              detail="the page declares the next one (rel=next), so the walk follows "
                                     "it on every page")
        if absolute == second_url and sampled_href is None:
            sampled_href = href

    # A pager that writes its numbers in the links themselves (`01 02 03 …`, and the address carries
    # the number: `…/2/`). Nothing else is needed to walk it — the page being read says which number
    # it is, so the next one is one past it — and *no second address is required*, which matters
    # because such a pager usually swaps its list in place and never changes the address bar:
    # measured on a jable.tv model page (2026-10-05), where both addresses a person can copy are the
    # same one and the tool used to learn "any link containing a #" from the page's own `href="#"`.
    # It comes before the sampled address on purpose: the numbers walk every page, that address one.
    pager = _numbered_pager(root, first_url)
    if pager:
        selector = {"from": "html", "document": "listing_html", "select": pager[0],
                    "attr": "href", "page_numbers": True}
        return Pagination(kind="numbered_pages", next_selector=selector,
                          first_page=first_url, second_page=second_url, pages_sampled=2,
                          detail=f"the pager numbers its pages ({pager[1]} numbered link(s)); the walk "
                                 "follows the number after the page it is reading")

    # The sampled address, used only when nothing more general was found. It is a rule that knows one
    # page and stops: measured on a site whose pager shows no numbers, the walk read the two pages
    # that were sampled and nothing after them — which is *not* what the second address is for, so it
    # is reported as a limit rather than passed off as pagination.
    if sampled_href is not None:
        return Pagination(kind="next_link",
                          next_selector={"from": "html", "document": "listing_html",
                                         "select": "a[href]", "attr": "href",
                                         "filter": [re.escape(sampled_href)]},
                          first_page=first_url, second_page=second_url, pages_sampled=2,
                          exact_next=True,
                          detail="the next page is known only by the address that was sampled, so the "
                                 "walk stops after it")

    numbers = {href for href in (_absolute(first_url, element.attr("href") or "")
                                 for element in select_all(root, "a[href]"))
               if PAGE_NUMBER_RE.search(href or "")}
    if numbers:
        selector = {"from": "html", "document": "listing_html", "select": "a[href]",
                    "attr": "href", "absolute": True,
                    "filter": [r"[?&](?:page|p)=\d+"]}
        return Pagination(kind="numbered_links", next_selector=selector,
                          first_page=first_url, second_page=second_url, pages_sampled=2,
                          detail=f"{len(numbers)} numbered page link(s) on the first page")

    # Nothing on the first page says where the next one is. The verdict is the same either way — this
    # needs a custom fetcher — but *why* there is nothing to learn differs, and a person can act on the
    # second case: measured on a jable.tv model page (2026-10-05) whose pager swaps its list in place,
    # so the address bar never changes and both addresses they can paste are the same one. Its own
    # pager link carries the real next address (`…/2/`), and pasting *that* does teach the walk.
    detail = ("no page parameter, no next link and no numbered list; a load-more button or infinite "
              "scroll needs a custom fetcher")
    if first_url == second_url:
        detail += (" — and both addresses are the same, so nothing was learned about the way on: if "
                   "the pager's own link carries a different address, paste that one")
    return Pagination(kind="unsupported", first_page=first_url, second_page=second_url,
                      pages_sampled=2, detail=detail)


def _absolute(base: str, href: str) -> str:
    from urllib.parse import urljoin
    return urljoin(base, href)


def _numbered_pager(root, page_url: str) -> tuple[str, int] | None:
    """The selector and count of a pager whose links carry their own page numbers.

    A link counts when its **text is a number** and its address is this page's address with that
    number as its tail (`…/2/`) or as a page parameter (`?page=2`) — the structural judgement that
    keeps a footer's `2024` out. The selector is the links' own, so the walk can read them again on
    every page; the runtime picks the number one past the page it is reading (`page_numbers`).
    """
    from ..generic.htmltree import select_all                  # local: only needed here

    counted: dict[str, int] = {}
    for element in select_all(root, "a[href]"):
        text = element.text().strip()
        href = (element.attr("href") or "").strip()
        if not text.isdigit() or not href or int(text) < 2:
            continue
        absolute = _absolute(page_url, href)
        if not is_page_address(page_url, absolute, int(text)):
            continue
        # Every page has to say its own number, or the walk cannot re-read it: the runtime computes
        # each next page from the address it is reading, so a pager whose number hides inside a segment
        # (`…_2_0.html`, where the path's last number is a `0`) is *not* learned this way — it would be
        # a walk that claims to follow numbers and cannot.
        if page_number_of(absolute) != int(text):
            continue
        counted[element_selector(element)] = counted.get(element_selector(element), 0) + 1
    if not counted:
        return None
    selector = max(counted, key=lambda key: counted[key])
    return selector, sum(counted.values())


def target_pattern_problem(url_pattern: str, samples: list[str]) -> str | None:
    """Why this listing target pattern would never resolve, or None when it reads its samples.

    Asked through the runtime's own matcher rather than a second copy of the rule, because
    `TargetRule.match` is what decides whether a pattern is usable. Two ways to fail, and both
    were live once: a pattern that matches none of its own sample pages, and one that matches but
    captures nothing — a group-less pattern, which `match` answers with `None`, so the target
    resolves through no code path at all while the adapter still installs and reports success.
    """
    rule = TargetRule(kind="listing", url_pattern=re.compile(url_pattern), id_group=None,
                      label="listing", single=False)
    for url in samples:
        if rule.url_pattern.search(url) is None:
            return (f"the listing pattern {url_pattern!r} matches none of its own samples "
                    f"({url!r}), so this target could never resolve")
        if rule.match(url) is None:
            return (f"the listing pattern {url_pattern!r} matches {url!r} but captures no id, so "
                    "nothing could name this listing: `TargetRule.match` takes the id from a named "
                    "group, else a positional one, and answers `None` when there is neither")
    return None


def listing_draft(*, host: str, kind: str, url_pattern: str, rule: dict[str, Any],
                  pagination: Pagination | None = None,
                  document: str = "listing_html",
                  acquisition: str = "http") -> dict[str, Any]:
    """The `targets` and `listings` sections of a draft for one declared page kind."""
    entry = dict(rule)
    entry["document"] = document
    if acquisition != "http":
        entry["acquisition"] = acquisition
    if pagination is not None and pagination.usable:
        if pagination.page_param:
            entry["page_param"] = pagination.page_param
        if pagination.next_selector:
            entry["next_selector"] = pagination.next_selector
    review = []
    if pagination is None or not pagination.usable:
        review.append("pagination: " + (pagination.detail if pagination
                                        else "the next page was not sampled"))
    elif pagination.exact_next:
        # The one case where the second address *is* the rule: the page shows no numbers and declares
        # no next link, so the walk can only recognise that one address. Said plainly, because a rule
        # that stops after the sampled pages is not what a second address is for.
        review.append("pagination: " + pagination.detail)
    if pagination is not None and pagination.pages_sampled < 3:
        review.append(f"only {pagination.pages_sampled} page(s) were sampled, so the "
                      "listing rules rest on one card set seen twice")
    return {
        "targets": {kind: {"url_pattern": url_pattern, "label": kind.title(),
                           "single": False}},
        "listings": {kind: entry},
        "documents": {"listing": {document: {"format": "html"}}},
        "_draft_listing": {"review": review},
    }


def _rows(html: str, selector: str | dict[str, Any]) -> list[Element]:
    """The rows a listing rule names — a class, or a class read inside the block that holds the set."""
    return rows_of(parse_html(html), selector)


def _read_in_row(rule: dict[str, Any], row: Element, url: str) -> Any:
    """One field rule against one row, scoped exactly as the runtime scopes it."""
    bag = DocumentBag()
    bag.add(RuntimeDocument.from_element("listing_html", row, url))
    try:
        return resolve(rule, bag, context={"url": url or "", "card": {}})
    except Exception:  # noqa: BLE001 - a rule that cannot run reads nothing
        return None


def check_over_cards(rule: dict[str, Any], pages: list[tuple[str, str]]) -> list[str]:
    """What the sampled cards say about a listing rule.

    The plan's §17 asks the terminal condition to be "no new ids on this page" rather than
    trusting the UI's next marker, and the same idea is what checks a *card* rule: a listing
    whose ids repeat is not reading ids at all. The findings are all reasons to fix the rule
    rather than to trust it:

    * the row selector names nothing on a sampled page;
    * a field reads nothing on the cards — one card without a cover is normal, a field
      empty on most of them is a rule pointed at the wrong element;
    * the ids are not distinct, within a page or between pages — the "no new id"
      condition, and the one that catches a rule reading a shared container.
    """
    findings: list[str] = []
    # One check per *address*: a pager that never changes the address bar hands the same page over
    # twice, and checking it twice reports every finding twice while "page 2 adds no id" reads as a
    # verdict about pagination that was never measured. Measured on a jable.tv model page (2026-10-05).
    distinct: list[tuple[str, str]] = []
    seen: set[str] = set()
    for url, html in pages:
        if url not in seen:
            seen.add(url)
            distinct.append((url, html))
    if len(distinct) < len(pages):
        findings.append(f"{len(pages) - len(distinct)} of the {len(pages)} sample(s) repeated an "
                        "address, so fewer pages were checked than were given")
    per_page: list[set[str]] = []
    for url, html in distinct:
        rows = _rows(html, rule["row_selector"])
        if not rows:
            findings.append(f"the row selector {rule['row_selector']!r} names nothing on {url}")
            per_page.append(set())
            continue
        if len(rows) < 2:
            findings.append(f"{url} carries only {len(rows)} card(s); a listing needs more "
                            "than one for the set to be a set")
        for name, field_rule in rule["fields"].items():
            # Read the way the runtime reads it, `unique` pass included: a check that reads a
            # field row by row reports a correct `unique` rule as unread, and reports a broken
            # one as fine. Same rule, same reader (`_values_over_rows`).
            values = _values_over_rows(field_rule, [(url, row) for row in rows])
            empty = sum(1 for value in values if not value)
            if empty == len(rows):
                # An optional field a listing simply does not carry — a date, most often —
                # is not a fault: many sites list their works without one, and the work page
                # supplies it when the work is fetched. Only the fields a card cannot be
                # without are reported as unread.
                if name in REQUIRED_CARD_FIELDS:
                    findings.append(f"{name}: read nothing on any of the {len(rows)} card(s) "
                                    f"of {url}")
            elif empty > 1:
                findings.append(f"{name}: read nothing on {empty} of {len(rows)} card(s) of {url}")
        ids = [str(value) for value in
               _values_over_rows(rule["fields"].get("source_id") or {}, [(url, row) for row in rows])]
        repeated = sorted({value for value in ids if ids.count(value) > 1})
        if repeated:
            findings.append("source_id: the same id on several cards of "
                            f"{url} ({', '.join(repeated)[:60]})")
        per_page.append({value for value in ids if value})
    for index in range(1, len(per_page)):
        if per_page[index] and per_page[index] <= per_page[index - 1]:
            findings.append(f"page {index + 1} adds no id the page before it did not have")
    return findings


def cards_as_read_by_the_runtime(template_path, page_url: str, html: str,
                                 document: str = "listing_html",
                                 kind: str | None = None) -> list[dict[str, Any]]:
    """The cards the *runtime* reads from this page, through its own listing path.

    The third leg of the plan's acceptance, for a listing: what the Builder marked must be
    what an installed adapter produces. Reading through `extract_listing` rather than
    through a private copy of the logic is what makes this a check and not a rehearsal.
    """
    template = load_template(template_path)
    # The kind is what `listings` is keyed by, and a generated draft declares exactly one
    # of them; naming it explicitly is only needed when a site has several.
    if kind is None:
        kind = next(iter(template.listings), None)
    cards, _next = extract_listing_page(template, document, html, page_url, kind)
    return cards
