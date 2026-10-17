"""A later single-member correction must survive learning and runtime verification."""
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.builder.annotate import FIELDS, hypotheses, normalise_selected_members, rule_for
from src.builder.capture import Capture, plain_documents
from src.builder.harvest import harvest
from src.builder.learn import Sample, apply_to, draft_site_json, learn_for_runtime, load_session, read_rule
from src.builder.roundtrip import compare_latest


def recorded(name, names, position):
    markup = '<h1>Work ' + name + '</h1><ul class="people">' + ''.join(
        f'<li class="person"><a class="value">{value}</a></li>' for value in names) + '</ul>'
    capture = Capture(url=f"https://fixture.test/posts/{name}", status=200,
                      documents=plain_documents(markup))
    result = harvest(capture)
    picked = next(item for item in result.candidates if item.kind == "text" and item.value == names[position])
    picks = {"characters": picked.candidate_id}
    values = normalise_selected_members({"characters": picked.value}, result, picks)
    saved = hypotheses(values, result, picks)
    return Sample(name=name, capture=capture, harvest=result, annotated=values,
                  picks=picks, selected_rules={"characters": saved["characters"]["rule"]})


def test_second_and_third_single_choices_override_earlier_positions(tmp_path):
    first = recorded("1", ["First Person (Story One)", "Another Person (Story One)"], 0)
    second = recorded("2", ["Second Person (Story Two)", "Corrected Person (Story Two)"], 1)
    assert second.annotated["characters"] == ["Corrected Person (Story Two)"]
    assert second.selected_rules["characters"]["index"] == 1
    draft = draft_site_json([first, second], learn_for_runtime([first, second]))
    assert compare_latest([first, second], draft, tmp_path).ok
    third = recorded("3", ["Latest Person (Story Three)", "Wrong Person (Story Three)"], 0)
    assert apply_to([first, second], third.capture)["characters"]["value"] == "Wrong Person (Story Three)"
    latest = draft_site_json([first, second, third], learn_for_runtime([first, second, third]))
    assert latest["work"]["fields"]["characters"]["index"] == 0
    assert compare_latest([first, second, third], latest, tmp_path).ok


def test_whole_group_keeps_members_with_spaces_and_separators(tmp_path):
    names = ["Person One (Story One)", "Person / Two (Story One)", "Person Three (Story One)"]
    single = recorded("1", names, 0)
    group = next(item for item in single.harvest.candidates if item.kind == "collection"
                 and item.context.get("members") == names)
    values = {"characters": list(group.context["members"])}
    picks = {"characters": group.candidate_id}
    assert normalise_selected_members(values, single.harvest, picks) == values
    saved = hypotheses(values, single.harvest, picks)
    single.annotated = values
    single.picks = picks
    single.selected_rules = {"characters": saved["characters"]["rule"]}
    draft = draft_site_json([single], learn_for_runtime([single]))
    assert draft["work"]["fields"]["characters"]["list"]
    assert compare_latest([single], draft, tmp_path).ok


def test_old_single_clicks_replay_without_rewriting_original_annotations(tmp_path):
    reference = recorded("1", ["A Name (A Story)", "Other Name (A Story)"], 0)
    directory = tmp_path / "sample"
    directory.mkdir()
    reference.capture.write(directory / "capture.json")
    group = next(source.rule for item in reference.harvest.candidates
                 if item.candidate_id == reference.picks["characters"]
                 for source in item.sources if source.rule.get("list") and source.rule.get("matches") == 2)
    payload = {"fields": {"characters": "A Name (A Story)"}, "picks": reference.picks,
               "hypotheses": {"characters": {"rule": group}}}
    path = directory / "annotations.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    before = path.read_bytes()
    replayed = load_session(directory)
    assert replayed.annotated["characters"] == ["A Name (A Story)"]
    assert not replayed.selected_rules["characters"].get("list")
    assert read_rule(replayed.selected_rules["characters"], replayed.capture) == "A Name (A Story)"
    assert compare_latest([replayed], draft_site_json([replayed], learn_for_runtime([replayed])), tmp_path).ok
    assert path.read_bytes() == before


def test_the_reported_attempt_replays_all_fields_offline(tmp_path):
    configured = os.environ.get("T3_TEST_LATEST_ATTEMPT_ROOT")
    if not configured:
        pytest.skip("Set T3_TEST_LATEST_ATTEMPT_ROOT to replay a user's read-only captures.")
    root = Path(configured)
    samples = [load_session(directory) for directory in sorted(root.iterdir())
               if (directory / "annotations.json").is_file()]
    assert len(samples) >= 2
    before = {(root / sample.name / "annotations.json"): (root / sample.name / "annotations.json").read_bytes()
              for sample in samples}
    draft = draft_site_json(samples, learn_for_runtime(samples, browser_capture=True))
    result = compare_latest(samples, draft, tmp_path)
    (tmp_path / "real-attempt-roundtrip.json").write_text(json.dumps(result.to_json(), ensure_ascii=False, indent=2), encoding="utf-8")
    assert result.ok, [(item.field, item.detail) for item in result.disagreeing()]
    assert any(item.field == "characters" and item.verdict == "agree" for item in result.comparisons)
    assert all(path.read_bytes() == data for path, data in before.items())
