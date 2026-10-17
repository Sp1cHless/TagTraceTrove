"""Focused, offline checks of later human corrections through adapter installation."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_adapter
import verify_adapter
from src.builder.annotate import hypotheses, rule_for
from src.builder.capture import Capture, plain_documents
from src.builder.harvest import harvest
from src.builder.learn import (Sample, apply_to, draft_site_json, learn, learn_for_runtime,
                               load_session, read_rule)
from src.builder.roundtrip import compare, compare_latest, draft_samples


def sample(name, old_title, new_title, *, choose_new=False, author=None):
    markup = f'<h1 class="old">{old_title}</h1><h2 class="new">{new_title}</h2>'
    if author:
        markup += f'<div class="author">{author}</div>'
    capture = Capture(url=f"https://fixture.test/detail/{name}", status=200,
                      documents=plain_documents(markup))
    result = harvest(capture)
    value = new_title if choose_new else old_title
    picked = next(c for c in result.candidates if c.kind == "text" and c.value == value)
    reference = Sample(name=name, capture=capture, harvest=result,
                       annotated={"title": value}, picks={"title": picked.candidate_id})
    reference.selected_rules = {"title": rule_for(picked)}
    if author:
        reference.annotated["creator"] = author
    return reference


def pair():
    return [sample("one", "First accepted", "First unrelated", author="Earlier author"),
            sample("two", "Wrong proposal", "Second corrected", choose_new=True)]


def save(reference, directory):
    directory.mkdir()
    reference.capture.write(directory / "capture.json")
    payload = {"fields": reference.annotated, "picks": reference.picks,
               "hypotheses": {field: {"rule": rule} for field, rule in reference.selected_rules.items()}}
    (directory / "annotations.json").write_text(json.dumps(payload), encoding="utf-8")


def test_later_rules_win_and_earlier_mismatches_do_not_block_acceptance(tmp_path):
    samples = pair()
    learning = learn_for_runtime(samples)
    rule = learning.chosen_rules()["title"]
    assert rule["select"] == "h2.new"
    assert read_rule(rule, samples[1].capture) == "Second corrected"
    draft = draft_site_json(samples, learning)
    assert draft["_draft"]["rule_policy"] == "latest_annotation"
    assert not compare(samples[0], draft, tmp_path).ok
    assert compare_latest(samples, draft, tmp_path).ok
    assert "creator" in learning.chosen_rules(), "a later unanswered field must not erase an earlier answer"
    winner = next(report.chosen() for report in learning.fields if report.field == "title")
    assert any(reading.superseded for reading in winner.readings)
    assert "latest annotation" in winner.reason()


def test_the_third_page_uses_the_second_pages_corrected_rule():
    first, second = pair()
    third = sample("three", "Wrong again", "Third correct", choose_new=True)
    assert apply_to([first, second], third.capture)["title"]["value"] == "Third correct"


def test_a_new_click_replaces_the_applied_rule_in_saved_hypotheses():
    first, second = pair()
    applied = apply_to(first, second.capture)
    assert applied["title"]["value"] == "Wrong proposal"
    recorded = hypotheses(second.annotated, second.harvest, picks=second.picks, applied=applied)
    assert recorded["title"]["rule"]["select"] == "h2.new"
    assert read_rule(recorded["title"]["rule"], second.capture) == "Second corrected"


def test_latest_manual_choice_outranks_a_rule_that_agrees_with_more_old_samples():
    first, second = pair()
    # Both selectors read the accepted value on page two, but only h1 agrees on page one.
    second.capture.documents = plain_documents('<h1 class="old">Second corrected</h1>'
                                               '<h2 class="new">Second corrected</h2>')
    second.harvest = harvest(second.capture)
    second.picks = {}
    second.selected_rules = {"title": {"from": "html", "document": "page",
                                        "select": "h2.new", "text": True}}
    assert learn_for_runtime([first, second]).chosen_rules()["title"]["select"] == "h2.new"


def test_latest_still_has_to_reproduce_its_own_accepted_value():
    first, second = pair()
    second.selected_rules = {"title": {"from": "const", "value": "Not selected"}}
    learning = learn_for_runtime([first, second])
    report = next(report for report in learning.fields if report.field == "title")
    wrong = next(item for item in report.hypotheses if item.rule.get("from") == "const")
    assert wrong.verdict == "prune"
    assert learning.chosen_rules()["title"].get("from") != "const"


def test_recorded_latest_rule_is_preserved_when_sessions_are_reloaded(tmp_path):
    samples = pair()
    for reference in samples:
        save(reference, tmp_path / reference.name)
    reloaded = [load_session(tmp_path / reference.name) for reference in samples]
    draft = draft_site_json(reloaded, learn_for_runtime(reloaded))
    assert draft_samples(tmp_path / "one", draft)[1].selected_rules == samples[1].selected_rules
    assert compare_latest(draft_samples(tmp_path / "one", draft), draft, tmp_path / "one").ok
    draft["_draft"]["generated_from"] = ["../outside"]
    with pytest.raises(ValueError, match="unavailable"):
        draft_samples(tmp_path / "one", draft)


def test_legacy_strict_learning_keeps_cross_sample_validation():
    samples = pair()
    assert "title" not in learn(samples).chosen_rules()


def test_interactive_build_and_later_verify_install_using_the_latest_page(tmp_path, monkeypatch):
    samples = pair()
    for reference in samples:
        save(reference, tmp_path / reference.name)
    monkeypatch.setattr(build_adapter, "one_sample",
                        lambda url, **options: tmp_path / next(s.name for s in samples if s.url == url))
    monkeypatch.setattr(build_adapter.unknown_url, "fetch", lambda url: (
        200, next(s.capture.markup.text.encode() for s in samples if s.url == url), "text/html", url))
    probed = []
    monkeypatch.setattr(build_adapter, "probe_draft", lambda draft, url, **options: (
        probed.append(url) or SimpleNamespace(findings=lambda: [])))
    monkeypatch.setattr(build_adapter, "format_probe_report", lambda report: [])
    installed = []
    target = tmp_path / "installed"
    target.mkdir()
    (target / "learned.json").write_text("{}", encoding="utf-8")
    def fake_install(draft, root, **options):
        installed.append(draft)
        return target
    monkeypatch.setattr(build_adapter, "install", fake_install)
    monkeypatch.setattr(verify_adapter, "install", fake_install)
    assert build_adapter.main(["--install", *[s.url for s in samples]]) == 0
    assert probed == [samples[-1].url]
    assert installed[-1]["work"]["fields"]["title"]["select"] == "h2.new"
    assert verify_adapter.main([str(tmp_path / "one"), "--install", "--no-probe"]) == 0
    assert len(installed) == 2
