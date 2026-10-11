"""Unit tests for the generic layer, with no network and no site tool.

The heavy verification lives in `verify_against_recordings.py`, which replays the
sites' real recorded pages. These tests pin the behaviour that verification would
only catch indirectly: the selector vocabulary, the canonical record's shape, the
registry's fail-closed target resolution, and the cursor the T³ side consumes.

Run:  .venv/Scripts/python.exe -m pytest -q
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
# An adapter is data in the SiteProbe home now, not a directory beside the tool: the contract
# tests read them from where the runtime finds them.
from src.builder import paths  # noqa: E402

_INSTALLED = paths.home() / "installed"
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic import export_layout, taxonomy  # noqa: E402
from src.generic.bundle import RawBundle, RawItem  # noqa: E402
from src.generic.document import Document, DocumentBag  # noqa: E402
from src.generic.extract import extract_work  # noqa: E402
from src.generic.htmltree import parse_html, select_all, select_one  # noqa: E402
from src.generic.registry import (
    RegistryError,
    discover,
    resolve_input,
)  # noqa: E402
from src.generic.select import SelectorError, resolve  # noqa: E402
from src.generic.template import load_template  # noqa: E402


# --- the CSS subset ------------------------------------------------------- #

HTML = """
<html><body>
  <div class="wrap">
    <div class="card" id="c1"><h4 class="t"><a href="/w/1?v=11">One</a></h4>
      <img class="thumb" src="a.jpg"><div class="who">Ann</div></div>
    <div class="card" id="c2"><h4 class="t"><a href="/w/2?v=22">Two</a></h4>
      <img class="thumb" data-src="b.jpg"><div class="who">Bob</div></div>
  </div>
  <a rel="next prev" href="/p/2">more</a>
  <div id="favorites_album_9">nine</div>
