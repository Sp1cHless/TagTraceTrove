"""Phase 2: the Candidate Harvester, against content-neutral fixtures.

The plan asks for fixtures so that this pins behaviour without a live site, and
each fixture declares the values that must be found next to the page that contains
them, so a fixture and its expectation cannot drift apart.

The bar is **recall**, which the plan calls the core metric: a candidate that ranks
badly can still be chosen by a person, one that was never offered cannot be
recovered. So these tests ask "is the value there, and does a source say where it
came from" and never "is it first".

Run:  .venv/Scripts/python.exe -m pytest -q
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder.capture import (  # noqa: E402
    Capture,
    Document,
    capture_plain,
    plain_documents,
)
from src.generic.htmltree import parse_html, select_all  # noqa: E402
from src.builder.harvest import (  # noqa: E402
    harvest,
    looks_like_a_path,
    normalize_url,
    parse_loose,
    dotted_path,
)

FIXTURES = PROJECT_ROOT / "fixtures"
BASE = "https://fixture.test/"


def fixture_names() -> list[str]:
    return sorted(path.name for path in FIXTURES.iterdir()
                  if path.is_dir() and (path / "expected.json").is_file())


def load_fixture(name: str) -> Capture:
    """The fixture as a capture: markup, its inline scripts, and any recorded bodies.

    Built through `plain_documents` exactly as a real capture is, so a fixture
    cannot pass by being loaded differently from a page.

    `network_0.json` on disk is the document `network:0` in memory — a colon in a
    filename is an NTFS data stream, not a name.
    """
    directory = FIXTURES / name
    capture = Capture(url=f"{BASE}{name}", final_url=f"{BASE}{name}")
    capture.status = 200
    capture.content_type = "text/html"
    html = (directory / "page.html").read_text(encoding="utf-8")
    capture.documents = plain_documents(html)
    for path in sorted(directory.glob("network_*.json")):
        index = path.stem.split("_", 1)[1]
        payload = json.loads(path.read_text(encoding="utf-8"))
        # `{"url": …, "body": …}` records where a response came from, which is what
        # tells a response about this page's own work from one about its neighbours.
        if isinstance(payload, dict) and "body" in payload and "url" in payload:
            capture.documents.append(Document(name=f"network:{index}",
                                              text=json.dumps(payload["body"]),
                                              format="json",
                                              source_url=str(payload["url"])))
        else:
            capture.documents.append(Document(name=f"network:{index}",
                                              text=path.read_text(encoding="utf-8"),
                                              format="json"))
    return capture


def expected_for(name: str) -> dict:
    return json.loads((FIXTURES / name / "expected.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", fixture_names())
def test_every_fixture_finds_the_values_it_declares(name):
    """Recall: the value has to be offered, whatever rank it ends up at."""
    result = harvest(load_fixture(name))
    values = set(result.values())

    missing = [value for value in expected_for(name)["recall"] if value not in values]
    assert not missing, f"{name}: never offered -> {missing}"


@pytest.mark.parametrize("name", fixture_names())
def test_every_expected_value_says_which_channel_produced_it(name):
    """A value without provenance cannot be turned into a rule."""
    result = harvest(load_fixture(name))
    for value, channel in expected_for(name).get("provenance", {}).items():
        candidate = next((c for c in result.candidates if c.value == value), None)
        assert candidate is not None, f"{name}: {value!r} absent"
        channels = {source.channel for source in candidate.sources}
        assert channel in channels, f"{name}: {value!r} came from {channels}, not {channel}"
        assert all(source.detail for source in candidate.sources), "a source with no detail"


# --- the candidate model --------------------------------------------------- #

def test_one_value_seen_twice_is_one_candidate_with_two_sources():
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<meta property="og:title" content="Same Title"><h1>Same Title</h1>'))
    result = harvest(capture)

    matches = [c for c in result.candidates if c.value == "Same Title"]
    assert len(matches) == 1
    details = {source.detail for source in matches[0].sources}
    assert details == {"meta[og:title]", "h1 text"}


def test_agreement_between_channels_raises_a_candidate_above_a_lone_one():
    """The plan's §7: agreement is the strongest signal available."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<meta property="og:title" content="Agreed">'
             '<script type="application/ld+json">{"@type":"Book","name":"Agreed"}</script>'
             '<h1>Agreed</h1><p>Lonely</p>'))
    result = harvest(capture)

    agreed = next(c for c in result.candidates if c.value == "Agreed")
    lonely = next(c for c in result.candidates if c.value == "Lonely")
    assert agreed.score > lonely.score
    assert {s.channel for s in agreed.sources} == {"markup", "jsonld"}


