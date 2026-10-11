"""Entry point: does an installed adapter still read the page it was built for?

    python check_adapter.py --site <site.json> <url> [--offline <saved-page.html>]
    python check_adapter.py --site local/hitomi_la/site.json https://hitomi.la/artist/... --offline page.html

Phase 7's maintenance half (the plan's §10, "后期 maintenance"). When a site is redesigned a
learned rule stops reading, and today that is silent: the export simply has no cover, and it
looks like a page without one. This says which field stopped reading, and puts the page's own
candidates — each with its deterministic rule — next to it, so a person can decide.

It **never writes** the adapter. The plan's wording is explicit: adaptive matching is an aid,
a repair is suggested rather than applied, and whatever comes out still has to be a
deterministic selector.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from src.builder.capture import Capture, capture_browser, capture_plain, plain_documents
from src.builder.health import check_work_adapter, describe, suggestions_for


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    site: Path | None = None
    offline: Path | None = None
    browser = "--browser" in arguments
    for argument in arguments:
        if argument.startswith("--site="):
            site = Path(argument.split("=", 1)[1])
        if argument.startswith("--offline="):
            offline = Path(argument.split("=", 1)[1])
    urls = [argument for argument in arguments if not argument.startswith("--")]
    if site is None or (not urls and offline is None):
        print("Usage: python check_adapter.py --site=<site.json> [--offline=<page.html>] "
              "[--browser] <url>")
        return 3
    if not site.is_file():
        print(f"[ERROR] no such adapter: {site}")
        return 2

    if offline is not None:
        html = offline.read_text(encoding="utf-8", errors="replace")
        url = urls[0] if urls else f"file://{offline.name}"
    else:
        capture = capture_browser(urls[0]) if browser else capture_plain(urls[0])
        if capture.markup is None:
            print(f"[ERROR] {urls[0]}: no markup was captured ({capture.status})")
            return 2
        html = capture.markup.text
        url = capture.final_url or urls[0]

    print(f"=== {site}")
    print(f"    {url}  ({len(html)} bytes)")
    if (site.parent / "fetch.py").is_file():
        # A written site brings its own fetcher, and that is what produces the documents its
        # rules read — running it is not this tool's job. Measured on a real album page: a
        # written adapter reported fourteen empty fields here and every field when its own
        # fetcher ran, because the documents it reads are built there, not declared.
        print("    note: this site has its own fetch.py, so its documents are not produced "
              "here;")
        print("          a field reading nothing may be a missing document rather than a "
              "broken rule.")
    findings = check_work_adapter(site, url, html)
    broken = [finding for finding in findings if finding.broken]
    if broken:
        for finding in broken:
            finding.suggestions = suggestions_for(html, url, limit=6, like=finding.rule)
    print(describe(findings))
    for warning in (load_warnings(site)):
        print(f"    note: {warning}")
    print()
    if broken:
        print(f"    {len(broken)} field(s) read nothing: "
              f"{', '.join(finding.field for finding in broken)}")
        print("    nothing was changed — pick a replacement and edit the adapter by hand")
        return 1
    print("    every field read a value")
    return 0


def load_warnings(site: Path) -> list[str]:
    """Whatever the adapter itself says still needs a person (written at install time)."""
    manifest = site.with_name("learned.json")
    if not manifest.is_file():
        return []
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    notes: list[str] = []
    for name in payload.get("unverified") or []:
        notes.append(f"{name} was never confirmed on a second page")
    for name in payload.get("t3_needs") or []:
        notes.append(name)
    return notes


if __name__ == "__main__":
    raise SystemExit(main())
