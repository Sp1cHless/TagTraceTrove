"""Phase A's one focused check (plan §5-A, §6).

The scenario, and why each half is here:

* a **simulated acquisition** (`run=`) feeds the probe a RunResult as the runtime would produce one,
  so the classification and the report are measured without a network — a stub is not evidence that
  a real site works, and this test does not claim it is (plan §6);
* an **empty listing** must be *located*: the probe fails the listing stage with `LISTING_ROWS_EMPTY`
  and `ok` is false, not a silent success that imports 0 items;
* a **valid result** must fetch one real image from a local fixture server and reach T³'s actual
  TypeScript parser, using scratch exports only;
* a running process must stop at its deadline, and duplicate ids must stop the runtime before
  writing a review page.
* a **required field no page answered** must refuse an install (`blocking_findings`), while an
  **acquisition** failure must not (an occasional network failure is not a broken rule, plan §7).

The whole file is one entry: `pytest siteprobe/tests/test_diagnostics.py`.
"""

from __future__ import annotations

import json
import base64
import subprocess
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic import acquisition, declarative, diagnostics as diag, probe_process, runner  # noqa: E402
from src.generic.export_layout import build_manifest, write_json  # noqa: E402
from src.generic.probe import ProbeRequest, runtime_probe  # noqa: E402
from src.generic.runner import RunResult  # noqa: E402


class FakeTemplate:
    key = "demo.test"
    display_name = "Demo"
    export_group = "demo_test"
    source_site = "demo.test"
    raw: dict = {"manifest": {"style": "items"}}


@pytest.fixture
def image_server():
    image = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = (image if self.path == "/image.png" else
                    b"<h1>Work</h1><time>5 days ago</time><img class='cover' src='/image.png'>"
                    if self.path.startswith("/video/") else b"<html>sign in</html>")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def _review_result(listing: Path, cards: list[dict], findings: list[diag.Finding]) -> RunResult:
    return RunResult(template=FakeTemplate(), target_kind="search", target_ref="q", listing_dir=listing,
                     records=[], origin=None, warnings=[], review_summary={"cards": len(cards)},
                     review_html=listing / "review.html", findings=findings, cards=cards)


def _download_result(listing: Path, records: list[dict],
                     findings: list[diag.Finding]) -> RunResult:
    return RunResult(template=FakeTemplate(), target_kind="work", target_ref="1", listing_dir=listing,
                     records=records, origin=None, warnings=[], findings=findings)


def test_probe_locates_an_empty_listing_and_refuses_it():
    """The plan's first failure: a listing that read nothing must not pass as a success."""
    def empty_run(options):
        # The runner's review path raises a DiagnosticError carrying the finding; the probe must turn
        # that into a failed stage, not an exception out of the probe.
        raise diag.DiagnosticError("nothing was listed", findings=[
            diag.listing_rows_empty(kind="search", url="https://demo.test/search?q=x")])

    report = runtime_probe(ProbeRequest(url="https://demo.test/search?q=x", building="listing"),
                           run=empty_run)
    assert report.ok is False
    assert report.stage("listing").status == "failed"
    assert {finding.code for finding in report.findings()} >= {"LISTING_ROWS_EMPTY"}
    # Nothing to import, so the import stage is not a pass either.
    assert report.stage("import").status == "unavailable"


