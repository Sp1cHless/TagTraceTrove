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
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Iterator
from urllib.parse import urlparse

from . import unknown_url

TIMEOUT_MS = 45_000
SETTLE_MS = 3500
#: How many times a page that has not rendered yet is read again, with a longer settle each time.
SETTLE_RETRIES = 2
TRANSIENT_HTTP_STATUSES = {408, 429, 500, 502, 503, 504}
RETRY_DELAYS_MS = (2_000, 5_000)
MAX_RETRY_WAIT_MS = 30_000


def retry_delay_ms(response: Any, attempt: int) -> int | None:
    """Respect Retry-After; do not retry early when the requested wait exceeds our bound."""
    delay = RETRY_DELAYS_MS[min(attempt, len(RETRY_DELAYS_MS) - 1)]
    value = str((getattr(response, "headers", {}) or {}).get("retry-after", "")).strip()
    if value:
        try:
            seconds = int(value)
        except ValueError:
            try:
                until = parsedate_to_datetime(value)
                until = until if until.tzinfo is not None else until.replace(tzinfo=timezone.utc)
                seconds = max(0, (until - datetime.now(timezone.utc)).total_seconds())
            except (TypeError, ValueError, OverflowError):
                seconds = 0
        delay = max(delay, int(seconds * 1000))
    return delay if delay <= MAX_RETRY_WAIT_MS else None
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
    manual_verification: bool = False
    verification_timeout_ms: int = 300_000

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
    manual_verified: bool = False

    @property
    def readable(self) -> bool:
        """Whether a page actually came back — a status and some markup, not an empty shell.

        Mirrors the Builder's own rule (`captured_nothing`): a failed navigation is not an empty page
        but *no* page — `status: None`, an empty document — so a status with no body is not readable
        and neither is a body with a non-2xx status.
        """
        if not self.html.strip():
            return False
        if unknown_url.challenge_of(self.html):
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


def windows_default_browser_channel() -> str | None:
    """Only map known Windows URL associations to supported Playwright channels."""
    try:
        import winreg
    except ImportError:
        return None
    for scheme in ("https", "http"):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                rf"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\{scheme}\UserChoice") as key:
                prog_id = str(winreg.QueryValueEx(key, "ProgId")[0]).casefold()
        except OSError:
            continue
        if prog_id.startswith("chromehtml"):
            return "chrome"
        if prog_id == "msedgehtm":
            return "msedge"
        if prog_id.startswith("firefoxurl"):
            return "firefox"
        return None
    return None


def bundled_browser_options(playwright: Any, engine: str = "chromium") -> dict[str, str]:
    """Resolve the browser revision belonging to this Playwright runtime, never system Chrome."""
    executable = Path(getattr(playwright, engine).executable_path)
    if not executable.is_file():
        raise RuntimeError(f"T3 自带浏览器（{engine}）文件缺失或版本不匹配，请重新解压完整安装包后重试。")
    return {"executable_path": str(executable)}


def launch_browser(playwright: Any, *, profile: Path | None = None, **options: Any) -> Any:
    """Prefer the supported default browser; a missing channel uses the shipped browser."""
    from playwright.sync_api import Error

    channel = windows_default_browser_channel()
    if channel == "firefox":
        # Playwright uses its patched Firefox, not the user's installed binary.
        # A Firefox profile must never share Chromium's cookies/database files.
        firefox_options = dict(options)
        firefox_options.pop("user_agent", None)
        arguments = [arg for arg in firefox_options.get("args", [])
                     if not arg.startswith("--disable-blink-features=")]
        if arguments:
            firefox_options["args"] = arguments
        else:
            firefox_options.pop("args", None)
        launch = (playwright.firefox.launch if profile is None
                  else playwright.firefox.launch_persistent_context)
        if profile is not None:
            firefox_options["user_data_dir"] = str(Path(profile) / "firefox")
        return launch(**bundled_browser_options(playwright, "firefox"), **firefox_options)
    launch = (playwright.chromium.launch if profile is None
              else playwright.chromium.launch_persistent_context)
    if profile is not None:
        options["user_data_dir"] = str(profile)
    if channel is not None:
        try:
            return launch(channel=channel, **options)
        except Error as error:
            message = str(error).casefold()
            # A stale default association must not require another browser installation.
            # Profile locks, permissions and genuine startup errors remain visible.
            if "is not found" not in message and "executable doesn't exist" not in message:
                raise
    return launch(**bundled_browser_options(playwright), **options)


