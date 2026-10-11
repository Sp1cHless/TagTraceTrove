"""The shared media downloader: whose transport reads the images, and what a failure says.

The bug these tests pin was measured on a real generated adapter (a bilinovel cover, 2026-10-04):
the run read the page through the impersonating transport (`unknown_url.fetch`) and downloaded
images through plain `urllib` — the site answered the page with 200 and the cover with
`403 Forbidden`. `download_image` swallows that ("a missing image never fails a record"), so the
export carried a cover URL and no bytes; T³'s import stores only what is on disk, so the preview
— which shows the site's own picture — had a cover and the imported Entry did not.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic import media  # noqa: E402


def test_an_image_is_fetched_through_the_same_transport_as_the_page(monkeypatch):
    """`fetch_bytes` impersonates a browser when curl_cffi is installed.

    The page reader and the image reader are one site's two requests, seconds apart; a site that
    checks who is asking can serve one and refuse the other, and the mismatch is invisible until a
    person imports a work and its cover is gone.
    """
    seen: dict[str, object] = {}
    fake = type("Response", (), {"content": b"\xff\xd8\xff" + b"0" * 8, "status_code": 200})()

    def fake_get(url, **kwargs):
        seen["impersonate"] = kwargs.get("impersonate")
        seen["referer"] = (kwargs.get("headers") or {}).get("Referer")
        return fake

    import src.generic.media as module
    monkeypatch.setattr(module, "USER_AGENT", "t3-test", raising=False)
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "curl_cffi":
            import types
            module = types.ModuleType("curl_cffi")
            requests = types.ModuleType("curl_cffi.requests")
            requests.get = fake_get
            module.requests = requests
            return module
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    data = media.fetch_bytes("https://site.test/cover.jpg", referer="https://site.test/work/1")

    assert data == fake.content
    assert seen["impersonate"] == "chrome"
    assert seen["referer"] == "https://site.test/work/1"


def test_a_cover_failure_is_said_twice_not_swallowed(tmp_path):
    """A failed cover names the work in the summary, and the record is honestly without one.

    `download_image` returning None is right — one image must not fail a work — but the two places
    that *say* something are the contract: the run summary counts it, and `missing_media` names the
    work at the end so a re-run can fetch it. This test pins that both fire for the same failure.
    """
    def refusing(url):
        raise RuntimeError("403")

    record = {"source_id": "w1",
              "cover": {"url": "https://site.test/cover.jpg"}}
    stats = media.download_record_media(record, tmp_path / "w1", fetch=refusing)
    assert stats == {"cover": 0, "previews": 0, "failed": 1}
    assert "local_path" not in record["cover"]

    # The run's own last-word check names the work, so "re-run to fetch them" is actionable.
    gaps = media.missing_media([record], tmp_path)
    assert gaps == ["w1 (cover)"]
