"""Phase 5: what makes a hypothesis a rule, and what a draft is allowed to claim.

The fixture is one invented site sampled three times. Two differences are built into
it on purpose:

* the `<h1>`'s class changes on the third page, so a rule learned from that class
  reads nothing there and must be pruned with a reason;
* `creator` appears in only the first sample's annotation, so its rule is neither
  supported nor contradicted and must be reported as unproven — not quietly promoted
  into the draft as if two other pages had agreed with it.

Run:  .venv/Scripts/python.exe -m pytest -q
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder.annotate import rule_for  # noqa: E402
from src.builder.capture import Capture, Document, plain_documents  # noqa: E402
from src.builder.harvest import Harvest, harvest, same_members  # noqa: E402
from src.builder.learn import (  # noqa: E402
    KEEP,
    PRUNE,
    UNPROVEN,
    FieldReport,
    Hypothesis,
    Sample,
    _pair,
    api_identifier,
    apply_to,
    capture_to_bag,
    draft_site_json,
    learn,
    load_session,
    network_documents,
    read_rule,
    runtime_fields,
    site_authority,
    url_pattern_for,
)
from src.generic.select import resolve  # noqa: E402
from src.generic.template import load_template  # noqa: E402

SAMPLES = PROJECT_ROOT / "fixtures" / "learned_site"
LABELLED = PROJECT_ROOT / "fixtures" / "labelled_row_site"
BASE = "https://fixture.test/"


def sample_of(name: str, *, directory: Path | None = None, base: str = BASE) -> Sample:
    """One fixture sample, with its declared values turned into an annotation.

    A real annotation holds candidate ids, because a person chooses from the page.
    The fixture declares values; this maps them, which is what a person clicking the
    matching candidate would have produced.
    """
    directory = (directory or SAMPLES) / name
    url = f"{base}work/{name}"
    capture = Capture(url=url, final_url=url)
    capture.status = 200
    capture.content_type = "text/html"
    capture.documents = plain_documents((directory / "page.html").read_text(encoding="utf-8"))
    result = harvest(capture)
    declared = json.loads((directory / "expected.json").read_text(encoding="utf-8"))

    annotated: dict[str, str] = {}
    for field, value in declared.items():
        # `cover` is declared as the work's title in the fixture, meaning "the cover
        # of this work" — the image candidate whose URL carries this work's slug.
        if field == "cover":
            slug = value.casefold().replace(" ", "-")
            candidate = next(c for c in result.by_kind("image") if slug in c.value)
        else:
            candidate = next(c for c in result.candidates if c.value == value)
        annotated[field] = candidate.value
    return Sample(name=name, capture=capture, harvest=result, annotated=annotated)


def learning_over_three() -> tuple[list[Sample], object]:
    samples = [sample_of("sample1"), sample_of("sample2"), sample_of("sample3")]
    return samples, learn(samples)


# --- a hypothesis becomes a rule by surviving other pages -------------------- #

def test_a_rule_reads_the_right_value_on_a_page_it_never_saw():
    """The property the whole phase rests on, and it needs no network: the samples
    are recorded, so the rule is resolved against documents already on disk."""
    samples, _ = learning_over_three()
    meta = next(source for source in samples[0].harvest.candidates
                if source.value == "Quiet Harbor"
                for source in source.sources
                if source.rule and source.rule.get("from") == "meta")

    read = resolve(meta.rule, samples[1].bag())

    assert read == "Salt and Iron"


def test_a_rule_that_breaks_on_a_later_page_is_pruned_with_a_reason():
    """The fixture's third page renames the h1's class, which is exactly the kind of
    change that leaves a class-based rule reading nothing."""
    _samples, learning = learning_over_three()
    report = next(item for item in learning.fields if item.field == "title")

    verdicts = {}
    for hypothesis in report.hypotheses:
        rule = hypothesis.rule
        key = rule.get("select") or rule.get("name") or rule.get("property")
        verdicts[key] = hypothesis

    assert verdicts["og:title"].verdict == KEEP
    broken = verdicts["h1.work-title"]
    assert broken.verdict == PRUNE
    assert "sample3" in broken.reason()
    assert "nothing" in broken.reason()


def test_a_field_only_one_page_could_check_is_unproven_not_a_rule():
    """`creator` is in the first sample's annotation only. Nothing contradicted it and
    nothing supported it, and the difference matters."""
    _samples, learning = learning_over_three()
    report = next(item for item in learning.fields if item.field == "creator")

    assert report.hypotheses
    assert all(item.verdict == UNPROVEN for item in report.hypotheses)
    assert "nothing but the annotated page" in report.hypotheses[0].reason()


def test_the_draft_prefers_the_rule_that_survived_over_the_one_that_did_not():
    _samples, learning = learning_over_three()

    assert learning.chosen_rules()["title"]["from"] == "meta"
    assert learning.chosen_rules()["cover"]["from"] == "html"


def test_one_sample_is_not_enough_and_says_so():
    samples = [sample_of("sample1")]

    learning = learn(samples)

    assert any("no hypothesis can be checked" in note for note in learning.notes)


def test_a_sample_without_an_annotation_has_nothing_to_learn():
    """Unchanged in spirit: a page that answered nothing offers nothing. What changed is
    that a page which *did* answer is asked, whichever of the samples it is."""
    samples = [sample_of("sample1"), sample_of("sample2")]
    samples[0].annotated = {}
    samples[1].annotated = {}

    assert learn(samples).fields == []


def test_a_field_answered_on_a_later_page_is_still_learned():
    """Measured in a real session whose first work carried no 登場人物 and no 系列 and whose
    second carried both: the person filled them in on the second page, and the third page
    was then offered nothing at all for either — because only the first sample was asked."""
    samples = [sample_of("sample1"), sample_of("sample2")]
    samples[0].annotated = {}

    learning = learn(samples)

    assert learning.fields
    offered = {reading.sample for report in learning.fields
               for hypothesis in report.hypotheses
               for reading in hypothesis.readings if reading.source}
    assert offered == {samples[1].name}
    assert any("carries no annotation" in note for note in learning.notes)


# --- previews: the field is many pictures ----------------------------------- #

def preview_sample(name: str, pictures: list[str], title: str) -> Sample:
    """One page whose previews are a group, annotated the way the page posts it.

    The annotation is the members the group candidate holds — what a person marking
    "this whole set" records — so the rule has to read all of them back.
    """
    html = (f'<!doctype html><html><head><title>{title}</title></head><body>'
            f'<h1 class="work-title">{title}</h1>'
            f'<div class="previews">'
            + "".join(f'<img src="{source}">' for source in pictures)
            + "</div></body></html>")
    url = f"{BASE}work/{name}"
    capture = Capture(url=url, final_url=url)
    capture.status = 200
    capture.content_type = "text/html"
    capture.documents = plain_documents(html)
    result = harvest(capture)
    group = next(c for c in result.by_kind("images"))
    return Sample(name=name, capture=capture, harvest=result,
                  annotated={"title": title, "preview": list(group.context["members"])})


def preview_samples() -> list[Sample]:
    return [
        preview_sample("work1", ["/i/1a.jpg", "/i/1b.jpg", "/i/1c.jpg"], "First"),
        preview_sample("work2", ["/i/2a.jpg", "/i/2b.jpg", "/i/2c.jpg"], "Second"),
        preview_sample("work3", ["/i/3a.jpg", "/i/3b.jpg", "/i/3c.jpg"], "Third"),
    ]


def test_a_preview_set_is_learned_as_the_runtimes_preview_list():
    """What the field is for: the same act as marking a cover, recorded as the list the
    runtime reads — `preview_urls` in, `preview_images` out."""
    samples = preview_samples()

    learning = learn(samples)

    report = next(item for item in learning.fields if item.field == "preview")
    assert report.chosen().verdict == KEEP
    assert learning.chosen_rules()["preview"]["list"] is True
    mapped = runtime_fields(learning)
    assert mapped["preview_urls"]["list"] is True
    assert mapped["preview_urls"]["select"] == "div.previews img"
    draft = draft_site_json(samples, learning)
    assert draft["work"]["fields"]["preview_urls"]["list"] is True


def test_a_preview_set_keeps_three_pictures_and_the_rule_reads_three():
    """The user's rule: the entry shows a cover and a few pictures behind it, so a preview
    set keeps three. The cap is on both halves — the annotation the page records and the
    `limit` the rule carries — because a truncated annotation against a rule that reads
    everything is exactly how a correct rule was pruned before."""
    def page_with_five(name: str, index: int) -> Sample:
        return preview_sample(name, [f"/i/{index}{letter}.jpg"
                                     for letter in ("a", "b", "c", "d", "e")],
                              f"Work {index}")

    samples = [page_with_five("work1", 1), page_with_five("work2", 2)]
    # What the annotation page records for a capped field: the first three of the group.
    for sample in samples:
        sample.annotated["preview"] = sample.annotated["preview"][:3]

    learning = learn(samples)

    report = next(item for item in learning.fields if item.field == "preview")
    chosen = report.chosen()
    assert chosen.verdict == KEEP, chosen.reason()
    assert chosen.rule["limit"] == 3
    assert chosen.rule["list"] is True
    # And it read three, not five: the same number the annotation holds.
    assert len(next(reading for reading in chosen.readings
                    if reading.source is False).value) == 3


def test_a_preview_field_takes_the_rule_that_reads_all_the_pictures():
    """A rule reading one picture is the wrong shape for this field however few elements
    it names — the same reason a title is not learned from a rule that reads a whole
    group. The field's *kind* is what decides, and it is decided here."""
    single = Hypothesis(rule={"select": "img", "attr": "src", "matches": 3},
                        from_candidate="cand_0001", sources=["markup"])
    group = Hypothesis(rule={"select": "div.previews img", "attr": "src",
                             "list": True, "matches": 3},
                       from_candidate="cand_0002", sources=["markup"])

    previews = FieldReport(field="preview", kind="images", hypotheses=[single, group])
    titles = FieldReport(field="title", kind="scalar", hypotheses=[single, group])

    assert previews.chosen().rule.get("list") is True
    assert titles.chosen().rule.get("list") is None




