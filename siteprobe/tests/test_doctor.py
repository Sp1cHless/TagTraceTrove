"""Phase F's focused check (plan §5-F): compatibility, a read-only doctor, a recoverable upgrade.

The plan's verification for this phase, plus the fixture corpus it asks for:

* an **old rule set** (no `adapter.json`, a `learned.json` without `schema_version`) still *loads and
  reads* by default — compatibility is the default, not an upgrade;
* `diagnose` names the missing metadata as **repairable** and writes **nothing** — the file's bytes
  are compared before and after;
* `upgrade` previews a diff and, applied, saves a **byte-identical** backup before replacing, so the
  original is recoverable exactly;
* the **fixtures** under `fixtures/adapter_contract/` each read their expected values — a distilled,
  sanitized case per generic capability, run by tag.
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic import doctor, select  # noqa: E402
from src.generic.bundle import RawItem  # noqa: E402
from src.generic.extract import extract_work  # noqa: E402
from src.generic.template import load_template  # noqa: E402

FIXTURES = PROJECT_ROOT / "fixtures" / "adapter_contract"

_OLD_SITE = {
    "schema_version": 1, "key": "old.test", "display_name": "old.test", "tool": "old_test",
    "source_site": "old.test", "export_group": "old_test", "media_id_prefix": "old",
    "hosts": ["old.test"],
    "targets": {"work": {"label": "Work", "single": True,
                         "url_pattern": r"^https?://old\.test/w/(?P<id>[^/]+)"}},
    "documents": {"work": {"page": {"format": "html"}}},
    "work": {"fields": {"title": {"from": "html", "document": "page", "select": "h1", "text": True},
                        "detail_url": {"from": "html", "document": "page", "select": "link",
                                       "attr": "href", "absolute": True}}},
}


def _record_value(record: dict, name: str):
    if name == "cover_url":
        return (record.get("cover") or {}).get("url")
    if name == "tags":
        return (record.get("分类信息") or {}).get("分类标签")
    return record.get(name)


def _run_fixture(directory: Path) -> tuple[dict, dict]:
    expect = json.loads((directory / "expect.json").read_text(encoding="utf-8"))
    template = load_template(directory / "site.json")
    page = (directory / "page.html").read_text(encoding="utf-8")
    url = expect["url"]
    matched = template.match_target(url)
    assert matched is not None, f"{directory.name}: the fixture URL is not claimed by its target"
    item = RawItem(source_id=matched[1]["id"], target_url=url)
    item.add("page", page)
    with select.frozen_clock(date.fromisoformat(expect["today"])):
        record = extract_work(template, item)
    return record, expect


def test_the_fixture_corpus_reads_its_expected_values_by_capability():
    assert FIXTURES.is_dir()
    seen: set[str] = set()
    for directory in sorted(path for path in FIXTURES.iterdir() if path.is_dir()):
        record, expect = _run_fixture(directory)
        for name, wanted in expect["fields"].items():
            assert _record_value(record, name) == wanted, f"{directory.name}.{name}"
        seen.add(expect["capability"])
    assert {"identity", "transforms"} <= seen, "the corpus covers the capabilities it claims to"


def _old_rule(tmp_path: Path) -> Path:
    directory = tmp_path / "old_test"
    directory.mkdir()
    (directory / "site.json").write_text(json.dumps(_OLD_SITE), encoding="utf-8")
    (directory / "learned.json").write_text(json.dumps({
        "generated_by": "siteprobe-builder", "kind": "declarative",
        "fields": ["title", "detail_url"],
    }), encoding="utf-8")
    return directory


def test_an_old_rule_still_loads_and_reads_by_default(tmp_path):
    directory = _old_rule(tmp_path)
    template = load_template(directory / "site.json")
    assert template.key == "old.test"
    assert "work" in template.targets


def test_diagnose_names_the_missing_metadata_and_writes_nothing(tmp_path):
    directory = _old_rule(tmp_path)
    before = {path.name: path.read_bytes() for path in directory.iterdir()}

    report = doctor.diagnose(directory)

    codes = {note.code for note in report.notes}
    assert {"ADAPTER_JSON_MISSING", "LEARNED_SCHEMA_MISSING"} <= codes
    assert all(note.repairable for note in report.notes), "these are repairable hints, not errors"
    assert report.ok, "a repairable metadata gap is not a failure to run the rule"
    after = {path.name: path.read_bytes() for path in directory.iterdir()}
    assert before == after, "diagnose is read-only"


def test_upgrade_previews_then_applies_with_a_byte_identical_backup(tmp_path):
    directory = _old_rule(tmp_path)
    learned_before = (directory / "learned.json").read_bytes()

    preview = doctor.upgrade(directory, apply=False)
    assert preview.applied is False
    assert len(preview.changes) >= 2, "both adapter.json and learned.json need attention"
    assert not (directory / "adapter.json").exists(), "a preview writes nothing"
    assert (directory / "learned.json").read_bytes() == learned_before

    applied = doctor.upgrade(directory, apply=True)
    assert applied.applied is True
    adapter = json.loads((directory / "adapter.json").read_text(encoding="utf-8"))
    assert adapter["domain"] == "old.test" and isinstance(adapter["capabilities"], list)
    assert json.loads((directory / "learned.json").read_text(encoding="utf-8"))["schema_version"] == 1
    # The backup is the original, byte for byte.
    backup = directory / "learned.json.bak"
    assert backup.read_bytes() == learned_before
    # And the rule still runs: the upgrade only added metadata.
    assert load_template(directory / "site.json").key == "old.test"
    # A second pass finds nothing left to do.
    assert doctor.diagnose(directory).repairable() == []


def test_doctor_refuses_the_things_this_core_cannot_run(tmp_path):
    directory = tmp_path / "broken"
    directory.mkdir()
    site = json.loads(json.dumps(_OLD_SITE))
    site["targets"]["work"]["url_pattern"] = r"^https?://old\.test/w/"  # captures nothing
    site["work"]["fields"]["tags"] = {"from": "html", "document": "page", "select": "div",
                                      "transform": ["no_such_transform"]}
    site["work"]["fields"]["cover_url"] = {"from": "json", "document": "network:api",
                                           "path": "$.cover"}
    (directory / "site.json").write_text(json.dumps(site), encoding="utf-8")

    codes = {note.code for note in doctor.diagnose(directory).errors()}
    assert {"TARGET_CAPTURES_NO_ID", "TRANSFORM_UNKNOWN", "DOCUMENT_UNAVAILABLE"} <= codes


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
