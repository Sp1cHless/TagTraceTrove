"""A marked rendered cover must survive learning, runtime acquisition and media export."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.builder.capture import Capture, plain_documents
from src.builder.harvest import harvest
from src.builder.learn import Sample, draft_site_json, learn_for_runtime
from src.builder.roundtrip import compare, template_from
from src.generic import acquisition, declarative, diagnostics as diag, media
from src.generic.extract import extract_work
from src.generic.probe import ProbeRequest, _probe_cover


def samples(*, served_cover: bool = False) -> list[Sample]:
    result = []
    for work in ("alpha", "beta"):
        url = f"https://fixture.test/work/{work}"
        title = f"Work {work}"
        cover = f"https://images.fixture.test/{work}.png"
        text = f'<h1 class="title">{title}</h1><div id="player"><img src="{cover}"></div>'
        capture = Capture(url=url, status=200, documents=plain_documents(text))
        result.append(Sample(name=work, capture=capture, harvest=harvest(capture),
                             annotated={"title": title, "cover": cover},
                             served=text if served_cover else f'<h1 class="title">{title}</h1>'))
    return result


def test_a_browser_only_cover_selects_rendered_acquisition_and_reaches_the_export(tmp_path, monkeypatch):
    recorded = samples()
    learning = learn_for_runtime(recorded, browser_capture=True)
    draft = draft_site_json(recorded, learning)
    assert learning.acquisition == "browser"
    assert draft["work"]["acquisition"] == "browser"
    assert "cover_url" in draft["work"]["fields"]
    assert compare(recorded[0], draft, tmp_path).ok
    template = template_from(draft, tmp_path)
    seen_modes = []

    def read_page(url, plan):
        seen_modes.append(plan.mode)
        return acquisition.PageRead(url=url, final_url=url, status=200,
                                    html=recorded[0].capture.markup.text)

    monkeypatch.setattr(acquisition, "read_page", read_page)
    item = declarative.read_work(template, recorded[0].url)
    record = extract_work(template, item)
    assert seen_modes == ["browser"]
    assert record["cover"]["url"] == recorded[0].annotated["cover"]
    stats = media.download_record_media(record, tmp_path / "items" / "alpha",
                                        fetch=lambda _url: b"\x89PNG\r\n\x1a\nfixture")
    assert stats["cover"] == 1
    assert (tmp_path / record["cover"]["local_path"]).is_file()


def test_a_served_cover_keeps_the_faster_http_reader(tmp_path):
    recorded = samples(served_cover=True)
    learning = learn_for_runtime(recorded, browser_capture=True)
    draft = draft_site_json(recorded, learning)
    assert learning.acquisition == "http"
    assert "cover_url" in draft["work"]["fields"]
    assert compare(recorded[0], draft, tmp_path).ok


def test_a_discarded_marked_cover_cannot_disappear_from_the_acceptance_count(tmp_path):
    recorded = samples()
    learning = learn_for_runtime(recorded, browser_capture=False)
    draft = draft_site_json(recorded, learning)
    assert "cover_url" not in draft["work"]["fields"]
    report = compare(recorded[0], draft, tmp_path)
    assert not report.ok
    assert [comparison.field for comparison in report.disagreeing()] == ["cover_url"]


def test_a_declared_http_cover_is_checked_against_the_served_page(tmp_path):
    recorded = samples()
    learning = learn_for_runtime(recorded, browser_capture=True)
    draft = draft_site_json(recorded, learning)
    draft["work"]["acquisition"] = "http"
    report = compare(recorded[0], draft, tmp_path)
    assert not report.ok
    assert next(item for item in report.comparisons if item.field == "cover_url").runtime is None


def test_a_probe_missing_its_expected_cover_blocks_instead_of_claiming_no_cover(tmp_path):
    report = diag.ProbeReport(target="work")
    _probe_cover(ProbeRequest(url="https://fixture.test/work/a", expect_cover=True), report,
                 [{"source_id": "a", "title": "Work"}], tmp_path, diag.Budget(90))
    assert report.stage("media").status == "failed"
    assert not report.ok
    assert [finding.code for finding in diag.blocking_findings(report.findings())] == ["COVER_URL_EMPTY"]
