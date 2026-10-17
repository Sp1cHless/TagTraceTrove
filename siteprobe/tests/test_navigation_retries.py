"""One focused offline check of bounded navigation retries and the next sample door."""
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from playwright.sync_api import TimeoutError as NavigationTimeout

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_adapter
from src.builder import capture as capture_module
from src.generic import acquisition

URL = "https://fixture.test/posts/2"
CHALLENGE = '<html><script>window.__cf_chl_opt = {};</script></html>'


class Page:
    def __init__(self, steps):
        self.steps = iter(steps)
        self.main_frame = object()
        self.calls = 0
        self.waits = []
        self.closed = False
        self.handlers = {}
        self.url = URL
        self.html = ""

    def on(self, event, handler):
        self.handlers[event] = handler

    def goto(self, url, **options):
        self.calls += 1
        self.url = url
        step = next(self.steps)
        if isinstance(step, Exception):
            raise step
        status, html, headers = step
        self.html = html
        response = SimpleNamespace(status=status, headers=headers, frame=self.main_frame,
                                   request=SimpleNamespace(resource_type="document"))
        self.handlers["response"](response)
        return response

    def content(self):
        return self.html

    def wait_for_timeout(self, milliseconds):
        self.waits.append(milliseconds)

    def close(self):
        self.closed = True


def reader(steps):
    page = Page(steps)
    session = acquisition.BrowserSession(acquisition.plan_for("browser", settle_ms=0, scroll=False))
    session._context = SimpleNamespace(new_page=lambda: page)
    return session, page


def step(status, html="<h1>posts Work 2</h1>", headers=None):
    return status, html, headers or {}


@pytest.mark.parametrize("status", [408, 429, 500, 502, 503, 504])
def test_transient_status_recovers_and_reports_wait(status, capsys):
    session, page = reader([step(status), step(200)])
    result = session.read(URL, mention=lambda html, resources: "Work 2" in html)
    assert result.status == 200 and result.readable
    assert page.calls == 2 and 2000 in page.waits and page.closed
    output = capsys.readouterr().out
    assert f"HTTP {status}" in output and "（1/2）" in output


def test_repeated_503_stops_at_three_requests_without_reading_error_as_work(capsys):
    session, page = reader([step(503)] * 3)
    result = session.read(URL, mention=lambda html, resources: False)
    assert page.calls == 3 and [delay for delay in page.waits if delay] == [2000, 5000]
    assert result.status == 503 and not result.readable and not result.html and not result.resources
    assert "重试上限" in capsys.readouterr().out


@pytest.mark.parametrize("seconds,requests", [(7, 2), (60, 1)])
def test_retry_after_is_respected_and_long_waits_stop(seconds, requests, capsys):
    session, page = reader([step(503, headers={"retry-after": str(seconds)}), step(200)])
    result = session.read(URL)
    assert page.calls == requests
    if requests == 2:
        assert seconds * 1000 in page.waits and result.readable
    else:
        assert not result.readable and "不提前" in capsys.readouterr().out


def test_timeout_recovers_but_permanent_errors_do_not_retry():
    session, page = reader([NavigationTimeout("request timed out"), step(200)])
    assert session.read(URL).readable and page.calls == 2
    for status in (401, 403, 404):
        session, page = reader([step(status)])
        assert not session.read(URL).readable and page.calls == 1


def test_verification_503_does_not_retry_the_challenge():
    session, page = reader([step(503, CHALLENGE)])
    session.plan.manual_verification = True
    session._headful = True
    session._wait_for_verification = Mock(return_value=("", URL))
    result = session.read(URL)
    assert page.calls == 1 and not result.readable
    session._wait_for_verification.assert_called_once()


def test_recovered_second_capture_opens_its_annotation_page(monkeypatch, tmp_path):
    session, page = reader([step(503), step(200)])
    class Session:
        def __init__(self, plan):
            pass
        def __enter__(self):
            return session
        def __exit__(self, *args):
            pass
    monkeypatch.setattr(capture_module, "BrowserSession", Session)
    monkeypatch.setattr(capture_module, "profile_for", lambda host: tmp_path / "profile")
    monkeypatch.setattr(build_adapter, "session_directory", lambda capture, label: tmp_path / label)
    serve = Mock()
    monkeypatch.setattr(build_adapter, "serve", serve)
    result = build_adapter.one_sample(URL, "work2", browser=True, references=[], index=1, total=2)
    assert result == tmp_path / "work2" and page.calls == 2
    assert serve.call_count == 1 and serve.call_args.args[0].position == (1, 2)


def test_failed_second_sample_preserves_first_selection_and_does_not_install(monkeypatch, tmp_path, capsys):
    first = tmp_path / "first"
    first.mkdir()
    annotation = first / "annotations.json"
    annotation.write_text('{"fields":{"title":"First selection"}}', encoding="utf-8")
    before = annotation.read_bytes()
    monkeypatch.setattr(build_adapter, "one_sample", Mock(side_effect=[first, None]))
    monkeypatch.setattr(build_adapter, "learn_for_runtime", lambda *args, **kwargs: pytest.fail("Failed second sample reached learning"))
    monkeypatch.setattr(build_adapter, "install", lambda *args, **kwargs: pytest.fail("Failed second sample reached installation"))
    assert build_adapter.main(["--browser", "--install", "https://fixture.test/posts/1", URL]) == 2
    assert annotation.read_bytes() == before
    assert "第 2/2 个作品读取失败" in capsys.readouterr().out
