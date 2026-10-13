"""Turning a site's raw documents into canonical records.

This module is the generic extractor. It contains no site name, no site selector
and no branch per site: everything it does is driven by the template that the
site's `site.json` provides, which is what makes "a new site is a config file"
true rather than aspirational.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from . import canonical
from .bundle import RawBundle, RawItem
from .canonical import CATEGORY_FIELDS, empty_categories
from .document import Document, DocumentBag
from .htmltree import select_all
from .pages import is_page_address, next_page_parameter, page_number_of
from .select import SelectorError, absolute_url, first_unique, resolve
from .select import _as_list
from .template import SiteTemplate

# Canonical scalar fields a template may produce directly.
#
# `duration` sits beside `page_count` in the T³ record, and it is the one field there that a rule
# cannot be trusted to read: on all five video pages measured (hanime1, missav, jable, yhdm7, nnyy;
# 2026-10-08) the runtime is computed inside the player, and only two of the five publish it in the
# served HTML at all — as `og:video:duration`, in seconds. So: **若为视频，不支持读取时长，请单独适配。**
# The name is accepted here, and through it the export and the T³ import, so such an adapter can
# declare the field itself; the generic learner deliberately proposes nothing for it.
_SCALAR_FIELDS = (
    "title", "detail_url", "date_added", "page_count", "duration",
    "language_code", "language_name",
    "video_url", "author", "keywords_raw",
    "cover_url", "cover_source_filename", "cover_fetch_url",
)
_LIST_FIELDS = ("preview_urls", "source_tags_raw", "tags")

# Site extras the T³ importer understands; anything else a template produces is
# dropped rather than written into the export, so a typo in a template cannot
# quietly pollute the exported schema.
_PASSTHROUGH_FIELDS = ("video_url", "author", "keywords_raw")


def _document_hints(template: SiteTemplate, section: str, name: str) -> dict[str, Any]:
    section_docs = (template.documents or {}).get(section) or {}
    hints = section_docs.get(name)
    if hints is None:
        # A template that omits the declaration still works: the extension of the
        # name says what the document is, and JSON-ish names get the JS wrapper
        # treatment only when the template asked for it.
        return {"format": "json" if name.endswith((".json", ".js")) else "html"}
    return dict(hints)


def build_bag(template: SiteTemplate, item: RawItem, section: str = "work") -> DocumentBag:
    """Wrap one item's raw text in Documents using the template's format hints."""
    bag = DocumentBag()
    for name, text in item.documents.items():
        hints = _document_hints(template, section, name)
        bag.add(Document(
            name=name,
            text=text,
            format=str(hints.get("format", "html")),
            url=item.urls.get(name) or item.target_url,
            json_wrapper=hints.get("json_wrapper"),
        ))
    return bag


def extract_context(template: SiteTemplate, item: RawItem, **extra: Any) -> dict[str, Any]:
    context: dict[str, Any] = {
        "source_id": item.source_id,
        "source_site": template.source_site,
        "url": item.target_url or "",
        "card": item.card,
    }
    # Scalar card values are interpolatable directly, so a template can write
    # `{primary_artist}` without the site supplying any code for it.
    context.update({
        key: value for key, value in item.card.items() if isinstance(value, (str, int, float))
    })
    context.update(extra)
    return context


def extract_work(template: SiteTemplate, item: RawItem) -> dict[str, Any]:
    """One raw item -> one canonical record."""
    bag = build_bag(template, item)
    context = extract_context(template, item)

    values: dict[str, Any] = {}
    fallback_notes: list[str] = []
    for name, rule in template.work_fields.items():
        notes: list[str] = []
        try:
            values[name] = resolve(rule, bag, context={**context, "_fallback_notes": notes})
        except (SelectorError, KeyError, ValueError) as error:
            # A site redesign must degrade to a missing field, never abort a run
            # that already downloaded hundreds of pages.
            values[name] = None
            context.setdefault("_errors", {})[name] = str(error)
        fallback_notes.extend(f"{name}: {note}" for note in notes)

    for name, value in template.work_constants.items():
        values.setdefault(name, value)

    categories = empty_categories()
    for rule_name, canonical_key in CATEGORY_FIELDS.items():
        categories[canonical_key] = _as_members(values.get(rule_name))

    tags = categories["分类标签"]
    source_tags = values.get("source_tags_raw")
    if template.source_tags_from:
        source = categories.get(template.source_tags_from) or []
        source_tags = list(source) if source else source_tags
    record: dict[str, Any] = {
        "source_site": template.source_site,
        "source_id": item.source_id,
        "title": canonical.normalize_text(values.get("title")),
        "detail_url": _absolute(template, values.get("detail_url")) or item.target_url,
        "分类信息": categories,
        "language": {
            "code": values.get("language_code"),
            "name": values.get("language_name"),
        },
        "date_added": values.get("date_added") or None,
        "page_count": _as_int_or_none(values.get("page_count")),
        # Written as the page spells it — `1:02:36`, `13:25`, or a plain count of seconds — because
        # the T³ importer is the one place that format is parsed. A second implementation of the same
        # format here is how two readers of one field drift apart.
        "duration": values.get("duration") or None,
        "cover": canonical.cover_record(
            prefix=template.media_id_prefix,
            source_id=item.source_id,
            url=_absolute(template, values.get("cover_url")),
            source_path_key=str(template.raw.get("cover_source_path_key") or "url"),
        ),
        "preview_images": canonical.preview_records(
            prefix=template.media_id_prefix,
            source_id=item.source_id,
            urls=[url for url in (_absolute(template, value)
                                 for value in _as_members(values.get("preview_urls"))) if url],
        ),
        # `source_tags_raw` is accepted + pending; `tags` is accepted only. Both
        # are filled in by the tag policy step, so raw text is the starting point.
        "source_tags_raw": list(source_tags or tags),
    }
    fetch_url = values.get("cover_fetch_url")
    if fetch_url and record["cover"] is not None:
        record["cover"]["fetch_url"] = fetch_url
    if values.get("cover_source_filename"):
        if record["cover"] is not None:
            record["cover"]["source_filename"] = values["cover_source_filename"]
    for name in _PASSTHROUGH_FIELDS:
        if values.get(name):
            record[name] = values[name]
    # Extra record keys a site declares, e.g. hanime's playlist title which the
    # listing card knows and the manifest wants.
    for name in template.raw.get("work", {}).get("passthrough", []) or []:
        if values.get(name) not in (None, "", [], {}):
            record[str(name)] = values[name]

    record["diagnostics"] = diagnostics(values, record, item)
    record["diagnostics"]["warnings"].extend(fallback_notes)
    # An absent key is what the importer's `optional` fields mean; an explicit
    # `null` only works where the schema also says `nullable`, which differs from
    # site to site. Omitting is therefore both correct everywhere and cleaner.
    return {key: value for key, value in record.items() if value is not None}


def diagnostics(values: dict[str, Any], record: dict[str, Any],
                item: RawItem) -> dict[str, Any]:
    """What the extractor could and could not find.

    The old per-site tools each grew their own diagnostics block. Keeping one
    generic block means a template that silently stops matching is visible in the
    export instead of producing empty records that look like real ones.
    """
    resolved = sorted(name for name, value in values.items() if value not in (None, "", [], {}))
    unresolved = sorted(name for name, value in values.items() if value in (None, "", [], {}))
    warnings: list[str] = []
    if not record.get("title"):
        warnings.append("title was not found")
    if not record.get("cover"):
        warnings.append("cover was not found")
    if not record["分类信息"]["作者"]:
        warnings.append("no author found; 分类信息.作者 left empty")
    if not record["preview_images"]:
        warnings.append("no preview images found")
    return {
        "extractor": "generic",
        "documents": sorted(item.documents),
        "resolved": resolved,
        "unresolved": unresolved,
        "warnings": warnings,
    }


def _as_members(value: Any) -> list[str]:
    """A list field's members, however the template produced them.

    Single-valued sites must not be exploded: hitomi's `type` is one string, and `list("doujinshi")`
    is one category per *character*. The previews have the same shape — a rule that reads one picture
    returns one address — and measured on buondua (2026-10-10) iterating that string gave the record
    179 "preview images" whose urls were `'h'`, `'t'`, `'t'`, `'p'`…, so the round trip reported a
    disagreement that was only ever the record's own shape and refused to install the adapter.
    """
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [value]
    return [str(item) for item in value if item not in (None, "")]


def _as_int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, int):
        return value
    match = re.search(r"\d+", str(value))
    return int(match.group(0)) if match else None


# --- listing pages -------------------------------------------------------- #


def narrowed(value: str | None, selector: dict[str, Any]) -> str | None:
    """One value, after the rule's `filter` and `group` have had their say.

    Split out because the `unique` pass has to apply them *after* choosing between values
    rather than before: the filter decides what an address means, and uniqueness decides
    which address is worth reading.
    """
    if value is None:
        return None
    filters = _as_list(selector.get("filter"))
    for pattern in filters:
        match = re.search(str(pattern), value)
        if match is None:
            continue
        group = selector.get("group")
        if group is None:
            return value
        index = int(group)
        if index > len(match.groups()):
            return value
        return match.group(index)
    return None if filters else value


def extract_listing_page(template: SiteTemplate, document_name: str, text: str,
                         url: str | None,
                         kind: str | None = None) -> tuple[list[dict[str, Any]], str | None]:
    """Read one listing page into cards, plus the URL of the next page.

    This is what makes the listing half generic: a site whose collection page is
    server-rendered HTML describes its cards in `site.json` and gets pagination
    for free. A site with an exotic index (hitomi's binary nozomi) skips this and
    builds its items in its own fetcher.
    """
    rule = (template.listings.get(kind) if kind else None) or template.listing
    if rule is None:
        raise SelectorError(f"{template.key}: no listing rule declared for {kind or 'the listing'}")
    hint = (template.documents.get("listing") or {}).get(document_name) or {}
    bag = DocumentBag()
    bag.add(Document(
        name=document_name,
        text=text,
        format=str(hint.get("format", "html")),
        url=url,
        json_wrapper=hint.get("json_wrapper"),
    ))

    cards: list[dict[str, Any]] = []
    root = bag.require(document_name).html()
    rows = rows_of(root, rule.row_selector)

    def read(row, selector: dict[str, Any]) -> Any:
        # Each field rule sees one row as its whole document, so a listing field
        # and a work field are written in exactly the same selector vocabulary.
        scoped = DocumentBag()
        scoped.add(Document.from_element(document_name, row, url))
        return resolve(selector, scoped, context={"url": url or "", "card": {}})

    # A field whose rule says `unique` is decided across the rows, not inside one: a card
    # may carry several links under one class, and the one that names the work is the one
    # whose address appears once on the page. So every candidate in every row is read, the
    # value that repeats is dropped, and the filter that turns the address into an id is
    # applied to what is left.
    unique_fields = {name: selector for name, selector in rule.fields.items()
                     if isinstance(selector, dict) and selector.get("unique")}
    picked: dict[str, list[str | None]] = {}
    if unique_fields:
        for name, selector in unique_fields.items():
            probe = {key: value for key, value in selector.items()
                     if key not in ("filter", "group", "unique", "list")}
            per_row = [[str(value) for value in _as_list(read(row, {**probe, "list": True}))]
                       for row in rows]
            picked[name] = [narrowed(value, selector) for value in first_unique(per_row)]

    for index, row in enumerate(rows):
        card: dict[str, Any] = {}
        for name, selector in rule.fields.items():
            value = read(row, selector)
            if name in picked:
                value = picked[name][index]
            card[name] = value
        if card.get("source_id"):
            cards.append(card)

    next_url = None
    if rule.next_selector is not None:
        # The rule belongs to the page being read, so it defaults to that page's
        # document; naming one explicitly is only needed for odd layouts.
        selector = dict(rule.next_selector)
        if selector.pop("page_numbers", False):
            # A pager that only lists numbers (`01 02 03 …`) says nothing about *which* one is next:
            # the link's own text is the number, and the page being read decides which number is one
            # past. Measured on a jable.tv model page (2026-10-05) whose pager swaps the list in place
            # — the address bar never changes, so a person cannot paste a second address at all.
            next_url = _next_numbered_page(selector, bag, url, document_name)
        else:
            selector.setdefault("document", document_name)
            next_url = resolve(selector, bag, context={"url": url or ""})
    if next_url is None and rule.page_param:
        # A URL-parameter pager: the next page is this address with that parameter one higher. The
        # Builder has written `page_param` since Phase 7 and nothing ever read it, so a learned
        # listing whose pages differ by `?page=` walked page 1 and stopped, exactly like the
        # `next_selector` above did through its own key.
        next_url = next_page_parameter(rule.page_param, url)
    next_url = absolute_url(url, next_url) if next_url else None
    return cards, next_url


def rows_of(root: Any, row_selector: Any) -> list[Any]:
    """The rows a listing rule names: a class, or a class read inside the block that holds the set.

    A class is shared across a page often enough that a set cannot always be named by it alone —
    measured on a jable.tv model page (2026-10-05), whose tag cloud and video list both write
    `div.col-6.col-sm-4` and where the videos carry no class the tags lack. The rule then carries the
    block as `scope` (the selector vocabulary's own word), and the rows are read inside it — the same
    rows the person was shown when they picked the set.
    """
    if isinstance(row_selector, dict):
        scope = str(row_selector.get("scope") or row_selector.get("in") or "")
        select = str(row_selector.get("select") or "")
        roots = select_all(root, scope) if scope else [root]
        return [element for node in roots for element in select_all(node, select)]
    return select_all(root, str(row_selector))


def _next_numbered_page(selector: dict[str, Any], bag: DocumentBag, url: str | None,
                        document_name: str) -> str | None:
    """The pager's own next number: the link whose number is one past the page being read.

    The page's own number comes from the address it was fetched at (`…/2/`, or a page parameter); the
    links carry theirs as text, so the two are compared as numbers rather than by position — a pager
    that shows `01 02 03 …` lists the *next* one somewhere in the middle on later pages.
    """
    current = page_number_of(url) or 1
    document = bag.require(document_name)
    target = str(selector.get("select") or "a[href]")
    attribute = str(selector.get("attr") or "href")
    for element in select_all(document.html(), target):
        text = element.text().strip()
        if not text.isdigit() or int(text) != current + 1:
            continue
        href = element.attr(attribute)
        if href and is_page_address(url or "", absolute_url(url, href) or "", int(text)):
            return href
    return None


def extract_bundle(template: SiteTemplate, bundle: RawBundle) -> list[dict[str, Any]]:
    return [extract_work(template, item) for item in bundle.items]


def _absolute(template: SiteTemplate, value: Any) -> str | None:
    """Resolve a site-relative URL against the origin the template declares.

    Hitomi stores image and gallery URLs as site-relative paths, and each old
    tool joined them by hand. One declared `url_base` normalises every URL in the
    record instead, so a template never has to spell out the origin repeatedly.
    """
    if not value:
        return None
    base = str(template.raw.get("url_base") or "")
    return absolute_url(base, str(value))
