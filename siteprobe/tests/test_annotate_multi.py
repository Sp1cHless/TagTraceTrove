"""Answers built from several clicks: one field, several values, one rule.

The page used to hold one value and one pick per field, so a site that shows one author at a
time — no group to point at — could only ever import one of them. These are the cases that
replaced it: the switch, the accumulated picks, the single rule they teach, and what happens
when that rule reads more than the person picked.
"""
from __future__ import annotations

import json
import re

from src.builder.annotate import (
    ACCEPTS,
    FIELDS,
    can_be_several,
    default_mode,
    hypotheses,
    normalise_selected_members,
    page,
    picked_ids,
    rule_for_many,
)
from src.builder.capture import Capture, Document
from src.builder.harvest import Candidate, Harvest, Source, harvest
from src.builder.learn import (
    COLLECTION_FIELDS,
    MULTI_FIELDS,
    Sample,
    _is_what_was_annotated,
    _with_split,
    answer_members,
    draft_site_json,
    learn,
    read_rule,
    runtime_names,
    wants_a_list,
)
from src.generic.select import split_members

# Three authors, each in its own block: the shape a literature page has, and the shape that has
# no shared container to point at (so the picks are what names them).
AUTHOR_PAGE = """<!doctype html><html><body>
<h1 id="title">A paper</h1>
<div id="authors">
  <div class="author"><a class="by" href="/s?q=1">Wen Tan</a><sup>1</sup></div>
  <div class="author"><a class="by" href="/s?q=2">Bohan Zhang</a><sup>2</sup></div>
  <div class="author"><a class="by" href="/s?q=3">Xinpei Liu</a><sup>1</sup></div>
</div>
<div id="tags"><a>Drama</a><a>Adventure</a></div>
</body></html>"""

KEYWORD_PAGE = """<!doctype html><html><body>
<h1 id="title">A paper</h1>
<section id="kwd-group1"><p><strong>Keywords:</strong> regulatory T cells, IL-33:ST2 axis,
lung repair</p></section>
</body></html>"""


def capture_of(markup: str, url: str = "https://fixture.test/p/one") -> Capture:
    return Capture(url=url, documents=[Document(name="page", text=markup, format="html")])


def pick(result: Harvest, value: str, kind: str = "text") -> str:
    return next(c.candidate_id for c in result.candidates
                if c.value == value and c.kind == kind)


def test_the_creator_is_the_field_that_is_one_or_several_and_the_others_are_not():
    kinds = {key: kind for key, kind, _label in FIELDS}

    assert kinds["creator"] == "multi"
    assert can_be_several("multi") and can_be_several("collection")
    assert not can_be_several("scalar") and not can_be_several("image")
    # A tag list is a list, so it opens on 「多个」; a creator usually is one name.
    assert default_mode("collection") == "many"
    assert default_mode("multi") == "one"
    # A single name is picked as itself, and a page that writes all the authors in one block
    # offers that block too.
    assert set(ACCEPTS["multi"]) >= {"text", "collection"}


def test_picking_several_names_one_at_a_time_becomes_one_rule_that_reads_them_all():
    capture = capture_of(AUTHOR_PAGE)
    result = harvest(capture)
    authors = ["Wen Tan", "Bohan Zhang", "Xinpei Liu"]
    picks = {"creator": [pick(result, name) for name in authors]}

    annotation = normalise_selected_members({"creator": authors}, result, picks,
                                            multi=("creator",))
    rules = hypotheses(annotation, result, picks=picks, multi=("creator",), capture=capture)

    rule = rules["creator"]["rule"]
    # One rule for the set, not the last name clicked: `list` reads the whole block of them.
    assert rule["list"] is True
    assert read_rule(rule, capture) == authors
    assert rules["creator"]["members"] == authors
    # This page names exactly those three, so nothing was read beyond what was picked.
    assert "extra" not in rules["creator"]


def test_a_rule_that_reads_more_than_was_picked_says_which_values_those_are():
    """The answer the person chose is "these, and the rest of the page's"."""
    capture = capture_of(AUTHOR_PAGE)
    result = harvest(capture)
    picked_two = ["Wen Tan", "Bohan Zhang"]
    picks = {"creator": [pick(result, name) for name in picked_two]}

    annotation = normalise_selected_members({"creator": picked_two}, result, picks,
                                            multi=("creator",))
    rules = hypotheses(annotation, result, picks=picks, multi=("creator",), capture=capture)

    assert rules["creator"]["members"] == ["Wen Tan", "Bohan Zhang", "Xinpei Liu"]
    assert rules["creator"]["extra"] == ["Xinpei Liu"]


