"""Does the generic path work at all? One real single-work run per learned rule set.

For each learned adapter that declares a *work* target with fields, find one real work URL from the
site's own front page (by matching the adapter's own pattern), then run the tool on it and report what
came back. Read-only: it writes into the export tree the way any crawl does, and nothing else.
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(r"D:/Project/TagTraceTrove/siteprobe")
sys.path.insert(0, str(ROOT))

from src.generic import registry  # noqa: E402

HOME = Path(r"D:/Project/TagTraceTrove/apps/server/.data/siteprobe")
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"


def fetch(url: str, timeout: int = 25) -> str | None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as reply:
            return reply.read().decode("utf-8", "replace")
    except Exception as error:  # noqa: BLE001 - a site that cannot be reached is a result here
        print(f"    index unreachable: {type(error).__name__}: {str(error)[:70]}")
        return None


def candidate_urls(template) -> list[str]:
    """One real work URL from the site's own front page, matched by the adapter's own pattern."""
    for start in (f"https://{template.hosts[0]}/", template.raw.get("url_base") or ""):
        if not start:
            continue
        html = fetch(str(start))
        if not html:
            continue
        rule = template.targets.get("work")
        if rule is None or rule.url_pattern is None:
            continue
        found: list[str] = []
        for href in re.findall(r'href="([^"]+)"', html):
            for url in (href, str(start).rstrip("/") + href):
                if rule.url_pattern.search(url) and url not in found:
                    found.append(url)
        if found:
            return found[:3]
    return []


def main() -> int:
    rows = []
    for folder in sorted((HOME / "local").iterdir()):
        document = json.loads((folder / "site.json").read_text(encoding="utf-8"))
        if not ((document.get("work") or {}).get("fields") or {}).get("title"):
            continue
        key = str(document.get("key"))
        template = registry.reader_for(key)
        print(f"== {key} ({len(template.work_fields)} work field(s))")
        urls = candidate_urls(template)
        if not urls:
            print("    no work URL found on the front page")
            rows.append((key, "-", "no sample url"))
            continue
        url = urls[0]
        print(f"    sample: {url[:100]}")
        rows.append((key, url, "see below"))
    print()
    for key, url, note in rows:
        print(f"{key:22} {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
