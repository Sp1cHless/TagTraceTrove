"""The JSON contract T³ drives (`integration.py`): what it answers, and how it says no.

This is the only surface a program uses, so it is pinned here rather than left to the prose CLIs'
output. Three things are load-bearing and each was a decision, not an accident:

* **A miss is an answer.** `resolve` on a URL no site claims is `matched: false` with a reason and
  exit 2 — not an exception, because the caller is asking a question ("is there a tool for this?")
  and "no" is a normal answer;
* **Every failure carries a code.** The code comes from the raise site (`RegistryError.code`), never
  from matching the message text, so rewording a sentence cannot change what a caller branches on;
* **stdout is only JSON lines.** A human sentence that leaks into stdout breaks every caller, so the
  runner's prose is re-emitted as a `progress` event and the tests read the stream back.

The run/selection half is exercised with the runner stubbed: the point here is the contract's shape
and the exit codes, and a real crawl needs a network. What a real run produces is checked by the
door sweep (`验收.bat`) and, offline, by `verify_against_recordings.py`.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic import integration  # noqa: E402
from src.generic.integration import (  # noqa: E402
    main, resolve_event, selection_events, sites_event,
)
from src.generic.registry import RegistryError  # noqa: E402
from src.generic.runner import RunResult  # noqa: E402

INTERPRETER = PROJECT_ROOT / ".venv" / "Scripts" / "python.exe"


def run_events_stubbed(fake_run, tmp_path, *, review=False):
    """Emit `run_events`' output with the runner replaced, so the contract can be read back."""
    import src.generic.integration as module

    collected: list[dict] = []
    original = module.run_once
    module.run_once = fake_run
    try:
        module.run_events("anything", review=review, project_root=tmp_path,
                          emit=collected.append)
    finally:
        module.run_once = original
    return collected


# --- sites: the menu T³ builds -------------------------------------------------------------

def test_sites_reports_every_site_with_a_usable_menu():
    event = sites_event()
    assert event["event"] == "sites"
    assert Path(event["home"]).is_dir(), "the tool must name the home it is reading"
    sites = {site["key"]: site for site in event["sites"]}
    assert {"18comic.vip", "hitomi.la", "hanime1.me"} <= set(sites)
    for site in sites.values():
        assert site["targets"], f"{site['key']} declares no target"
        for target in site["targets"]:
            assert {"kind", "label", "single", "accepts_name", "source"} <= set(target)
    album = [t for t in sites["18comic.vip"]["targets"] if t["kind"] == "album"]
    assert album and album[0]["single"] is True, "a single-work target must say so"


def _two_files_for_one_key(home: Path, shell_search_pattern: str) -> None:
    """A rule set learned for one listing, beside the written adapter for the same site.

    The learned file declares a search and no work fields; the written one reads albums, favorites
    and searches. Written here rather than taken from the machine's own home: what these tests pin is
    the union and who each target names, and a test that read the user's disk would change meaning
    the day they install or retire an adapter.

    The learned pattern is an argument because that is what decides whether it can answer anything: a
    pattern with no capturing group matches no address at all, which is what the Builder wrote for the
    three shells that have since been retired.
    """
    shell = home / "local" / "demo_vip"
    shell.mkdir(parents=True)
    (shell / "site.json").write_text(json.dumps({
        "schema_version": 1, "key": "demo.test", "display_name": "demo.test", "tool": "demo_vip",
        "hosts": ["demo.test"],
        "targets": {"search": {"label": "搜索", "single": False,
                               "url_pattern": shell_search_pattern}},
        "listings": {"search": {"document": "listing_html",
                                "row_selector": "div.card",
                                "fields": {"source_id": {"from": "html", "document": "listing_html",
                                                         "select": "a", "attr": "href"}}}},
    }), encoding="utf-8")

    written = home / "installed" / "demo"
    written.mkdir(parents=True)
    (written / "site.json").write_text(json.dumps({
        "schema_version": 1, "key": "demo.test", "display_name": "Demo", "tool": "demo",
        "source_site": "demo.test", "export_group": "demo_test", "media_id_prefix": "demo",
        "hosts": ["demo.test"],
        "targets": {
            "album": {"label": "Album", "single": True, "id_group": "id",
                      "url_pattern": r"^https?://demo\.test/album/(?P<id>\d+)"},
            "favorite": {"label": "Favorites", "single": False, "id_group": "id",
                         "url_pattern": r"^https?://demo\.test/user/(?P<id>[^/]+)/favorite"},
            "search": {"label": "Search", "single": False, "id_group": "id", "accepts_name": True,
                       "url_pattern": r"^https?://demo\.test/search\?q=(?P<id>[^&]+)"},
        },
        "documents": {"work": {"page": {"format": "html"}}},
        "work": {"fields": {"title": {"from": "html", "select": "h1"}}},
    }), encoding="utf-8")


