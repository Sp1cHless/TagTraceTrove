"""The contract every site tool implements.

The merge splits along one line, and this module is that line:

**Reading one work is the primitive.** Given the URL of a single work, a site's
`fetch.py` produces that work's raw documents. Every site can do this — it is the
function the original per-site tools already had (`hitomi_la/src/single_work.py`,
the hanime detail page, `18comic_vip/src/import_album.py`) — and it is the part
that cannot be derived from anything else, because only the site knows how its own
page stores a work.

**Enumerating a listing is optional sugar.** An author, a collection, a playlist:
each is just a way to produce *more work URLs*. A site that has one provides
`list_work_urls`; a site that does not is still fully usable through a work URL.

Everything above this line is generic: the canonical record, the tag policy, the
export layout and the crawl cursor are identical for every site, so a new site
never touches them.

A site module therefore provides:

    read_work(template, url, options) -> RawItem | None      # required
    list_work_urls(template, kind, ref, options) -> list[str] # optional

`options` carries `cache_root` (where raw documents may be cached), `refresh`,
`offline_dir`, `progress`, and whatever the site needs for acquisition
(`profile_dir` for 18comic). `read_work` returns `None` when the page turned out
not to contain a work at all, and raises `WorkUnavailable` when the site refused
to serve it — both are reported, neither aborts a listing.
"""

from __future__ import annotations

from typing import Any, Iterator

from .bundle import RawItem


class WorkUnavailable(RuntimeError):
    """The site did not serve this work (removed, gated, or check required)."""


def require_read_work(fetcher: Any, site_key: str):
    reader = getattr(fetcher, "read_work", None)
    if reader is None:
        raise ValueError(
            f"site {site_key!r} cannot read a single work: {site_key}'s fetch.py "
            f"must define read_work(template, url, options)"
        )
    return reader


def optional_list_work_urls(fetcher: Any) -> Any | None:
    return getattr(fetcher, "list_work_urls", None)


def optional_scan_review(fetcher: Any) -> Any | None:
    """A site may offer "scan, then let me pick" instead of "download everything".

    Optional on purpose: a listing without a review step still works, and a site
    with a rich review supplies it without the runner knowing how it works.
    """
    return getattr(fetcher, "scan_review", None)


def optional_export_selection(fetcher: Any) -> Any | None:
    return getattr(fetcher, "export_selection", None)


def optional_list_cards(fetcher: Any) -> Any | None:
    """A site may list works *with their card fields*, which is what a generic
    review page needs. A listing that only yields URLs still works; it just cannot
    offer a review without reading every work first.
    """
    return getattr(fetcher, "list_cards", None)


def work_id_of(fetcher: Any, url: str) -> str | None:
    """The site-native work id inside a URL, using the site's own parser.

    Every site already needs this to read a work, so it is not a new hook — just a
    reuse of the one that exists. A site without it simply skips the trim.
    """
    parser = getattr(fetcher, "work_id_from_url", None)
    if parser is None:
        return None
    try:
        return str(parser(url))
    except Exception:  # noqa: BLE001 - an unparsable URL is not a known work
        return None


def work_listing_name(template: Any, options: Any) -> str:
    """The folder individually requested works accumulate into.

    `sole_work` / `single` is one accumulator per site, exactly as the original
    per-site tools did, so importing a second work adds to the folder instead of
    replacing what is in it.
    """
    naming = template.raw.get("naming") or {}
    return str(naming.get("work") or "sole_work")


def listing_url(fetcher: Any, template: Any, kind: str, ref: dict[str, str],
                fallback: str) -> str:
    """The canonical page of a listing, when the site can name one.

    An artist typed as a bare name carries no URL, but the site knows which page
    it is about to read, and that page is what belongs in the export.
    """
    resolver = getattr(fetcher, "listing_url", None)
    if resolver is not None:
        try:
            resolved = resolver(template, kind, ref)
            if resolved:
                return str(resolved)
        except Exception:  # noqa: BLE001 - a nicer URL is never worth failing for
            pass
    return fallback


def iter_options(options: Any, cache_root: Any, template: Any) -> dict[str, Any]:
    return {
        "cache_root": cache_root,
        "refresh": options.refresh,
        "offline_dir": options.offline_dir,
        "progress": options.progress,
        "profile_dir": _profile_dir(template),
    }


