"""Phase 4: annotation — a person says which candidate is which field.

The plan's §13.1: the harvester offers candidates, and the person marks "which value
is what field". What makes that mechanical is that a candidate already carries the
rule which would read it again (`Source.rule`), so choosing a candidate *is*
choosing a rule. This module holds the field vocabulary, the mapping from an
annotation to rule hypotheses, and the page itself.

Two things it deliberately cannot do, both of which need the live page rather than
the harvested one:

* highlight the element on the real page;
* let a person pick an element the harvester never offered.

That is the picker the plan defers, and its absence has a consequence worth saying
out loud on the page itself: a value that is not in the list cannot be chosen here,
so the escape hatch is a manual rule or another channel — not a click.

Delivery is by POST to the local server, never by download: a session that ends in
a file landing in a browser's download folder is one the user has to move by hand,
and the plan's endpoint is a UI that runs the tool, which can receive it directly.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from urllib.parse import quote
from typing import Any, Iterable

from ..generic.select import split_members
from . import text as l10n
from .harvest import COLLECTION_JOIN, Candidate, Harvest, joined_value, same_members

# The fields and their shapes. A collection candidate marks its whole group once;
# selecting a single text candidate keeps that one member, including spaces in its name.
#
# `preview` is that same act applied to pictures: the field is many images, so it is
# marked once as a group (the harvester offers one candidate per repeated image rule)
# and the rule reads them all. A cover and a preview are chosen the same way; what
# differs is only what the import does with the answer.
#
# Free text has exactly one home in the import: the Entry's `body`, a content beside
# the source URL. `description` is offered because that home exists, and it is carried
# there as a declared passthrough key — see `learn.FIELD_TO_RUNTIME`. It is the only
# field here whose T³ side is not yet wired; the log records what T³ must add.
FIELDS: tuple[tuple[str, str, str], ...] = (
    ("title", "scalar", "作品标题"),
    ("creator", "multi", "作者 / 创作者"),
    ("date", "scalar", "日期"),
    ("description", "scalar", "简介"),
    ("cover", "image", "封面"),
    ("preview", "images", "预览图"),
    ("tags", "collection", "分类标签"),
    ("characters", "collection", "登场人物"),
    ("series", "collection", "作品系列"),
)

# The kinds that may hold several values. `collection` is always several; `multi` is one
# *or* several, decided by the person per work — a paper has six authors and a doujin has
# one, and the field is the same field. Which of the two it is decides only the default the
# page opens on (see `default_mode`).
MULTI_KINDS: tuple[str, ...] = ("collection", "multi")


def can_be_several(kind: str) -> bool:
    """Whether the page offers this field the one/many switch."""
    return kind in MULTI_KINDS


def default_mode(kind: str) -> str:
    """The switch's position when the page opens.

    A tag list is a list, so it opens on `many`; a creator usually is one name, so it opens
    on `one` — and a work with six authors is one click away from saying so.
    """
    return "many" if kind == "collection" else "one"


# How many members a field keeps, when the page offers more. A preview set is the case
# this exists for: the entry shows a cover and the pictures behind it, the stack shows four
# layers, and a work with twenty screenshots would otherwise import twenty pictures of
# which a person sees four. The cap is a property of the *field*, and it is applied to both
# halves — the value the page records and the `limit` the rule reads with — because a
# truncated annotation against a rule that reads everything is how a correct rule was
# pruned once already.
FIELD_LIMITS: dict[str, int] = {
    "preview": 3,
}

# Which candidate kind each field can take, so the page can narrow the list instead
# of making a person scroll past four hundred text values to find the cover.
ACCEPTS: dict[str, tuple[str, ...]] = {
    "scalar": ("text", "number", "url"),
    "image": ("image", "url"),
    "images": ("images",),
    "collection": ("text", "collection"),
    # One or several: a single name is picked as itself, and a page that writes the authors
    # as one block offers that block too.
    "multi": ("text", "number", "url", "collection"),
}

# What each field is asking for, in the words of the page rather than the schema's. Shown
# under the field's name, because the names alone are not enough: measured on a real run,
# `作品 id` was left unmarked — nothing said that the answer is the card's *link* — and a
# listing card with no id is dropped by the runtime, so the whole listing read zero cards.
# The usage tips the annotation page shows in place of its log notes (the C specification:
     # the harvest's own diagnostics are log material, not guidance). One list, so the page and any
     # future surface teach the same three.
USAGE_TIPS: tuple[str, ...] = (
    "保持原网页打开，多复制粘贴：直接复制原网页的内容（作者名、标题、tag），"
    "在搜索框里搜索，就会弹出相应的内容，选择最匹配的。",
    "核心原则：选择最匹配的信息！适配器会打分给出最可能的候选，但最匹配的才是重要的。"
    "\"$作者S$\"、\"123标题456\" 这类像代码的值可能被打高分，"
    "但只要纯净的字段显示在网页上，适配器就一定抓得到——一定要找最匹配的！",
    "多字段组合：适配器可能同时抓到 \"作者S，作者H\" 和分开的 \"作者S\"、\"作者H\"，"
    "要选择包含最多的选项。tag 也是如此。",
)

FIELD_HINTS: dict[str, str] = {
    # a work's page
    "title": "点页面上的作品标题",
    # The one field that is genuinely one-or-several, so the hint has to teach both: a page
    # that shows one author per block has no group to point at, and a page that shows one
    # name at a time is exactly where a person was left with a single imported author.
    "creator": "点作者 / 创作者的名字；这个作品有多个作者时，切到「多个」把他们一个个点选进来",
    "date": "点发布日期",
    "description": "点简介正文（会作为条目正文导入）",
    "cover": "点封面图，或它在页面上的图片地址",
    "preview": "点整组预览图那一项（images 类型，右侧写着有几张；只保留前 "
               f"{FIELD_LIMITS['preview']} 张，本作品没有预览图就不用点）",
    "tags": "点一个分类标签，或整段标签（多位值会自动按逗号 / 空格拆开）",
    "characters": "点一个登场人物，或整段人物（同上，会拆成多位）",
    "series": "点作品系列 / 所属作品",
    # a listing card
    "source_id": "必填：点这张卡上通往作品的链接，编号会从链接里取出来",
    "cover_url": "点卡片上的封面图",
    "date_added": "点卡片上的日期；列表页常常不显示日期，没有就留空",
    "author": "点卡片上的作者 / 社团",
}


# The same shape for a listing's card, under the names the runtime already reads from a
# row (`source_id`, `title`, `cover_url`). Using the runtime's own names is deliberate: a
# listing rule that comes out of this then has no translation step, which is what lets the
# existing review and selection pages consume a generated listing unchanged.
LISTING_FIELDS: tuple[tuple[str, str, str], ...] = (
    ("source_id", "scalar", "作品 id"),
    ("title", "scalar", "标题"),
    ("cover_url", "image", "封面"),
    ("date_added", "scalar", "日期"),
    ("author", "scalar", "作者"),
)


def fields_for(kind: str) -> list[tuple[str, str, str]]:
    return [field for field in FIELDS if field[1] == kind]


def rule_for(candidate: Candidate, kind: str | None = None) -> dict[str, Any] | None:
    """The rule that would read this value again, from whichever source has one.

    A later source is preferred when it is a structured one: an API path survives a
    redesign that a class name does not.
    """
    # Prefer a rule the runtime can actually run, then a structured source, then a rule whose
    # matches all read the same value, then the rule that names fewest elements: a rule that
    # matches forty siblings reads the first of them — unless it was *measured* to read
    # different values at its matches, in which case it is offered last however few they are.
    #
    # A rule naming a *captured response* (`network:4`) cannot run at all until a request recipe
    # exists for it, which the builder does not derive yet (execution log §731). So it must not
    # win over a rule that can: measured on iwara (2026-10-10) the title had a page rule reading
    # exactly one element and the tool still preferred the API path — and because a response is
    # named by its capture *order*, the same name is a different response on the next page, so the
    # confirm page proposed the site's own announcement banner as the work's title.
    #
    # At equal matches, the rule that says *which* of them wins. That is what `index` is for, and
    # without this the proposal path ignored it: measured on buondua (2026-10-10), the annotation
    # held the set's second picture while the confirm page proposed the first — the person accepted
    # the proposal, the two pages then disagreed, and the cover was pruned for good even though a
    # rule that read exactly the annotated picture was sitting right there.
    if kind is not None and candidate.kind not in ACCEPTS.get(kind, ()):
        return None
    ranked = sorted(candidate.sources,
                    key=lambda source: (_needs_a_recipe(source.rule),
                                        source.channel == "markup",
                                        (source.rule or {}).get("matches", 1),
                                        0 if "index" in (source.rule or {}) else 1))
    for source in ranked:
        rule = source.rule
        if not rule:
            continue
        if kind in ("scalar", "image") and rule.get("list"):
            continue
        if rule.get("conflict"):
            # Measured on the page it came from to read a different value at one of the
            # elements it matches. Proposing it is how 登場人物 came to be filled with the
            # works block (`原神`) on every following page — the field is better left
            # unproposed than proposed with another field's value.
            continue
        return rule
    return None


def _needs_a_recipe(rule: dict[str, Any] | None) -> int:
    """1 when the rule names a captured response, which nothing can fetch yet — else 0.

    A `network:N` document is one the capture recorded, named by its *order* among the responses.
    The runtime fetches such a document by a request recipe, and the builder derives none (execution
    log §731), so the rule reads nothing wherever it is installed — while the same name on another
    page is a different response entirely.
    """
    document = str((rule or {}).get("document") or "")
    return 1 if document.startswith("network:") else 0


def picked_ids(picks: dict[str, Any] | None, field: str) -> list[str]:
    """The candidates clicked for one field: one id, or the ids of several picks.

    The page sends a bare id for a field answered with a single value, and a list when the
    person used the switch's 「多个」 — the same payload, read the same way, so an older
    annotation (which could only ever hold one) keeps loading unchanged.
    """
    value = (picks or {}).get(field)
    if value is None or value == "":
        return []
    return [str(item) for item in (value if isinstance(value, (list, tuple)) else [value]) if str(item)]


def _selectors_of(rule: dict[str, Any]) -> list[str]:
    select = rule.get("select") or rule.get("selector")
    return [str(item) for item in (select if isinstance(select, list) else [select]) if item]


def _set_readings(candidate: Candidate) -> list[dict[str, Any]]:
    """The rules this candidate already carries that read a whole *set*.

    A candidate for one author's name carries the single-value rule that read it and, when
    its selector matched the author's siblings too, the list rule that reads all of them.
    That second rule is what an answer of several values needs — and it is already
    measured, because the harvest counted what it matches on this page.
    """
    found: list[dict[str, Any]] = []
    for source in candidate.sources:
        rule = source.rule or {}
        if not rule.get("list") or rule.get("conflict"):
            continue
        selectors = _selectors_of(rule)
        if not selectors:
            continue
        found.append({**rule, "select": selectors[0], "list": True})
    return found


def _reads_the_set(rule: dict[str, Any], read: Any, wanted: list[str]) -> bool:
    """Whether the rule reads every value the person picked — it may read more.

    Reading it with the runtime that will execute it is the only way to know: the selector
    a page needs is not always the one the candidate list showed. More is allowed on
    purpose: a person naming three of a page's five authors means the other two as well,
    and a rule that named exactly those three by position would not survive the next page.
    """
    value = read(rule)
    if value is None or value == "":
        return False
    members = [str(member) for member in (value if isinstance(value, list) else [value])]
    return all(any(member == name for member in members) for name in wanted)


def rule_for_many(selected: list[Candidate], read: Any) -> dict[str, Any] | None:
    """One rule for a field answered by clicking several values one at a time.

    Some pages offer no group to click — every author sits in its own block, and the
    annotation could only ever say one of them. Picking several says "this field's answer
    is these", and what the field needs is one rule that reads the set.

    Two ways, both checked against the page before they are offered: the picks may already
    know a shared way of reading the set (the list rule the harvest measured on their
    selector), or their own selectors may be unioned into one rule — a `select` list is
    what the runtime uses for a set with no common parent.
    """
    if not selected or read is None:
        return None
    wanted = [candidate.value for candidate in selected]
    readings = [_set_readings(candidate) for candidate in selected]
    if any(not rules for rules in readings):
        return None

    # The same way of reading the set, offered by every pick: measured on each of them.
    def key(rule: dict[str, Any]) -> tuple[str, str]:
        return (str(rule.get("document") or ""), str(rule.get("select") or ""))

    shared = readings[0]
    for rules in readings[1:]:
        offered = {key(rule) for rule in rules}
        shared = [rule for rule in shared if key(rule) in offered]
    for rule in shared:
        if _reads_the_set(rule, read, wanted):
            return rule

    # Otherwise the picks' own selectors, unioned — which is how several separately-located
    # items are read when they share no parent to name.
    document = str(readings[0][0].get("document") or "")
    union: list[str] = []
    for rules in readings:
        for rule in rules:
            if str(rule.get("document") or "") != document:
                return None
            for selector in _selectors_of(rule):
                if selector not in union:
                    union.append(selector)
    if len(union) < 2:
        return None
    combined: dict[str, Any] = {"from": "html", "document": document, "select": union, "list": True}
    return combined if _reads_the_set(combined, read, wanted) else None


def capture_reader(capture: Any) -> Any:
    """Read one rule against one capture, with the runtime that will execute it.

    Imported here rather than at the top: `learn` imports this module, and a rule is only
    worth offering once it has been read the way the installed adapter will read it.
    """
    from .learn import read_rule       # noqa: PLC0415 - the import would be circular above

    return lambda rule: read_rule(rule, capture)


def validate_choices(annotation: dict[str, Any], harvest: Harvest,
                     picks: dict[str, str] | None,
                     fields: tuple[tuple[str, str, str], ...]) -> None:
    """Reject provable shape mistakes, never choices based on their recommendation score."""
    by_id = {candidate.candidate_id: candidate for candidate in harvest.candidates}
    for field, kind, _label in fields:
        value = annotation.get(field)
        if value in (None, "", []):
            continue
        if kind in ("scalar", "image") and isinstance(value, (list, tuple, dict)):
            raise ValueError(f"{field}: choose a single value, not a whole collection")
        for selected in picked_ids(picks, field):
            candidate = by_id.get(selected)
            if candidate is None or rule_for(candidate, kind=kind) is None:
                raise ValueError(f"{field}: the selected candidate has no rule compatible with this field")


def normalise_selected_members(annotation: dict[str, Any], harvest: Harvest,
                               picks: dict[str, str] | None,
                               fields: tuple[tuple[str, str, str], ...] = FIELDS,
                               multi: Iterable[str] = ()) -> dict[str, Any]:
    """Explicit single-member clicks carry provenance; whitespace is part of the member.

    A field answered in 「多个」 holds the values a person picked one at a time, so its
    answer is a list however many they are — one author picked as a *set* means "the pages
    that write their authors this way", while one author picked as a single value means the
    work has one author. That difference is the switch, and it is why the count cannot
    decide the shape.
    """
    many = tuple(multi)
    result = dict(annotation)
    by_id = {candidate.candidate_id: candidate for candidate in harvest.candidates}
    for field, kind, _label in fields:
        ids = picked_ids(picks, field)
        candidate = by_id.get(ids[0]) if ids else None
        value = result.get(field)
        if not isinstance(value, str):
            continue
        if (kind == "collection" and candidate is not None and candidate.kind != "collection"
                and value == candidate.value):
            result[field] = [value]
        elif kind == "multi" and field in many and ids:
            result[field] = [value]
    return result


def hypotheses(annotation: dict[str, str], harvest: Harvest,
               picks: dict[str, str] | None = None,
               applied: dict[str, dict[str, Any]] | None = None,
               fields: tuple[tuple[str, str, str], ...] = FIELDS,
               multi: Iterable[str] = (),
               capture: Any = None) -> dict[str, Any]:
    """Turn `{field: value}` into the rule hypothesis for each field.

    A value with a `pick` takes its rule from the candidate that was clicked. A value
    confirmed in `confirm` mode has no pick — the tool proposed it — so its rule comes
    from what was applied, which is the same rule that read the value.

    A field answered in 「多个」 is the exception, because several clicks are not one
    click: `rule_for_many` builds the single rule that reads the set they name, and it is
    checked against the page before it is recorded.

    One rule per field, and the value it currently reads, which is what the plan's
    Example 2 shows a person to confirm. A field with no rule at all is left out
    rather than guessed at.
    """
    validate_choices(annotation, harvest, picks, fields)
    many = tuple(multi)
    read = capture_reader(capture) if capture is not None else None
    by_id = {candidate.candidate_id: candidate for candidate in harvest.candidates}
    # Keyed by the candidate's value, which is one line — a collection's members joined
    # — so a submitted list is looked up by the same line it was written as.
    by_value = {candidate.value: candidate for candidate in harvest.candidates}
    kinds = {field: kind for field, kind, _label in fields}

    def candidate_for(field: str, value: Any) -> Any:
        """The candidate a submitted value came from, by its line and then by its members.

        A candidate's line is the members joined the way the *harvester* joins them, so a value
        submitted for a field the page writes with other separators (`a b c` beside `a / b / c`)
        misses that line — and the field then looked like one with no candidate behind it, which is
        how the rule that reads it was never offered. Collections and image groups are compared as
        members; every other field stays a line, because a title is not a list.
        """
        line = joined_value(value)
        exact = by_value.get(line)
        if exact is not None:
            return exact
        if kinds.get(field) not in ("collection", "images"):
            return None
        wanted = split_members(line)
        if len(wanted) < 2:
            return None
        return next((candidate for candidate in harvest.candidates
                     if same_members(split_members(candidate.value), wanted)), None)

    result: dict[str, Any] = {}
    for field, _kind, _label in fields:
        value = annotation.get(field)
        if not value:
            continue
        ids = picked_ids(picks, field)
        clicked = [by_id[item] for item in ids if item in by_id]
        # Several clicks are one answer: the rule is derived from the set they name, not
        # from whichever of them happened to be clicked last.
        if field in many and clicked and read is not None:
            rule = rule_for_many(clicked, read)
            if rule is not None:
                reads = read(rule)
                members = [str(member) for member in (reads if isinstance(reads, list) else [reads])]
                extra = [member for member in members
                         if not any(member == str(picked.value) for picked in clicked)]
                result[field] = {
                    "value": value,
                    "score": clicked[0].score,
                    "rule": rule,
                    "from": [source.channel for source in clicked[0].sources],
                    "candidate_id": clicked[0].candidate_id,
                    "members": members,
                    **({"extra": extra} if extra else {}),
                }
                continue
            # A pick that cannot be named as a set — one block the page wrote the members
            # into — is still the value the person chose, and the field's own rules read it:
            # that is the path every collection already had.
        candidate = (by_id.get(ids[0]) if ids else None) \
            or candidate_for(field, value)
        proposal = (applied or {}).get(field) or {}
        # A new click replaces the proposal; it must not keep the rejected rule.
        rule = ((rule_for(candidate, kind=_kind) if candidate else None) if field in (picks or {})
                else proposal.get("rule") or (rule_for(candidate, kind=_kind) if candidate else None))
        if rule is None:
            continue
        result[field] = {
            "value": value,
            "score": candidate.score if candidate else None,
            "rule": rule,
            "from": ([source.channel for source in candidate.sources] if candidate
                     else ["confirmed"]),
        }
        if candidate is not None and field in (picks or {}):
            result[field]["candidate_id"] = candidate.candidate_id
        date_kind = ((candidate.context.get("date_kind") if candidate else None)
                     if field in (picks or {}) else proposal.get("date_kind")
                     or (candidate.context.get("date_kind") if candidate else None))
        if date_kind and field in ("date", "date_added"):
            result[field]["date_kind"] = date_kind
    return result


@dataclass
class Annotation:
    """What a person decided, plus what the tool knows about the page it came from."""

    url: str
    fields: dict[str, Any]                  # field -> the value a person accepted
    # Fields this page simply does not carry. A work is not required to have every
    # field: characters may live inside the tags, or only some works declare them.
    # Saying so is what keeps "read nothing here" from being read as a broken rule.
    absent: list[str] = field(default_factory=list)
    # field -> candidate clicked, or the candidate ids in the order they were clicked when
    # the person answered with several (the switch's 「多个」).
    picks: dict[str, Any] = field(default_factory=dict)
    verdicts: dict[str, str] = field(default_factory=dict)    # confirm mode: ok | bad
    # The fields answered in 「多个」. A one-author answer and a one-of-many answer look the
    # same in `picks` — one id — and mean different things, so the choice is recorded
    # rather than inferred from the count.
    multi: list[str] = field(default_factory=list)
    mode: str = "annotate"          # annotate | confirm | validate

    def to_json(self) -> dict[str, Any]:
        return {"url": self.url, "mode": self.mode, "fields": self.fields,
                "picks": self.picks, "multi": self.multi, "verdicts": self.verdicts,
                "absent": self.absent}

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> Annotation:
        def text_map(key: str) -> dict[str, str]:
            return {str(k): str(v) for k, v in (payload.get(key) or {}).items()}

        def picked_map(key: str) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for name, value in (payload.get(key) or {}).items():
                if isinstance(value, (list, tuple)):
                    result[str(name)] = [str(item) for item in value]
                else:
                    result[str(name)] = str(value)
            return result

        return cls(url=str(payload.get("url") or ""),
                   fields={str(k): kept_value(v)
                           for k, v in (payload.get("fields") or {}).items()},
                   picks=picked_map("picks"), verdicts=text_map("verdicts"),
                   multi=[str(name) for name in (payload.get("multi") or [])],
                   absent=[str(name) for name in (payload.get("absent") or [])],
                   mode=str(payload.get("mode") or "annotate"))


def kept_value(value: Any) -> Any:
    """A submitted value as it was submitted: a collection stays a list.

    Stringifying it here is what turned a work's tags into the Python repr of a list,
    brackets and quotes included — and then the rule, which reads the same tags into a
    list, "disagreed" with the value a person had just accepted and was pruned as if
    the rule were the wrong half.
    """
    if isinstance(value, (list, tuple)):
        return [str(member) for member in value]
    return str(value)


def page(harvest: Harvest, *, url: str, mode: str = "annotate",
         applied: dict[str, dict[str, Any]] | None = None, token: str = "",
         fields: tuple[tuple[str, str, str], ...] = FIELDS,
         position: tuple[int, int] | None = None, last: bool = False,
         vocabulary: str = "work", lang: str | None = None) -> str:
    """The annotation page: one self-contained document, no framework, no build.

    Everything it needs is embedded, so it works from a plain HTTP response with no
    second request for data — and the only requests it makes are for the cover
    images it shows, which the same server proxies from its own candidate list.

    `lang` is the whole page's language (`l10n.CHROME`); it defaults to the one T³ passed in the
    environment, because the person reading this page is inside T³ and not in a terminal.

    `vocabulary` is which page this is — a work's, or a listing card's. The card page teaches a
    different job (the card is one sample of a set), so its tips and the words around the save
    button differ; everything else about the page is the same page.
    """
    quoted = quote(token, safe="")
    language = lang if lang in l10n.LANGS else l10n.lang_from_env()
    # Pictures are named by score order (图片1, 图片2, …): an address like
    # `…/files/article/image/4/4525/4525s.jpg` says nothing a person can tell apart, and the same
    # name on the next page is how they confirm "the same picture as last time". The candidate's
    # *value* stays the address — that is what the rule learns — only what the row shows changes.
    named_images: dict[str, str] = {}
    for order, candidate in enumerate(
            sorted((item for item in harvest.candidates if item.kind == "image"),
                   key=lambda item: (-item.score, item.candidate_id)),
            start=1):
        named_images[candidate.candidate_id] = l10n.picture_name(language, order)

    payload = json.dumps({
        "url": url,
        "mode": mode,
        # Where this page sits in the site's sequence, and whether submitting it finishes the
        # adapter — the guidance the console used to carry.
        "lang": language,
        # Rendered by the page, so the numeral is the language's (`第一个网站` / `Site 1 of 3`).
        "position": (None if position is None
                     else {"text": l10n.position_text(language, position[0], position[1])}),
        "last": last,
        "tips": list(l10n.tips_for(vocabulary, language)),
        # The page's own words. Sent rather than written into the script because the script is one
        # string with one language in it, and this page is served in whichever one T³ is in.
        "text": l10n.chrome_for(vocabulary, language),
        "kindLabels": l10n.kind_labels(language),
        "save_url": f"/api/annotations?token={quoted}",
        "fields": [{"key": key, "kind": kind,
                    "label": l10n.field_label(language, key, label),
                    "hint": l10n.field_hint(language, key, limit=FIELD_LIMITS.get(key)),
                    # Which fields offer the one/many switch, and where it starts. Sent for
                    # the same reason the join is: the page and the server must agree on
                    # which answer is a single value and which is a set.
                    "multi": can_be_several(kind),
                    "mode": default_mode(kind)}
                   for key, kind, label in fields],
        # What a collection's members are joined with, sent rather than written into the
        # page: the two sides have to agree on it, and a page that guesses records one
        # long tag where the rule reads twelve.
        "join": COLLECTION_JOIN,
        # Example 2: what the tool proposes, for a person to accept or reject.
        "applied": {key: {"value": entry.get("value"), "rule": entry.get("rule")}
                    for key, entry in (applied or {}).items()},
        "accepts": ACCEPTS,
        # How many members a field keeps. Sent rather than written into the page for the
        # same reason the join is: the two sides must agree, and a page keeping three
        # where the rule reads twenty records a value the rule disagrees with.
        "limits": FIELD_LIMITS,
        # Address → 图片N, for the *field* side of the page: a field's answer is an image's address,
        # and the question the left column has to answer is "is that the picture I mean?" — which
        # only the name can, because the name is the one the list on the right shows. Sent rather
        # than rebuilt in the page, so the two sides cannot drift apart.
        "image_names": {candidate.value: named_images[candidate.candidate_id]
                        for candidate in harvest.candidates
                        if candidate.candidate_id in named_images},
        "candidates": [
            {
                "id": candidate.candidate_id,
                "kind": candidate.kind,
                "value": candidate.value,
                "display": candidate.display,
                "date_kind": candidate.context.get("date_kind"),
                # What this value becomes for a field that holds several: one clicked block is
                # several values by the field's own separators (`pickDefaultCoverText`'s sibling
                # — the very function the rule's `split` transform runs), so the page can show
                # what will actually be imported instead of one item.
                "split": (members if len(members := split_members(candidate.value)) > 1 else None),
                # The page itself cut this value short: it is the page's summary, not the field.
                "cut_short": bool(candidate.context.get("cut_short")),
                "count": candidate.context.get("count"),
                "members": (candidate.context.get("members") if candidate.kind == "collection" else None),
                "score": candidate.score,
                "sources": [source.to_json() for source in candidate.sources],
                "has_rule": rule_for(candidate) is not None,
                "usable_for": [kind for kind in ACCEPTS if rule_for(candidate, kind=kind) is not None],
                # Built here, not by the page: the server is the side that knows the
                # token, and a page assembling its own URLs is how every cover came to
                # be requested without one and refused with a 403. A group of images shows
                # its first picture, because twenty addresses in a row say less about
                # which group is the previews than one of its faces does.
                "thumb": (f"/media?c={quote(candidate.candidate_id, safe='')}&token={quoted}"
                          if candidate.kind in ("image", "images") else None),
                # 图片N by score order, for images; the value underneath stays the address.
                "label": named_images.get(candidate.candidate_id),
                "ambiguous": max([source.rule.get("matches", 1)
                                  for source in candidate.sources
                                  if source.rule] or [1]) > 1,
            }
            for candidate in harvest.candidates
        ],
    }, ensure_ascii=False).replace("<", "\\u003c")
    return (_TEMPLATE.replace("__PAYLOAD__", payload)
            .replace("__LANG__", language)
            .replace("__TITLE__", l10n.chrome(language)["docTitle"]))


# The page is deliberately plain: it renders a list, lets two clicks make an
# assignment, and posts the result. No framework, no build step, nothing to install
# — the plan asks for a working view before a nice one, and this is the view that
# answers whether annotation produces anything executable.
# Raw: the script inside it has regexes (`/\{(\w+)\}/`), and a normal string would warn.
_TEMPLATE = r"""<!doctype html>
<html lang="__LANG__"><head><meta charset="utf-8">
<title>__TITLE__</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:13px/1.5 system-ui,sans-serif; background:#14161a; color:#e6e6e6; }
  header { padding:10px 14px; border-bottom:1px solid #2a2e35; position:sticky; top:0;
           background:#14161a; z-index:3; }
  header .url { color:#8aa0b8; word-break:break-all; }
  main { display:flex; gap:14px; padding:14px; align-items:flex-start; }
  /* The field column scrolls on its own. Pinned to the viewport, it used to be as tall as its
     contents, so its lower half — the save button included — could only come into view once the
     *right* column (a page's worth of candidates) had been scrolled to the bottom; measured in the
     app on 2026-10-03, on a page whose field list was taller than the window. */
  .fields { width:290px; flex:none; position:sticky; top:56px;
            max-height:calc(100vh - 70px); overflow-y:auto; }
  .cands { flex:1; min-width:0; }
  .field { border:1px solid #2a2e35; border-radius:6px; padding:8px; margin-bottom:6px; }
  .field.sel { border-color:#4a9eff; }
  .field .name { font-weight:600; }
  /* The name line, with the one/many switch at its right edge: it is a property of the field,
     and a control on its own line made every multi-valued field taller than the panel shows
     at once. Two buttons rather than a checkbox — both positions are words, not a state. */
  .field .head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .field .val { color:#8fd694; word-break:break-all; font-size:12px; }
  .field .hint { color:#6b7480; font-size:12px; }
  /* A value the page itself cut short: it has to look different from the preview this page
     prints, or the two read the same and the difference is invisible. */
  .hint.cut { color:#e0c07a; }
  /* The one/many switch, on the fields whose answer can be either. Two buttons rather than a
     checkbox: both positions are words a person reads, not a state to infer. */
  .field .modes { display:flex; align-items:center; gap:4px; flex:none; }
  .field .modes .ask { color:#6b7480; font-size:11px; }
  .field .modes button { padding:0 6px; font-size:11px; line-height:1.5; }
  /* What is chosen, one per line, each removable: the answer of a several-field is a list,
     and a list has to be readable one member at a time. */
  .field .chips { display:flex; flex-wrap:wrap; gap:4px; margin-top:6px; }
  .field .chip { display:inline-flex; align-items:center; gap:4px; max-width:100%;
    padding:1px 4px 1px 8px; border:1px solid #2a2e35; border-radius:10px;
    background:#1b1e24; font-size:11px; word-break:break-all; }
  .field .chip .drop { padding:0 3px; border:0; background:transparent; color:#c9d3de;
    font-size:12px; line-height:1; cursor:pointer; }
  .field .chip .drop:hover { color:#ff8f8f; }
  .field .chips .clear { padding:1px 8px; font-size:11px; }
  .bar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
  input[type=search] { flex:1; min-width:180px; background:#1b1f25; color:#e6e6e6;
                       border:1px solid #2a2e35; border-radius:6px; padding:6px 8px; }
  button { background:#1b1f25; color:#e6e6e6; border:1px solid #2a2e35; border-radius:6px;
           padding:6px 10px; cursor:pointer; }
  button.on { background:#26456b; border-color:#4a9eff; }
  button.ok { background:#2f6b3a; border-color:#4a9e5c; }
  button.bad { background:#6b2f2f; border-color:#9e4a4a; }
  button.primary { background:#2f6b3a; border-color:#4a9e5c; }
  .cand { border:1px solid #2a2e35; border-radius:6px; padding:8px; margin-bottom:6px;
          display:flex; gap:10px; align-items:flex-start; }
  .cand img { max-width:120px; max-height:160px; border-radius:4px; background:#000; flex:none; }
  .cand code { display:block; background:#101317; padding:2px 4px; border-radius:3px; user-select:text; }
  .cand .thumb-link { display:block; color:#8aa0b8; margin:2px 0; }
  .cand .v { word-break:break-all; }
  .cand .src { color:#6b7480; font-size:12px; word-break:break-all; }
  .cand .score { color:#c9a227; flex:none; }
  .cand.assigned { border-color:#4a9e5c; }
  .empty { color:#6b7480; }
  .send { margin-left:auto; }
  /* The wait, in the middle of the screen. Submitting a page is followed by several seconds of the
     tool capturing the next site (a headless browser, sometimes a minute) and then opening its page;
     the sentence that used to carry this sat in the left column under the save button, which is
     exactly where a person is no longer looking. Opaque enough to be the only thing on screen, and
     it swallows clicks because there is nothing left to do on this page. */
  .veil { position:fixed; inset:0; z-index:9; display:none; align-items:center; justify-content:center;
          padding:24px; background:rgba(20,22,26,.94); }
  .veil.show { display:flex; }
  .veil .panel { max-width:660px; text-align:center; }
  .veil .pulse { width:72px; height:4px; margin:0 auto 20px; border-radius:2px;
                 background:#2a2e35; overflow:hidden; }
  .veil .pulse i { display:block; width:40%; height:100%; background:#4a9eff;
                   animation:slide 1.2s ease-in-out infinite; }
  @keyframes slide { from { transform:translateX(-100%); } to { transform:translateX(250%); } }
  .veil .headline { font-size:26px; font-weight:600; line-height:1.35; }
  .veil .detail { margin-top:12px; color:#8aa0b8; word-break:break-word; }
  .veil .extra { margin-top:10px; max-width:36rem; color:#e0c07a; font-size:12px;
    word-break:break-word; }
</style></head><body>
<header>
  <div class="url" id="url"></div>
  <div class="hint" id="hint"></div>
</header>
<main>
  <section class="fields"><div id="fields"></div>
    <button class="primary send" id="save"></button>
    <div class="hint" id="saveNote"></div>
    <div class="hint" id="status"></div>
  </section>
  <section class="cands">
    <div class="bar">
      <input type="search" id="q">
      <span id="kinds"></span>
    </div>
    <div id="list"></div>
  </section>
</main>
<!-- What the page says once this one is submitted. The tool then captures the next site with a
     headless browser (several seconds) and opens its page, so the wait is the whole message; the
     line under the save button is where nobody looks. -->
<div class="veil" id="veil" role="status" aria-live="polite">
  <div class="panel">
    <div class="pulse"><i></i></div>
    <div class="headline" id="veilHead"></div>
    <div class="detail" id="veilDetail"></div>
    <div class="extra" id="veilExtra"></div>
  </div>
</div>
<script>
const DATA = __PAYLOAD__;
const T = DATA.text;
// `{name}` in a sentence is filled here, so a translation can order its own placeholders.
const fill = (template, values) => template.replace(/\{(\w+)\}/g,
  (whole, name) => (name in values ? String(values[name]) : whole));
// The middle-of-the-screen wait, and the way back down from it: `null` takes it away, which is the
// failure path — a page that could not be saved says so beside the button, where the action was.
// The page's own scrollbar goes with it: a fixed panel leaves it showing along the edge of the veil,
// which reads as "there is still something to do down there".
const veil = (headline, detail) => {
  const box = document.getElementById('veil');
  document.getElementById('veilExtra').textContent = '';
  if (headline === null) { box.className = 'veil'; document.body.style.overflow = ''; return; }
  document.getElementById('veilHead').textContent = headline;
  document.getElementById('veilDetail').textContent = detail || '';
  box.className = 'veil show';
  document.body.style.overflow = 'hidden';
};
// A field's answer is a *value*; the candidate id is only provenance, for the case
// where a person picked it off the list. Conflating the two is why confirming a
// proposal did nothing: accepting a proposal was implemented as finding a candidate
// whose value matched it exactly, and when the rule had read a value no candidate
// carried, the answer became `undefined` — so the buttons came back and the save
// threw on `byId.get(undefined).value`.
const values = {};                // field -> the value a person accepted
const picked = {};                // field -> the candidate id, or the ids clicked in order
const modes = {};                 // field -> 'one' | 'many', for the fields that offer it
const absent = new Set();         // fields this page simply does not carry
let selectedField = null;
let kindFilter = null;

const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const byId = new Map(DATA.candidates.map(c => [c.id, c]));
const join = DATA.join;
const KIND = {};
const MULTI = new Set();
for (const field of DATA.fields) {
  KIND[field.key] = field.kind;
  if (field.multi) { MULTI.add(field.key); modes[field.key] = field.mode; }
}
// The ids clicked for one field, whether that is one click or several.
const pickedIds = (key) => {
  const value = picked[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value.slice() : [value];
};
const isMany = (key) => modes[key] === 'many';
// A value written as one line. A collection is a list of its members; showing it as
// anything shorter — five of sixteen tags, or the first 300 characters of a cast list
// — is how a person came to accept a partial value and the rule that read all of it
// was pruned as if the rule were the broken half.
const textOf = (value) => Array.isArray(value) ? value.join(join) : String(value);
const counted = (text, value) => Array.isArray(value)
  ? text + fill(T.counted, { count: value.length }) : text;
// A name for an address, so a field answers with the same name the candidate list shows. An address
// says nothing a person can tell apart, and the question the left side has to answer is "is that the
// picture I mean?" — which only the name can, because the name is the one on the right.
const NAME_BY_VALUE = new Map(Object.entries(DATA.image_names || {}));
const isImageField = (key) => KIND[key] === 'image' || KIND[key] === 'images';
// A candidate that *is* a picture (or a group of them), as opposed to one that answers a picture
// field. The chip filter works on this, because what a person looks for there is looked up by eye.
const isPictureKind = (kind) => kind === 'image' || kind === 'images';
const named = (key, value) => {
  if (!isImageField(key)) return null;
  const members = Array.isArray(value) ? value : [value];
  const names = members.map(member => NAME_BY_VALUE.get(member));
  // One address the page did not offer stays an address: naming the rest would hide which one is
  // unknown, and a rule that read something else is exactly what a person has to see here.
  return names.every(Boolean) ? names.join(join) : null;
};
// A long value is drawn as a preview, and says so: the answer holds the whole text and that is
// what the import writes. A person has to be able to tell that from a value the *page* cut short
// (marked `cut_short`), because a "…" on its own reads either way — and reading the page's own
// summary as "we captured it and are showing part of it" is exactly what happened here first.
const PREVIEW_CHARS = 160;
const isLong = (key, value) => !isImageField(key) && textOf(value).length > PREVIEW_CHARS;
const previewOf = (value) => textOf(value).slice(0, PREVIEW_CHARS) + '…';
const previewNote = (value) => fill(T.preview, { shown: PREVIEW_CHARS, total: textOf(value).length });
// What a several-value answer is going to become. One clicked block is one member here and several
// values by the field's own separators, and showing it as one item is how a person came to ask
// whether the import would take it as one.
const splitOf = (key) => {
  if (!isMany(key)) return null;
  const chosen = Array.isArray(values[key]) ? values[key] : (values[key] === undefined ? [] : [values[key]]);
  if (chosen.length !== 1) return null;
  const ids = pickedIds(key);
  const source = ids.length === 1 ? byId.get(ids[0]) : null;
  return source && Array.isArray(source.split) && source.split.length > 1 ? source.split : null;
};
// What a field's answer reads as: the name for images, the value itself otherwise.
const answerText = (key, value) => counted(named(key, value) ?? textOf(value), value);
// What a candidate means as a field's value: assigning a collection assigns its
// members, which is what the rule reads and what the record carries — and a group of
// images assigns the addresses of all of them, for the same reason. A field with a
// declared limit keeps the first that many, which is the same `limit` its rule carries.
const valueOf = (c, many) => {
  let value;
  if (c.kind === 'collection' || c.kind === 'images') {
    value = Array.isArray(c.members) ? c.members.slice() : c.value.split(join);
  } else if (many || KIND[selectedField] === 'collection') {
    // One value of a set: the field's answer is the list, this is one of its members.
    value = [c.value];
  } else {
    value = c.value;
  }
  const cap = DATA.limits[selectedField];
  return Array.isArray(value) && cap ? value.slice(0, cap) : value;
};

// The switch decides what a click means, and the answer is reshaped with it: an author
// picked as "these are the pages' authors" is a set, and the same author picked as "this
// work's author" is one value. Keeping the first pick when narrowing to one, and keeping
// what was there as the first member when widening, means nothing a person chose is lost
// by flipping the switch.
function setMode(key, mode) {
  if (modes[key] === mode) return;
  modes[key] = mode;
  const current = values[key];
  if (mode === 'one') {
    const ids = pickedIds(key);
    if (Array.isArray(current)) values[key] = current[0];
    if (ids.length > 1) picked[key] = ids[0];
  } else if (current !== undefined && !Array.isArray(current)) {
    values[key] = [current];
  }
  render();
}

// In "several" a click is one member: the same value again takes it back out. One member is
// kept as the value itself rather than as a one-item list, because the two mean different
// things to the field: five picked names are five values, while one clicked block is a block
// the field's own rules split into its members.
function toggleChosen(key, c) {
  const ids = pickedIds(key);
  const members = Array.isArray(values[key]) ? values[key].slice()
    : (values[key] === undefined ? [] : [values[key]]);
  const at = ids.indexOf(c.id);
  if (at >= 0) { ids.splice(at, 1); members.splice(at, 1); }
  else { ids.push(c.id); members.push(...valueOf(c, true)); }
  if (!ids.length) { delete picked[key]; delete values[key]; }
  else { picked[key] = ids; values[key] = members.length === 1 ? members[0] : members; }
}

function dropChosen(key, index) {
  const ids = pickedIds(key);
  const members = Array.isArray(values[key]) ? values[key].slice() : [];
  ids.splice(index, 1);
  members.splice(index, 1);
  if (!ids.length) { delete picked[key]; delete values[key]; }
  else { picked[key] = ids; values[key] = members; }
}

function render() {
  document.getElementById('url').textContent =
    (DATA.position ? DATA.position.text + '  ·  ' : '') + DATA.url;
  const hint = document.getElementById('hint');
  hint.textContent = T.pickHint + (DATA.mode === 'annotate' ? T.noRuleHint : '');
  // The usage tips sit where the harvest's log notes used to be: the notes are diagnostics and
  // stay in the session folder, and this page teaches instead.
  for (const tip of DATA.tips) {
    const line = el('div', 'hint'); line.textContent = tip;
    hint.appendChild(line);
  }

  const fields = document.getElementById('fields');
  fields.textContent = '';
  for (const field of DATA.fields) {
    const box = el('div', 'field' + (selectedField === field.key ? ' sel' : ''));
    // The name line carries the one/many switch at its right edge: it is a property of the
    // field, and a control on its own line made every multi-valued field taller than the
    // panel could show at once.
    const head = el('div', 'head');
    const name = el('div', 'name'); name.textContent = field.label + '  (' + field.key + ')';
    head.appendChild(name);
    if (MULTI.has(field.key)) {
      const bar = el('div', 'modes');
      const ask = el('span', 'ask'); ask.textContent = T.modeAsk;
      bar.appendChild(ask);
      for (const [value, label] of [['one', T.modeOne], ['many', T.modeMany]]) {
        const button = el('button', 'mode' + (modes[field.key] === value ? ' on' : ''));
        button.textContent = label;
        // Using the field's own control selects the field: a click on the row no longer
        // reaches it, and a person who sets the switch and then clicks a value means this
        // field — not "no field selected".
        button.onclick = (event) => {
          event.stopPropagation();
          selectedField = field.key;
          setMode(field.key, value);
        };
        bar.appendChild(button);
      }
      head.appendChild(bar);
    }
    box.appendChild(head);
    // What the field is asking for, in the page's own words — the field names alone had a
    // person leave the work-id field unmarked on a real run, and a card with no id is dropped.
    if (field.hint) { const why = el('div', 'hint'); why.textContent = field.hint; box.appendChild(why); }
    if (selectedField === field.key && (field.kind === 'scalar' || field.kind === 'image')) {
      const why = el('div', 'hint'); why.textContent = T.singleValueHint; box.appendChild(why);
    }
    const proposal = (DATA.applied || {})[field.key];
    const answered = Object.prototype.hasOwnProperty.call(values, field.key);
    const shown = el('div', answered ? 'val' : 'hint');
    if (absent.has(field.key)) shown.textContent = T.absentValue;
    if (answered && isMany(field.key)) {
      // The members are listed under the row, one by one; the line says how many. A single
      // clicked block is the field's whole answer here, so it is one member on the list.
      const chosen = Array.isArray(values[field.key]) ? values[field.key] : [values[field.key]];
      const split = splitOf(field.key);
      if (split) shown.textContent = fill(T.splitInto, { count: split.length });
      else if (chosen.length) shown.textContent = fill(T.chosenCount, { count: chosen.length });
      else shown.textContent = answerText(field.key, values[field.key]);
    }
    else if (answered && isLong(field.key, values[field.key])) {
      shown.textContent = previewOf(values[field.key]);
    }
    else if (answered) shown.textContent = answerText(field.key, values[field.key]);
    else if (proposal) shown.textContent = (proposal.value === null
      ? T.unreadable : answerText(field.key, proposal.value));
    else shown.textContent = T.unassigned;
    box.appendChild(shown);
    if (answered && isLong(field.key, values[field.key])) {
      const note = el('div', 'hint'); note.textContent = previewNote(values[field.key]);
      box.appendChild(note);
    }
    const splitMembers = answered ? splitOf(field.key) : null;
    const listed = splitMembers ?? (Array.isArray(values[field.key]) ? values[field.key] : null);
    if (answered && isMany(field.key) && listed) {
      const chips = el('div', 'chips');
      listed.forEach((member, index) => {
        const chip = el('span', 'chip');
        chip.textContent = String(member);
        // A member of a split block is not something the person picked one by one: the answer is
        // the block, so there is nothing here to remove on its own: the Clear button removes it.
        if (!splitMembers) {
          const drop = el('button', 'drop'); drop.textContent = '×';
          drop.onclick = (event) => {
            event.stopPropagation();
            selectedField = field.key;
            dropChosen(field.key, index);
            render();
          };
          chip.appendChild(drop);
        }
        chips.appendChild(chip);
      });
      const clear = el('button', 'clear'); clear.textContent = T.clearChosen;
      clear.onclick = (event) => {
        event.stopPropagation();
        selectedField = field.key;
        delete values[field.key]; delete picked[field.key]; render();
      };
      chips.appendChild(clear);
      box.appendChild(chips);
      if (splitMembers) {
        const why = el('div', 'hint'); why.textContent = T.splitFrom;
        box.appendChild(why);
      }
    }
    if (proposal && !answered) {
      const accept = el('button', 'ok'); accept.textContent = T.accept;
      accept.onclick = (event) => { event.stopPropagation();
        absent.delete(field.key);
        // The tool proposed a value *and* the rule that read it, so accepting needs
        // nothing else — no candidate has to exist for it.
        values[field.key] = proposal.value;
        render(); };
      const reject = el('button', 'bad'); reject.textContent = T.reject;
      reject.onclick = (event) => { event.stopPropagation();
        absent.delete(field.key);
        delete values[field.key]; delete picked[field.key];
        selectedField = field.key; render(); };
      box.appendChild(accept); box.appendChild(reject);
    }
    // A third answer, and the one that was missing: a work is not required to carry
    // every field. Characters may live inside the tags, or only some works declare
    // them, and neither "correct" nor "wrong" describes that — so it can be said.
    if (!answered) {
      const none = el('button', absent.has(field.key) ? 'on' : '');
      none.textContent = T.absentButton;
      none.onclick = (event) => { event.stopPropagation();
        delete values[field.key]; delete picked[field.key];
        if (absent.has(field.key)) absent.delete(field.key); else absent.add(field.key);
        selectedField = null; render(); };
      box.appendChild(none);
    }
    box.onclick = () => { selectedField = selectedField === field.key ? null : field.key; render(); };
    fields.appendChild(box);
  }

  const kinds = document.getElementById('kinds');
  kinds.textContent = '';
  const counts = {};
  for (const c of DATA.candidates) if (c.has_rule) counts[c.kind] = (counts[c.kind] || 0) + 1;
  const all = el('button', kindFilter === null ? 'on' : '');
  all.textContent = T.kindAll + ' ' + DATA.candidates.length;
  all.onclick = () => { kindFilter = null; render(); };
  kinds.appendChild(all);
  for (const kind of Object.keys(counts).sort()) {
    const b = el('button', kindFilter === kind ? 'on' : '');
    b.textContent = (DATA.kindLabels[kind] || kind) + ' ' + counts[kind];
    b.onclick = () => {
      // Switching to the pictures drops whatever was typed for the field before: a picture is
      // looked up by eye, its value is an address, and a query about the previous field would
      // filter the pictures by it and hide the one being looked for.
      if (isPictureKind(kind)) document.getElementById('q').value = '';
      kindFilter = kind; render();
    };
    kinds.appendChild(b);
  }

  const query = document.getElementById('q').value.trim().toLowerCase();
  const list = document.getElementById('list');
  list.textContent = '';
  const assignedIds = new Set(Object.values(picked));
  const shown = DATA.candidates.filter(c => {
    // No rule, no offer: the tool cannot learn from it, so showing it only invites a pick that
    // teaches nothing.
    if (!c.has_rule) return false;
    if (selectedField && !c.usable_for.includes(KIND[selectedField])) return false;
    if (kindFilter && c.kind !== kindFilter) return false;
    if (!query) return true;
    return c.value.toLowerCase().includes(query)
        || c.sources.some(s => (s.detail || '').toLowerCase().includes(query));
  });
  if (!shown.length) {
    const none = el('div', 'empty'); none.textContent = T.noMatches; list.appendChild(none);
  }
  // A huge page offers more than a person can read at once, so the list stops — and
  // says so, because a list that stops silently reads as a page that has no more.
  const MAX_ROWS = 400;
  for (const c of shown.slice(0, MAX_ROWS)) {
    const row = el('div', 'cand' + (assignedIds.has(c.id) ? ' assigned' : ''));
    if (c.thumb) {
      const img = el('img');
      img.loading = 'lazy';
      img.src = c.thumb;
      img.onerror = () => {
        const note = el('span', 'hint');
        note.textContent = T.pictureFailed;
        img.replaceWith(note);
      };
      const link = el('a', 'thumb-link');
      link.href = c.thumb; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = T.openPicture;
      row.appendChild(link);
      row.appendChild(img);
    }
    const body = el('div'); body.style.minWidth = '0';
    const value = el('div', 'v');
    if (c.thumb) {
      // The name, not the address: a URL says nothing a person can tell apart, and the same name on
      // the next page is how they confirm "the same picture as last time". The address stays in
      // the folded provenance and in the recorded value.
      const name = el('strong');
      name.textContent = c.label || T.pictureBare;
      value.appendChild(name);
      const code = el('code');
      code.textContent = c.value;
      value.appendChild(code);
    } else if (textOf(c.value).length > PREVIEW_CHARS) {
      value.textContent = previewOf(c.value);
    } else {
      value.textContent = c.date_kind ? c.display : c.value;
    }
    body.appendChild(value);
    if (!c.thumb && textOf(c.value).length > PREVIEW_CHARS) {
      const note = el('div', 'hint'); note.textContent = previewNote(c.value);
      body.appendChild(note);
    }
    // The page wrote this value cut off, so it is the page's own summary of a longer text — not
    // a preview of anything we hold, and choosing it imports exactly this much.
    if (c.cut_short) {
      const cut = el('div', 'hint cut'); cut.textContent = T.pageCut;
      body.appendChild(cut);
    }
    // Where the value came from is how a rule is diagnosed, not something a person
    // annotating a page needs to read past — so it is folded away, one line, closed by
    // default, and the row stays a value and a click.
    const src = el('details', 'src');
    const head = el('summary');
    head.textContent = (c.count ? fill(T.sourceCount, { count: c.count }) : T.source)
      + T.sourceOpen;
    src.appendChild(head);
    const detail = el('div');
    detail.textContent = c.sources.map(s => s.channel + ':' + s.detail).join('  |  ')
      + (c.ambiguous ? ' ' + T.ambiguous : '');
    src.appendChild(detail);
    body.appendChild(src);
    row.appendChild(body);
    const score = el('span', 'score'); score.textContent = c.score;
    row.appendChild(score);
    row.onclick = (event) => {
      // Selecting the address, opening the image, or unfolding the provenance is not
      // choosing a field.
      if (event.target.closest('a, code, details')) return;
      if (!selectedField) { document.getElementById('status').textContent = T.needField; return; }
      if (!c.usable_for.includes(KIND[selectedField])) {
        document.getElementById('status').textContent = T.wrongShape; return;
      }
      const field = selectedField;
      if (c.kind === 'collection' || c.kind === 'images') {
        // A group is the whole answer in either mode: that is what a group means.
        values[field] = valueOf(c, isMany(field));
        picked[field] = c.id;
      } else if (isMany(field)) {
        toggleChosen(field, c);
      } else {
        values[field] = valueOf(c, false);
        picked[field] = c.id;
      }
      document.getElementById('status').textContent = '';
      // Choosing a picture ends the search that led to it: an address is not searchable, so a query
      // left in the box would filter the *next* field's values by a word about this one.
      if (c.thumb) document.getElementById('q').value = '';
      render();
    };
    list.appendChild(row);
  }
  if (shown.length > MAX_ROWS) {
    const more = el('div', 'empty');
    more.textContent = fill(T.tooMany, { count: shown.length, max: MAX_ROWS });
    list.appendChild(more);
  }
}

document.getElementById('save').textContent = T.save;
document.getElementById('saveNote').textContent = T.saveNote;
document.getElementById('q').placeholder = T.searchPlaceholder;
document.getElementById('q').oninput = render;
// Clicking the search box means "search everything": a kind filter left on from the last field would
// silently hide the value being looked for, and the box looks like it searches the whole list. A
// click rather than a focus event, because a box that already has the caret fires no focus when it
// is clicked again.
document.getElementById('q').onclick = () => {
  if (kindFilter === null) return;
  kindFilter = null;
  render();
};

document.getElementById('save').onclick = async () => {
  const status = document.getElementById('status');
  status.textContent = '';
  // The wait starts on the click, not on the answer: the person has committed to this page and the
  // next thing that happens is not on it. A failure takes it back down and reports beside the button,
  // where the action was.
  veil(T.submitting, '');
  try {
    const reply = await fetch(DATA.save_url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        url: DATA.url, mode: DATA.mode,
        fields: values,
        picks: picked,
        // Which answers are sets. One id and one-of-many ids look the same in `picks`, so
        // the choice travels beside them rather than being guessed from the count.
        multi: Object.keys(modes).filter(key => modes[key] === 'many'
          && Object.prototype.hasOwnProperty.call(values, key)),
        absent: Array.from(absent),
      }),
    });
    const result = await reply.json();
    if (!result.ok) {
      veil(null, '');
      status.textContent = fill(T.saveFailed, { error: result.error || reply.status });
      return;
    }
    veil(DATA.last ? T.doneHeadline : T.waitHeadline,
         DATA.last ? T.savedLast
                   : fill(T.savedNext,
                          { fields: (result.fields || []).join(', ') || T.savedNothing }));
    // A rule that reads more than the person picked is not a failure — picking three of a
    // page's five authors means the other two as well — but it is not silent either: the
    // answer becomes every author, and that is worth reading before the next page.
    if ((result.extra || []).length) {
      const note = document.getElementById('veilExtra');
      note.textContent = fill(T.readsMore, { items: (result.extra || []).join(' · ') });
    }
  } catch (error) {
    veil(null, '');
    status.textContent = fill(T.saveFailed, { error: String(error) });
  }
};

render();
</script>
</body></html>
"""