def test_ranking_orders_but_never_removes():
    """Site chrome is ranked last, not dropped: a person still has to see it."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<nav><a href="/login">Login</a></nav><h1>The Work</h1>'))
    result = harvest(capture)

    assert "Login" in result.values()
    assert result.values().index("The Work") < result.values().index("Login")


def test_a_candidate_carries_the_path_the_runtime_will_read():
    """Every expected path is present. Extras are not a failure: `@type` is a value
    on the page too, and it is the one the plan's own content-type field wants."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<script type="application/ld+json">'
             '{"@type":"Book","name":"N","author":{"name":"A"},"pages":7}</script>'))
    result = harvest(capture)

    paths = {source.detail for candidate in result.candidates
             for source in candidate.sources if source.channel == "jsonld"}
    assert {"name", "author.name", "pages", "@type"} <= paths


# --- normalization --------------------------------------------------------- #

def test_a_fragment_is_dropped_because_it_changes_no_resource():
    assert normalize_url("https://x.test/a.jpg#frag", BASE) == "https://x.test/a.jpg"
    assert normalize_url("/a.jpg?v=2", BASE) == f"{BASE}a.jpg?v=2"


def test_a_name_is_not_turned_into_an_address():
    """`urljoin` resolves anything, so a channel that resolved everything would
    invent an address for every value it saw."""
    assert looks_like_a_path("/media/a.jpg") is True
    assert looks_like_a_path("https://x.test/a") is True
    assert looks_like_a_path("media/a.jpg") is True
    assert looks_like_a_path("Lantern Season") is False
    assert looks_like_a_path("2021-03-04") is False


def test_a_url_carrying_a_session_id_is_still_a_url():
    """`;` is ordinary in an address and is a markup giveaway everywhere else."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<a href="/space;jsessionid=ABC123">Enter</a>'))
    result = harvest(capture)

    assert f"{BASE}space;jsessionid=ABC123" in result.values("url")


def test_whitespace_is_normalized_for_comparison_but_kept_for_display():
    """Comparison has to collapse it; what was on the page is still what a person
    needs to see, so the two are kept apart."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="network:0", format="json",
        text=json.dumps({"title": "A   Work\n  Title"})))
    result = harvest(capture)

    candidate = next(c for c in result.candidates if c.value == "A Work Title")
    assert candidate.display == "A   Work\n  Title"


# --- the channels ---------------------------------------------------------- #

def test_an_escaped_path_in_framework_state_is_decoded():
    """The Phase 1 measurement that put this channel on the list at all: the value
    was in the page, split by `\\u002F`, and a string scan could not cross it."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="inline:0", format="script",
        text='window.__NUXT__={"work":{"cover":"\\u002Fmedia\\u002Fx.jpg"}};'))
    result = harvest(capture)

    assert f"{BASE}media/x.jpg" in result.values("url")


def test_a_minified_script_falls_back_to_literals_and_says_so():
    """Not a decoder for minified state, and it does not pretend to be one."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="inline:0", format="script",
        text='window.__X__=(function(a,b){return {title:a,cover:b}}("A Work","/c.jpg"));'))
    result = harvest(capture)

    assert "A Work" in result.values()
    assert any("not JSON" in note for note in result.notes)


def test_a_response_body_is_read_as_json_not_as_html():
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="network:0", format="json",
        text=json.dumps({"data": {"title": "From The API", "n": 3}})))
    result = harvest(capture)

    candidate = next(c for c in result.candidates if c.value == "From The API")
    assert candidate.sources[0].channel == "network"
    assert candidate.sources[0].detail == "data.title"
    assert "3" in result.values("number")


def test_a_media_candidate_keeps_the_size_the_page_declared():
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<img class="cover" src="/a.jpg" width="640" height="900">'))
    result = harvest(capture)

    candidate = next(c for c in result.candidates if c.kind == "image")
    assert candidate.context["declared_width"] == 640
    assert candidate.context["declared_height"] == 900


def test_an_image_that_looks_like_chrome_is_marked_but_still_offered():
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<img src="/static/images/site-logo.svg"><img src="/a.jpg">'))
    result = harvest(capture)

    logo = next(c for c in result.candidates if c.value.endswith("site-logo.svg"))
    assert logo.context["chrome"]
    plain = next(c for c in result.candidates if c.value.endswith("/a.jpg"))
    assert plain.score > logo.score


# --- the pieces ------------------------------------------------------------ #

