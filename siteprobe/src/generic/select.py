"""Resolving a template's field rules into values.

Every canonical field is produced by one *selector*: a small declarative record
that says which document to read, how to find the value inside it, and what to do
with the result. There is no per-site Python in this module, which is what lets a
single extractor serve every site.

Selector forms (``from`` is the discriminator):

    {"from": "json",       "path": "title"}
    {"from": "json_list",  "path": "tags", "take": "tag",
                           "where": {"field": "male", "is_falsy": true}}
    {"from": "html",       "document": "detail_html", "scope": "div.tags",
                           "select": "a", "attr": "href"}
    {"from": "html",       "...", "text": true, "list": true}
    {"from": "html_param", "document": "detail_html",
                           "scope": "div.tags", "select": "a", "param": "query"}
    {"from": "meta",       "document": "detail_html",
                           "name": "keywords"}        # or "property": "og:image"
    {"from": "regex",      "document": "detail_html",
                           "pattern": "pages\\s*:\\s*(\\d+)", "group": 1}
    {"from": "url",        "pattern": "(\\d+)", "template": "https://.../{1}"}
    {"from": "const",      "value": []}
    {"from": "card",       "field": "cover_url"}

Shared keys on any selector:

    transform   list of named post-processing steps, applied in order
    fallback    list of alternative selectors tried when this one yields nothing
    list        return every match instead of the first

Several keys take a *list* of alternatives instead of one string and are tried in
order: ``select``, ``scope``, ``attr``, ``pattern``, ``filter``.

Any ``{name}`` inside ``pattern``, ``filter``, ``template`` or ``path`` is
interpolated from the extraction context, so a rule can key off ``{source_id}``
without the site supplying code.
"""

from __future__ import annotations

import re
from contextlib import contextmanager
from datetime import date, timedelta
from typing import Any, Iterable
from urllib.parse import parse_qs, urljoin, urlparse

from .document import Document, DocumentBag, MissingDocumentError
from .htmltree import Element, select_all, select_one
from .text_normalization import decode_entities, to_simplified
from .dates import extract_date

#: Attribute names that are two spellings of **one value**, because a script moved it between the page
#: as served and the page as rendered. Bootstrap's tooltip copies `title` into `data-original-title`
#: and blanks the original; lazy-loaders move `src` into `data-src` / `data-original`.
#:
#: The direction matters: a rule is learned from the page the *Builder* captured — a rendered one —
#: while a crawl reads the page as *served*. Measured on jable.tv (2026-10-05): the author was marked
#: successfully and then absent from the import, because the served `<span>` carries `title="早坂奏音"`
#: while the captured one carries `title="" data-original-title="早坂奏音"`, so the rule read nothing.
ATTR_ALIASES: dict[str, tuple[str, ...]] = {
    "data-original-title": ("title",),
    "title": ("data-original-title",),
    "data-src": ("src",),
    "src": ("data-src",),
    "data-original": ("src",),
    "data-lazy-src": ("src",),
}


class SelectorError(RuntimeError):
    """A template rule is malformed, or names a document the fetcher omitted."""


# --- transforms ----------------------------------------------------------- #

def _basename(value: str) -> str:
    path = urlparse(str(value)).path
    return path.rsplit("/", 1)[-1]


def _strip_query(value: str) -> str:
    parsed = urlparse(str(value))
    if not parsed.scheme:
        return str(value).split("?", 1)[0]
    return parsed._replace(query="", fragment="").geturl()


