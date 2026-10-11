"""Phase 4: annotation — and the property that makes it worth anything.

Two things are tested here that the phase stands or falls on:

* **Choosing a candidate is choosing a rule.** Every candidate's source carries the
  runtime selector that would read it again, so an annotation produces something
  executable rather than a field name. The test resolves the rule through the
  runtime's own `resolve`, which is the same code path an adapter uses.
* **The annotation arrives without being moved by hand.** The page is served on the
  loopback interface and posts its result back, so nothing lands in a download
  folder. That is asserted by actually doing it over HTTP.

Run:  .venv/Scripts/python.exe -m pytest -q
"""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder import text as l10n  # noqa: E402
from src.builder.annotate import (  # noqa: E402
    ACCEPTS,
    FIELDS,
    Annotation,
    hypotheses,
    page,
    rule_for,
)
from src.builder.capture import Document, plain_documents  # noqa: E402
from src.builder.harvest import (  # noqa: E402
    build_collections,
    element_selector,
    harvest,
    harvest_markup,
    _Registry,
)
from src.builder.session_server import Session, start  # noqa: E402
from src.generic.document import Document as RuntimeDocument  # noqa: E402
from src.generic.document import DocumentBag  # noqa: E402
from src.generic.htmltree import parse_html, select_one  # noqa: E402
from src.generic.select import resolve  # noqa: E402

FIXTURES = PROJECT_ROOT / "fixtures"
BASE = "https://fixture.test/"

PAGE = """<!doctype html><html><head>
  <title>Quiet Harbor - Example Site</title>
  <meta property="og:title" content="Quiet Harbor">
  <script type="application/ld+json">
  {"@type":"Book","name":"Quiet Harbor","author":{"name":"Lin Wei"}}
  </script>
</head><body>
  <header><nav><a href="/">Home</a></nav></header>
  <h1>Quiet Harbor</h1>
  <img class="cover" src="/media/quiet-harbor/cover.png" width="640" height="900">
  <div class="tags"><a href="/t/one">One</a><a href="/t/two">Two</a>
    <a href="/t/three">Three</a></div>
</body></html>
"""


def capture_of(html: str, url: str = f"{BASE}quiet-harbor"):
    from src.builder.capture import Capture

    capture = Capture(url=url, final_url=url)
    capture.status = 200
    capture.content_type = "text/html"
    capture.documents = plain_documents(html)
    return capture


def bag_for(html: str) -> DocumentBag:
    """The runtime's own document bag, built the way a generated adapter must build it.

    Markup under `page`, and the page's JSON-LD blocks under `jsonld` — because a
    `json` selector reads a JSON document, and the markup is HTML. Until an adapter
    exposes that document, a JSON-LD candidate's rule cannot run at all.
    """
    from src.generic.unknown_url import jsonld_nodes

    bag = DocumentBag()
    bag.add(RuntimeDocument(name="page", text=html, format="html"))
    for node in jsonld_nodes(html):
        bag.add(RuntimeDocument(name="jsonld", text=json.dumps(node), format="json"))
        break
    return bag


# --- choosing a candidate is choosing a rule -------------------------------- #

def test_a_markup_candidates_rule_reads_the_value_again():
    """The resolution runs through `src/generic/select.py`, the adapter's own code."""
    result = harvest(capture_of(PAGE))
    bag = bag_for(PAGE)

    for candidate in result.candidates:
        rule = rule_for(candidate)
        if rule is None or rule.get("list"):
            continue
        try:
            resolved = resolve(rule, bag)
        except Exception as error:  # noqa: BLE001 - the rule is the thing under test
            raise AssertionError(f"{candidate.value!r} rule {rule} failed: {error}") from None
        assert resolved is not None, f"{candidate.value!r} has a rule that reads nothing: {rule}"
        matches = max([source.rule.get("matches", 1) for source in candidate.sources
                       if source.rule] or [1])
        if matches > 1:
            # A selector like `a` matches every link, so the rule reads the first
            # link rather than the one it came from. That is the hypothesis the
            # plan's Example 2 prunes, and it is recorded rather than hidden.
            continue
        if candidate.kind == "image":
            assert str(resolved).endswith(candidate.value.rsplit("/", 1)[-1])
        else:
            assert candidate.value in str(resolved)


def test_the_rule_for_a_picked_picture_says_which_picture_it_is():
    """`apply_to` builds the confirm page's proposal out of `rule_for`, so this is what the next page
    is offered.

    Measured on buondua (2026-10-10): the person picked the set's second picture, the candidate
    carried both a plain rule (which reads the first) and a positional one, and `rule_for` returned
    the plain one — so the confirm page proposed the *first* picture, the person accepted it, the two
    pages then disagreed, and the cover was pruned although a rule reading exactly the annotated
    picture was sitting right there. At equal matches the positional rule is the more specific one.
    """
    from src.builder.capture import Capture
    from src.builder.learn import read_rule

    html = ('<html><body><div class="article-fulltext">'
            '<img src="/p/one-001.jpeg"><img src="/p/one-002.jpeg">'
            '</div></body></html>')
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(name="page", format="markup", text=html))
    result = harvest(capture)

    candidate = next(c for c in result.candidates
                     if c.kind == "image" and str(c.value).endswith("one-002.jpeg"))
    rule = rule_for(candidate)

    assert rule.get("index") == 1, rule
    assert read_rule(rule, capture) == f"{BASE}p/one-002.jpeg"


