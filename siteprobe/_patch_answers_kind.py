"""One-off: the shared "can this adapter answer this kind" rule, plus the two fabricated tests.

The first patch adds the matchability half to the menu's rule. A target whose `url_pattern` captures
no group can never claim an address (`TargetRule.match` answers None), so an adapter declaring it must
not be named as the one that answers that kind.
"""

import pathlib

registry_file = pathlib.Path("src/generic/registry.py")
raw = registry_file.read_bytes().decode("utf-8")

old = '''    return (False, not reads_kind(template, matched[0]), source_rank(template))


def reads_kind(template: SiteTemplate, kind: str) -> bool:
    """Whether an adapter that declares `kind` can actually read it.

    A single-work target needs work fields; an adapter that declares one and has none reads nothing.
    A listing target is read by the learned rules themselves, so declaring it is the whole promise.
    """
    rule = template.targets.get(kind)
    if rule is None:
        return False
    return bool(template.work_fields) if rule.single else True
'''.replace("\n", "\r\n")
assert raw.count(old) == 1, ("reads_kind", raw.count(old))
new = '''    return (False, not answers_kind(template, matched[0]), source_rank(template))


def answers_kind(template: SiteTemplate, kind: str) -> bool:
    """Whether an adapter that declares `kind` could answer an address of it. One rule, both doors.

    With an address in hand (rule A) the first half is already settled \\u2014 a kind only comes back from
    a target that matched. The menu asks the same question with no address, so it has to ask both:

    * the target must be able to **claim** an address at all: a pattern with no capturing group
      matches nothing (`TargetRule.match` answers None), which is what the three learned shells in
      `local/` did while every address went to the written adapter beside them;
    * and it must be able to **read** what it claimed: a single-work target with no work fields reads
      nothing. A listing target is read by the learned rules themselves, so declaring it is the whole
      promise.
    """
    rule = template.targets.get(kind)
    if rule is None:
        return False
    if rule.url_pattern is None or rule.url_pattern.groups == 0:
        return False
    return bool(template.work_fields) if rule.single else True
'''.replace("\n", "\r\n")
raw = raw.replace(old, new, 1)

old2 = '''    declaring = [template for template in templates if kind in template.targets]
    return min(declaring, key=lambda template: (not reads_kind(template, kind),
                                                source_rank(template)))
'''.replace("\n", "\r\n")
assert raw.count(old2) == 1, ("adapter_for_kind", raw.count(old2))
new2 = '''    declaring = [template for template in templates if kind in template.targets]
    return min(declaring, key=lambda template: (not answers_kind(template, kind),
                                               source_rank(template)))
'''.replace("\n", "\r\n")
raw = raw.replace(old2, new2, 1)
registry_file.write_bytes(raw.encode("utf-8"))

# --- the two fabricated tests ----------------------------------------------------------------

tests = pathlib.Path("tests/test_integration_api.py")
raw = tests.read_bytes().decode("utf-8")

old3 = '''def _two_files_for_one_key(home: Path) -> None:'''.replace("\n", "\r\n")
assert raw.count(old3) == 1, ("helper", raw.count(old3))
raw = raw.replace(old3, '''def _two_files_for_one_key(home: Path, shell_search_pattern: str) -> None:'''.replace("\n", "\r\n"), 1)

old4 = '''        "targets": {"search": {"label": "\\u641c\\u7d22", "single": False,
                               "url_pattern": r"^https?://demo\\.test/search"}},'''.replace("\n", "\r\n")
assert raw.count(old4) == 1, ("shell target", raw.count(old4))
raw = raw.replace(old4, '''        "targets": {"search": {"label": "\\u641c\\u7d22", "single": False,
                               "url_pattern": shell_search_pattern}},'''.replace("\n", "\r\n"), 1)

