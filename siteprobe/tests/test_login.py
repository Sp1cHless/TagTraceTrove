"""The login door (`login.py`): which site, which profile, and whose cookie file.

The browser leg needs a person and a screen, so what is pinned here is everything around it: that a
URL or a key names the right adapter, that the browser is sent to the site's front page rather than to
the deep page somebody pasted, and that the cookies are handed to the **adapter's own** writer instead
of a format this door invented. That last one is the part that decides whether a crawl can read the
session back at all.

Run:  .venv/Scripts/python.exe -m pytest -q
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic import login  # noqa: E402
from src.generic import registry  # noqa: E402
from src.generic.registry import RegistryError  # noqa: E402

SITE = {
    "schema_version": 1, "key": "demo.test", "display_name": "Demo", "tool": "demo",
    "source_site": "demo.test", "export_group": "demo_test", "media_id_prefix": "demo",
    "hosts": ["demo.test", "www.demo.test"],
    "targets": {"work": {"label": "作品", "single": True,
                         "url_pattern": r"^https?://(?:www\.)?demo\.test/work/(\d+)"}},
    "documents": {"work": {"page": {"format": "html"}}},
    "work": {"fields": {"title": {"from": "html", "select": "h1"}}},
    "session": {"profile_dir": "session/demo-profile"},
}


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """A home with one adapter, and the cookie writer that adapter owns."""
    folder = tmp_path / "home" / "installed" / "demo"
    folder.mkdir(parents=True)
    (folder / "site.json").write_text(json.dumps(SITE), encoding="utf-8")
    (folder / "fetch.py").write_text(
        "def save_cookies(profile, cookies):\n"
        "    import json, pathlib\n"
        "    target = pathlib.Path(profile).parent / 'demo-cookies.json'\n"
        "    target.write_text(json.dumps(cookies), encoding='utf-8')\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("SITEPROBE_HOME", str(tmp_path / "home"))
    registry.forget_adapters()
    try:
        yield folder
    finally:
        registry.forget_adapters()


def test_a_url_or_a_key_names_the_same_adapter(home):
    by_url = login.template_for("https://www.demo.test/work/42")
    by_key = login.template_for("demo.test")

    assert by_url.key == by_key.key == "demo.test"


def test_a_url_no_adapter_claims_says_so(home):
    with pytest.raises(RegistryError) as refusal:
        login.template_for("https://elsewhere.test/x")

    assert refusal.value.code == "NO_MATCH"
    assert "demo.test" in str(refusal.value), "the message names the sites that could be meant"


def test_the_browser_opens_the_front_page_not_the_page_that_was_pasted(home):
    """A session is established where a site expects one, which is what the deep page then sees."""
    template = login.template_for("https://demo.test/work/42")

    assert login.entry_url(template, "https://demo.test/work/42") == "https://demo.test/"
    assert login.entry_url(template, "demo.test") == "https://demo.test/"


def test_cookies_go_to_the_adapters_own_writer(home):
    """The adapter owns the file its crawl reads back; a door that writes its own format is how a
    session is established and then not found."""
    template = login.template_for("demo.test")
    profile = home / "session" / "demo-profile"
    profile.mkdir(parents=True)

    written = login.write_cookies(template, profile, [{"name": "sid", "value": "1"}])

    assert "适配器" in written, "the door says the adapter wrote it"
    assert json.loads((profile.parent / "demo-cookies.json").read_text(encoding="utf-8")) == [
        {"name": "sid", "value": "1"}]


def test_a_site_without_a_writer_gets_one_file_of_our_own(tmp_path, monkeypatch):
    folder = tmp_path / "home" / "installed" / "plain"
    folder.mkdir(parents=True)
    (folder / "site.json").write_text(
        json.dumps({**SITE, "key": "plain.test", "tool": "plain", "source_site": "plain.test",
                    "hosts": ["plain.test"], "session": {}}), encoding="utf-8")
    monkeypatch.setenv("SITEPROBE_HOME", str(tmp_path / "home"))
    registry.forget_adapters()
    try:
        template = login.template_for("plain.test")
        profile = folder / "session" / "chrome-profile"
        profile.mkdir(parents=True)
        written = login.write_cookies(template, profile, [{"name": "sid", "value": "2"}])
    finally:
        registry.forget_adapters()

    assert written.endswith("session-cookies.json")
    assert (profile.parent / "session-cookies.json").is_file()


def test_nothing_entered_is_an_input_error_not_a_crash():
    assert login.main([]) == 2
    assert login.main(["https://no-such-site.test/x"]) == 2


def test_the_profile_is_the_one_the_adapter_declares(home):
    """`session.profile_dir` in the site's own file, read against the adapter's directory — the same
    profile a capture uses, so the person's sign-in is the session the crawl sees."""
    from src.generic.site_api import _profile_dir

    template = login.template_for("demo.test")

    assert _profile_dir(template) == (home / "session" / "demo-profile").resolve()
