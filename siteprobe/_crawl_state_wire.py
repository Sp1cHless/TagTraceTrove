"""Wire the crawl-side state in: trim before fetching, record after."""

import ast
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent


def patch(rel, old, new):
    p = ROOT / rel
    s = p.read_text(encoding="utf8")
    assert s.count(old) == 1, (rel, old[:60], s.count(old))
    s = s.replace(old, new)
    ast.parse(s)
    p.write_text(s, encoding="utf8")
    print("patched", rel)


# --- the trim: fetch only what is not already on disk --------------------- #
patch(
    "src/generic/site_api.py",
    """                  single: bool = False, limit: int | None = None,
                  cards: list[dict[str, Any]] | None = None
                  ) -> tuple[list[RawItem], list[str]]:""",
    """                  single: bool = False, limit: int | None = None,
                  cards: list[dict[str, Any]] | None = None,
                  skip_source_ids: set[str] | None = None
                  ) -> tuple[list[RawItem], list[str]]:""",
)

patch(
    "src/generic/site_api.py",
    """    for index, url in enumerate(urls, start=1):
        try:
            item = read_work(template, url, site_options)""",
    """    if skip_source_ids:
        # Works already on disk are not fetched again. Done here rather than by the
        # caller because this is the last point before the expensive read, and the
        # site's own id parser is what maps a URL back to its work.
        before = len(urls)
        urls = [url for url in urls if work_id_of(fetcher, url) not in skip_source_ids]
        skipped = before - len(urls)
        if skipped:
            progress(f"{skipped} work(s) already on disk; {len(urls)} to fetch")

    for index, url in enumerate(urls, start=1):
        try:
            item = read_work(template, url, site_options)""",
)

patch(
    "src/generic/site_api.py",
    """def work_listing_name(template: Any, options: Any) -> str:""",
    """def work_id_of(fetcher: Any, url: str) -> str | None:
    \"\"\"The site-native work id inside a URL, using the site's own parser.

    Every site already needs this to read a work, so it is not a new hook — just a
    reuse of the one that exists. A site without it simply skips the trim.
    \"\"\"
    parser = getattr(fetcher, "work_id_from_url", None)
    if parser is None:
        return None
    try:
        return str(parser(url))
    except Exception:  # noqa: BLE001 - an unparsable URL is not a known work
        return None


def work_listing_name(template: Any, options: Any) -> str:""",
)

# --- the runner: read state, trim a download run, record afterwards -------- #
patch(
    "src/generic/runner.py",
    """    items, warnings = collect_items(
        fetcher, template, target_kind, ref, target_url, options, listing, options.progress,
        single=is_single_work,
        limit=options.limit,
    )""",
    """    # A download run fetches only what the listing does not already hold. A review
    # run lists everything on purpose: choosing what to keep means seeing what is
    # there, including the works already on disk.
    local_ids = crawl_state.local_work_ids(listing)
    skip: set[str] = set()
    if not options.review and not options.refresh and local_ids:
        skip = local_ids
        options.progress(f"{len(local_ids)} work(s) already in {listing.name}")

    items, warnings = collect_items(
        fetcher, template, target_kind, ref, target_url, options, listing, options.progress,
        single=is_single_work,
        limit=options.limit,
        skip_source_ids=skip,
    )""",
)

patch(
    "src/generic/runner.py",
    """    origin = bundle.origin()
    if not options.dry_run:
        _write(template, records, listing, options, origin)""",
    """    origin = bundle.origin()
    if not options.dry_run:
        _write(template, records, listing, options, origin)
        # The crawl's own state, kept where the crawl lives. Written after the
        # records so the inventory includes them, and it survives whether or not
        # anything is ever imported.
        crawl_state.record(
            export_layout.site_root(options.project_root, template),
            kind=target_kind,
            ref=ref.get("id") or ref.get("user") or "",
            local_ids=crawl_state.local_work_ids(listing),
            seen=[(work.source_id, work.workDate) for work in resolve_batch_works(records)],
            display_name=bundle.display_name,
            url=bundle.target_url,
            order_key=site_work_order_key_for,
        )""",
)

patch(
    "src/generic/runner.py",
    "from . import canonical, export_layout, media, review, review_media, site_api, taxonomy",
    "from . import canonical, crawl_state, export_layout, media, review, review_media, "
    "site_api, taxonomy",
)

patch(
    "src/generic/runner.py",
    """def _profile_dir(template: SiteTemplate) -> Path:""",
    """def resolve_batch_works(records: list[dict[str, Any]]) -> list[tuple[str, str | None]]:
    \"\"\"(source_id, work_date) for the records a run wrote, for the cursor.\"\"\"
    return [
        (str(record.get("source_id") or ""), record.get("date_added"))
        for record in records if record.get("source_id")
    ]


def site_work_order_key_for(source_id: str, work_date: str | None) -> str:
    \"\"\"The same forward-only ordering the library uses, computed locally.\"\"\"
    import re

    date = work_date if isinstance(work_date, str) and re.fullmatch(r"\\d{4}-\\d{2}-\\d{2}", work_date) else ""
    padded = source_id.padStart(18, "0") if source_id.isdigit() else source_id.lower()
    return f"{date}\\u0000{padded}"


def _profile_dir(template: SiteTemplate) -> Path:""",
)
