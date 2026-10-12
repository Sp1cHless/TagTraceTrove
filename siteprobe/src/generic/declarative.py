"""Reading a work from `site.json` alone — the declarative adapter.

A site whose fields can all be read out of the markup and the page's own structured
data does not need a Python module at all. This is the reader such a site uses, and
the reason a generated adapter can be a config file plus a two-line shim:

    <adapter dir>/fetch.py   from src.generic.declarative import read_work

It lives in the generic layer rather than beside the Builder, because an installed
adapter importing the Builder would make the runtime depend on its own authoring
tool. The Builder only writes a `site.json` this module can run; the runtime never
needs the Builder to be present.

Which documents it offers is a deliberate, short list — the same list the Builder's
round trip checks against, because a rule that names a document this reader cannot
produce is a rule that cannot run:

    page       the markup, always
    jsonld     the page's JSON-LD blocks, when the template declares the document
    <name>     any other declared document, fetched by the template's own recipe

The recipe exists because an API-backed site is common: the work's data is in a
response the page fetched, and a rule reads it by path. Deriving such a recipe
automatically is what the Builder's network log is for; declaring one by hand is
what this reader supports today.
"""

from __future__ import annotations

import json
import re
from typing import Any

from . import acquisition
from . import diagnostics as diag
from . import unknown_url
from .bundle import RawItem
from .extract import extract_listing_page
from .template import SiteTemplate

PAGE = "page"
JSONLD = "jsonld"


def declared_documents(template: SiteTemplate) -> dict[str, dict[str, Any]]:
    """The documents this template declares for reading a work."""
    section = (template.documents or {}).get("work") or {}
    return {str(name): dict(spec or {}) for name, spec in section.items()}


def producible_documents(template: SiteTemplate) -> set[str]:
    """The documents this reader can produce for a site, whatever the page holds.

    Not the same as "what the template declares": a declared document with no request
    recipe is one nothing will ever fetch. And not "what it produces for an empty
    page" either, which is how every JSON-LD rule came to be reported unrunnable —
    `jsonld` is built from the page's own text, so a blank page produces none.
    """
    producible = {PAGE, JSONLD}
    for name, spec in declared_documents(template).items():
        if spec.get("request"):
            producible.add(name)
    return producible


def documents_from(template: SiteTemplate, text: str) -> dict[str, str]:
    """The documents a declarative adapter can offer for one fetched page.

    `page` is always there. `jsonld` carries the page's JSON-LD blocks as JSON,
    which is what makes a `json {document: jsonld}` rule executable at all —
    without it such a rule names a document nothing produces.
    """
    documents: dict[str, str] = {}
    declared = declared_documents(template)
    if PAGE in declared or not declared:
        documents[PAGE] = text
    if JSONLD in declared:
        for node in unknown_url.jsonld_nodes(text):
            documents[JSONLD] = json.dumps(node)
            break
    return documents


def request_documents(template: SiteTemplate, url: str) -> dict[str, str]:
    """Documents fetched by recipe: a declared URL with the page's id substituted.

    A recipe is `{"name": {"request": "https://api.example/work/{id}",
    "from": "target"}}`, and `{id}` comes from the target's own match on the URL, so
    the same recipe works for every work of the site.
    """
    documents: dict[str, str] = {}
    matched = template.match_target(url)
    identifiers = dict(matched[1]) if matched else {}
    for name, spec in declared_documents(template).items():
        recipe = spec.get("request")
        if not isinstance(recipe, str) or not recipe:
            continue
        try:
            rendered = re.sub(
                r"\{(\w+)\}",
                lambda found: str(identifiers.get(found.group(1), found.group(0))),
                recipe,
            )
        except re.error:  # pragma: no cover - a malformed recipe is a config error
            continue
        if "{" in rendered:
            # An identifier the target's pattern does not capture: nothing to fetch.
            continue
        try:
            status, body, _kind, _final = unknown_url.fetch(rendered, referer=url)
        except Exception:  # noqa: BLE001 - a missing document is reported by the field
            continue
        if status == 200 and body:
            documents[name] = body.decode("utf-8", "replace")
    return documents