old5 = '''def _declare_work_in_the_learned_file(home: Path) -> None:
    """The learned file declares the work kind too, and still has no fields to read it with."""
    document = json.loads((home / "local" / "demo_vip" / "site.json").read_text(encoding="utf-8"))
    document["targets"]["work"] = {"label": "Work", "single": True, "id_group": "id",
                                  "url_pattern": r"^https?://demo\\.test/album/(?P<id>\\d+)"}
    (home / "local" / "demo_vip" / "site.json").write_text(json.dumps(document), encoding="utf-8")


'''.replace("\n", "\r\n")
assert raw.count(old5) == 1, ("declare work helper", raw.count(old5))
raw = raw.replace(old5, "", 1)

old6 = '''    A menu built from one file alone hides capabilities that work \\u2014 measured before the union
    existed: `--list-sites` showed `18comic.vip` as search-only. And each target names the layer that
    *answers* it: both files can read a search, so by \\u00a717 the outer one is the answer.
    """
    _two_files_for_one_key(tmp_path / "home")'''.replace("\n", "\r\n")
assert raw.count(old6) == 1, ("union docstring", raw.count(old6))
raw = raw.replace(old6, '''    A menu built from one file alone hides capabilities that work \\u2014 measured before the union
    existed: `--list-sites` showed `18comic.vip` as search-only. And each target names the layer that
    *answers* it: the learned file declares a search and can never claim a search address, because its
    pattern captures no id, so the written adapter is the one named.
    """
    _two_files_for_one_key(tmp_path / "home", r"^https?://demo\\.test/search")'''.replace("\n", "\r\n"), 1)

old7 = '''        assert sources["search"] == "local", "both can read a search, and local is the outer layer"'''.replace("\n", "\r\n")
assert raw.count(old7) == 1, ("search source", raw.count(old7))
raw = raw.replace(old7, '''        assert sources["search"] == "installed", (
            "the learned file's pattern captures no id, so it can never claim a search address")'''.replace("\n", "\r\n"), 1)

old8 = '''def test_a_target_names_the_layer_that_answers_it_not_the_first_that_declares_it(tmp_path, monkeypatch):
    """A rule set with no work fields can declare a work kind and read nothing from it.

    Measured on a real album while the learned shells were on disk: the menu named
    `local/18comic_vip` for the work kind while resolution handed every address to
    `installed/comic18`.
    """
    home = tmp_path / "home"
    _two_files_for_one_key(home)
    _declare_work_in_the_learned_file(home)
    monkeypatch.setenv("SITEPROBE_HOME", str(home))

    from src.generic import registry

    registry.forget_adapters()
    try:
        comic = {site["key"]: site for site in sites_event()["sites"]}["demo.test"]
        sources = {target["kind"]: target["source"] for target in comic["targets"]}
        assert sources["work"] == "installed", "the layer that can read it is the one named"
        assert sources["search"] == "local", "an outer layer that can read it still wins"
    finally:
        registry.forget_adapters()
'''.replace("\n", "\r\n")
assert raw.count(old8) == 1, ("second test", raw.count(old8))
raw = raw.replace(old8, '''def test_a_target_names_the_layer_that_answers_it_not_the_first_that_declares_it(tmp_path, monkeypatch):
    """A target that cannot claim an address is not the one that answers it.

    Measured on a real search address while the learned shells were on disk: the menu named
    `local/18comic_vip` while both doors handed every 18comic address to `installed/comic18`.
    """
    home = tmp_path / "home"
    _two_files_for_one_key(home, r"^https?://demo\\.test/search")
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
    """\\u00a717 keeps the last word: when both can claim and read the same kind, the outer layer is the
    answer \\u2014 "my own rule covers the downloaded one" is the point of the order, not an accident."""
    home = tmp_path / "home"
    _two_files_for_one_key(home, r"^https?://demo\\.test/search\\?q=(?P<id>[^&]+)")
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
'''.replace("\n", "\r\n"), 1)

tests.write_bytes(raw.encode("utf-8"))
print("ok")
