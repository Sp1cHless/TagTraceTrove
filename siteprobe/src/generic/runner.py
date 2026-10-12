"""One run: resolve input -> acquire -> extract -> tag review -> write.

The runner holds no site knowledge. It asks the registry which site an input
belongs to, calls that site's fetcher for raw documents, applies that site's
declarative template, and writes the result in that site's export group. Every
site-specific decision was made before this module runs.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import canonical, crawl_state, export_layout, media, review, review_media, select, site_api, taxonomy
from . import diagnostics as diag
from .bundle import RawBundle
from .extract import extract_work
from .registry import get_for as get_site_for
from .registry import RegistryError, load_fetcher, resolve_input, templates_for
from .site_api import collect_items, work_listing_name
from . import registry
from .template import SiteTemplate
from .registry import adapter_root

# The directory that **contains** `export/` — the tool's home, not the export tree itself. Every
# writer goes through `export_layout.site_root(project_root, …)`, which appends `export/<group>`, so
# this constant being the export tree doubled the path into `<home>/export/export/<group>/`: the
# crawl put its listing and a fresh empty dictionary there while the migrated dictionary and tag
# sheet — and `应用Tag审核`, which scans `<home>/export/<group>/` — stayed where they were. Nothing
# caught it until a real run through T³ was read back, because no listing had been written through
# this home before and every test built its own project root.
PROJECT_ROOT = adapter_root()


@dataclass
class RunOptions:
    raw_input: str
    # Scan for review instead of downloading: the run stops after writing
    # works.json / review.html, and the picks are fetched later from a selection.
    review: bool = False
    site_key: str | None = None
    target_kind: str | None = None
    name: str | None = None
    limit: int | None = None
    refresh: bool = False
    offline_dir: Path | None = None
    with_media: bool = True
    dry_run: bool = False
    project_root: Path = PROJECT_ROOT
    workers: int = 4
    max_pages: int | None = None
    progress: Callable[[str], None] = field(default=lambda message: print(message, flush=True))


@dataclass
class RunResult:
    template: SiteTemplate
    target_kind: str
    target_ref: str
    listing_dir: Path
    records: list[dict[str, Any]]
    origin: dict[str, Any] | None
    warnings: list[str]
    media_stats: dict[str, int] = field(default_factory=dict)
    # Set when the run scanned for review instead of downloading.
    review_html: Path | None = None
    review_summary: dict[str, Any] = field(default_factory=dict)
    # Structured reasons a stage produced nothing a caller can act on (plan §4.1). Always present,
    # so a caller reads `findings.length` rather than testing for the key's existence.
    findings: list[diag.Finding] = field(default_factory=list)
    # The cards a review run listed, so a probe can pick one whose `detail_url` names a work to read.
    # Empty for a download run, whose product is the records.
    cards: list[dict[str, Any]] = field(default_factory=list)

    @property
    def record_count(self) -> int:
        return len(self.records)


def resolve(options: RunOptions) -> tuple[SiteTemplate, str, dict[str, str]]:
    """Which site and target kind, honouring an explicit --site override.

    The override asks for the adapter that **declares the requested kind**, not merely the one that
    wins the key (`registry.get_for`, not `registry.get`). Those differ on any domain with two
    files: a rule set the Builder learned for 18comic's search page carries the same key as the
    written adapter and outranks it, so `--site 18comic.vip --kind album` used to fail with "it
    accepts: search" while the album reader sat beside it on disk — and the menu T³ builds from
    `integration sites` reports album for that key, so the caller was being told to ask for
    something the tool then refused.
    """
    if options.site_key:
        text = options.raw_input.strip()
        # No kind asked for — the question is only "does this site claim this address, and as what".
        # Answered from whichever file of that key can read it: the key-priority file is not always
        # the reader (18comic's learned search rule set wins the key while the written adapter beside
        # it reads the albums), and answering with the winner made a real album address come back as
        # "it accepts: search" — measured through the app on 2026-09-22.
        if not options.target_kind:
            capable = _template_that_reads(options.site_key, None, text)
            if capable is not None:
                capable_template, capable_kind, capable_ref = capable
                return capable_template, capable_kind, capable_ref
            fallback = get_site_for(options.site_key, None)
            raise ValueError(
                f"{text!r} is not a target {fallback.key} recognizes; "
                f"it accepts: {', '.join(fallback.targets)}"
            )
        template = get_site_for(options.site_key, options.target_kind)
        matched = template.match_target(text)
        if matched is None:
            if options.target_kind and options.target_kind in template.targets:
                # A capability one of the site's adapters has is a capability of the site. Two files
                # share a key, and the one that wins the key is not always the one that reads this
                # kind of input: measured on 18comic, the learned file declares its search without
                # `accepts_name` while the written adapter beside it turns a keyword into a search
                # URL — so a keyword used to be refused for a site that can search by keyword.
                # Whichever file can serve the input is the one that reads it, the same rule
                # `registry.site_for_url` already follows for addresses.
                capable = _template_that_reads(options.site_key, options.target_kind, text)
                if capable is not None:
                    capable_template, _capable_kind, capable_ref = capable
                    return capable_template, options.target_kind, capable_ref
                rule = template.targets[options.target_kind]
                # An explicit kind is a promise about what the answer is, so it is checked rather
                # than assumed. Accepting any string here is how a page of the wrong shape (a
                # homepage, another site's URL, a search address pasted for a work) turned into a
                # crawl that failed much later with a message about a field, not about the input.
                # `INVALID_INPUT`, not a run failure: the input is what is wrong, and a caller
                # that shows "please report this bug" for a mistyped address is worse than one
                # that just asks again.
                if _looks_like_an_address(text):
                    raise RegistryError(
                        f"{text!r} does not look like {template.key}'s {rule.label} page "
                        f"({options.target_kind})",
                        "INVALID_INPUT",
                    )
                if not rule.accepts_name:
                    raise RegistryError(
                        f"{options.target_kind} of {template.key} ({rule.label}) needs an address; "
                        f"only a kind that accepts a name takes a bare value, and "
                        f"{template.key} accepts names for: "
                        f"{', '.join(sorted(k for k, r in template.targets.items() if r.accepts_name)) or 'none'}",
                        "INVALID_INPUT",
                    )
                ref = _ref_for(template, options.target_kind, text)
                return template, options.target_kind, ref
            raise ValueError(
                f"{text!r} is not a target {template.key} recognizes; "
                f"it accepts: {', '.join(template.targets)}"
            )
        return template, matched[0], matched[1]
    return resolve_input(options.raw_input)


def _template_that_reads(site_key: str, kind: str | None,
                         text: str) -> tuple[SiteTemplate, str, dict[str, str]] | None:
    """The adapter of this site that can actually read this input, and as what.

    Tried across every file the key has, best-first, over the kinds that were asked for — every kind
    the file declares when none was (`kind=None`), which is the shape of "what is this address?".
    A URL that is another kind's page is not a match for this one.
    """
    for candidate in templates_for(site_key):
        kinds = [kind] if kind else sorted(candidate.targets)
        for candidate_kind in kinds:
            rule = candidate.targets.get(candidate_kind)
            if rule is None:
                continue
            matched = candidate.match_target(text)
            if matched is not None and matched[0] == candidate_kind:
                return candidate, candidate_kind, matched[1]
            if not _looks_like_an_address(text) and rule.accepts_name:
                return candidate, candidate_kind, {"id": text, "user": text}
    return None


def _looks_like_an_address(text: str) -> bool:
    """Whether this is meant to be a URL rather than a name.

    Deliberately loose: the scheme is the one thing every address has and no site's name does, and a
    stricter test would send a mistyped address down the name path — where it would be accepted as a
    name for a kind that takes them, which is the same silent wrong answer by another door.
    """
    return text[:7].casefold() == "http://" or text[:8].casefold() == "https://"


def _ref_for(template: SiteTemplate, kind: str, raw_input: str) -> dict[str, str]:
    matched = template.match_target(raw_input)
    if matched is not None:
        return matched[1]
    return {"id": raw_input.strip(), "user": raw_input.strip()}


def listing_name(template: SiteTemplate, kind: str, ref: dict[str, str],
                 options: RunOptions) -> str:
    """The folder name for this run, matching each site's existing convention."""
    conventions = (template.raw.get("naming") or {})
    pattern = conventions.get(kind) or "{kind}_{id}"
    values = {**ref, "kind": kind, "name": options.name or ref.get("id", "")}
    try:
        return pattern.format(**values)
    except KeyError:
        return f"{kind}_{ref.get('id', 'listing')}"


