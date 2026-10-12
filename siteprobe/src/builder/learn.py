"""Phase 5: from three samples of one site to a draft adapter.

The plan's §13. A single annotation produces a *hypothesis*, not a rule — and the
reason is measured, not theoretical: a rule derived from one candidate may read a
different value even on the page it came from (`a` matches every link, so it reads
the first one). What separates a hypothesis from a rule is whether it still reads
the right thing on pages the annotation never saw.

Here the three samples are three recorded sessions of the same site. Example 1 is
annotated by a person; Examples 2 and 3 are what prune. **Validation needs no
network at all**, because a session recorded its capture: the rules are resolved
against documents that are already on disk. That is what `capture.json` is for, and
it is why this phase can be tested without a browser.

Resolving a rule needs the runtime's own `DocumentBag`, so `capture_to_bag` builds
one — and in doing so states the contract a generated adapter has to meet:

    page        the markup
    jsonld      the page's JSON-LD blocks, as JSON
    network:N   each recorded response body
    inline:N    a script body, when it parses as JSON at all

A `json` selector reads a JSON document, so anything not exposed under one of those
names cannot be read by a rule. `capture_to_bag` is therefore not a convenience: it
is the definition the generated adapter is checked against in Phase 6.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.parse import urlparse

from ..generic.document import Document as RuntimeDocument
from ..generic.document import DocumentBag
from ..generic.select import resolve
from ..generic.unknown_url import jsonld_nodes
from .annotate import FIELD_LIMITS, FIELDS, rule_for
from .capture import Capture
from ..generic.select import split_members
from .harvest import (COLLECTION_JOIN, JSONLD_DOCUMENT, Harvest, flatten_json, harvest, joined_value,
                      members_of, parse_loose, same_members)
from src.generic.select import _assemble, json_path

# A hypothesis that read the right value everywhere it was checked.
KEEP = "keep"
# Read the wrong value, or nothing, where a value was expected.
PRUNE = "prune"
# Only the annotated page could check it: nothing contradicts it, and nothing
# supports it either. Kept, and said to be unproven rather than called a rule.
UNPROVEN = "unproven"
#: How many verified alternatives ride along with a field's rule. Enough for a page whose content
#: arrives by JavaScript (the markup rule, then the API one) and short enough to read.
MAX_FALLBACKS = 3


@dataclass
class Sample:
    """One recorded page of the site, and what a person said its fields are."""

    name: str
    capture: Capture
    harvest: Harvest
    # field -> the value a person accepted: a string, or a list of members for a
    # collection. A collection that arrives as its repr is not a value anyone accepted.
    annotated: dict[str, Any] = field(default_factory=dict)
    absent: set[str] = field(default_factory=set)
    #: field -> the candidate a person clicked, when the session recorded one. A value alone cannot
    #: tell two fields apart when one word serves both — measured on iwara (2026-10-10), the work's
    #: title and its character list are the same word, so matching by value handed `characters` the
    #: *title's* rule and the confirm page showed the work's title as its character list.
    picks: dict[str, str] = field(default_factory=dict)
    #: positional document name -> the name its request has, once the sample set says which part of
    #: the address is the work's id (`network_documents`). Empty when nothing can be derived, and
    #: then every rule reads exactly what it read before.
    document_names: dict[str, str] = field(default_factory=dict)
    #: The page as the site served it, when the caller fetched it. A crawl reads *this* document, so
    #: it is what a rule has to be checked against — the capture's markup is the browser's rendering.
    served: str | None = None
    #: Preserve the user's date meaning even when equal timestamps merge or candidate ids change.
    date_kinds: dict[str, str] = field(default_factory=dict)

    @property
    def url(self) -> str:
        return self.capture.final_url or self.capture.url

    def bag(self) -> DocumentBag:
        return capture_to_bag(self.capture, self.document_names, self.served)


@dataclass
class Reading:
    """What one hypothesis read on one sample.

    A reading of the page the hypothesis came from is not evidence: the annotation
    chose a value there, so a rule finding the same value again says only that the
    rule reads what it was built from. `source` marks that sample and excludes it
    from the verdict — which is precisely why the plan asks for two more pages.
    """

    sample: str
    value: Any
    expected: Any
    source: bool = False
    # A person said this page has no value for the field. Silence then means what it
    # says; silence where a value *was* expected means the rule could not find it.
    absent: bool = False

    @property
    def agrees(self) -> bool:
        return self.expected is not None and self.value is not None \
            and same_members(self.value, self.expected)

    @property
    def checked(self) -> bool:
        return self.expected is not None and not self.source and not self.absent

    @property
    def missing(self) -> bool:
        """A value was expected here and the rule read nothing."""
        return self.checked and self.value is None


@dataclass
class Hypothesis:
    """One rule candidate for a field, and what the other samples said about it."""

    rule: dict[str, Any]
    from_candidate: str
    sources: list[str]
    readings: list[Reading] = field(default_factory=list)

    @property
    def verdict(self) -> str:
        checked = [reading for reading in self.readings if reading.checked]
        if not checked:
            return UNPROVEN
        own = next((reading for reading in self.readings if reading.source), None)
        if own is not None and own.value is None:
            # It cannot reproduce what was annotated, so it is not a rule.
            return PRUNE
        if own is not None and own.expected is not None and not own.agrees:
            # It read a different value on the very page the annotation came from, so it
            # does not describe what a person accepted — and a rule that cannot
            # reproduce its own page will not reproduce the next one either. This is the
            # half that let a rule reading all sixteen of a work's tags pass against an
            # annotation that had recorded the first five.
            return PRUNE
        if any(reading.value is not None and not reading.agrees for reading in checked):
            return PRUNE
        if any(reading.missing for reading in checked):
            # The page carries the field and the rule could not read it, which is what
            # the plan's Example 2 exists to catch.
            return PRUNE
        return KEEP

    def reason(self) -> str:
        """Why the verdict is what it is, including what a page did not have.

        A page that carries no value for a field is not evidence against the rule — a
        work is not required to declare every field, and characters in particular are
        often only inside the tags. So silence is reported as accepted absence, and
        only reading a *different* value counts against a rule.
        """
        for reading in self.readings:
            if reading.checked and reading.value is not None and not reading.agrees:
                read, expected = _pair(reading.value, reading.expected)
                return f"read {read} on {reading.sample} where {expected} was expected"
        own = next((reading for reading in self.readings if reading.source), None)
        if own is not None and own.value is None:
            return "read nothing on the page it was derived from"
        if own is not None and own.expected is not None and not own.agrees:
            read, annotated = _pair(own.value, own.expected)
            return (f"read {read} on the page it was derived from, where {annotated} was annotated")
        read = [r.sample for r in self.readings if r.checked and r.value is not None]
        gone = [r.sample for r in self.readings if r.missing]
        parts = []
        if read:
            parts.append("read the right value on " + ", ".join(read))
        if gone:
            parts.append("nothing on " + ", ".join(gone) + ", which does have it")
        accepted_absent = [r.sample for r in self.readings
                           if r.absent and r.source is False]
        if accepted_absent:
            parts.append("absent on " + ", ".join(accepted_absent) + " (no rule needed there)")
        return "; ".join(parts) or "nothing but the annotated page could check it"


@dataclass
class FieldReport:
    field: str
    kind: str
    hypotheses: list[Hypothesis]

    def kept(self) -> list[Hypothesis]:
        return [item for item in self.hypotheses if item.verdict == KEEP]

    def shaped(self, items: list[Hypothesis]) -> list[Hypothesis]:
        """Only the rules whose shape matches the field.

        A title is one value and a tag list is many, so a rule that reads a whole
        repeated group is not a candidate for `creator` however well it scores — and
        it scored well enough to be chosen: measured on a real portal, `creator` was
        learned as `a` with `list`, which reads the site's navigation.

        A preview set is many pictures for the same reason a tag list is many strings,
        so an `images` field wants the list-shaped rules too.
        """
        wants_list = self.kind in ("collection", "images")
        matching = [item for item in items if bool(item.rule.get("list")) == wants_list]
        return matching or items

    def chosen(self) -> Hypothesis | None:
        """The rule to put in the draft.

        A structured source first — an API path or a declared meta survives a
        redesign that a class name does not — then the rule that reproduces the
        annotated value *exactly*, then the most specific selector, which is the one
        that matched fewest elements on the annotated page.

        Exactness is what decides between two rules that both "agree": agreement is
        case-insensitive on purpose (`same_members`), so iwara's `slug` (`mornye`) and its
        `title` (`Mornye`) both passed while only one of them is what a person wrote — and
        the shorter rule won, so the library would have shown the slug.
        """
        candidates = self.shaped(self.kept() or self.hypotheses)
        if not candidates:
            return None
        structured = [item for item in candidates
                      if (item.rule or {}).get("from") in ("json", "meta")]
        pool = structured or candidates

        def exact(item: Hypothesis) -> int:
            return 0 if any(reading.source and reading.value == reading.expected
                            for reading in item.readings) else 1

        return min(pool, key=lambda item: (exact(item),
                                           item.rule.get("matches", 1),
                                           len(str(item.rule))))


@dataclass
class Learning:
    """Everything the three samples decided."""

    fields: list[FieldReport]
    notes: list[str] = field(default_factory=list)
    acquisition: str = "http"

    def chosen_rules(self) -> dict[str, dict[str, Any]]:
        """The rule to install for each field, with its verified alternatives behind it.

        The alternatives ride along as `fallback`, which the runtime already reads: it tries them only
        when the first rule yields nothing. That is what a page whose content arrives by JavaScript
        needs — measured on iwara (2026-10-11), whose *served* page is a 2.3 KB shell with no title in
        it at all while the browser-rendered page the Builder learned from has one: the crawl read the
        served page, the title rule found nothing, and the whole work was dropped as "the page did not
        contain the work's data" — an import of zero entries. A site whose first rule works never
        reaches the fallbacks, so nothing changes for it.
        """
        chosen: dict[str, dict[str, Any]] = {}
        for report in self.fields:
            winner = report.chosen()
            if winner is None or winner.verdict == PRUNE:
                continue
            if winner.rule.get("conflict"):
                # Measured on the page it came from: this rule reads a different value at
                # one of the elements it matches. Installing it would put another field's
                # value into this one, which is worse than leaving the field out.
                continue
            alternatives = [item.rule for item in report.kept()
                            if item.rule != winner.rule and not item.rule.get("conflict")]
            rule = dict(winner.rule)
            if alternatives:
                rule["fallback"] = alternatives[:MAX_FALLBACKS]
            chosen[report.field] = rule
        return chosen

    def to_json(self) -> dict[str, Any]:
        return {
            "acquisition": self.acquisition,
            "notes": self.notes,
            "fields": {
                report.field: {
                    "kind": report.kind,
                    "chosen": (report.chosen().rule if report.chosen() else None),
                    "hypotheses": [
                        {"rule": item.rule, "from": item.from_candidate,
                         "sources": item.sources, "verdict": item.verdict,
                         "reason": item.reason(),
                         "readings": [{"sample": reading.sample, "value": reading.value,
                                       "expected": reading.expected}
                                      for reading in item.readings]}
                        for item in report.hypotheses
                    ],
                }
                for report in self.fields
            },
        }

    def write(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_json(), ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
        return path


def _short(value: Any, limit: int = 60) -> str:
    """A value cut down to one line of a report, quoted the way Python would.

    A collection is a list of members; what a report needs is the line a person would
    recognise, not `str(list)`, which is the repr this project already mistook for a
    value once.
    """
    text = joined_value(value)
    return repr(text[:limit] + ("…" if len(text) > limit else ""))


#: How much either side of a difference is kept when two values are shown side by side.
DIFFERENCE_CONTEXT = 16


def _pair(left: Any, right: Any) -> tuple[str, str]:
    """Two values cut down to the part where they differ, with the rest elided.

    A verdict compares two values, and a plain cut of each hides exactly what the verdict is about:
    measured on buondua (2026-10-10), `…MissKON.com-001.jpeg?6f98…` against `…MissKON.com-002.jpeg?6f98…`
    differ in the middle, so both printed as the same string and the report read
    "read 'X…' where 'X…' was expected" — a verdict nobody can act on. Showing the window around the
    first difference is what makes it readable, whatever part of the value it sits in.
    """
    first, second = joined_value(left), joined_value(right)
    head = 0
    while head < min(len(first), len(second)) and first[head] == second[head]:
        head += 1
    tail = 0
    while (tail < min(len(first), len(second)) - head
           and first[len(first) - 1 - tail] == second[len(second) - 1 - tail]):
        tail += 1

    def window(text: str) -> str:
        start = max(0, head - DIFFERENCE_CONTEXT)
        end = len(text) - max(0, tail - DIFFERENCE_CONTEXT)
        return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")

    return repr(window(first)), repr(window(second))


def answer_members(field: str, value: Any) -> Any:
    """A field's answer as the members it holds.

    A person who marks a block that writes its members with separators is answering with
    the members, however the page joined them — `美甘寧瑠 美甘妮露` is two characters — and
    an older session recorded exactly that joined string. Either way the comparison is
    member against member, and a scalar field is left exactly as it was written.

    Split out because three places compare such an answer against what a rule read: the
    candidate search below, the verdict on the other pages, and the round trip
    (`roundtrip.compare`). All three used to compare the *written forms* — joining the
    answer with the separator the record uses and string-comparing that line — so a page
    that writes its tags with spaces came back first as "no candidate for 转生 / 奇幻 / …
    carries a usable rule" and then as "the two sides read different values" for the very
    same members, and the install was refused (a real bilinovel build, 2026-10-03).
    """
    if field in COLLECTION_FIELDS and isinstance(value, str):
        parts = split_members(value)
        return parts if len(parts) > 1 else value
    return value


def _with_split(rule: dict[str, Any], field: str, answer: Any) -> dict[str, Any]:
    """The rule reads the members, when the answer was written as one string.

    Splitting is a property of the *field*, not of the string, and this is the only place
    that knows which it is: 登場人物 answered with `美甘寧瑠 美甘妮露` is two characters, while
    a sentence with a full-width comma in it is one title. Measured the other way first —
    a split offered per *value* at harvest time — and it turned every two-word string into
    a collection, including the title the parser tests exist to protect.

    A rule that already reads a repeated group carries `list` and needs nothing; one that
    reads a single block of joined members needs this, and then produces exactly what the
    person accepted.
    """
    if field not in COLLECTION_FIELDS or not isinstance(answer, str) or rule.get("list"):
        return rule
    if len(split_members(answer)) < 2:
        return rule
    return {**rule, "transform": [*(rule.get("transform") or []), "split"]}


def _with_field_limit(rule: dict[str, Any], field: str) -> dict[str, Any]:
    """The rule keeps as many members as the field does.

    A field with a declared cap — a preview set keeps three — has that cap on both sides:
    the page records the first three and the rule reads with `limit`. Applying it to only
    one of the two is the shape that pruned a correct rule before (an annotation holding
    five of sixteen tags, a rule reading all sixteen, and the rule reported as wrong).

    A rule that already carries a `limit` keeps its own: the site asked for it, and the
    field's cap is a default rather than an override.
    """
    cap = FIELD_LIMITS.get(field)
    if not cap or rule.get("limit") is not None:
        return rule
    return {**rule, "limit": cap}


def _is_what_was_annotated(expected: Any, candidate_value: str,
                           field: str | None = None) -> bool:
    """Whether a candidate is the thing a person accepted.

    A candidate's value is one line — a collection's members joined — while an
    annotated collection is the list of members, so the list is joined before the two
    are compared. Stringifying instead is how the annotation came to hold a repr that
    no candidate ever carried, and the candidate was then never found at all.

    A field that keeps only the first few members answers with the *beginning* of the
    group it was marked from — a preview set keeps three of the twenty the page offers —
    so the candidate's line is the longer one and the match is by prefix. Comparing the
    whole line would find no candidate at all, and the field would be reported as having
    no usable rule on a page that offered exactly the right one.

    When the written forms disagree, the *members* still decide: a page that writes its tags
    `转生 奇幻 冒险` offers the same answer as one that writes `转生 / 奇幻 / 冒险`, and splitting
    is a property of the field either way. Comparing only the written forms is how a real
    bilinovel page reported "no candidate for 转生 / 奇幻 / … carries a usable rule" while the
    block a person had marked sat in the list with a rule of its own (measured 2026-10-03).
    """
    wanted = members_of(expected)
    offered = candidate_value.split(COLLECTION_JOIN)
    if field in FIELD_LIMITS and len(wanted) < len(offered):
        return all(same_members(one, other) for one, other in zip(wanted, offered))
    if same_members(joined_value(expected), candidate_value):
        return True
    if field not in COLLECTION_FIELDS:
        return False
    # The candidate on the field's own terms: its separators become members, and the two sides are
    # compared member against member. The exact test above runs first, so a member that itself
    # contains a separator (`A/B` as one tag) still matches the line it was recorded as.
    as_members = split_members(candidate_value)
    if len(wanted) != len(as_members):
        return False
    return all(same_members(one, other) for one, other in zip(wanted, as_members))


def capture_to_bag(capture: Capture, names: dict[str, str] | None = None,
                   served: str | None = None) -> DocumentBag:
    """The contract a generated adapter must meet, in one function.

    `names` renames a recorded response to the name its *request* has (see `network_documents`). The
    positional name stays in the bag beside it, so a rule learned before the renaming — an old
    annotation, an adapter already installed — keeps resolving exactly as it did.

    `served` is the page as the site *served* it, when the caller has it. It replaces the `page`
    document, because that is the page a crawl reads: the capture's own markup is what a browser
    rendered, and on a site whose content arrives by JavaScript the two are not the same document at
    all — measured on iwara (2026-10-11), whose served page is a 2.3 KB shell with no title in it,
    where a rule that read the *rendered* page was learned, installed, and then read nothing.
    """
    bag = DocumentBag()
    markup = capture.markup
    page_text = served if served is not None else (markup.text if markup is not None else None)
    if page_text is not None:
        bag.add(RuntimeDocument(name="page", text=page_text, format="html"))
        for node in jsonld_nodes(page_text):
            # One document holds the blocks; the common case is a single one, and a
            # rule's path was read from the same flattening.
            bag.add(RuntimeDocument(name=JSONLD_DOCUMENT, text=json.dumps(node),
                                    format="json"))
            break
    for document in capture.of_format("json"):
        stable = (names or {}).get(document.name)
        if stable and stable != document.name:
            bag.add(RuntimeDocument(name=stable, text=document.text, format="json"))
        bag.add(RuntimeDocument(name=document.name, text=document.text, format="json"))
    for document in capture.of_format("script"):
        if parse_loose(document.text) is None:
            # Not JSON, so no `json` selector can read it — which is the same reason
            # a positional literal carries no rule.
            continue
        bag.add(RuntimeDocument(name=document.name, text=document.text, format="json"))
    return bag


def read_rule(rule: dict[str, Any], capture: Capture,
              names: dict[str, str] | None = None) -> Any:
    """Resolve one rule against one capture, offline.

    The same call an adapter makes, minus the network: the capture has the documents
    already, so a rule can be checked without visiting the site again. A collection
    rule reads a list and returns it — the shape the record carries and the shape the
    annotation holds, so nothing has to convert between the two.
    """
    try:
        value = resolve(rule, capture_to_bag(capture, names),
                        context={"url": capture.final_url or capture.url})
    except Exception:  # noqa: BLE001 - a rule that cannot run reads nothing
        return None
    if value is None or value == "" or value == []:
        return None
    return value


def _reads_the_annotation(rule: dict[str, Any], candidate: Candidate, expected: Any,
                          reference: Sample, field: str) -> dict[str, Any] | None:
    """The candidate's own rule that reproduces the annotated value, or no usable rule.

    Measured on iwara (2026-10-11): a picture offered at two sizes is one candidate (`merge_image_variants`),
    so the cover candidate held both the page's `og:image` — the *thumbnail* variant — and the picture
    the person picked, the *original*. Ranking picked the meta rule, the confirm page proposed the
    thumbnail, and accepting it made the two pages disagree permanently. Measuring instead of ranking is
    what the rest of this file does; this is the proposal path doing the same.
    """
    names = reference.document_names
    for alternative in [rule, *(source.rule for source in candidate.sources)]:
        if not alternative or alternative.get("conflict"):
            continue
        measured = _with_field_limit(_with_split(alternative, field,
                                                 reference.annotated.get(field)), field)
        if same_members(expected, read_rule(measured, reference.capture, names)):
            return measured
    return None


def assembled_rule(samples: list[Sample], field: str) -> dict[str, Any] | None:
    """A field's value as an address written over the JSON fields that make it up.

    Some sites never publish the address they mean: iwara's cover is
    `//i.iwara.tv/image/thumbnail/<file id>/thumbnail-05.jpg` while its own API holds only the pieces
    (`file.id`, a `thumbnail` index), so no rule could read it and the cover came out empty.

    **One page cannot derive this, and two attempts from one page proved it** (2026-10-11): the strict
    one left the varying index as a literal, so every work read the first work's picture; loosened, it
    templated digits out of unrelated fields (`{exchangeLimit.USD:02d}` inside a file id). Several works
    can derive it, the way the request recipes are derived: a part becomes a placeholder only when
    the same JSON path differs with it on **every** work, and the runtime can rebuild every complete
    address afterward. That condition is what makes this a measurement: a `limit: 1` that happens to
    match one address cannot match them all, and a shared first character cannot be mistaken for the
    boundary between the literal URL and a field value.

    Returns None when nothing can be derived — a site whose address is not made of its own fields.
    """
    values = [sample.annotated.get(field) for sample in samples]
    if len(values) < 2 or any(not isinstance(value, str) or not value for value in values):
        return None

    first = samples[0]
    payloads = [parse_loose(document.text) for document in first.capture.of_format("json")]
    for document, payload in zip(first.capture.of_format("json"), payloads):
        if payload is None:
            continue
        # A response is the request it answers, not the position in which it arrived. Measured on
        # iwara (2026-10-11), the subject API was `network:4` on one work and `network:2` on the next;
        # matching those literals made an otherwise valid cover template disappear. The same stable
        # request names already used by ordinary JSON rules make the two documents the same here too.
        document_name = first.document_names.get(document.name, document.name)
        others: list[Any] = []
        for sample in samples[1:]:
            matching = [other_document for other_document in sample.capture.of_format("json")
                        if sample.document_names.get(other_document.name, other_document.name)
                        == document_name]
            if len(matching) != 1:
                break
            other_payload = parse_loose(matching[0].text)
            if other_payload is None:
                break
            others.append(other_payload)
        if len(others) != len(samples) - 1:
            continue
        every = [payload, *others]
        scalar = [(path, value) for path, value in flatten_json(payload)
                  if isinstance(value, (str, int, float)) and not isinstance(value, bool)]
        used: list[tuple[str, str]] = []
        template = values[0]
        for path, value in sorted(scalar, key=lambda item: -len(str(item[1]))):
            # The same path has to exist in every work's own copy of this document.
            if any(json_path(other, path) is None for other in others):
                continue
            other_values = [json_path(other, path) for other in others]
            # A field is evidence only when it follows the work. Without this gate a site-wide
            # constant can become part of the address: an earlier paired attempt turned the literal
            # host `i.iwara.tv` into `i.{sites[0].id}.tv` because every response said `iwara`.
            if len({str(value), *(str(other) for other in other_values)}) < 2:
                continue
            if isinstance(value, str):
                if not _whole_token(template, value):
                    continue
                if not all(_whole_token(address, str(other_value))
                           for address, other_value in zip(values[1:], other_values)):
                    continue
                template = template.replace(value, "{" + path + "}")
                used.append(("{" + path + "}", path))
                continue
            # A number is written out by the address, and only a number that *follows the work*
            # proves itself: iwara's `thumbnail` is 5 on one work and 12 on the next while its image
            # reads `…-05.jpg` and `…-12.jpg`. A field that is the same on every work (`limit: 1`)
            # would also match a digit run somewhere, and would then put a constant into an address
            # that varies — so the value must differ between the works for this to be that field.
            if int(value) < 0 or any(not isinstance(other, (int, float))
                                     for other in other_values):
                continue
            # The width is how *the addresses* write it — `5` reads `05` — so it comes from the digit
            # runs themselves, on every work, and has to be the same width everywhere for one
            # template to spell them all. Only whole numeric tokens count: the first `5` in iwara's
            # UUID is not its thumbnail index, while the `05` after `thumbnail-` is.
            runs: list[str] = []
            for index, (payload_or_document, address) in enumerate(zip(every, values)):
                want = json_path(payload_or_document, path)
                text = template if index == 0 else address
                matches = [match.group() for match in re.finditer(r"\d+", text)
                           if int(match.group()) == int(want)
                           and not (text[match.start() - 1:match.start()].isalnum()
                                   or text[match.end():match.end() + 1].isalnum())]
                if len(matches) != 1:
                    break
                runs.append(matches[0])
            else:
                widths = {len(run) for run in runs}
                if len(widths) != 1 or not _whole_token(template, runs[0]):
                    continue
                width = widths.pop()
                placeholder = f"{{{path}:0{width}d}}" if width > len(str(value)) \
                    else "{" + path + "}"
                template = template.replace(runs[0], placeholder)
                used.append((placeholder, path))
        if not used:
            continue
        # The runtime's own reader has to reproduce every work's address from its own document: the
        # same call the crawl makes, so nothing here can pass that the crawl would not.
        rule = {"from": "json_template", "document": document_name,
                "template": template}
        if all(_read_template(rule, payload_or_document) == written
               for payload_or_document, written in zip(every, values)):
            return rule
    return None


def _read_template(rule: dict[str, Any], payload: Any) -> str | None:
    """What the runtime's own `json_template` reader makes of this rule and this document."""
    return _assemble(payload, rule)


