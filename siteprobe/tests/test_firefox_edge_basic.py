"""One real-browser, local-only check of ordinary Firefox and Edge adapter functions."""
from __future__ import annotations

import base64
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.builder.annotate import hypotheses
from src.builder.capture import capture_browser
from src.builder.harvest import harvest
from src.builder.learn import Sample, apply_to, draft_site_json, learn_for_runtime
from src.builder.roundtrip import install
from src.builder.session_server import Session, start
from src.generic import acquisition
from src.generic.declarative import read_work
from src.generic.extract import extract_work
from src.generic.site_api import _profile_dir
from src.generic.template import load_template


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7xkAAAAASUVORK5CYII=")
HTML = """<!doctype html><html><body><h1 id="title">Loading</h1>
<div class="row">Writer: <span id="creator"></span></div>
<p id="description"></p><img id="cover" width="320" height="480"><div id="tags"></div>
<script>
document.body.dataset.remembered = localStorage.getItem('remembered') || 'none';
localStorage.setItem('remembered', 'kept');
document.cookie = 'fixture_session=kept; Max-Age=3600; Path=/';
fetch('/api/__NAME__').then(r => r.json()).then(d => {
  for (const key of ['title', 'creator', 'description']) document.getElementById(key).textContent = d[key];
  document.getElementById('cover').src = d.image;
  for (const tag of d.tags) {
    const a = document.createElement('a'); a.textContent = tag; document.getElementById('tags').appendChild(a);
  }
});
</script></body></html>"""


@pytest.fixture
def local_site():
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            requests.append((self.path, self.headers.get("Cookie", "")))
            if self.path.startswith("/p/"):
                body, content_type = HTML.replace("__NAME__", self.path.rsplit("/", 1)[-1]).encode(), "text/html"
            elif self.path.startswith("/api/"):
                name = self.path.rsplit("/", 1)[-1].title()
                host, port = self.server.server_address
                body = json.dumps({"title": name, "creator": f"Author {name}",
                                   "description": f"Description for {name}.",
                                   "image": f"http://{host}:{port}/cover.png",
                                   "tags": ["Drama", "Adventure", "Comedy"]}).encode()
                content_type = "application/json"
            elif self.path == "/cover.png":
                body, content_type = PNG, "image/png"
            else:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address
    try:
        yield f"http://{host}:{port}", requests
    finally:
        server.shutdown()
        server.server_close()


def test_firefox_association_and_profile_are_engine_specific(tmp_path, monkeypatch):
    class Key:
        def __enter__(self): return self
        def __exit__(self, *args): pass
    monkeypatch.setitem(sys.modules, "winreg", SimpleNamespace(HKEY_CURRENT_USER=1,
        OpenKey=lambda *args: Key(), QueryValueEx=lambda *args: ("FirefoxURL-308046B0AF4A39CB", 1)))
    assert acquisition.windows_default_browser_channel() == "firefox"
    executable = tmp_path / "firefox.exe"
    executable.write_bytes(b"not executed fixture")
    launch = Mock(return_value="firefox")
    chromium_launch = Mock()
    playwright = SimpleNamespace(firefox=SimpleNamespace(executable_path=str(executable),
        launch_persistent_context=launch), chromium=SimpleNamespace(launch_persistent_context=chromium_launch))
    acquisition.launch_profile(playwright, tmp_path / "profile", headful=False)
    options = launch.call_args.kwargs
    assert options["user_data_dir"] == str(tmp_path / "profile" / "firefox")
    assert "user_agent" not in options and "args" not in options and "channel" not in options
    chromium_launch.assert_not_called()


@pytest.mark.parametrize("engine", ["msedge", "firefox"])
def test_real_engine_captures_annotates_learns_and_extracts_without_cloudflare(engine, local_site, tmp_path, monkeypatch):
    base, requests = local_site
    # Force engine selection in this isolated test without changing the Windows default browser.
    monkeypatch.setattr(acquisition, "windows_default_browser_channel", lambda: engine)
    profile = tmp_path / "profile"
    captures = [capture_browser(f"{base}/p/{name}", profile=profile, settle_ms=250) for name in ("one", "two")]
    for capture in captures:
        assert capture.status == 200 and not capture.manual_verified
        assert any(resource.format == "json" and "/api/" in resource.source_url for resource in capture.documents)
    assert 'data-remembered="kept"' in captures[1].markup.text
    assert any(path == "/p/two" and "fixture_session=kept" in cookies for path, cookies in requests)
    if engine == "firefox":
        assert (profile / "firefox").is_dir()

    result = harvest(captures[0])
    annotation_dir = tmp_path / "annotation"
    annotation_dir.mkdir()
    session = Session(harvest=result, directory=annotation_dir, url=captures[0].url, last=True)
    annotation_server, annotation_url = start(session)
    try:
        with sync_playwright() as playwright:
            browser = acquisition.launch_browser(playwright, headless=True)
            try:
                if engine == "firefox":
                    assert browser.browser_type.name == "firefox"
                context = browser.new_context(**acquisition.browser_context_options(browser))
                page = context.new_page()
                page.goto(annotation_url)
                for field, value in [("title", "One"), ("creator", "Author One"),
                                     ("description", "Description for One.")]:
                    page.locator(".field").filter(has_text=f"({field})").click()
                    page.locator("#q").fill(value)
                    page.locator(".cand .v").filter(has_text=re.compile("^" + re.escape(value) + "$" )).first.click()
                page.locator(".field").filter(has_text="(cover)").click()
                page.locator("#q").fill("")
                cover_row = page.locator(".cand").filter(has=page.locator("code", has_text=f"{base}/cover.png"))
                cover_row.locator("strong").first.click()
                page.locator(".field").filter(has_text="(tags)").click()
                page.locator("#q").fill("Drama")
                page.locator(".cand .v").filter(has_text=re.compile("^Drama / Adventure / Comedy$")).first.click()
                page.locator("#save").click()
                assert session.done.wait(5), "the real browser did not submit its annotation"
                assert session.annotation.fields["creator"] == "Author One"
                assert session.annotation.fields["description"] == "Description for One."
                assert session.annotation.fields["tags"] == ["Drama", "Adventure", "Comedy"]
            finally:
                browser.close()
    finally:
        annotation_server.shutdown()
        annotation_server.server_close()

    samples = []
    for name, capture in zip(("one", "two"), captures):
        values = {"title": name.title(), "creator": f"Author {name.title()}",
                  "description": f"Description for {name.title()}.", "cover": f"{base}/cover.png",
                  "tags": ["Drama", "Adventure", "Comedy"]}
        sample = Sample(name=name, capture=capture, harvest=harvest(capture), annotated=values)
        sample.selected_rules = {field: item["rule"] for field, item in hypotheses(values, sample.harvest).items()}
        samples.append(sample)
    assert apply_to(samples[0], samples[1].capture)["creator"]["value"] == "Author Two"
    draft = draft_site_json(samples, learn_for_runtime(samples, browser_capture=True))
    adapter_dir = install(draft, tmp_path / "local")
    template = load_template(adapter_dir / "site.json")
    item = read_work(template, captures[1].url, {"profile_dir": _profile_dir(template)})
    assert item is not None
    record = extract_work(template, item)
    assert record["title"] == "Two" and record["author"] == "Author Two"
    assert record["description"] == "Description for Two."
    assert record["cover"]["url"] == f"{base}/cover.png"
    assert record["分类信息"]["分类标签"] == ["Drama", "Adventure", "Comedy"]
