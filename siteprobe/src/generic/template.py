"""Loading a site's declarative template.

A site joins the tool by adding one folder under an adapter source holding a ``site.json``
and a ``fetch.py``. Nothing in the generic layer imports a site module by name and
no site adds a branch to shared code, which is the whole point of the merge: the
difference between sites becomes data.

The template declares *what* to read; ``fetch.py`` declares *how to get it*.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# A target is one kind of thing a user can point the tool at. Not every site has
# every kind: hitomi has no folder-style collection, hanime has no artist page.
TARGET_KINDS = ("work", "artist", "folder", "search", "playlist", "album", "favorite")


class TemplateError(RuntimeError):
    pass


@dataclass
class TargetRule:
    kind: str
    url_pattern: re.Pattern[str] | None
    id_group: str | None
    label: str
    # A name-shaped target (hitomi's artist name) has no URL to match; the
    # fetcher decides whether a bare string is acceptable.
    accepts_name: bool = False
    # True when this input is one work rather than a listing to enumerate, so the
    # runner calls the site's read_work directly and never a listing.
    single: bool = False

    def match(self, raw: str) -> dict[str, str] | None:
        # The reading lives in `identity.extract` so the Builder's card narrowing and this agree by
        # construction, not by luck (plan §5-C). A pattern that matches but captures nothing is `None`
        # there — "a listing target pattern must capture an id" is this tool's own rule, measured once
        # as a learned 18comic search target that resolved through no code path at all while the
        # adapter installed and reported success.
        from . import identity

        return identity.extract(raw, self.url_pattern, id_group=self.id_group)


@dataclass
class ListingRule:
    """How to read a paginated listing page into per-item cards."""

    document: str
    row_selector: str
    fields: dict[str, Any] = field(default_factory=dict)
    next_selector: dict[str, Any] | None = None
    page_param: str | None = None
    max_pages: int = 200
    acquisition: str = "http"


@dataclass
class SiteTemplate:
    key: str
    display_name: str
    tool: str
    source_site: str
    export_group: str
    media_id_prefix: str
    hosts: list[str]
    targets: dict[str, TargetRule]
    documents: dict[str, dict[str, Any]]
    listing: ListingRule | None
    listings: dict[str, ListingRule]
    work_fields: dict[str, Any]
    work_constants: dict[str, Any]
    work_defaults: dict[str, Any]
    source_tags_from: str | None
    # How a *work* page is read (`http` or `browser`). Kept apart from a listing's own `acquisition`
    # (plan §5-B.5): a site can read its works over HTTP while a listing needs the browser, or the
    # other way round. Absent means HTTP, so no existing site changes.
    work_acquisition: str
    directory: Path
    raw: dict[str, Any]

    # -- target resolution ------------------------------------------------- #
    def match_target(self, raw: str) -> tuple[str, dict[str, str]] | None:
        """Which target kind does this input name, and what is its id?"""
        raw = raw.strip()
        for kind, rule in self.targets.items():
            matched = rule.match(raw)
            if matched is not None:
                return kind, matched
        return None

    def target(self, kind: str) -> TargetRule | None:
        return self.targets.get(kind)

    def target_label(self, kind: str) -> str:
        rule = self.targets.get(kind)
        return rule.label if rule else kind

    def is_host(self, url: str) -> bool:
        host = (url.split("//", 1)[-1].split("/", 1)[0].split("?")[0]).lower()
        host = host.split("@")[-1].split(":")[0]
        return any(host == allowed or host.endswith("." + allowed) for allowed in self.hosts)


def _require(mapping: dict[str, Any], key: str, where: str) -> Any:
    if key not in mapping:
        raise TemplateError(f"{where}: missing required key {key!r}")
    return mapping[key]


def load_template(path: Path) -> SiteTemplate:
    """Read and validate one ``site.json``."""
    document: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    where = path.name

    targets: dict[str, TargetRule] = {}
    for kind, rule in (document.get("targets") or {}).items():
        if kind not in TARGET_KINDS:
            raise TemplateError(f"{where}: unknown target kind {kind!r}")
        pattern = rule.get("url_pattern")
        targets[kind] = TargetRule(
            kind=kind,
            url_pattern=re.compile(str(pattern), re.IGNORECASE) if pattern else None,
            id_group=rule.get("id_group"),
            label=rule.get("label") or kind,
            accepts_name=bool(rule.get("accepts_name")),
            single=bool(rule.get("single")),
        )

    def build_listing(raw_listing: dict[str, Any]) -> ListingRule:
        return ListingRule(
            document=str(_require(raw_listing, "document", where)),
            # A string, or a rule with a `scope` when the class alone names more than the set.
            row_selector=_require(raw_listing, "row_selector", where),
            fields=dict(raw_listing.get("fields") or {}),
            # The key the Builder writes (`next_selector`), with `next` accepted as the older spelling:
            # reading only `next` meant **every learned listing walked page 1 and stopped** — the rule
            # was in the file and nothing looked it up. Measured on 2026-10-05 against every adapter on
            # disk: none of them carries a `next` key at all, while a learned one carries
            # `next_selector`, and `declarative.list_cards`'s own docstring names `next_selector`.
            next_selector=raw_listing.get("next_selector") or raw_listing.get("next"),
            page_param=raw_listing.get("page_param"),
            max_pages=int(raw_listing.get("max_pages", 200)),
            acquisition=str(raw_listing.get("acquisition") or "http"),
        )

    # One rule per target kind: a site's search page and its collection page have
    # different markup, so they must not share a row rule.
    listings = {
        str(kind): build_listing(raw)
        for kind, raw in (document.get("listings") or {}).items()
    }
    listing_rule = build_listing(document["listing"]) if document.get("listing") else None

    work = document.get("work") or {}
    return SiteTemplate(
        key=str(_require(document, "key", where)),
        display_name=str(document.get("display_name") or document["key"]),
        tool=str(_require(document, "tool", where)),
        source_site=str(document.get("source_site") or document["key"]),
        export_group=str(document.get("export_group") or document["tool"]),
        media_id_prefix=str(document.get("media_id_prefix") or document.get("source_site") or document["key"]),
        hosts=[str(host) for host in (document.get("hosts") or [])],
        targets=targets,
        documents=dict(document.get("documents") or {}),
        listing=listing_rule,
        listings=listings,
        work_fields=dict(work.get("fields") or {}),
        work_constants=dict(work.get("constants") or {}),
        work_defaults=dict(work.get("defaults") or {}),
        source_tags_from=work.get("source_tags_from"),
        work_acquisition=str(work.get("acquisition") or "http"),
        directory=path.parent,
        raw=document,
    )