def test_dotted_paths_use_the_syntax_the_runtime_already_reads():
    assert dotted_path(["data", 0, "work", "title"]) == "data[0].work.title"
    assert dotted_path(["name"]) == "name"


def test_parse_loose_takes_json_and_declines_to_guess_at_the_rest():
    assert parse_loose('{"a":1}') == {"a": 1}
    assert parse_loose('window.X = {"a":1};') == {"a": 1}
    assert parse_loose('window.X = \\u002Fescaped\\u002F;') is None
    assert parse_loose("(function(a){return a}(1))") is None


def test_a_capture_survives_a_round_trip_through_its_own_json(tmp_path):
    """A session must be replayable without visiting the site again."""
    capture = load_fixture("jsonld_work")
    path = capture.write(tmp_path / "capture.json")
    restored = Capture.read(path)

    assert restored.to_json() == capture.to_json()
    assert harvest(restored).values() == harvest(capture).values()


def test_a_plain_capture_of_a_bad_url_reports_rather_than_raises():
    capture = capture_plain("not-a-url")

    assert capture.documents == []
    assert capture.notes


# --- Phase 3: the plan's four acceptance items ------------------------------ #

def test_the_same_cover_offered_at_several_sizes_is_one_candidate():
    """`…/250px-X.jpg` and `…/X.jpg` are one picture: the plan's §4.6 case, and a
    page that shows a cover three times must not offer it as three candidates."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<img src="/commons/1/17/Photo.jpg">'
             '<img src="/commons/thumb/1/17/Photo.jpg/250px-Photo.jpg">'
             '<img src="/commons/thumb/1/17/Photo.jpg/960px-Photo.jpg">'))
    result = harvest(capture)

    images = result.by_kind("image")
    assert len(images) == 1
    assert len(images[0].context["variants"]) == 2


def test_a_picture_that_is_not_the_first_one_can_still_be_named():
    """The rule a person's pick becomes has to read *that* picture, not the first of the set.

    Measured on buondua (2026-10-10): the article keeps its photos under one selector, the person
    picked the second as the cover and the third as the preview, and both rules read the first —
    the learner pruned both fields, so the adapter had no cover and no preview and the import
    arrived with no images at all. The same page's earlier run worked only because that person had
    picked the first picture. The runtime has read `index` all along and nothing ever sent it; the
    harvest now offers it *beside* the plain rule, so a page whose first match is right keeps
    reading it.
    """
    from src.generic.document import Document as RuntimeDocument
    from src.generic.document import DocumentBag
    from src.generic.select import resolve

    html = ('<html><body><div class="article-fulltext">'
            '<img src="/p/one-001.jpeg"><img src="/p/one-002.jpeg"><img src="/p/one-003.jpeg">'
            '</div></body></html>')
    capture = Capture(url=f"{BASE}one", final_url=f"{BASE}one")
    capture.documents.append(Document(name="page", format="markup", text=html))
    result = harvest(capture)

    bag = DocumentBag()
    bag.add(RuntimeDocument(name="page", text=html, format="html", url=f"{BASE}one"))
    for name, position in (("one-002.jpeg", 1), ("one-003.jpeg", 2)):
        candidate = next(c for c in result.candidates
                         if c.kind == "image" and str(c.value).endswith(name))
        rules = [source.rule for source in candidate.sources if source.rule]
        assert any("index" not in rule for rule in rules), f"{name}: the plain rule is gone"
        indexed = next((rule for rule in rules if rule.get("index") == position), None)
        assert indexed is not None, f"{name}: no rule names position {position} ({rules})"
        # The runtime reads that same picture back, which is the whole point of the rule.
        assert resolve(indexed, bag) == f"{BASE}p/{name}"


def test_the_run_of_pictures_after_the_first_is_offered_beside_the_whole_set():
    """A cover taken from a run of pictures keeps its preview in the pictures right after it.

    Measured on buondua (2026-10-10): the article's photos sit under one selector, the person's
    cover was the second of them and their preview the next three — and nothing could say "the next
    three", because `index` names one picture and the whole-set rule starts at the first. The added
    rule is that same set shifted by one, offered *beside* the whole set rather than instead of it,
    so a page that does not work this way keeps exactly the candidates it had.
    """
    from src.builder.harvest import COLLECTION_JOIN
    from src.builder.learn import read_rule

    html = ('<html><body><div class="article-fulltext">'
            + "".join(f'<img src="/p/one-{n:03d}.jpeg">' for n in (1, 2, 3, 4))
            + '</div></body></html>')
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(name="page", format="markup", text=html))
    result = harvest(capture)

    runs = [c for c in result.candidates if c.kind == "images"]
    whole = next(c for c in runs
                 if "offset" not in next(s.rule for s in c.sources if s.rule))
    after = next(c for c in runs
                 if next(s.rule for s in c.sources if s.rule).get("offset") == 1)
    assert whole is not after, "the whole set has to stay, and stay separate"
    assert [v.rsplit("/", 1)[-1] for v in whole.value.split(COLLECTION_JOIN)] \
        == [f"one-{n:03d}.jpeg" for n in (1, 2, 3, 4)]
    assert [v.rsplit("/", 1)[-1] for v in after.value.split(COLLECTION_JOIN)] \
        == ["one-002.jpeg", "one-003.jpeg", "one-004.jpeg"]

    # With the field's cap, it reads exactly the pictures after the first — the next three.
    rule = {**next(s.rule for s in after.sources if s.rule), "limit": 3}
    assert read_rule(rule, capture) == [f"{BASE}p/one-{n:03d}.jpeg" for n in (2, 3, 4)]


def test_two_works_whose_covers_share_a_name_are_not_merged():
    """The unsafe failure is collapsing two works, so containment is required."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<img src="/upload2/book/id/1/cover_1.jpg">'
             '<img src="/upload3/book/id/2/cover_1.png">'))
    result = harvest(capture)

    assert len(result.by_kind("image")) == 2