def _whole_token(text: str, part: str) -> bool:
    """Whether `part` occurs in `text` as a whole token — nothing alphanumeric touching it."""
    if not part:
        return False
    start = text.find(part)
    if start < 0 or text.find(part, start + 1) >= 0:
        return False
    before = text[start - 1] if start > 0 else ""
    after = text[start + len(part)] if start + len(part) < len(text) else ""
    return not before.isalnum() and not after.isalnum()


def _field_candidates(reference: Sample, field: str, expected: Any) -> list[Any]:
    candidates = list(reference.harvest.candidates)
    if field not in ("date", "date_added"):
        return candidates
    meaning = reference.date_kinds.get(field)
    picked = next((candidate for candidate in candidates
                   if candidate.candidate_id == reference.picks.get(field)
                   and _is_what_was_annotated(expected, candidate.value, field)), None)
    meaning = meaning or (picked.context.get("date_kind") if picked else None)
    return ([candidate for candidate in candidates if candidate.context.get("date_kind") == meaning]
            if meaning else candidates)


def apply_to(references: Sample | Iterable[Sample], capture: Capture) -> dict[str, dict[str, Any]]:
    """The samples' hypotheses, applied to a page that was never annotated.

    This is the plan's Example 2: the tool proposes, and the person only confirms.
    Each field carries the value the rule read and the rule that read it, so the page
    can show the value and the server can record the rule without asking for the
    choice again. A field whose rule reads nothing is kept as `None` rather than
    dropped — a rule that fails on the second page is a finding, not an absence.

    Every sample answered so far is consulted and the first answer for a field wins,
    because a work is not required to carry every field: measured in a real session, the
    first work had no 登場人物 and no 系列, the person filled them in on the second, and the
    third page was offered nothing at all for either.
    """
    if isinstance(references, Sample):
        references = [references]
    references = list(references)
    # The pages' recorded responses are named by their request on both sides of this call: the rule
    # says which request it reads, and the page being proposed to has to offer it under the same name.
    index = key_index([(reference.url, reference.capture) for reference in references])
    for reference in references:
        reference.document_names = network_names(reference.url, reference.capture,
                                                key_at(reference.url, index))
    target_names = network_names(capture.final_url or capture.url, capture,
                                key_at(capture.final_url or capture.url, index))
    answers: dict[str, tuple[Sample, Any]] = {}
    for reference in references:
        for field, expected in reference.annotated.items():
            answers.setdefault(field, (reference, expected))
    applied: dict[str, dict[str, Any]] = {}
    for field, (reference, expected) in answers.items():
        expected = answer_members(field, expected)
        candidates = _field_candidates(reference, field, expected)
        picked = reference.picks.get(field)
        if picked:
            # The person's own click first. Two fields can carry the same word — a work's title and
            # the character named after it — and matching by value then proposes one field with
            # another field's rule; the session records which candidate was clicked, so use it.
            clicked = next((c for c in candidates if c.candidate_id == picked), None)
            if clicked is not None and _is_what_was_annotated(expected, clicked.value, field):
                candidates = [clicked]
        for candidate in candidates:
            if not _is_what_was_annotated(expected, candidate.value, field):
                continue
            rule = rule_for(candidate)
            if rule is None:
                continue
            # …but the candidate may carry several rules for one value, and the ranking is not a
            # measurement: measured on iwara (2026-10-11), the cover candidate carried both the page's
            # `og:image` (the thumbnail variant) and the picture the person actually picked (the
            # original, merged into it as the same picture at another size). The ranking chose the
            # meta rule, so the confirm page proposed a *different image* than the one being confirmed
            # — and the person, accepting it, made the two pages disagree for good. The rule that
            # reproduces the annotated value on the page it was annotated from is the one to propose.
            rule = _reads_the_annotation(rule, candidate, expected, reference, field)
            if rule is None:
                continue
            # The value is read with the very rule that gets recorded, cap included. Reading it with
            # the uncapped one proposed nineteen pictures while the rule beside them said three, and
            # the page records what it is shown: the two halves then disagreed, and the field was
            # pruned over a difference that only ever existed between them.
            rule = named_document(_with_field_limit(rule, field), reference.document_names)
            applied[field] = {"value": read_rule(rule, capture, target_names), "rule": rule}
            if field in ("date", "date_added") and candidate.context.get("date_kind"):
                applied[field]["date_kind"] = candidate.context["date_kind"]
            break
    return applied


