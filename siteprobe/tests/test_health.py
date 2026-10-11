"""Phase 7 尾段：维护那一半 —— 规则失效时点名、给候选，且绝不改文件。

页面用磁盘上现存的录制（`18comic_vip/output/v2_dry_run/items/122916/raw.html` ✓，真实相册页 ✓），
adapter 由测试自己写一份最小的 ✓（不依赖 `local/` 里碰巧装了什么 ✗ —— 那里现在是列表适配器，
没有 `work` 段 ✓）。两个用例：能读的字段要报告读了 ✓；**故意改坏**的字段要被点名 ✓ 并附带该页
自己的候选替换 ✓ —— 这正是计划 §10 对 maintenance 的要求：给建议 ✓，不静默修改 ✓，建议本身仍是
确定性 selector ✓。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder.health import check_work_adapter, describe, suggestions_for  # noqa: E402

RECORDED = (PROJECT_ROOT.parent / "18comic_vip" / "output" / "v2_dry_run" / "items"
            / "122916" / "raw.html")
URL = "https://18comic.vip/album/122916/"


def site_with(title_rule: dict) -> dict:
    """A minimal work adapter, in the shape `load_template` reads."""
    return {
        "schema_version": 1, "key": "18comic.vip", "display_name": "18comic",
        "tool": "comic18", "source_site": "18comic.vip", "export_group": "18comic.vip",
        "media_id_prefix": "18comic.vip", "hosts": ["18comic.vip"],
        "targets": {"album": {"url_pattern": r"^https?://18comic\.vip/", "label": "album"}},
        "documents": {"work": {"page": {"format": "html"}}},
        "work": {"fields": {"title": title_rule}},
    }


def write(tmp_path: Path, site: dict) -> Path:
    path = tmp_path / "site.json"
    path.write_text(json.dumps(site, ensure_ascii=False), encoding="utf-8")
    return path


def recorded_html() -> str:
    return RECORDED.read_text(encoding="utf-8", errors="replace")


def test_a_field_that_reads_is_reported_as_reading():
    if not RECORDED.is_file():
        return                                        # pragma: no cover - the user's recording
    rule = {"from": "html", "document": "page", "select": "#book-name", "text": True,
            "matches": 1}
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        path = write(Path(directory), site_with(rule))
        findings = check_work_adapter(path, URL, recorded_html())

    title = next(finding for finding in findings if finding.field == "title")
    assert not title.broken, describe(findings)
    assert "read a value" in describe(findings)


def test_a_broken_rule_is_named_and_offered_replacements(tmp_path):
    """The maintenance case: a site is redesigned, a selector stops matching, and today that is
    silent — the export simply has no title. The check names the field, and puts the page's own
    candidates beside it, each carrying the deterministic rule that reads it again."""
    if not RECORDED.is_file():
        return                                        # pragma: no cover - the user's recording
    broken = {"from": "html", "document": "page", "select": "h1.this-class-was-renamed",
              "text": True}
    html = recorded_html()

    findings = check_work_adapter(write(tmp_path, site_with(broken)), URL, html)
    title = next(finding for finding in findings if finding.field == "title")
    pool = suggestions_for(html, URL, limit=6, like=broken)

    assert title.broken, describe(findings)
    assert pool, "the page offered no replacement candidates"
    assert all(suggestion["rule"] for suggestion in pool), "a suggestion without a rule"
    assert all(suggestion["kind"] in ("text", "collection") for suggestion in pool), \
        "a text rule must not be offered links or images"
    assert any(str(suggestion["rule"].get("select") or "").startswith("#")
               for suggestion in pool), "no named element among the candidates"
    assert not any(str(suggestion["rule"].get("select") or "") == "a" for suggestion in pool), \
        "the navigation's own links are not title candidates"
    title.suggestions = pool[:2]
    assert "empty" in describe(findings)
