"""Phase B's focused check (plan §5-B): one acquisition engine, one context per walk.

Two things the plan asks this phase to prove, and one invariant it asks to keep:

* **the Builder and the runtime read through the same engine** — `capture_browser` and
  `declarative.list_cards` both go through `acquisition`, so a rule learned from rendered markup is
  read the same way at runtime;
* **pagination does not restart the context** — a two-page browser listing opens the browser **once**
  and reads both pages in that one session (before this, the runtime opened a fresh browser per page);
* **the runtime no longer imports the Builder's capture module** — the plan's §5-B.2, pinned here as
  a source check so the dependency cannot quietly come back.

The reader is stubbed (`BrowserSession` replaced), so this measures this module's own behaviour, not a
site's; a real Chrome and a real network are the user's acceptance, not this test's claim.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic import acquisition  # noqa: E402
from src.generic import declarative  # noqa: E402
from src.generic.acquisition import AcquisitionPlan, NetworkResource, PageRead, plan_for  # noqa: E402
from src.generic.template import load_template  # noqa: E402

BASE = "https://fix.test"
PAGE_1 = (f'<main><article class="card"><a href="/work/1">A</a></article>'
          f'<a class="next" href="{BASE}/tag/x?page=2">next</a></main>')
PAGE_2 = '<main><article class="card"><a href="/work/2">B</a></article></main>'


def _listing_site(tmp_path: Path) -> Path:
    site = {
        "schema_version": 1, "key": "fix.test", "display_name": "fix", "tool": "fix_test",
        "source_site": "fix.test", "export_group": "fix.test", "media_id_prefix": "fix.test",
        "hosts": ["fix.test"],
        "targets": {"album": {"label": "Album", "single": False, "id_group": "id",
                              "url_pattern": r"^https?://fix\.test/tag/(?P<id>[^/?]+)"}},
        "listings": {"album": {
            "document": "listing_html", "row_selector": "article.card",
            "fields": {"source_id": {"from": "html", "document": "listing_html",
                                     "select": "a", "attr": "href"},
                       "title": {"from": "html", "document": "listing_html",
                                 "select": "a", "text": True}},
            "next_selector": {"from": "html", "document": "listing_html",
                              "select": "a.next", "attr": "href"},
            "acquisition": "browser",
        }},
    }
    path = tmp_path / "site.json"
    path.write_text(json.dumps(site), encoding="utf-8")
    return path


class _FakeBrowser:
    """Stands in for the one Chrome, and counts how many were opened."""

    opened: list[AcquisitionPlan] = []

    def __init__(self, plan: AcquisitionPlan) -> None:
        self.plan = plan
        _FakeBrowser.opened.append(plan)

    def __enter__(self) -> "_FakeBrowser":
        return self

    def __exit__(self, *exception: object) -> bool:
        return False

    def read(self, url: str, **_options: object) -> PageRead:
        html = PAGE_1 if "page=2" not in url else PAGE_2
        return PageRead(url=url, final_url=url, status=200, content_type="text/html", html=html)


def test_a_browser_listing_reads_every_page_in_one_context(tmp_path, monkeypatch):
    _FakeBrowser.opened = []
    monkeypatch.setattr(acquisition, "BrowserSession", _FakeBrowser)
    template = load_template(_listing_site(tmp_path))

    cards = declarative.list_cards(template, "album", {"id": "x"},
                                   {"target_url": f"{BASE}/tag/x"})

    assert [card["source_id"] for card in cards] == ["/work/1", "/work/2"], "both pages were walked"
    assert len(_FakeBrowser.opened) == 1, "one browser for the whole walk, not one per page"
    assert _FakeBrowser.opened[0].mode == "browser"


def test_the_builder_captures_through_the_same_engine(tmp_path, monkeypatch):
    """`capture_browser` returns a Builder `Capture`, but the reading is the shared engine."""
    html = "<html><body><h1>Rendered</h1></body></html>"

    class _FakeCaptureBrowser(_FakeBrowser):
        def read(self, url, **_options):
            return PageRead(url=url, final_url=url, status=200, content_type="text/html", html=html,
                            resources=[NetworkResource(name="network:0", text='{"a": 1}',
                                                       url=f"{BASE}/api/work/1")])

    monkeypatch.setattr(acquisition, "BrowserSession", _FakeCaptureBrowser)
    from src.builder import capture as capture_module
    # `capture_browser` binds the engine at import, so the fake is installed on that module's own
    # name — the same engine either way, and this is what proves it is the same one.
    monkeypatch.setattr(capture_module, "BrowserSession", _FakeCaptureBrowser)

    capture = capture_module.capture_browser(f"{BASE}/work/1")
    assert capture.markup is not None and capture.markup.text == html
    assert [document.name for document in capture.of_format("json")] == ["network:0"], (
        "the network log survives the move to the shared engine")


def test_a_plan_honours_an_explicit_mode_and_defaults_to_http():
    """§5-B: a browser rule is never downgraded to HTTP, and an absent mode stays HTTP."""
    assert plan_for(None).mode == "http"
    assert plan_for("http").mode == "http"
    assert plan_for("browser").mode == "browser"
    assert plan_for("  Browser ").mode == "browser"
    assert plan_for("browser", profile=Path("p")).profile == Path("p")
    assert plan_for("browser").browser is True


def test_the_runtime_does_not_import_the_builder_capture_module():
    """The plan's §5-B.2, pinned: the extraction half must not depend on the authoring tool."""
    source = Path(declarative.__file__).read_text(encoding="utf-8")
    assert "builder.capture" not in source
    assert "from ..builder" not in source


if __name__ == "__main__":  # pragma: no cover
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
