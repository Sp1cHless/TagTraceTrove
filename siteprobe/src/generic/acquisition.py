"""Getting a document off a site — the one place the tool opens a browser.

Both halves of the tool need the same thing and used to have two of it: the **Builder** captured a
page to learn rules from (with a network log, a scroll, and a retry when a single-page app had not
rendered); the **runtime** fetched a page to run the rules back (HTTP only, except for a listing,
which reached back into the Builder's capture module). The plan's Phase B is to make that one thing
(§5-B): the extraction half moves here, into the generic layer, and the Builder calls it instead of
owning it.

What this module deliberately keeps apart, because the plan does:

* **a plan is data, not a per-site fetcher.** `AcquisitionPlan` is `http` or `browser`, with a
  profile, a settle, an optional network log — the same shape for every site.
* **an explicit mode is honoured, never downgraded.** A `browser` rule does not silently fall back to
  HTTP (which would read a shell and call it a page), and an HTTP rule does not open a window.
* **one session, many pages.** `session()` is a context manager, so a paginated listing opens Chrome
  **once** and reads every page in that context. Before this, the runtime called the Builder's
  capture once per page — a fresh browser per page of a listing.

The HTTP half stays exactly what it was (`unknown_url.fetch`), so no working site changes: this
module only decides *which* reader runs, and shares the browser engine between the two callers.
"""

from __future__ import annotations

import json
import re
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator
from urllib.parse import urlparse

from . import unknown_url

TIMEOUT_MS = 45_000
SETTLE_MS = 3500
#: How many times a page that has not rendered yet is read again, with a longer settle each time.
SETTLE_RETRIES = 2
# A page can fire hundreds of XHRs. The first few dozen carry everything a rule would want, and
# reading a body is a round-trip to the browser.
MAX_NETWORK_DOCUMENTS = 40
MAX_NETWORK_BODY = 512_000

# Telemetry, ads and fonts: nothing a rule would ever want, and most of what a raw network log
# contains.
NOISE = re.compile(
    r"google-analytics|googletagmanager|doubleclick|cloudflareinsights|umami"
    r"|sentry|facebook|hotjar|clarity|/beacon|/www/delivery/|exoclick|juicyads"
    r"|clickaine|adservice|/ads?/|font|\.woff|\.css",
    re.IGNORECASE,
)


@dataclass
class AcquisitionPlan:
    """How a page is read: the reader, and the handful of knobs that shape it.

    `mode` is the one decision (`http` or `browser`); everything else has the default the working
    sites already have, so a plan built from a legacy `"acquisition": "browser"` string behaves
    exactly as before.
    """

    mode: str = "http"
    profile: Path | None = None
    login: bool = False
    settle_ms: int = SETTLE_MS
    scroll: bool = True
    capture_network: bool = True
    retries: int = SETTLE_RETRIES
    timeout_ms: int = TIMEOUT_MS

    @property
    def browser(self) -> bool:
        return self.mode == "browser"


def plan_for(acquisition: Any, *, profile: Path | None = None, **overrides: Any) -> AcquisitionPlan:
    """A plan from a site's legacy declaration (`"browser"` / `"http"` / absent).

    The only string the tool ever wrote is `browser`; anything else — an absent key, `http`, a typo —
    is HTTP, because HTTP is the reader that was always the default and changing that for an unknown
    value would change every site that never declared one.
    """
    mode = "browser" if str(acquisition or "").strip().casefold() == "browser" else "http"
    plan = AcquisitionPlan(mode=mode, profile=profile)
    for key, value in overrides.items():
        if value is not None and hasattr(plan, key):
            setattr(plan, key, value)
    return plan


@dataclass
class NetworkResource:
    """One JSON response the page fetched, named the way a rule can point back at it."""

    name: str
    text: str
    url: str


@dataclass
class PageRead:
    """One address as read, before anything is interpreted."""

    url: str
    final_url: str = ""
    status: int | None = None
    content_type: str = ""
    html: str = ""
    resources: list[NetworkResource] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def readable(self) -> bool:
        """Whether a page actually came back — a status and some markup, not an empty shell.

        Mirrors the Builder's own rule (`captured_nothing`): a failed navigation is not an empty page
        but *no* page — `status: None`, an empty document — so a status with no body is not readable
        and neither is a body with a non-2xx status.
        """
        if not self.html.strip():
            return False
        return self.status is None or 200 <= self.status < 300


def _resource_url(resource: Any) -> str:
    """The address a response came from, for either this module's resource or the Builder's Document."""
    return str(getattr(resource, "url", None) or getattr(resource, "source_url", "") or "")