def test_sites_unions_the_targets_of_a_domain_with_two_adapters(tmp_path, monkeypatch):
    """The learned file reads searches, the written one reads albums and favorites.

    A menu built from one file alone hides capabilities that work — measured before the union
    existed: `--list-sites` showed `18comic.vip` as search-only. And each target names the layer that
    *answers* it: the learned file declares a search and can never claim a search address, because its
    pattern captures no id, so the written adapter is the one named here.
    """
    _two_files_for_one_key(tmp_path / "home", r"^https?://demo\.test/search")
    monkeypatch.setenv("SITEPROBE_HOME", str(tmp_path / "home"))

    from src.generic import registry

    registry.forget_adapters()
    try:
        comic = {site["key"]: site for site in sites_event()["sites"]}["demo.test"]
        kinds = {target["kind"] for target in comic["targets"]}
        assert kinds == {"album", "favorite", "search"}
        assert {adapter["source"] for adapter in comic["adapters"]} == {"installed", "local"}
        sources = {target["kind"]: target["source"] for target in comic["targets"]}
        assert sources["album"] == "installed", "only the written adapter reads albums"
        assert sources["search"] == "installed", (
            "the learned file's pattern captures no id, so it can never claim a search address")
        search = [target for target in comic["targets"] if target["kind"] == "search"][0]
        assert search["accepts_name"] is True, (
            "accepting a name is the union: the other file turns a keyword into its search URL")
    finally:
        registry.forget_adapters()


def test_a_target_names_the_layer_that_answers_it_not_the_first_that_declares_it(tmp_path, monkeypatch):
    """A target that cannot claim an address is not the one that answers it.

    Measured on a real search address while the learned shells were on disk: the menu named
    `local/18comic_vip` while both doors handed every 18comic address to `installed/comic18`.
    """
    home = tmp_path / "home"
    _two_files_for_one_key(home, r"^https?://demo\.test/search")
    monkeypatch.setenv("SITEPROBE_HOME", str(home))

    from src.generic import registry

    registry.forget_adapters()
    try:
        comic = {site["key"]: site for site in sites_event()["sites"]}["demo.test"]
        sources = {target["kind"]: target["source"] for target in comic["targets"]}
        assert sources["search"] == "installed", "the layer that can claim it is the one named"
    finally:
        registry.forget_adapters()


def test_the_layer_decides_when_two_files_can_both_answer_one_kind(tmp_path, monkeypatch):
    """§17 keeps the last word: when both can claim and read the same kind, the outer layer answers
    — "my own rule covers the downloaded one" is the point of that order, not an accident."""
    home = tmp_path / "home"
    _two_files_for_one_key(home, r"^https?://demo\.test/search\?q=(?P<id>[^&]+)")
    monkeypatch.setenv("SITEPROBE_HOME", str(home))

    from src.generic import registry

    registry.forget_adapters()
    try:
        comic = {site["key"]: site for site in sites_event()["sites"]}["demo.test"]
        sources = {target["kind"]: target["source"] for target in comic["targets"]}
        assert sources["search"] == "local"
        assert sources["album"] == "installed", "only one of them reads albums at all"
    finally:
        registry.forget_adapters()


def test_sites_names_a_site_with_the_file_that_actually_says_something():
    """A learned draft writes the key back into `display_name`, so "declared" is not enough.

    Measured: `local/18comic_vip` says `display_name: "18comic.vip"` while `installed/comic18`
    says `18comic`. Taking the first declared value would put the placeholder in the menu.
    """
    comic = {site["key"]: site for site in sites_event()["sites"]}["18comic.vip"]
    assert comic["display_name"] == "18comic"
    assert comic["export_group"] == "18comic_vip"