def test_probe_passes_a_valid_result_and_names_the_export_for_t3(tmp_path, image_server):
    """A valid listing+work passes every stage it ran, and the export it wrote is the real shape."""
    records = [{"source_site": "demo.test", "source_id": "1", "title": "A work",
                "detail_url": "https://demo.test/work/1", "分类信息": {},
                "cover": {"url": image_server + "/image.png"}}]

    def good_run(options):
        if options.review:
            listing = tmp_path / "export" / "demo_test" / "search_q"
            listing.mkdir(parents=True, exist_ok=True)
            (listing / "review.html").write_text("<html></html>", encoding="utf-8")
            return _review_result(listing, [{"source_id": "1", "title": "A work",
                                             "detail_url": "https://demo.test/work/1"}], [])
        listing = tmp_path / "export" / "demo_test" / "work_1"
        listing.mkdir(parents=True, exist_ok=True)
        manifest = build_manifest(FakeTemplate(), records, name="work_1",
                                  url=records[0]["detail_url"], origin=None)
        write_json(listing / "metadata.json", manifest)
        return _download_result(listing, records, [])

    report = runtime_probe(ProbeRequest(url="https://demo.test/search?q=x", building="listing"),
                           run=good_run)
    assert report.ok is True, report.to_json()
    assert report.stage("listing").status == "passed"
    assert report.stage("work").status == "passed"
    assert report.stage("media").status == "passed"
    assert report.stage("import").status == "passed", report.to_json()
    assert report.export is not None

    document = json.loads(Path(report.export).read_text(encoding="utf-8"))
    # The keys T³'s own parser reads (`apps/server/src/import/site-probe.ts`): a batch names its site
    # and carries item objects with the four required fields a record is built from.
    assert document["source_site"] == "demo.test"
    assert document["item_count"] == 1
    assert isinstance(document["items"], list) and isinstance(document["items"][0], dict)
    assert {"source_site", "source_id", "title", "detail_url"} <= set(document["items"][0])
    cover_path = Path(report.export).parent / document["items"][0]["cover"]["local_path"]
    assert cover_path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")


def test_a_required_field_that_no_page_answered_refuses_an_install(tmp_path):
    """The state the whole batch exists for: it must block, and it must say which field."""
    def dropped_run(options):
        if options.review:
            listing = tmp_path / "review"
            listing.mkdir(parents=True, exist_ok=True)
            return _review_result(listing, [{"source_id": "1", "title": "A work",
                                             "detail_url": "https://demo.test/work/1"}], [])
        listing = tmp_path / "work_1"
        listing.mkdir(parents=True, exist_ok=True)
        # Every work was dropped for a missing required field: no records, one finding.
        return _download_result(listing, [], [
            diag.work_field_empty("title", ids=["1"], severity="error")])

    report = runtime_probe(ProbeRequest(url="https://demo.test/search?q=x", building="listing"),
                           run=dropped_run)
    codes = {finding.code for finding in report.findings()}
    assert "WORK_FIELD_EMPTY" in codes
    blocking = diag.blocking_findings(report.findings())
    assert [finding.code for finding in blocking] == ["WORK_FIELD_EMPTY"]
    assert report.ok is False


def test_an_acquisition_failure_is_advisory_not_blocking():
    """The plan's risk table: an occasional network failure must look like one, not like a rule bug."""
    def flaky_run(options):
        raise ValueError("connection reset")

    report = runtime_probe(ProbeRequest(url="https://demo.test/work/1", building="work"),
                           run=flaky_run)
    codes = {finding.code for finding in report.findings()}
    assert "ACQUISITION_FAILED" in codes
    assert diag.blocking_findings(report.findings()) == []


def test_a_repeated_id_is_a_data_fault_and_blocks():
    """Two cards answering one id is not a pass — the import would refuse the batch as duplicates."""
    def duplicated_run(options):
        if options.review:
            listing = Path(options.project_root) / "review"
            listing.mkdir(parents=True, exist_ok=True)
            cards = [{"source_id": "7", "title": "a", "detail_url": "https://demo.test/work/7"},
                     {"source_id": "7", "title": "b", "detail_url": "https://demo.test/work/7"}]
            findings = diag.classify_cards(cards, target_kind="search")
            return _review_result(listing, cards, findings)
        # The work stage is reached (a card carries an address) but reads nothing; the data fault is
        # the repeated id, already reported by the listing stage.
        listing = Path(options.project_root) / "work_7"
        listing.mkdir(parents=True, exist_ok=True)
        return _download_result(listing, [], [])

    report = runtime_probe(ProbeRequest(url="https://demo.test/search?q=x", building="listing"),
                           run=duplicated_run)
    codes = {finding.code for finding in report.findings()}
    assert "SOURCE_ID_DUPLICATED" in codes
    assert [f.code for f in diag.blocking_findings(report.findings())] == ["SOURCE_ID_DUPLICATED"]


