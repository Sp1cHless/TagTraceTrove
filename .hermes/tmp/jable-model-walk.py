"""Does pasting the pager's own page-2 address actually walk both pages?

The pager on that model page swaps its list in place (the address bar never changes), so both addresses
a person can copy from the bar are the same one. Its own `2` link carries the real second address. This
builds a listing rule for that page in memory and walks it through the runtime's own reader, so the
answer is measured rather than argued.
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "D:/Project/TagTraceTrove/siteprobe")

from src.builder.annotate import LISTING_FIELDS
from src.builder.capture import capture_browser                       # noqa: E402
from src.builder.cards import cards_of, card_page                     # noqa: E402
from src.builder.harvest import harvest                               # noqa: E402
from src.builder.learn import Sample, learn                           # noqa: E402
from src.builder.listing import (                                     # noqa: E402
    listing_draft, listing_rules, pagination_from, rule_from,
)
from src.generic import unknown_url                                   # noqa: E402
from src.generic.declarative import list_cards                        # noqa: E402
from src.generic.template import load_template                        # noqa: E402

URL = "https://jable.tv/models/12613c56a25c8efef14f7b7f6f9912e7/"
CACHE = Path("D:/Project/TagTraceTrove/.hermes/tmp/jable-model-page.html")
served = CACHE.read_text(encoding="utf-8")

for label, pages in (("the same address twice", [(URL, served), (URL, served)]),
                     ("the pager's own page-2 address", [(URL, served), (f"{URL}2/", served)])):
    found = pagination_from(pages)
    print(f"{label}: {found.kind} usable={found.usable}")
    print("   ", found.detail)

found = pagination_from([(URL, served), (f"{URL}2/", served)])
if not found.usable:
    raise SystemExit("nothing to walk")

# The rule a build would write for the video cards of this page, then the runtime's own walk.
group = next(candidate for candidate in cards_of(served) if candidate.count == 24)
capture = card_page(group, URL)
result = harvest(capture)
answer = {"source_id": "https://jable.tv/videos/snos-357/", "title": "x",
          "cover_url": "https://assets-cdn.jable.tv/a.jpg"}
sample = Sample(name="card1", capture=capture, harvest=result, annotated=answer)
rules = listing_rules(learn([sample], fields=LISTING_FIELDS), group,
                      pages=[(URL, served), (f"{URL}2/", served)], answers=answer)
rule = rule_from(group, rules)
draft = listing_draft(host="jable.tv", kind="artist", url_pattern=rf"^{URL}", rule=rule,
                      pagination=found)
site = {**draft, "schema_version": 1, "key": "jable.tv", "display_name": "jable",
        "tool": "jable_tv", "source_site": "jable.tv", "export_group": "jable.tv",
        "media_id_prefix": "jable.tv", "hosts": ["jable.tv"]}

with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "site.json"
    path.write_text(json.dumps(site, ensure_ascii=False), encoding="utf-8")
    template = load_template(path)
    walked = list_cards(template, "artist", {"id": "x"},
                        {"target_url": URL, "progress": lambda message: print("   ", message)})
ids = [card.get("source_id") for card in walked]
print(f"\nthe runtime walked {len(walked)} card(s); distinct ids: {len(set(ids))}")
print("first five:", ids[:5])
print("last five :", ids[-5:])
