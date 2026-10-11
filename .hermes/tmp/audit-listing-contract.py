"""Audit the listing rule's contract: what the Builder writes vs what the runtime reads.

Three bugs of one class have already been paid for (a `next` key nothing writes, a `page_param`
nothing read, a `row_selector` that named the whole page) — so this measures both sides instead of
trusting either. Every *shape* the Builder can produce is drafted here (each pagination form, a scoped
row selector, a narrowed id, a chained rule), because a single draft only shows the keys that shape
happens to use.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path("D:/Project/TagTraceTrove/siteprobe")
sys.path.insert(0, str(ROOT))

from src.builder.annotate import LISTING_FIELDS                        # noqa: E402
from src.builder.cards import CardGroup, card_page, cards_of           # noqa: E402
from src.builder.harvest import harvest                                # noqa: E402
from src.builder.learn import Sample, learn                            # noqa: E402
from src.builder.listing import (                                      # noqa: E402
    card_rule_for_id, listing_draft, listing_rules, pagination_from, rule_from,
)

FIXTURE = (ROOT / "fixtures" / "repeated_listing" / "page.html").read_text(encoding="utf-8")
BASE = "https://fixture.test"
URL = f"{BASE}/list"
NEXT_LINK = ('<a class="next" rel="next" href="/list?page=2">Next</a>'
             '<ul id="grid"><li class="card"><a href="/work/1"><h3>One</h3></a>'
             '<img src="/c/1.jpg"></li><li class="card"><a href="/work/2"><h3>Two</h3></a>'
             '<img src="/c/2.jpg"></li></ul>')
NUMBERED = ('<ul class="pagination"><li><span class="page-link active">01</span></li>'
            '<li><a class="page-link" href="/list/2/">02</a></li>'
            '<li><a class="page-link" href="/list/3/">03</a></li></ul>'
            '<ul id="grid"><li class="card"><a href="/work/1"><h3>One</h3></a>'
            '<img src="/c/1.jpg"></li><li class="card"><a href="/work/2"><h3>Two</h3></a>'
            '<img src="/c/2.jpg"></li></ul>')


def keys_of(value, prefix=""):
    if isinstance(value, dict):
        for key, item in value.items():
            yield f"{prefix}{key}"
            yield from keys_of(item, f"{prefix}{key}.")
    elif isinstance(value, list):
        for item in value:
            yield from keys_of(item, prefix)


group = cards_of(FIXTURE)[0]
capture = card_page(group, URL)
result = harvest(capture)
answer = {"source_id": f"{BASE}/work/1", "title": "First Work", "cover_url": f"{BASE}/c/1.jpg"}
sample = Sample(name="card1", capture=capture, harvest=result, annotated=answer)
rules = listing_rules(learn([sample], fields=LISTING_FIELDS), group, answers=answer)

drafts = {
    "url_param": listing_draft(host="fixture.test", kind="search", url_pattern=rf"^{BASE}/list",
                               rule=rule_from(group, rules),
                               pagination=pagination_from([(f"{URL}?page=1", FIXTURE),
                                                           (f"{URL}?page=2", FIXTURE)])),
    "next_link": listing_draft(host="fixture.test", kind="search", url_pattern=rf"^{BASE}/list",
                               rule=rule_from(group, rules),
                               pagination=pagination_from([(URL, NEXT_LINK),
                                                           (f"{URL}/2", NEXT_LINK)])),
    "numbered": listing_draft(host="fixture.test", kind="search", url_pattern=rf"^{BASE}/list",
                              rule=rule_from(group, rules),
                              pagination=pagination_from([(f"{BASE}/list/", NUMBERED),
                                                          (f"{BASE}/list/", NUMBERED)])),
    # A rule whose row selector needs the block, and whose id was narrowed from a marked link.
    "scoped": listing_draft(host="fixture.test", kind="search", url_pattern=rf"^{BASE}/list",
                            rule=rule_from(CardGroup(selector="li.card", count=3,
                                                     container="ul#grid", scope="ul#grid"),
                                           rules),
                            pagination=pagination_from([(URL, FIXTURE), (URL, FIXTURE)])),
}
kinds = listing_draft(host="fixture.test", kind="search", url_pattern=rf"^{BASE}/list",
                      rule=rule_from(group, {
                          **rules,
                          "title": {"from": "meta", "property": "og:title"},
                          "detail_url": {"from": "json", "path": "url"},
                      }),
                      pagination=pagination_from([(URL, FIXTURE), (URL, FIXTURE)]))
drafts["kinds"] = kinds
rules["source_id"] = card_rule_for_id(rules["source_id"], f"{BASE}/work/1")
drafts["narrowed_id"] = listing_draft(host="fixture.test", kind="search",
                                      url_pattern=rf"^{BASE}/list",
                                      rule=rule_from(group, rules))

written: set[str] = set()
for draft in drafts.values():
    written |= {key.split(".")[-1] for key in keys_of(draft["listings"]["search"])}
kinds_written = sorted({rule["from"] for draft in drafts.values()
                        for rule in draft["listings"]["search"]["fields"].values()
                        if isinstance(rule, dict) and "from" in rule})

# --- what the runtime reads -------------------------------------------------- #
RUNTIME = [ROOT / "src/generic/template.py", ROOT / "src/generic/extract.py",
           ROOT / "src/generic/declarative.py", ROOT / "src/generic/select.py",
           ROOT / "src/generic/pages.py", ROOT / "src/generic/site_api.py"]
# Every form a key can be read by: `x.get("k")`, `x["k"]`, `_require(raw, "k")`, `rule.k`,
# `x.pop("k", …)`, and `for key in ("a", "b")`.
lookup = re.compile(r"""\.(?:get|pop)\(\s*["']([a-z_]+)["']|\[\s*["']([a-z_]+)["']\s*\]"""
                    r"""|_require\(\s*\w+,\s*["']([a-z_]+)["']|rule\.([a-z_]+)"""
                    r"""|for\s+\w+\s+in\s+\(([^)]*)\)""")
read: set[str] = set()
for path in RUNTIME:
    for match in lookup.finditer(path.read_text(encoding="utf-8")):
        if match.group(5):
            read.update(re.findall(r'''["']([a-z_]+)["']''', match.group(5)))
        else:
            read.add(match.group(1) or match.group(2) or match.group(3) or match.group(4))

# Keys the Builder writes for a *person* reading the draft — diagnostics, not the runtime's contract.
DIAGNOSTIC = {"_builder", "cards", "hints", "missing", "matches"}
contract = written - DIAGNOSTIC

print("keys the Builder writes into a listing rule:", sorted(contract))
print("  diagnostics only (ignored by the runtime on purpose):", sorted(written & DIAGNOSTIC))
print("\nWRITTEN BUT NEVER READ:", sorted(contract - read) or "none")
print("READ BUT NEVER WRITTEN (rule keys):",
      sorted({"next_selector", "page_param", "row_selector", "max_pages", "page_numbers",
              "unique", "fallback", "absolute", "scope", "group", "filter", "attr", "select",
              "text", "document", "fields"} - written - read) or "none")

# --- the work half's contract (the same class of bug can live there) ---------- #
from src.builder.learn import draft_site_json                          # noqa: E402
work_draft = draft_site_json([sample], learn([sample]))
work_written = {key.split(".")[-1] for key in keys_of(work_draft)}
from src.generic.template import SiteTemplate                          # noqa: E402
carried = set(SiteTemplate.__dataclass_fields__) | {"targets", "documents", "work", "listings"}
print("
the work draft writes:", sorted(work_written))
print("  WRITTEN BUT THE TEMPLATE DOES NOT CARRY IT:",
      sorted(work_written - carried - {"_draft", "generated_from", "review"}) or "none")

# --- the field vocabulary: every `from` the Builder emits must be implemented -- #
implemented = set(re.findall(r'kind == ["\']([a-z_]+)["\']', (ROOT / "src/generic/select.py")
                             .read_text(encoding="utf-8")))
print("\n`from` kinds the Builder emits:", kinds_written)
print("  implemented by the runtime:", sorted(implemented))
print("  EMITTED BUT NOT IMPLEMENTED:", sorted(set(kinds_written) - implemented) or "none")
print("  implemented but never emitted (fine: hand-written sites use them):",
      sorted(implemented - set(kinds_written)))
