"""What a page gave us, from every channel, as one artifact.

Phase 2 of `siteprobe-completion-plan.md`. The Harvester reads a `capture.json`
rather than a URL, for three reasons the plan gives: a session can be replayed
without visiting the site again, a failure can be debugged after the fact, and a
fixture can be kept as a regression — none of which is possible if the only input
is a live page.

A capture holds documents, not fields. Which of them becomes a title is the
Harvester's business; this module's only job is to get everything off the page
without deciding anything:

    markup            the HTML, as sent or as rendered
    inline:N          a script body, which is where framework state lives
    network:N         a JSON response body, which is where an API-driven site
                      keeps everything the markup never had

The browser builder is Builder-only. The runtime reads through the shared engine in
`src/generic/acquisition.py` instead of importing this module — that was the plan's Phase B: the
page-read engine (browser lifecycle, scroll, retry-when-not-rendered) lives in the generic layer,
and both callers use it. What stays here is what is Builder-only: turning a page into a `Capture`
with the inline scripts and the network log the Harvester reads. The reader itself, and the names a
test or the login door imports (`mentions_the_work`, `launch_profile`, `profile_for`, the settle
constants), are re-exported from the generic engine so nothing else has to know they moved.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse

from ..generic import unknown_url
# The one page-read engine, shared with the runtime (plan §5-B). Imported rather than copied: a second
# copy of the browser flags is how the Builder and the runtime drift into different browsers.
from ..generic.acquisition import (  # noqa: F401 - re-exported for callers and tests
    MAX_NETWORK_BODY, MAX_NETWORK_DOCUMENTS, NOISE, SETTLE_MS, SETTLE_RETRIES, BrowserSession,
    launch_profile, mentions_the_work, plan_for, profile_for, scroll_until_settled,
)

TIMEOUT = 25
MAX_SCRIPT_BYTES = 400_000

_SCRIPT = re.compile(r"<script([^>]*)>(.*?)</script>", re.DOTALL | re.IGNORECASE)
_SCRIPT_SRC = re.compile(r"""\bsrc\s*=\s*["']""", re.IGNORECASE)


@dataclass
class Document:
    """One text a channel produced, named so a candidate can point back at it.

    `source_url` is the address the text was fetched from, which is empty for
    markup and inline scripts and set for a network response. It is what makes "is
    this response about the page's own work, or about something beside it"
    answerable — a response whose address shares the page's own slug is the page's
    subject, and one fetched from `…/related` is not.
    """

    name: str
    text: str
    format: str          # markup | json | script
    source_url: str = ""

    def to_json(self) -> dict[str, Any]:
        payload = {"name": self.name, "format": self.format, "text": self.text}
        if self.source_url:
            payload["source_url"] = self.source_url
        return payload