def test_the_document_bag_is_built_the_way_an_adapter_must_build_it():
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<script type="application/ld+json">{"@type":"Book","name":"N"}</script>'))
    capture.documents.append(Document(name="network:0", format="json",
                                      text='{"title":"T"}'))
    capture.documents.append(Document(name="inline:0", format="script",
                                      text='window.__X__=(function(a){return a}(1));'))
    capture.documents.append(Document(name="inline:1", format="script",
                                      text='window.__Y__={"kept":true}'))

    bag = capture_to_bag(capture)
    names = set(bag.documents)

    assert names == {"page", "jsonld", "network:0", "inline:1"}
    # The script that is not JSON is absent, which is the same reason a positional
    # literal carries no rule: no `json` selector could read it.
    assert "inline:0" not in names


# --- the draft -------------------------------------------------------------- #

def test_the_derived_pattern_matches_every_sample_it_came_from():
    samples = [sample_of(name) for name in ("sample1", "sample2", "sample3")]
    pattern = url_pattern_for(samples)

    assert pattern
    import re

    assert all(re.search(pattern, sample.url) for sample in samples)
    # It must also *capture* the work's id: the registry reads one out of the groups,
    # and a pattern that only matches is a site the tool refuses to claim.
    matched = re.search(pattern, samples[0].url)
    assert matched and matched.groups(), "the pattern captures no id"
    # And it is not simply "anything": a different path is not a work of this site.
    assert not re.search(pattern, f"{BASE}other/thing")


