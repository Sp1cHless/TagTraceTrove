"""Entry point: one link, any site — title, cover, and a document T³ can import.

Level 0 of the tool. No site rule, no registry, no site name: it answers "what can
be had from this URL with no site-specific knowledge at all". That is the whole
point of keeping it separate from `probe.py` — which refuses a URL no folder under
`tool/` claims, and is right to, because crawling the wrong thing silently is the
failure the tool exists to avoid.

What it writes is the same export layout the site adapters write, so the result is
something the library can collect rather than a folder of loose images:

    export/<host>/single/items/<source_id>/metadata.json
    export/<host>/single/items/<source_id>/cover/cover.jpg

Run it on a site that has no adapter and the result says which of two things is
true: the site is readable as it stands, or it needs a rule. Either is a usable
answer; a wrong title or a logo passed off as a cover is not.

    python show_link.py <url> [<url> ...]

Exit code is the verdict, so a caller can branch without reading the report:

    0  title and cover were both read, and the export was written
    1  the page was reached, but not read fully — it needs a rule, or its cover
       candidates were unusable, so nothing was exported
    2  the page could not be read this time: refused, blocked by a bot check, or
       unreachable
    3  the input was not an http(s) URL, so there was nothing to fetch
"""

from __future__ import annotations

import sys
from pathlib import Path

from src.generic.level0_link import read_link
from src.generic.unknown_url import format_report

# Nothing is written any more: this door reads a page and reports it. The report says so, and the
# cover it read is described (not saved) so a person can see what Level 0 would hand a library.

EXIT_BY_KIND = {
    "found": 0,
    "insufficient": 1,
    "teaching": 1,
    "retryable": 2,
    "blocked": 2,
    "invalid": 3,
}

# A kind this mapping has not heard of is a bug here, not a verdict about the
# page. It must still not read as success, and 3 would claim the input was bad
# when the input may have been fine, so it lands in "not read".
UNKNOWN_EXIT = 2


def main(argv: list[str] | None = None) -> int:
    targets = sys.argv[1:] if argv is None else argv
    if not targets:
        print("Usage: python show_link.py <url> [<url> ...]")
        return 3

    worst = 0
    for url in targets:
        result, _cover = read_link(url)
        print(format_report(result))
        print()
        worst = max(worst, EXIT_BY_KIND.get(str(result.get("kind")), UNKNOWN_EXIT))
    return worst


if __name__ == "__main__":
    raise SystemExit(main())
