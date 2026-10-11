"""Does a rule naming the row read the row itself, or nothing?

The learner drops such a rule ("a rule naming the row cannot be shipped"), and this says what the
runtime actually does with it — measured, not assumed.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.generic.document import Document, DocumentBag
from src.generic.select import resolve

CARD = ('<a class="book-layout" href="/novel/3095.html">'
        '<img class="lazyloaded" data-src="https://x.test/3095s.jpg">'
        '<h4 class="book-title">败北女角太多了！</h4></a>')

bag = DocumentBag()
bag.add(Document(name="listing_html", text=f'<div class="grid">{CARD}</div>', format="html",
                 url="https://x.test/list"))

root = bag.require("listing_html").html()
rows = [element for element in root.iter() if element.attr("class") == "book-layout"]
row = rows[0]

scoped = DocumentBag()
scoped.add(Document.from_element("listing_html", row, "https://x.test/list"))

cases = {
    "row-named + href": {"from": "html", "select": "a.book-layout", "attr": "href"},
    "row-named + text": {"from": "html", "select": "a.book-layout", "text": True},
    "no select + href": {"from": "html", "attr": "href"},
    "no select + text": {"from": "html", "text": True},
    "child title": {"from": "html", "select": "h4.book-title", "text": True},
    "descendant img": {"from": "html", "select": "img", "attr": "data-src"},
}
for label, rule in cases.items():
    try:
        print(f"{label:22s} -> {resolve(rule, scoped, context={'url': '', 'card': {}})!r}")
    except Exception as error:                                    # noqa: BLE001 - a diagnostic
        print(f"{label:22s} -> raised {type(error).__name__}: {error}")
