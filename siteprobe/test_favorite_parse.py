"""Why did the favourite listing parse no cards?"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from src.generic.registry import load_fetcher, registry  # noqa: E402

# The adapter is data in the SiteProbe home, so it is loaded from its directory rather than
# imported as `tool.comic18`, and its session lives beside it.
TEMPLATE = registry()["18comic.vip"]
fetch = load_fetcher(TEMPLATE)

URL = "https://18comic.vip/user/spechzy/favorite/albums?folder=1184906"
PROFILE = TEMPLATE.directory / "session" / "importer-chrome-profile"

MARKERS = {
    "favorites_album_": "favorites_album_",
    "favorites_folder_": "favorites_folder_",
    "album link": 'href="/album/',
    "pagination": "pagination",
    "login form": 'name="login"',
    "login word": "登入",
    "login word2": "登录",
    "empty hint": "还没有",
    "cf challenge": "Just a moment",
    "username link": "/user/spechzy",
}

cookies = fetch.load_cookies(PROFILE)
body = fetch.plain_fetch(URL, cookies)
print(f"bytes={len(body)}")
for name, marker in MARKERS.items():
    print(f"  {name:18} {marker in body}")
from src.generic.htmltree import parse_html, select_all  # noqa: E402

root = parse_html(body)
for selector in ("div[id^='favorites_album_']", "div[id^='favorites_folder_']",
                 "a[href*='/album/']", "img[data-original]"):
    print(f"  selector {selector!r:34} -> {len(select_all(root, selector))} match(es)")
