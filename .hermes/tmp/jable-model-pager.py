"""How does that model page turn to page 2, and what does the tool see?

The user reports: the page has two pages, the second one's URL is identical to the first, and the
adapter only ever lists page 1's works. This measures the page as served, the page as rendered, the
pager's own markup, and every document the browser fetched — the last one says whether page 2 arrives
as an XHR (which a custom fetcher could call) or not at all.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, "D:/Project/TagTraceTrove/siteprobe")

from src.builder.capture import capture_browser                      # noqa: E402
from src.generic import unknown_url                                  # noqa: E402

URL = "https://jable.tv/models/12613c56a25c8efef14f7b7f6f9912e7/"


def videos(html: str) -> list[str]:
    return sorted(set(re.findall(r"/videos/([a-z0-9-]+)/", html)))


status, body, kind, final = unknown_url.fetch(URL)
served = body.decode("utf-8", "replace")
print(f"served      : {status} {len(served)} bytes, final={final}")
print(f"  /videos/  : {len(videos(served))} -> {videos(served)[:4]}")
for pattern in (r'rel="next"', r"pagination", r"page=\d", r"data-page", r"load-more", r"loadMore"):
    print(f"  markup {pattern!r}: {len(re.findall(pattern, served, re.I))}")

capture = capture_browser(URL)
rendered = next(d.text for d in capture.documents if d.name == "page")
print(f"\nrendered    : {len(rendered)} bytes, final={capture.final_url}")
print(f"  /videos/  : {len(videos(rendered))}")
for pattern in (r'rel="next"', r"pagination", r"page=\d", r"data-page", r"load-more", r"loadMore"):
    print(f"  markup {pattern!r}: {len(re.findall(pattern, rendered, re.I))}")

print("\ndocuments the browser fetched:")
for document in capture.documents:
    url = getattr(document, "url", None) or ""
    if document.name == "page" or document.format == "json":
        print(f"  {document.name:12s} {document.format:7s} {len(document.text):8d}  {url[:110]}")

# What the pager looks like in the rendered page: the block around a "2".
for match in re.finditer(r"<[^>]*(?:pagination|page-item|page-link)[^>]*>", rendered, re.I):
    print("  pager markup:", match.group(0)[:140])
