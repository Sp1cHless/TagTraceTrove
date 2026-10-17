"""A long text the page names but does not cut: a paper's abstract.

Measured on pmc.ncbi.nlm.nih.gov/articles/PMC8082076/ (2026-10-16): the page's own
`meta description` ends in "…" while the abstract it summarizes is a plain `<p>` under
`<h2>Abstract</h2>`, 1335 characters long. Only the summary was ever offered, so the
description field could only be filled with a cut value.

Two things had to hold: a long block whose *section* names it is a block of prose the person
can pick, and the field's own rules have to read that block rather than a nested one.
"""
from __future__ import annotations

from src.builder.annotate import page, rule_for
from src.builder.capture import Capture, Document
from src.builder.harvest import harvest
from src.builder.learn import read_rule

ABSTRACT = (
    "Acute respiratory distress syndrome (ARDS) triggered mostly by infection, is a syndrome "
    "that involves respiratory failure. ARDS induces strong local infiltration of regulatory "
    "T cells in the lungs, and those cells were recently highlighted as being related to the "
    "repair of various tissue. However, there is still a lack of adequate evidence showing the "
    "impact of that population, and the mechanism by which it is recruited remains unclear. "
    "Here we show that the alarmin restores regulatory cells and facilitates lung "
    "regeneration by promoting alveolar type II cell recovery, with elevated neutrophils "
    "infiltration and upregulated release of the growth factor."
)
CUT = "Acute respiratory distress syndrome (ARDS) triggered mostly by infection, is a syndrome that involves ..."

# The abstract's section also wraps the keywords block, exactly as the real page does, so the
# selector the harvester derives for the paragraph matches two elements and has to name one.
PAPER = (
    '<!doctype html><html><head>'
    f'<meta name="description" content="{CUT}">'
    '</head><body>'
    '<section class="abstract" id="abstract1"><h2>Abstract</h2>'
    f'<p>{ABSTRACT}</p>'
    '<section id="kwd-group1"><p>Keywords: one, two</p></section>'
    '</section></body></html>'
)


def capture_of(markup: str) -> Capture:
    return Capture(url="https://fixture.test/p/one",
                   documents=[Document(name="page", text=markup, format="html")])


def test_a_long_abstract_under_a_named_heading_is_offered_in_full():
    capture = capture_of(PAPER)
    result = harvest(capture)
    abstract = next((c for c in result.candidates if c.value.startswith("Acute respiratory")
                     and len(c.value) == len(ABSTRACT)), None)

    assert abstract is not None, "the whole abstract is a candidate, not only the page's summary"
    rule = rule_for(abstract, kind="scalar")
    assert rule is not None, "and a single-value field can use it"
    # The rule reads the abstract and nothing else: its section wraps the keywords block too,
    # so it names this paragraph by position rather than by the block that holds both.
    assert read_rule(rule, capture) == ABSTRACT
    assert rule.get("index") is not None or rule["matches"] == 1


def test_a_value_the_page_cut_short_ranks_below_the_text_it_summarizes():
    result = harvest(capture_of(PAPER))
    scored = {c.value: c.score for c in result.candidates}
    cut = next(c for c in result.candidates if c.value == CUT)
    full = next(c for c in result.candidates if c.value == ABSTRACT)

    # Still offered — on a page whose only description is its own summary there is nothing else.
    assert cut is not None
    assert full.score > cut.score


def test_the_page_says_which_kind_of_ellipsis_it_is_showing():
    """A preview of ours and a value the page cut short must not look the same.

    The first reading of that "…" was "we captured the abstract and are showing its opening",
    which is why the page now prints the count for its own previews and a notice, in a different
    colour, for a value the page itself ended.
    """
    result = harvest(capture_of(PAPER))
    payload = page(result, url="https://fixture.test/p/one")
    import json
    import re

    data = json.loads(re.search(r"const DATA = (.*?);\n", payload, re.S).group(1))
    marks = {entry["value"]: entry["cut_short"] for entry in data["candidates"]}

    assert marks[CUT] is True, "the page's own summary is marked"
    assert marks[ABSTRACT] is False, "our full text is not"
    # The words themselves, and the renderer that uses them, are in the page.
    for key in ("preview", "pageCut"):
        assert key in json.dumps(data["text"], ensure_ascii=False)
    assert "previewNote" in payload and "hint cut" in payload


def test_the_abstract_is_reachable_on_the_page_a_person_annotates():
    """It has to survive the payload and the shape gate, not only the harvest."""
    result = harvest(capture_of(PAPER))
    payload = page(result, url="https://fixture.test/p/one")
    import json
    import re

    data = json.loads(re.search(r"const DATA = (.*?);\n", payload, re.S).group(1))
    shown = next((entry for entry in data["candidates"]
                  if len(entry["value"]) == len(ABSTRACT)), None)

    assert shown is not None and shown["has_rule"], "shown, with a rule it can be picked by"
    assert "scalar" in shown["usable_for"], "and usable for the description field"


# The same paper on a site that numbers its ids per article style: PMC's abstract section is
# `#abstract1` on one article and `#Abs1` on the next (measured 2026-10-16, PMC8082076 against
# PMC12460222). A rule learned from the first read nothing on the second, and the person saw
# "read nothing" for the description.
SECOND = (
    '<!doctype html><html><head>'
    '<meta name="description" content="The use of plant growth-promoting bacteria is an ...">'
    '</head><body>'
    '<section class="abstract" id="Abs1"><h2>Abstract</h2>'
    '<p>The use of plant growth-promoting bacteria is an emerging strategy for sustainable '
    'agriculture, offering alternatives to chemical fertilisers. Here we report the draft genome '
    'sequence of a strain isolated from the leaf of a ready-to-eat lettuce plant, together with '
    'its functional characterisation, and we describe the traits that make it a candidate for '
    'field use in a warmer climate.</p>'
    '<section id="kwd-group1"><p>Keywords: bacteria, lettuce</p></section>'
    '</section></body></html>'
)


def test_a_block_named_by_an_id_is_also_offered_by_its_class():
    """An id names one page; the class names both, and the second sample is what decides."""
    first = capture_of(PAPER)
    second = capture_of(SECOND)
    learned = next(c for c in harvest(first).candidates
                   if c.kind == "text" and c.value == ABSTRACT)
    by_select = {source.rule["select"]: source.rule for source in learned.sources
                 if source.rule and source.rule.get("text")}

    assert "#abstract1 p" in by_select, "the page's own name for it"
    assert "section.abstract p" in by_select, "and the name the class gives it"
    # The point of keeping both: the id reads nothing on the next article, the class reads that
    # article's abstract — which is what the two samples compare.
    assert read_rule(by_select["#abstract1 p"], second) is None
    assert read_rule(by_select["section.abstract p"], second).startswith(
        "The use of plant growth-promoting")