def test_the_same_address_with_a_tracking_parameter_is_one_candidate():
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<img src="/c.jpg">'
             '<meta property="og:image" content="/c.jpg?utm_source=card">'))
    result = harvest(capture)

    assert len(result.by_kind("image")) == 1


def test_navigation_does_not_lead():
    """The plan's third acceptance item: a nav link is not the work's title."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<header><nav><a href="/">Home</a><a href="/login">Login</a></nav></header>'
             '<main><h1>The Work</h1></main>'))
    result = harvest(capture)

    order = result.values()
    assert order.index("The Work") < order.index("Login")
    assert order.index("The Work") < order.index("Home")


def test_every_source_stays_expandable():
    """The plan's fourth acceptance item: one candidate, all its sources."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<meta property="og:title" content="A Work">'
             '<script type="application/ld+json">{"@type":"Book","name":"A Work"}</script>'
             '<h1>A Work</h1>'))
    result = harvest(capture)

    candidate = next(c for c in result.candidates if c.value == "A Work")
    assert {source.channel for source in candidate.sources} == {"markup", "jsonld"}
    assert len(candidate.sources) >= 3
    assert all(source.document and source.detail for source in candidate.sources)


# --- Phase 3: what the ranking learned from the measurements --------------- #

def test_a_page_repeating_one_value_has_not_confirmed_it():
    """Agreement is between channels. A template id repeated in three elements of
    one page's markup is the opposite signal, and scoring it as agreement put site
    furniture above the work (measured: the real cover at rank 479)."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<a data-id="22587219"><i data-id="22587219"></i></a>'
             '<div data-id="22587219"></div><h1>The Work</h1>'))
    result = harvest(capture)

    template = next(c for c in result.candidates if c.value == "22587219")
    assert template.score < next(c for c in result.candidates
                                 if c.value == "The Work").score


def test_a_field_key_outranks_a_parameter_of_the_same_response():
    """The plan's "API key 稳定": `title` names a field, `limit` names the response."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="network:0", format="json", source_url=f"{BASE}video/AB12CD34",
        text=json.dumps({"title": "The Work", "limit": 32, "numComments": 4})))
    capture.url = capture.final_url = f"{BASE}video/AB12CD34"
    result = harvest(capture)

    title = next(c for c in result.candidates if c.value == "The Work")
    limit = next(c for c in result.candidates if c.value == "32")
    assert title.score > limit.score


def test_a_neighbours_value_is_below_the_works_own():
    """The measured Phase 2 gap: a response about the works *beside* this one is
    shaped exactly like the response about this one."""
    result = harvest(load_fixture("related_api_work"))
    order = result.values()

    assert order.index("Quiet Harbor") < order.index("Some Other Work")
    assert order.index("Quiet Harbor") < order.index("Yet Another Work")


def test_an_escaped_entity_is_unified_without_decoding_markup_twice():
    """Markup text is already decoded by the parser; decoding it again is what once
    turned `?w=1&copy=2` into `?w=1©=2`."""
    from src.builder.harvest import decode_entities

    assert decode_entities("A &amp; B") == "A & B"
    assert decode_entities("plain") == "plain"
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="network:0", format="json", text=json.dumps({"title": "A &amp; B"})))
    result = harvest(capture)
    assert "A & B" in result.values()


