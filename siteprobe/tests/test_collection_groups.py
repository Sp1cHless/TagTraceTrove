"""Generic collection learning: shared styling, nested controls and two different works."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.builder.capture import Capture, plain_documents
from src.builder.harvest import Candidate, Harvest, Source, harvest, same_members
from src.builder.learn import KEEP, Sample, apply_to, learn, load_session, read_rule


def page(labels: list[str], series: list[str], *, reverse: bool = False) -> str:
    def chips(kind: str, values: list[str]) -> str:
        return "".join(
            f'<span class="chip state-{index % 2}" data-cluster-kind="{kind}" data-object-id="{9000 + index}">'
            f'<span class="meter"></span><a class="pill state-{index % 2}" href="/{kind}/{index}">{value}</a>'
            '<span class="controls"><button>▲</button><button>▼</button></span></span>'
            for index, value in enumerate(values))

    groups = [f'<div class="group"><div class="label">Labels</div>{chips("labels", labels)}</div>',
              f'<div class="group"><div class="label">Series</div>{chips("series", series)}</div>']
    if reverse:
        groups.reverse()
    return ('<nav><a class="pill" href="/home">Home</a></nav>'
            '<div id="information"><div class="download">'
            '<a class="pill download" href="/files/a.mp4">MP4 1080p<span>44 MB</span></a>'
            '<a class="pill download" href="/files/b.mp4">MP4 720p<span>25 MB</span></a>'
            '</div>' + "".join(groups) + '</div>')


def sample(html: str, name: str, annotated: dict | None = None) -> Sample:
    capture = Capture(url=f"https://fixture.test/work/{name}", status=200,
                      documents=plain_documents(html))
    return Sample(name=name, capture=capture, harvest=harvest(capture), annotated=annotated or {})


def group_for(reference: Sample, members: list[str]) -> Candidate:
    return next(candidate for candidate in reference.harvest.by_kind("collection")
                if same_members(candidate.context["members"], members))


def test_every_shown_collection_is_exactly_what_its_rule_reads():
    reference = sample(page(["Alpha", "Beta", "Gamma"], ["Story", "Style"]), "one")
    for candidate in reference.harvest.by_kind("collection"):
        for source in candidate.sources:
            assert read_rule(source.rule, reference.capture) == candidate.context["members"]
        assert candidate.context["count"] == len(candidate.context["members"])
    broad = next(candidate for candidate in reference.harvest.by_kind("collection")
                 if candidate.context["selector"] == "a.pill")
    assert "Home" in broad.context["members"]
    assert any("MP4" in member for member in broad.context["members"])


def test_categorical_groups_ignore_shared_classes_and_nested_controls_on_another_work():
    first = sample(page(["Alpha", "Beta", "Gamma"], ["Story", "Style"]), "one",
                   {"tags": ["Alpha", "Beta", "Gamma"], "series": ["Story", "Style"]})
    second = sample(page(["Delta", "Epsilon"], ["Other story", "Other style"], reverse=True), "two",
                    {"tags": ["Delta", "Epsilon"], "series": ["Other story", "Other style"]})
    first.picks = {field: group_for(first, members).candidate_id
                   for field, members in first.annotated.items()}
    applied = apply_to(first, second.capture)
    assert applied["tags"]["value"] == second.annotated["tags"]
    assert applied["series"]["value"] == second.annotated["series"]
    assert all("900" not in entry["rule"]["select"] for entry in applied.values())
    learned = learn([first, second])
    for field in ("tags", "series"):
        report = next(report for report in learned.fields if report.field == field)
        assert report.chosen().verdict == KEEP
        assert read_rule(learned.chosen_rules()[field], second.capture) == second.annotated[field]


def test_collections_keep_all_members_beyond_the_old_preview_limit():
    labels = [f"Label {index}" for index in range(65)]
    reference = sample(page(labels, ["Story", "Style"]), "many")
    candidate = group_for(reference, labels)
    assert candidate.context["count"] == 65
    assert candidate.context["members"] == labels
    assert read_rule(candidate.sources[0].rule, reference.capture) == labels


def test_a_stale_candidate_that_never_read_the_annotation_is_not_proposed():
    first = sample(page(["Alpha", "Beta"], ["Story", "Style"]), "one", {"tags": ["Alpha", "Beta"]})
    stale = Candidate(kind="collection", value="Alpha / Beta", display="Alpha / Beta",
                      candidate_id="old", sources=[Source("markup", "page", "old group", {
                          "from": "html", "document": "page", "select": "a.pill", "text": True,
                          "list": True})], context={"members": ["Alpha", "Beta"]})
    first.harvest = Harvest(url=first.capture.url, candidates=[stale])
    first.picks = {"tags": "old"}
    assert "tags" not in apply_to(first, sample(page(["Delta", "Epsilon"], []), "two").capture)


def test_existing_annotations_can_be_reharvested_without_reusing_the_bad_selector(tmp_path):
    html = page(["Alpha", "Beta", "Gamma"], ["Story", "Style"])
    reference = sample(html, "one")
    reference.capture.write(tmp_path / "capture.json")
    (tmp_path / "annotations.json").write_text(json.dumps({
        "fields": {"tags": ["Alpha", "Beta", "Gamma"], "series": ["Story", "Style"]},
        "picks": {"tags": "cand_9999", "series": "cand_9998"},
    }), encoding="utf-8")
    restored = load_session(tmp_path)
    applied = apply_to(restored, sample(page(["Delta", "Epsilon"], ["Next", "Different"]), "two").capture)
    assert applied["tags"]["value"] == ["Delta", "Epsilon"]
    assert applied["series"]["value"] == ["Next", "Different"]


def test_scoped_rules_handle_an_id_only_group_and_one_member_on_the_next_page():
    first = sample('<div id="labels"><a>One</a><a>Two</a></div><a>Navigation</a>', "one",
                   {"tags": ["One", "Two"]})
    second = sample('<a>Navigation</a><div id="labels"><a>Three</a></div>', "two")
    first.picks = {"tags": group_for(first, ["One", "Two"]).candidate_id}
    assert apply_to(first, second.capture)["tags"]["value"] == ["Three"]