def list_cards(template: SiteTemplate, kind: str, ref: dict[str, str],
               options: dict[str, Any]) -> list[dict[str, Any]]:
    """The cards a listing page holds, read through the runtime's own listing reader.

    A learned listing adapter is a `site.json` with a row rule in it and no Python at all, so this
    hook is what makes one crawlable: without it the reader offered no card listing, and the runner
    answered "offers neither a review step nor card listing" — measured on a real buondua tag page
    (2026-09-22), whose rules had been learned and verified offline in Phase 7 and could never be
    run. Reading goes through `extract_listing_page`, the same call the Builder's acceptance check
    uses, so what a person sees here is what that check verified.

    Pagination is the rule's own (`next_selector` / `page_param`), and a page that repeats a card
    ends the walk: a site whose "next" link stays put would otherwise loop until `max_pages`.

    Acquisition goes through the shared engine (`acquisition.session`), so the rule's declared mode is
    honoured — `browser` reads the rendered page, `http` the markup as sent — and, for a browser rule,
    **one** context reads every page of the walk instead of a fresh browser per page (plan §5-B.4).
    """
    rule = template.listings.get(kind) or template.listing
    if rule is None:
        raise ValueError(f"{template.key}: no listing rule is declared for {kind!r}")
    url = str(options.get("target_url") or ref.get("url") or ref.get("id") or "")
    if not url.startswith(("http://", "https://")):
        raise ValueError(f"{template.key}: {kind} {ref.get('id')!r} has no address to list")

    plan = acquisition.plan_for(rule.acquisition, profile=options.get("profile_dir"))
    progress = options.get("progress") or (lambda _message: None)
    cards: list[dict[str, Any]] = []
    seen: set[str] = set()
    page_url: str | None = url
    with acquisition.session(plan) as reader:
        for page in range(1, max(1, min(rule.max_pages, options.get("max_pages", rule.max_pages))) + 1):
            read = reader.read(page_url)
            if not read.readable:
                finding = (diag.acquisition_failed(kind=kind, url=page_url,
                                                   detail="; ".join(read.notes))
                           if read.status is None or not 200 <= read.status < 300
                           else diag.acquisition_empty(kind=kind, url=page_url))
                raise diag.DiagnosticError("the listing page could not be acquired", [finding])
            text = read.html
            final = read.final_url or page_url
            found, next_url = extract_listing_page(template, rule.document, text,
                                                   final or page_url, kind)
            faults = diag.blocking_findings(diag.classify_cards(found, target_kind=kind,
                                                               url=page_url))
            if found and faults:
                raise diag.DiagnosticError("the listing contains invalid work identities", faults)
            fresh = [card for card in found
                     if not card.get("source_id") or str(card["source_id"]) not in seen]
            for card in fresh:
                if card.get("source_id"):
                    seen.add(str(card["source_id"]))
            cards.extend(fresh)
            progress(f"listed page {page}: {len(fresh)} new card(s), {len(cards)} in total")
            if not next_url or not fresh:
                break
            page_url = next_url
    return cards


def list_work_urls(template: SiteTemplate, kind: str, ref: dict[str, str],
                   options: dict[str, Any]) -> list[str]:
    """The **addresses** of the works a listing holds, so a learned listing can be crawled.

    `site_api` asks a site for this hook and refuses to enumerate without it ("its fetch.py has no
    list_work_urls, so it only supports a single work URL") — measured with the bilinovel listing
    adapter installed (2026-10-04), whose cards the runtime could already read (30 of them, ids
    distinct) while `probe.py <listing URL>` would not walk them. The addresses come from the same
    cards the review page shows, so the crawl and the page cannot disagree about what a listing
    holds.
    """
    urls: list[str] = []
    for card in list_cards(template, kind, ref, options):
        address = str(card.get("detail_url") or card.get("url") or "")
        if address:
            urls.append(address)
    return urls


def read_work(template: SiteTemplate, url: str, options: dict[str, Any] | None = None):
    """One work, read from the template alone. Returns a RawItem, or None.

    None means the page could not be read as a work at all — a status the caller reports rather than a
    half-filled record.

    Acquisition is the template's own `work.acquisition` (plan §5-B.5): a work whose fields were
    learned from rendered markup is read through the browser, while a listing of the same site may
    still be read over HTTP — the two halves keep their own mode. Absent, it is HTTP, so no existing
    site changes.
    """
    options = options or {}
    plan = acquisition.plan_for(template.work_acquisition, profile=options.get("profile_dir"))
    read = acquisition.read_page(url, plan)
    if not read.readable:
        return None

    text = read.html
    matched = template.match_target(url)
    if matched is not None and matched[1].get("id"):
        source_id = str(matched[1]["id"])
    else:
        # No pattern captured an id, so the address is the identity. The last path
        # segment is stable for a working target and costs nothing to fall back to.
        source_id = (read.final_url or url).rstrip("/").rsplit("/", 1)[-1] or "work"

    item = RawItem(source_id=source_id, target_url=read.final_url or url)
    for name, document in {**documents_from(template, text),
                           **request_documents(template, url)}.items():
        item.add(name, document)
    return item