def run(options: RunOptions) -> RunResult:
    # Freeze the run's clock once (plan §5-D.2): a relative date read a minute apart must not become a
    # different day if the run crosses midnight, and every date this run writes is measured from here.
    select.freeze_clock()
    template, target_kind, ref = resolve(options)
    options.progress(f"site: {template.key} ({template.display_name}) kind: {target_kind}")
    if not ref.get("id") and not ref.get("user"):
        raise ValueError(f"could not determine an identifier from {options.raw_input!r}")

    target_url = options.raw_input.strip()
    is_single_work = bool(template.targets[target_kind].single) if target_kind in template.targets else False
    listing_name_value = (
        work_listing_name(template, options) if is_single_work
        else listing_name(template, target_kind, ref, options)
    )
    listing = export_layout.listing_dir(options.project_root, template, listing_name_value)
    if options.dry_run:
        options.progress(f"dry run: would write to {listing}")

    fetcher = load_fetcher(template)
    if not target_url.startswith(("http://", "https://")):
        target_url = site_api.listing_url(fetcher, template, target_kind, ref, target_url)

    if options.review:
        scan_options = dict(site_api.iter_options(options, listing, template))
        scan_options.update({"export_dir": listing, "workers": options.workers})
        if options.max_pages is not None:
            scan_options["max_pages"] = options.max_pages
        options.progress(f"scanning for review into {listing}")
        scanner = site_api.optional_scan_review(fetcher)
        # A site's own review only handles the kinds it was built for; it declines
        # the rest, and those get the generic card-based page below.
        scanned = scanner(template, target_kind, ref, scan_options) if scanner else None
        cards: list[dict[str, Any]] = []
        findings: list[diag.Finding] = []
        if scanned is not None:
            review_html = Path(scanned["review_html"])
            summary = dict(scanned.get("summary") or {})
            warnings = list(scanned.get("warnings") or [])
        else:
            # No review of its own: build the generic page from the listing's own
            # cards, so a few hundred results cost a few requests and no work's
            # detail page is fetched before the user has chosen.
            cards_hook = site_api.optional_list_cards(fetcher)
            if cards_hook is None:
                raise ValueError(
                    f"site {template.key!r} offers neither a review step nor card "
                    f"listing, so its results cannot be reviewed before download"
                )
            scan_options["export_dir"] = listing
            # The address the target resolved to: a learned listing declares no URL recipe, so the
            # page it lists is the one the person asked for.
            scan_options["target_url"] = target_url
            cards = list(cards_hook(template, target_kind, ref, scan_options))
            # The same states the Builder checks over its own cards, asked again where the *data* is
            # produced: a rule set that slipped past the authoring check must not pass silently here.
            findings = diag.classify_cards(cards, target_kind=target_kind, url=target_url)
            if diag.blocking_findings(findings):
                raise diag.DiagnosticError("the listing has no valid, distinct work identities",
                                           findings=findings)
            if options.limit:
                cards = cards[: options.limit]
            if not cards:
                raise diag.DiagnosticError(
                    f"nothing was listed for {target_kind} {ref.get('id')}", findings=findings)
            meta = {
                "source_site": template.source_site,
                "target_kind": target_kind,
                "target_ref": ref.get("id") or ref.get("user") or "",
                "target_ref_fields": ref,
                "listing": listing.name,
                "source_url": target_url,
                # A site declares how its tags spell a language; a site without the
                # convention declares none and the page simply hides the filter.
                "language_tags": (template.raw.get("review") or {}).get("language_tags") or {},
            }
            # The page needs covers it can show; a remote URL is not that, for
            # reasons that differ per site and are handled by one download here.
            if options.with_media:
                review_media.localize_covers(cards, listing, template, options.progress)
            review_html = review.write_review(listing, cards, meta)
            # `count` is the one key every review carries, whatever the site calls it; `cards`
            # stays as the generic shape it always was.
            summary = {"cards": len(cards), "count": len(cards)}
            warnings = []
            options.progress(f"{len(cards)} card(s) written to the review page")
        options.progress(f"review page: {review_html}")
        options.progress(
            "open it, pick works, export the selection, then drag the "
            "selection JSON onto 下载selection.bat"
        )
        return RunResult(
            template=template,
            target_kind=target_kind,
            target_ref=ref.get("id") or ref.get("user") or "",
            listing_dir=listing,
            records=[],
            origin=None,
            warnings=warnings,
            review_html=review_html,
            review_summary=summary,
            findings=findings,
            cards=cards,
        )

    # A download run fetches only what the listing does not already hold. A review
    # run lists everything on purpose: choosing what to keep means seeing what is
    # there, including the works already on disk.
    local_ids = crawl_state.local_work_ids(
        listing,
        crawl_state.recorded_ids(export_layout.site_root(options.project_root, template),
                                 target_kind, ref.get("id") or ref.get("user") or ""),
    )
    skip: set[str] = set()
    # A listing is crawled in passes, so what is already on disk is skipped. A single
    # work is not: the person asked for *this* work, and `sole_work` keeps every work it
    # ever read, so the requested one is always "already on disk" and would never be read
    # again — measured as an empty review after re-importing the same link.
    if not options.review and not options.refresh and local_ids and not is_single_work:
        skip = local_ids
        options.progress(f"{len(local_ids)} work(s) already in {listing.name}")

    items, warnings, listed_ids = collect_items(
        fetcher, template, target_kind, ref, target_url, options, listing, options.progress,
        single=is_single_work,
        limit=options.limit,
        skip_source_ids=skip,
    )
    options.progress(f"read {len(items)} work document(s)")

    bundle = RawBundle(
        template_key=template.key,
        target_kind=target_kind,
        target_ref=ref.get("id") or ref.get("user") or "",
        target_url=target_url,
        display_name=options.name,
        items=items,
        warnings=warnings,
    )

    records = [extract_work(template, item) for item in bundle.items]
    # A record missing its identity cannot be imported, and writing it would make
    # the whole manifest unreadable rather than just that one work — T³ validates
    # every item in a manifest together. Drop it here, loudly, and keep the rest.
    usable: list[dict[str, Any]] = []
    dropped: list[tuple[str, list[str]]] = []
    for record in records:
        missing = canonical.missing_fields(record)
        if missing:
            dropped.append((str(record.get("source_id") or ""), list(missing)))
            bundle.warnings.append(
                f"work {record.get('source_id') or '?'}: the page did not contain the "
                f"work's data (missing {', '.join(missing)}); skipped"
            )
            continue
        usable.append(record)
    records = usable

    # Why this run produced what it did, as data (plan §4.1): a required field no page answered, a
    # repeated id, and a listing that named no work are the three states the first batch exists to
    # stop hiding behind a friendly sentence.
    findings = diag.classify_records(records, target_kind=target_kind, dropped=dropped,
                                    expect_cover="cover_url" in template.work_fields)
    duplicate_faults = [finding for finding in findings if finding.code == "SOURCE_ID_DUPLICATED"]
    if duplicate_faults:
        raise diag.DiagnosticError("the export contains repeated work identities", duplicate_faults)
    if not items:
        if is_single_work:
            findings.append(diag.acquisition_empty(kind=target_kind, url=target_url))
        elif not skip:
            findings.append(diag.listing_rows_empty(kind=target_kind, url=target_url))
    if not records and not skip and not options.dry_run:
        # Nothing survived to be exported: the listing named no work, or every work it named was
        # unreadable. An empty export that still reports success is exactly the state the plan's
        # §5-A completion criterion forbids, so the run fails with its reasons attached.
        raise diag.DiagnosticError(
            f"nothing usable was read for {target_kind} "
            f"{ref.get('id') or ref.get('user') or ''}".strip(),
            findings=findings,
        )

    # Tag policy runs before writing so the exported 分类标签 is already filtered;
    # the same dictionary accumulates across every listing of this site.
    group_root = export_layout.site_root(options.project_root, template)
    if records and not options.dry_run:
        warnings.extend(_refresh_dictionary(group_root, records, options.progress))
        policy = taxonomy.load_tag_policy(group_root)
        records = [taxonomy.apply_policy_to_record(record, policy) for record in records]

    media_stats: dict[str, int] = {}
    if records and options.with_media and not options.dry_run:
        media_stats = _download_media(fetcher, template, records, listing, options)
        pruned = 0
        for record in records:
            pruned += media.prune_unreferenced(
                export_layout.item_dir(listing, str(record["source_id"])), record
            )
        if pruned:
            media_stats["pruned_stale"] = pruned
        gaps = media.missing_media(records, listing)
        if gaps:
            # A counter is easy to miss; naming the works is not. And it is a *distinct* reason from a
            # field the page never had (plan §5-D.6): the cover address was read, the bytes did not
            # land — so it is a media failure, not a missing field, and it warns rather than blocks.
            findings.append(diag.cover_fetch_failed(
                detail=f"{len(gaps)} work(s) are missing media: "
                       + ", ".join(gaps[:8]) + (f" (+{len(gaps) - 8} more)" if len(gaps) > 8 else "")))
            options.progress(
                f"{len(gaps)} work(s) are missing media; re-run to fetch them: "
                + ", ".join(gaps[:12]) + (f" (+{len(gaps) - 12} more)" if len(gaps) > 12 else "")
            )
            media_stats["missing_media"] = len(gaps)

    origin = bundle.origin()
    if not options.dry_run:
        _write(template, records, listing, options, origin)
        # The crawl's own state, kept where the crawl lives. Written after the
        # records so the inventory includes them, and it survives whether or not
        # anything is ever imported.
        crawl_state.record(
            export_layout.site_root(options.project_root, template),
            kind=target_kind,
            ref=ref.get("id") or ref.get("user") or "",
            local_ids=crawl_state.local_work_ids(
                listing,
                crawl_state.recorded_ids(
                    export_layout.site_root(options.project_root, template),
                    target_kind, ref.get("id") or ref.get("user") or ""),
            ),
            seen=cursor_observations(listed_ids, records),
            display_name=bundle.display_name,
            url=bundle.target_url,
            order_key=site_work_order_key_for,
        )

    missing = [record["source_id"] for record in records if not record.get("title")]
    warnings = list(bundle.warnings)
    if missing:
        warnings.append(f"{len(missing)} record(s) have no title: {', '.join(missing[:10])}")
    return RunResult(
        template=template,
        target_kind=target_kind,
        target_ref=ref.get("id") or ref.get("user") or "",
        listing_dir=listing,
        records=records,
        origin=origin,
        warnings=warnings,
        media_stats=media_stats,
        findings=findings,
    )


