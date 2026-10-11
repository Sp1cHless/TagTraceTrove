"""Audit the rule contract: what the Builder writes vs what the runtime reads.

Four bugs of one class were already paid for (a `next` key nothing writes, a `page_param` nothing
reads, a `row_selector` that named the whole page, a `page_numbers` marker added to the runtime), so
this measures both sides instead of trusting either. Every shape the Builder can produce is drafted
here, because a single draft only shows the keys that shape happens to use.

Run:  .venv/Scripts/python.exe audit-listing-contract.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path("D:/Project/TagTraceTrove/siteprobe")
sys.path.insert(0, str(ROOT))

from src.builder.annotate import LISTING_FIELDS
from src.builder.cards import CardGroup, card_page, cards_of
from src.builder.harvest import harvest
from src.builder.learn import Sample, draft_site_json, learn
from src.builder.listing import (card_rule_for_id, listing_draft, listing_rules,
                                 pagination_from, rule_from)
from src.generic.template import ListingRule, SiteTemplate

FIXTURE = (ROOT / "fixtures" / "repeated_listing" / "page.html").read_text(encoding="utf-8")
BASE = "https://fixture.test"
URL = f"{BASE}/list"
CARDS = ('<ul id="grid"><li class="card"><a href="/work/1"><h3>One</h3></a>'
         '<img src="/c/1.jpg"></li><li class="card"><a href="/work/2"><h3>Two</h3></a>'
         '<img src="/c/2.jpg"></li></ul>')
NEXT_LINK = '<a class="next" rel="next" href="/list?page=2">Next</a>' + CARDS
NUMBERED = ('<ul class="pagination"><li><span class="page-link active">01</span></li>'
            '<li><a class="page-link" href="/list/2/">02</a></li>'
            '<li><a class="page-link" href="/list/3/">03</a></li></ul>' + CARDS)


def keys_of(value, prefix=""):
    """Every key path inside a rule, so a nested rule's keys are audited too."""
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


def draft(rule, pages):
    return listing_draft(host="fixture.test", kind="search", url_pattern=rf"^{BASE}/list",
                         rule=rule, pagination=pagination_from(pages))


drafts = {
    "url_param": draft(rule_from(group, rules), [(f"{URL}?page=1", FIXTURE),
                                                 (f"{URL}?page=2", FIXTURE)]),
    "next_link": draft(rule_from(group, rules), [(URL, NEXT_LINK), (f"{URL}/2", NEXT_LINK)]),
    "numbered": draft(rule_from(group, rules), [(f"{BASE}/list/", NUMBERED),
                                                (f"{BASE}/list/", NUMBERED)]),
    # A row selector that needs its block, and fields using the other `from` kinds.
    "scoped": draft(rule_from(CardGroup(selector="li.card", count=3, container="ul#grid",
                                        scope="ul#grid"), rules),
                    [(URL, FIXTURE), (URL, FIXTURE)]),
    "kinds": draft(rule_from(group, {**rules, "title": {"from": "meta", "property": "og:title"},
                                     "detail_url": {"from": "json", "path": "url"}}),
                   [(URL, FIXTURE), (URL, FIXTURE)]),
}
rules["source_id"] = card_rule_for_id(rules["source_id"], f"{BASE}/work/1")
drafts["narrowed_id"] = draft(rule_from(group, rules), [(URL, FIXTURE), (URL, FIXTURE)])

written: set[str] = set()
for drafted in drafts.values():
    written |= {key.split(".")[-1] for key in keys_of(drafted["listings"]["search"])}
kinds_written = sorted({rule["from"] for drafted in drafts.values()
                        for rule in drafted["listings"]["search"]["fields"].values()
                        if isinstance(rule, dict) and "from" in rule})

# Every form a key can be read by: `x.get("k")`, `x["k"]`, `_require(raw, "k")`, `rule.k`,
# `x.pop("k", …)`, and `for key in ("a", "b")`.
RUNTIME = [ROOT / "src/generic/template.py", ROOT / "src/generic/extract.py",
           ROOT / "src/generic/declarative.py", ROOT / "src/generic/select.py",
           ROOT / "src/generic/pages.py", ROOT / "src/generic/site_api.py"]
lookup = re.compile(
    r"""\.(?:get|pop)\(\s*["']([a-z_]+)["']"""
    r"""|\[\s*["']([a-z_]+)["']\s*\]"""
    r"""|_require\(\s*\w+,\s*["']([a-z_]+)["']"""
    r"""|rule\.([a-z_]+)\b"""
    r"""|for\s+\w+\s+in\s+\(([^)]*)\)""")
read: set[str] = set()
for path in RUNTIME:
    for match in lookup.finditer(path.read_text(encoding="utf-8")):
        if match.group(5):
            read.update(re.findall(r"""["']([a-z_]+)["']""", match.group(5)))
        else:
            read.add(match.group(1) or match.group(2) or match.group(3) or match.group(4))

# Keys the Builder writes for a *person* reading the draft — diagnostics, not the runtime's contract.
DIAGNOSTIC = {"_builder", "cards", "hints", "missing", "matches"}
contract = written - DIAGNOSTIC

print("keys the Builder writes into a listing rule:", sorted(contract))
print("  diagnostics only (the runtime ignores them on purpose):", sorted(written & DIAGNOSTIC))
print("WRITTEN BUT NEVER READ:", sorted(contract - read) or "none")
print("READ BUT NEVER WRITTEN:",
      sorted({"next_selector", "page_param", "row_selector", "max_pages", "page_numbers",
              "unique", "fallback", "absolute", "scope", "group", "filter", "attr", "select",
              "text", "document", "fields"} - written - read) or "none")
print("keys that do not even reach `ListingRule`:",
      sorted(contract - set(ListingRule.__dataclass_fields__)) or "none")

# Only the *top level* of a work draft is the template's contract; the keys inside `work`,
# `targets` and `documents` belong to those sections.
work_draft = draft_site_json([sample], learn([sample]))
work_written = set(work_draft)
carried = set(SiteTemplate.__dataclass_fields__) | {"targets", "documents", "work", "listings"}
print("\nthe work draft writes:", sorted(work_written))
print("  WRITTEN BUT THE TEMPLATE DOES NOT CARRY IT:",
      sorted(work_written - carried - {"_draft", "generated_from", "review"}) or "none")

implemented = set(re.findall(r"""kind == ["']([a-z_]+)["']""",
                             (ROOT / "src/generic/select.py").read_text(encoding="utf-8")))
print("\n`from` kinds the Builder emits:", kinds_written)
print("  EMITTED BUT NOT IMPLEMENTED:", sorted(set(kinds_written) - implemented) or "none")
print("  implemented, never emitted by the Builder (hand-written sites use them):",
      sorted(implemented - set(kinds_written)))
print("\nthe drafted listing rule:")
print(json.dumps(drafts["url_param"]["listings"]["search"], ensure_ascii=False)[:400])
