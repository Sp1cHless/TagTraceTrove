"""One focused offline check of labelled prose, safe deduplication and field shapes."""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.builder import harvest as harvest_module
from src.builder.annotate import hypotheses, page, rule_for
from src.builder.capture import Capture, plain_documents
from src.builder.harvest import (COLLECTION_JOIN, MAX_LABELLED_BLOCK_LENGTH, Harvest, Source,
                                 _Registry, harvest)
from src.builder.learn import Sample, apply_to, draft_site_json, learn_for_runtime, read_rule
from src.builder.roundtrip import compare_latest
from src.builder.session_server import Session, start


def recorded(name, author, description, *, label="Maker:"):
    description = description.strip()
    markup = (f'<html><body><h1>{name}</h1><section class="details">'
              f'<div class="row">{label}<span><a>{author}</a></span></div>'
              '<div class="row">Cast: <span><a>Actor A</a><a>Actor B</a></span></div>'
              f'<div class="row">Synopsis: <span>{description}</span></div>'
              '<div class="row">Genre: <span><a>Drama</a><a>Adventure</a></span></div>'
              '</section></body></html>')
    capture = Capture(url=f"https://fixture.test/work/{name}", status=200,
                      documents=plain_documents(markup))
    result = harvest(capture)
    return Sample(name=name, capture=capture, harvest=result,
                  annotated={"title": name, "creator": author, "description": description})


@pytest.mark.parametrize("label", ["Maker:", "创作者："])
def test_literal_labels_and_long_prose_transfer_through_the_generic_runtime(tmp_path, label):
    first = recorded("one", "Creator One", "A complete sentence. " * 30, label=label)
    second = recorded("two", "Creator Two", "Another complete sentence. " * 30, label=label)
    for reference in (first, second):
        reference.picks = {field: next(c.candidate_id for c in reference.harvest.candidates
                                      if c.kind == "text" and c.value == value)
                           for field, value in reference.annotated.items()}
        # The page normalises whitespace; preserve the exact selected values.
        reference.annotated["description"] = reference.annotated["description"].strip()
        reference.selected_rules = {field: item["rule"] for field, item in hypotheses(
            reference.annotated, reference.harvest, picks=reference.picks).items()}
    applied = apply_to(first, second.capture)
    assert applied["creator"]["value"] == "Creator Two"
    assert applied["description"]["value"] == second.annotated["description"]
    assert not applied["creator"]["rule"].get("list")
    assert applied["creator"]["rule"]["group"] == 1
    draft = draft_site_json([first, second], learn_for_runtime([first, second]))
    assert compare_latest([first, second], draft, tmp_path).ok


def test_long_text_budget_is_bounded_and_does_not_collect_the_entire_page(monkeypatch):
    text = "A long local value. " * 30
    reference = recorded("one", "Creator", text)
    assert any(c.kind == "text" and c.value == text.strip() for c in reference.harvest.candidates)
    monkeypatch.setattr(harvest_module, "MAX_LABELLED_TEXT_BUDGET", 100)
    limited = recorded("two", "Creator", text)
    assert not any(c.kind == "text" and c.value == text.strip() for c in limited.harvest.candidates)
    monkeypatch.setattr(harvest_module, "MAX_LABELLED_TEXT_BUDGET", 100_000)
    oversized = recorded("three", "Creator", "x" * (MAX_LABELLED_BLOCK_LENGTH + 1))
    assert not any(c.kind == "text" and len(c.value) > MAX_LABELLED_BLOCK_LENGTH
                   for c in oversized.harvest.candidates)


def test_equal_groups_merge_all_sources_but_the_larger_group_remains_selectable():
    markup = ('<div id="whole"><section class="inner"><div class="names">'
              '<a>Maker</a><a>Actor</a><a>Drama</a></div></section><a>HD</a></div>')
    result = harvest(Capture(url="https://fixture.test/work/one", documents=plain_documents(markup)))
    equal = [c for c in result.candidates if c.kind == "collection"
             and c.context.get("members") == ["Maker", "Actor", "Drama"]]
    assert len(equal) == 1
    assert len({source.rule["select"] for source in equal[0].sources}) >= 2
    larger = [c for c in result.candidates if c.kind == "collection" and "HD" in c.context.get("members", [])]
    assert larger and all(c is not equal[0] for c in larger)


