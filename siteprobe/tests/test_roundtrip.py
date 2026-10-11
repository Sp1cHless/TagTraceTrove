"""Phase 6: does a generated adapter run under the runtime, and read the same values?

The plan's bar is that the Builder's extraction, the generated `site.json`, and the
existing runtime's extraction all agree. Two of the three are checked here against a
recorded fixture, offline; the installed adapter is checked as far as it can be
without a network, which is: the registry finds it, its shim imports, and the reader
it calls produces the documents the rules name.

Run:  .venv/Scripts/python.exe -m pytest -q
"""

from __future__ import annotations

import importlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder import roundtrip  # noqa: E402
from src.builder import paths  # noqa: E402
from src.builder.capture import Capture, Document, plain_documents  # noqa: E402
from src.builder.learn import draft_site_json, learn  # noqa: E402
from src.builder.roundtrip import (  # noqa: E402
    AGREE,
    DISAGREE,
    UNRUNNABLE,
    compare,
    install,
    runtime_bag,
    template_from,
)
from src.generic import declarative, registry  # noqa: E402
from src.generic.select import resolve  # noqa: E402
from src.generic.template import load_template  # noqa: E402

SAMPLES = PROJECT_ROOT / "fixtures" / "learned_site"
BASE = "https://fixture.test/"


def sample_of(name: str, **options):
    """Reuse the Phase 5 fixture loader so both phases see the same samples."""
    from test_learn import sample_of as loader

    return loader(name, **options)


def trained_draft(tmp_path: Path) -> tuple[list, dict]:
    samples = [sample_of(name) for name in ("sample1", "sample2", "sample3")]
    return samples, draft_site_json(samples, learn(samples))


def test_a_block_written_with_spaces_agrees_with_the_answer_a_person_gave(tmp_path):
    """The round trip reads the accepted answer as its *members* too.

    Measured on a real bilinovel build (2026-10-03): the draft read the tags back correctly, the
    annotation held the block the page writes (`转生 奇幻 冒险 龙傲天 女性视角 欢乐向`), and `compare`
    answered `disagree — both sides read '转生 / 奇幻 / …', not the accepted '转生 奇幻 …'` — the same
    members in two written forms — so `build_adapter` refused to install a draft that was right.
    This fixture's pages write the tag row the way that page does.
    """
    lab = PROJECT_ROOT / "fixtures" / "labelled_row_site"
    samples = [sample_of(name, directory=lab, base="https://labelled.test/")
               for name in ("sample1", "sample2", "sample3")]
    draft = draft_site_json(samples, learn(samples))

    result = compare(samples[0], draft, tmp_path)

    tags = next((item for item in result.comparisons if item.field == "tags"), None)
    assert tags is not None, [item.field for item in result.comparisons]
    assert tags.verdict == AGREE, tags.detail
    assert result.ok, [(item.field, item.detail) for item in result.comparisons
                       if item.verdict != AGREE]


# --- the declarative reader ------------------------------------------------- #

def test_the_page_is_always_offered_and_jsonld_only_when_declared(tmp_path):
    """A rule naming `jsonld` can only run if the template declares that document —
    otherwise the runtime would treat the page's structured data as HTML."""
    without = {"key": "x", "tool": "x", "documents": {"work": {"page": {"format": "html"}}}}
    with_jsonld = {"key": "x", "tool": "x",
                   "documents": {"work": {"page": {"format": "html"},
                                          "jsonld": {"format": "json"}}}}
    html = '<script type="application/ld+json">{"@type":"Book","name":"N"}</script>'

    plain = declarative.documents_from(template_from(without, tmp_path), html)
    structured = declarative.documents_from(template_from(with_jsonld, tmp_path), html)

    assert set(plain) == {"page"}
    assert set(structured) == {"page", "jsonld"}
    assert json.loads(structured["jsonld"])["name"] == "N"


