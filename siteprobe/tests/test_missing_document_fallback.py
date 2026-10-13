"""One focused check of missing-source fallbacks, without network or library data."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.generic.bundle import RawItem
from src.generic.declarative import documents_from
from src.generic.document import Document, DocumentBag, MissingDocumentError
from src.generic.extract import extract_work
from src.generic.select import SelectorError, resolve
from src.generic.template import load_template


def html_rule(select="h2.title", **options):
    return {"from": "html", "document": "page", "select": select, "text": True, **options}


def json_rule(document="jsonld", path="name", **options):
    return {"from": "json", "document": document, "path": path, **options}


def page_bag():
    result = DocumentBag()
    result.add(Document(name="page", text='<h2 class="title">Visible title</h2>'))
    return result


def test_missing_primary_document_uses_the_html_fallback_and_keeps_a_note():
    notes = []
    rule = json_rule(fallback=[html_rule()])
    assert resolve(rule, page_bag(), context={"_fallback_notes": notes}) == "Visible title"
    assert len(notes) == 1 and "'jsonld'" in notes[0]


def test_missing_middle_fallback_does_not_block_a_later_source():
    rule = html_rule("h1", fallback=[json_rule("optional_api"), html_rule()])
    assert resolve(rule, page_bag()) == "Visible title"


def test_a_present_primary_value_keeps_priority_and_does_not_read_fallbacks():
    result = page_bag()
    result.add(Document(name="jsonld", text='{"name":"Declared title"}', format="json"))
    assert resolve(json_rule(fallback=[json_rule("absent"), html_rule()]), result) == "Declared title"


@pytest.mark.parametrize("fallback", [None, [html_rule("h1"), json_rule("other_missing")]])
def test_an_unrecovered_missing_document_still_raises_the_original_error(fallback):
    with pytest.raises(MissingDocumentError, match="'jsonld'"):
        resolve(json_rule(fallback=fallback), page_bag())


def test_ordinary_empty_values_still_fall_back_and_still_return_empty_without_a_match():
    assert resolve(html_rule("h1", fallback=[html_rule()]), page_bag()) == "Visible title"
    assert resolve(html_rule("h1", fallback=[html_rule("h3")]), page_bag()) is None


def test_malformed_payloads_and_rules_are_not_swallowed_as_missing_sources():
    result = page_bag()
    result.add(Document(name="jsonld", text="not JSON", format="json"))
    with pytest.raises(json.JSONDecodeError):
        resolve(json_rule(fallback=[html_rule()]), result)
    with pytest.raises(SelectorError):
        resolve({"from": "unknown", "fallback": [html_rule()]}, result)
    with pytest.raises(SelectorError):
        resolve({"from": "json", "path": "name", "fallback": [html_rule()]}, page_bag())


def test_declarative_extraction_recovers_title_and_cover_without_jsonld(tmp_path):
    path = tmp_path / "site.json"
    path.write_text(json.dumps({
        "key": "fixture.test", "tool": "fixture",
        "documents": {"work": {"page": {"format": "html"}, "jsonld": {"format": "json"}}},
        "work": {"fields": {
            "title": json_rule(fallback=[html_rule()]),
            "cover_url": json_rule(path="image", fallback=[
                html_rule("img.cover", text=False, attr="data-original")]),
        }},
    }), encoding="utf-8")
    template = load_template(path)
    item = RawItem(source_id="one", target_url="https://fixture.test/work/one")
    html = '<h2 class="title">Visible title</h2><img class="cover" data-original="https://cdn.test/cover.jpg">'
    for name, text in documents_from(template, html).items():
        item.add(name, text)
    record = extract_work(template, item)
    assert record["title"] == "Visible title"
    assert record["cover"]["url"] == "https://cdn.test/cover.jpg"
    assert record["diagnostics"]["unresolved"] == []
    assert any("title:" in note and "'jsonld'" in note for note in record["diagnostics"]["warnings"])
    assert any("cover_url:" in note and "'jsonld'" in note for note in record["diagnostics"]["warnings"])