def test_deduplication_preserves_order_and_embedded_display_separators():
    registry = _Registry()
    groups = [["A / B", "C"], ["A", "B / C"], ["C", "A / B"]]
    for index, members in enumerate(groups):
        registry.add("collection", COLLECTION_JOIN.join(members),
                     Source("markup", "page", str(index), {"list": True}),
                     context={"members": members})
    assert len(registry.all()) == 3
    registry.add("collection", COLLECTION_JOIN.join(groups[0]),
                 Source("markup", "other", "alternative", {"list": True}),
                 context={"members": groups[0]})
    assert len(registry.all()) == 3 and len(registry.all()[0].sources) == 2


def test_zero_score_single_values_remain_visible_and_selectable():
    registry = _Registry()
    scalar = registry.add("text", "Correct zero-score value", Source("markup", "page", "first", {
        "from": "html", "document": "page", "select": "div.value", "text": True}))
    scalar.score = 0
    scalar.candidate_id = "zero"
    registry.add("text", scalar.value, Source("markup", "other", "first", {
        "from": "meta", "document": "other", "name": "value"}))
    result = Harvest(url="https://fixture.test", candidates=registry.all())
    html = page(result, url=result.url, lang="zh")
    payload = json.loads(re.search(r"const DATA = (.*?);\n", html, re.S).group(1))
    choice = next(c for c in payload["candidates"] if c["id"] == "zero")
    assert choice["score"] == 0 and "scalar" in choice["usable_for"]
    assert len(choice["sources"]) == 2
    assert hypotheses({"creator": scalar.value}, result, picks={"creator": "zero"})["creator"]


def test_groups_cannot_be_saved_as_scalar_descriptions_and_members_are_not_resplit():
    registry = _Registry()
    members = ["Alpha / alias", "Beta", "Gamma"]
    group = registry.add("collection", COLLECTION_JOIN.join(members), Source("markup", "page", "group", {
        "from": "html", "document": "page", "select": "a", "text": True, "list": True}),
        context={"members": members, "count": 3})
    group.candidate_id = "group"
    result = Harvest(url="https://fixture.test", candidates=[group])
    assert rule_for(group, kind="scalar") is None
    assert rule_for(group, kind="collection") is not None
    with pytest.raises(ValueError, match="single value"):
        hypotheses({"description": members}, result, picks={"description": "group"})
    with pytest.raises(ValueError, match="compatible"):
        # A field that holds one value cannot be answered with a whole set. `creator` is no
        # longer one of those — one name or several, by the person's own switch — so the
        # invariant is stated on a field that really is single-valued.
        hypotheses({"title": group.value}, result, picks={"title": "group"})
    html = page(result, url=result.url)
    payload = json.loads(re.search(r"const DATA = (.*?);\n", html, re.S).group(1))
    assert payload["candidates"][0]["members"] == members
    assert "scalar" not in payload["candidates"][0]["usable_for"]
    assert "c.members.slice()" in html


def test_annotation_server_rejects_a_wrong_shape_without_saving_or_finishing(tmp_path):
    reference = recorded("one", "Creator", "A short description.")
    session = Session(harvest=reference.harvest, directory=tmp_path, url=reference.url)
    server, url = start(session)
    parsed = urllib.parse.urlparse(url)
    endpoint = f"http://{parsed.netloc}/api/annotations?{parsed.query}"
    request = urllib.request.Request(endpoint,
        data=json.dumps({"url": reference.url, "fields": {"description": ["metadata", "prose"]}}).encode(),
        headers={"Content-Type": "application/json"})
    try:
        with pytest.raises(urllib.error.HTTPError) as failure:
            urllib.request.urlopen(request, timeout=3)
        assert failure.value.code == 400
        assert "single value" in json.loads(failure.value.read())["error"]
        assert not (tmp_path / "annotations.json").exists()
        assert not session.done.is_set()
    finally:
        server.shutdown()
        server.server_close()
