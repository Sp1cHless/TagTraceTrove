"""Replay the recorded jable listing session through the fixed rule chooser."""
import json
import sys
from pathlib import Path

ROOT = Path("D:/Project/TagTraceTrove/siteprobe")
sys.path.insert(0, str(ROOT))

from src.builder.annotate import LISTING_FIELDS
from src.builder.cards import cards_of
from src.builder.learn import learn, load_session
from src.builder.listing import check_over_cards, listing_rules, rule_from

SESSION = Path("D:/Project/TagTraceTrove/apps/server/.data/siteprobe/sessions/jable.tv/20261005-194929-listing")
# The session records the *card* (that is what was harvested); the listing page itself came from
# the live fetch, and this is that page as it was saved at the time.
sample = load_session(SESSION)
url = "https://jable.tv/models/12613c56a25c8efef14f7b7f6f9912e7/"
html = Path("D:/Project/TagTraceTrove/.hermes/tmp/jable-model-page.html").read_text(encoding="utf-8")
pages = [(url, html), (url, html)]

# The set the person marked, built the way the tool builds it: the members are the elements
# the detector itself named, and the row selector is scoped to the block that holds them.
import dataclasses
from src.builder.cards import cards_of_group
from build_listing import row_selector_for
from src.generic.htmltree import parse_html

groups = cards_of(html)
index = next(i for i, g in enumerate(groups) if g.selector == "div.col-6.col-sm-4")
root = parse_html(html)
pick = sorted(cards_of_group(html, groups[index], root=root), key=lambda e: e.order)
group = dataclasses.replace(
    groups[index], count=len(pick), selector=groups[index].selector,
    scope=row_selector_for(root, groups[index], pick, picked=[groups[index].selector]))
print("scope:", group.scope)
print("cards in the set:", group.count)
print("annotated:", json.dumps(sample.annotated, ensure_ascii=False)[:200])

learning = learn([sample], fields=LISTING_FIELDS)
rules = listing_rules(learning, group, pages, answers=sample.annotated)
print()
print("what the card was learned as")
for name, rule in rules.items():
    print(f"    {name:12} {json.dumps(rule, ensure_ascii=False)}")

rule = rule_from(group, rules)
print()
print("missing:", rule["_builder"]["missing"])
for finding in check_over_cards(rule, pages):
    print("    [CHECK]", finding)
if not check_over_cards(rule, pages):
    print("    [CHECK] clean: ids distinct, every card read")

draft = {
    "key": "jable.tv",
    "display_name": "jable.tv",
    "tool": "listing",
    "source_site": "jable.tv",
    "export_group": "jable.tv",
    "media_id_prefix": "",
    "hosts": ["jable.tv"],
    "targets": {"artist": {"url_pattern": r"^https?://jable\.tv/models/.*"}},
    "listings": {"artist": rule},
    "documents": {"listing_html": {"format": "markup"}},
}
path = Path("D:/Project/TagTraceTrove/.hermes/tmp/jable-replay-site.json")
path.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")

from src.builder.listing import cards_as_read_by_the_runtime
cards = cards_as_read_by_the_runtime(path, url, html, kind="artist")
print()
print(f"the runtime reads {len(cards)} card(s)")
for card in cards[:3]:
    print("   ", json.dumps(card, ensure_ascii=False)[:160])
