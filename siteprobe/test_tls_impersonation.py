"""Can a TLS-impersonating client reach an 18comic album page with a saved cookie?

The question this answers: does single-album import really need a browser, or was
`HTTP 403` only ever a TLS-fingerprint problem?
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from src.generic.registry import load_fetcher, registry  # noqa: E402

# The adapter is data in the SiteProbe home, so it is loaded from its directory rather than
# imported as `tool.comic18`, and its session lives beside it.
TEMPLATE = registry()["18comic.vip"]
fetch = load_fetcher(TEMPLATE)

URL = "https://18comic.vip/album/1472965/"
PROFILE = TEMPLATE.directory / "session" / "importer-chrome-profile"

MARKERS = {
    "book-name": 'id="book-name"',
    "works": 'data-type="works"',
    "tags": 'data-type="tags"',
    "datePublished": "datePublished",
    "media/albums": "/media/albums/",
}


def report(label, status, body, error=None):
    if error is not None:
        print(f"{label:12} ERROR {type(error).__name__}: {str(error)[:100]}")
        return
    found = {name: (marker in body) for name, marker in MARKERS.items()}
    print(f"{label:12} status={status} bytes={len(body)} challenge={'Just a moment' in body} {found}")


def main():
    cookies = fetch.load_cookies(PROFILE)
    print(f"cookies available: {len(cookies)} | cf_clearance: {'cf_clearance' in cookies}")
    if not cookies:
        print("no saved cookie; nothing to test")
        return

    try:
        from curl_cffi import requests as curl_requests
    except ImportError:
        print("curl_cffi is not installed")
        return

    for impersonate in ("chrome", "chrome136", "chrome124", "chrome120"):
        try:
            response = curl_requests.get(
                URL,
                impersonate=impersonate,
                cookies=cookies,
                timeout=30,
                headers={"Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8", "Referer": "https://18comic.vip/"},
            )
            report(impersonate, response.status_code, response.text)
        except Exception as error:  # noqa: BLE001 - reported, not raised
            report(impersonate, None, "", error)


if __name__ == "__main__":
    main()
