"""Where the tool keeps its data, and which adapter answers an address.

Two things this file locks, both of which were wrong in ways nobody noticed until the integration
work measured them:

* the home must be T³'s own data root — `library.db` and the tool's adapters in one tree, so one
  backup and one cleanup policy covers both (guidance §34). It was `<repo>/.data/siteprobe`
  while the database lived in `apps/server/.data`, and nothing anywhere asserted which root was
  in use, so it stayed wrong through a whole migration;
* an address must be answered by an adapter that declares a target for it. Two adapters can share
  a key, and a rule set learned from one listing page reads listings only — asking it for a work
  page gets an adapter with no work fields at all.

`builtin` is checked too, because it is the one root that is *not* user data: a shipped adapter is
read-only code in the repository.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
REPO = PROJECT_ROOT.parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder import paths  # noqa: E402
from src.generic import registry  # noqa: E402
from src.generic.template import TargetRule  # noqa: E402
from build_listing import url_pattern_for  # noqa: E402
from src.builder.listing import target_pattern_problem  # noqa: E402


def test_the_home_and_the_database_share_one_root():
    """Guidance §34: the tool's writable data sits inside T³'s data root, not beside it."""
    home = registry.adapter_root()
    assert home == registry.user_data_dir() / "siteprobe", (
        "the tool's home and T³'s data root must be one tree, so the same backup covers both")
    assert home.parent == (REPO / "apps" / "server" / ".data")
    assert paths.home() == home, "the builder and the registry must agree on one home"


def test_the_repository_names_the_home_so_a_bat_finds_the_same_one():
    """A bat double-clicked in a checkout and a T³-spawned run must land in the same place.

    That is what `siteprobe.json` is for: the environment variable only exists when T³ starts the
    tool, and a relative `home` must be read against the file's own directory rather than the
    caller's working directory.
    """
    setting = REPO / "siteprobe.json"
    assert setting.is_file(), "the repository must name the home for a checkout"
    named = json.loads(setting.read_text(encoding="utf-8"))["home"]
    assert not Path(named).is_absolute()
    assert (REPO / named) == paths.home()
    assert (REPO / named).is_dir(), "the named home must exist"


def test_an_environment_variable_still_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("SITEPROBE_HOME", str(tmp_path / "elsewhere"))
    assert registry.adapter_root() == tmp_path / "elsewhere"


def test_the_data_root_follows_t3_data_dir(monkeypatch):
    monkeypatch.setenv("T3_DATA_DIR", "somewhere-else")
    resolved = registry.user_data_dir()
    assert resolved.name == "somewhere-else"
    assert resolved.parent.name == "server", "a relative T3_DATA_DIR is read against the server"


def test_builtin_is_read_from_the_repository_not_from_user_data():
    """A shipped adapter is read-only code, so it is never copied into the home (§34)."""
    roots = registry.tool_roots()
    assert registry.adapters_root() / "builtin" in roots
    assert registry.adapter_root() / "builtin" not in roots
    for root in roots:
        if root.name != "builtin":
            assert registry.adapter_root() in root.parents


def test_the_installed_and_learned_adapters_are_both_found(two_layers):
    """Two rule sets for one domain are a duplicate, not a reason to stop working.

    The map keeps one of them by layer order (§17) and the other stays reachable for the targets
    it alone declares. Measured on a real gallery: the Builder installed a learned adapter for a site
    the toolkit already read, and from then on *every* URL failed with "two site templates claim the
    key" — one builder session took the whole tool down with it. This asked the user's own home for
    the count, which is a fact about their disk rather than about this code, so it writes both.
    """
    kept = _write_adapter(two_layers / "local", "mine", _adapter(fields=WORK_FIELDS))
    shadowed = _write_adapter(two_layers / "installed", "downloaded", _adapter(fields=WORK_FIELDS))

    both = registry.templates_for("two-layers.test")
    assert sorted(template.directory.name for template in both) == ["downloaded", "mine"],         "the whole set is on disk, and both are read"
    assert registry.registry()["two-layers.test"].directory == kept
    assert registry.shadowed_sites() == [("two-layers.test", str(shadowed), str(kept))],         "the adapter that lost is named, so a site that changed hands can be explained"


@pytest.mark.parametrize("url", [
    "https://18comic.vip/album/1472965/",
    "https://18comic.vip/search/photos?search_query=x",
    "https://18comic.vip/user/someone/favorite/albums?folder=1184906",
])
def test_an_address_is_answered_by_an_adapter_that_declares_it(url):
    """Measured: for one search URL these two disagreed, and `site_for_url` named the one whose
    `work.fields` is empty."""
    by_host = registry.site_for_url(url)
    resolved, _kind, _captured = registry.resolve_input(url)
    assert by_host is not None
    assert by_host.directory == resolved.directory
    assert by_host.match_target(url) is not None, "the adapter must declare this kind of address"


# --- one address, two adapters, two layers (architecture §17 + resolution) ------------------------

WORK_FIELDS = {"title": {"from": "html", "select": "h1"}}
ALBUM = "https://two-layers.test/album/7"


def _write_adapter(layer: Path, folder: str, document: dict) -> Path:
    target = layer / folder
    target.mkdir(parents=True, exist_ok=True)
    (target / "site.json").write_text(json.dumps(document), encoding="utf-8")
    return target


def _adapter(*, fields: dict | None = None, declares_album: bool = True) -> dict:
    """A minimal adapter that either declares the album address or only shares its host."""
    targets = {"work": {"label": "作品", "single": True, "id_group": "id",
                        "url_pattern": r"^https?://two-layers\.test/album/(?P<id>\d+)"}}
    if not declares_album:
        targets = {"search": {"label": "搜索", "single": False, "id_group": "id",
                              "url_pattern": r"^https?://two-layers\.test/search\?q=(?P<id>[^&]+)"}}
    return {
        "key": "two-layers.test",
        "tool": "twolayers",
        "hosts": ["two-layers.test"],
        "targets": targets,
        "documents": {"work": {"page": {"format": "html"}}},
        "work": {"fields": {} if fields is None else fields},
    }


@pytest.fixture()
def two_layers(tmp_path, monkeypatch):
    """A home whose only adapters are the ones a test writes, so layer order is the whole world."""
    home = tmp_path / "home"
    (home / "local").mkdir(parents=True)
    (home / "installed").mkdir(parents=True)
    monkeypatch.setenv("SITEPROBE_HOME", str(home))
    registry.forget_adapters()
    try:
        yield home
    finally:
        registry.forget_adapters()


def test_an_adapter_that_can_read_the_address_beats_the_layer(two_layers):
    """Rule A, first half: a matching target that can be *read* wins before the layer does.

    Measured on a real album: `local/18comic_vip` — a rule set learned from a search page, with no
    work fields at all — outranked `installed/comic18`, whose work rule reads 11 fields, and the
    album page was handed to the adapter that reads nothing.
    """
    _write_adapter(two_layers / "local", "learned-shell", _adapter(fields={}))
    reader = _write_adapter(two_layers / "installed", "written", _adapter(fields=WORK_FIELDS))

    by_url = registry.site_for_url(ALBUM)
    by_input, kind, _captured = registry.resolve_input(ALBUM)

    assert by_url is not None and by_url.directory == reader
    assert by_input.directory == reader, "both doors must pick the same adapter"
    assert kind == "work"


def test_the_layer_decides_when_both_adapters_can_read_the_address(two_layers):
    """Rule A, second half: §17 keeps the last word, because "my own rule covers the downloaded
    one" is still the right answer when both of them can read the same thing."""
    mine = _write_adapter(two_layers / "local", "mine", _adapter(fields=WORK_FIELDS))
    downloaded = _write_adapter(two_layers / "installed", "downloaded", _adapter(fields=WORK_FIELDS))

    assert registry.site_for_url(ALBUM).directory == mine
    assert registry.resolve_input(ALBUM)[0].directory == mine
    assert downloaded.exists(), "the losing adapter stays on disk, for the targets it alone declares"


