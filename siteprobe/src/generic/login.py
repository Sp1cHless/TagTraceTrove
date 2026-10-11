"""Log a site in once, so the adapter that crawls it can use that session.

Why this is a door of its own. Two of the shipped sites read something only a signed-in browser can
see (18comic's favourites). A person establishes that session by hand — the tool never sees a
password and never stores one — and two things make it a tool job instead of a manual one:

* the browser profile has to be **the same one the adapter reads**, which is a per-host directory
  under the tool's home, not whichever profile the person's own Chrome happens to use;
* the cookies have to reach the adapter's **own** file, whose name and shape are the adapter's
  business — so the tool asks the adapter to write them rather than guessing a format.

    python login.py <url or site key>

Exit code is the verdict, the same three answers every other door gives:

    0  the session was written, and the adapter can use it
    2  the input names no site this tool has an adapter for
    1  the browser could not be opened, or the session could not be written
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .registry import RegistryError, load_fetcher, site_for_url
from .registry import get_for as get_template_for
from .site_api import _profile_dir
from .registry import site_keys


def looks_like_an_address(text: str) -> bool:
    return text[:7].casefold() == "http://" or text[:8].casefold() == "https://"


def template_for(text: str) -> Any:
    """The adapter a URL — or a site key — belongs to."""
    if looks_like_an_address(text):
        template = site_for_url(text)
        if template is None:
            known = ", ".join(sorted(site_keys()))
            raise RegistryError(
                f"no adapter claims {text!r}; sites with one: {known}", "NO_MATCH"
            )
        return template
    return get_template_for(text)


def entry_url(template: Any, text: str) -> str:
    """Where the browser opens first.

    The site's front page rather than the page the person pasted: a session is established where the
    site expects one, which is what the deep, parameterised page then sees — measured on a real
    gallery whose protections challenged a deep URL in a fresh profile while the front page was
    reachable.
    """
    if looks_like_an_address(text):
        parsed = urlparse(text)
        return f"{parsed.scheme}://{parsed.netloc}/"
    host = template.hosts[0] if template.hosts else template.key
    return f"https://{host}/"


def sign_in(profile: Path, url: str) -> list[dict[str, Any]]:
    """Open the profile, let the person sign in, and take the cookies they ended up with."""
    try:
        from playwright.sync_api import sync_playwright  # noqa: PLC0415 - only this door needs it
        from ..builder.capture import launch_profile  # noqa: PLC0415
    except ImportError as error:  # noqa: BLE001 - the door reports it as a plain failure
        raise RuntimeError(
            "playwright is not installed here; run 登录.bat, which prepares the browser extra"
        ) from error

    with sync_playwright() as playwright:
        try:
            # The Builder's own launcher: one place decides which browser, which user agent and
            # which profile flags, or the session this door writes is not the one a crawl reads.
            context = launch_profile(playwright, profile, headful=True)
        except Exception as error:  # noqa: BLE001 - the browser's own message is the useful one
            detail = str(error).splitlines()[0] if str(error) else type(error).__name__
            hint = ("close any browser already using this profile and try again"
                    if "ProcessSingleton" in str(error) or "in use" in str(error)
                    else "Google Chrome has to be installed, or run `playwright install chromium`")
            raise RuntimeError(
                f"could not open the browser profile {profile} ({detail}); {hint}"
            ) from error
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(url, wait_until="load", timeout=60_000)
            print()
            print(f"    先在 {url} 登录 / 过验证。")
            print("    在 T³ 里：回到页面点「我已完成登录」。")
            print("    直接跑这个 bat 时：在本窗口按回车继续。")
            print("    完成后那个浏览器窗口由工具关闭；会话已经写进 profile。")
            try:
                input()
            except EOFError:      # no console to answer: carry on with whatever session exists
                pass
            return context.cookies()
        finally:
            context.close()


def write_cookies(template: Any, profile: Path, cookies: list[dict[str, Any]]) -> str:
    """Hand the session to the adapter's own writer, or fall back to one place of our own.

    A site knows how it persists a session — 18comic's fetcher reads its cookies back from a file
    whose name and shape it owns — so the tool asks it to write rather than writing a format of its
    own that the adapter would then not read.
    """
    module = None
    try:
        module = load_fetcher(template)
    except RegistryError:
        module = None
    writer = getattr(module, "save_cookies", None) if module is not None else None
    if callable(writer):
        writer(profile, cookies)
        return "该站适配器自己的 cookie 文件（由适配器写入）"
    target = profile.parent / "session-cookies.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(cookies, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(target)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="login",
        description="Sign a site in once, into the profile its adapter reads.",
    )
    parser.add_argument("input", nargs="?", default="",
                        help="a URL on the site, or its key (18comic.vip)")
    args = parser.parse_args(argv)

    text = args.input.strip()
    if not text:
        print("[ERROR] Nothing entered.")
        return 2
    try:
        template = template_for(text)
    except RegistryError as error:
        print(f"[ERROR] {error}")
        return 2

    profile = _profile_dir(template)
    profile.mkdir(parents=True, exist_ok=True)
    print(f"site:    {template.key} ({template.display_name})")
    print(f"profile: {profile}")

    try:
        cookies = sign_in(profile, entry_url(template, text))
    except RuntimeError as error:
        print(f"[ERROR] {error}")
        return 1

    written = write_cookies(template, profile, cookies)
    print(f"[OK] {len(cookies)} cookie(s) saved: {written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