def _download_media(fetcher, template: SiteTemplate, records: list[dict[str, Any]],
                    listing: Path, options: RunOptions) -> dict[str, int]:
    """Prefer the site's own downloader; fall back to the shared one."""
    hook = getattr(fetcher, "download_media", None)
    if hook is not None:
        return hook(template, records, listing, options)

    totals = {"cover": 0, "previews": 0, "failed": 0}
    for record in records:
        stats = media.download_record_media(
            record,
            export_layout.item_dir(listing, str(record["source_id"])),
            referer=template.raw.get("url_base"),
        )
        for key, value in stats.items():
            totals[key] = totals.get(key, 0) + value
    return totals


def _refresh_dictionary(group_root: Any, records: list[dict[str, Any]],
                        progress) -> list[str]:
    """Refresh the site's tag dictionary, and say so when it cannot be written.

    The dictionary is an *index* of the records — derived from them, regenerated from them, and read
    by the review page and the import as a hint. A run whose records are on disk has done its job, so
    a failed dictionary write is a warning that names the file: measured on a real crawl where
    Windows refused the replace (`WinError 5`, another process holding the target for a moment) and
    the whole run was reported as a crash with the export sitting there, finished.
    """
    from . import taxonomy

    try:
        taxonomy.refresh_review(group_root, records)
    except Exception as error:  # noqa: BLE001 - an index, not the deliverable
        note = (f"the site's tag dictionary could not be written "
                f"({type(error).__name__}: {error}); the records and their media are unaffected")
        progress(f"warning: {note}")
        return [note]
    return []