def load_session(directory: Path, name: str | None = None) -> Sample:
    """Replay one recorded session, with whatever annotation it holds."""
    capture = Capture.read(directory / "capture.json")
    from .harvest import harvest

    result = harvest(capture)
    annotated: dict[str, Any] = {}
    annotations = directory / "annotations.json"
    if annotations.is_file():
        payload = json.loads(annotations.read_text(encoding="utf-8"))
        # `fields` holds the value a person accepted. A collection's value is the list
        # of its members and stays a list; an older file held a candidate id where the
        # value belongs, and that form is still understood rather than silently reading
        # as "nothing was annotated".
        by_id = {candidate.candidate_id: candidate.value
                 for candidate in result.candidates}
        for key, recorded in (payload.get("fields") or {}).items():
            if isinstance(recorded, (list, tuple)):
                annotated[key] = [str(member) for member in recorded]
                continue
            text = str(recorded)
            annotated[key] = by_id.get(text, text)
        explicitly_absent = {str(name) for name in (payload.get("absent") or [])}
        picks = {str(field): str(candidate)
                 for field, candidate in (payload.get("picks") or {}).items()}
        date_kinds = {str(field): hypothesis["date_kind"]
                      for field, hypothesis in (payload.get("hypotheses") or {}).items()
                      if isinstance(hypothesis, dict)
                      and hypothesis.get("date_kind") in ("published", "updated", "created", "unknown")}
    else:
        explicitly_absent = set()
        picks = {}
        date_kinds = {}
    return Sample(name=name or directory.name, capture=capture, harvest=result,
                  annotated=annotated, absent=explicitly_absent, picks=picks, date_kinds=date_kinds)