def test_the_pattern_captures_the_number_that_names_the_work():
    """The id is the **number**, not the whole path segment — and the same number the listing reads.

    Measured on bilinovel (2026-10-04): the work target captured `([^/]+)` of `/novel/4525.html`, so a
    work's id was `4525.html` on the work path, while the listing half of the same adapter — which
    narrows the card's link to the digits — called that same work `4525`. One work with two ids means
    the two doors disagree about what they have already seen, and the id is an internal name (it
    spells the export directory and every media id) that only has to tell one work from another within
    one site. Same doctrine as the card side's `card_rule_for_id`: the **last** number, since a work
    address carries its own title, and the anchor is what makes the engine take the last one rather
    than the first it can reach.
    """
    import re

    def samples_for(urls):
        return [Sample(name=f"work{index}", capture=Capture(url=url, final_url=url),
                       harvest=Harvest(url=url))
                for index, url in enumerate(urls, start=1)]

    def identity(pattern: str, url: str) -> str:
        matched = re.search(pattern, url)
        assert matched is not None, f"{pattern} does not match its own sample {url}"
        return matched.groupdict().get("id") or matched.group(1)

    cases = [
        # The site's own extension, a trailing slash instead of one, and a title before the number.
        (["https://site.test/novel/4525.html", "https://site.test/novel/4057.html"], ["4525", "4057"]),
        (["https://site.test/album/1472965/", "https://site.test/album/1472966/"],
         ["1472965", "1472966"]),
        (["https://site.test/f/first-title-3547173.html",
          "https://site.test/f/second-title-4201383.html"], ["3547173", "4201383"]),
    ]
    for urls, expected in cases:
        pattern = url_pattern_for(samples_for(urls))
        assert [identity(pattern, url) for url in urls] == expected, pattern

    # A query or a dropped extension is the same work, and must still resolve to the same id.
    pattern = url_pattern_for(samples_for(["https://site.test/novel/4525.html",
                                           "https://site.test/novel/4057.html"]))
    assert identity(pattern, "https://site.test/novel/4525.html?from=list") == "4525"
    assert identity(pattern, "https://site.test/novel/4525") == "4525"

    # A site whose addresses carry no number keeps the whole segment: there is nothing to narrow to.
    slugs = ["https://site.test/w/abc-title/", "https://site.test/w/def-title/"]
    pattern = url_pattern_for(samples_for(slugs))
    assert [identity(pattern, url) for url in slugs] == ["abc-title", "def-title"], pattern
    assert not re.search(pattern, "https://site.test/other/thing")


