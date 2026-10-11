"""What does a card that IS the link ship, and what does the runtime read from it?"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path("D:/Project/TagTraceTrove/siteprobe")
sys.path.insert(0, str(ROOT))

from src.builder.cards import cards_of                                   # noqa: E402
from src.builder.listing import (                                         # noqa: E402
    cards_as_read_by_the_runtime,
    card_rule_for_id,
    listing_draft,
    listing_rules,  # noqa: F401 - imported to prove the module loads
    pagination_from,
    rule_from,
)

HTML = """<!doctype html><html><body>
  <div class="weekly">
    <a class="book-layout" href="/novel/2906.html"><img data-src="/c/2906s.jpg"><h4 class="book-title">First</h4></a>
    <a class="book-layout" href="/novel/3095.html"><img data-src="/c/3095s.jpg"><h4 class="book-title">Second</h4></a>
    <a class="book-layout" href="/novel/3343.html"><img data-src="/c/3343s.jpg"><h4 class="book-title">Third</h4></a>
  </div>
</body></html>"""
BASE = "https://fixture.test"

group = cards_of(HTML)[0]
print("group selector:", group.selector, "| cards:", group.count)

rule = rule_from(group, {
    "source_id": {"from": "html", "select": "a.book-layout", "attr": "href", "absolute": True},
    "title": {"from": "html", "select": "h4.book-title", "text": True},
    "cover_url": {"from": "html", "select": "img", "attr": "data-src", "absolute": True},
})
print("shipped fields:", json.dumps(rule["fields"], ensure_ascii=False))
print("narrowed by card_rule_for_id:",
      json.dumps(card_rule_for_id(rule["fields"]["source_id"], "/novel/3095.html"),
                 ensure_ascii=False))

draft = listing_draft(host="fixture.test", kind="search", url_pattern=rf"^{BASE}/list",
                      rule=rule, pagination=pagination_from([(f"{BASE}/list/1", HTML)]))
site = {**draft, "schema_version": 1, "key": "fixture.test", "display_name": "fixture",
        "tool": "fixture_test", "source_site": "fixture.test",
        "export_group": "fixture.test", "media_id_prefix": "fixture.test",
        "hosts": ["fixture.test"]}
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "site.json"
    path.write_text(json.dumps(site, ensure_ascii=False), encoding="utf-8")
    cards = cards_as_read_by_the_runtime(path, f"{BASE}/list", HTML)
print("runtime cards:", json.dumps(cards, ensure_ascii=False, indent=1))