def learn(samples: list[Sample],
          fields: tuple[tuple[str, str, str], ...] = FIELDS) -> Learning:
    """Every hypothesis the first sample offers, judged by all the samples.

    `fields` is the vocabulary the annotation was keyed by: a work's, or a listing card's
    (`source_id`, `title`, `cover_url`, …) — the same machinery, told which field names to
    look for.
    """
    if not samples:
        return Learning(fields=[], notes=["no samples given"])

    # Every sample names its recorded responses by the request they answer, once the set can say
    # which part of the address is the work's id. Nothing is renamed when it cannot.
    named = network_documents(samples)
    for sample in samples:
        sample.document_names = named["names"].get(sample.name, {})

    annotated = samples[0].annotated
    notes: list[str] = []
    if not annotated:
        notes.append(f"{samples[0].name} carries no annotation, so there is nothing to learn")
    if len(samples) < 2:
        notes.append("only one sample, so no hypothesis can be checked against another page "
                     "and none of them is a rule yet")

    reports: list[FieldReport] = []
    for field, kind, _label in fields:
        # Whichever sample answered this field is the one that offers hypotheses. It used
        # to be the first sample for every field, which meant a field the first work
        # happened not to carry was never learned at all: measured in a real session whose
        # first work had no 登場人物 and no 系列 and whose second had both, the person
        # filled them in on the second page and the third was offered nothing.
        source = next((sample for sample in samples
                       if sample.annotated.get(field) is not None), None)
        if source is None:
            continue
        answer = source.annotated[field]
        expected = answer_members(field, answer)
        hypotheses: list[Hypothesis] = []
        seen: set[str] = set()
        for candidate in _field_candidates(source, field, expected):
            if not _is_what_was_annotated(expected, candidate.value, field):
                continue
            # Every source that carries a rule is its own hypothesis. The plan's
            # §13.2 keeps several per field rather than choosing one at Example 1,
            # because one page cannot say which of them will survive the next: the
            # same title arrives in `og:title` and in the `h1`, and only another page
            # decides between them.
            for rule_source in candidate.sources:
                rule = rule_source.rule
                if not rule:
                    continue
                # A rule naming a recorded response says *which request* it is, not where that
                # response sat in the log — otherwise it reads a different response on the next page.
                rule = named_document(rule, source.document_names)
                key = json.dumps(rule, sort_keys=True)
                if key in seen:
                    continue
                seen.add(key)
                hypotheses.append(Hypothesis(
                    rule=_with_field_limit(_with_split(rule, field, answer), field),
                    from_candidate=candidate.candidate_id,
                    sources=[rule_source.channel],
                ))
        # A value no rule could read may still be an address its own fields make up — the cover of a
        # site that publishes only the pieces. Offered *beside* whatever the page offered, not only
        # when the page offered nothing: measured on iwara (2026-10-11), the page's own rule for the
        # cover reads a browser artifact (`div.vjs-poster`'s painted background), which the *served*
        # page does not have at all, so it is pruned and the field would be left empty — while the
        # address assembled from the API is exactly what both works agree on.
        assembled = assembled_rule(samples, field)
        if assembled is not None:
            hypotheses.append(Hypothesis(rule=_with_field_limit(assembled, field),
                                         from_candidate="", sources=["network"]))
        if not hypotheses:
            notes.append(f"{field}: no candidate for {_short(expected)[:40]} carries a usable rule")
            continue
        for hypothesis in hypotheses:
            hypothesis.readings = [
                _read(hypothesis.rule, field, sample, is_source=sample is source)
                for sample in samples
            ]
        reports.append(FieldReport(field=field, kind=kind, hypotheses=hypotheses))
    return Learning(fields=reports, notes=notes)