def test_a_site_on_a_port_keeps_its_port_in_the_pattern():
    """`hostname` drops the port, and the pattern then matches none of its own addresses.

    Measured on a mock site served at `127.0.0.1:8811` (2026-10-03): the derived pattern
    was `^https?://127\\.0\\.0\\.1/work/…`, the install was refused because no target of the
    draft matched an address it was learned from — a real site behind a port (a mirror, a
    dev server, a proxy) would have been dropped for a reason nobody could see.
    """
    import re

    urls = [f"http://127.0.0.1:8811/work/{index}.html" for index in (1, 2, 3)]
    samples = [Sample(name=f"work{index}", capture=Capture(url=url, final_url=url),
                      harvest=Harvest(url=url))
               for index, url in enumerate(urls, start=1)]
    pattern = url_pattern_for(samples)

    assert pattern
    assert all(re.search(pattern, url) for url in urls), pattern
    assert not re.search(pattern, "http://127.0.0.1/work/1.html"), "the port is not optional"
    # A default port that was written out stays written out, because the address a person
    # pastes keeps it too.
    plain = site_authority(["https://fixture.test/work/1", "https://fixture.test/work/2"])
    assert plain == "fixture.test"
    explicit = site_authority(["http://fixture.test:80/work/1", "http://fixture.test:80/work/2"])
    assert explicit == "fixture.test:80"


def test_a_block_written_with_spaces_is_the_same_answer_as_one_written_with_slashes():
    """The candidate is found by its *members*, not by the separators it was written with.

    Measured on a real bilinovel work page (2026-10-03): the tag row reads
    `转生 奇幻 冒险 龙傲天 女性视角 欢乐向`, a person marked exactly that row, and learning answered
    "tags: no candidate for 转生 / 奇幻 / … carries a usable rule" — because the comparison rejoined
    the answer with the separator the *record* uses and compared that line to the candidate's line.
    The field was dropped, the next page proposed nothing for it, and that page's person marked a
    different block (author, label and tags together) — so nothing survived the samples and the site
    learned no tags at all. This fixture's pages write the tag row the way that page does.
    """
    samples = [sample_of(name, directory=LABELLED, base="https://labelled.test/")
               for name in ("sample1", "sample2", "sample3")]

    learning = learn(samples)

    report = next((one for one in learning.fields if one.field == "tags"), None)
    assert report is not None, learning.notes
    winner = report.chosen()
    assert winner is not None, learning.notes
    # Two pages it never saw agreed with it, which is what makes a rule a rule.
    assert winner.verdict == KEEP, winner.reason()
    # And it reads the row by its label: the members come back whole on the next work.
    assert resolve(winner.rule, samples[1].bag()) == [
        "冒险", "战斗", "欢乐向", "龙傲天", "百合", "大小姐", "女性视角"]


def test_the_draft_is_a_template_the_runtime_can_actually_load(tmp_path):
    """A draft that is only JSON is not a draft site.json. This loads it with the
    same loader an installed adapter goes through."""
    samples, learning = learning_over_three()
    draft = draft_site_json(samples, learning)
    path = tmp_path / "site.json"
    path.write_text(json.dumps(draft), encoding="utf-8")

    template = load_template(path)

    assert template.key == "fixture.test"
    assert template.hosts == ["fixture.test"]
    assert template.targets["work"].single is True
    assert template.work_fields["title"]["from"] == "meta"


def test_the_draft_says_what_it_did_not_derive():
    """Everything it states comes from the samples; what it cannot know is listed
    rather than invented."""
    samples, learning = learning_over_three()
    draft = draft_site_json(samples, learning)

    assert draft["schema_version"] == 1
    assert draft["_draft"]["generated_from"] == ["sample1", "sample2", "sample3"]
    assert len(draft["_draft"]["review"]) >= 3
    assert any("listing" in item for item in draft["_draft"]["review"])


def test_a_draft_with_no_surviving_rule_does_not_claim_one():
    samples = [sample_of("sample1"), sample_of("sample2"), sample_of("sample3")]
    for sample in samples:
        sample.annotated = {"title": "Nothing Like This Exists"}

    learning = learn(samples)
    draft = draft_site_json(samples, learning)

    assert draft["work"]["fields"] == {}
    assert any("carries a usable rule" in note for note in learning.notes)


# --- replay ------------------------------------------------------------------ #

def test_a_session_replays_from_disk_with_no_network(tmp_path):
    """What `capture.json` is for: the same page, resolved later, offline."""
    directory = tmp_path / "session"
    directory.mkdir()
    capture = Capture(url=f"{BASE}work/x", final_url=f"{BASE}work/x")
    capture.documents = plain_documents(
        (SAMPLES / "sample1" / "page.html").read_text(encoding="utf-8"))
    capture.write(directory / "capture.json")
    harvest(capture).write(directory / "candidates.json")

    sample = load_session(directory, name="replayed")

    assert sample.name == "replayed"
    assert any(candidate.value == "Quiet Harbor" for candidate in sample.harvest.candidates)