def test_a_declared_request_document_is_fetched_with_the_targets_own_id(tmp_path, monkeypatch):
    """An API-backed rule needs its response as a document, and the recipe is how a
    declarative adapter gets one at runtime."""
    template = template_from({
        "key": "x", "tool": "x",
        "targets": {"work": {"url_pattern": r"^https?://fixture\.test/work/(\d+)", "label": "W"}},
        "documents": {"work": {"page": {"format": "html"},
                               "api": {"format": "json",
                                       "request": "https://api.fixture.test/work/{id}"}}},
    }, tmp_path)
    seen: list[str] = []

    def fake_fetch(url, *, referer=None):
        seen.append(url)
        return 200, b'{"title":"From The API"}', "application/json", url

    monkeypatch.setattr(declarative.unknown_url, "fetch", fake_fetch)
    documents = declarative.request_documents(template, f"{BASE}work/4242")

    assert seen == ["https://api.fixture.test/work/4242"]
    assert json.loads(documents["api"])["title"] == "From The API"


def test_a_recipe_the_target_cannot_fill_is_not_fetched(tmp_path, monkeypatch):
    """`{slug}` is not captured by the target's pattern, so there is nothing to ask
    for — better than requesting a literal `{slug}` and reading the error page."""
    template = template_from({
        "key": "x", "tool": "x",
        "targets": {"work": {"url_pattern": r"^https?://fixture\.test/work/(\d+)", "label": "W"}},
        "documents": {"work": {"api": {"format": "json",
                                       "request": "https://api.fixture.test/{slug}"}}},
    }, tmp_path)
    monkeypatch.setattr(declarative.unknown_url, "fetch",
                        lambda url, **_: (_ for _ in ()).throw(AssertionError("fetched")))

    assert declarative.request_documents(template, f"{BASE}work/4242") == {}


def test_read_work_returns_none_rather_than_a_half_filled_record(tmp_path, monkeypatch):
    template = template_from({"key": "x", "tool": "x",
                              "documents": {"work": {"page": {"format": "html"}}}}, tmp_path)
    monkeypatch.setattr(declarative.unknown_url, "fetch",
                        lambda url, **_: (403, b"nope", "text/html", url))

    assert declarative.read_work(template, f"{BASE}work/1") is None


def test_read_work_builds_an_item_from_the_template_alone(tmp_path, monkeypatch):
    template = template_from({
        "key": "x", "tool": "x",
        "targets": {"work": {"url_pattern": r"^https?://fixture\.test/work/(\d+)", "label": "W"}},
        "documents": {"work": {"page": {"format": "html"}}},
    }, tmp_path)
    monkeypatch.setattr(declarative.unknown_url, "fetch",
                        lambda url, **_: (200, b"<h1>Hi</h1>", "text/html", url))

    item = declarative.read_work(template, f"{BASE}work/4242")

    assert item.source_id == "4242"
    assert item.documents["page"] == "<h1>Hi</h1>"


# --- the round trip --------------------------------------------------------- #

def test_the_generated_site_json_reads_what_the_builder_read(tmp_path):
    """The plan's acceptance, offline: the same rules, resolved through the runtime's
    own loader and document builder, must read the values a person accepted."""
    samples, draft = trained_draft(tmp_path)

    result = compare(samples[0], draft, tmp_path)

    assert result.ok
    # The draft's field names are the runtime's, not the annotation's: `creator` is
    # `author` there, `cover` is `cover_url`, `series` is `works`.
    assert {item.field for item in result.comparisons} == {"title", "author", "cover_url"}
    assert all(item.verdict == AGREE for item in result.comparisons), [
        (i.field, i.detail) for i in result.comparisons if i.verdict != AGREE]
    for item in result.comparisons:
        assert item.runtime == item.accepted
        assert item.in_record, item.field      # read *and* written into the record


def test_agreement_between_two_wrong_answers_is_not_success(tmp_path):
    """Both sides agreeing is not the bar; agreeing *with the annotation* is."""
    samples, draft = trained_draft(tmp_path)
    samples[0].annotated["title"] = "A Value That Was Never On The Page"

    result = compare(samples[0], draft, tmp_path)

    title = next(item for item in result.comparisons if item.field == "title")
    assert title.verdict == DISAGREE
    assert "not the accepted" in title.detail


