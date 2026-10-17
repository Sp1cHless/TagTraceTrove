"""One offline check of manual verification handoff; no CAPTCHA is solved by the tool."""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_adapter
from src.builder import capture as capture_module
from src.builder.capture import Capture, Document, captured_nothing
from src.builder.harvest import harvest
from src.builder.learn import Sample, draft_site_json, learn_for_runtime
from src.builder.roundtrip import install
from src.generic import acquisition
from src.generic.site_api import _profile_dir
from src.generic.template import load_template


CHALLENGE = '<html><title>Please wait</title><script>window.__cf_chl_opt = {};</script></html>'
URL = "https://fixture.test/p/one"


class FakePage:
    def __init__(self, context):
        self.context = context
        self.url = ""
        self.html = ""
        self.main_frame = object()
        self.handlers = {}
        self.closed = False

    def on(self, name, handler):
        self.handlers[name] = handler

    def response(self, status):
        response = SimpleNamespace(status=status, frame=self.main_frame,
                                   request=SimpleNamespace(resource_type="document"))
        self.handlers["response"](response)
        return response

    def goto(self, url, **options):
        self.url = url
        self.context.state["navigations"].append((self.context.headful, url))
        if self.context.state["cleared"]:
            self.html = f'<html><h1>{url.rsplit("/", 1)[-1]}</h1></html>'
            return self.response(200)
        self.html = CHALLENGE
        return self.response(403)

    def content(self):
        return self.html

    def is_closed(self):
        return self.closed or (self.context.headful and self.context.state["outcome"] == "closed")

    def wait_for_timeout(self, milliseconds):
        if self.context.headful and self.context.state["outcome"] == "human_passed":
            # Simulated external human action, not a click performed by the reader.
            self.context.state["cleared"] = True
            self.html = f'<html><h1>{self.url.rsplit("/", 1)[-1]}</h1></html>'
            self.response(200)

    def reload(self, **options):
        self.context.state["reloads"] += 1
        raise AssertionError("manual verification must not repeatedly reload")

    def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, state, profile, headful):
        self.state, self.profile, self.headful = state, profile, headful
        self.pages = []
        self.closed = False

    def new_page(self):
        page = FakePage(self)
        self.pages.append(page)
        return page

    def close(self):
        self.closed = True
        for page in self.pages:
            page.close()


@pytest.fixture
def browser(monkeypatch, tmp_path):
    profile = tmp_path / "home" / "browser_profiles" / "fixture.test"
    state = {"cleared": False, "outcome": "human_passed", "opens": [], "navigations": [], "reloads": 0}
    def launch(playwright, path, *, headful):
        state["opens"].append((Path(path), headful))
        return FakeContext(state, Path(path), headful)
    class FakeSession(acquisition.BrowserSession):
        def __enter__(self):
            self._playwright = SimpleNamespace(stop=lambda: None)
            self._context = launch(self._playwright, self.plan.profile, headful=self.plan.login)
            return self
    monkeypatch.setattr(acquisition, "launch_profile", launch)
    monkeypatch.setattr(acquisition, "scroll_until_settled", lambda page: None)
    monkeypatch.setattr(capture_module, "BrowserSession", FakeSession)
    monkeypatch.setattr(capture_module, "profile_for", lambda host: profile)
    return state, profile, FakeSession


def test_hidden_capture_opens_same_profile_for_human_then_reads_the_verified_work(browser, capsys):
    state, profile, _session = browser
    result = capture_module.capture_browser(URL, settle_ms=0)
    assert state["opens"] == [(profile, False), (profile, True)]
    assert result.status == 200 and result.manual_verified
    assert result.browser_profile == str(profile.resolve())
    assert result.markup.text == "<html><h1>one</h1></html>"
    assert not captured_nothing(result)
    assert state["reloads"] == 0 and len(state["navigations"]) == 2
    assert "[VERIFY]" in capsys.readouterr().out


@pytest.mark.parametrize("outcome,note", [("waiting", "timed out"), ("closed", "cancelled")])
def test_timeout_or_user_close_never_returns_the_challenge_as_work(browser, outcome, note):
    state, profile, session_type = browser
    state["outcome"] = outcome
    plan = acquisition.plan_for("browser", profile=profile, manual_verification=True,
                                verification_timeout_ms=2000, settle_ms=0, scroll=False)
    with session_type(plan) as reader:
        result = reader.read(URL)
    assert not result.readable and result.html == "" and result.resources == []
    assert not result.manual_verified and any(note in item for item in result.notes)
    assert state["reloads"] == 0


def test_noninteractive_runtime_does_not_open_a_window_or_treat_the_gate_as_content(browser):
    state, profile, session_type = browser
    plan = acquisition.plan_for("browser", profile=profile, settle_ms=0, scroll=False)
    with session_type(plan) as reader:
        result = reader.read(URL)
    assert not result.readable and not result.html
    assert state["opens"] == [(profile, False)]


def test_an_ordinary_page_does_not_prompt_and_later_captures_reuse_clearance(browser):
    state, profile, _session = browser
    first = capture_module.capture_browser(URL, settle_ms=0)
    second = capture_module.capture_browser(URL.replace("one", "two"), settle_ms=0)
    assert first.manual_verified and not second.manual_verified
    assert second.status == 200 and "<h1>two</h1>" in second.markup.text
    assert state["opens"] == [(profile, False), (profile, True), (profile, False)]
    assert first.browser_profile == second.browser_profile


def test_verified_capture_roundtrip_and_generated_adapter_keep_the_profile(browser, tmp_path):
    state, profile, _session = browser
    captures = [capture_module.capture_browser(URL, settle_ms=0),
                capture_module.capture_browser(URL.replace("one", "two"), settle_ms=0)]
    samples = []
    for name, capture in zip(("one", "two"), captures):
        restored = Capture.from_json(capture.to_json())
        assert restored.browser_profile == capture.browser_profile
        assert restored.manual_verified == capture.manual_verified
        samples.append(Sample(name=name, capture=restored, harvest=harvest(restored),
                              annotated={"title": name}, served=restored.markup.text))
    learning = learn_for_runtime(samples, browser_capture=True)
    assert learning.acquisition == "browser", "manual clearance must not be downgraded to plain HTTP"
    draft = draft_site_json(samples, learning)
    assert draft["session"]["profile_dir"] == str(profile.resolve())
    target = install(draft, tmp_path / "home" / "local")
    template = load_template(target / "site.json")
    assert _profile_dir(template) == profile.resolve()
    assert not Path(template.raw["session"]["profile_dir"]).is_absolute()


def test_challenge_and_http_errors_stop_before_the_annotation_page(monkeypatch):
    blocked = Capture(url=URL, status=403, documents=[Document(name="page", format="markup", text=CHALLENGE)])
    assert captured_nothing(blocked)
    assert captured_nothing(Capture(url=URL, status=200, documents=blocked.documents))
    assert captured_nothing(Capture(url=URL, status=404, documents=[
        Document(name="page", format="markup", text="Not found")]))
    assert not acquisition.PageRead(url=URL, status=200, html=CHALLENGE).readable
    monkeypatch.setattr(build_adapter, "capture_browser", lambda *args, **options: blocked)
    monkeypatch.setattr(build_adapter, "serve", lambda *args: pytest.fail("verification page reached annotation"))
    assert build_adapter.one_sample(URL, "work1", browser=True, references=[]) is None