def test_replay_picks_up_an_annotation_beside_the_capture(tmp_path):
    directory = tmp_path / "session"
    directory.mkdir()
    capture = Capture(url=f"{BASE}work/x", final_url=f"{BASE}work/x")
    capture.documents = plain_documents(
        (SAMPLES / "sample1" / "page.html").read_text(encoding="utf-8"))
    capture.write(directory / "capture.json")
    result = harvest(capture)
    result.write(directory / "candidates.json")
    title = next(c for c in result.candidates if c.value == "Quiet Harbor")
    (directory / "annotations.json").write_text(json.dumps({
        "url": capture.url, "mode": "annotate",
        "fields": {"title": title.candidate_id},
    }), encoding="utf-8")

    sample = load_session(directory)

    assert sample.annotated == {"title": "Quiet Harbor"}
    assert rule_for(title) is not None


# --- a work is not required to carry every field ----------------------------- #

def test_a_field_a_page_does_not_have_is_accepted_rather_than_failing_the_rule():
    """The manual report: characters may live inside the tags, or only some works
    declare them, so "read nothing here" must not condemn the rule. Saying so is what
    tells the two silences apart."""
    samples = [sample_of(name) for name in ("sample1", "sample2", "sample3")]
    samples[1].absent = {"title"}
    samples[1].annotated = {k: v for k, v in samples[1].annotated.items()
                            if k != "title"}

    learning = learn(samples)
    report = next(item for item in learning.fields if item.field == "title")
    winner = report.chosen()

    assert winner is not None
    assert winner.verdict == KEEP
    assert "absent on" in winner.reason()


def test_a_page_that_has_the_field_and_the_rule_cannot_read_it_still_prunes():
    """The other silence: an expectation with nothing read is a broken rule, which is
    what the plan's Example 2 exists to catch."""
    samples = [sample_of(name) for name in ("sample1", "sample2", "sample3")]

    learning = learn(samples)
    report = next(item for item in learning.fields if item.field == "title")
    broken = next(item for item in report.hypotheses
                  if item.rule.get("select") == "h1.work-title")

    assert broken.verdict == PRUNE
    assert "which does have it" in broken.reason()


def test_the_session_records_which_fields_a_page_said_it_lacks(tmp_path):
    directory = tmp_path / "session"
    directory.mkdir()
    capture = Capture(url=f"{BASE}work/x", final_url=f"{BASE}work/x")
    capture.documents = plain_documents(
        (SAMPLES / "sample1" / "page.html").read_text(encoding="utf-8"))
    capture.write(directory / "capture.json")
    harvest(capture).write(directory / "candidates.json")
    (directory / "annotations.json").write_text(json.dumps({
        "url": capture.url, "mode": "confirm", "fields": {}, "picks": {},
        "verdicts": {}, "absent": ["characters", "series"],
    }), encoding="utf-8")

    sample = load_session(directory)

    assert sample.absent == {"characters", "series"}


# --- a value is what it is, not what Python writes it as --------------------- #


def page_sample(html: str, annotated: dict, name: str) -> Sample:
    """One invented page, harvested, with a person's answer for it."""
    url = f"{BASE}{name}"
    capture = Capture(url=url, final_url=url)
    capture.status = 200
    capture.content_type = "text/html"
    capture.documents = plain_documents(html)
    return Sample(name=name, capture=capture, harvest=harvest(capture), annotated=annotated)


def test_a_rule_that_misreads_the_page_it_came_from_is_not_a_rule():
    """Measured on a real gallery: the annotation held the first five of a work's
    sixteen tags while the rule read all sixteen, and the verdict was `keep` — because
    the sample a rule came from was excluded from the verdict, so the one page that
    could contradict it was also the one page not asked.

    Here both pages say `title`, and the second page's answer happens to equal what the
    bad rule reads there — so by the other samples alone it looks supported.
    """
    html = "<html><body><ul><li>First</li><li>Second</li><li>Third</li></ul></body></html>"
    samples = [page_sample(html, {"title": "Third"}, "one"),
               page_sample(html, {"title": "First"}, "two")]

    report = next(r for r in learn(samples).fields if r.field == "title")

    # `li` names no unique element, so the candidate carrying "Third" comes with a rule
    # that reads "First" — on the very page it came from.
    assert report.hypotheses
    assert all(item.verdict == PRUNE for item in report.hypotheses)
    assert "derived from" in report.hypotheses[0].reason()


def test_a_collection_annotation_is_the_list_the_rule_reads():
    """The two sides of this comparison are lists: the page hands the annotation the
    members it read, and the rule resolves to the same members. Nothing is stringified
    on the way, so nothing has to be un-stringified to compare them."""
    html = ("<html><body><div class='tags'>"
            "<a href='/t/1'>One</a><a href='/t/2'>Two</a><a href='/t/3'>Three</a>"
            "</div></body></html>")
    members = ["One", "Two", "Three"]
    samples = [page_sample(html, {"tags": members}, "one"),
               page_sample(html, {"tags": members}, "two")]

    report = next(r for r in learn(samples).fields if r.field == "tags")
    winner = report.chosen()

    assert winner is not None and winner.verdict == KEEP
    assert winner.rule["list"] is True
    assert "[" not in winner.reason()