@dataclass
class Capture:
    """Everything read from one address, before anything is interpreted."""

    url: str
    final_url: str = ""
    status: int | None = None
    content_type: str = ""
    documents: list[Document] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    browser_profile: str = ""
    manual_verified: bool = False

    def of_format(self, kind: str) -> list[Document]:
        return [document for document in self.documents if document.format == kind]

    @property
    def markup(self) -> Document | None:
        for document in self.documents:
            if document.name == "page":
                return document
        return None

    def to_json(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "final_url": self.final_url,
            "status": self.status,
            "content_type": self.content_type,
            "documents": [document.to_json() for document in self.documents],
            "notes": self.notes,
            "browser_profile": self.browser_profile,
            "manual_verified": self.manual_verified,
        }

    def write(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_json(), ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
        return path

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> Capture:
        return cls(
            url=str(payload.get("url") or ""),
            final_url=str(payload.get("final_url") or ""),
            status=payload.get("status"),
            content_type=str(payload.get("content_type") or ""),
            documents=[Document(name=str(d["name"]), text=str(d["text"]),
                                format=str(d["format"]),
                                source_url=str(d.get("source_url") or ""))
                       for d in payload.get("documents") or []],
            notes=[str(note) for note in payload.get("notes") or []],
            browser_profile=str(payload.get("browser_profile") or ""),
            manual_verified=bool(payload.get("manual_verified")),
        )

    @classmethod
    def read(cls, path: Path) -> Capture:
        return cls.from_json(json.loads(path.read_text(encoding="utf-8")))


def inline_scripts(html: str) -> Iterator[tuple[int, str]]:
    """Script bodies with no `src`, which is where a framework puts its state.

    A script that loads a bundle carries nothing; the one that *is* the bundle's
    state carries everything, and those are the ones worth naming.
    """
    for index, match in enumerate(_SCRIPT.finditer(html)):
        if _SCRIPT_SRC.search(match.group(1) or ""):
            continue
        body = match.group(2).strip()
        if body:
            yield index, body


def plain_documents(html: str) -> list[Document]:
    documents = [Document(name="page", text=html, format="markup")]
    size = 0
    for index, body in inline_scripts(html):
        if size + len(body) > MAX_SCRIPT_BYTES:
            break
        size += len(body)
        documents.append(Document(name=f"inline:{index}", text=body, format="script"))
    return documents


def capture_plain(url: str) -> Capture:
    """The markup as sent. No browser, no session, no rendering."""
    capture = Capture(url=url)
    try:
        status, body, content_type, final = unknown_url.fetch(url)
    except Exception as error:  # noqa: BLE001 - reported, not raised
        capture.notes.append(f"fetch failed: {type(error).__name__}: {str(error)[:80]}")
        return capture

    capture.status = status
    capture.content_type = content_type
    capture.final_url = final
    if not (200 <= status < 300):
        capture.notes.append(f"HTTP {status}: the body was not read as a page")
        return capture
    if "html" not in content_type and not body.lstrip().startswith(b"<"):
        capture.notes.append(f"not HTML ({content_type or 'unknown type'})")
        return capture

    capture.documents = plain_documents(body.decode("utf-8", "replace"))
    return capture


# The page-read engine and its helpers (`scroll_until_settled`, `mentions_the_work`,
# `profile_for`, `launch_profile`) now live in `src/generic/acquisition.py` and are imported
# above (plan §5-B): one implementation, shared with the runtime.


def captured_nothing(capture: "Capture") -> bool:
    """Whether a capture came back with no page at all.

    A failed navigation is *not* a `markup` of `None` — `page.content()` returns an empty shell
    document, measured on an unreachable address (`status: None`, markup length 0), so checking the
    markup alone let an empty harvest through to the annotation page, which then had nothing to
    click and read as the tool hanging. No status means navigation itself failed; an empty body with
    no status is the same fact.
    """
    if capture.markup and unknown_url.challenge_of(capture.markup.text):
        return True
    if capture.status is not None:
        return not (200 <= capture.status < 300) or capture.markup is None or not capture.markup.text.strip()
    return capture.markup is None or not capture.markup.text.strip()


def capture_browser(url: str, *, settle_ms: int = SETTLE_MS,
                    profile: "pathlib.Path | None" = None,
                    login: bool = False) -> Capture:
    """The markup after the page has run, plus the JSON it fetched to build itself.

    The network log is the channel that matters most for a page whose data is not in its markup — and
    often the one that makes a browser unnecessary at runtime afterwards, because a rule can call the
    API the log revealed.

    `profile` names a persistent browser profile, so a session a person established once is the
    session every later capture uses — the browser's own mechanism, which works for any site and never
    asks this tool to hold a credential. `login` opens a *visible* window and waits for the person to
    finish signing in before the page is read.

    The reading itself is the shared engine (`src/generic/acquisition.py`, plan §5-B); this only turns
    what it returns into the `Capture` the Harvester reads, keeping the Builder-only parts — the
    inline scripts and the network log — here.
    """
    persistent = Path(profile) if profile is not None else profile_for(urlparse(url).hostname or "unknown")
    plan = plan_for("browser", profile=persistent, manual_verification=True,
                    login=login, settle_ms=settle_ms)
    with BrowserSession(plan) as reader:
        read = reader.read(url, mention=lambda html, resources: mentions_the_work(url, html, resources))
    capture = Capture(url=url, final_url=read.final_url, status=read.status,
                      content_type=read.content_type)
    capture.notes = list(read.notes)
    capture.browser_profile = str(persistent.resolve())
    capture.manual_verified = read.manual_verified
    capture.documents = plain_documents(read.html) + [
        Document(name=resource.name, text=resource.text, format="json", source_url=resource.url)
        for resource in read.resources
    ]
    return capture


# Where Chrome may live on a machine that has it. A browser's location, not a site's.
CHROME_CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "chromium",
)