def _write(template: SiteTemplate, records: list[dict[str, Any]], listing: Path,
           options: RunOptions, origin: dict[str, Any] | None) -> None:
    dropped: list[str] = []
    for record in records:
        canonical.scrub_fetch_urls(record)
        dropped.extend(canonical.verify_local_files(record, listing))
        export_layout.write_json(
            export_layout.item_dir(listing, str(record["source_id"])) / "metadata.json",
            record,
        )
    manifest = export_layout.build_manifest(
        template, records,
        name=Path(listing).name,
        url=records[0].get("detail_url") if records else None,
        origin=origin,
        extra=_manifest_extras(template, records),
    )
    if _accumulates(template, listing):
        manifest = _accumulate(listing, manifest, records)
    export_layout.write_json(listing / "metadata.json", manifest)


def _accumulates(template: SiteTemplate, listing: Path) -> bool:
    """Whether this run merges into what the folder already holds.

    Listings are crawled in passes, so their manifests accumulate. A single work is not:
    `sole_work` used to keep every individually requested work, and the link import then
    read the whole folder — so a person importing one work saw the one before it, and
    the review became a batch. One link is one work, so that folder is replaced.
    """
    if not (template.raw.get("manifest") or {}).get("accumulate"):
        return False
    from . import site_api
    return Path(listing).name != site_api.work_listing_name(template, None)