def test_a_spent_budget_is_reported_never_wrapped_as_a_pass():
    """The plan's §5-A.8, pinned: once the budget is gone the stage is `unavailable`, not `passed`."""
    def never_called(options):
        raise AssertionError("nothing should run after the budget is spent")

    report = runtime_probe(
        ProbeRequest(url="https://demo.test/work/1", building="work", total_seconds=0.0),
        run=never_called)
    assert report.ok is False
    assert report.stage("acquisition").status == "unavailable"
    assert {finding.code for finding in report.findings()} == {"BUDGET_EXCEEDED"}


def test_finding_json_omits_absent_optional_keys():
    """A caller reads `finding.field`, not `null`; absent means absent (plan §4.1's tableau)."""
    payload = diag.source_id_duplicated(["7"]).to_json()
    assert payload["code"] == "SOURCE_ID_DUPLICATED"
    assert payload["stage"] == "listing"
    assert payload["severity"] == "error"
    assert "field" not in payload and "suggested_action" in payload


def test_a_query_value_never_reaches_a_report():
    """Evidence is bounded and safe: a session-bearing query value is redacted (plan §7)."""
    redacted = diag.redact_url("https://demo.test/search?q=secret&authkey=deadbeef#frag")
    assert "secret" not in redacted and "deadbeef" not in redacted and "#frag" not in redacted
    assert redacted.startswith("https://demo.test/search?")


def test_the_finding_vocabulary_matches_the_plan():
    """Every code the plan fixes for batch A is a code this module can actually emit."""
    assert {"LISTING_ROWS_EMPTY", "SOURCE_ID_EMPTY", "SOURCE_ID_DUPLICATED", "WORK_FIELD_EMPTY",
            "ACQUISITION_EMPTY", "ACQUISITION_FAILED", "DOCUMENT_UNAVAILABLE", "COVER_URL_EMPTY",
            "COVER_FETCH_FAILED", "BUDGET_EXCEEDED", "CAPABILITY_UNSUPPORTED"} <= diag.FINDING_CODES
    # And the required-field list this module classifies by is the one the export writer enforces.
    from src.generic.canonical import REQUIRED_KEYS
    assert set(diag.REQUIRED_FIELDS) == set(REQUIRED_KEYS)


@pytest.mark.parametrize("status, expected", [(403, "ACQUISITION_FAILED"),
                                              (None, "ACQUISITION_FAILED"),
                                              (200, "ACQUISITION_EMPTY")])
def test_failed_listing_acquisition_keeps_its_stage(monkeypatch, status, expected):
    rule = SimpleNamespace(acquisition="http", max_pages=1)
    template = SimpleNamespace(listings={"artist": rule}, listing=None)

    @contextmanager
    def session(_plan):
        yield SimpleNamespace(read=lambda url: acquisition.PageRead(url=url, status=status,
                                                                    notes=["not readable"]))

    monkeypatch.setattr(acquisition, "session", session)

    def run(options):
        return declarative.list_cards(template, "artist", {"id": "author"},
                                      {"target_url": options.raw_input})

    report = runtime_probe(ProbeRequest(url="https://demo.test/author/a", building="listing"), run=run)
    assert report.stage("acquisition").status == "failed"
    assert report.stage("listing").status == "unavailable"
    assert [f.code for f in report.findings()] == [expected]


