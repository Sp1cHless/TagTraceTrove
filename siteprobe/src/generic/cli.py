"""Command line for the merged tool.

Three entry points, matching the three things a user actually does:

* ``probe.py <url-or-name>`` — one work, one artist, one collection. The site is
  detected from the input; nothing about any site is hardcoded here.
* ``--list-sites`` — the registry, which is what makes the picker and any future
  UI data-driven rather than a hardcoded menu.
* ``tag_review.py`` — apply the 保留/屏蔽 decisions for one site or all of them.

Every site is reached through an adapter source under the SiteProbe home, so this file never
names one.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import export_layout, registry, taxonomy
from .runner import PROJECT_ROOT, RunOptions, run


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("input", nargs="?", help="a URL, or a name for sites that accept one")
    parser.add_argument("--site", dest="site_key",
                        help="force a site by key instead of detecting it")
    parser.add_argument("--kind", dest="target_kind",
                        help="force the target kind (work/artist/folder/playlist/album/favorite)")
    parser.add_argument("--name", help="display name for the listing folder")
    parser.add_argument("--limit", type=int, help="stop after N works")
    parser.add_argument("--refresh", action="store_true", help="ignore every cache")
    parser.add_argument("--offline", dest="offline_dir", type=Path,
                        help="read recorded raw documents instead of the network")
    parser.add_argument("--no-media", action="store_true", help="skip cover and preview downloads")
    parser.add_argument("--dry-run", action="store_true", help="resolve and acquire, write nothing")
    parser.add_argument("--list-sites", action="store_true", help="show the site registry and exit")
    parser.add_argument("--review", action="store_true",
                        help="scan for review (writes review.html) instead of downloading")
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT,
                        help="where export/ lives (default: the tool directory)")


def ask(prompt: str) -> str:
    """Read one answer, treating input that has ended as an empty answer.

    A batch file can be opened with no console attached — a shortcut, a redirected run, this
    tool's own acceptance sweep — and `input()` then raises `EOFError` instead of returning. A
    prompt with nothing left to read is the same case as a prompt answered with Enter, so it
    belongs on the caller's "nothing entered" path rather than in a traceback.
    """
    try:
        return input(prompt).strip()
    except EOFError:
        print()
        return ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="probe",
        description="Merged multi-site probe: acquire raw documents, extract and export.",
    )
    _add_common(parser)
    args = parser.parse_args(argv)

    if args.list_sites:
        for site in registry.describe_sites():
            kinds = ", ".join(
                target["kind"] + ("(name)" if target["accepts_name"] else "")
                for target in site["targets"]
            )
            print(f"{site['key']:<16} {site['display_name']:<10} export={site['export_group']:<12} {kinds}")
        # Two adapters for one domain is the one thing a person cannot see from the outside, and
        # this listing is where they find it out. Neither is unused: each answers the targets it
        # declares (`resolve_input`), and only the registry key goes to the higher-priority one.
        # What each of them reads is printed, because the line above shows only the key holder's —
        # which for a rule set learned from one listing page reads as "18comic can only search",
        # while the written adapter beside it also reads albums and favourites.
        for key, kept_out, used in registry.shadowed_sites():
            reads = {str(template.directory): ", ".join(sorted(template.targets)) or "nothing"
                     for template in registry.templates_for(key)}
            print(f"{key:<16} two adapters: {used} answers this key and reads "
                  f"{reads.get(used, 'nothing')}; {kept_out} reads {reads.get(kept_out, 'nothing')}")
        # An adapter that is on disk but unreadable is invisible from every other surface, and the
        # report it produces is "the site I built has gone from this list". It has not gone: its
        # `site.json` cannot be read (a writer that was interrupted, a full disk). Named here so the
        # answer is a sentence rather than a guess — and skipped during discovery, so one broken
        # file cannot take every other site down with it.
        for folder, why in registry.unreadable_sites():
            print(f"{'(unreadable)':<16} {folder}: {why}")
        # Showing the registry is the whole job, so this is where the command ends. It used to
        # fall through to the "an input is required" check below and exit 2 with an error that
        # recommended the flag just used.
        return 0

    if not args.input:
        parser.error("an input URL or name is required (or use --list-sites)")

    options = RunOptions(
        raw_input=args.input,
        site_key=args.site_key,
        target_kind=args.target_kind,
        name=args.name,
        limit=args.limit,
        refresh=args.refresh,
        offline_dir=args.offline_dir,
        with_media=not args.no_media,
        dry_run=args.dry_run,
        review=args.review,
        project_root=args.project_root,
    )
    try:
        result = run(options)
    except (ValueError, registry.RegistryError) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 2

    print()
    print(f"site        {result.template.key}")
    print(f"target      {result.target_kind} {result.target_ref}")
    print(f"works       {result.record_count}")
    print(f"export      {result.listing_dir}")
    if result.origin:
        print(f"origin      {json.dumps(result.origin, ensure_ascii=False)}")
    if result.media_stats:
        print(f"media       {json.dumps(result.media_stats)}")
    if result.warnings:
        print("warnings")
        for warning in result.warnings[:20]:
            print(f"  - {warning}")
    return 0


def tag_review_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tag_review",
        description="Apply the 保留/屏蔽 decisions in tag_review.csv to the dictionary and records.",
    )
    parser.add_argument("--site", dest="site_key", help="one site group; default is every site")
    parser.add_argument("--inventory", action="store_true",
                        help="refresh the dictionary and the review sheet, rewrite no records")
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)
    args = parser.parse_args(argv)

    sites = ([registry.get(args.site_key)] if args.site_key
             else list(registry.registry().values()))
    if not sites:
        print("[ERROR] no sites are installed", file=sys.stderr)
        return 2

    for template in sites:
        group_root = export_layout.site_root(args.project_root, template)
        if not group_root.is_dir():
            print(f"{template.key}: no exports yet at {group_root}")
            continue
        try:
            if args.inventory:
                records = [
                    json.loads(path.read_text(encoding="utf-8"))
                    for path in group_root.glob("**/items/*/metadata.json")
                ]
                taxonomy.refresh_review(group_root, [r for r in records if isinstance(r, dict)])
                print(f"{template.key}: dictionary and review sheet refreshed")
            else:
                updated = taxonomy.apply_review_to_exports(group_root)
                policy = taxonomy.load_tag_policy(group_root)
                print(
                    f"{template.key}: {updated} record(s) updated "
                    f"({len(policy['accepted'])} accepted, {len(policy['rejected'])} rejected)"
                )
        except ValueError as error:
            print(f"[ERROR] {template.key}: {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

def _ask_review(site, kind: str) -> bool:
    """Ask about the review step, wherever one is actually possible.

    Two ways to have one: a site's own scan (hitomi, with its cluster analysis) or
    the generic card-based page every other site gets. Checking only the first was
    a bug with real consequences — 18comic was never asked, so a 218-result search
    downloaded all 218. A listing is exactly the case a review exists for, so the
    default is yes and a single Enter gets you the page rather than the download.
    """
    from .registry import load_fetcher
    from .site_api import optional_list_cards, optional_scan_review

    if site.targets[kind].single:
        return False
    try:
        fetcher = load_fetcher(site)
    except Exception:  # noqa: BLE001 - an unloadable site has no review either
        return False
    if optional_scan_review(fetcher) is None and optional_list_cards(fetcher) is None:
        return False
    print()
    answer = ask(
        "Review first (pick works before anything is downloaded)? [Y/n]: "
    ).lower()
    return answer not in ("n", "no", "否")


def pick_main(argv: list[str] | None = None) -> int:
    """Interactive entry for authors and collections.

    The menu is built from the registry, not from a hardcoded list, so a site
    added later appears here without this file changing.
    """
    parser = argparse.ArgumentParser(prog="pick", description="Choose a site, then paste a link.")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--offline", dest="offline_dir", type=Path)
    parser.add_argument("--no-media", action="store_true")
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)
    parser.add_argument("--review", action="store_true",
                        help="scan for review instead of downloading")
    args = parser.parse_args(argv)

    sites = list(registry.registry().values())
    if not sites:
        print(f"[ERROR] no sites are installed under {registry.adapter_root()}", file=sys.stderr)
        return 2

    print("Choose a site:")
    for index, site in enumerate(sites, start=1):
        kinds = "  ".join(
            rule.label + ("(输入名称)" if rule.accepts_name else "(输入网址)")
            for rule in site.targets.values()
        )
        print(f"  {index}. {site.display_name:<12} {site.key:<16} {kinds}")
    answer = ask("\nNumber: ")
    if not answer.isdigit() or not 1 <= int(answer) <= len(sites):
        print("[ERROR] not a listed number", file=sys.stderr)
        return 2
    site = sites[int(answer) - 1]

    kinds = list(site.targets)
    if len(kinds) > 1:
        print(f"\n{site.display_name} — which kind?")
        for index, kind in enumerate(kinds, start=1):
            print(f"  {index}. {kind} ({site.targets[kind].label})")
        chosen = ask("\nNumber: ")
        if not chosen.isdigit() or not 1 <= int(chosen) <= len(kinds):
            print("[ERROR] not a listed number", file=sys.stderr)
            return 2
        kind = kinds[int(chosen) - 1]
    else:
        kind = kinds[0]

    raw = ask(f"\n{site.targets[kind].label} URL or name: ")
    if not raw:
        print("[ERROR] nothing entered", file=sys.stderr)
        return 2

    # Offer the review step here, before anything is downloaded: the point of a
    # review is to pick first and fetch only the picks.
    review = args.review or _ask_review(site, kind)
    if review:
        print("Review mode: this run only scans and writes review.html; nothing is downloaded.")
        print("When the page has exported a selection, drag it onto 下载selection.bat.")

    options = RunOptions(
        raw_input=raw,
        site_key=site.key,
        target_kind=kind,
        limit=args.limit,
        refresh=args.refresh,
        offline_dir=args.offline_dir,
        with_media=not args.no_media,
        review=review,
        project_root=args.project_root,
    )
    try:
        result = run(options)
    except (ValueError, registry.RegistryError) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 2
    if result.review_html is not None:
        print(f"\n{result.template.key}: review page -> {result.review_html}")
        return 0
    print(f"\n{result.template.key}: {result.record_count} work(s) -> {result.listing_dir}")
    if result.origin:
        print(f"origin {json.dumps(result.origin, ensure_ascii=False)}")
    return 0
