"""Focused regression for generic labels outside a value's nested markup."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.builder.capture import Capture, plain_documents
from src.builder.harvest import harvest, labelled_value_row
from src.builder.learn import Sample, apply_to, draft_site_json, learn, read_rule
from src.builder.roundtrip import template_from
from src.generic.bundle import RawItem
from src.generic.declarative import documents_from
from src.generic.extract import extract_work
from src.generic.htmltree import parse_html, select_one


def table_sample(name: str, author: str, label: str = "Maker:") -> Sample:
    author_id = author.partition(" | ")[0]
    html = (
        f'<h1>{name}</h1><div id="uploader"><a>upload_account</a></div>'
        '<table id="metadata"><tbody>'
        '<tr><td class="label">Series:</td><td><div class="chip"><a>Series One</a></div></td></tr>'
        f'<tr><td class="label">{label}</td><td>'
        f'<div class="chip" id="value_{author_id}"><a id="link_{author_id}">{author}</a></div>'
        '</td></tr><tr><td class="label">Tags:</td><td>'
        '<div class="chip"><a>Tag One</a></div><div class="chip"><a>Tag Two</a></div>'
        '</td></tr></tbody></table>'
    )
    capture = Capture(url=f"https://fixture.test/work/{name}", status=200,
                      documents=plain_documents(html))
    result = harvest(capture)
    candidate = next(c for c in result.candidates if c.value == author)
    return Sample(name=name, capture=capture, harvest=result,
                  annotated={"title": name, "creator": author},
                  picks={"creator": candidate.candidate_id})


@pytest.mark.parametrize("label", ["Maker:", "制作：", "Drawn by"])
def test_nested_label_transfers_through_confirmation_learning_and_runtime(tmp_path, label):
    first = table_sample("one", "creator12003", label)
    second = table_sample("two", "another | alias", label)
    assert apply_to(first, second.capture)["creator"]["value"] == "another | alias"
    rules = learn([first, second]).chosen_rules()
    assert "creator" in rules
    assert rules["creator"]["group"] == 1
    assert read_rule(rules["creator"], second.capture) == "another | alias"
    assert "creator12003" not in str(rules["creator"])
    draft = draft_site_json([first, second], learn([first, second]))
    template = template_from(draft, tmp_path)
    item = RawItem(source_id="two", target_url=second.capture.url)
    for name, document in documents_from(template, second.capture.markup.text).items():
        item.add(name, document)
    assert extract_work(template, item)["author"] == "another | alias"


def test_unique_name_based_ids_also_offer_the_stable_row_alternative():
    reference = table_sample("one", "writer")
    candidate = next(c for c in reference.harvest.candidates if c.value == "writer")
    row_rules = [source.rule for source in candidate.sources
                 if source.rule and source.rule.get("group") == 1]
    assert row_rules
    second = table_sample("two", "different")
    assert any(read_rule(rule, second.capture) == "different" for rule in row_rules)


def test_two_interactive_chips_are_not_labels_even_with_nested_text():
    root = parse_html('<div class="tags"><a><span>Alpha</span></a>'
                      '<a class="value"><span>Beta</span></a></div>')
    assert labelled_value_row(select_one(root, "a.value span"), "Beta") is None
    assert labelled_value_row(select_one(root, "a.value"), "Beta") is None


def test_a_multi_value_row_does_not_claim_it_reads_one_selected_author():
    root = parse_html('<table><tr><td>Maker:</td><td>'
                      '<div><a>Alpha</a></div><div class="value"><a>Beta</a></div>'
                      '</td></tr></table>')
    assert labelled_value_row(select_one(root, "div.value a"), "Beta") is None


def test_label_search_does_not_cross_a_table_row_boundary():
    root = parse_html('<table><tr><td>Maker:</td></tr>'
                      '<tr><td><div><a>Beta</a></div></td></tr></table>')
    assert labelled_value_row(select_one(root, "a"), "Beta") is None


def test_label_search_is_bounded():
    root = parse_html('<div><span>Maker:</span><div>' + '<div>' * 7
                      + '<a>Beta</a>' + '</div>' * 7 + '</div></div>')
    assert labelled_value_row(select_one(root, "a"), "Beta") is None