def _accumulate(listing: Path, manifest: dict[str, Any],
                records: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge this run's items into the listing's existing manifest.

    A `single` / `sole_work` folder is one accumulator for every individually
    requested work, matching what the per-site tools did: importing a second work
    must not shrink the manifest to just that one. New records win for their own
    id, and everything already in the folder is kept.
    """
    path = listing / "metadata.json"
    if not path.is_file():
        return manifest
    try:
        existing = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return manifest
    previous = existing.get("items")
    if not isinstance(previous, list):
        return manifest

    current = manifest.get("items")
    if not isinstance(current, list) or not current:
        manifest["items"] = previous
        manifest["item_count"] = len(previous)
        return manifest
    if isinstance(current[0], dict):
        # An earlier run may have written an item this version now rejects; the
        # folder self-heals instead of staying permanently un-importable.
        by_id = {
            str(item.get("source_id")): item
            for item in previous
            if isinstance(item, dict) and not canonical.missing_fields(item)
        }
        for item in current:
            if isinstance(item, dict):
                by_id[str(item.get("source_id"))] = item
        merged = list(by_id.values())
        manifest["items"] = merged
        manifest["item_count"] = len(merged)
    else:
        merged = list(dict.fromkeys([str(value) for value in previous] + [str(v) for v in current]))
        manifest["items"] = merged
        manifest["item_count"] = len(merged)
    return manifest


def _manifest_extras(template: SiteTemplate, records: list[dict[str, Any]]) -> dict[str, Any]:
    """Manifest keys copied from the first record that carries them.

    Hanime's manifest needs the playlist title, which only the listing cards
    knew. A site declares that with `manifest.record_keys`.
    """
    extras: dict[str, Any] = {}
    for key, field_name in ((template.raw.get("manifest") or {}).get("record_keys") or {}).items():
        for record in records:
            if record.get(field_name):
                extras[key] = record[field_name]
                break
    return extras


def cursor_observations(listed_ids: list[str],
                       records: list[dict[str, Any]]) -> list[tuple[str, str | None]]:
    """What the cursor is computed from: every work the listing offered.

    Uses the dates the run read where it has them, and no date for the rest — an
    undated entry can never overtake a dated one, so a run that trimmed everything
    still advances a date-free site (hanime has no dates at all) while leaving a
    dated site's cursor untouched rather than guessing.
    """
    dates = {str(record.get("source_id")): record.get("date_added") for record in records}
    return [(source_id, dates.get(source_id)) for source_id in listed_ids]


def site_work_order_key_for(source_id: str, work_date: str | None) -> str:
    """The same forward-only ordering the library uses, computed locally.

    Duplicated on purpose: a crawl must be able to order its own works without the
    library, which is what lets it run and record state on its own.
    """
    import re as _re

    date = work_date if isinstance(work_date, str) and _re.fullmatch(r"\d{4}-\d{2}-\d{2}", work_date) else ""
    padded = source_id.rjust(18, "0") if source_id.isdigit() else source_id.lower()
    return f"{date}\u0000{padded}"
