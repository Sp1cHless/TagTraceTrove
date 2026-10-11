"""The comic18 acquisition ladder: a rung that cannot get through hands over to the next one.

Measured on a real 18comic search (2026-09-22): `curl_cffi` raised
`SSLError: Connection closed abruptly` during the handshake, and because `acquire` only caught
`ChallengeDetected` there, the exception travelled all the way out of `run_once` — the run died with a
traceback instead of opening the browser, which is the rung that answers a check like that. Nothing
about the site changed between the crawl that worked and the one that did not; the ladder simply had
no rung for "this request did not get through".

The adapters are data in the SiteProbe home, so they are imported from where they live — the same way
`registry.load_fetcher` loads one.

Run:  .venv/Scripts/python.exe -m pytest -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder import paths  # noqa: E402
from src.generic import registry  # noqa: E402

INSTALLED = paths.home() / "installed"
sys.path.insert(0, str(INSTALLED))

curl_exceptions = pytest.importorskip("curl_cffi.requests.exceptions")
from comic18 import fetch as comic  # noqa: E402


@pytest.fixture()
def reader():
    """The adapter the runtime uses to read a work page: the written file, not the learned rules."""
    return registry.load_fetcher(registry.reader_for("18comic.vip"))


def test_the_ssl_failure_that_killed_a_real_run_is_a_handover_not_an_exception():
    assert issubclass(curl_exceptions.SSLError, comic.TRANSPORT_ERRORS)
    assert issubclass(curl_exceptions.ConnectionError, comic.TRANSPORT_ERRORS)
    assert issubclass(curl_exceptions.Timeout, comic.TRANSPORT_ERRORS)


def test_a_plain_request_that_cannot_get_through_opens_the_browser(monkeypatch, tmp_path):
    """The whole point of the ladder: a handshake failure is not a verdict about the page."""
    monkeypatch.setattr(comic, "plain_fetch", lambda url, cookies=None: (_ for _ in ()).throw(
        curl_exceptions.SSLError("BoringSSL SSL_connect: Connection closed abruptly")))

    opened: list[str] = []

    class StubBrowser:
        launched = True

        def __init__(self, profile):
            self.profile = profile

        def connect(self, url, allow_launch: bool = True) -> None:
            opened.append(url)

        def fetch(self, url: str) -> str:
            return "<html><body>the album page</body></html>"

        def cookies(self):
            return []

        def close(self) -> None:
            pass

    monkeypatch.setattr(comic, "BrowserFetcher", StubBrowser)
    messages: list[str] = []

    body = comic.acquire(
        registry.reader_for("18comic.vip"),
        "https://18comic.vip/search/photos?search_query=x",
        tmp_path / "cached.html", "search_x",
        {"progress": messages.append, "profile_dir": tmp_path / "profile"},
        {},
    )

    assert body is not None and "the album page" in body
    assert opened, "the browser rung has to be reached"
    assert any("plain request failed" in message for message in messages), (
        "and the person is told which rung fell over")