def learn_for_runtime(samples: list[Sample], *, browser_capture: bool = False) -> Learning:
    """Select the reader that preserves the annotated fields, using both recorded representations.

    Prefer HTTP when it can reproduce the annotations. A browser-only field must not be
    pruned merely because the served page has not rendered it. Change the declared reader
    only when the rendered samples recover that field without losing the HTTP fields.
    """
    http_learning = learn(samples)
    if not browser_capture:
        return http_learning
    if not any(sample.served is not None for sample in samples):
        http_learning.acquisition = "browser"
        http_learning.notes.append("runtime uses the browser-rendered page; "
                                   "no served sample was available to verify HTTP")
        return http_learning
    rendered = learn([replace(sample, served=None) for sample in samples])
    http_fields = set(http_learning.chosen_rules())
    rendered_fields = set(rendered.chosen_rules())
    if rendered_fields - http_fields and http_fields <= rendered_fields:
        rendered.acquisition = "browser"
        recovered = ", ".join(sorted(rendered_fields - http_fields))
        rendered.notes.append("runtime uses the browser-rendered page"
                              + (f" to preserve annotated fields: {recovered}" if recovered else
                                 "; no served sample was available to verify HTTP"))
        return rendered
    return http_learning


def _read(rule: dict[str, Any], field: str, sample: Sample, *,
          is_source: bool = False) -> Reading:
    """Resolve one rule on one sample, and compare with what was expected there.

    The address is passed as context because `absolute` in a rule means "resolve
    against the page", and without it a cover rule reads the relative path the
    markup wrote rather than the address it points at.
    """
    try:
        value = resolve(rule, sample.bag(), context={"url": sample.url})
    except Exception as error:  # noqa: BLE001 - a rule that cannot run is a result
        value = None
        sample_error = f"{type(error).__name__}: {str(error)[:60]}"
    else:
        sample_error = ""
    # A list stays a list: it is what the annotation holds for a collection and what the
    # record carries, and `str(list)` is a repr that compares equal to nothing.
    if value is None:
        text: Any = None
    elif isinstance(value, (list, tuple)):
        text = [str(member) for member in value]
    else:
        text = str(value)
    reading = Reading(sample=sample.name, value=text,
                      # The same members the hypothesis side compares: what a person marked at a
                      # tags row is the members, however the page wrote them, and a rule that read
                      # `a / b / c` off a page whose row says `a b c` read the field correctly.
                      expected=answer_members(field, sample.annotated.get(field)), source=is_source,
                      absent=field in sample.absent)
    if sample_error:
        reading.value = None
    return reading