def test_unicode_is_normalized_for_comparison():
    from src.builder.harvest import text_identity

    # Full-width digits and a non-breaking space compare as their ordinary forms.
    assert text_identity("１２３") == "123"
    assert text_identity("A B") == "A B"


# --- where else a page keeps an image --------------------------------------- #

def images_of(html: str) -> dict[str, list[str]]:
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(name="page", format="markup", text=html))
    result = harvest(capture)
    return {c.value: [s.detail for s in c.sources] for c in result.by_kind("image")}


def test_a_painted_background_is_an_image_because_that_is_where_posters_live():
    """Measured on a real page: the work's own cover was a `background-image` on the
    player's poster div, while every `<img>` on that page was a related work — so a
    harvester reading only `<img>` offered every thumbnail except the right one."""
    found = images_of('<div class="vjs-poster" '
                      'style="background-image: url(&quot;/c.jpg&quot;)"></div>'
                      '<img src="/related.jpg">')

    assert f"{BASE}c.jpg" in found
    assert found[f"{BASE}c.jpg"] == ["div[style[background-image]]"]
    assert f"{BASE}related.jpg" in found


def test_a_video_poster_and_a_srcset_are_images_too():
    found = images_of('<video poster="/p.jpg" src="/movie.mp4"></video>'
                      '<img srcset="/small.jpg 1x, /big.jpg 2x" src="/fallback.jpg">')

    assert found[f"{BASE}p.jpg"] == ["video[poster]"]
    assert found[f"{BASE}small.jpg"] == ["img[srcset]"]   # the first of the set
    # The `src` beside a srcset is offered too: it is an image the page really
    # declares, and dropping a declared value to look tidy is a recall loss.
    assert found[f"{BASE}fallback.jpg"] == ["img[src]"]
    # A video's own file is not a cover, and that one is a rule rather than a taste.
    assert f"{BASE}movie.mp4" not in found


def test_a_script_or_an_iframe_is_not_an_image():
    """The broadening that added the background channel also made `script[src]` an
    image, and it scored high enough to sit near the top of a real page."""
    found = images_of('<script src="/bundle.js"></script>'
                      '<iframe src="/ad.html"></iframe>'
                      '<link rel="icon" href="/favicon.ico">'
                      '<img src="/real.jpg">')

    assert list(found) == [f"{BASE}real.jpg"]