def test_an_adapter_that_declares_the_address_beats_one_that_only_shares_the_host(two_layers):
    """Rule A, before capability: sharing a host is not declaring an address."""
    _write_adapter(two_layers / "local", "elsewhere", _adapter(fields=WORK_FIELDS,
                                                               declares_album=False))
    declared = _write_adapter(two_layers / "installed", "declared", _adapter(fields=WORK_FIELDS))

    assert registry.site_for_url(ALBUM).directory == declared
    assert registry.resolve_input(ALBUM)[0].directory == declared


def test_a_listing_pattern_must_capture_an_id():
    """`TargetRule.match` answers `None` without a group, and this is the pattern that shipped.

    It was built by an older `url_pattern_for` that returned host and path only, so the learned
    `search` target of 18comic resolved through no code path: correct silently, because the
    hand-written adapter's own pattern kept the URL working.
    """
    broken = r"^https?://18comic\.vip/search/photos"
    assert target_pattern_problem(broken, ["https://18comic.vip/search/photos?search_query=x"])
    assert "captures no id" in target_pattern_problem(
        broken, ["https://18comic.vip/search/photos?search_query=x"])


@pytest.mark.parametrize("page", [
    "https://18comic.vip/search/photos?search_query=x",
    "https://18comic.vip/search/photos?search_query=x&page=2",
])
def test_a_search_listing_pattern_reads_both_sampled_pages(page):
    pattern = url_pattern_for("https://18comic.vip/search/photos?search_query=x", "page")
    assert target_pattern_problem(pattern, [page]) is None
    assert "search_query=x" not in pattern, "the export name wants the value, not the parameter"