def test_sites_says_which_adapters_explain_themselves(tmp_path, monkeypatch):
    """The menu needs to know a readme *exists* without reading the tool's tree itself."""
    home = tmp_path / "home"
    folder = home / "installed" / "demo" 
    folder.mkdir(parents=True)
    (folder / "site.json").write_text(json.dumps({
        "schema_version": 1, "key": "demo.test", "display_name": "Demo", "tool": "demo",
        "source_site": "demo.test", "export_group": "demo_test", "media_id_prefix": "demo",
        "hosts": ["demo.test"],
        "targets": {"work": {"label": "Work", "single": True,
                             "url_pattern": r"^https?://demo\.test/work/(\d+)"}},
        "documents": {"work": {"page": {"format": "html"}}},
        "work": {"fields": {"title": {"from": "html", "select": "h1"}}},
    }), encoding="utf-8")
    monkeypatch.setenv("SITEPROBE_HOME", str(home))

    from src.generic import registry

    # The key -> adapter map is cached per process, so a test that points the home at a fixture has
    # to drop it before reading and after finishing.
    registry.forget_adapters()
    try:
        site = {site["key"]: site for site in sites_event()["sites"]}["demo.test"]
        assert [adapter["readme"] for adapter in site["adapters"]] == [False]

        (folder / "README.md").write_text("# Demo\n\nWhat it covers.\n", encoding="utf-8")
        site = {site["key"]: site for site in sites_event()["sites"]}["demo.test"]
        assert [adapter["readme"] for adapter in site["adapters"]] == [True]

        event = integration.readme_event("demo.test")
        assert event["event"] == "readme"
        assert event["source"] == "installed"
        assert "What it covers." in event["text"]

        # A site with no readme is not an error — the menu asked whether there is one.
        (folder / "README.md").unlink()
        empty = integration.readme_event("demo.test")
        assert empty["text"] == "" and empty["source"] is None
    finally:
        registry.forget_adapters()


def test_readme_refuses_a_site_that_does_not_exist():
    with pytest.raises(RegistryError) as refusal:
        integration.readme_event("no.such.site")
    assert refusal.value.code == "UNKNOWN_SITE"


# --- resolve: who claims this input --------------------------------------------------------

def test_resolve_names_the_site_and_the_kind():
    event = resolve_event("https://hitomi.la/galleries/1234.html")
    assert event["matched"] is True
    assert event["site"] == "hitomi.la"
    assert event["kind"] == "work"
    assert event["ref"]["id"] == "1234"
    assert event["single"] is True


def test_resolve_answers_no_instead_of_raising():
    event = resolve_event("https://example.com/x")
    assert event["matched"] is False
    assert event["reason"] == "NO_MATCH"
    assert "example.com" in event["detail"]


def test_resolve_reports_an_ambiguous_name_as_ambiguous():
    """A bare name several sites accept is the one case the tool refuses to guess."""
    event = resolve_event("kakao")
    assert event["matched"] is False
    assert event["reason"] == "AMBIGUOUS"


def test_resolve_honours_an_explicit_site_and_kind():
    """The shape a UI produces from the menu `sites` just gave it: key + kind from that site.

    This failed until `runner.resolve` asked `get_for(key, kind)` instead of `get(key)`: the learned
    file wins the key, declares only `search`, and answered "it accepts: search" for an album the
    menu had just listed.

    Every kind the menu lists has to resolve with an input that kind actually takes — a URL for the
    ones that read a page, a name for the ones that accept one. The bare id this used to pass for all
    three is exactly the silent wrong answer the contract now refuses (see the two tests below).
    """
    inputs = {
        "album": "https://18comic.vip/album/1472965/x",
        "favorite": "https://18comic.vip/user/x/favorite/albums?folder=7",
        "search": "1472965",
    }
    sites = {site["key"]: site for site in sites_event()["sites"]}
    for target in sites["18comic.vip"]["targets"]:
        kind = target["kind"]
        event = resolve_event(inputs[kind], site_key="18comic.vip", kind=kind)
        assert event["matched"] is True, kind
        assert event["kind"] == kind
        assert event["ref"]["id"], kind


def test_a_site_asked_without_a_kind_answers_from_the_file_that_reads_the_address():
    """`--site` alone asks "what is this address, and as what?" — and the key-priority file is not
    always the reader.

    Measured through the app on 2026-09-22: pasting a real 18comic album address returned
    "'…' is not a target 18comic.vip recognizes; it accepts: search", because the learned search rule
    set wins the key while the written adapter beside it is the one that reads albums. Both files of
    one key answer for the site, so the address is offered to every one of them.
    """
    album = resolve_event("https://18comic.vip/album/1472965/x", site_key="18comic.vip")
    assert album["matched"] is True, album
    assert album["kind"] == "album"
    assert album["source"] == "installed", "the file that can read it is the one that answers"
    assert album["ref"]["id"] == "1472965"

    # The learned file's own kind still answers too: this is not a preference for the written file.
    searched = resolve_event("https://18comic.vip/search/photos?search_query=x",
                             site_key="18comic.vip")
    assert searched["matched"] is True, searched
    assert searched["kind"] == "search"