def test_a_declared_image_is_offered_as_an_image_so_it_can_be_picked_by_eye():
    """`og:image` was a bare URL candidate, so it had no preview — and a cover is
    chosen by looking at it."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<meta property="og:image" content="//cdn.example.test/c.jpg">'))
    result = harvest(capture)

    image = next(c for c in result.candidates if c.kind == "image")
    assert image.value == "https://cdn.example.test/c.jpg"
    assert image.sources[0].detail == "meta[og:image]"


def test_a_url_meta_that_is_not_declared_an_image_stays_a_url():
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<meta property="og:url" content="//example.test/a/b">'))
    result = harvest(capture)

    assert result.by_kind("image") == []
    assert "https://example.test/a/b" in result.values("url")


def test_a_painted_picture_is_read_through_its_style_attribute():
    """Measured on iwara (2026-10-11): the cover the person picked was a *painted* picture.

    Its candidate had exactly one usable source — `div[style[background-image]]` — and that source
    carried no rule, so the only rule recorded for the pick was `og:image`, which points at a
    *different* picture (the same work's thumbnail rather than the original). The next page then
    proposed that other picture, the two answers disagreed, and the cover was pruned for good.

    An earlier round of this same test asserted the opposite — that no primitive exists for a painted
    picture, so the meta rule is the one that runs. The primitive does exist: the runtime reads an
    attribute through a filter and a capture group, which is the reading the harvest itself did.
    """
    from src.builder.annotate import rule_for
    from src.builder.learn import read_rule

    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<meta property="og:image" content="/thumb-01.jpg">'
             '<div class="vjs-poster" style="background-image: url(&quot;/original/pic-05.jpg&quot;)">'
             '</div>'))
    result = harvest(capture)
    candidate = next(c for c in result.by_kind("image") if "original" in str(c.value))

    by_detail = {source.detail: source.rule for source in candidate.sources}
    painted = by_detail["div[style[background-image]]"]
    assert painted is not None, "a painted picture is a picture the page has"
    assert painted["attr"] == "style" and painted["group"] == 1
    # It reads the address the page painted — and `og:image` names a *different* picture, which is
    # why the pick has to be read through the style attribute rather than through the declared one.
    assert read_rule(painted, capture) == candidate.value
    declared = next(c for c in result.by_kind("image") if "thumb-01" in str(c.value))
    assert declared.value != candidate.value, "the two rules point at different pictures"
    assert any((source.rule or {}).get("from") == "meta" for source in declared.sources)
    assert rule_for(candidate) == painted


def test_the_meta_rule_for_a_cover_reads_a_different_page(monkeypatch):
    """The user's report: page 2's cover reads nothing. The number in the filename
    differs per work — and the rule does not contain it, which is the whole point."""
    from src.builder.learn import read_rule

    def page(number: str) -> Capture:
        capture = Capture(url=BASE, final_url=BASE)
        capture.documents.append(Document(
            name="page", format="markup",
            text=f'<meta property="og:image" content="//cdn.test/i/thumb-{number}.jpg">'))
        return capture

    rule = {"from": "meta", "document": "page", "property": "og:image"}

    assert read_rule(rule, page("12")) == "//cdn.test/i/thumb-12.jpg"
    assert read_rule(rule, page("00")) == "//cdn.test/i/thumb-00.jpg"


def test_a_srcset_carries_no_rule_because_no_primitive_picks_one_candidate():
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<img srcset="/small.jpg 1x, /big.jpg 2x">'))
    result = harvest(capture)

    assert result.by_kind("image")[0].sources[0].rule is None


# --- typing a value by its shape -------------------------------------------- #

def test_a_date_shaped_value_is_typed_and_ranks_above_ordinary_text():
    """The plan's pipeline is 归一化 → 去重 → **类型化**. Without the typing step a date
    could not be found at all: measured on a real page, the date was an ordinary text
    candidate scoring the same zero as the site's navigation."""
    from src.builder.harvest import looks_like_a_date

    assert looks_like_a_date("當地首播:2026-04-03")
    assert looks_like_a_date("2026-09-30T12:00:00Z")
    assert looks_like_a_date("09/30/2026")
    assert looks_like_a_date("2026年9月30日")
    assert not looks_like_a_date("第73-82集")
    assert not looks_like_a_date("運動競技")

    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<ul><li>當地首播:2026-04-03</li><li>運動競技</li></ul>'))
    result = harvest(capture)
    dates = [c for c in result.by_kind("text") if looks_like_a_date(c.value)]
    others = [c for c in result.by_kind("text") if not looks_like_a_date(c.value)]

    assert dates and others
    assert min(c.score for c in dates) > max(c.score for c in others)


def test_the_time_element_is_read_in_both_its_forms():
    """`<time>` is how a page marks a date, and `datetime` carries the machine value
    even when the text is a human one."""
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<p><time datetime="2026-09-30">9月30日首播</time></p>'))
    result = harvest(capture)

    machine = next(c for c in result.candidates if c.value == "2026-09-30")
    assert machine.kind == "text"
    assert machine.sources[0].detail == "time[datetime]"
    assert machine.sources[0].rule["attr"] == "datetime"
    assert "9月30日首播" in result.values()


def test_a_value_among_siblings_is_anchored_on_its_own_label():
    """The manual report: "當地首播:2026-10-02 is the right date and it is never found".

    It was found — and unreadable. Every info field on that page is a sibling `li`, so
    the rule `ul.ACG-box1listA li` matched thirteen elements and read the first, which
    is why the date came back as another line on the next page. The primitive for it
    already existed (`filter` is a list of regexes the value must match); the Builder
    had simply never emitted one.
    """
    from src.builder.annotate import rule_for
    from src.builder.learn import read_rule

    def page(date: str) -> str:
        return ('<ul class="ACG-box1listA">'
                '<li>作品平台:動畫</li><li>作品類型:推理懸疑</li>'
                f'<li>當地首播:{date}</li><li>台灣首播:未定</li></ul>')

    first = Capture(url=BASE, final_url=BASE)
    first.documents.append(Document(name="page", format="markup", text=page("2026-04-03")))
    candidate = next(c for c in harvest(first).candidates if c.value.startswith("當地首播"))

    rule = rule_for(candidate)
    assert rule["filter"] == ["當地首播"]
    assert rule["matches"] == 1, "the anchored rule names one element, not thirteen"

    second = Capture(url=BASE, final_url=BASE)
    second.documents.append(Document(name="page", format="markup", text=page("2026-09-30")))
    # The label is the anchor precisely because it does not change between pages.
    assert read_rule(rule, first).endswith("2026-04-03")
    assert read_rule(rule, second).endswith("2026-09-30")


def test_a_value_with_no_label_gets_no_anchor():
    from src.builder.harvest import anchor_for

    assert anchor_for("當地首播:2026-10-02") == "當地首播"
    assert anchor_for("原著作者：許斐剛") == "原著作者"
    # Nothing stable to anchor on, so no rule is invented.
    assert anchor_for("2026-10-02") is None
    assert anchor_for("a: b") is None


# --- a value that is one row of many ---------------------------------------- #

INFO_ROWS = ('<div class="info"><span class="n">地区</span>'
             '<span class="detail_imform_value">{area}</span></div>'
             '<div class="info"><span class="n">制作</span>'
             '<span class="detail_imform_value">{studio}</span></div>'
             '<div class="info"><span class="n">首播</span>'
             '<span class="detail_imform_value">{date}</span></div>')


def info_page(area: str, studio: str, date: str) -> Capture:
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text="<html><body>" + INFO_ROWS.format(area=area, studio=studio, date=date)
        + "</body></html>"))
    return capture


