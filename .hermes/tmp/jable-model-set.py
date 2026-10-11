"""Why did the set become 111 tag links when the group is 24 videos?

The printed group list says `[0] 24 card(s)  selector='div.col-6.col-sm-4'`, and the set the chooser then
shows has 111 cards pointing at `/tags/…`. So the class is shared with another block on the page, and the
set is re-read by selector alone. This measures that, block by block.
"""
import sys
from pathlib import Path

sys.path.insert(0, "D:/Project/TagTraceTrove/siteprobe")

from src.builder.capture import capture_browser                      # noqa: E402
from src.builder.cards import cards_of, cards_of_group, _link_kind   # noqa: E402
from src.generic.htmltree import parse_html, select_all              # noqa: E402

URL = "https://jable.tv/models/12613c56a25c8efef14f7b7f6f9912e7/"
CACHE = Path("D:/Project/TagTraceTrove/.hermes/tmp/jable-model-page.html")

if CACHE.exists():
    html = CACHE.read_text(encoding="utf-8")
    print("using the saved capture")
else:
    capture = capture_browser(URL)
    html = next(d.text for d in capture.documents if d.name == "page")
    CACHE.write_text(html, encoding="utf-8")
    print("captured", len(html), "bytes")

groups = cards_of(html)
for index, group in enumerate(groups):
    print(f"[{index}] printed: {group.count:4d} card(s) selector={group.selector!r} container={group.container!r}")
    members = cards_of_group(html, group)
    kinds: dict[str, int] = {}
    for member in members:
        kinds[_link_kind(member)] = kinds.get(_link_kind(member), 0) + 1
    print(f"     cards_of_group -> {len(members)} card(s), link kinds: {kinds}")

root = parse_html(html)
every = select_all(root, "div.col-6.col-sm-4")
print(f"\ndiv.col-6.col-sm-4 anywhere on the page: {len(every)}")
in_container = select_all(root, "section.pb-3.pb-e-lg-40")
inside = [element for container in in_container for element in select_all(container, "div.col-6.col-sm-4")]
print(f"  of which inside 'section.pb-3.pb-e-lg-40': {len(inside)}")
tags = [element for element in every if (_link_kind(element) or "").startswith("/tags/")]
videos = [element for element in every if (_link_kind(element) or "").startswith("/videos/")]
print(f"  pointing at /tags/: {len(tags)}   pointing at /videos/: {len(videos)}")
print("  a tag element's classes:", tags[0].attr("class") if tags else None)
print("  a video element's classes:", videos[0].attr("class") if videos else None)