def test_an_address_of_the_wrong_shape_is_refused_by_name():
    """An explicit kind is a promise about what the answer is, so the input is checked.

    Measured before this: `--site 18comic.vip --kind album <homepage>` resolved happily (the fallback
    used the whole string as the id) and the crawl failed much later with a message about a missing
    field. A caller that shows "report this bug" for a mistyped address is worse than one that asks
    again, which is why the reason is an input code and not a run failure.
    """
    event = resolve_event("https://18comic.vip/", site_key="18comic.vip", kind="album")
    assert event["matched"] is False
    assert event["reason"] == "INVALID_INPUT"
    assert "18comic.vip" in event["detail"]
    assert main(["resolve", "https://18comic.vip/", "--site", "18comic.vip",
                 "--kind", "album"]) == 2


def test_a_bare_value_is_only_taken_by_a_kind_that_accepts_a_name():
    """`album` reads a page; `search` accepts a name. Handing a page-only kind a bare word is the
    same silent wrong answer by another door."""
    refused = resolve_event("1472965", site_key="18comic.vip", kind="album")
    assert refused["matched"] is False and refused["reason"] == "INVALID_INPUT"
    assert "accepts names for: search" in refused["detail"]

    accepted = resolve_event("kakao", site_key="hitomi.la", kind="search")
    assert accepted["matched"] is True and accepted["kind"] == "search"


def test_a_work_page_is_read_by_the_adapter_that_has_work_fields(tmp_path, monkeypatch):
    """`get(key)` answers the key, and the learned file that wins it reads no work page.

    Measured on the three sites that had both files: the key-priority adapter had 0 work fields
    against 11/13/11 in the written one beside it, so anything that resolves a *work* by key alone —
    downloading a review selection, for one — would read records with nothing in them. Those learned
    shells have since been retired, so on this machine the two doors now agree; this writes the case
    that keeps `reader_for` from becoming dead weight.
    """
    home = tmp_path / "home"
    _two_files_for_one_key(home, r"^https?://demo\.test/search")
    monkeypatch.setenv("SITEPROBE_HOME", str(home))

    from src.generic import registry

    registry.forget_adapters()
    try:
        reader = registry.reader_for("demo.test")
        assert reader.work_fields, "the reader is the one that can read a work page"
        assert not registry.get("demo.test").work_fields, (
            "the key map keeps the outer layer, which is exactly why `reader_for` exists")
    finally:
        registry.forget_adapters()


def test_one_site_has_one_export_group():
    """Two files for one key disagree about the site's group; the site must win over the file.

    The learned draft writes the key into `export_group`, so its runs landed in `export/18comic.vip/`
    while the written adapter — and the hand-written tools before it — wrote `export/18comic_vip/`.
    """
    from pathlib import Path

    from src.generic import export_layout, registry

    for key, group in (("18comic.vip", "18comic_vip"), ("hitomi.la", "hitomi_la"),
                       ("hanime1.me", "hanime1_me")):
        assert registry.site_identity(key)["export_group"] == group
        for template in registry.templates_for(key):
            resolved = export_layout.site_root(Path("root"), template)
            assert resolved.name == group, f"{template.directory} resolved to {resolved.name}"


# --- run and selection: the result event ---------------------------------------------------

class FakeTemplate:
    key = "18comic.vip"
    display_name = "18comic"
    export_group = "18comic_vip"


def test_a_review_run_reports_the_page_and_no_export_yet(tmp_path):
    """The page is the product; `export` stays `None` until a selection is downloaded."""
    def fake_run(options):
        options.progress("scanning for review")
        return RunResult(template=FakeTemplate(), target_kind="search", target_ref="x",
                         listing_dir=tmp_path, records=[], origin=None, warnings=["w"],
                         review_html=tmp_path / "review.html",
                         review_summary={"cards": 218, "count": 218})

    collected = run_events_stubbed(fake_run, tmp_path, review=True)
    kinds = [event["event"] for event in collected]
    assert kinds == ["progress", "review", "result"], (
        "progress while scanning, then where the page is, then the result")
    assert collected[1]["review_html"].endswith("review.html")
    assert collected[1]["count"] == 218, (
        "how many the page holds, under the one name every review reports it with")
    result = collected[-1]
    assert result["command"] == "run"
    assert result["export"] is None, "a review run has no export until a selection is downloaded"
    assert result["works"] is None
    assert result["origin"] is None
    assert result["warnings"] == ["w"]