@pytest.mark.parametrize("page", [
    "https://www.agedm.io/author/someone",
    "https://www.agedm.io/author/someone/",
])
def test_an_artist_listing_pattern_captures_the_last_segment(page):
    pattern = url_pattern_for("https://www.agedm.io/author/someone")
    assert target_pattern_problem(pattern, [page]) is None
    matched = TargetRule(kind="artist", url_pattern=re.compile(pattern),
                         id_group=None, label="artist").match(page)
    assert matched == {"id": "someone"}


def test_the_export_tree_is_built_under_the_home_exactly_once():
    """`project_root` is the directory that *contains* `export/`, and nothing else.

    Measured on a real run through T³: with the constant pointing at the export tree itself, the
    listing and a fresh empty dictionary landed in `<home>/export/export/<group>/` while the
    migrated dictionary, the tag sheet and `应用Tag审核` (which scans `<home>/export/<group>/`)
    stayed where they were — two trees for one site, and no test noticed because every test builds
    its own project root. So this pins both halves: what the runner defaults to, and where a listing
    actually lands.
    """
    from src.generic import export_layout
    from src.generic.registry import adapters_root, adapter_root
    from src.generic.runner import PROJECT_ROOT

    assert PROJECT_ROOT == adapter_root()
    assert adapters_root() not in PROJECT_ROOT.parents, (
        "the repository's own adapters are never under the home")

    template = registry.get_for('18comic.vip', 'album')
    listing = export_layout.listing_dir(PROJECT_ROOT, template, 'single/1472965')
    assert listing == adapter_root() / 'export' / '18comic_vip' / 'single' / '1472965'
    assert listing.parts.count('export') == 1, f"the export segment is doubled: {listing}"


def test_every_writer_of_an_export_resolves_it_through_the_home():
    """One rule for every entry that *writes* an export, not just the runner.

    `repair_crawl_state.py` passed its own directory as the project root, so `export_root` appended a
    second `export` and it looked in `<tool>/export/<group>/` — a tree that does not exist in a
    checkout. The two Level 0 entries had the same mistake and no longer have a project root at all:
    they write nothing (see `tests/test_unknown_url.py`), so there is no path left to get wrong.
    """
    import importlib.util

    from src.generic.registry import adapter_root

    spec = importlib.util.spec_from_file_location("_probe_repair_crawl_state",
                                                  PROJECT_ROOT / "repair_crawl_state.py")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except SystemExit:  # pragma: no cover - a module that exits on import is a failure anyway
        raise AssertionError("repair_crawl_state.py exited while being imported")
    assert module.PROJECT_ROOT == adapter_root()

    # And the Level 0 doors must not have acquired one again.
    for name in ("show_link.py", "fetch_work_meta.py"):
        source = (PROJECT_ROOT / name).read_text(encoding="utf-8")
        assert "PROJECT_ROOT" not in source, f"{name} writes nothing, so it needs no project root"


def test_a_pattern_that_misses_its_own_sample_is_reported():
    assert target_pattern_problem(r"^https?://other\.example/", [
        "https://18comic.vip/album/1/"]) is not None