def test_a_value_in_a_labelled_row_is_captured_out_of_that_row():
    """The manual report, in its general form: `creator`, `date` and `tags` all came
    back as the first row's value, because every field on that page is one `<span>`
    among eleven siblings and "container plus tag" reads the first of them.

    The page does say which row a value belongs to — the row carries its label — and
    the runtime can express that with `filter` and `group`, so the row is chosen by its
    label and the value captured out of it.
    """
    from src.builder.annotate import rule_for
    from src.builder.learn import read_rule

    first = info_page("日本", "MADHOUSE", "2026-07-17")
    bare = {"from": "html", "document": "page",
            "select": "span.detail_imform_value", "text": True}
    assert read_rule(bare, first) == "日本"          # the wrong row, every field

    for value, label in (("MADHOUSE", "制作"), ("2026-07-17", "首播")):
        candidate = next(c for c in harvest(first).candidates if c.value == value)
        rule = rule_for(candidate)
        assert rule["group"] == 1
        assert rule["matches"] == 1, "the row rule names one row, not the whole list"
        assert read_rule(rule, first) == value
        # The label is what makes it transfer: it is the same on every page.
        second = info_page("美国", "MAPPA", "2025-01-09")
        assert read_rule(rule, second) == ({label: "MAPPA", "制作": "MAPPA",
                                            "首播": "2025-01-09"}[label])


def test_a_row_rule_is_only_offered_when_it_actually_captures_the_value():
    """A rule that does not read the value it was derived from is worse than none:
    the annotation offers it as a choice."""
    from src.builder.harvest import label_pattern, sibling_label

    root = parse_html('<div class="info"><span class="n">制作</span>'
                      '<span class="v">MADHOUSE</span></div>')
    value_span = select_all(root, "span.v")[0]

    assert sibling_label(value_span) == ("制作", "div.info")
    assert label_pattern("制作", "MADHOUSE", value_span.parent.text()) is not None
    # A label that does not name this row's own value produces nothing.
    assert label_pattern("制作", "Something Else", value_span.parent.text()) is None
    assert label_pattern("制作", "MADHOUSE", "no such row") is None


# --- the value keeps the page's own characters ------------------------------ #

def test_a_full_width_punctuation_mark_survives_in_the_value():
    """NFKC-folding the value itself broke every field whose text holds a full-width
    comma or exclamation: the rule reads the page's own characters, so the stored value
    could never equal what the rule returned."""
    from src.builder.annotate import rule_for
    from src.builder.learn import read_rule

    text = "他跑得快，喊了一声！"
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup", text=f"<p>{text}</p>"))
    candidate = next(c for c in harvest(capture).candidates if "跑得快" in c.value)

    assert "，" in candidate.value and "！" in candidate.value
    assert read_rule(rule_for(candidate), capture) == candidate.value


def test_two_spellings_of_the_same_text_still_become_one_candidate():
    """Folding is for the identity, which is what deduplication compares."""
    from src.builder.harvest import text_identity

    assert text_identity("a，b") == text_identity("a,b")


# --- a URL that still carries an entity is not a URL ------------------------ #