def test_a_rule_that_cannot_run_does_not_win_over_one_that_can():
    """A rule naming a captured response reads nothing wherever it is installed.

    The runtime fetches such a document by a request recipe and the builder derives none (execution
    log §731), so preferring it is always wrong — and a response is named by its *order* among the
    responses, so the same name is a different response on the next page. Measured on iwara
    (2026-10-10): the title had a page rule reading exactly one element, the tool chose the API path
    anyway, and the confirm page proposed the site's own announcement banner as the work's title.
    """
    from src.builder.capture import Capture

    html = '<html><body><div class="text mb-1">Mornye</div></body></html>'
    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(name="page", format="markup", text=html))
    capture.documents.append(Document(name="network:4", format="json",
                                      text=json.dumps({"title": "Mornye"})))
    result = harvest(capture)
    candidate = next(c for c in result.candidates if c.value == "Mornye")
    assert any((source.rule or {}).get("document") == "network:4"
               for source in candidate.sources), "the API rule has to be offered to be ranked"

    rule = rule_for(candidate)

    assert rule.get("document") == "page", rule
    assert rule.get("select") == "div.text.mb-1", rule


def test_a_json_candidates_rule_reads_the_value_again():
    body = json.dumps({"data": {"post": {"title": "From The API"}}})
    from src.builder.capture import Capture

    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(name="network:0", format="json", text=body,
                                      source_url=f"{BASE}api/post/1"))
    result = harvest(capture)
    candidate = next(c for c in result.candidates if c.value == "From The API")
    rule = rule_for(candidate)

    assert rule == {"from": "json", "document": "network:0", "path": "data.post.title"}
    bag = DocumentBag()
    bag.add(RuntimeDocument(name="network:0", text=body, format="json"))
    assert resolve(rule, bag) == "From The API"


def test_a_candidate_without_a_rule_is_marked_as_such():
    """A script literal has no path, so it cannot become a rule — and the page says
    so rather than offering a choice that would silently produce nothing."""
    from src.builder.capture import Capture

    capture = Capture(url=BASE, final_url=BASE)
    capture.documents.append(Document(
        name="inline:0", format="script",
        text='window.__X__=(function(a){return a}("Loose Value"));'))
    result = harvest(capture)
    loose = next(c for c in result.candidates if c.value == "Loose Value")

    assert rule_for(loose) is None


def test_a_heading_selector_is_specific_enough_to_name_the_element():
    """Measured in Phase 1: a bare tag repeats forty times on a real page and would
    read whichever came first."""
    root = parse_html('<h1 id="t">A</h1><h2 class="sub x">B</h2><h3>C</h3>')
    assert element_selector(select_one(root, "h1")) == "#t"
    assert element_selector(select_one(root, "h2")) == "h2.sub.x"
    assert element_selector(select_one(root, "h3")) == "h3"


# --- collections ------------------------------------------------------------ #

def test_a_repeated_group_becomes_one_collection_candidate():
    """The plan's §13.1: a collection must not be marked one element at a time."""
    result = harvest(capture_of(PAGE))
    collections = result.by_kind("collection")

    # The tag links and the nav links are *different* groups, which is the point of
    # naming the ancestor when an element has no id and no class: `a` was one group of
    # everything, and a rule over it read the site's navigation.
    tags = next(c for c in collections
                if c.context["members"] == ["One", "Two", "Three"])
    assert rule_for(tags)["list"] is True
    assert rule_for(tags)["select"] == "div.tags a"
    # The nav link is not in it: a single link is not a repeated group, and the
    # anchor that used to sweep every link on the page into one collection now names
    # the container it repeats inside.
    assert "Home" not in tags.context["members"]
    assert "collection" in ACCEPTS["collection"]


def test_a_group_too_small_to_be_a_collection_is_not_offered():
    registry = _Registry()
    from src.builder.capture import Document as CaptureDocument

    harvest_markup(registry, CaptureDocument(name="page", format="markup",
                                             text="<a href='/1'>Only One</a>"),
                   BASE)
    build_collections(registry)

    assert registry.all() and not [c for c in registry.all() if c.kind == "collection"]


# --- previews: marking a cover, applied to a group --------------------------- #

PREVIEW_PAGE = """<!doctype html><html><head>
  <title>Quiet Harbor - Example Site</title>
  <meta property="og:image" content="/media/quiet-harbor/cover.png">
</head><body>
  <img class="cover" src="/media/quiet-harbor/cover.png">
  <div class="previews">
    <img src="/media/quiet-harbor/001.jpg"><img src="/media/quiet-harbor/002.jpg">
    <img src="/media/quiet-harbor/003.jpg"><img src="/media/quiet-harbor/004.jpg">
  </div>
</body></html>
"""

PREVIEW_MEMBERS = [f"{BASE}media/quiet-harbor/00{index}.jpg" for index in range(1, 5)]


def preview_group(html: str = PREVIEW_PAGE):
    result = harvest(capture_of(html))
    return result, next(c for c in result.by_kind("images")
                        if c.context["selector"] == "div.previews img")