def test_runner_blocks_duplicate_ids_before_writing_a_review(tmp_path, monkeypatch):
    template = SimpleNamespace(key="demo.test", display_name="Demo", source_site="demo.test",
                               export_group="demo_test", directory=tmp_path, raw={},
                               targets={"artist": SimpleNamespace(single=False)})
    cards = [{"source_id": "same", "detail_url": "https://demo.test/work/1"},
             {"source_id": "same", "detail_url": "https://demo.test/work/2"}]
    monkeypatch.setattr(runner, "resolve", lambda _options: (template, "artist", {"id": "a"}))
    monkeypatch.setattr(runner, "load_fetcher", lambda _template: SimpleNamespace(
        list_cards=lambda *_args: cards))
    monkeypatch.setattr(runner.export_layout, "site_root", lambda root, _template: root / "export")
    with pytest.raises(diag.DiagnosticError) as caught:
        runner.run(runner.RunOptions(raw_input="https://demo.test/author/a", review=True,
                                     project_root=tmp_path, progress=lambda _message: None))
    assert [f.code for f in caught.value.findings] == ["SOURCE_ID_DUPLICATED"]
    assert not list(tmp_path.rglob("review.html"))


def test_a_running_process_is_terminated_at_its_deadline():
    started = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired):
        probe_process.execute([sys.executable, "-c", "import time; time.sleep(20)"], seconds=0.1)
    assert time.monotonic() - started < 5


def test_runtime_probe_applies_the_page_budget(monkeypatch):
    def worker(action, payload, *, seconds):
        assert action == "run" and payload["max_pages"] == 1
        assert 0 < seconds <= 0.2
        raise subprocess.TimeoutExpired("runtime", seconds)

    monkeypatch.setattr(probe_process, "worker", worker)
    report = runtime_probe(ProbeRequest(url="https://demo.test/work/1", page_seconds=0.2))
    assert report.stage("acquisition").status == "unavailable"
    assert [f.code for f in report.findings()] == ["BUDGET_EXCEEDED"]


def test_cover_html_is_not_reported_as_a_valid_image(tmp_path, image_server):
    records = [{"source_site": "demo.test", "source_id": "1", "title": "Work",
                "detail_url": "https://demo.test/work/1", "cover": {"url": image_server + "/login"}}]

    def run(_options):
        write_json(tmp_path / "metadata.json", build_manifest(FakeTemplate(), records,
                    name="work_1", url=records[0]["detail_url"], origin=None))
        return _download_result(tmp_path, records, [])

    report = runtime_probe(ProbeRequest(url=records[0]["detail_url"]), run=run)
    assert report.stage("media").status == "failed"
    assert "COVER_FETCH_FAILED" in {f.code for f in report.findings()}
    assert report.stage("import").status == "passed"


def test_t3_rejects_an_export_that_would_import_zero(tmp_path):
    def run(_options):
        write_json(tmp_path / "metadata.json", {"source_site": "demo.test", "items": []})
        return _download_result(tmp_path, [{"source_site": "demo.test", "source_id": "1",
                                           "title": "Work", "detail_url": "https://demo.test/work/1"}], [])

    report = runtime_probe(ProbeRequest(url="https://demo.test/work/1"), run=run)
    assert report.stage("import").status == "failed"
    assert [f.code for f in diag.blocking_findings(report.findings())] == ["IMPORT_CONTRACT_REJECTED"]


def test_default_probe_runs_a_scratch_adapter_through_the_real_worker(tmp_path, image_server):
    from src.builder.roundtrip import install

    draft = json.loads((PROJECT_ROOT / "fixtures/adapter_contract/opaque_id_relative_date/site.json")
                       .read_text(encoding="utf-8"))
    draft["hosts"] = ["127.0.0.1"]
    draft["url_base"] = image_server
    draft["targets"]["work"]["url_pattern"] = r"^http://127\.0\.0\.1:\d+/video/(?P<id>[^/]+)"
    home = tmp_path / "home"
    install(draft, home / "local", source="probe")
    report = runtime_probe(ProbeRequest(url=image_server + "/video/opaque-id/slug", home=home,
                                       project_root=tmp_path / "scratch"))
    assert report.ok, report.to_json()
    assert report.stage("work").status == "passed", report.to_json()
    assert report.stage("media").status == "passed", report.to_json()
    assert report.stage("import").status == "passed", report.to_json()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