def browser_context_options(browser: Any) -> dict[str, Any]:
    options: dict[str, Any] = {"viewport": {"width": 1440, "height": 900}}
    if getattr(getattr(browser, "browser_type", None), "name", None) != "firefox":
        options["user_agent"] = unknown_url.UA
    return options


def launch_profile(playwright: Any, profile: Path, *, headful: bool) -> Any:
    """Open a persistent browser profile — the one place that does it.

    Two callers need exactly this browser: the capture that reads a page a person is signed into, and
    the login door that establishes that session. A second copy of these flags is how the two would
    drift into different browsers, different user agents or a profile that one of them cannot read
    back.

    Capture and login share Chrome/Edge, dedicated Firefox and the Chromium fallback.
    The profile stays in T3's per-host directory. Nothing else is spoofed.
    """
    profile = Path(profile)
    profile.mkdir(parents=True, exist_ok=True)
    return launch_browser(
        playwright, profile=profile, headless=not headful,
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
        self._headful = plan.login

    def __enter__(self) -> "BrowserSession":
        from playwright.sync_api import sync_playwright

        self._playwright = sync_playwright().start()
        try:
            if self.plan.profile is not None:
                # A persistent profile *is* the browser: there is no separate handle to launch.
                self._context = launch_profile(self._playwright, Path(self.plan.profile),
                                               headful=self.plan.login)
            else:
                self._browser = launch_browser(self._playwright, headless=not self.plan.login)
                self._context = self._browser.new_context(**browser_context_options(self._browser))
        except Exception:
            self.__exit__()
            raise
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

    def _visible_page(self, url: str, on_response: Callable) -> Any:
        """Reopen the same profile visibly; the person, not the tool, solves the check."""
        state = self._context.storage_state() if self.plan.profile is None else None
        self._context.close()
        self._context = None
        if self._browser is not None:
            self._browser.close()
            self._browser = None
        self._headful = True
        if self.plan.profile is not None:
            self._context = launch_profile(self._playwright, self.plan.profile, headful=True)
        else:
            self._browser = launch_browser(self._playwright, headless=False)
            self._context = self._browser.new_context(
                **browser_context_options(self._browser), storage_state=state)
        page = self._context.new_page()
        page.on("response", on_response)
        response = page.goto(url, wait_until="domcontentloaded", timeout=self.plan.timeout_ms)
        return page, response

    def _wait_for_verification(self, page: Any, url: str, read: PageRead) -> tuple[str, str]:
        """Observe manual completion without clicking, solving or repeatedly reloading."""
        print("[VERIFY] 请在弹出的浏览器中手动完成网站安全验证；通过后自动继续，请勿关闭窗口。", flush=True)
        expected = urlparse(url)
        elapsed = 0
        while elapsed < self.plan.verification_timeout_ms:
            if page.is_closed():
                read.notes.append("manual verification cancelled: the browser page was closed")
                return "", url
            html, final = page.content(), page.url
            current = urlparse(final)
            if (not unknown_url.challenge_of(html) and html.strip()
                    and current.netloc == expected.netloc and current.path == expected.path
                    and read.status is not None and 200 <= read.status < 300):
                read.manual_verified = True
                read.notes.append("manual verification completed in the browser profile")
                print("[VERIFY] 已读取到验证后的原作品页面，继续采集。", flush=True)
                return html, final
            step = min(1000, self.plan.verification_timeout_ms - elapsed)
            page.wait_for_timeout(step)
            elapsed += step
            if elapsed and elapsed % 30_000 == 0:
                print("[VERIFY] 仍在等待手动验证；未通过前不会生成候选。", flush=True)
        read.notes.append("manual verification timed out; no work page was captured")
        print("[VERIFY] 验证尚未通过，已停止本次采集。", flush=True)
        return "", url

    def _navigate_with_retries(self, page: Any, url: str, read: PageRead,
                               resources: list[NetworkResource], retries: int) -> Any:
        from playwright.sync_api import TimeoutError as NavigationTimeout

        retry_count = max(0, retries)
        for attempt in range(retry_count + 1):
            response = None
            read.status = None
            try:
                response = page.goto(url, wait_until="load", timeout=self.plan.timeout_ms)
                read.status = response.status if response else None
                if (read.status not in TRANSIENT_HTTP_STATUSES
                        or unknown_url.challenge_of(page.content())):
                    return response
                reason = f"HTTP {read.status}"
            except NavigationTimeout:
                reason = "页面加载超时"
                if attempt >= retry_count:
                    read.notes.append("navigation retries exhausted after timeout")
                    print(f"[RETRY] {reason}，已达到 {retry_count} 次重试上限。", flush=True)
                    raise
            if attempt >= retry_count:
                read.notes.append(f"navigation retries exhausted: {reason}")
                print(f"[RETRY] {reason}，已达到 {retry_count} 次重试上限。", flush=True)
                return response
            delay = retry_delay_ms(response, attempt)
            if delay is None:
                read.notes.append("Retry-After exceeds the 30-second wait limit; not retrying early")
                print("[STOP] 网站要求等待超过 30 秒，请稍后重试；本次不提前重复请求。", flush=True)
                return response
            print(f"[RETRY] {reason}，{delay / 1000:g} 秒后重试（{attempt + 1}/{retry_count}）：{url}", flush=True)
            read.notes.append(f"{reason}; retry {attempt + 1}/{retry_count} after {delay}ms")
            page.wait_for_timeout(delay)
            resources.clear()
        return None

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
            if (response.request.resource_type == "document"
                    and getattr(response, "frame", None) is getattr(page, "main_frame", None)):
                read.status = response.status
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
            response = self._navigate_with_retries(page, url, read, responses, attempts)
            page.wait_for_timeout(settle)
            html = page.content()
            final = page.url
            challenge = unknown_url.challenge_of(html)
            if challenge:
                read.notes.append(f"{challenge} verification page was returned, not a work page")
                if not self.plan.manual_verification:
                    html = ""
                else:
                    if not self._headful:
                        responses.clear()
                        page, response = self._visible_page(url, on_response)
                        read.status = response.status if response else None
                    html, final = self._wait_for_verification(page, url, read)
                if not html:
                    read.final_url, read.html, read.resources = final, "", []
                    return read
            if read.status is not None and not (200 <= read.status < 300):
                read.notes.append(f"HTTP {read.status}: the body was not read as a page")
                read.final_url, read.html, read.resources = final, "", []
                return read
            if should_scroll:
                scroll_until_settled(page)
            # A JavaScript-driven page can be read before it has rendered: measured on iwara
            # (2026-10-11), whose second page came back as its own loading screen. One more go, with a
            # longer settle, is what a person does when a page is not there yet.
            if mention is not None:
                for attempt in range(attempts):
                    if unknown_url.challenge_of(html):
                        break
                    if mention(html, responses):
                        break
                    read.notes.append("the page did not mention the work yet; reading it again")
                    try:
                        self._navigate_with_retries(page, url, read, responses, attempts)
                    except Exception as error:  # noqa: BLE001 - reported, not raised
                        read.notes.append(f"reload failed: {type(error).__name__}")
                        break
                    page.wait_for_timeout(settle * (attempt + 2))
                    if should_scroll:
                        scroll_until_settled(page)
                    html = page.content()
                    final = page.url
                    if read.status is not None and not (200 <= read.status < 300):
                        html = ""
                        break
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
        read.html = "" if unknown_url.challenge_of(html) else html
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