def test_a_double_encoded_url_loses_the_entity_and_agrees_with_the_dom():
    """Measured: `og:image` held `&amp;amp;` while the `img` attribute held `&`, so the
    same picture arrived as two different strings and neither side matched the other."""
    from src.builder.annotate import rule_for
    from src.builder.learn import read_rule

    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<meta property="og:image" content="/i.jpg?a=1&amp;amp;b=2">'
             '<img class="lazyload" data-original="/i.jpg?a=1&amp;b=2">'))
    result = harvest(capture)

    assert f"{BASE}i.jpg?a=1&b=2" in [c.value for c in result.by_kind("image")]
    assert not any("&amp;" in c.value for c in result.candidates)
    # The candidate carries the address the markup meant. Which *rule* reads it back
    # is not this module's call: the `meta` rule hands back the attribute as written
    # (still encoded, because the site wrote it twice), while the `img` rule reads
    # what the parser decoded. The three-sample validation is what keeps the one that
    # agrees and prunes the other, which is why the fixture asserts both readings
    # rather than pretending they are the same.
    image = next(c for c in result.by_kind("image"))
    rules = {source.detail: source.rule for source in image.sources}
    assert read_rule(rules["img[data-original]"], capture) == image.value
    assert "&amp;" in (read_rule(rules["meta[og:image]"], capture) or "")


def test_a_peer_value_is_not_mistaken_for_a_label():
    """Measured on a real page whose tags are a list of sibling chips.

    The chip before the value looked like a label, so a rule was offered that captured
    the value out of that chip's row — and it passed its own self-check on the page it
    came from. On every other page the "label" was a tag that work did not carry, so
    the rule read nothing; and because it named one row it outranked the rules that
    worked, which is how a field came to be forever empty.
    """
    from src.builder.harvest import sibling_label

    chips = "".join(f'<a class="tag is-medium"><span>{name}</span></a>'
                    for name in ("Fantia", "rioko", "Cosplay", "Fantia"))
    root = parse_html(f'<html><body><div class="tags">{chips}</div></body></html>')

    assert sibling_label(select_all(root, "a.tag span")[1]) is None
    assert sibling_label(select_all(root, "a.tag span")[0]) is None


def test_a_two_sibling_row_is_still_a_label():
    """The guard is on the sibling set's size, so the shape it was built for survives."""
    from src.builder.harvest import sibling_label

    root = parse_html('<html><body><div class="info">'
                      '<span class="n">制作</span><span class="v">MADHOUSE</span>'
                      '</div></body></html>')

    assert sibling_label(select_all(root, "span.v")[0]) == ("制作", "div.info")


def test_a_media_rule_records_how_many_elements_it_names():
    """An image rule with no count could neither be compared with another nor shown as
    ambiguous, so a rule reading the first of a gallery looked as good as any."""
    from src.builder.annotate import rule_for

    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="page", format="markup",
        text='<div class="article"><img src="/a.jpg"><img src="/b.jpg">'
             '<img src="/c.jpg"></div>'))
    image = next(c for c in harvest(capture).by_kind("image"))
    recorded = [source.rule for source in image.sources if source.rule]

    assert any(rule["matches"] == 3 for rule in recorded), "the count is recorded"
    # An address rule over three images reads the first on purpose, so it stays a rule —
    # not flagged as reading something else, which is the test a *text* rule has to pass.
    assert rule_for(image) is not None
    assert rule_for(image)["matches"] == 3


def test_a_page_that_never_mentions_the_work_is_not_the_work_page():
    """A capture can come back as the site's own loading screen, and that is not a broken rule.

    Measured on iwara (2026-10-11): the second page was captured mid-load —
    `<title>Loading | Iwara</title>`, no work name, no images, and not one API response — so every
    rule read nothing and the confirm page offered five empty fields. The head is not evidence: that
    loading screen carried `<meta property="og:url">` echoing the address before anything rendered.
    """
    from src.builder.capture import mentions_the_work

    url = "https://www.site.test/video/sOAekITnnSb24p/fleurdelys"
    loading = (f'<html><head><meta property="og:url" content="{url}"><title>Loading | Site</title>'
               '</head><body><div id="app"></div></body></html>')
    assert mentions_the_work(url, loading, []) is False, "the head echoing the address is not the work"

    rendered = ('<html><head><title>Fleurdelys</title></head>'
                '<body><h1>Fleurdelys</h1></body></html>')
    assert mentions_the_work(url, rendered, []) is True

    # A page whose content is entirely behind JavaScript says which work it is in a request it made.
    api = Document(name="network:0", format="json", text="{}",
                   source_url="https://api.site.test/video/sOAekITnnSb24p")
    assert mentions_the_work(url, '<html><body><div id="app"></div></body></html>', [api]) is True

    # An address with nothing to look for is not a judgement this can make.
    assert mentions_the_work("https://www.site.test/", loading, []) is True