def test_a_rule_needing_a_document_the_reader_cannot_produce_is_reported(tmp_path):
    """An API-backed rule has no request recipe yet. Saying so is the difference
    between a checked round trip and a claimed one."""
    samples, draft = trained_draft(tmp_path)
    draft["work"]["fields"]["title"] = {"from": "json", "document": "network:0",
                                        "path": "data.title"}
    draft["documents"]["work"]["network:0"] = {"format": "json"}

    result = compare(samples[0], draft, tmp_path)

    title = next(item for item in result.comparisons if item.field == "title")
    assert title.verdict == UNRUNNABLE
    assert "request recipe" in title.detail
    # One unverifiable field no longer rejects the adapter: what did verify is worth
    # keeping, and what did not is named in the report and in `learned.json`.
    assert result.ok
    assert [item.field for item in result.unverified()] == ["title"]


def test_a_draft_with_no_rules_says_there_is_nothing_to_run(tmp_path):
    samples, draft = trained_draft(tmp_path)
    draft["work"]["fields"] = {}

    result = compare(samples[0], draft, tmp_path)

    assert result.comparisons == []
    assert any("no field rules" in note for note in result.notes)


def test_the_runtimes_bag_follows_the_template_not_the_builder(tmp_path):
    """`jsonld` declared as JSON is what makes a `json` rule executable; declared as
    anything else it silently reads nothing, which is why the hints are exercised."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<script type="application/ld+json">{"@type":"Book","name":"N"}</script>'))
    rule = {"from": "json", "document": "jsonld", "path": "name"}
    declared = {"key": "x", "tool": "x",
                "documents": {"work": {"page": {"format": "html"},
                                       "jsonld": {"format": "json"}}}}
    undeclared = {"key": "x", "tool": "x",
                  "documents": {"work": {"page": {"format": "html"}}}}

    good = resolve(rule, runtime_bag(template_from(declared, tmp_path), capture),
                   context={"url": BASE})

    assert good == "N"
    # Undeclared, the document does not exist, and the runtime says so loudly rather
    # than reading nothing — which is the behaviour a round trip can rely on.
    with pytest.raises(KeyError):
        resolve(rule, runtime_bag(template_from(undeclared, tmp_path), capture),
                context={"url": BASE})


# --- installing it ---------------------------------------------------------- #

def test_a_draft_the_loader_refuses_is_a_draft_that_cannot_be_installed(tmp_path):
    """`install` writes a folder; the loader is what decides whether it is an adapter."""
    broken = {"key": "x", "tool": "x", "targets": {"nonsense": {"label": "?"}}}

    with pytest.raises(Exception):
        template_from(broken, tmp_path)


def test_install_writes_the_folder_the_registry_looks_for(tmp_path):
    samples, draft = trained_draft(tmp_path)
    tool_root = tmp_path / "tool"

    target = install(draft, tool_root, source="a-session")

    assert (target / "site.json").is_file()
    assert (target / "learned.json").is_file()
    # No Python: the runtime reads a site that ships no fetch module declaratively, so
    # a generated adapter is a config file and carries no authoring tool with it.
    assert not (target / "fetch.py").exists()
    written = json.loads((target / "site.json").read_text(encoding="utf-8"))
    assert written["key"] == "fixture.test"
    meta = json.loads((target / "learned.json").read_text(encoding="utf-8"))
    assert meta["kind"] == "declarative"
    assert meta["source"] == "a-session"
    assert meta["fields"] == sorted(draft["work"]["fields"])

    # And the folder is installable in the sense the registry means.
    discovered = registry.discover(tool_root)
    assert [template.key for template in discovered] == ["fixture.test"]
    assert registry.load_fetcher(discovered[0]) is declarative


def test_the_generated_root_is_read_without_touching_the_written_sites(tmp_path):
    """A built adapter is found in its own root. The three hand-written sites are
    pinned by this project's own contract tests, and a generated one appearing among
    them would fail those tests — which is how this root came to exist."""
    samples, draft = trained_draft(tmp_path)
    generated = tmp_path / "learned"
    target = install(draft, generated)

    # `tool` in the written site.json is the folder name, so the reader resolves.
    assert json.loads((target / "site.json").read_text(encoding="utf-8"))["tool"] == target.name
    assert [t.key for t in registry.discover(generated)] == ["fixture.test"]
    # The written sites are exactly the ones a person wrote, before and after.
    assert [t.key for t in registry.discover(paths.home() / "installed")] == [
        "18comic.vip", "hanime1.me", "hitomi.la"]


def test_a_site_with_no_fetch_module_is_read_declaratively(tmp_path):
    """The absence of a module means "read my site.json". A module that exists and
    does not import is still a loud error — the fallback is not a blanket catch."""
    samples, draft = trained_draft(tmp_path)
    target = install(draft, tmp_path / "learned")

    template = load_template(target / "site.json")
    assert registry.load_fetcher(template) is declarative

    (target / "fetch.py").write_text("raise ImportError()" + chr(10), encoding="utf-8")
    with pytest.raises(registry.RegistryError):
        registry.load_fetcher(template)


def test_installing_one_half_of_a_site_keeps_the_other_half(tmp_path):
    """A site's adapter has two halves, and a build owns one of them.

    Measured on bilinovel (2026-10-04): a *listing* run wrote `site.json` wholesale, so the work
    adapter built the day before was **deleted** — the site kept exporting works while the half that
    knew how to read a work page was gone, and nothing in the output said so. An install replaces the
    sections it was built for and keeps the ones it was not: the halves themselves, and the `targets`
    and `documents` keys that belong to them.
    """
    _samples, work_draft = trained_draft(tmp_path)
    generated = tmp_path / "learned"
    install(work_draft, generated, source="the work build")

    listing_draft = {
        "key": "fixture.test",
        "tool": "fixture_test",
        "targets": {"search": {"url_pattern": r"^https?://fixture\.test/list",
                               "label": "Search", "single": False}},
        "documents": {"listing": {"listing_html": {"format": "html"}}},
        "listings": {"search": {
            "document": "listing_html",
            "row_selector": "li.card",
            "fields": {
                "source_id": {"from": "html", "select": "a", "attr": "href",
                              "filter": [r"/work/(\d+)"], "group": 1},
                "title": {"from": "html", "select": "h3", "text": True},
            },
        }},
    }
    target = install(listing_draft, generated, source="the listing build")

    written = json.loads((target / "site.json").read_text(encoding="utf-8"))
    # The half this build was built for.
    assert set(written["listings"]) == {"search"}
    assert "search" in written["targets"]
    assert written["documents"]["listing"] == listing_draft["documents"]["listing"]
    # And the half it was not, kept whole.
    assert written["work"] == work_draft["work"], "the work half was overwritten"
    assert written["targets"]["work"] == work_draft["targets"]["work"]
    assert written["documents"]["work"] == work_draft["documents"]["work"]
    # One adapter to the registry, not two.
    assert [template.key for template in registry.discover(generated)] == ["fixture.test"]
    # And the adapter says which fields it can read across *both* halves, so the half the site
    # already had is not invisible in the file that describes it.
    meta = json.loads((target / "adapter.json").read_text(encoding="utf-8"))
    assert set(meta["capabilities"]) == set(written["work"]["fields"]) | {"source_id", "title"}


def test_a_namespaced_slug_cannot_escape_the_tool_directory(tmp_path):
    """A draft's own text deciding where its folder lands would be a path traversal
    written by a page. The slug is sanitized, not trusted."""
    target = install({"key": "x", "tool": "../../etc/passwd"}, tmp_path / "tool")

    assert target.parent == tmp_path / "tool"
    assert ".." not in str(target)


def test_a_learned_field_that_the_runtime_does_not_read_is_reported_as_not_recorded(tmp_path):
    """The bug this replaces, stated as a test: the cover was learned, agreed with the
    annotation, and then the export said `cover: null` — because the rule was written
    under a name (`cover`) that `extract_work` does not write records from."""
    samples, draft = trained_draft(tmp_path)
    # Put the cover back under the annotation's own name, which is what a draft that
    # skipped the mapping would look like.
    draft["work"]["fields"]["cover"] = draft["work"]["fields"].pop("cover_url")

    result = compare(samples[0], draft, tmp_path)

    cover = next(item for item in result.comparisons if item.field == "cover")
    assert cover.verdict == DISAGREE
    assert cover.in_record is False
    assert "no 'cover'" in cover.detail


def test_a_description_is_carried_as_a_declared_passthrough_key(tmp_path):
    """Free text has one home — the Entry body, beside the source URL — and the
    runtime writes it only because the draft declares it."""
    samples, _draft = trained_draft(tmp_path)
    samples[0].annotated["description"] = "Lin Wei"
    samples[0].harvest = samples[0].harvest  # unchanged; the value comes from a rule
    draft = draft_site_json(samples, learn(samples))

    assert draft["work"]["passthrough"] == ["description"] or "description" in draft["work"]["passthrough"]


# --- previews: the field an adapter could not carry before ------------------- #


def test_a_learned_preview_set_reaches_the_record_the_runtime_writes(tmp_path):
    """The whole chain, offline: a person marks the group, the rule is learned as a list,
    and the record `extract_work` writes actually carries the pictures — the half that
    was missing when a learned field was written under a name the runtime does not read.
    """
    from test_learn import preview_samples

    samples = preview_samples()
    draft = draft_site_json(samples, learn(samples))
    assert draft["work"]["fields"]["preview_urls"]["list"] is True

    result = compare(samples[0], draft, tmp_path)

    previews = next(item for item in result.comparisons if item.field == "preview_urls")
    assert previews.verdict == AGREE, previews.detail
    assert previews.in_record is True
    assert len(previews.runtime) == 3


def test_a_preview_that_is_one_picture_is_one_picture_in_the_record(tmp_path):
    """A single-valued preview rule must not be exploded into one image per character.

    Measured on buondua (2026-10-10): the person marked one picture for the preview — a scalar rule,
    because a preview of one is what the page offered — and `extract_work` iterated the *string*: the
    record came out with 179 "preview images" whose urls were `'h'`, `'t'`, `'t'`, `'p'`… The round
    trip then reported a disagreement that was only ever the record's own shape, and refused to
    install the adapter, after the learner had kept the field correctly.
    """
    from test_learn import page_sample

    html = ('<html><body><div class="article">'
            '<img src="/p/a-001.jpeg"><img src="/p/a-002.jpeg"><img src="/p/a-003.jpeg">'
            '</div></body></html>')
    marked = {"preview": f"{BASE}p/a-002.jpeg"}
    samples = [page_sample(html, dict(marked), "one"), page_sample(html, dict(marked), "two")]
    draft = draft_site_json(samples, learn(samples))
    assert not draft["work"]["fields"]["preview_urls"].get("list"), \
        "one picture is not a set, so the rule reads it as a single value"

    result = compare(samples[0], draft, tmp_path)

    previews = next(item for item in result.comparisons if item.field == "preview_urls")
    assert previews.verdict == AGREE, previews.detail
    assert previews.in_record is True
    assert previews.runtime == f"{BASE}p/a-002.jpeg", previews.runtime


# --- what PASS is allowed to mean ------------------------------------------- #


def test_a_disagreeing_field_is_not_a_pass():
    """Measured on a real gallery: four fields agreed, the fifth read the work's tags on
    the runtime side as the Python repr of a list, and the summary said PASS — with the
    4/5 right beside it. One of those two readings is wrong, so that is a failure."""
    trip = roundtrip.RoundTrip(url=BASE, comparisons=[
        roundtrip.Comparison(field="title", accepted="A", builder="A", runtime="A",
                             verdict=AGREE),
        roundtrip.Comparison(field="tags", accepted=["A", "B"], builder=["A", "B"],
                             runtime="['A', 'B']", verdict=DISAGREE),
    ])

    assert not trip.ok
    assert [item.field for item in trip.disagreeing()] == ["tags"]


def test_an_unverified_field_is_still_a_pass():
    """A field nothing could contradict is kept out of the adapter and named there:
    refusing the whole adapter because one field is weak is the wrong trade, and a page
    is not required to carry every field."""
    trip = roundtrip.RoundTrip(url=BASE, comparisons=[
        roundtrip.Comparison(field="title", accepted="A", builder="A", runtime="A",
                             verdict=AGREE),
        roundtrip.Comparison(field="series", accepted="A", builder=None, runtime=None,
                             verdict=UNRUNNABLE),
    ])

    assert trip.ok
    assert [item.field for item in trip.unverified()] == ["series"]


def test_an_empty_round_trip_is_not_a_pass():
    """Nothing to compare is not agreement, and calling it PASS is how a draft with no
    rules at all would look verified."""
    assert not roundtrip.RoundTrip(url=BASE).ok


def test_a_collection_that_arrived_whole_is_not_reported_as_lost():
    """The record carries a category list, and a collection's value holds several
    members: asking whether the whole value looks like one of them answers no however
    right the record is."""
    record = {"分类信息": {"登场人物": ["One", "Two", "Three"]}}

    assert roundtrip.record_carries(record, "characters", ["One", "Two", "Three"])
    assert not roundtrip.record_carries(record, "characters", ["One", "Four"])


def test_one_unreadable_adapter_does_not_take_every_other_site_down(tmp_path):
    """Discovery is how *every* site is found, so a fault in one file used to be a fault in all.

    A `site.json` that cannot be read is what a writer cut off mid-write leaves — a killed install, a
    full disk. Measured by putting one beside a good adapter: `discover` raised `JSONDecodeError` and
    the *good* site was unreachable too, because the loop never returned. One adapter's problem has to
    stay that adapter's problem, and the skip has to be reported: an adapter that is on disk and
    invisible everywhere else produces exactly one report, "the site I built has gone from the list".
    """
    good = tmp_path / "good_site"
    good.mkdir()
    (good / "site.json").write_text(json.dumps({
        "key": "good.site", "tool": "good_site", "source_site": "good.site",
        "export_group": "good.site", "hosts": ["good.site"],
        "documents": {}, "targets": {}, "listings": {},
    }), encoding="utf-8")
    cut = tmp_path / "cut_site"
    cut.mkdir()
    (cut / "site.json").write_text('{\n  "key": "cut.site",\n  "tool": "cut_si', encoding="utf-8")

    assert [template.key for template in registry.discover(tmp_path)] == ["good.site"]
    skipped = dict(registry.unreadable_sites())
    assert str(cut) in skipped
    assert "cut_site" not in str(skipped[str(cut)]).replace(str(cut), "")


def test_a_json_write_that_fails_leaves_the_previous_file_whole(tmp_path):
    """`site.json` is the one file the registry reads to find a site, and its writer truncated in place.

    A payload that cannot be serialized is the cheap way to catch a half-written file without killing a
    process: the old writer had already truncated the destination and written part of the new document
    before it raised, so the site's adapter became unreadable and — before the discovery fix above —
    every other site with it. Written through a temporary and a replace, a failed write leaves the file
    that was there. `export_layout.write_json` and `crawl_state.save` have always been written this way;
    this was the exception.
    """
    target = tmp_path / "site.json"
    roundtrip._write_json(target, {"key": "first"})
    assert json.loads(target.read_text(encoding="utf-8")) == {"key": "first"}

    with pytest.raises(TypeError):
        roundtrip._write_json(target, {"key": "second", "unserializable": object()})

    assert json.loads(target.read_text(encoding="utf-8")) == {"key": "first"}
    assert [path.name for path in tmp_path.iterdir()] == ["site.json"]
