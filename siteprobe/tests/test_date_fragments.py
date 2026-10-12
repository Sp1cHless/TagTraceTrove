"""One focused check of mixed-text date candidates, meaning selection and runtime reuse."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.builder.annotate import hypotheses, page
from src.builder.capture import Capture, plain_documents
from src.builder.harvest import harvest
from src.builder.learn import Sample, apply_to, draft_site_json, learn, load_session, read_rule
from src.builder.roundtrip import template_from
from src.generic.dates import extract_date
from src.generic.declarative import documents_from
from src.generic.bundle import RawItem
from src.generic.extract import extract_work


def sample(html: str, name: str = "one") -> Sample:
    capture = Capture(url=f"https://fixture.test/work/{name}", status=200,
                      documents=plain_documents(html))
    return Sample(name=name, capture=capture, harvest=harvest(capture))


def date_candidate(reference: Sample, value: str, kind: str):
    return next(candidate for candidate in reference.harvest.candidates
                if candidate.value == value and candidate.context.get("date_kind") == kind)


def test_the_screenshot_shape_produces_a_clean_labelled_date_and_a_reusable_rule(tmp_path):
    first = sample('<h1>First</h1><div id="metadata">Posted:2026-10-09 16:30Parent:4242090'
                   'Visible:YesLanguage:Chinese TRFile Size:816.4 MiBLength:80 pages</div>')
    picked = date_candidate(first, "2026-10-09 16:30", "published")
    assert "发布" in picked.display or "Published" in picked.display
    assert read_rule(picked.sources[0].rule, first.capture) == "2026-10-09 16:30"
    first.annotated = {"title": "First", "date": picked.value}
    first.picks = {"date": picked.candidate_id}
    second = sample('<h1>Second</h1><div id="metadata">Posted:2026-11-02 08:05Parent:9999'
                    'Visible:YesLength:12 pages</div>', "two")
    second.annotated = {"title": "Second", "date": "2026-11-02 08:05"}
    applied = apply_to(first, second.capture)
    assert applied["date"]["value"] == "2026-11-02 08:05"
    assert applied["date"]["date_kind"] == "published"
    draft = draft_site_json([first, second], learn([first, second]))
    template = template_from(draft, tmp_path)
    item = RawItem(source_id="two", target_url=second.capture.url)
    for name, document in documents_from(template, second.capture.markup.text).items():
        item.add(name, document)
    assert extract_work(template, item)["date_added"] == "2026-11-02 08:05"


def test_equal_published_and_updated_values_stay_distinct_and_keep_the_chosen_meaning(tmp_path):
    first = sample('<div id="metadata">Updated:2026-10-09 16:30Posted:2026-10-09 16:30</div>')
    published = date_candidate(first, "2026-10-09 16:30", "published")
    updated = date_candidate(first, "2026-10-09 16:30", "updated")
    assert published.candidate_id != updated.candidate_id
    first.annotated = {"date": published.value}
    first.picks = {"date": published.candidate_id}
    second = sample('<div id="metadata">Updated:2026-11-04 10:00Posted:2026-11-02 08:05</div>', "two")
    second.annotated = {"date": "2026-11-02 08:05"}
    assert apply_to(first, second.capture)["date"]["value"] == "2026-11-02 08:05"
    rules = learn([first, second]).chosen_rules()
    assert read_rule(rules["date"], second.capture) == "2026-11-02 08:05"

    saved_hypotheses = hypotheses(first.annotated, first.harvest, picks=first.picks)
    assert saved_hypotheses["date"]["date_kind"] == "published"
    first.capture.write(tmp_path / "capture.json")
    (tmp_path / "annotations.json").write_text(json.dumps({
        "fields": first.annotated, "picks": {"date": "old-candidate-id"},
        "hypotheses": saved_hypotheses,
    }), encoding="utf-8")
    restored = load_session(tmp_path)
    assert apply_to(restored, second.capture)["date"]["value"] == "2026-11-02 08:05"


@pytest.mark.parametrize("text, expected", [
    ("Posted:2026-10-09 16:30Parent:9999", "2026-10-09 16:30"),
    ("Uploaded:2026-10-09T16:30:45+08:00Visible:Yes", "2026-10-09T16:30:45+08:00"),
    ("发布日期：2026年10月9日 16:30页数：80", "2026年10月9日 16:30"),
    ("Date 2026-02-30", ""),
    ("Posted:2026-10-09 25:90", ""),
    ("2026-10-01 to 2026-10-09", ""),
])
def test_the_shared_transform_validates_and_preserves_without_guessing(text, expected):
    assert extract_date(text) == expected


def test_unlabelled_multiple_dates_are_not_turned_into_an_automatic_first_date():
    reference = sample('<div id="metadata">2026-10-01 to 2026-10-09</div>')
    assert not [candidate for candidate in reference.harvest.candidates
                if candidate.context.get("date_kind")]


def test_jsonld_and_machine_readable_dates_remain_available_and_are_not_replaced_by_mixed_text():
    reference = sample('<time datetime="2026-10-09T16:30:00Z">October 9</time>'
        '<script type="application/ld+json">{"datePublished":"2026-10-09T16:30:00Z",'
        '"dateModified":"2026-11-01T18:00:00Z"}</script>'
        '<div id="metadata">Posted:2026-10-09T16:30:00ZParent:1234</div>')
    picked = date_candidate(reference, "2026-10-09T16:30:00Z", "published")
    assert any(source.rule.get("from") == "json" for source in picked.sources)
    assert any(source.rule.get("attr") == "datetime"
               for candidate in reference.harvest.candidates for source in candidate.sources)
    assert date_candidate(reference, "2026-11-01T18:00:00Z", "updated")
    shown = page(reference.harvest, url=reference.capture.url, lang="zh")
    assert '"date_kind": "published"' in shown
    assert "c.date_kind ? c.display : c.value" in shown