def test_a_download_run_reports_where_the_export_landed(tmp_path):
    def fake_run(options):
        return RunResult(template=FakeTemplate(), target_kind="album", target_ref="1472965",
                         listing_dir=tmp_path, records=[{"source_id": "1472965"}],
                         origin={"kind": "album", "ref": "1472965"},
                         media_stats={"cover": 1}, warnings=[])

    collected = run_events_stubbed(fake_run, tmp_path)
    assert [event["event"] for event in collected] == ["result"]
    result = collected[-1]
    assert result["works"] == 1
    assert result["export"].endswith("metadata.json")
    assert result["listing"] == str(tmp_path)
    assert result["origin"] == {"kind": "album", "ref": "1472965"}, (
        "origin is what the library's update cursor reads, so it travels with the result")


def test_a_failed_run_reports_a_code_not_a_traceback(tmp_path):
    def explode(options):
        raise RegistryError("no site claims 'x'", "NO_MATCH")

    emitted: list[dict] = []
    import src.generic.integration as module

    original = module.run_once
    module.run_once = explode
    try:
        code = module.run_events("x", project_root=tmp_path, emit=emitted.append)
    finally:
        module.run_once = original
    assert code == 2, "a matching failure is the caller's input being wrong"
    assert emitted[-1]["code"] == "NO_MATCH"


def test_selection_reports_the_export_and_its_origin(tmp_path):
    listing = tmp_path / "export" / "18comic_vip" / "search_x"
    listing.mkdir(parents=True)
    (listing / "metadata.json").write_text(json.dumps({
        "source_site": "18comic.vip", "origin": {"kind": "search", "ref": "x"},
        "items": [{"source_id": "1"}, {"source_id": "2"}],
    }), encoding="utf-8")
    selection = listing / "selection_x.json"
    selection.write_text("{}", encoding="utf-8")

    emitted: list[dict] = []
    import src.generic.integration as module

    original = module.run_selection
    module.run_selection = lambda path, **kwargs: listing
    try:
        code = selection_events([selection], project_root=tmp_path, emit=emitted.append)
    finally:
        module.run_selection = original
    assert code == 0
    result = emitted[-1]
    assert result["works"] == 2
    assert result["site"] == "18comic.vip"
    assert result["origin"] == {"kind": "search", "ref": "x"}


def test_a_missing_selection_is_the_callers_input_problem():
    emitted: list[dict] = []
    code = selection_events([Path("no_such_selection.json")], emit=emitted.append)
    assert code == 2
    assert emitted[0]["code"] == "INVALID_INPUT"


# --- the CLI itself: exit codes, and stdout as a stream of JSON -----------------------------

def run_cli(*arguments: str) -> subprocess.CompletedProcess:
    return subprocess.run([str(INTERPRETER), "integration.py", *arguments],
                          cwd=str(PROJECT_ROOT), capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def parse_lines(stdout: str) -> list[dict]:
    lines = [line for line in stdout.splitlines() if line.strip()]
    assert lines, "a machine door must say something on stdout"
    return [json.loads(line) for line in lines]


def test_the_cli_exits_zero_and_prints_one_json_line_per_answer():
    completed = run_cli("sites")
    assert completed.returncode == 0
    events = parse_lines(completed.stdout)
    assert len(events) == 1 and events[0]["event"] == "sites"


def test_the_cli_exits_two_when_nothing_claims_the_input():
    completed = run_cli("resolve", "https://example.com/x")
    assert completed.returncode == 2
    event = parse_lines(completed.stdout)[0]
    assert event["matched"] is False and event["reason"] == "NO_MATCH"


def test_the_cli_accepts_no_empty_input():
    completed = run_cli("resolve", "   ")
    assert completed.returncode == 2
    assert parse_lines(completed.stdout)[0]["reason"] == "INVALID_INPUT"


def test_the_cli_branches_on_a_code_rather_than_a_message():
    """Every failure the resolver can raise carries a code from the contract's own set."""
    from src.generic import registry

    for raw in ("", "https://example.com/x", "kakao"):
        try:
            registry.resolve_input(raw)
        except RegistryError as error:
            assert error.code in integration.ERROR_CODES, error.code
        else:  # pragma: no cover - these three are the failures, not the successes
            pytest.fail(f"{raw!r} was expected to fail")
