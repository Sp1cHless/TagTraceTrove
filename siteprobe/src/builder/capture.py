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

The browser builder is Builder-only. The runtime never imports it, and this module
imports Playwright lazily so that it stays absent from any path that does not ask
for it.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from ..generic import unknown_url

TIMEOUT = 25
SETTLE_MS = 3500
#: How many times a page that has not rendered yet is read again, with a longer settle each time.
SETTLE_RETRIES = 2
MAX_SCRIPT_BYTES = 400_000
# A page can fire hundreds of XHRs. The first few dozen carry everything a rule
# would want, and reading a body is a round-trip to the browser.
MAX_NETWORK_DOCUMENTS = 40
MAX_NETWORK_BODY = 512_000

# Telemetry, ads and fonts: nothing a rule would ever want, and most of what a raw
# network log contains.
NOISE = re.compile(
    r"google-analytics|googletagmanager|doubleclick|cloudflareinsights|umami"
    r"|sentry|facebook|hotjar|clarity|/beacon|/www/delivery/|exoclick|juicyads"
    r"|clickaine|adservice|/ads?/|font|\.woff|\.css",
    re.IGNORECASE,
)

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


def _scroll_until_settled(page, rounds: int = 12) -> None:
    """Give a page that loads the rest of itself on scroll the chance to do so.

    Measured on a real search page: its markup held 31 of the 43 results, and the page's own
    scripts mentioned `scroll`, `ajax` and `infinite` — the rest arrive only once the viewport
    moves. Waiting a fixed time does not help, so the tool learned rules from a fraction of the
    set and reported that fraction as the whole.

    The loop stops when the document stops growing: the same terminal condition the plan's §17
    uses for pages ("no new ids"), applied to one document.
    """
    previous = -1
    for _ in range(rounds):
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(500)
        height = page.evaluate("document.body ? document.body.scrollHeight : 0")
        if height <= previous:
            break
        previous = height
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(200)


from urllib.parse import urlparse


def profile_for(host: str) -> pathlib.Path:
    """Where this host's browser profile lives, unless a person names another directory.

    One directory per host, beside the sessions the Builder already writes, and git-ignored:
    a profile holds cookies and tokens, so it is the person's to keep and never the repository's.
    """
    import pathlib as _pathlib

    from . import paths

    return paths.home() / "browser_profiles" / host


def launch_profile(playwright: Any, profile: "pathlib.Path", *, headful: bool) -> Any:
    """Open a persistent browser profile — the one place that does it.

    Two callers need exactly this browser: the Builder (which captures a page a person is signed
    into) and the login door (which establishes that session). A second copy of these flags is how
    the two would drift into different browsers, different user agents or a profile that one of
    them cannot read back.

    Chrome through the channel, not Playwright's bundled Chromium: the bundled build is
    version-mismatched in this workspace, the download is large, and the system Chrome is the
    browser a person is already logged into. The one automation signal worth removing is removed
    only when a person is in the loop — Chrome is then being driven as the browser they signed
    into, and `navigator.webdriver` is what most protections look at first. Nothing else is
    spoofed: no fingerprint tuning, no site-specific profile.
    """
    import pathlib as _pathlib

    profile = _pathlib.Path(profile)
    profile.mkdir(parents=True, exist_ok=True)
    return playwright.chromium.launch_persistent_context(
        user_data_dir=str(profile), headless=not headful, channel="chrome",
        user_agent=unknown_url.UA, viewport={"width": 1440, "height": 900},
        args=["--disable-blink-features=AutomationControlled"],
    )


def mentions_the_work(url: str, html: str, responses: list["Document"]) -> bool:
    """Whether a captured page is the page that was asked for.

    Measured on iwara (2026-10-11): the second page came back as the site's own loading screen —
    `<title>Loading | Iwara</title>`, no work name, no images, and not one API response — because the
    browser read it before the single-page app had rendered. Every rule then read nothing, and the
    confirm page offered five empty fields, which looks exactly like five broken rules and is not.

    The page says which work it is — but *not in its head*: measured on iwara (2026-10-11), the loading
    screen carried `<meta property="og:url" content="…/sOAekITnnSb24p/fleurdelys">`, the address
    echoed into the head before anything had rendered, while its body held nothing of the work and it
    had made no request at all. So the body is what is searched, and the requests it made — on a site
    whose content is entirely behind JavaScript, the requests are where a rendered page says so.
    """
    wanted = [part for part in urlparse(url).path.split("/") if part]
    needles = [part.casefold() for part in wanted[-2:] if len(part) >= 4]
    if not needles:
        # Nothing in the address worth looking for (a bare origin, a short id): not a judgement this
        # can make, and a guard that guesses would refuse good pages.
        return True
    body = html.split("</head>", 1)[-1].casefold()
    requests = [(document.source_url or "").casefold() for document in responses]
    return any(needle in haystack for needle in needles
               for haystack in [body, *requests])