def test_a_partial_annotation_finds_no_candidate_and_says_so(tmp_path):
    """A value stopping at the fifth tag matches no candidate, because a candidate now
    carries every member. Reported as a note rather than learned from something else.
    """
    html = ("<html><body><div class='tags'>"
            "<a href='/t/1'>One</a><a href='/t/2'>Two</a><a href='/t/3'>Three</a>"
            "<a href='/t/4'>Four</a></div></body></html>")

    learning = learn([page_sample(html, {"tags": ["One", "Two"]}, "one")])

    assert not learning.fields
    assert any("carries a usable rule" in note for note in learning.notes)


def test_a_verdict_shows_where_the_two_values_differ():
    """A plain cut of each value hides exactly what the verdict is about.

    Measured on buondua (2026-10-10): the rule read `…MissKON.com-001.jpeg?6f98…` where
    `…MissKON.com-002.jpeg?6f98…` was annotated, and both were cut to the same 60 characters, so the
    report read "read 'X…' where 'X…' was expected" — a verdict nobody can act on. The difference sat
    in the middle of two long addresses, which is where it usually sits.
    """
    left = ("https://i2.buondua.com/2026/56147/Cosplayer-small-store-chiyo-w-Fantia-2026-Year-7"
            "-Monthly-membership-subscription-collection-MissKON.com-002.jpeg?6f98473214ecf")
    right = left.replace("-002", "-001")

    read, expected = _pair(left, right)
    assert read != expected
    assert "-002" in read and "-001" in expected
    # Short values are shown whole, quoted the way the rest of the report quotes them.
    assert _pair("a", "b") == ("'a'", "'b'")
    assert _pair("same", "same") == ("'same'", "'same'")


def test_a_field_is_proposed_with_its_own_pick_when_two_fields_share_a_word():
    """A value alone cannot tell two fields apart, and the session records which one was clicked.

    Measured on iwara (2026-10-10): the work's title and its character list are the same word, so
    matching by value handed `characters` the *title's* rule and the confirm page showed the work's
    title as its character list. The harvest keeps them apart (one is `Mornye`, the other `mornye`),
    and so does the annotation's `picks`.
    """
    html = ('<html><body><h1>Mornye</h1>'
            '<div class="tags"><a href="/t/x">mornye</a></div></body></html>')
    first = page_sample(html, {"title": "Mornye", "characters": "mornye"}, "one")
    by_value = {candidate.value: candidate.candidate_id for candidate in first.harvest.candidates}
    first.picks = {"title": by_value["Mornye"], "characters": by_value["mornye"]}

    applied = apply_to([first], page_sample(html, {}, "two").capture)

    assert applied["title"]["rule"].get("select") == "h1", applied["title"]["rule"]
    assert applied["characters"]["rule"].get("select") != "h1", \
        f"characters was proposed with the title's rule: {applied['characters']['rule']}"
    # And the values stay each field's own, which is what the confirm page shows.
    assert applied["title"]["value"] == "Mornye"
    assert applied["characters"]["value"] == "mornye"


def test_a_proposal_reads_its_value_with_the_rule_it_records():
    """A capped field's value and its rule have to say the same number of members.

    A preview keeps three. The proposal used to be read with the *uncapped* rule while the rule
    recorded beside it carried `limit: 3`, and the page records what it is shown — so the second page
    answered with nineteen pictures while the rule read three, and the field was pruned over a
    difference that only ever existed between the two halves here. Measured on buondua
    (2026-10-10): the same run's `preview` came out of the confirm page as a nineteen-member answer.
    """
    page = ('<html><body><div class="article-fulltext">'
            + "".join(f'<img src="/p/one-{n:03d}.jpeg">' for n in (1, 2, 3, 4, 5))
            + '</div></body></html>')
    first = page_sample(page, {"preview": [f"{BASE}p/one-{n:03d}.jpeg" for n in (2, 3, 4)]}, "one")
    second = page_sample(page, {}, "two")

    applied = apply_to([first], second.capture)
    preview = applied["preview"]

    assert preview["rule"].get("limit") == 3, preview["rule"]
    assert preview["value"] == [f"{BASE}p/one-{n:03d}.jpeg" for n in (2, 3, 4)], preview["value"]
    # The two halves agree, which is the whole point: the rule reads exactly what was proposed.
    assert same_members(read_rule(preview["rule"], second.capture), preview["value"])


