"""What card groups does the model page have, and which one did the tool offer?

The chooser showed 60 cards that are all `/tags/...` links — a tag cloud, not the model's videos. This
captures the page the way the builder does and asks the detector itself what it found, so the answer is
the tool's own view rather than my guess about the markup.
"""
import sys
from pathlib import Path

sys.path.insert(0, "D:/Project/TagTraceTrove/siteprobe")

from src.builder.capture import capture_browser                      # noqa: E402
from src.builder.cards import cards_of, preview_of                   # noqa: E402

URL = "https://jable.tv/models/12613c56a25c8efef14f7b7f6f9912e7/"

capture = capture_browser(URL)
page = next((d for d in capture.documents if d.name == "page"), None)
print("documents:", [(d.name, d.format, len(d.text)) for d in capture.documents][:6])
html = page.text if page else ""
print("page bytes:", len(html))

groups = cards_of(html)
print(f"\n{len(groups)} card group(s):")
for index, group in enumerate(groups):
    shown = preview_of(group)
    print(f"  [{index}] {group.count:4d} card(s)  selector={group.selector!r}  container={group.container!r}")
    print(f"        hints={sorted(group.hints)}")
    print(f"        first: title={shown['title'][:60]!r}")
    print(f"               link={shown['link'][:70]!r} cover={shown['cover'][:60]!r}")

# The videos a model page should list: how many links look like `/videos/<id>/`?
import re
videos = sorted(set(re.findall(r'/videos/([a-z0-9-]+)/', html)))
print(f"\n/videos/ links on the page: {len(videos)} -> {videos[:6]}")