def mentions_the_work(url: str, html: str, responses: list[Any]) -> bool:
    """Whether a captured page is the page that was asked for.

    Measured on iwara (2026-10-11): the second page came back as the site's own loading screen —
    `<title>Loading | Iwara</title>`, no work name, no images, and not one API response — because the
    browser read it before the single-page app had rendered. Every rule then read nothing, and the
    confirm page offered five empty fields, which looks exactly like five broken rules and is not.

    The page says which work it is — but *not in its head*: the loading screen carried
    `<meta property="og:url" …>`, the address echoed into the head before anything had rendered, while
    its body held nothing of the work and it had made no request at all. So the body is what is
    searched, and the requests it made — on a site whose content is entirely behind JavaScript, the
    requests are where a rendered page says so.
    """
    wanted = [part for part in urlparse(url).path.split("/") if part]
    needles = [part.casefold() for part in wanted[-2:] if len(part) >= 4]
    if not needles:
        # Nothing in the address worth looking for (a bare origin, a short id): not a judgement this
        # can make, and a guard that guesses would refuse good pages.
        return True
    body = html.split("</head>", 1)[-1].casefold()
    requests = [_resource_url(document).casefold() for document in responses]
    return any(needle in haystack for needle in needles
               for haystack in [body, *requests])


def scroll_until_settled(page, rounds: int = 12) -> None:
    """Give a page that loads the rest of itself on scroll the chance to do so.

    Measured on a real search page: its markup held 31 of the 43 results, and the page's own scripts
    mentioned `scroll`, `ajax` and `infinite` — the rest arrive only once the viewport moves. The loop
    stops when the document stops growing: the plan's §17 terminal condition ("no new ids"), applied
    to one document.
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


def profile_for(host: str) -> Path:
    """Where this host's browser profile lives, unless a person names another directory.

    One directory per host, beside the sessions, and git-ignored: a profile holds cookies and tokens,
    so it is the person's to keep and never the repository's. The home comes from the registry, so
    the plan's Phase B move does not change where an existing profile lives.
    """
    from .registry import adapter_root

    return adapter_root() / "browser_profiles" / host


def launch_profile(playwright: Any, profile: Path, *, headful: bool) -> Any:
    """Open a persistent browser profile — the one place that does it.

    Two callers need exactly this browser: the capture that reads a page a person is signed into, and
    the login door that establishes that session. A second copy of these flags is how the two would
    drift into different browsers, different user agents or a profile that one of them cannot read
    back.

    Chrome through the channel, not Playwright's bundled Chromium: the bundled build is
    version-mismatched in this workspace, the download is large, and the system Chrome is the browser
    a person is already logged into. `navigator.webdriver` is removed only when a person is in the
    loop — Chrome is then being driven as the browser they signed into. Nothing else is spoofed.
    """
    profile = Path(profile)
    profile.mkdir(parents=True, exist_ok=True)
    return playwright.chromium.launch_persistent_context(
        user_data_dir=str(profile), headless=not headful, channel="chrome",
        user_agent=unknown_url.UA, viewport={"width": 1440, "height": 900},
        args=["--disable-blink-features=AutomationControlled"],
    )


class PageSession:
    """Reads addresses, reusing whatever the reader needs to reuse.

    The HTTP session is trivial — one fetch per address — and exists so the runtime's loop does not
    branch on the mode. The browser session is where reuse matters: one Chrome, one context, many
    pages.
    """

    def read(self, url: str, **options: Any) -> PageRead:  # pragma: no cover - overridden
        raise NotImplementedError


class HttpSession(PageSession):
    """The default reader: the markup as sent. No browser, no session, no rendering."""

    def read(self, url: str, **options: Any) -> PageRead:
        read = PageRead(url=url)
        referer = options.get("referer")
        try:
            if referer:
                status, body, content_type, final = unknown_url.fetch(url, referer=referer)
            else:
                # Called without the keyword when there is no referer: `unknown_url.fetch` is a seam
                # tests replace, and a stub that takes only the URL is the shape they have always had.
                status, body, content_type, final = unknown_url.fetch(url)
        except Exception as error:  # noqa: BLE001 - reported, not raised
            read.notes.append(f"fetch failed: {type(error).__name__}: {str(error)[:80]}")
            return read
        read.status = status
        read.content_type = content_type or ""
        read.final_url = final
        if not (200 <= status < 300):
            read.notes.append(f"HTTP {status}: the body was not read as a page")
            return read
        read.html = body.decode("utf-8", "replace")
        return read


class BrowserSession(PageSession):
    """One Chrome, opened once, that reads as many pages as it is asked to.

    The context is what the plan wants reused (§5-B.4): a listing's every page is read in the same
    signed-in context, so the second page does not pay for a new browser and does not lose the session
    the first page established.
    """

    def __init__(self, plan: AcquisitionPlan) -> None:
        self.plan = plan
        self._playwright: Any = None
        self._browser: Any = None
        self._context: Any = None

    def __enter__(self) -> "BrowserSession":
        from playwright.sync_api import sync_playwright

        self._playwright = sync_playwright().start()
        if self.plan.profile is not None:
            # A persistent profile *is* the browser: there is no separate handle to launch, and the
            # session inside it is the whole point — cookies and storage live in that directory.
            self._context = launch_profile(self._playwright, Path(self.plan.profile),
                                           headful=self.plan.login)
        else:
            self._browser = self._playwright.chromium.launch(headless=not self.plan.login,
                                                             channel="chrome")
            self._context = self._browser.new_context(
                user_agent=unknown_url.UA, viewport={"width": 1440, "height": 900})
        return self

    def __exit__(self, *exception: Any) -> None:
        try:
            if self._context is not None:
                self._context.close()
        finally:
            try:
                if self._browser is not None:
                    self._browser.close()
            finally:
                if self._playwright is not None:
                    self._playwright.stop()

    def read(self, url: str, *, settle_ms: int | None = None, scroll: bool | None = None,
             capture_network: bool | None = None, retries: int | None = None,
             mention: Callable[[str, list[Any]], bool] | None = None,
             **options: Any) -> PageRead:
        settle = self.plan.settle_ms if settle_ms is None else settle_ms
        should_scroll = self.plan.scroll if scroll is None else scroll
        want_network = self.plan.capture_network if capture_network is None else capture_network
        attempts = self.plan.retries if retries is None else retries
        timeout = self.plan.timeout_ms

        read = PageRead(url=url)
        context = self._context
        page = context.new_page()
        responses: list[NetworkResource] = []

        def on_response(response) -> None:
            if not want_network or len(responses) >= MAX_NETWORK_DOCUMENTS:
                return
            try:
                if response.request.resource_type not in ("xhr", "fetch"):
                    return
                if NOISE.search(response.url):
                    return
                if "json" not in (response.headers.get("content-type") or "").lower():
                    return
                # The declared length decides before the body is asked for: asking for a megabyte of
                # analytics JSON only to discard it is a round-trip spent on nothing.
                if int(response.headers.get("content-length") or 0) > MAX_NETWORK_BODY:
                    return
                body = response.body()
                if not body or len(body) > MAX_NETWORK_BODY:
                    return
                responses.append(NetworkResource(name=f"network:{len(responses)}",
                                                 text=body.decode("utf-8", "replace"),
                                                 url=response.url))
            except Exception:  # noqa: BLE001 - a capture must not fail the run
                return

        page.on("response", on_response)
        final = url
        html = ""
        try:
            if self.plan.login:
                # A session is established where a site expects one: its own front page. Measured on a
                # real gallery, whose protections challenge a deep, parameterised URL in a fresh
                # profile while the front page is reachable.
                root = f"{urlparse(url).scheme}://{urlparse(url).netloc}/"
                try:
                    page.goto(root, wait_until="load", timeout=timeout)
                except Exception as error:  # noqa: BLE001 - the deep page is tried regardless
                    read.notes.append(f"front page did not load: {type(error).__name__}")
                print(f"    先在 {root} 登录 / 过验证，完成后回到这个窗口按回车继续 ...")
                try:
                    input()
                except EOFError:  # no console to answer: carry on with what is there
                    pass
            response = page.goto(url, wait_until="load", timeout=timeout)
            read.status = response.status if response else None
            page.wait_for_timeout(settle)
            if should_scroll:
                scroll_until_settled(page)
            html = page.content()
            final = page.url
            # A JavaScript-driven page can be read before it has rendered: measured on iwara
            # (2026-10-11), whose second page came back as its own loading screen. One more go, with a
            # longer settle, is what a person does when a page is not there yet.
            if mention is not None:
                for attempt in range(attempts):
                    if mention(html, responses):
                        break
                    read.notes.append("the page did not mention the work yet; reading it again")
                    try:
                        page.reload(wait_until="load", timeout=timeout)
                    except Exception as error:  # noqa: BLE001 - reported, not raised
                        read.notes.append(f"reload failed: {type(error).__name__}")
                        break
                    page.wait_for_timeout(settle * (attempt + 2))
                    if should_scroll:
                        scroll_until_settled(page)
                    html = page.content()
                    final = page.url
                if not mention(html, responses):
                    read.notes.append(
                        "the page never mentioned the work it was asked for: what came back is not "
                        "that page, so every field will read nothing")
        except Exception as error:  # noqa: BLE001 - reported, not raised
            read.notes.append(f"browser capture failed: {type(error).__name__}: {str(error)[:80]}")
        finally:
            try:
                page.close()
            except Exception:  # noqa: BLE001 - a closed page is fine
                pass

        read.final_url = final
        read.content_type = "text/html"
        read.html = html
        read.resources = responses
        if want_network and not responses:
            read.notes.append("the network log held no usable JSON response")
        return read


@contextmanager
def session(plan: AcquisitionPlan) -> Iterator[PageSession]:
    """One reader, opened once, for however many pages the caller reads.

    A browser plan yields a live `BrowserSession` (so a paginated listing reads every page in one
    context); an HTTP plan yields the stateless `HttpSession`. The caller's loop does not branch on
    the mode — which is the point.
    """
    if plan.browser:
        with BrowserSession(plan) as opened:
            yield opened
    else:
        yield HttpSession()


def read_page(url: str, plan: AcquisitionPlan, *,
              mention: Callable[[str, list[Any]], bool] | None = None) -> PageRead:
    """Read one address under a plan, opening and closing whatever the plan needs."""
    with session(plan) as reader:
        return reader.read(url, mention=mention)