def test_a_recorded_response_is_named_by_its_request_and_gets_a_recipe(tmp_path):
    """A response named by its arrival order reads a *different* response on the next page.

    Measured on iwara (2026-10-10): `network:4` was the video API on one page and the site-wide
    announcement on the next, so the title rule learned from the first read the announcement's banner,
    and every API-backed field was pruned. The work's key is the segment the site's own requests
    repeat — and it is not always the segment the target pattern would capture: iwara's address
    carries a key *and* a slug, and `api.iwara.tv/video/mornye` answers 404 while
    `api.iwara.tv/video/bCiZIXUeR4tLq5` answers 200. Naming it makes the rule readable on both pages,
    and the name *is* the request — which is what the draft declares as its recipe.
    """
    def page(work: str, slug: str, title: str) -> Sample:
        # The title lives *only* in the API — iwara's date and tags are the same shape — so the rule
        # that reads it has to be runnable, which is the whole point of naming it and declaring it.
        html = '<html><body><p>nothing the page itself says</p></body></html>'
        capture = Capture(url=f"https://www.site.test/video/{work}/{slug}",
                          final_url=f"https://www.site.test/video/{work}/{slug}")
        capture.documents = plain_documents(html)
        capture.documents.append(Document(name="network:4", format="json",
                                          text=json.dumps({"title": title}),
                                          source_url=f"https://api.site.test/video/{work}"))
        capture.documents.append(Document(name="network:5", format="json",
                                          text=json.dumps({"other": title}),
                                          source_url=f"https://api.site.test/video/{work}/comments"))
        return Sample(name=slug, capture=capture, harvest=harvest(capture),
                      annotated={"title": title})

    samples = [page("AB12CD34", "mornye", "Mornye"), page("EF56GH78", "fleurdelys", "Fleurdelys")]
    named = network_documents(samples)

    assert api_identifier([(sample.url, sample.capture) for sample in samples]) == "AB12CD34"
    assert named["names"]["mornye"]["network:4"] == "network:api.site.test/video/{id}"
    assert named["names"]["mornye"]["network:5"] == "network:api.site.test/video/{id}/comments"
    assert named["recipes"]["network:api.site.test/video/{id}"] == "https://api.site.test/video/{id}"

    # The rule is renamed, so it reads the same request on the second page — and the draft carries
    # both the name and the request that fetches it, which is what makes it runnable at all.
    learning = learn(samples)
    title = next(report for report in learning.fields if report.field == "title")
    assert any(item.rule.get("document") == "network:api.site.test/video/{id}"
               for item in title.hypotheses), [item.rule for item in title.hypotheses]

    draft = draft_site_json(samples, learning)
    assert draft["work"]["fields"]["title"]["document"] == "network:api.site.test/video/{id}"
    assert draft["documents"]["work"]["network:api.site.test/video/{id}"] == {
        "format": "json", "request": "https://api.site.test/video/{id}", "from": "target"}


def test_a_rule_is_checked_against_the_page_the_site_served(tmp_path):
    """The crawl reads the *served* page; the Builder learns from the browser's rendering.

    Measured on iwara (2026-10-11): the served page is a 2.3 KB JavaScript shell, the rendering has
    the title, and the rule learned from the rendering read nothing on the served page — the work was
    dropped as "the page did not contain the work's data" and the import came out with zero entries.
    Here the shell answers `og:title` with the *site's* name, which is worse than answering nothing:
    the field looks filled and is wrong. Checked against the served page, that rule is pruned and the
    one that reads the work's own title from the API is what survives.
    """
    def page(work: str, title: str, *, served: str | None) -> Sample:
        html = f'<html><head><meta property="og:title" content="{title}"></head>' \
               f'<body><h1>{title}</h1></body></html>'
        capture = Capture(url=f"https://www.site.test/video/{work}/x",
                          final_url=f"https://www.site.test/video/{work}/x")
        capture.documents = plain_documents(html)
        capture.documents.append(Document(name="network:4", format="json",
                                          text=json.dumps({"title": title}),
                                          source_url=f"https://api.site.test/video/{work}"))
        # A second request naming the same work: that repetition is what says which path step is the
        # key, and so what lets a response be named by its request instead of by its arrival order.
        capture.documents.append(Document(name="network:5", format="json",
                                          text=json.dumps({"other": title}),
                                          source_url=f"https://api.site.test/video/{work}/comments"))
        return Sample(name=work, capture=capture, harvest=harvest(capture),
                      annotated={"title": title}, served=served)

    shell = ('<html><head><meta property="og:title" content="Site Name">'
             '<title>Site</title></head><body><div id="app"></div></body></html>')
    samples = [page("AB12CD34", "Mornye", served=shell),
               page("EF56GH78", "Fleurdelys", served=shell)]

    learning = learn(samples)
    title = next(report for report in learning.fields if report.field == "title")

    assert not any(item.rule.get("from") == "meta" for item in title.kept()), \
        "a rule reading the served page's site name is not a rule for the work's title"
    winner = title.chosen()
    assert winner is not None and winner.rule.get("document") == "network:api.site.test/video/{id}"

    # Without the served page the same rules are judged against the rendering, where the meta rule
    # reads the work's own title and is perfectly good — so this check is what makes the difference,
    # and a site whose served page carries its data is unaffected.
    for sample in samples:
        sample.served = None
    again = next(report for report in learn(samples).fields if report.field == "title")
    assert any(item.rule.get("from") == "meta" for item in again.kept())