def test_several_picks_with_no_shared_reading_are_read_as_a_list_of_selectors():
    """The runtime already unions a `select` list; the rule uses it when nothing is shared."""
    members = ["Alpha", "Beta"]
    one = Candidate(kind="text", value="Alpha", display="Alpha", candidate_id="one",
                    sources=[Source("markup", "page", "a", {
                        "from": "html", "document": "page", "select": ".left a",
                        "text": True, "list": True})])
    other = Candidate(kind="text", value="Beta", display="Beta", candidate_id="other",
                      sources=[Source("markup", "page", "b", {
                          "from": "html", "document": "page", "select": ".right a",
                          "text": True, "list": True})])
    capture = capture_of('<html><body><div class="left"><a>Alpha</a></div>'
                         '<div class="right"><a>Beta</a></div></body></html>')

    rule = rule_for_many([one, other], lambda rule: members if rule else None)

    assert rule["select"] == [".left a", ".right a"]
    assert rule["list"] is True


def test_a_pick_that_cannot_be_named_as_a_set_keeps_the_ordinary_rule():
    """One clicked block is a value the field's own rules read, split if it holds members."""
    capture = capture_of(KEYWORD_PAGE)
    result = harvest(capture)
    block = next(c for c in result.candidates if c.value.startswith("Keywords:"))
    picks = {"tags": block.candidate_id}

    annotation = normalise_selected_members({"tags": block.value}, result, picks)
    rules = hypotheses(annotation, result, picks=picks, capture=capture)
    rule = _with_split(rules["tags"]["rule"], "tags", annotation["tags"])

    assert rule.get("list") is None                     # the block, not a group
    assert rule["transform"] == ["split"]               # the members are inside it
    assert answer_members("tags", annotation["tags"]) == split_members(block.value)
    assert split_members(block.value) == ["regulatory T cells", "IL-33:ST2 axis", "lung repair"]


def test_a_clicked_block_says_which_tags_it_will_become():
    """One clicked block on a several-value field: say what the import writes.

    The answer is the block (that is the shape the field's `split` transform needs), so the row
    used to read "one chosen" — and the question that followed was whether the import would take
    the block as a single tag.
    """
    payload = json.loads(re.search(r"const DATA = (.*?);\n",
                                   page(harvest(capture_of(KEYWORD_PAGE)), url="https://x.test/a"),
                                   re.S).group(1))
    keyword = next(entry for entry in payload["candidates"]
                   if entry["value"].startswith("Keywords:"))

    assert keyword["split"] == ["regulatory T cells", "IL-33:ST2 axis", "lung repair"]
    assert split_members(keyword["value"]) == keyword["split"], "one splitter, both sides"
    assert "splitInto" in json.dumps(payload["text"], ensure_ascii=False)


def test_one_pick_and_several_picks_are_told_apart_by_the_recorded_switch():
    """One id and one-of-many ids look the same; only what was recorded says which it was."""
    capture = capture_of(AUTHOR_PAGE)
    result = harvest(capture)
    one = pick(result, "Wen Tan")

    assert picked_ids({"creator": one}, "creator") == [one]
    assert picked_ids({"creator": [one, pick(result, "Bohan Zhang")]}, "creator") == [
        one, pick(result, "Bohan Zhang")]
    assert picked_ids({}, "creator") == []
    # An answer of several is a list; the same field answered with one value stays one value.
    assert normalise_selected_members({"creator": "Wen Tan"}, result, {"creator": one}) == {
        "creator": "Wen Tan"}
    assert normalise_selected_members({"creator": "Wen Tan"}, result, {"creator": one},
                                      multi=("creator",)) == {"creator": ["Wen Tan"]}


def test_the_switch_is_offered_on_exactly_the_fields_that_can_hold_several():
    payload = json.loads(re.search(r"const DATA = (.*?);\n",
                                   page(harvest(capture_of(AUTHOR_PAGE)), url="https://x.test/a"),
                                   re.S).group(1))
    switches = {field["key"]: (field["multi"], field["mode"]) for field in payload["fields"]}

    assert switches["creator"] == (True, "one")
    assert switches["tags"] == (True, "many")
    assert switches["characters"] == (True, "many")
    assert all(switches[key][0] is False
               for key in ("title", "date", "description", "cover", "preview"))
    # And the mode travels with the answer, because the count cannot decide the shape.
    assert "multi: Object.keys(modes)" in page(harvest(capture_of(AUTHOR_PAGE)),
                                               url="https://x.test/a")