def test_a_repeated_image_group_is_offered_as_one_preview_candidate():
    """Marking previews is marking a cover, applied to a group: a person points at an
    image either way, and what differs is that the field is many pictures."""
    _result, group = preview_group()

    assert group.context["count"] == 4
    assert group.context["members"] == PREVIEW_MEMBERS
    rule = rule_for(group)
    assert rule["list"] is True
    # Reading all of them is what makes the field many-valued end to end: the runtime
    # turns `preview_urls` into `preview_images`, one entry per address.
    assert resolve(rule, bag_for(PREVIEW_PAGE),
                   context={"url": f"{BASE}quiet-harbor"}) == PREVIEW_MEMBERS
    assert "images" in ACCEPTS["images"]


def test_one_picture_at_two_sizes_is_one_member_of_the_group():
    """The merge that keeps a cover from being offered three times applies to the group
    too, so it has to run before the group is built for that to hold."""
    page = """<!doctype html><html><body><div class="previews">
      <img src="/commons/1/17/Photo.jpg">
      <img src="/commons/thumb/1/17/Photo.jpg/250px-Photo.jpg">
      <img src="/media/quiet-harbor/002.jpg">
      <img src="/media/quiet-harbor/003.jpg">
    </div></body></html>"""

    _result, group = preview_group(page)

    assert group.context["count"] == 3
    assert group.context["members"][0] == f"{BASE}commons/1/17/Photo.jpg"


def test_a_lone_image_is_not_offered_as_a_preview_group():
    """A group is still a group: one picture beside a title is a cover, not a set."""
    page = """<!doctype html><html><body>
      <div class="previews"><img src="/media/quiet-harbor/001.jpg"></div>
      <div class="other"><img src="/media/quiet-harbor/002.jpg"></div>
    </body></html>"""

    result = harvest(capture_of(page))

    assert result.by_kind("image")
    assert result.by_kind("images") == []


def test_choosing_the_preview_group_is_choosing_its_list_rule():
    """The whole point of the field: the annotation records the addresses, and the rule
    the click produces reads all of them again."""
    result, group = preview_group()

    built = hypotheses({"preview": group.context["members"]}, result,
                       picks={"preview": group.candidate_id})

    assert built["preview"]["value"] == PREVIEW_MEMBERS
    assert built["preview"]["rule"]["list"] is True
    assert built["preview"]["rule"]["select"] == "div.previews img"


# --- the annotation itself -------------------------------------------------- #

def test_hypotheses_map_each_field_to_a_rule():
    result = harvest(capture_of(PAGE))
    title = next(c for c in result.candidates if c.value == "Quiet Harbor")
    cover = next(c for c in result.by_kind("image"))

    # The page sends the value a person accepted, plus the candidate they clicked —
    # the rule comes from the pick, and the value is what `learn` compares against.
    built = hypotheses({"title": title.value, "cover": cover.value}, result,
                       picks={"title": title.candidate_id, "cover": cover.candidate_id})

    assert set(built) == {"title", "cover"}
    assert built["title"]["rule"]["from"] in ("meta", "json", "html")
    assert built["cover"]["rule"]["attr"]


def test_a_field_pointing_at_nothing_is_left_out_rather_than_guessed():
    result = harvest(capture_of(PAGE))

    assert hypotheses({"title": "no such value"}, result) == {}
    assert hypotheses({"title": ""}, result) == {}


def test_the_page_carries_every_candidate_and_says_what_it_cannot_do():
    result = harvest(capture_of(PAGE))
    html = page(result, url=f"{BASE}quiet-harbor")

    assert "Quiet Harbor" in html
    assert len(result.candidates) > 0
    # The limitation is on the page, not only in a document: a value that is not a
    # candidate cannot be chosen here.
    assert "候选列表里没有的值无法在此选择" in html
    assert "/media?c=" in html


# --- the round trip, with no file to move ----------------------------------- #

def serve_for(html: str, tmp_path: Path):
    result = harvest(capture_of(html))
    session = Session(harvest=result, directory=tmp_path, url=f"{BASE}quiet-harbor")
    httpd, url = start(session)
    return session, httpd, url