def test_an_address_made_of_json_fields_is_derived_from_several_works():
    """The cover of a site that publishes only the pieces, derived the way recipes are derived.

    Measured on iwara (2026-10-11): one page cannot derive this — the strict attempt left the varying
    index as a literal (every work read the first work's picture) and the loose one templated digits
    out of unrelated fields. Two works can: the address is split at the parts that are the same on
    every work, a part that differs is a placeholder only when a JSON field differs with it on *every*
    work, and the runtime's own reader has to reproduce each work's address from its own document.
    """
    from src.builder.learn import assembled_rule

    def page(work: str, thumb: int, cover: str, *, limit: int = 1) -> Sample:
        html = "<html><body><p>nothing the page itself says</p></body></html>"
        capture = Capture(url=f"https://www.site.test/video/{work}/x",
                          final_url=f"https://www.site.test/video/{work}/x")
        capture.documents = plain_documents(html)
        capture.documents.append(Document(
            name="network:0", format="json",
            text=json.dumps({"file": {"id": work}, "thumbnail": thumb, "limit": limit}),
            source_url=f"https://api.site.test/video/{work}"))
        return Sample(name=work, capture=capture, harvest=harvest(capture),
                      annotated={"cover": cover})

    cover = "https://i.site.test/image/original/{}/thumbnail-{:02d}.jpg"
    samples = [page("AB12CD34", 5, cover.format("AB12CD34", 5)),
               page("EF56GH78", 12, cover.format("EF56GH78", 12))]

    # The names a rule reads a document by are set by the learner; deriving before that has none.
    learn(samples)
    rule = assembled_rule(samples, "cover")
    assert rule is not None
    assert rule["template"] == \
        "https://i.site.test/image/original/{file.id}/thumbnail-{thumbnail:02d}.jpg", rule

    # The field is kept, and it is what the draft installs.
    report = next(item for item in learn(samples).fields if item.field == "cover")
    assert report.kept() and report.chosen().rule == rule

    # A field that does *not* follow the work is not a part of the address, however well a digit run
    # happens to match it: `limit` is 1 on every work, and a template over it would put a constant
    # into an address that varies.
    assert "limit" not in rule["template"]

    # Nothing to derive when the works do not share an address shape.
    assert assembled_rule([samples[0]], "cover") is None


def test_an_assembled_address_matches_responses_by_request_not_arrival_order():
    """The same API response may arrive at a different position on every page.

    Measured on iwara (2026-10-11): the response carrying `file.id` and `thumbnail` was `network:4`
    on the first work and `network:2` on the second. Ordinary JSON rules already name both by their
    request; the assembled cover must use that same identity or it cannot find its pieces.
    """
    from src.builder.learn import assembled_rule

    def page(work: str, file_id: str, thumb: int, position: int) -> Sample:
        cover = f"https://i.site.test/image/original/{file_id}/thumbnail-{thumb:02d}.jpg"
        capture = Capture(url=f"https://www.site.test/video/{work}/x",
                          final_url=f"https://www.site.test/video/{work}/x")
        capture.documents = plain_documents("<html><body><div id='app'></div></body></html>")
        capture.documents.append(Document(
            name=f"network:{position}", format="json",
            text=json.dumps({"file": {"id": file_id}, "thumbnail": thumb,
                             "sites": [{"id": "iwara"}]}),
            source_url=f"https://api.site.test/video/{work}"))
        # A second request repeating the page key is the measured evidence for which URL segment is
        # the API identifier; its arrival position is deliberately unrelated to the subject response.
        capture.documents.append(Document(
            name=f"network:{position + 3}", format="json", text=json.dumps({"results": []}),
            source_url=f"https://api.site.test/video/{work}/comments"))
        return Sample(name=work, capture=capture, harvest=harvest(capture),
                      annotated={"cover": cover})

    # Both file ids start with `9`: a character-wise common-prefix split used to swallow that first
    # character and then fail to find either complete id. `iwara` is deliberately constant so the
    # regression also proves that a site-wide value cannot be substituted into the host.
    samples = [page("AB12CD34", "9c5b3bdf-e280-4b61-bdc5-01bcb7bb7357", 5, 4),
               page("EF56GH78", "9813760e-7a81-40ae-a0c5-5674aef5be07", 12, 2)]
    learning = learn(samples)
    rule = assembled_rule(samples, "cover")

    assert rule == {
        "from": "json_template",
        "document": "network:api.site.test/video/{id}",
        "template": "https://i.site.test/image/original/{file.id}/thumbnail-{thumbnail:02d}.jpg",
    }
    cover = next(report for report in learning.fields if report.field == "cover")
    assert cover.chosen() is not None and cover.chosen().rule == rule