def find_chrome() -> str | None:
    """The installed Chrome, or None — the tool does not ship one."""
    import pathlib as _pathlib
    import shutil

    for candidate in CHROME_CANDIDATES:
        found = shutil.which(candidate) if not candidate.endswith(".exe") else (
            candidate if _pathlib.Path(candidate).is_file() else None)
        if found:
            return found
    return None


def capture_attached(url: str, *, profile: "pathlib.Path | None" = None, port: int = 9222,
                     settle_ms: int = SETTLE_MS) -> Capture:
    """Start Chrome the ordinary way, let a person sign in, attach, and read the page.

    The measurement behind this: a browser Playwright launched itself was challenged on the
    site's own front page, while the same site accepts a plain Chrome a person drives — which is
    what the hand-written site tool does, and what this makes general. Nothing is spoofed: the
    browser is the installed Chrome, the profile is a directory the person owns, and the tool
    only connects to it afterwards to read.
    """
    import json as _json
    import subprocess
    import time
    import urllib.request

    from playwright.sync_api import sync_playwright

    chrome = find_chrome()
    if chrome is None:
        raise RuntimeError("no Chrome was found on this machine")
    profile = Path(profile) if profile is not None else profile_for(
        urlparse(url).netloc or "site")
    profile.mkdir(parents=True, exist_ok=True)
    # Opened *at the site*, not at a blank tab: the person's job here is to sign in, and a blank
    # window gives them nothing to sign into — measured, that is exactly what the first version
    # of this did, and the window it left was `about:blank`.
    site = f"{urlparse(url).scheme}://{urlparse(url).netloc}/"
    # Chrome keeps a lock inside a profile it is using, and refuses to start a second instance
    # on the same one: the URL is handed to the running browser, this process exits, and no
    # debugging port ever appears. Saying that before launching is the difference between a
    # person closing a window and a person watching nothing happen.
    if (profile / "SingletonLock").exists():
        raise RuntimeError(
            f"{profile} 正被另一个 Chrome 使用：请先关掉那个 Chrome 窗口（或换一个 profile 目录），"
            "否则 Chrome 不会新开实例、也不会开调试端口")
    process = subprocess.Popen([chrome, f"--remote-debugging-port={port}",
                                f"--user-data-dir={profile}", "--no-first-run",
                                "--no-default-browser-check", site])
    endpoint = f"http://127.0.0.1:{port}/json/version"
    for attempt in range(60):
        if process.poll() is not None:
            # It exited at once: the URL went to a Chrome that was already running, so there will
            # be no port to attach to. Reported rather than waited on.
            raise RuntimeError(
                "Chrome 立刻退出了 —— 网址被交给了已在运行的 Chrome（同一 profile 被占用）："
                "关掉那个窗口，或换一个 profile 目录再试")
        try:
            with urllib.request.urlopen(endpoint, timeout=2) as reply:
                _json.load(reply)
            break
        except Exception:  # noqa: BLE001 - not up yet
            if attempt and attempt % 5 == 0:
                print(f"    等待调试端口 {port} …（{attempt}s）", flush=True)
            time.sleep(1)
    else:
        process.terminate()
        raise RuntimeError(f"Chrome did not expose a debugging port on {port}")

    capture = Capture(url=url)
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.pages[0] if context.pages else context.new_page()
        print(f"    已在 {site} 打开一个普通 Chrome；在那里登录 / 过验证，")
        print(f"    完成后回终端按回车，工具再附加读取：{url}")
        try:
            input()
        except EOFError:      # no console to answer: read whatever is there
            pass
        response = page.goto(url, wait_until="load", timeout=60_000)
        capture.status = response.status if response else None
        page.wait_for_timeout(settle_ms)
        html = page.content()
        capture.final_url = page.url
        # The browser is the person's: it is left open, and the profile keeps the session for
        # the next run. `connect_over_cdp` detaches; it does not close what it attached to.
    capture.content_type = "text/html"
    capture.documents = plain_documents(html)
    capture.notes.append("read through an attached browser: the page's own session, "
                         "no automation flags set by this tool")
    return capture