def site_authority(urls: list[str]) -> str | None:
    """`host:port` when the addresses agree on one, the bare host when they only share that.

    `urlparse(...).hostname` drops the port, and a site served on a port is not the same
    address as one behind 443: measured on a mock site at `127.0.0.1:8811` (2026-10-03), whose
    derived pattern came out `^https?://127\\.0\\.0\\.1/work/…` and matched none of the three
    addresses it was learned from — so the install was refused, for the right reason and from
    the wrong cause. Netloc is used as written, which also keeps an explicit `:80` working.
    """
    parsed = [urlparse(url) for url in urls]
    authorities = {item.netloc for item in parsed if item.netloc}
    if len(authorities) == 1:
        return next(iter(authorities))
    hosts = {item.hostname for item in parsed}
    return next(iter(hosts)) if len(hosts) == 1 else None


def request_shape(url: str, identifier: str) -> str:
    """The response's request with the work's own id templated, scheme stripped.

    `https://api.iwara.tv/video/bCiZIXUeR4tLq5` becomes `api.iwara.tv/video/{id}` — the same string
    on every work of the site, which is what makes it usable as a document's name.
    """
    return url.split("://", 1)[-1].replace(identifier, "{id}")


def network_names(url: str, capture: Capture, identifier: str | None) -> dict[str, str]:
    """One page's recorded responses, named by the request each answers.

    `identifier` is the work's key as the site's own requests spell it (`api_identifier`) — measured
    from the captured responses, so this works from a single page as well as from a set: the pattern
    below can only say which segment varies when there are two addresses to compare.
    """
    if not identifier:
        return {}
    names: dict[str, str] = {}
    for document in capture.of_format("json"):
        source = document.source_url or ""
        if identifier in source:
            names[document.name] = f"network:{request_shape(source, identifier)}"
    return names