def captured_nothing(capture: "Capture") -> bool:
    """Whether a capture came back with no page at all.

    A failed navigation is *not* a `markup` of `None` — `page.content()` returns an empty shell
    document, measured on an unreachable address (`status: None`, markup length 0), so checking the
    markup alone let an empty harvest through to the annotation page, which then had nothing to
    click and read as the tool hanging. No status means navigation itself failed; an empty body with
    no status is the same fact.
    """
    if capture.status is not None:
        return False
    return capture.markup is None or not capture.markup.text.strip()


def capture_browser(url: str, *, settle_ms: int = SETTLE_MS,
                    profile: "pathlib.Path | None" = None,
                    login: bool = False) -> Capture:
    """The markup after the page has run, plus the JSON it fetched to build itself.

    The network log is the channel that matters most for a page whose data is not
    in its markup — and often the one that makes a browser unnecessary at runtime
    afterwards, because a rule can call the API the log revealed.

    `profile` names a persistent browser profile, so that a session a person established once is
    the session every later capture uses — the browser's own mechanism, which works for any site
    and never asks this tool to hold a credential. `login` opens a *visible* window and waits for
    the person to finish signing in before the page is read.
    """
    import pathlib
    from playwright.sync_api import sync_playwright

    capture = Capture(url=url)
    with sync_playwright() as playwright:
        if profile is not None:
            # A persistent profile *is* the browser: there is no separate handle to launch, and
            # the session inside it is the whole point — cookies and storage live in that
            # directory, so a site that shows more to a signed-in visitor shows it here. A page
            # that still challenges is one a person solves in the window (`login` waits for it).
            browser = None
            context = launch_profile(playwright, Path(profile), headful=login)
        else:
            browser = playwright.chromium.launch(headless=True, channel="chrome")
            context = browser.new_context(
                user_agent=unknown_url.UA, viewport={"width": 1440, "height": 900},
            )
        page = context.new_page()
        responses: list[Document] = []

        def on_response(response) -> None:
            try:
                if len(responses) >= MAX_NETWORK_DOCUMENTS:
                    return
                if response.request.resource_type not in ("xhr", "fetch"):
                    return
                if NOISE.search(response.url):
                    return
                if "json" not in (response.headers.get("content-type") or "").lower():
                    return
                # The declared length decides before the body is asked for: asking
                # for a megabyte of analytics JSON only to discard it is a round-trip
                # spent on nothing.
                if int(response.headers.get("content-length") or 0) > MAX_NETWORK_BODY:
                    return
                body = response.body()
                if not body or len(body) > MAX_NETWORK_BODY:
                    return
                responses.append(Document(name=f"network:{len(responses)}",
                                          text=body.decode("utf-8", "replace"),
                                          format="json",
                                          source_url=response.url))
            except Exception:  # noqa: BLE001 - a capture must not fail the run
                return

        page.on("response", on_response)
        final = url
        html = ""
        try:
            if login:
                # A session is established where a site expects one to be: its own front page.
                # Measured on a real gallery, whose protections challenge a deep, parameterised
                # URL in a fresh profile while the front page is reachable — and a session built
                # there is the session the deep page then sees.
                root = f"{urlparse(url).scheme}://{urlparse(url).netloc}/"
                try:
                    page.goto(root, wait_until="load", timeout=45_000)
                except Exception as error:  # noqa: BLE001 - the deep page is tried regardless
                    capture.notes.append(f"front page did not load: {type(error).__name__}")
                print(f"    先在 {root} 登录 / 过验证，完成后回到这个窗口按回车继续 ...")
                try:
                    input()
                except EOFError:      # no console to answer: carry on with what is there
                    pass
            response = page.goto(url, wait_until="load", timeout=45_000)
            capture.status = response.status if response else None
            page.wait_for_timeout(settle_ms)
            _scroll_until_settled(page)
            html = page.content()
            final = page.url
            # A JavaScript-driven page can be read before it has rendered: measured on iwara
            # (2026-10-11), whose second page came back as its own loading screen, so every rule read
            # nothing and the confirm page offered five empty fields. One more go, with a longer
            # settle, is what a person does when a page is not there yet.
            for attempt in range(SETTLE_RETRIES):
                if mentions_the_work(url, html, responses):
                    break
                capture.notes.append("the page did not mention the work yet; reading it again")
                try:
                    page.reload(wait_until="load", timeout=45_000)
                except Exception as error:  # noqa: BLE001 - reported, not raised
                    capture.notes.append(f"reload failed: {type(error).__name__}")
                    break
                page.wait_for_timeout(settle_ms * (attempt + 2))
                _scroll_until_settled(page)
                html = page.content()
                final = page.url
            if not mentions_the_work(url, html, responses):
                capture.notes.append(
                    "the page never mentioned the work it was asked for: what came back is not "
                    "that page, so every field will read nothing")
        except Exception as error:  # noqa: BLE001 - reported, not raised
            capture.notes.append(f"browser capture failed: {type(error).__name__}: "
                                 f"{str(error)[:80]}")
        finally:
            try:
                context.close()
            finally:
                if browser is not None:
                    browser.close()

    capture.final_url = final
    capture.content_type = "text/html"
    capture.documents = plain_documents(html) + responses
    if not responses:
        capture.notes.append("the network log held no usable JSON response")
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