</body></html>
"""


def test_class_id_and_descendant_selectors():
    root = parse_html(HTML)
    assert len(select_all(root, "div.card")) == 2
    assert select_one(root, "#c2 .who").text() == "Bob"
    assert select_one(root, "div.wrap div.card h4.t a").text() == "One"


def test_attribute_presence_equality_word_and_substring():
    root = parse_html(HTML)
    assert len(select_all(root, "img[data-src]")) == 1
    assert select_all(root, 'a[rel~="next"]')[0].attr("href") == "/p/2"
    assert len(select_all(root, "img[src*='a.jpg']")) == 1
    assert len(select_all(root, "div[id^='favorites_album_']")) == 1


def test_selector_list_is_a_union_in_document_order():
    root = parse_html(HTML)
    # A union comes back in document order, not grouped by alternative.
    found = select_all(root, "div.who, h4.t")
    assert [element.text() for element in found] == ["One", "Ann", "Two", "Bob"]


def test_malformed_markup_degrades_instead_of_raising():
    root = parse_html("<div><p>unclosed<span>x</div><img src='y.png'>")
    assert select_one(root, "img").attr("src") == "y.png"
    assert "unclosed" in parse_html("<div><p>unclosed").text()


# --- selectors ------------------------------------------------------------ #

def bag(**documents) -> DocumentBag:
    result = DocumentBag()
    for name, (text, fmt) in documents.items():
        result.add(Document(name=name, text=text, format=fmt))
    return result


def test_json_and_json_list_with_a_where_clause():
    data = json.dumps({"tags": [
        {"tag": "anal", "male": ""},
        {"tag": "sole male", "male": 1},
    ]})
    b = bag(galleryinfo=(data, "json"))
    assert resolve({"from": "json", "path": "tags[0].tag"}, b) == "anal"
    assert resolve({"from": "json_length", "path": "tags"}, b) == 2
    assert resolve({
        "from": "json_list", "path": "tags", "take": "tag",
        "where": {"field": "male", "is_falsy": True},
    }, b) == ["anal"]


def test_js_wrapped_json_document():
    document = Document(name="g", text="var galleryinfo = {\"id\": 7};",
                        format="js", json_wrapper=r"var\s+galleryinfo\s*=\s*(\{.*\})\s*;?")
    b = DocumentBag()
    b.add(document)
    assert resolve({"from": "json", "path": "id"}, b) == 7


def test_a_json_value_carries_the_pages_entities_the_way_the_candidate_does():
    """The rule and the candidate it was learned from have to read the same string.

    Measured on agedm.io (2026-10-09): the cover was answered from a JSON-LD `image`, the harvest
    offered the candidate as `…app=2001&n=0&…`, and the rule read it back as `…app=2001&amp;n=0&…`.
    The confirm page then quoted a raw address where the list beside it said 图片1 — and the same
    picture would have been recorded under two spellings. A `<script>` block is never decoded by
    the parser, so the JSON channels decode it here; the markup channels must not be touched
    (decoding those a second time turns `?w=1&copy=2` into `?w=1©=2`).
    """
    data = json.dumps({"image": "https://cdn.test/c.jpg?a=1&amp;b=2"})
    b = bag(jsonld=(data, "json"))
    assert resolve({"from": "json", "document": "jsonld", "path": "image"}, b) \
        == "https://cdn.test/c.jpg?a=1&b=2"

    members = json.dumps({"tags": [{"tag": "a&amp;b"}, {"tag": "plain"}]})
    b = bag(tags=(members, "json"))
    assert resolve({"from": "json_list", "path": "tags", "take": "tag"}, b) == ["a&b", "plain"]

    # The markup side is decoded by the parser, once, and the runtime must not decode it again:
    # `&amp;amp;` reaches the attribute as `&amp;` and stays that way — a second pass would make it
    # `&`, which is how a `?w=1&copy=2` address became `?w=1©=2` in this project once already.
    b = bag(page=('<img src="https://cdn.test/c.jpg?a=1&amp;b=2">'
                  '<a href="https://cdn.test/p?x=1&amp;amp;y=2">x</a>', "html"))
    assert resolve({"from": "html", "document": "page", "select": "img", "attr": "src"}, b) \
        == "https://cdn.test/c.jpg?a=1&b=2"
    assert resolve({"from": "html", "document": "page", "select": "a", "attr": "href"}, b) \
        == "https://cdn.test/p?x=1&amp;y=2"


def test_selector_official_failures_are_loud():
    b = bag(page=("<p>x</p>", "html"))
    with pytest.raises(SelectorError):
        resolve({"from": "json", "path": "x"}, b)
    with pytest.raises(KeyError):
        resolve({"from": "html", "document": "absent", "select": "p"}, b)


def test_fallbacks_try_in_order():
    b = bag(page=("<div class='other'>text</div>", "html"))
    value = resolve({
        "from": "html", "document": "page", "select": "h1", "text": True,
        "fallback": [{"from": "html", "document": "page", "select": "div.other", "text": True}],
    }, b)
    assert value == "text"


def test_map_lookup_and_ordering():
    b = bag(page=("<i>x</i>", "html"))
    mapped = resolve({"from": "const", "value": "artistcg",
                      "map": {"artistcg": "Artist Cg"}}, b)
    assert mapped == "Artist Cg"
    promoted = resolve({
        "from": "json_list", "path": "a", "promote_first": "{primary}",
    }, bag(**{"data.json": (json.dumps({"a": ["Beta", "Alp", "Gamma"]}), "json")}))
    assert promoted == ["Beta", "Alp", "Gamma"]
    promoted2 = resolve({
        "from": "json_list", "path": "a", "promote_first": "{primary}",
    }, bag(**{"data.json": (json.dumps({"a": ["Beta", "Gamma"]}), "json")}),
        context={"primary": "alp"})
    assert promoted2 == ["alp", "Beta", "Gamma"]


def test_every_candidate_attribute_is_collected_for_filtering():
    root = parse_html("<img src='blank.gif' data-src='/media/photos/7/00016.webp'>")
    element = select_one(root, "img")
    from src.generic.select import _element_values
    assert _element_values(element, {"attr": ["data-src", "src"]}) == [
        "/media/photos/7/00016.webp", "blank.gif",
    ]


def test_a_rule_survives_the_attribute_a_script_moved():
    """A rule is learned from the *rendered* page and a crawl reads the *served* one.

    Bootstrap's tooltip copies `title` into `data-original-title` and blanks the original, and
    lazy-loaders move `src` into `data-src` — so a rule that names the rendered spelling has to still
    find the served one. Measured on jable.tv (2026-10-05): the author was marked successfully during
    the build and then absent from the import, because the served `<span>` carries
    `title="早坂奏音"` while the captured one carries `title="" data-original-title="早坂奏音"`, and the
    learned rule read `data-original-title` — nothing, on the page the crawler fetched.
    """
    from src.generic.select import _element_values

    served = select_one(parse_html(
        '<span class="placeholder rounded-circle" data-toggle="tooltip" title="早坂奏音"></span>'),
        "span")
    rendered = select_one(parse_html(
        '<span class="placeholder rounded-circle" data-toggle="tooltip" title="" '
        'data-original-title="早坂奏音"></span>'), "span")

    # The rule as learned (from the rendered page) reads the value on the served page too.
    assert _element_values(served, {"attr": "data-original-title"}) == ["早坂奏音"]
    # And the rule's own spelling still wins where both exist, so a page that means two different
    # things by them is not silently swapped.
    assert _element_values(rendered, {"attr": "data-original-title"})[0] == "早坂奏音"
    both = select_one(parse_html('<img title="shown" data-original-title="kept">'), "img")
    assert _element_values(both, {"attr": "data-original-title"})[0] == "kept"

    # The lazy-image pair is the same shape, in both directions.
    lazy = select_one(parse_html("<img data-src='/real.webp'>"), "img")
    assert _element_values(lazy, {"attr": "src"}) == ["/real.webp"]


# --- the registry: adding a site is a folder ------------------------------ #

def test_every_installed_site_is_discovered_from_disk():
    """The sites a person wrote — the adapters in the SiteProbe home.

    Scoped to that root on purpose: the Builder's generated adapters live in their own
    root and are discovered too (so `probe.py` can run one), but they are not what
    this assertion is about — and a generated adapter does not yet satisfy the whole
    site contract the other tests here check.
    """
    keys = {template.key for template in discover(paths.home() / "installed")}
    assert keys == {"hitomi.la", "hanime1.me", "18comic.vip"}


def test_a_url_is_matched_to_its_site_and_kind():
    template, kind, ref = resolve_input("https://hanime1.me/playlist?list=535566")
    assert (template.key, kind, ref["id"]) == ("hanime1.me", "playlist", "535566")
    template, kind, ref = resolve_input("https://18comic.vip/album/122916/?series_sort=2")
    assert (template.key, kind, ref["id"]) == ("18comic.vip", "album", "122916")


def test_a_bare_keyword_is_ambiguous_across_searches():
    """More than one site accepts a keyword, so guessing would be wrong.

    A bare word can be an artist on one site and a search on another, and picking
    one silently is exactly the failure the tool exists to avoid. The error names
    the candidates so the user can choose with --site.
    """
    with pytest.raises(RegistryError) as refusal:
        resolve_input("kakao")
    assert "ambiguous" in str(refusal.value)
    assert "hitomi.la:artist" in str(refusal.value)

    template, kind, ref = resolve_input(
        "https://18comic.vip/search/photos?main_tag=0&search_query=kakao"
    )
    assert (template.key, kind) == ("18comic.vip", "search")
    assert ref["id"] == "kakao"


def test_an_unclaimed_url_is_refused_rather_than_guessed():
    with pytest.raises(RegistryError):
        resolve_input("https://example.invalid/artist/x")


def test_a_malformed_site_json_is_rejected(tmp_path):
    # No key/tool: the template cannot be identified, so installation fails loudly.
    (tmp_path / "site.json").write_text(json.dumps({"display_name": "x"}), encoding="utf-8")
    with pytest.raises(Exception):
        load_template(tmp_path / "site.json")

    # A site with no declared manifest shape cannot write an importable export.
    (tmp_path / "site.json").write_text(json.dumps({"key": "x", "tool": "x"}), encoding="utf-8")
    with pytest.raises(Exception):
        from src.generic.registry import ensure_site_manifest
        ensure_site_manifest(load_template(tmp_path / "site.json"))


# --- the canonical record ------------------------------------------------- #

HITOMI_PAYLOAD = json.dumps({
    "id": 7, "title": "A title", "galleryurl": "/doujinshi/a-7.html",
    "date": "2017-01-28 16:47:00-06", "language": "chinese", "language_localname": "中文",
    "type": "imageset",
    "tags": [{"tag": "anal", "male": ""}, {"tag": "sole male", "male": 1}],
    "artists": [{"artist": "alp"}], "parodys": [{"parody": "x"}],
    "characters": [{"character": "rin"}],
    "files": [{"name": "01.jpg", "hash": "abc"}, {"name": "02.jpg", "hash": "def"}],
})
# The real payload arrives as JavaScript wrapping a JSON literal, which is what
# the template's `json_wrapper` declares.
HITOMI_JSON = f"var galleryinfo = {HITOMI_PAYLOAD};"


def hitomi_record(**card):
    template = load_template(
        _INSTALLED / "hitomi_la" / "site.json"
    )
    item = RawItem(source_id="7", target_url="https://hitomi.la/galleries/7.html")
    item.add("galleryinfo", HITOMI_JSON)
    item.card.update(card)
    return extract_work(template, item)


def test_the_record_matches_the_importer_contract():
    record = hitomi_record()
    assert record["source_site"] == "hitomi.la"
    assert record["title"] == "A title"
    # A site-relative gallery path is resolved against the declared origin.
    assert record["detail_url"] == "https://hitomi.la/doujinshi/a-7.html"
    # The raw `2017-01-28 16:47:00-06` becomes the one shape the cursor uses.
    assert record["date_added"] == "2017-01-28"
    assert record["page_count"] == 2
    assert record["language"] == {"code": "chinese", "name": "中文"}
    assert set(record["分类信息"]) == {"作品", "登场人物", "分类标签", "作者", "作品类型"}
    assert record["分类信息"]["作品类型"] == ["Image Set"]
    assert record["分类信息"]["分类标签"] == ["Anal"]
    assert record["分类信息"]["登场人物"] == ["Rin"]


def test_the_crawled_author_leads_even_when_the_payload_names_none():
    assert hitomi_record(primary_artist="alp")["分类信息"]["作者"] == ["Alp"]
    assert hitomi_record(primary_artist="someone else")["分类信息"]["作者"] == [
        "Someone Else", "Alp",
    ]


def test_media_entries_carry_no_null_paths():
    # Cover and preview URLs are computed by the fetcher from gg.js and handed to
    # the template as card fields, so they are supplied here the same way.
    record = hitomi_record(cover_url="https://w1.example/1/abc.webp",
                           preview_urls=["https://w1.example/2/def.webp"])
    # The T³ importer declares local_path as an optional string, so `null` there
    # is rejected outright; the key must simply be absent until a file exists.
    assert "local_path" not in (record["cover"] or {})
    for preview in record["preview_images"]:
        assert "local_path" not in preview
    # An already-absolute URL is kept as-is; a site-relative one is resolved
    # against the origin the template declares.
    assert record["cover"]["url"] == "https://w1.example/1/abc.webp"
    assert hitomi_record(cover_url="/media/cover.webp")["cover"]["url"] == (
        "https://hitomi.la/media/cover.webp"
    )


def test_diagnostics_name_what_was_not_found():
    template = load_template(_INSTALLED / "hitomi_la" / "site.json")
    item = RawItem(source_id="1", target_url="https://hitomi.la/galleries/1.html")
    item.add("galleryinfo", json.dumps({"id": 1, "title": "t"}))
    record = extract_work(template, item)
    assert record["diagnostics"]["unresolved"]
    assert any("no author" in warning for warning in record["diagnostics"]["warnings"])


# --- the cursor the T³ side consumes ------------------------------------- #

def test_origin_is_built_from_the_listing_and_its_kind_is_translated():
    bundle = RawBundle(template_key="hanime1.me", target_kind="playlist",
                       target_ref="535566", target_url="https://hanime1.me/playlist?list=535566",
                       display_name="A playlist")
    assert bundle.origin() == {
        "kind": "folder", "ref": "535566", "display_name": "A playlist",
        "url": "https://hanime1.me/playlist?list=535566",
    }
    # An artist listing keeps its own kind, which the library understands.
    artist = RawBundle(template_key="hitomi.la", target_kind="artist", target_ref="alp")
    assert artist.origin() == {"kind": "artist", "ref": "alp"}


# --- the export layout ---------------------------------------------------- #

def test_every_writer_survives_a_momentary_lock_and_the_sidecars_never_kill_a_crawl(tmp_path):
    """The same class of defect, checked at each place the runtime writes.

    Measured on this machine twice: `os.replace` onto a target another process holds returns
    `WinError 5`, which took down a finished crawl on the tag dictionary and would have cost a whole
    work's data on the record path. So the classification is explicit here — the *deliverables*
    (records, manifests, review pages) retry and then fail loudly; the *sidecars* (the tag dictionary,
    the crawl cursor) retry and then only warn; stale media that cannot be deleted is pruned next time.
    """
    import os

    from src.generic import crawl_state, export_layout, media, review

    # Deliverables: the shared writers retry the rename.
    target = tmp_path / "record.json"
    attempts = {"count": 0}
    real_replace = os.replace

    def flaky(source, destination):
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise PermissionError(5, "Access is denied")
        return real_replace(source, destination)

    os.replace = flaky
    try:
        export_layout.write_json(target, {"title": "a work"})
    finally:
        os.replace = real_replace
    assert attempts["count"] == 3 and target.is_file()

    # The review page and its cards go through the same writer.
    assert "export_layout.write_text" in Path(review.__file__).read_text(encoding="utf-8")

    # A sidecar: the cursor never raises, whatever the filesystem says.
    original_save = crawl_state.save
    crawl_state.save = lambda site_root, listings: (_ for _ in ()).throw(
        PermissionError(5, "Access is denied"))
    try:
        state = crawl_state.record(tmp_path, kind="work", ref="1", local_ids=["1"], seen=[])
    finally:
        crawl_state.save = original_save
    assert state.source_ref == "1", "the in-memory update still happens"

    # Stale media that cannot be deleted is left for the next run, and the rest is still pruned.
    item = tmp_path / "items" / "7"
    (item / "previews").mkdir(parents=True)
    (item / "previews" / "old.webp").write_text("stale", encoding="utf-8")
    (item / "previews" / "keep.webp").write_text("kept", encoding="utf-8")
    os.chmod(item / "previews" / "old.webp", 0o444)
    try:
        removed = media.prune_unreferenced(item, {"preview_images": [{"local_path": "items/7/previews/keep.webp"}]})
    finally:
        os.chmod(item / "previews" / "old.webp", 0o666)
    assert removed == 0, "a file Windows will not let go of is pruned by the next run"
    assert (item / "previews" / "keep.webp").is_file()
    assert (item / "previews" / "old.webp").is_file()


def test_a_dictionary_write_survives_a_momentary_lock_and_never_kills_a_crawl(tmp_path):
    """Measured on a real run: Windows refused the replace with `WinError 5` because another process
    held the dictionary for an instant, and a finished crawl was reported as a crash — with its
    export, records and media already on disk. The replace is retried, and a dictionary that still
    cannot be written is a warning: it is an *index* of the records, derived from them.
    """
    from src.generic import taxonomy
    from src.generic.runner import _refresh_dictionary

    target = tmp_path / "taxonomy_dictionary.json"
    attempts = {"count": 0}
    real_replace = os.replace

    def flaky_replace(source, destination):
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise PermissionError(5, "Access is denied")
        return real_replace(source, destination)

    os.replace = flaky_replace
    try:
        # A JSON document and a newline, spelled without an escape this file's writer keeps mangling.
        taxonomy._atomic_text(target, json.dumps({}) + chr(10))
    finally:
        os.replace = real_replace
    assert attempts["count"] == 3, "the replace has to be retried"
    assert target.is_file()

    # And when it truly cannot be written: a note, not an exception.
    def refuse(group_root, records):
        raise PermissionError(5, "Access is denied")

    original = taxonomy.refresh_review
    taxonomy.refresh_review = refuse
    messages: list[str] = []
    try:
        notes = _refresh_dictionary(tmp_path, [], messages.append)
    finally:
        taxonomy.refresh_review = original

    assert notes and "could not be written" in notes[0]
    assert messages == [f"warning: {notes[0]}"]


def test_manifests_take_the_shape_each_site_declares():
    hitomi = load_template(_INSTALLED / "hitomi_la" / "site.json")
    hanime = load_template(_INSTALLED / "hanime1_me" / "site.json")
    records = [{"source_id": "1", "title": "a"}, {"source_id": "2", "title": "b"}]

    id_list = export_layout.build_manifest(hitomi, records, name="artist_alp",
                                           url="https://hitomi.la/x", origin=None)
    assert id_list["items"] == ["1", "2"]

    embedded = export_layout.build_manifest(hanime, records, name="playlist_9",
                                            url="https://hanime1.me/p", origin=None)
    assert embedded["items"] == records
    assert embedded["playlist_id"] == "playlist_9"


def test_listing_names_are_sanitized_per_component():
    template = load_template(_INSTALLED / "comic18" / "site.json")
    path = export_layout.listing_dir(Path("."), template, "single/1229:16")
    assert path.parts[-2:] == ("single", "1229_16")


# --- the tag review ------------------------------------------------------- #

def test_review_decisions_move_tags_between_accepted_and_rejected(tmp_path):
    (tmp_path / "taxonomy_dictionary.json").write_text(json.dumps({
        "series": {}, "authors": {}, "characters": {}, "types": {},
        "tags": {"accepted": {"老標籤": "老标签"}, "rejected": ["屏蔽的"]},
    }, ensure_ascii=False), encoding="utf-8")
    taxonomy.write_review(tmp_path, [
        {"tag": "新標籤", "decision": "保留", "zh_cn": ""},
        {"tag": "討厭的", "decision": "屏蔽", "zh_cn": ""},
    ])
    taxonomy.apply_decisions(tmp_path)
    policy = taxonomy.load_tag_policy(tmp_path)

    assert policy["accepted"]["新標籤"] == "新标签"      # OpenCC t2s fills the blank
    assert "討厭的" in policy["rejected"]
    assert "討厭的" not in policy["accepted"]


def test_a_pending_tag_is_kept_but_never_accepted(tmp_path):
    (tmp_path / "taxonomy_dictionary.json").write_text(json.dumps({
        "series": {}, "authors": {}, "characters": {}, "types": {},
        "tags": {"accepted": {}, "rejected": ["屏蔽的"]},
    }, ensure_ascii=False), encoding="utf-8")
    policy = taxonomy.load_tag_policy(tmp_path)
    record = {
        "source_id": "1", "title": "t",
        "source_tags_raw": ["屏蔽的", "待審"],
        "分类信息": {"作品": [], "登场人物": [], "分类标签": ["屏蔽的", "待審"],
                    "作者": [], "作品类型": []},
    }
    filtered = taxonomy.apply_policy_to_record(record, policy)
    assert filtered["分类信息"]["分类标签"] == ["待審"]
    assert filtered["source_tags_raw"] == ["待審"]
    assert filtered["tags"] == []


def test_an_unknown_decision_is_refused(tmp_path):
    (tmp_path / "taxonomy_dictionary.json").write_text(
        json.dumps({"tags": {"accepted": {}, "rejected": []}}), encoding="utf-8")
    taxonomy.write_review(tmp_path, [{"tag": "x", "decision": "maybe", "zh_cn": ""}])
    with pytest.raises(ValueError):
        taxonomy.apply_decisions(tmp_path)