def network_documents(samples: list[Sample]) -> dict[str, Any]:
    """Name each recorded response by the request it answers, not by the order it arrived in.

    A response is recorded as `network:4` — its place among the responses — and that place is not the
    same on the next page: measured on iwara (2026-10-10), `network:4` was `api.iwara.tv/video/<id>`
    on one page and `api.iwara.tv/page/sitewide-announcement` on the next, so the title rule learned
    from the first read the site's own announcement banner, and every API-backed field was pruned
    because its rule read a different response on the second page.

    The one part of a response's address that belongs to *this* work is the id the target's own
    address carries, and the pattern these samples already derive is what says which part that is —
    so nothing here is guessed. Returns:

    * `names`: {sample name: {positional document name: stable name}} — empty when the samples share
      no derivable id, in which case nothing is renamed and every rule reads what it read before;
    * `recipes`: {stable name: the request to fetch it with} — the runtime's own recipe shape, which
      is what lets an adapter read these fields at all (execution log §731).
    """
    pages = [(sample.url, sample.capture) for sample in samples]
    identifier = api_identifier(pages)
    index = key_index(pages)
    pattern = url_pattern_for(samples, identifier)
    names: dict[str, dict[str, str]] = {}
    recipes: dict[str, str] = {}
    for sample in samples:
        own = key_at(sample.url, index)
        found = network_names(sample.url, sample.capture, own)
        names[sample.name] = found
        if not own:
            continue
        for document in sample.capture.of_format("json"):
            stable = found.get(document.name)
            if stable:
                recipes[stable] = (document.source_url or "").replace(own, "{id}")
    return {"names": names, "recipes": recipes}


def named_document(rule: dict[str, Any], names: dict[str, str]) -> dict[str, Any]:
    """The rule with a recorded response named by its request, when the sample set can say so."""
    stable = names.get(str(rule.get("document") or ""))
    return {**rule, "document": stable} if stable else rule


def key_index(pages: list[tuple[str, Capture]]) -> int | None:
    """Which step of the work's address is the key the site's own requests repeat.

    A work page's address often carries two varying segments — iwara's is
    `/video/bCiZIXUeR4tLq5/mornye`, a key and a slug — and the pattern below takes the last one, which
    is the right answer for a *name* and the wrong one for an API: measured 2026-10-10,
    `api.iwara.tv/video/mornye` answers 404 while `api.iwara.tv/video/bCiZIXUeR4tLq5` answers 200.

    So the key's *position* is read off the site's own requests: a page-path step that some recorded
    response repeats as a path segment, in at least two of them. A segment that *leads* a response's
    path is the API's own shape (`/video/…`), not the work's key, and is not counted. The *value* at
    that position differs from work to work, so only the position is shared — each page reads its own.
    """
    if not pages:
        return None
    page = [part for part in urlparse(pages[0][0]).path.split("/") if part]
    if not page:
        return None
    counts: dict[str, int] = {}
    for _url, capture in pages:
        for document in capture.of_format("json"):
            parts = [part for part in urlparse(document.source_url or "").path.split("/") if part]
            for part in set(parts[1:]):
                if part in page:
                    counts[part] = counts.get(part, 0) + 1
    if not counts:
        return None
    best = max(counts, key=lambda part: (counts[part], -page.index(part)))
    return page.index(best) if counts[best] > 1 else None


def key_at(url: str, index: int | None) -> str | None:
    """The work's key as *this* address spells it, given the step it sits at."""
    parts = [part for part in urlparse(url).path.split("/") if part]
    return parts[index] if index is not None and index < len(parts) else None


def api_identifier(pages: list[tuple[str, Capture]]) -> str | None:
    """The key as the first page spells it — the evidence the target pattern is asked to capture."""
    return key_at(pages[0][0], key_index(pages)) if pages else None


def url_pattern_for(samples: list[Sample], prefer: str | None = None) -> str | None:
    """The loosest pattern that still matches every sample.

    The differing path segments become `[^/]+` and the common ones stay, so the
    pattern is derived from the addresses rather than guessed at. `None` when the
    samples do not share a host, which is a finding rather than a failure.
    """
    parsed = [urlparse(sample.url) for sample in samples]
    host = site_authority([sample.url for sample in samples])
    if host is None:
        return None
    # The leading slash splits into an empty first segment, which would otherwise
    # become a step of its own and put a `//` in the middle of the pattern.
    paths = [[part for part in item.path.split("/") if part] for item in parsed]
    if len({len(parts) for parts in paths}) != 1:
        return rf"^https?://{re.escape(host)}/"
    if not paths[0]:
        # An address with no path at all (`https://site.test/`) — a listing card's own page, and the
        # host is the whole of what can be said about it. Without this the step below indexes an
        # empty list: measured by running the listing tests with a session recorded at a bare origin.
        return rf"^https?://{re.escape(host)}/"
    steps = []
    for index in range(len(paths[0])):
        column = {parts[index] for parts in paths}
        steps.append(re.escape(next(iter(column))) if len(column) == 1 else "[^/]+")
    # The last step that varies has to *capture*: the registry reads a target's id out
    # of the pattern's groups, and a pattern of non-capturing steps matches the URL and
    # still reports that no site claims it — which reads as "unknown site", not as
    # "your pattern forgot a group".
    #
    # **What it captures is the number, when that is what the addresses carry.** Measured on a real
    # site whose works are `/novel/4525.html`: capturing the whole segment made every id carry the
    # site's own extension (`4525.html`), while the listing half of the same adapter — which narrows
    # the card's link to the digits — called that same work `4525`. One work with two ids is how the
    # two doors came to disagree about what they had already seen, and the id is an internal name
    # (it shapes the export directory and every media id) that only has to tell one work from another
    # *within one site*. Same doctrine as the card side's `card_rule_for_id`: the **last** number,
    # because a work address carries its own title — measured on a real gallery whose links read
    # `…-日本語-4201383`, where the first number belongs to the title and only the trailing one is the
    # work's. The tail after the digits stays optional and the whole step is anchored at the end, so a
    # site that drops its extension, or adds a query, still matches.
    varying = [index for index, step in enumerate(steps) if step == "[^/]+"]
    # `prefer` is the segment the site's *own API* repeats (`api_identifier`) — the work's key as the
    # requests spell it. It only moves the capture when it is one of the steps that actually varies,
    # so a caller that passes nothing, or a site with no API evidence, derives exactly the pattern it
    # derived before.
    chosen = (paths[0].index(prefer)
              if prefer and prefer in paths[0] and paths[0].index(prefer) in varying
              else max(varying, default=len(steps) - 1))
    capture = (_identity_capture([parts[chosen] for parts in paths]) if varying
               else f"({steps[chosen]})")
    rendered = "".join(
        f"/{capture}" if index == chosen else f"(?:/{step})"
        for index, step in enumerate(steps))
    return rf"^https?://{re.escape(host)}" + rendered