def _date_only(value: str) -> str:
    """Reduce any date spelling to ``YYYY-MM-DD``.

    Sites publish dates as `2019-08-14`, `2017-01-28 16:47:00-06`, `2017/1/3` and
    worse. The library and the crawl cursor both want one shape, so the generic
    layer normalises here rather than leaving every consumer to slice.
    """
    match = re.search(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", str(value))
    if match is None:
        return ""
    year, month, day = match.groups()
    return f"{int(year):04d}-{int(month):02d}-{int(day):02d}"


def _relative_date(value: str, *, today: "date | None" = None) -> str:
    """Turn a recent, human-readable date into the same date shape as older rows.

    Listing pages commonly replace only their newest absolute dates with ``5 days ago`` or
    ``yesterday``.  This is a display convention, not a site-specific data format, so it belongs
    beside the other generic selector transforms.  Absolute ISO-like dates still pass through the
    ordinary date normaliser; unknown spellings are preserved rather than silently erased.

    `today` is the run's **frozen** clock (plan §5-D.2): one run that crosses midnight must not give
    two works read a minute apart two different dates. `frozen_clock` sets it for the whole run; an
    explicit argument wins, so a test can pin a day.
    """
    text = str(value).strip()
    absolute = _date_only(text)
    if absolute:
        return absolute
    lowered = text.casefold()
    today = today or _RUN_TODAY or date.today()
    if lowered == "today":
        return today.isoformat()
    if lowered == "yesterday":
        return (today - timedelta(days=1)).isoformat()
    match = re.fullmatch(
        r"(?:about\s+)?(\d+)\s+(second|minute|hour|day|week)s?\s+ago", lowered)
    if match is None:
        return text
    amount = int(match.group(1))
    unit = match.group(2)
    days = amount * 7 if unit == "week" else amount if unit == "day" else 0
    return (today - timedelta(days=days)).isoformat()


# The run's clock, frozen once. Extraction is single-threaded (the media downloads use threads, and
# none of them converts a date), so one module value is the whole mechanism — the alternative is
# threading a clock through every `apply_transforms` call site, which buys nothing a single run needs.
_RUN_TODAY: "date | None" = None


def freeze_clock(today: "date | None" = None) -> "date":
    """Freeze this run's clock at today, once. Called at the start of a run."""
    global _RUN_TODAY
    _RUN_TODAY = today or date.today()
    return _RUN_TODAY


@contextmanager
def frozen_clock(today: "date | None" = None):
    """Freeze the clock for a block, then restore — for a test that must pin a day."""
    global _RUN_TODAY
    previous = _RUN_TODAY
    _RUN_TODAY = today or date.today()
    try:
        yield _RUN_TODAY
    finally:
        _RUN_TODAY = previous


SPLIT_RE = re.compile(r"\s*[,，、;；|]\s*")

# What separates the members of a multi-value field that a page writes as one string:
# commas in every width, the CJK enumeration comma, semicolons, slashes and pipes — and
# whitespace, which is what a characters block uses, but only for a value that carries no
# comma-class separator at all. Deciding between the two by whether the strong one is
# present is what keeps a comma-joined list of multi-word members whole: measured on
# pmc.ncbi.nlm.nih.gov (2026-10-15), `regulatory T cells, acute respiratory distress
# syndrome, …` came out as thirteen words instead of five keywords, because whitespace
# split every member that happens to contain a space.
MEMBERS_RE = re.compile(r"\s*[,，、;；/／|]\s*")
SPACE_MEMBERS_RE = re.compile(r"\s+")

# The list's own label, glued in front of its first member: `<strong>Keywords:</strong>
# regulatory T cells, …` reads as `Keywords: regulatory T cells`. A label is letters only
# — no whitespace, no digits, shorter than a member — so `IL-33:ST2 axis` is left alone
# while `Keywords:` and `关键词：` are dropped.
LABEL_RE = re.compile(r"^[^\s,，、;；/／|\d]{1,14}[:：]\s*")


def _split_csv(value: Any) -> list[str]:
    """One comma-separated string into a list, the way a keyword meta list is shaped."""
    return [part.strip() for part in SPLIT_RE.split(str(value)) if part.strip()]


def split_members(value: Any) -> list[str]:
    """One string holding several members into the members themselves.

    Multi-value fields arrive joined more often than they arrive as repeated elements: a
    characters block written as `美甘寧瑠 美甘妮露` is two characters, and a tags list
    written `a, b, c` is three tags — and before this both were accepted as one value, so
    a work's 登場人物 came out as a single string with the separator still inside it.

    A list is flattened rather than refused, because a rule that reads several elements
    and a rule that reads one block holding several are the same field: `list: true`
    produces the list, this produces the members, and either may be what a page needs.
    """
    if isinstance(value, (list, tuple)):
        members: list[str] = []
        for item in value:
            members.extend(split_members(item))
        return members
    text = str(value)
    pattern = MEMBERS_RE if MEMBERS_RE.search(text) else SPACE_MEMBERS_RE
    members = [part.strip() for part in pattern.split(text) if part.strip()]
    if members:
        # The label in front of a list is the list's name, not one of its members. Only the
        # first member can carry it, and only when what is left still has a value.
        unlabelled = LABEL_RE.sub("", members[0]).strip()
        if unlabelled:
            members[0] = unlabelled
    return members


_TRANSFORMS = {
    "trim": lambda value: str(value).strip(),    "collapse_ws": lambda value: re.sub(r"\s+", " ", str(value)).strip(),
    "lower": lambda value: str(value).lower(),
    "titlecase": lambda value: str(value).title(),
    "t2s": to_simplified,
    # Hitomi tags carry gender markers: `♂` marks a tag about a male subject and
    # the tag is dropped by the `where` clause, `♀` is decoration around an
    # otherwise useful tag and is removed here.
    "strip_gender_marker": lambda value: re.sub(r"\s*[\u2640\ufe0f]\s*", " ", str(value)).strip(),
    "date_only": _date_only,
    "extract_date": extract_date,
    "relative_date": _relative_date,
    "basename": _basename,
    "strip_query": _strip_query,
    "int": lambda value: _as_int(value),
    "count": lambda value: len(value) if isinstance(value, (list, tuple)) else None,
    # A site that keeps its categories in one comma-separated meta keyword list
    # rather than in per-tag elements needs a single step to make that a list.
    "split_csv": _split_csv,
    "split": split_members,
}


def _as_int(value: Any) -> int | None:
    match = re.search(r"\d+", str(value))
    return int(match.group(0)) if match else None


def apply_transforms(value: Any, transforms: Iterable[str]) -> Any:
    for name in transforms:
        function = _TRANSFORMS.get(name)
        if function is None:
            raise SelectorError(f"unknown transform {name!r}")
        if value is None or value == "":
            return value
        value = function(value)
    return value


# --- small helpers -------------------------------------------------------- #

def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _first(values: Any) -> Any:
    """First element that is not None and not an empty string."""
    for value in _as_list(values):
        if value is not None and value != "":
            return value
    return None


def _clean_list(values: Iterable[Any]) -> list[str]:
    """Trim, drop empties, dedupe case-sensitively while keeping first-seen order."""
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        text = re.sub(r"\s+", " ", str(value or "")).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _apply_map(value: Any, mapping: Any) -> Any:
    """Replace a coded value with its declared label.

    Sites publish machine values that a human never wants to see as a category:
    hitomi's gallery `type` is `artistcg`, and its own tooling displayed
    "Artist Cg". A template carries that table instead of the code carrying a
    branch, which is what keeps one extractor serving every site.
    """
    if not isinstance(mapping, dict) or value is None:
        return value
    folded = {str(key).casefold(): label for key, label in mapping.items()}
    return folded.get(str(value).casefold(), value)


def _promote_first(values: list[str], target: Any) -> list[str]:
    """Lead a list with one value, inserting it when it is not already there.

    The author a crawl started from is the one worth seeing first, and hitomi's
    tool ordered `分类信息.作者` that way — including when the site's payload names
    no author at all and only the crawled name is known. Comparison treats `_` and
    `-` as word separators, so `arai_kazuki` finds `Arai Kazuki`; the inserted
    value keeps the target's own spelling and then goes through the same
    transforms as everything else.
    """
    if not target:
        return values
    wanted = _words(str(target))
    for index, value in enumerate(values):
        if _words(value) == wanted:
            return [value, *values[:index], *values[index + 1:]]
    return [str(target), *values]


def _words(value: Any) -> str:
    return re.sub(r"[-_]+", " ", str(value or "")).strip().casefold()


def _finish_list(values: Any, selector: dict[str, Any], context: dict[str, Any],
                 transforms: list[str], *, offset: int = 0) -> list[str]:
    """Clean, slice, order and transform a list result — one path for every kind."""
    cleaned = _clean_list(_as_list(values))
    if offset:
        cleaned = cleaned[offset:]
    limit = selector.get("limit")
    if limit is not None:
        cleaned = cleaned[: int(limit)]
    promoted = selector.get("promote_first")
    if promoted is not None:
        cleaned = _promote_first(cleaned, _interpolate(str(promoted), context))
    return [apply_transforms(value, transforms) for value in cleaned]


def _interpolate(value: Any, context: dict[str, Any]) -> Any:
    if not isinstance(value, str):
        return value
    return re.sub(
        r"\{([A-Za-z_][A-Za-z0-9_]*)\}",
        lambda match: str(context.get(match.group(1), "") or ""),
        value,
    )


# --- json paths ----------------------------------------------------------- #

_PATH_TOKEN = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


def json_path(root: Any, path: str) -> Any:
    """Read a dotted path with numeric indexes: ``languages[0].name``."""
    if path in ("", ".", None):
        return root
    current = root
    for token in _PATH_TOKEN.finditer(str(path)):
        key, index = token.group(1), token.group(2)
        if current is None:
            return None
        if index is not None:
            if not isinstance(current, (list, tuple)) or int(index) >= len(current):
                return None
            current = current[int(index)]
            continue
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def _matches_where(entry: Any, condition: dict[str, Any]) -> bool:
    if not isinstance(entry, dict):
        return False
    actual = json_path(entry, str(condition.get("field", "")))
    if "is_falsy" in condition:
        # `is_falsy: true` keeps the entries whose field is falsy, which is how a
        # hitomi tag that describes a male subject (`male: 1`) is dropped while
        # the ordinary tags (`male: ""`) survive.
        if bool(actual) is not bool(not condition["is_falsy"]):
            return False
    if "equals" in condition and actual != condition["equals"]:
        return False
    if "not_equals" in condition and actual == condition["not_equals"]:
        return False
    if "in" in condition:
        allowed = condition["in"]
        if not isinstance(allowed, list) or actual not in allowed:
            return False
    if "present" in condition and (actual is not None) is not bool(condition["present"]):
        return False
    return True


# --- html element access -------------------------------------------------- #

def _document_for(bag: DocumentBag, selector: dict[str, Any], kind: str) -> Document:
    name = _first(selector.get("document"))
    if name:
        return bag.require(str(name))
    if kind == "json":
        candidates = [d for d in bag.documents.values() if d.format in ("json", "js")]
    else:
        candidates = [d for d in bag.documents.values() if d.format == "html"]
    if len(candidates) != 1:
        raise SelectorError(
            f"a {kind} selector needs an explicit 'document'; "
            f"available: {sorted(d.name for d in bag.documents.values())}"
        )
    return candidates[0]


def _scopes(document: Document, selector: dict[str, Any],
            context: dict[str, Any]) -> list[Element]:
    root = document.html()
    for scope in _as_list(selector.get("scope")) or _as_list(selector.get("in")):
        found = select_all(root, str(_interpolate(scope, context)))
        if found:
            return found
    return [root]


def _elements(document: Document, selector: dict[str, Any], context: dict[str, Any]) -> list[Element]:
    found: list[Element] = []
    seen: set[int] = set()
    targets = _as_list(selector.get("select")) or _as_list(selector.get("selector"))
    if not targets:
        return _scopes(document, selector, context)
    for scope in _scopes(document, selector, context):
        for target in targets:
            for element in select_all(scope, str(_interpolate(target, context))):
                if id(element) not in seen:
                    seen.add(id(element))
                    found.append(element)
    return found


def _element_values(element: Element, selector: dict[str, Any]) -> list[str]:
    """Every candidate value this element offers for the rule.

    A list of attributes yields *all* of them in the declared order rather than
    only the first: a lazy-loaded image often keeps a placeholder in `src` and the
    real URL in `data-src`, and each site's own tooling picked whichever one
    matched. Collecting all of them and letting `filter` choose reproduces that.

    A **named** attribute is read through `ATTR_ALIASES` for the same reason: the rule was learned from
    the page the Builder *captured* (a rendered one) while a crawl reads the page as *served*, and a
    script may have moved the value between the two.
    """
    if selector.get("text"):
        value = element.text()
        return [value] if value else []
    if selector.get("html"):
        value = element.raw_text()
        return [value] if value else []
    named = [str(name) for name in _as_list(selector.get("attr"))]
    if not named:
        named = ["src", "data-src", "data-original", "data-lazy-src", "href"]
    # The rule's own spelling first, then the spellings a script may have moved the value into — each
    # name once, so a rule that already lists both spellings reads two values and not four.
    names: list[str] = []
    for attr in named:
        for name in (attr, *ATTR_ALIASES.get(attr, ())):
            if name not in names:
                names.append(name)
    return [value for value in (element.attr(name) for name in names) if value]


def _apply_filters(values: list[str], selector: dict[str, Any],
                   context: dict[str, Any]) -> list[str]:
    filters = _as_list(selector.get("filter"))
    if not filters:
        return values
    result = []
    for value in values:
        for pattern in filters:
            compiled = re.compile(str(_interpolate(pattern, context)))
            match = compiled.search(value)
            if match is None:
                continue
            group = selector.get("group")
            if group is not None:
                index = int(group)
                if index > len(match.groups()):
                    break
                value = match.group(index)
            result.append(value)
            break
    return result


def first_unique(values_per_row: list[list[str]]) -> list[str | None]:
    """For each row, the first of its values that no other row carries.

    Uniqueness is a property of the *page*, not of a row, so it is decided where every row is
    known — the listing reader — and not by a rule that only ever sees one. Measured on a real
    gallery: a card carries several links under one class, and the work's link is the one whose
    address appears once on the page while the others (a date link, a tag link) repeat on every
    card. Nothing in a single row tells them apart; the whole set does.
    """
    counts: dict[str, int] = {}
    for values in values_per_row:
        for value in values:
            counts[value] = counts.get(value, 0) + 1
    picked: list[str | None] = []
    for values in values_per_row:
        picked.append(next((value for value in values if counts[value] == 1), None))
    return picked


def _absolutize(values: list[str], selector: dict[str, Any],
                document: Document, context: dict[str, Any]) -> list[str]:
    if not selector.get("absolute"):
        return values
    base = document.url or context.get("url") or ""
    return [urljoin(base, value) if base else value for value in values]


def _project(values: list[str], selector: dict[str, Any],
             context: dict[str, Any], transforms: list[str]) -> Any:
    values = _clean_list(values)
    if selector.get("list"):
        return _finish_list(values, selector, context, transforms,
                            offset=int(selector.get("offset", 0)))
    index = selector.get("index")
    if index is None:
        return apply_transforms(_first(values), transforms)
    index = int(index)
    if index < 0 or index >= len(values):
        return None
    return apply_transforms(values[index], transforms)


def _assemble(payload: Any, selector: dict[str, Any]) -> str | None:
    """A value written as a template over the JSON paths that make it up.

    Some sites never publish the address they mean: measured on iwara (2026-10-11), the work's cover is
    `//i.iwara.tv/image/thumbnail/<file id>/thumbnail-05.jpg` in the rendered page while its own API
    holds only the pieces (`file.id`, a `thumbnail` index), so no rule could read it and the cover came
    out empty however well everything else was read.

    A path that reads nothing makes the whole value unreadable rather than a half-built address: a
    template with a hole in it is a wrong URL, and a wrong URL is worse than a field left empty.
    """
    template = str(selector.get("template") or "")
    if not template:
        return None
    missing = False

    def fill(match: re.Match[str]) -> str:
        nonlocal missing
        path, _, fmt = match.group(1).partition(":")
        value = json_path(payload, path)
        if value is None:
            missing = True
            return ""
        if fmt.endswith("d") and isinstance(value, (int, float)):
            # A number as the address spells it: iwara's `thumbnail` is `5` and its own image is
            # `…/thumbnail-05.jpg`, so the template carries the width rather than a literal zero.
            return format(int(value), fmt)
        return str(value)

    assembled = re.sub(r"\{([^{}]+)\}", fill, template)
    if missing or "{" in assembled:
        return None
    return assembled


def _resolve_href_param(value: str, param: str) -> list[str]:
    return list(parse_qs(urlparse(value).query, keep_blank_values=False).get(param, []))


# --- the resolver --------------------------------------------------------- #

def resolve(selector: Any, bag: DocumentBag, *, context: dict[str, Any] | None = None) -> Any:
    """Resolve one selector record. Returns a scalar, a list, or None."""
    if not isinstance(selector, dict):
        raise SelectorError(f"selector must be an object, got {type(selector).__name__}")
    context = dict(context or {})
    missing: MissingDocumentError | None = None
    value = None
    for choice in [selector, *_as_list(selector.get("fallback"))]:
        try:
            value = _resolve_once(choice, bag, context)
        except MissingDocumentError as error:
            # Optional sources (e.g. JSON-LD) need not exist on every work page.
            # Only their absence is recoverable here, not malformed rules or JSON.
            if missing is None:
                missing = error
            notes = context.get("_fallback_notes")
            if isinstance(notes, list):
                notes.append(error.args[0])
            continue
        if not _is_empty(value):
            return value
    if missing is not None:
        # No rule recovered the field: retain the missing-source diagnostic.
        raise missing
    return value


def _is_empty(value: Any) -> bool:
    if value is None or value == "":
        return True
    return isinstance(value, list) and not value


def _resolve_once(selector: dict[str, Any], bag: DocumentBag, context: dict[str, Any]) -> Any:
    value = _resolve_raw(selector, bag, context)
    return _apply_map(value, selector.get("map"))


def _resolve_raw(selector: dict[str, Any], bag: DocumentBag,
                 context: dict[str, Any]) -> Any:
    kind = selector.get("from")
    transforms = _as_list(selector.get("transform"))
    context = {**context, "index": context.get("index", 0)}

    if kind == "const":
        value = selector.get("value")
        return apply_transforms(value, transforms) if isinstance(value, str) else value

    if kind == "card":
        value = json_path(context.get("card") or {}, str(_interpolate(selector.get("field", ""), context)))
        return _project(_as_list(value), selector, context, transforms)

    if kind == "url":
        source = str(context.get("url") or "")
        pattern = _first(selector.get("pattern"))
        if pattern is None:
            return apply_transforms(source or None, transforms)
        match = re.search(str(_interpolate(pattern, context)), source)
        if match is None:
            return None
        template = selector.get("template")
        if template is None:
            return apply_transforms(match.group(1) if match.groups() else match.group(0), transforms)
        # `{1}`/`{2}` reference capture groups; `{0}` is the whole match.
        return apply_transforms(
            re.sub(r"\{(\d+)\}", lambda m: match.group(int(m.group(1))) or "",
                   str(_interpolate(template, context))),
            transforms,
        )

    if kind == "json":
        document = _document_for(bag, selector, "json")
        # A JSON-LD block sits inside a <script>, so the parser never decodes its text and the
        # page's `&amp;` survives into the string. Decode it the way the harvest decodes the
        # candidate it offered: a rule that read a different string than the one the list
        # showed is how a confirm page came to quote a raw address where the picture's own
        # name was expected. Markup and attribute values are decoded by the parser already
        # and must not be decoded twice — see `decode_entities`.
        value = json_path(document.json(), _interpolate(selector.get("path", ""), context))
        return apply_transforms(
            decode_entities(value) if isinstance(value, str) else value,
            transforms,
        )

    if kind == "json_template":
        document = _document_for(bag, selector, "json")
        return apply_transforms(_assemble(document.json(), selector), transforms)

    if kind == "json_length":
        document = _document_for(bag, selector, "json")
        value = json_path(document.json(), _interpolate(selector.get("path", ""), context))
        return len(value) if isinstance(value, (list, tuple, dict, str)) else None

    if kind == "json_list":
        document = _document_for(bag, selector, "json")
        entries = json_path(document.json(), _interpolate(selector.get("path", ""), context))
        if not isinstance(entries, list):
            entries = []
        conditions = _as_list(selector.get("where"))
        take = selector.get("take")
        values = []
        for entry in entries:
            if conditions and not all(_matches_where(entry, condition) for condition in conditions):
                continue
            values.append(json_path(entry, str(take)) if take else entry)
        # Same channel, same decoding: a collection read out of a JSON block carries the
        # page's entities just as a single value does.
        values = [decode_entities(value) if isinstance(value, str) else value for value in values]
        values = _apply_filters(values, selector, context)
        return _finish_list(values, selector, context, transforms,
                            offset=int(selector.get("offset", 0)))

    if kind == "html":
        document = _document_for(bag, selector, "html")
        raw = [
            value
            for element in _elements(document, selector, context)
            for value in _element_values(element, selector)
        ]
        raw = _apply_filters(raw, selector, context)
        raw = _absolutize(raw, selector, document, context)
        return _project(raw, selector, context, transforms)

    if kind == "html_param":
        document = _document_for(bag, selector, "html")
        param = str(selector.get("param") or "")
        if not param:
            raise SelectorError("html_param selector needs a 'param'")
        raw: list[str] = []
        for element in _elements(document, selector, context):
            candidates = _element_values(element, selector)
            href = candidates[0] if candidates else (element.attr("href") or "")
            raw.extend(_resolve_href_param(href, param))
        raw = _apply_filters(raw, selector, context)
        raw = _absolutize(raw, selector, document, context)
        return _project(raw, selector, context, transforms)

    if kind == "meta":
        document = _document_for(bag, selector, "html")
        root = document.html()
        for key in ("name", "property"):
            for wanted in _as_list(selector.get(key)):
                element = select_one(root, f'meta[{key}="{wanted}"]')
                if element is not None and element.attr("content"):
                    return apply_transforms(element.attr("content"), transforms)
        return None

    if kind == "regex":
        document = _document_for(bag, selector, "html")
        flags = re.DOTALL if selector.get("dotall") else 0
        group = int(selector.get("group", 1))
        for pattern in _as_list(selector.get("pattern")):
            match = re.search(str(_interpolate(pattern, context)), document.text, flags)
            if match is None:
                continue
            if match.groups():
                if group > len(match.groups()):
                    continue
                value = match.group(group)
            else:
                value = match.group(0)
            if value:
                return apply_transforms(value, transforms)
        return None

    raise SelectorError(f"unknown selector kind {kind!r}")


def absolute_url(base: str | None, value: str | None) -> str | None:
    """Resolve a possibly-relative URL against the page it was found on."""
    if not value:
        return None
    return urljoin(base, value) if base else value