def test_the_annotation_is_written_by_the_tool_itself(tmp_path):
    result = harvest(capture_of(PAGE))
    title = next(c for c in result.candidates if c.value == "Quiet Harbor")
    session = Session(harvest=result, directory=tmp_path, url=f"{BASE}quiet-harbor")
    httpd, url = start(session)

    try:
        with urllib.request.urlopen(url) as reply:
            assert reply.status == 200
            page = reply.read().decode("utf-8")
        assert "Quiet Harbor" in page
        # The other half of the same property the chooser's page is held to (see
        # `test_listing.test_the_choosing_page_is_served_with_every_word_it_reads`): every word the
        # script reads must have been handed to it, or the page stops rendering partway.
        handed = set(payload_of(page)["text"])
        read = set(re.findall(r"\bT\.([A-Za-z][A-Za-z0-9]*)", page))
        assert read, "a page whose script reads no words is a page whose script is gone"
        assert not (read - handed), f"the page reads {sorted(read - handed)} and was not given them"

        request = urllib.request.Request(
            url.replace("/?", "/api/annotations?"),
            data=json.dumps({"url": f"{BASE}quiet-harbor", "mode": "annotate",
                             "fields": {"title": title.value},
                             "picks": {"title": title.candidate_id}}).encode("utf-8"),
            headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(request) as reply:
            answer = json.loads(reply.read().decode("utf-8"))

        # Written where the session lives, by the server — not downloaded to a
        # browser folder and moved by hand.
        assert answer["ok"] is True
        written = tmp_path / "annotations.json"
        assert written.is_file()
        document = json.loads(written.read_text(encoding="utf-8"))
        assert document["fields"] == {"title": "Quiet Harbor"}
        assert document["picks"] == {"title": title.candidate_id}
        assert document["hypotheses"]["title"]["value"] == "Quiet Harbor"
        assert session.done.is_set()
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_a_request_without_the_token_is_refused(tmp_path):
    _session, httpd, url = serve_for(PAGE, tmp_path)
    try:
        bare = url.split("?")[0]
        with pytest.raises(urllib.error.HTTPError) as refusal:
            urllib.request.urlopen(bare)
        assert refusal.value.code == 403
    finally:
        httpd.shutdown()
        httpd.server_close()


def payload_of(html: str) -> dict:
    """The data the page's own script reads, exactly as it reads it.

    Extracted from the served HTML rather than rebuilt in the test: testing a URL the
    test constructs is how the covers came to be requested without a token and the
    suite stayed green while no image ever appeared.
    """
    start = html.index("const DATA = ") + len("const DATA = ")
    # Read the payload as JSON, not up to the first `;`: a semicolon inside any string (an English
    # sentence has one, and so could a page's own text) closed the object early and the test failed
    # on a payload that was perfectly well formed.
    payload, _end = json.JSONDecoder().raw_decode(html[start:])
    return payload


def test_the_page_is_served_in_the_language_t3_is_in(monkeypatch):
    """One page, two languages, and no language mixed into the other.

    The page is served by the tool but read by a person inside T³, so T³'s own language travels to it
    (`SITEPROBE_LANG`) — and the whole page has to follow, not just the prose: the field names, the
    kind chips, the picture names, the buttons and the document's own language attribute. The state
    this replaces was a Chinese page whose title, chips and picture names stayed English, which the
    user reported as 混杂了英语.
    """
    # The language reaches both halves through the environment: the harvest writes a candidate's
    # provenance line while it runs, and the page renders later in the same process. In production
    # one variable sets both (`SITEPROBE_LANG`, from T³), so a test that changes the page alone would
    # measure a state that cannot happen.
    monkeypatch.setenv("SITEPROBE_LANG", "en")
    harvest_result = harvest(capture_of(PREVIEW_PAGE))
    english = page(harvest_result, url=BASE, lang="en")
    assert '<html lang="en">' in english
    assert "SiteProbe annotation" in english
    assert "Save annotation" in english
    prompts = payload_of(english)
    prompts = payload_of(english)
    assert prompts["text"]["save"] == "Save annotation"
    assert prompts["text"]["kindAll"] == "All"
    assert prompts["kindLabels"]["image"] == "Image"
    assert prompts["fields"][0]["label"] == "Title"
    assert all("zh" not in (hint or "") for hint in [f["hint"] for f in prompts["fields"]])
    # No Chinese anywhere in the served document, comments and payload included.
    assert not re.search(r"[一-鿿]", english)

    monkeypatch.setenv("SITEPROBE_LANG", "zh")
    chinese = page(harvest(capture_of(PREVIEW_PAGE)), url=BASE, lang="zh")
    assert '<html lang="zh">' in chinese
    assert re.search(r"[一-鿿]", chinese)
    assert payload_of(chinese)["text"]["save"] == "保存标注"
    assert payload_of(chinese)["fields"][0]["label"] == "作品标题"

    # Pictures are named in the page's language, and the field column answers with the same name.
    names = payload_of(english)["image_names"]
    assert names, "the fixture offers no named picture"
    assert sorted(names.values()) == [f"Image {order}" for order in range(1, len(names) + 1)]


def test_every_word_the_page_shows_exists_in_both_languages():
    """A missing translation is a bug here rather than an English word inside a Chinese page."""
    assert set(l10n.CHROME["save"]) == set(l10n.LANGS)
    for key, values in l10n.CHROME.items():
        assert set(values) == set(l10n.LANGS), key
        assert all(value.strip() for value in values.values()), key
    for key, values in l10n.CHOOSER.items():
        assert set(values) == set(l10n.LANGS), key
    for field, values in l10n.FIELD_LABELS.items():
        assert set(values) == set(l10n.LANGS), field
    for field, values in l10n.FIELD_HINTS.items():
        assert set(values) == set(l10n.LANGS), field
    for kind, values in l10n.KIND_LABELS.items():
        assert set(values) == set(l10n.LANGS), kind
    assert set(l10n.TIPS) == set(l10n.LANGS)
    # The table is the only home for the field words: the page no longer carries its own copy.
    for field, values in l10n.FIELD_LABELS.items():
        assert l10n.field_label("zh", field, "?") == values["zh"]


def test_the_language_comes_from_the_environment_t3_sets():
    assert l10n.lang_from_env({"SITEPROBE_LANG": "en"}) == "en"
    assert l10n.lang_from_env({"SITEPROBE_LANG": "ZH"}) == "zh"
    # Anything else — unset, empty, or a language the page has no words for — is the default rather
    # than a page that cannot render.
    assert l10n.lang_from_env({}) == "zh"
    assert l10n.lang_from_env({"SITEPROBE_LANG": "fr"}) == "zh"


def test_the_page_guides_instead_of_logging(tmp_path):
    """The C specification's page changes, each answering something measured: the notes were log
    material shown as guidance; the provenance named every channel before the click; and a candidate
    with no rule cannot be learned, so offering it only invites a pick that teaches nothing.
    """
    data = payload_of(page(harvest(capture_of(PREVIEW_PAGE)), url=BASE,
                           position=(0, 3), last=False))

    # The tips sit where the notes were, and the notes themselves are not on the page.
    assert data["tips"] and "最匹配" in data["tips"][1]
    assert "notes" not in data

    # Position and last-ness travel to the page.
    assert data["position"]["text"] == "第一个网站（1/3）"
    assert data["last"] is False
    finished = payload_of(page(harvest(capture_of(PREVIEW_PAGE)), url=BASE, last=True))
    assert finished["last"] is True

    # Pictures are named by score order; the address underneath stays the value.
    images = [candidate for candidate in data["candidates"] if candidate["kind"] == "image"]
    labels = [candidate["label"] for candidate in images if candidate["label"]]
    assert labels == [f"图片{order}" for order in range(1, len(labels) + 1)]
    assert all(candidate["value"].startswith("http") for candidate in images)


def test_a_run_with_several_pages_serves_a_page_instead_of_nothing(tmp_path):
    """The page's position is a `(index, total)` tuple, and the builder has to hand over that shape.

    Measured on a three-address jable.tv run (2026-10-04): the builder passed the *formatted sentence*
    (`第一个网站（1/3）`) while the page read `position[0]`/`position[1]` off it — two characters, not a
    number — so the handler raised inside the request and closed the socket without a byte. The browser
    showed `ERR_EMPTY_RESPONSE`, every *other* route on that server answered normally (403, 404, the
    media proxy), and a one-address run was unaffected because it carries no position at all. This walks
    the three links of that chain: the builder's shape, the page's rendering, and the served document.
    """
    import urllib.request

    from build_adapter import position_for
    from src.builder.session_server import Session, start

    # 1. The builder hands over a tuple, and no position at all for a single-page run.
    assert position_for(0, 3) == (0, 3)
    assert position_for(2, 3) == (2, 3)
    assert position_for(0, 1) is None

    # 2. The page renders it in its own language.
    data = payload_of(page(harvest(capture_of(PREVIEW_PAGE)), url=BASE,
                           position=position_for(1, 3)))
    assert data["position"]["text"] == "第二个网站（2/3）"

    # 3. And the *served* document is not empty — which is what the person actually gets.
    session = Session(harvest=harvest(capture_of(PREVIEW_PAGE)), directory=tmp_path, url=BASE,
                      position=position_for(0, 3))
    httpd, url = start(session)
    try:
        with urllib.request.urlopen(url) as reply:
            served = reply.read().decode("utf-8")
    finally:
        httpd.shutdown()
        httpd.server_close()
    assert len(served) > 1000, "the page came back empty"
    assert payload_of(served)["position"]["text"] == "第一个网站（1/3）"


def test_the_page_offers_only_what_can_be_learned():
    """`has_rule` is the one gate: the page's own counts and list both come from it."""
    html = page(harvest(capture_of(PAGE)), url=BASE)
    # A candidate without a rule is not in the payload's *offer*; the row's data keeps `has_rule`
    # so the page can filter, and the test reads the same field the script reads.
    data = payload_of(html)
    for candidate in data["candidates"]:
        assert set(candidate) >= {"has_rule"}
    # At least one candidate has a rule on this fixture (the title does), so the gate is real.
    assert any(candidate["has_rule"] for candidate in data["candidates"])


def test_the_page_hands_the_images_a_url_that_actually_serves_them(tmp_path, monkeypatch):
    """The bug this replaces: the page built `/media?c=...` itself, with no token, so
    every cover was refused with a 403 and the page said nothing about why."""
    session, httpd, url = serve_for(PAGE, tmp_path)
    monkeypatch.setattr("src.builder.session_server.fetch_image",
                        lambda value, referer: (bytes([255, 216, 255, 224]) + b"jpeg", ".jpg"))
    try:
        with urllib.request.urlopen(url) as reply:
            data = payload_of(reply.read().decode("utf-8"))
        image = next(c for c in data["candidates"] if c["kind"] == "image")
        assert image["thumb"], "an image candidate carries no URL to fetch"

        with urllib.request.urlopen("http://127.0.0.1:"
                                    + url.split(":")[2].split("/")[0] + image["thumb"]) as reply:
            assert reply.status == 200
            assert reply.read().startswith(bytes([255, 216]))
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_the_save_url_in_the_page_works(tmp_path):
    """The same bug on the other endpoint: the page posted to a URL with no token."""
    session, httpd, url = serve_for(PAGE, tmp_path)
    try:
        with urllib.request.urlopen(url) as reply:
            data = payload_of(reply.read().decode("utf-8"))
        title = next(c for c in data["candidates"] if c["value"] == "Quiet Harbor")
        request = urllib.request.Request(
            "http://127.0.0.1:" + url.split(":")[2].split("/")[0] + data["save_url"],
            data=json.dumps({"url": data["url"], "mode": data["mode"],
                             "fields": {"title": title["value"]},
                             "picks": {"title": title["id"]}}).encode("utf-8"),
            headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(request) as reply:
            assert json.loads(reply.read())["ok"] is True
        assert (tmp_path / "annotations.json").is_file()
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_the_payload_carries_every_key_the_script_reads(tmp_path):
    """Two keys went missing this way: the ambiguity marker and the image URL. The
    script read them as undefined and nothing failed."""
    session, httpd, url = serve_for(PAGE, tmp_path)
    try:
        with urllib.request.urlopen(url) as reply:
            data = payload_of(reply.read().decode("utf-8"))
        for candidate in data["candidates"]:
            assert set(candidate) >= {"id", "kind", "value", "sources", "has_rule",
                                      "thumb", "ambiguous"}
        assert data["save_url"] and "token=" in data["save_url"]
        assert any(c["ambiguous"] is False for c in data["candidates"])
        # The map the field column answers with: address -> 图片N.
        assert data["image_names"]
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_a_field_answer_names_the_picture_rather_than_quoting_its_address():
    """The left column answers with 图片N, the same name the candidate list shows.

    Measured in the app on 2026-10-03: the `cover` field read
    `https://…/files/article/image/4/4525/4525s.jpg` while the list beside it said 图片1 — an
    address says nothing a person can tell apart, so "did the rule pick the picture I meant?" had
    no answer exactly where the question is asked (a later work's proposal). The names travel in
    the payload (`image_names`), which is also what keeps them from drifting away from the list's.
    """
    data = payload_of(page(harvest(capture_of(PREVIEW_PAGE)), url=BASE))
    images = [c for c in data["candidates"] if c["kind"] == "image" and c["label"]]
    assert images, "the fixture offers no named picture"

    names = data["image_names"]
    for candidate in images:
        assert names[candidate["value"]] == candidate["label"]

    # A proposal and a pick are read the same way, and an address no candidate carries is not
    # named: naming the rest would hide which one the rule actually read.
    html = page(harvest(capture_of(PREVIEW_PAGE)), url=BASE)
    assert "new Map(Object.entries(DATA.image_names" in html
    assert "answerText(field.key, values[field.key])" in html
    assert "answerText(field.key, proposal.value)" in html
    assert "names.every(Boolean)" in html


def test_switching_to_the_pictures_drops_a_query_typed_for_another_field():
    """The picture chip is the fast way to the pictures, so it must not keep the last field's query.

    The search box is where a person narrows a *text* field, and a picture's value is an address: a
    query left over from the previous field filters the pictures by it and hides the one being looked
    for. Clicking the chip clears it — the same reason a clicked picture row clears it too.
    """
    html = page(harvest(capture_of(PREVIEW_PAGE)), url=BASE)
    assert "const isPictureKind = (kind) => kind === 'image' || kind === 'images';" in html
    assert "if (isPictureKind(kind)) document.getElementById('q').value = '';" in html


def test_the_wait_after_submitting_is_a_panel_in_the_middle_of_the_screen():
    """Submitting a page is followed by several seconds of the tool capturing the next site.

    Measured in the app (2026-10-09): the sentence that carried this sat in the left column under the
    save button, so the wait read as "nothing happened" and the person clicked again. It is the page's
    headline now, in a panel over the whole screen, and a failure takes the panel back down so the
    error stays beside the button that produced it.
    """
    html = page(harvest(capture_of(PAGE)), url=BASE)
    assert 'id="veil"' in html
    assert ".veil.show { display:flex; }" in html
    assert "veil(T.submitting, '')" in html
    assert "veil(DATA.last ? T.doneHeadline : T.waitHeadline" in html
    assert "veil(null, '')" in html
    # A page submitted with nothing marked must not read "已保存：。"
    assert "T.savedNothing" in html
    # The two headlines say what to do next; the detail under them carries the field list.
    assert l10n.CHROME["waitHeadline"]["zh"] != l10n.CHROME["doneHeadline"]["zh"]
    assert "T³" in l10n.CHROME["doneHeadline"]["zh"]


def test_the_field_column_scrolls_on_its_own():
    """The save button has to be reachable without first scrolling the page's worth of candidates.

    Measured in the app on 2026-10-03 (a window 720 px tall, a field list ~1145 px): the column was
    pinned to the viewport *and* as tall as its contents, so its lower half — 保存标注 included —
    only came into view once the right-hand list had been scrolled to the bottom. It carries its own
    scrollbar now; a CSS rule is what the page can assert here, and the behaviour itself was measured
    in the browser (column scrollTop 0 → 455 with the page parked, save visible).
    """
    html = page(harvest(capture_of(PAGE)), url=BASE)
    assert "position:sticky; top:56px;" in html
    assert "max-height:calc(100vh - 70px); overflow-y:auto" in html


def test_media_is_served_by_candidate_id_so_it_cannot_fetch_arbitrary_addresses(tmp_path):
    _session, httpd, url = serve_for(PAGE, tmp_path)
    try:
        request = urllib.request.Request(
            url.replace("/?", "/media?c=cand_0001&"), method="GET")
        # cand_0001 is a text candidate, not an image, and an unknown id is refused
        # the same way: the endpoint can only serve images it harvested.
        with pytest.raises(urllib.error.HTTPError) as refusal:
            urllib.request.urlopen(request)
        assert refusal.value.code == 404
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_an_annotation_round_trips_through_its_own_json():
    annotation = Annotation(url=BASE, fields={"title": "A Work"},
                            picks={"title": "cand_0001"},
                            verdicts={"title": "ok"}, mode="confirm")

    assert Annotation.from_json(json.loads(json.dumps(annotation.to_json()))) == annotation


def test_the_three_samples_are_modes_of_one_page():
    result = harvest(capture_of(PAGE))

    assert '"mode": "annotate"' in page(result, url=BASE, mode="annotate")
    assert '"mode": "confirm"' in page(result, url=BASE, mode="confirm")


def test_every_field_declares_what_it_accepts():
    for key, kind, label in FIELDS:
        assert key and label
        assert kind in ACCEPTS


def test_a_field_that_keeps_only_some_members_says_so_on_the_page():
    """The cap is a property of the field and both sides have to know it: the page keeps
    the first three pictures and the rule reads with `limit: 3`, which is what the payload
    carries and what the field's own hint tells the person."""
    data = payload_of(page(harvest(capture_of(PREVIEW_PAGE)), url=BASE))

    assert data["limits"]["preview"] == 3
    hint = next(field["hint"] for field in data["fields"] if field["key"] == "preview")
    assert "3" in hint


def test_an_ambiguous_rule_is_recorded_but_never_proposed():
    """Measured: a candidate from `<a>` carries the selector `a`, which matches every link,
    so it reads the first one. The rule is *recorded* — Phase 5's validation is what judges
    it, and a person may still need it — but it is not what the page proposes, because a
    proposal that reads another element's value is how 登場人物 came to be filled with the
    works block."""
    result = harvest(capture_of(PAGE))
    link = next(c for c in result.candidates if c.value == "One")
    recorded = [source.rule for source in link.sources if source.rule]

    assert any(rule["matches"] > 1 for rule in recorded), "the ambiguity is recorded"
    assert rule_for(link) is None, "and it is not what a person is shown"


def test_a_unique_rule_says_it_matches_one_element():
    result = harvest(capture_of(PAGE))
    heading = next(c for c in result.candidates if c.value == "Quiet Harbor"
                   and any(s.rule and s.rule.get("text") for s in c.sources))

    assert max(source.rule["matches"] for source in heading.sources
               if source.rule and "matches" in source.rule) == 1


def test_a_value_can_be_accepted_without_a_candidate_behind_it(tmp_path):
    """Confirming a proposal needed no candidate to exist for it.

    The page used to record acceptance by finding a candidate whose value matched the
    proposal exactly; when none did, the field was left `undefined`, the buttons came
    back and the save threw. Accepting a proposal is about the *value* — the candidate
    id is only provenance for a click.
    """
    html = page(harvest(capture_of(PAGE)), url=BASE, mode="confirm",
                applied={"title": {"value": "A Value No Candidate Carries",
                                   "rule": {"from": "meta", "document": "page",
                                            "property": "og:title"}}})
    assert "A Value No Candidate Carries" in html
    # The page keeps values and picks apart, so nothing has to be looked up.
    assert "const values = {}" in html and "const picked = {}" in html
    assert "fields: values" in html
    assert "byId.get(assigned" not in html


def test_the_server_takes_a_value_with_no_pick_at_all(tmp_path):
    result = harvest(capture_of(PAGE))
    session = Session(harvest=result, directory=tmp_path, url=f"{BASE}quiet-harbor",
                      mode="confirm",
                      applied={"title": {"value": "Quiet Harbor",
                                         "rule": {"from": "meta", "document": "page",
                                                  "property": "og:title"}}})
    httpd, url = start(session)
    try:
        request = urllib.request.Request(
            url.replace("/?", "/api/annotations?"),
            data=json.dumps({"url": BASE, "mode": "confirm",
                             "fields": {"title": "Quiet Harbor"},
                             "picks": {}, "absent": []}).encode("utf-8"),
            headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(request) as reply:
            assert json.loads(reply.read())["ok"] is True
        document = json.loads((tmp_path / "annotations.json").read_text(encoding="utf-8"))
        # The rule came from what was applied, so a confirmed field keeps it.
        assert document["hypotheses"]["title"]["rule"]["property"] == "og:title"
    finally:
        httpd.shutdown()
        httpd.server_close()


# --- a collection is its members, and nothing in between --------------------- #

SIBLING_LISTS = """<!doctype html><html><body>
  <h2 id="artists"><ul class="comma-list">
    <li><a href="/artist/a">cloth tsugutoshi</a></li></ul></h2>
  <table><tr><td>Series</td><td id="series"><ul class="comma-list">
    <li><a href="/series/b">boku no kokoro</a></li>
    <li><a href="/series/c">meitantei precure</a></li>
    <li><a href="/series/d">bang dream</a></li></ul></td></tr></table>
</body></html>"""


def test_an_ancestor_id_names_a_list_a_repeated_class_cannot():
    """Measured on a real gallery: three lists — artists, group, series — were each
    `ul.comma-list` and nothing else, so all three collapsed into one selector that
    matched three elements and read the first. Each list's identity was one level up and
    unique, and a class the page repeats is not an identity however close it sits.
    """
    root = parse_html(SIBLING_LISTS)

    assert element_selector(select_one(root, "#series li")) == "#series li"
    assert element_selector(select_one(root, "#artists li")) == "#artists li"


def test_an_id_minted_for_one_page_is_not_an_identity():
    """`#post-12345` names this page's post and nothing on the next page, so the class
    beside it is the better name — which is also what this returned before the id
    preference above existed, so nothing regresses when an id is page-specific."""
    root = parse_html('<div id="post-12345" class="article"><p>Body text</p></div>')

    assert element_selector(select_one(root, "p")) == "div.article p"


def test_two_lists_sharing_a_class_become_two_collections():
    """Which is what the fix above is for: one selector over both lists read the artist
    as the series, and the series could not be learned because of it."""
    result = harvest(capture_of(SIBLING_LISTS))
    selectors = {candidate.context["selector"] for candidate in result.by_kind("collection")}

    assert "#series li" in selectors
    assert "ul.comma-list li" not in selectors


def test_a_collection_candidate_carries_every_member():
    """Choosing a collection is what records the value, so a candidate holding five of a
    work's sixteen tags records five — and the rule that read all sixteen then disagreed
    with the annotation it came from and was pruned as if the rule were the wrong half.
    """
    html = """<!doctype html><html><body><div class="tags">
      <a>One</a><a>Two</a><a>Three</a><a>Four</a><a>Five</a><a>Six</a>
    </div></body></html>"""
    result = harvest(capture_of(html))
    tags = next(c for c in result.by_kind("collection") if c.context["selector"] == "div.tags a")

    assert tags.value == "One / Two / Three / Four / Five / Six"
    assert tags.context["members"] == ["One", "Two", "Three", "Four", "Five", "Six"]


def test_a_named_group_of_two_is_a_collection_and_an_anonymous_one_is_not():
    """Measured on a real gallery: a work with two characters, and a set page carrying
    two series, each offered only as two unrelated candidates — so marking either one
    recorded one value where the page had two. Picking a field is not the moment to ask
    a person to invent a rule; the group has to be on the list.
    """
    html = ('<html><body>'
            '<div id="pair"><a href="/1">One</a><a href="/2">Two</a></div>'
            '<div class="twins"><a href="/3">Three</a><a href="/4">Four</a></div>'
            '</body></html>')
    result = harvest(capture_of(html))
    selectors = {candidate.context["selector"] for candidate in result.by_kind("collection")}

    assert "#pair a" in selectors
    assert "div.twins a" not in selectors


def test_an_element_that_declares_what_it_is_is_named_by_that():
    """Measured on a real album: the author sat in `<span data-type="author">` while every
    rule its value carried named a class that seventy buttons shared, so the annotation
    recorded the author and the rule read `×` — and every following work was proposed `×`.
    """
    html = ('<html><body><div id="page">'
            '<span itemprop="author" data-type="works">'
            '<a class="btn btn-sm" href="/s?q=w">作品名</a></span>'
            '<span itemprop="author" data-type="author">'
            '<a class="btn btn-sm" href="/s?q=a">作者名</a></span>'
            '</div></body></html>')
    result = harvest(capture_of(html))
    author = next(c for c in result.candidates if c.value == "作者名")
    # The rules that would read one value, which is what a scalar field can use. The block
    # also offers itself as a group (`list`), which is how a field with several values is
    # marked — junk groups are candidates too, and the samples are what discard them.
    scalar = {source.rule["select"] for source in author.sources
              if source.rule and not source.rule.get("list")}

    # `itemprop="author"` is on the works block too, and on this page that variant reads
    # 作品名 — so it is rejected for the same reason it was rejected on the real album:
    # not because it matches more elements, but because it reads a different value.
    assert 'span[data-type="author"] a' in scalar
    assert 'span[itemprop="author"] a' not in scalar


def test_a_cover_inside_a_named_block_beats_a_shared_declaration():
    """The same fix, reached from the same measurement: `itemprop="image"` sits on every
    image on that page while the block holding the cover names it alone."""
    html = ('<html><body><div id="album_photo_cover">'
            '<img itemprop="image" src="/media/albums/1472965.jpg"></div>'
            '<img itemprop="image" src="/static/resources/images/logo.png"></body></html>')
    result = harvest(capture_of(html))
    cover = next(c for c in result.by_kind("image") if "1472965" in c.value)
    selectors = {source.rule["select"] for source in cover.sources if source.rule}

    assert "#album_photo_cover img" in selectors


def test_a_collection_is_recorded_as_the_list_it_is(tmp_path):
    """Not as the Python repr of a list. The repr came from a proposal the page
    stringified on its way back, and the rule that read the same tags into a list was
    then reported as disagreeing with the value a person had just accepted."""
    result = harvest(capture_of(PAGE))
    session = Session(harvest=result, directory=tmp_path, url=f"{BASE}quiet-harbor",
                      mode="confirm",
                      applied={"tags": {"value": ["One", "Two", "Three"],
                                        "rule": {"from": "html", "document": "page",
                                                 "select": "div.tags a", "text": True,
                                                 "list": True}}})
    httpd, url = start(session)
    try:
        request = urllib.request.Request(
            url.replace("/?", "/api/annotations?"),
            data=json.dumps({"url": BASE, "mode": "confirm",
                             "fields": {"tags": ["One", "Two", "Three"]},
                             "picks": {}, "absent": []}).encode("utf-8"),
            headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(request) as reply:
            assert json.loads(reply.read())["ok"] is True
        document = json.loads((tmp_path / "annotations.json").read_text(encoding="utf-8"))

        assert document["fields"]["tags"] == ["One", "Two", "Three"]
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_the_page_shows_a_whole_value_and_says_how_many_it_hid():
    """The two ways the page misled: a candidate's value cut at 300 characters, and a
    list cut at 400 rows with no word about the rest."""
    html = page(harvest(capture_of(PAGE)), url=f"{BASE}quiet-harbor")

    assert "slice(0, 300)" not in html and "slice(0, 160)" not in html
    assert "只列出前" in html