def test_a_creator_answered_as_a_set_reaches_the_record_as_several_authors():
    capture = capture_of(AUTHOR_PAGE)
    result = harvest(capture)
    authors = ["Wen Tan", "Bohan Zhang"]
    list_rule = {"from": "html", "document": "page", "select": "div.author a.by",
                 "text": True, "list": True}
    several = Sample(name="one", capture=capture, harvest=result,
                     annotated={"creator": authors},
                     picks={"creator": [pick(result, name) for name in authors]},
                     multi=("creator",), selected_rules={"creator": list_rule})

    fields = draft_site_json([several], learn([several], prefer_latest=True))["work"]["fields"]
    assert fields["authors"]["list"] is True            # several names -> the plural field
    assert "author" not in fields
    # And one name stays the singular field — the same call the builder makes (`prefer_latest`,
    # where the person's own pick decides between two rules that both read the page).
    single_rule = {"from": "html", "document": "page", "select": "div.author a.by",
                   "text": True, "index": 0}
    alone = Sample(name="two", capture=capture, harvest=result,
                   annotated={"creator": "Wen Tan"}, picks={"creator": pick(result, "Wen Tan")},
                   selected_rules={"creator": single_rule})
    fields = draft_site_json([alone], learn([alone], prefer_latest=True))["work"]["fields"]
    assert fields["author"].get("list") is None        # a single value: no list
    assert "authors" not in fields
    assert wants_a_list("creator", {"index": 0}) is False
    assert wants_a_list("tags", {"index": 0}) is True   # a tag list is several whatever the rule says


def test_the_round_trip_verifies_the_plural_name_it_wrote():
    """The draft writes several names as `authors`; the check has to look for that name.

    It looked for `author` alone, so a finished draft was reported as "the annotated field was
    discarded from the draft" — and the install was refused with "the round trip has to agree
    first" on an adapter that was in fact agreed (PMC, 2026-10-16). Worse, the per-page check
    filtered the field out entirely, so it was never verified either.
    """
    import tempfile

    from src.builder.learn import load_session
    from src.builder.roundtrip import compare_latest

    capture = capture_of(AUTHOR_PAGE)
    result = harvest(capture)
    names = ["Wen Tan", "Bohan Zhang"]
    rule = {"from": "html", "document": "page", "select": "div.author a.by",
            "text": True, "list": True}
    sample = Sample(name="one", capture=capture, harvest=result, annotated={"creator": names},
                    picks={"creator": [pick(result, name) for name in names]},
                    multi=("creator",), selected_rules={"creator": rule})
    draft = draft_site_json([sample], learn([sample], prefer_latest=True))
    round_trip = compare_latest([sample], draft, __import__("pathlib").Path(tempfile.mkdtemp()))

    assert "authors" in {comparison.field for comparison in round_trip.comparisons},         "the plural field is checked, not skipped"
    assert round_trip.ok, [c.detail for c in round_trip.comparisons]
    assert runtime_names("creator") == ("author", "authors")
    assert runtime_names("tags") == ("tags",)          # a list field has one name
    assert runtime_names("nope") == ()
    assert load_session is not None                    # the recorded session reads the same way


def test_a_field_reads_a_superset_only_when_the_answer_was_a_set():
    """The tolerance is the switch's, so an old annotation keeps comparing exactly."""
    result = harvest(capture_of(AUTHOR_PAGE))
    picked = [{"id": "one"}]          # the candidate's own value is one member of the answer
    expected = ["Wen Tan", "Bohan Zhang", "Xinpei Liu"]

    assert _is_what_was_annotated("Wen Tan", "Wen Tan", "creator", many=True)
    assert _is_what_was_annotated("Wen Tan", "Wen Tan", "creator", many=False)
    # A partial answer names the field only when the person said it was a set.
    assert _is_what_was_annotated(expected, "Wen Tan", "creator", many=True)
    assert not _is_what_was_annotated(expected, "Wen Tan", "creator", many=False)
    assert picked and result.candidates           # the fixture was harvested, not invented


def test_the_page_says_when_a_rule_reads_more_than_was_picked():
    """Reading more is the answer the person chose, but it is not done silently."""
    html = page(harvest(capture_of(AUTHOR_PAGE)), url="https://x.test/a")

    assert 'id="veilExtra"' in html                       # where the note is shown
    assert "result.extra" in html                         # fed by what the server reported
    assert "readsMore" in html                            # and worded by the page's own table


def test_the_member_splitter_keeps_a_comma_written_list_whole():
    """Measured on pmc.ncbi.nlm.nih.gov: five keywords came out as thirteen words."""
    assert split_members("regulatory T cells, IL-33:ST2 axis, lung repair") == [
        "regulatory T cells", "IL-33:ST2 axis", "lung repair"]
    assert split_members("Keywords: regulatory T cells, lung repair") == [
        "regulatory T cells", "lung repair"]
    assert split_members("关键词：标签一、标签二") == ["标签一", "标签二"]
    # The shapes the old separator handled are unchanged: a space-written pair is two members.
    assert split_members("美甘寧瑠 美甘妮露") == ["美甘寧瑠", "美甘妮露"]
    assert split_members("a, b, c") == ["a", "b", "c"]
    # One tag that merely contains a space is one member when it is the field's whole answer.
    assert answer_members("tags", ["Only One"]) == ["Only One"]
    assert "creator" in MULTI_FIELDS and "tags" in COLLECTION_FIELDS