def _identity_capture(values: list[str]) -> str:
    """The capture for the step that carries a work's identity, as the samples spell it.

    The number if every sample holds one there (with the same text after it, so the digits really are
    the identity and the tail is a decoration); the whole segment otherwise, which is what a slug-
    addressed site keeps getting until one of them is measured.
    """
    found = []
    for value in values:
        digits = list(re.finditer(r"\d+", value))
        if not digits:
            return "(?P<id>[^/]+)"
        last = digits[-1]
        found.append((value[:last.start()], value[last.end():]))
    tails = {tail for _head, tail in found}
    if len(tails) != 1:
        return "(?P<id>[^/]+)"
    heads = {head for head, _tail in found}
    if heads == {""}:
        head = ""
    elif len(heads) == 1:
        head = re.escape(next(iter(heads)))
    else:
        # A slug before the number: it differs on every work (it is the title), so it is not part of
        # the identity — matched loosely, with the end anchor below making the engine take the *last*
        # number rather than the first one it can reach.
        head = "[^/]*?"
    tail = next(iter(tails))
    # The anchor is what makes the engine take the **last** number rather than the first it can reach
    # (`…-abc-2025-title/` would otherwise report `2025`); it allows a path separator, a query, a
    # fragment or the end, because a work address may end `/novel/4525/`, `/novel/4525.html` or
    # `/novel/4525.html?page=2`.
    return f"{head}(?P<id>\\d+)" + (f"(?:{re.escape(tail)})?" if tail else "") + r"(?=[/?#]|$)"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.casefold()).strip("_") or "site"


# The annotation's field names are a person's words; the runtime has its own, and a
# `work.fields` key it does not recognise is silently dropped — measured on a real
# generated adapter, where `cover` was learned, verified and then never reached the
# record, and the export said `cover: null`.
FIELD_TO_RUNTIME = {
    "title": "title",
    "creator": "author",
    "date": "date_added",
    "cover": "cover_url",
    # The runtime reads the previews under the name its record uses, and the T³ importer
    # already turns `preview_images` into the Entry's previews — so the field is a list of
    # addresses on one side and a list of pictures on the other, with nothing in between.
    "preview": "preview_urls",
    "tags": "tags",
    "characters": "characters",
    "series": "works",
    # Free text has one home in the import: the Entry body, beside the source URL.
    # Nothing in the runtime consumes it, so it travels as a declared passthrough key
    # — and declaring it is what makes it travel at all.
    "description": "description",
}
PASSTHROUGH_FIELDS = ("description",)

# The fields whose value is the members it holds rather than one string.
COLLECTION_FIELDS = frozenset(key for key, kind, _label in FIELDS if kind == "collection")


def runtime_fields(learning: Learning) -> dict[str, dict[str, Any]]:
    """The learned rules, under the names the runtime reads them by."""
    mapped: dict[str, dict[str, Any]] = {}
    for field, rule in learning.chosen_rules().items():
        mapped[FIELD_TO_RUNTIME.get(field, field)] = rule
    return mapped


def draft_base(page_url: str) -> dict[str, Any]:
    """The parts of a draft that are the host's, whether the page is a work or a listing."""
    host = urlparse(page_url).hostname or "unknown"
    return {
        "schema_version": 1,
        "key": host,
        "display_name": host,
        "tool": _slug(host),
        "source_site": host,
        "export_group": host,
        "media_id_prefix": host,
        "hosts": [host],
    }


def draft_site_json(samples: list[Sample], learning: Learning) -> dict[str, Any]:
    """A draft `site.json`, and an honest note about what still needs a person.

    Everything it states is derived from the samples: the host, the target pattern,
    the documents the rules read, and the field rules themselves. What it cannot
    derive from one work page is named in `_draft.review` instead of invented.
    """
    host = urlparse(samples[0].url).hostname or "unknown"
    authority = site_authority([sample.url for sample in samples]) or host
    pattern = url_pattern_for(samples, api_identifier([(sample.url, sample.capture) for sample in samples]))
    # The hints live under `documents.work.<name>` — that is where `extract` reads
    # them — and `jsonld` has to be declared as JSON, or the runtime would treat the
    # page's structured data as HTML and a `json` rule would quietly read nothing.
    documents: dict[str, Any] = {"work": {"page": {"format": "html"}}}
    # A rule naming a recorded response is runnable once the draft declares the request that fetches
    # it: the runtime has always fetched documents by recipe (`declarative.request_documents`), and
    # the recipe is the response's own address with the work's id templated — the same string the
    # rule's document is named after (`network_documents`).
    recipes = network_documents(samples)["recipes"]
    unrunnable: list[str] = []
    for field_name, rule in learning.chosen_rules().items():
        # The fallbacks are rules too, and one of them may be the only one that reads a page whose
        # content arrives by JavaScript — so their documents need their recipes declared as well.
        for candidate_rule in [rule, *(rule.get("fallback") or [])]:
            document = str(candidate_rule.get("document") or "")
            if not document or document in ("page", "jsonld"):
                if document == "jsonld":
                    documents["work"]["jsonld"] = {"format": "json"}
                continue
            recipe = recipes.get(document)
            if recipe:
                documents["work"][document] = {"format": "json", "request": recipe,
                                               "from": "target"}
                continue
            unrunnable.append(
                f"{field_name} reads document {document!r}, which needs a request recipe")
    review = [
        "the target's other kinds (artist, listing, search) are not derived here",
        "the export manifest shape is not derived here",
        "field rules were learned from one kind of page; a listing page is Phase 7",
        *unrunnable,
    ]
    if pattern is None:
        review.append("the samples do not share a host, so no target pattern was derived")
    elif not all(re.search(pattern, sample.url) for sample in samples):
        review.append("the derived target pattern does not match every sample")
    return {
        **draft_base(samples[0].url),
        "targets": {
            "work": {"url_pattern": pattern or rf"^https?://{re.escape(authority)}/",
                     "label": "Work", "single": True},
        },
        "documents": documents,
        "work": {
            "acquisition": learning.acquisition,
            "fields": runtime_fields(learning),
            # A declared passthrough key is written into the record verbatim; without
            # the declaration the runtime drops the field it was learned for.
            "passthrough": [name for name in PASSTHROUGH_FIELDS
                            if name in runtime_fields(learning)],
        },
        "_draft": {"generated_from": [sample.name for sample in samples],
                   "review": review},
    }