def _profile_dir(template: Any):
    from pathlib import Path

    declared = (template.raw.get("session") or {}).get("profile_dir")
    if declared:
        return (template.directory / str(declared)).resolve()
    return template.directory / "session" / "chrome-profile"


def repeated_card_ids(cards: list[dict[str, Any]]) -> list[str]:
    """The ids that appear on more than one card of a listing.

    A card set whose ids repeat is not reading ids at all, and the data it produces is not valid:
    measured on a learned rule set whose target pattern captured a constant (`acgDetail.php`), so
    every work on the site would be met as one work — and a selection of twenty of them would be
    refused by the import as a duplicate id in one batch. The Builder checks this at authoring time
    (`check_over_cards`); this is the same check where the *data* is produced, because a rule set
    that slipped through must not pass silently here.
    """
    ids = [str(card.get("source_id")) for card in cards if card.get("source_id")]
    return sorted({value for value in ids if ids.count(value) > 1})


def collect_items(fetcher: Any, template: Any, kind: str, ref: dict[str, str],
                  target_url: str, options: Any, listing: Any, progress,
                  single: bool = False, limit: int | None = None,
                  cards: list[dict[str, Any]] | None = None,
                  skip_source_ids: set[str] | None = None
                  ) -> tuple[list[RawItem], list[str], list[str]]:
    """Read one work, or enumerate then read each — the only difference between targets.

    Which of the two happens is the template's declaration (`targets.<kind>.single`),
    not a name the generic layer recognises, so a site is free to call its work
    target `album`, `video` or anything else.
    """
    from .bundle import RawItem as _RawItem

    read_work = require_read_work(fetcher, template.key)
    site_options = iter_options(options, listing, template)
    warnings: list[str] = []
    items: list[RawItem] = []
    card_by_url = {
        str(card.get("detail_url") or card.get("url") or ""): card
        for card in (cards or [])
    }

    if cards is not None:
        # A selection already resolved the works from the listing's own cards, so
        # there is nothing left to enumerate.
        urls = [str(card.get("detail_url") or card.get("url") or "") for card in cards]
        urls = [url for url in urls if url]
        if not urls:
            raise ValueError("the selected cards carry no work URL to read")
    elif single:
        urls = [target_url]
    else:
        enumerate_urls = optional_list_work_urls(fetcher)
        if enumerate_urls is None:
            raise ValueError(
                f"site {template.key!r} cannot enumerate a {kind}: its fetch.py has no "
                f"list_work_urls, so it only supports a single work URL"
            )
        # A learned listing declares no URL recipe: the page it lists is the address the person
        # asked for, so the hook is handed it. (`runner` does the same for the review door.)
        site_options["target_url"] = target_url
        urls = list(enumerate_urls(template, kind, ref, site_options))
        # The cap bounds the fetching, not just what is written: reading hundreds
        # of pages to then discard all but three is exactly what a limit is for.
        if limit:
            urls = urls[: int(limit)]
        if not urls:
            warnings.append(f"no works were listed for {kind} {ref.get('id') or ref}")
        progress(f"{len(urls)} work URL(s) to read")

    # The ids the listing offered, in order. A run that trims everything away still
    # read the listing, and the cursor is about the listing, not about the fetches.
    listed_ids = [value for value in (work_id_of(fetcher, url) for url in urls) if value]

    if cards is not None:
        repeated = repeated_card_ids(cards)
        if repeated:
            warnings.append(f"{len(repeated)} id(s) appear on more than one card "
                            f"({', '.join(repeated)[:60]}): the listing is not reading distinct works")

    if skip_source_ids:
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
            item = read_work(template, url, site_options)
        except WorkUnavailable as error:
            warnings.append(f"{url}: {error}")
            continue
        except Exception as error:  # noqa: BLE001 - one bad work never stops a listing
            warnings.append(f"{url}: {type(error).__name__}: {error}")
            continue
        if item is None:
            warnings.append(f"{url}: the page did not contain a work")
            continue
        # The listing's card wins over whatever the work page yielded: a template
        # may prefer a card field precisely because the work page does not carry
        # it (hanime's detail page has no dependable title).
        card = card_by_url.get(url)
        if card:
            item.card = {**item.card, **card}
            if not item.card.get("source_id"):
                item.card["source_id"] = card.get("source_id")
        items.append(item)
        if index % 20 == 0:
            progress(f"  read {index}/{len(urls)}")

    return items, warnings, listed_ids
