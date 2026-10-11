"""Level 0: the reader for a URL no site template claims.

No network. Every case builds a page in memory and a fake transport that serves
it, so the tests pin this reader's own behaviour and nothing about a live site.

Two of these are regressions for defects that made the reader lie:

* an error page's ``<title>`` being reported as the work's title, because the
  response status was recorded but never checked;
* a cover URL being corrupted by a second entity unescape, turning
  ``?w=1&copy=2`` into ``?w=1©=2`` — a URL that can only ever 404, reported to the
  user as "no cover candidate was usable".

Run:  .venv/Scripts/python.exe -m pytest -q
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic import unknown_url  # noqa: E402
from src.generic.level0_link import read_link  # noqa: E402
from src.generic.unknown_url import (  # noqa: E402
    CLAIMED_FIELDS,
    comparison_url,
    extension_for,
    format_report,
    is_site_name,
    mentions_host,
    outcome_kind,
    read_work,
)

PAGE = "https://site.example/view/77"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


class FakeNet:
    """A page plus its media, keyed by URL. Records what was asked for."""

    def __init__(self) -> None:
        self.pages: dict[str, tuple[int, bytes, str, str]] = {}
        self.media: dict[str, tuple[int, bytes, str]] = {}
        self.requests: list[tuple[str, str | None]] = []

    def page(self, url: str, body: str, *, status: int = 200,
             content_type: str = "text/html; charset=utf-8", final: str | None = None) -> FakeNet:
        self.pages[url] = (status, body.encode("utf-8"), content_type, final or url)
        return self

    def image(self, url: str, data: bytes = JPEG, *,
              content_type: str = "image/jpeg", status: int = 200) -> FakeNet:
        self.media[url] = (status, data, content_type)
        return self

    def __call__(self, url: str, *, referer: str | None = None) -> tuple[int, bytes, str, str]:
        self.requests.append((url, referer))
        if url in self.pages:
            return self.pages[url]
        if url in self.media:
            status, data, content_type = self.media[url]
            return status, data, content_type, url
        return 404, b"", "text/plain", url

    @property
    def media_requests(self) -> list[str]:
        return [url for url, _referer in self.requests if url in self.media]


def install(monkeypatch, net: FakeNet, size: tuple[int, int] | None = (600, 800)) -> FakeNet:
    monkeypatch.setattr(unknown_url, "fetch", net)
    monkeypatch.setattr(unknown_url, "inspect_image", lambda data: size)
    return net


# --- the happy path -------------------------------------------------------- #

def test_a_page_with_og_tags_yields_a_title_and_a_downloaded_cover(tmp_path, monkeypatch):
    net = install(monkeypatch, FakeNet()
                  .page(PAGE, '<meta property="og:title" content="A Work">'
                              '<meta property="og:image" content="/cover.jpg">')
                  .image("https://site.example/cover.jpg", JPEG))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "ok"
    assert result["kind"] == "found"
    assert result["title"] == "A Work"
    assert result["title_from"] == "meta:og:title"
    assert result["title_verified"] is True
    # The deliverable is the bytes, not the URL.
    saved = Path(result["cover"])
    assert saved.parent == tmp_path
    assert saved.read_bytes() == JPEG
    assert result["cover_from"] == "meta"
    assert result["cover_verified"] is True
    assert result["cover_size"] == "600x800"


def test_the_source_url_survives_a_redirect(tmp_path, monkeypatch):
    """The final URL is the work's identity, and relative covers resolve against it."""
    install(monkeypatch, FakeNet()
            .page("http://sho.rt/x", '<meta property="og:title" content="T">'
                                     '<meta property="og:image" content="cover.jpg">',
                  final=PAGE)
            .image("https://site.example/view/cover.jpg"))
    result = read_work("http://sho.rt/x", save_dir=tmp_path)

    assert result["input_url"] == "http://sho.rt/x"
    assert result["source_url"] == PAGE
    assert result["cover_source"] == "https://site.example/view/cover.jpg"


def test_a_script_jsonld_cover_is_used_when_there_is_no_og_image(tmp_path, monkeypatch):
    body = ('<title>From JSON-LD</title>'
            '<script type="application/ld+json">'
            '{"@type":"ComicStory","name":"A Work","image":{"url":"/i/9.jpg"}}'
            '</script>')
    install(monkeypatch, FakeNet().page(PAGE, body).image("https://site.example/i/9.jpg"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "ok"
    # The work node names the work; <title> is the fallback, not the preference.
    assert result["title"] == "A Work"
    assert result["title_from"] == "jsonld:name"
    assert result["cover_from"] == "jsonld"


def test_an_image_only_page_is_still_readable(tmp_path, monkeypatch):
    install(monkeypatch, FakeNet()
            .page(PAGE, '<h1>A Work</h1><img class="main-cover" src="/big.jpg" width="800">')
            .image("https://site.example/big.jpg"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "ok"
    assert result["title"] == "A Work"
    # A heading is page text, not a declaration: reported, but not trusted.
    assert result["title_verified"] is False
    assert result["cover_from"] == "img"


# --- covers a lazy-loading site hides from a first look -------------------- #

LAZY_COVER = "https://cdn.example/upload2/book/id/77/cover_1.jpg"


def test_a_lazy_cover_behind_a_placeholder_src_is_still_found(tmp_path, monkeypatch):
    """Measured on a real site, and the reason the source attributes are ordered.

    The page put a 1px placeholder in `src` and the cover in `data-original`.
    Reading `src` first found the placeholder, stopped, and never looked at the
    real URL — so the cover was reported missing while it sat in the HTML.
    """
    net = install(monkeypatch, FakeNet()
                  .page(PAGE, '<title>t</title>'
                              '<img class="lazy" src="/static/images/imagecover_s.png"'
                              f'     data-original="{LAZY_COVER}">')
                  .image(LAZY_COVER))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "ok"
    assert result["cover_source"] == LAZY_COVER
    # The placeholder was not even fetched: it is chrome, and the real URL is
    # known, so there is nothing to learn from trying it first.
    assert net.media_requests == [LAZY_COVER]


def test_a_cover_served_from_a_static_path_is_not_dismissed_as_chrome(tmp_path, monkeypatch):
    """`static` in a path is a shared CDN convention, not a sign of a logo.

    It was a hint once, matched against the whole URL, which threw away every
    cover on any site that serves images from `…/static/…`.
    """
    url = "https://cdn.example/static/upload2/book/id/77/cover_1.jpg"
    net = install(monkeypatch, FakeNet().page(PAGE, f'<title>t</title><img src="{url}">')
                  .image(url))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "ok"
    assert result["cover_source"] == url


def test_a_page_whose_images_were_all_dismissed_says_why(tmp_path, monkeypatch):
    """"No cover" and "no images" are different failures and must not look alike.

    Discovery drops chrome silently, so a page where every image was dismissed
    used to report exactly what an empty page reports: nothing.
    """
    install(monkeypatch, FakeNet().page(
        PAGE, '<title>t</title>'
              '<img src="/static/images/new_logo.svg">'
              '<img src="/static/upload/ads/files/promo.gif">'))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "no-candidates"
    assert result["candidates"] == 0
    assert any("name contains 'logo'" in entry for entry in result["skipped"])
    assert any("path contains '/ads/'" in entry for entry in result["skipped"])
    assert "skipped" in format_report(result)


def test_a_logo_is_still_dismissed_by_its_own_name(tmp_path, monkeypatch):
    """The rule is narrower, not weaker: an image named for chrome is chrome."""
    net = install(monkeypatch, FakeNet()
                  .page(PAGE, '<title>t</title>'
                              '<img src="https://cdn.example/img/site-logo.png">'
                              '<img class="cover" src="/real.jpg">')
                  .image("https://site.example/real.jpg"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["cover_source"] == "https://site.example/real.jpg"
    assert "https://cdn.example/img/site-logo.png" not in net.media_requests
    assert any("name contains 'logo'" in entry for entry in result["skipped"])


def test_a_page_that_builds_itself_in_javascript_says_so(tmp_path, monkeypatch):
    """Measured on a real site, whose entire response was this and nothing else.

    Its title and cover are fetched by script after load, so there is nothing in
    the HTML to find — and "needs a selector" and "the data was never sent" are
    different work, which a person triaging failures needs told apart.
    """
    install(monkeypatch, FakeNet().page(
        PAGE,
        '<title>Site Name</title><meta name="description" content="Site Name">'
        '<div id="app"></div><noscript>Please enable Javascript.</noscript>'
        '<script defer src="/main.abc.js"></script>'))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "no-candidates"
    assert result["kind"] == "teaching"
    assert result["client_rendered"] is True
    assert "JavaScript" in result["detail"]
    # Nothing was invented for it either.
    assert result["cover"] is None


def test_a_static_page_is_not_reported_as_client_rendered(tmp_path, monkeypatch):
    install(monkeypatch, FakeNet().page(PAGE, "<title>Only a title</title>"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "no-candidates"
    assert result["client_rendered"] is False
    assert "JavaScript" not in result["detail"]


# --- a page that calls itself the title ------------------------------------ #

def test_a_page_that_calls_itself_the_title_yields_no_title(tmp_path, monkeypatch):
    """Measured on a real site: `og:title` and `og:site_name` both held its name.

    Taking it would put the site's name in the library as the name of a work, and
    marking that *confirmed* is worse than finding no title at all — it is the
    silent wrong answer rather than the missing one.
    """
    logo = "https://site.example/static/kemono-logo.svg"
    install(monkeypatch, FakeNet().page(
        PAGE,
        '<title>Kemono</title>'
        '<meta name="og:type" content="website">'
        '<meta name="og:site_name" content="Kemono">'
        '<meta name="og:title" content="Kemono">'
        f'<meta name="og:image" content="{logo}">'
        '<div id="root"></div>')
        .image(logo, b"<svg/>", content_type="image/svg+xml"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["title"] is None
    assert result["title_verified"] is False
    assert result["cover"] is None
    assert any("site's own name" in note for note in result["notes"])
    # An SVG is an image; it is just not a cover, and the reason says so.
    assert result["rejected"] == ["meta: an SVG is site chrome, not a cover"]
    # The empty shell is the reason nothing was readable, so it leads.
    assert result["client_rendered"] is True
    assert result["outcome"] == "no-candidates"
    assert result["kind"] == "teaching"
    assert "JavaScript" in result["detail"]


def test_a_site_name_in_og_title_lets_a_later_source_win(tmp_path, monkeypatch):
    """A page can declare the site in `og:title` and the work in its `<h1>`."""
    install(monkeypatch, FakeNet()
            .page(PAGE, '<meta name="og:site_name" content="Kemono">'
                        '<meta name="og:title" content="Kemono">'
                        '<h1>The Real Work</h1>'
                        '<img class="cover" src="/c.jpg">')
            .image("https://site.example/c.jpg"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "ok"
    assert result["title"] == "The Real Work"
    assert result["title_from"] == "h1"


def test_an_og_title_that_is_not_the_site_name_is_still_kept(tmp_path, monkeypatch):
    install(monkeypatch, FakeNet()
            .page(PAGE, '<meta name="og:site_name" content="Wikipedia">'
                        '<meta name="og:title" content="Natsume Sōseki - Wikipedia">'
                        '<meta name="og:image" content="/c.jpg">')
            .image("https://site.example/c.jpg"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["title"] == "Natsume Sōseki - Wikipedia"
    assert result["title_verified"] is True


def test_a_title_padded_with_a_separator_is_still_the_site_name():
    assert is_site_name("Kemono", "Kemono") is True
    assert is_site_name("KEMONO |", "Kemono") is True
    assert is_site_name("| Kemono", "Kemono") is True
    assert is_site_name("A Work", "Kemono") is False
    # Nothing declared means nothing to compare against.
    assert is_site_name("A Work", None) is False


def test_a_title_naming_the_pages_own_domain_is_chrome(tmp_path, monkeypatch):
    """Measured on a real site whose <title> was "女神社 - nshens.com".

    That is a site's name plus its address, the shape a blog's title almost always
    has. A work is not titled with the domain of the site publishing it.
    """
    install(monkeypatch, FakeNet().page(PAGE, "<title>女神社 - site.example</title>"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["title"] is None
    assert result["title_verified"] is False
    assert any("names the site itself" in note for note in result["notes"])


def test_a_title_that_does_not_name_the_host_is_kept(tmp_path, monkeypatch):
    install(monkeypatch, FakeNet().page(PAGE, "<title>A Work - Somewhere</title>"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["title"] == "A Work - Somewhere"


def test_a_page_with_no_title_at_all_does_not_claim_one_was_refused(tmp_path, monkeypatch):
    """Measured on a real Vite shell: no `<title>`, no headings, no og tags at all.

    "The page called itself the title" and "the page has no title" are different
    findings, and the first must not be reported for a page where nothing was
    refused — that states something which did not happen.
    """
    install(monkeypatch, FakeNet().page(
        PAGE, '<meta charset="UTF-8"><div id="root"></div>'
              '<script type="module" src="/assets/index-C8JF3rqk.js"></script>'))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["title"] is None
    assert result["client_rendered"] is True
    assert result["outcome"] == "no-candidates"
    assert result["notes"] == []
    # The shell is still explained — just not with a claim about a title.
    assert "no data at all" in result["detail"]


def test_mentions_host_matches_with_and_without_www():
    assert mentions_host("女神社 - nshens.com", "nshens.com") is True
    assert mentions_host("Site - example.com", "www.example.com") is True
    assert mentions_host("A Work", "nshens.com") is False
    assert mentions_host("A Work", None) is False


def test_a_hydration_blob_is_not_reported_as_no_data_at_all(tmp_path, monkeypatch):
    """Measured on a real Nuxt site: the post's data was in `window.__NUXT__`.

    That is not the same as a page that ships nothing but its bundle — the data
    was sent, in script source rather than markup or JSON — and saying "no data at
    all" about it would be false and would point a person at the wrong fix.
    """
    install(monkeypatch, FakeNet().page(
        PAGE,
        '<title>Site - site.example</title><div id="__nuxt"></div>'
        '<script>window.__NUXT__=(function(a,b){return {id:a}}("10039037"));</script>'))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["client_rendered"] is True
    assert result["hydration"] == "window.__NUXT__"
    assert result["outcome"] == "no-candidates"
    assert result["kind"] == "teaching"
    assert "window.__NUXT__" in result["detail"]
    assert "no data at all" not in result["detail"]


def test_a_page_with_no_state_blob_still_says_nothing_was_sent(tmp_path, monkeypatch):
    install(monkeypatch, FakeNet().page(
        PAGE, '<title>Site</title><div id="__nuxt"></div>'
              '<script src="/main.js"></script>'))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["client_rendered"] is True
    assert result["hydration"] is None
    assert "no data at all" in result["detail"]


# --- the two defects this reader used to have ------------------------------ #

def test_an_error_page_is_never_read_as_a_work(tmp_path, monkeypatch):
    """A 404 body has a <title> and often a logo: neither is this work's."""
    net = install(monkeypatch, FakeNet().page(
        PAGE,
        '<title>Page not found</title><meta property="og:image" content="/logo.png">',
        status=404,
    ).image("https://site.example/logo.png"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "http-error"
    assert result["kind"] == "retryable"
    assert result["status"] == 404
    assert result["title"] is None
    assert result["cover"] is None
    # The body was refused before anything in it was acted on.
    assert net.media_requests == []


def test_a_cover_url_is_not_corrupted_by_a_second_unescape(tmp_path, monkeypatch):
    """`&copy=` in a query is a parameter, not the copyright entity."""
    net = install(monkeypatch, FakeNet().page(
        PAGE,
        '<meta property="og:title" content="T">'
        '<meta property="og:image" content="https://cdn.example/i.jpg?w=1&amp;copy=2&amp;reg=3">',
    ).image("https://cdn.example/i.jpg?w=1&copy=2&reg=3"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["cover_source"] == "https://cdn.example/i.jpg?w=1&copy=2&reg=3"
    assert "\u00a9" not in result["cover_source"]      # ©
    assert "\u00ae" not in result["cover_source"]      # ®
    assert net.media_requests == ["https://cdn.example/i.jpg?w=1&copy=2&reg=3"]


# --- what this reader refuses to claim ------------------------------------- #

def test_author_date_and_tags_are_never_claimed(tmp_path, monkeypatch):
    """The page mentions them; that is not the same as this work's value for them."""
    body = ('<meta property="og:title" content="T">'
            '<meta property="og:image" content="/c.jpg">'
            '<meta name="author" content="Someone">'
            '<meta property="article:published_time" content="2020-01-01">'
            '<meta name="keywords" content="a, b, c">'
            '<script type="application/ld+json">{"@type":"Book","name":"T",'
            '"author":{"name":"Someone"},"datePublished":"2020-01-01",'
            '"keywords":"a, b","image":"/c.jpg"}</script>')
    install(monkeypatch, FakeNet().page(PAGE, body).image("https://site.example/c.jpg"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert CLAIMED_FIELDS == ("title", "cover")
    assert not {"author", "date", "tags", "description", "creator"} & set(result)
    assert result["title"] == "T"

    # Nothing in the result may claim a field outside the declared list. The
    # bookkeeping keys are named here so a new one has to be added on purpose.
    bookkeeping = {
        "input_url", "source_url", "outcome", "kind", "detail", "status",
        "title_from", "title_verified", "cover_source", "cover_from", "cover_size",
        "cover_bytes", "cover_rank", "cover_verified", "candidates", "rejected",
        "skipped", "client_rendered", "hydration", "challenge", "notes",
    }
    assert set(result) == set(CLAIMED_FIELDS) | bookkeeping


# --- the page whose data is not in the HTML -------------------------------- #

def test_a_javascript_rendered_page_needs_a_rule_rather_than_a_wrong_title(tmp_path, monkeypatch):
    """Measured on a real gallery site, and the reason `title_verified` exists.

    Its gallery pages build the title and the cover in JavaScript, so the static
    HTML holds site chrome in the `<h1>` and a ghost placeholder in the `<img>`.
    Reporting that heading as the work's title is the silent wrong answer; the
    honest result is that this page cannot be read without a rule.
    """
    net = install(monkeypatch, FakeNet().page(
        PAGE, '<title>Gallery</title><h1>Read Online</h1>'
              '<img class="lazyload" src="/ghost.webp" width="15" height="12">'),
        size=(15, 12))
    net.image("https://site.example/ghost.webp")
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "no-candidates"
    assert result["kind"] == "teaching"
    assert result["cover"] is None
    assert result["rejected"] == ["img: too small (15x12)"]
    # The text is still reported — with the source that gave it and a flag, never
    # silently promoted to the work's title.
    assert result["title"] == "Read Online"
    assert result["title_from"] == "h1"
    assert result["title_verified"] is False
    assert any("site chrome" in note for note in result["notes"])


def test_a_site_level_jsonld_name_is_not_taken_as_the_title(tmp_path, monkeypatch):
    install(monkeypatch, FakeNet().page(
        PAGE, '<title>Real Page Title</title>'
              '<script type="application/ld+json">'
              '{"@type":"WebSite","name":"Example Portal","url":"https://site.example/"}'
              '</script>'))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["title"] == "Real Page Title"
    assert result["title_from"] == "title"
    assert result["title_verified"] is False


# --- failure is a first-class outcome -------------------------------------- #

def test_a_page_with_no_cover_candidate_needs_a_rule(tmp_path, monkeypatch):
    install(monkeypatch, FakeNet().page(PAGE, "<title>Only a title</title>"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "no-candidates"
    assert result["kind"] == "teaching"
    assert result["title"] == "Only a title"


def test_a_page_whose_candidates_all_fail_is_only_insufficient(tmp_path, monkeypatch):
    net = install(monkeypatch, FakeNet()
                  .page(PAGE, '<title>t</title>'
                              '<meta property="og:image" content="/a.png">'
                              '<img src="/static/logo.png">'), size=(40, 40))
    net.image("https://site.example/a.png")
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "candidates-rejected"
    assert result["kind"] == "insufficient"
    assert result["cover"] is None
    assert result["rejected"] == ["meta: too small (40x40)"]


def test_a_candidate_that_does_not_serve_an_image_falls_through(tmp_path, monkeypatch):
    net = install(monkeypatch, FakeNet()
                  .page(PAGE, '<title>t</title>'
                              '<meta property="og:image" content="/gone.jpg">'
                              '<img class="cover" src="/real.jpg">')
                  .image("https://site.example/gone.jpg", status=404))
    net.image("https://site.example/real.jpg")
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "ok"
    assert result["cover_source"] == "https://site.example/real.jpg"
    assert result["cover_rank"] == 2
    assert result["rejected"] == ["meta: HTTP 404"]


def test_a_cover_without_a_title_is_insufficient_not_ok(tmp_path, monkeypatch):
    install(monkeypatch, FakeNet()
            .page(PAGE, '<meta property="og:image" content="/c.jpg">')
            .image("https://site.example/c.jpg"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "cover-only"
    assert result["kind"] == "insufficient"
    assert result["title"] is None
    assert result["cover"] is not None


def test_a_page_with_neither_title_nor_cover_needs_a_rule(tmp_path, monkeypatch):
    install(monkeypatch, FakeNet().page(PAGE, "<html><body></body></html>"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "no-title"
    assert result["kind"] == "teaching"


def test_a_response_that_is_not_html_is_not_a_work_page(tmp_path, monkeypatch):
    install(monkeypatch, FakeNet().page(PAGE, "%PDF-1.4", content_type="application/pdf"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "not-html"
    assert result["kind"] == "teaching"
    assert "application/pdf" in result["detail"]


def test_a_transport_failure_is_reported_rather_than_raised(tmp_path, monkeypatch):
    def broken(url, *, referer=None):
        raise OSError("connection reset")

    monkeypatch.setattr(unknown_url, "fetch", broken)
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "fetch-failed"
    assert result["kind"] == "retryable"
    assert "OSError" in result["detail"]
    assert any("connection reset" in note for note in result["notes"])


def test_a_non_http_input_is_refused_before_any_request(tmp_path, monkeypatch):
    net = install(monkeypatch, FakeNet())
    for raw in ("file:///etc/passwd", "not a url", ""):
        result = read_work(raw, save_dir=tmp_path)
        assert result["outcome"] == "bad-input"
        assert result["kind"] == "invalid"
    assert net.requests == []


def test_every_outcome_token_is_classified():
    """A new outcome cannot be added without deciding what it means."""
    tokens = [value for name, value in vars(unknown_url.Outcome).items()
              if not name.startswith("_")]
    assert tokens
    for token in tokens:
        assert token in unknown_url.OUTCOME_KIND, token
        assert outcome_kind(token) in {
            "found", "insufficient", "teaching", "retryable", "blocked", "invalid",
        }


# --- a refusal that is a bot check, not a verdict -------------------------- #

CLOUDFLARE_CHALLENGE = (
    '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>'
    '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">'
    '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>'
    '</head><body><div id="cf-chl-widget"></div></body></html>'
)


def test_a_bot_check_is_reported_as_blocked_rather_than_retryable(tmp_path, monkeypatch):
    """Measured on a real site that refuses even a real Chrome.

    A challenge will refuse the same plain request again, so "retryable" would be
    wrong advice — passing it needs a session this reader deliberately does not
    hold. And the challenge page's own `<title>` is "Just a moment...", which is
    why a non-2xx body is never read as content.
    """
    install(monkeypatch, FakeNet().page(PAGE, CLOUDFLARE_CHALLENGE, status=403))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "blocked"
    assert result["kind"] == "blocked"
    assert result["challenge"] == "Cloudflare"
    assert result["status"] == 403
    assert result["title"] is None
    assert result["cover"] is None
    assert "bot check" in result["detail"]


def test_an_ordinary_error_is_still_just_an_error(tmp_path, monkeypatch):
    install(monkeypatch, FakeNet().page(PAGE, "<title>Not found</title>", status=404))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "http-error"
    assert result["kind"] == "retryable"
    assert result["challenge"] is None
    assert "body was not read" in result["detail"]


def test_challenge_detection_names_the_firewall():
    from src.generic.unknown_url import challenge_of

    assert challenge_of(CLOUDFLARE_CHALLENGE) == "Cloudflare"
    assert challenge_of("<html>DataDome dd_challenge</html>") == "DataDome"
    assert challenge_of("<html><title>Example work</title></html>") is None
    assert challenge_of("") is None


# --- a page that is asking for a password ---------------------------------- #

LOGIN_PAGE = (
    '<title>登录 - Example</title>'
    '<meta property="og:site_name" content="Example">'
    '<meta property="og:title" content="请先登录">'
    '<meta property="og:image" content="/static/hero.jpg">'
    '<h1>请先登录查看内容</h1>'
    '<form action="/login" method="post">'
    '<input type="text" name="username"><input type="password" name="password">'
    '<button type="submit">登录</button></form>'
)


def test_a_login_page_is_never_taken_for_the_work(tmp_path, monkeypatch):
    """Measured against a fixture, and it exported before this check existed.

    A login page answers 200 and sites give theirs og tags so it shares well, which
    made it read as a complete work: an entry titled "请先登录" carrying the login
    page's hero image as its cover.
    """
    net = install(monkeypatch, FakeNet().page(PAGE, LOGIN_PAGE))
    net.image("https://site.example/static/hero.jpg")
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "blocked"
    assert result["kind"] == "blocked"
    assert result["title"] is None
    assert result["cover"] is None
    assert "login form" in result["detail"]
    # Nothing was even fetched from it.
    assert net.media_requests == []


def test_a_login_form_in_the_page_chrome_is_not_a_gate(tmp_path, monkeypatch):
    """The form the site puts in its header on every page is not this page's answer.

    Calling that a gate would report every page of such a site as unreadable.
    """
    install(monkeypatch, FakeNet()
            .page(PAGE, '<header><form><input type="password" name="pw"></form></header>'
                        '<title>A Work</title>'
                        '<img class="cover" src="/c.jpg">')
            .image("https://site.example/c.jpg"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "ok"
    assert result["title"] == "A Work"


def test_a_password_protected_post_is_a_gate_too(tmp_path, monkeypatch):
    """The content really is withheld, so it is the same answer."""
    install(monkeypatch, FakeNet().page(
        PAGE, '<title>A Work</title><h1>A Work</h1>'
              '<p>This post is protected.</p>'
              '<form><input type="password" name="post_password"></form>'))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "blocked"
    assert result["kind"] == "blocked"


# --- the pieces that keep the cover honest --------------------------------- #

def test_comparison_url_drops_only_what_cannot_select_different_bytes():
    assert comparison_url("https://A.EXAMPLE/x?w=1#frag") == "https://a.example/x?w=1"
    assert comparison_url("https://a.example/x?utm_source=y&copy=2") == "https://a.example/x?copy=2"
    # A CDN parameter selects the bytes and must survive.
    assert comparison_url("https://a.example/x?w=800&h=600") == "https://a.example/x?w=800&h=600"


def test_one_image_repeated_with_a_tracking_parameter_is_fetched_once(tmp_path, monkeypatch):
    net = install(monkeypatch, FakeNet()
                  .page(PAGE, '<title>t</title>'
                              '<img class="cover" src="/c.jpg">'
                              '<img class="cover" src="/c.jpg?utm_source=card#x">')
                  .image("https://site.example/c.jpg"))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["candidates"] == 1
    assert net.media_requests == ["https://site.example/c.jpg"]


def test_two_works_sharing_a_path_tail_do_not_overwrite_each_other(tmp_path, monkeypatch):
    """Without a digest both would be `<host>_view.jpg` and the first cover would be lost."""
    net = FakeNet().image("https://a.example/one/view/cover.jpg", b"first")
    net.image("https://a.example/two/view/cover.jpg", b"second")
    install(monkeypatch, net)
    net.page("https://a.example/one/view", '<title>One</title>'
                                           '<meta property="og:image" content="/one/view/cover.jpg">')
    net.page("https://a.example/two/view", '<title>Two</title>'
                                           '<meta property="og:image" content="/two/view/cover.jpg">')

    first = read_work("https://a.example/one/view", save_dir=tmp_path)
    second = read_work("https://a.example/two/view", save_dir=tmp_path)

    assert first["cover"] != second["cover"]
    assert Path(first["cover"]).read_bytes() == b"first"
    assert Path(second["cover"]).read_bytes() == b"second"


def test_without_pillow_the_cover_is_saved_but_marked_unverified(tmp_path, monkeypatch):
    """A missing optional extra must not read as 'this page has no usable cover'."""
    install(monkeypatch, FakeNet()
            .page(PAGE, '<title>t</title><meta property="og:image" content="/c.jpg">')
            .image("https://site.example/c.jpg"), size=None)
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["outcome"] == "ok"
    assert result["cover"] is not None
    assert result["cover_verified"] is False
    assert any("Pillow" in note for note in result["notes"])


def test_extension_for_sniffs_magic_bytes_when_the_type_is_unhelpful():
    assert extension_for("IMAGE/JPEG; charset=binary", b"") == ".jpg"
    assert extension_for("", JPEG) == ".jpg"
    assert extension_for("", b"\x89PNG\r\n\x1a\n") == ".png"
    assert extension_for("", b"RIFF\x00\x00") == ".webp"
    assert extension_for("text/html", b"<html>") == ""


# --- the report a person reads -------------------------------------------- #

def test_the_report_names_the_values_their_sources_and_the_verdict(tmp_path, monkeypatch):
    install(monkeypatch, FakeNet()
            .page(PAGE, '<meta property="og:title" content="A Work">'
                        '<meta property="og:image" content="/c.jpg">')
            .image("https://site.example/c.jpg"))
    report = format_report(read_work(PAGE, save_dir=tmp_path))

    assert "ok  [found]" in report
    assert "A Work" in report
    assert "meta:og:title (confirmed)" in report
    assert "candidate #1 via meta" in report
    assert "verified" in report
    # Where the image came from is what tells a person it is the cover and not an
    # illustration from the page's sidebar.
    assert "from https://site.example/c.jpg" in report


def test_the_report_shows_why_a_cover_was_refused(tmp_path, monkeypatch):
    net = install(monkeypatch, FakeNet()
                  .page(PAGE, '<title>t</title><meta property="og:image" content="/a.png">'),
                  size=(40, 40))
    net.image("https://site.example/a.png")
    report = format_report(read_work(PAGE, save_dir=tmp_path))

    assert "candidates-rejected  [insufficient]" in report
    assert "rejected" in report
    assert "too small (40x40)" in report
    assert "cover   none" in report


def test_a_long_cover_url_is_never_broken_across_lines(tmp_path, monkeypatch):
    """A URL split over two lines is one a person cannot copy or click.

    The path this test used to check belonged to the export document, which Level 0 no longer writes.
    What the report still prints — and what a person still needs to copy intact — is the address the
    cover came from, so that is what must survive whole.
    """
    long_url = "https://site.example/" + "/".join(["a_very_long_directory_name"] * 4) + "/c.jpg"
    install(monkeypatch, FakeNet()
            .page(PAGE, f'<title>t</title><meta property="og:image" content="{long_url}">')
            .image(long_url))
    result, cover = read_link(PAGE)
    report = format_report(result)

    assert cover is not None
    assert len(result["cover_source"]) > 80      # long enough that wrapping would show
    assert result["cover_source"] in report
    assert result["input_url"] in report


# --- the command line ------------------------------------------------------ #

def test_the_exit_code_is_the_verdict(monkeypatch):
    import show_link

    def code_for(kind: str) -> int:
        monkeypatch.setattr(show_link, "read_link",
                            lambda url: ({"input_url": url, "kind": kind}, None))
        return show_link.main(["https://site.example/x"])

    assert code_for("found") == 0
    assert code_for("insufficient") == 1
    assert code_for("teaching") == 1
    assert code_for("retryable") == 2
    assert code_for("blocked") == 2
    assert code_for("invalid") == 3
    # A kind the mapping has not heard of is a bug here, not a verdict: it must
    # never read as success, and 3 would claim the input was bad.
    assert code_for("something-new") == 2


def test_the_command_line_without_a_link_says_how_to_use_it(capsys):
    import show_link

    assert show_link.main([]) == 3
    assert "Usage" in capsys.readouterr().out


# --- what a read leaves behind (nothing) ---------------------------------- #

def test_a_read_hands_over_the_cover_and_writes_no_files(tmp_path, monkeypatch):
    """Level 0 reads; T³ stores. The export document is not how a link reaches the library any
    more, so a read must not leave one — measured by looking at the filesystem, not at the code."""
    install(monkeypatch, FakeNet()
            .page(PAGE, '<meta property="og:title" content="A Work">'
                        '<meta property="og:image" content="/c.jpg">')
            .image("https://site.example/c.jpg"))

    before = sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*"))
    result, cover = read_link(PAGE)
    after = sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*"))

    assert result["outcome"] == "ok"
    assert result["title"] == "A Work"
    assert cover == JPEG
    assert result["cover_bytes"] == len(JPEG)
    assert result["cover_mime"] == "image/jpeg"
    assert result["cover_source"] == "https://site.example/c.jpg"
    # No path to a file that no longer exists: the scratch directory is gone by now.
    assert result["cover"] is None
    assert before == after == [], f"a read wrote {after}"


def test_an_incomplete_page_reads_nothing_and_says_so(tmp_path, monkeypatch):
    """A wrong title in the library is worse than no entry, so no cover either."""
    install(monkeypatch, FakeNet().page(PAGE, "<title>Only a title</title>"))
    result, cover = read_link(PAGE)

    assert cover is None
    assert result["outcome"] == "no-candidates"
    assert not list(tmp_path.rglob("metadata.json"))
    report = format_report(result)
    assert "kept" in report


def test_a_cover_without_a_verified_title_is_still_read(tmp_path, monkeypatch):
    """`h1` is page text, but a page with a real cover is a work page."""
    install(monkeypatch, FakeNet()
            .page(PAGE, '<h1>A Work</h1><img class="cover" src="/c.jpg">')
            .image("https://site.example/c.jpg"))
    result, cover = read_link(PAGE)

    assert result["title_verified"] is False
    assert cover == JPEG
    assert result["title"] == "A Work"


# The two identity tests that stood here (`source_id_for` on a hash route, and the fragment a
# redirect cannot carry) pinned how the *export folder* was named. Level 0 writes no folder now, so
# the helpers went with it — and what they protected is still covered: the fragment never reaches the
# server, and a hash-routed page is reported as the shell it is (the test below).

# --- a shell that carried nothing ------------------------------------------ #

def test_a_shell_that_carried_nothing_does_not_report_its_own_title(tmp_path, monkeypatch):
    """Measured on a real site: `<title>笔趣阁</title>`, an empty mount, no images.

    A shell serves one `<title>` for every route it has, so on a page that carried
    nothing else that title is the string the whole site shows. It cannot be this
    work's, and taking it puts the site's name in the library.
    """
    install(monkeypatch, FakeNet().page(
        PAGE,
        '<title>笔趣阁</title><div id="app"></div>'
        '<script src="/js/read.js?v=1"></script>'
        '<div>首页 排行榜 完本</div>'))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["client_rendered"] is True
    assert result["title"] is None
    assert any("every page of this site has" in note for note in result["notes"])


def test_a_shell_keeps_a_structured_title_because_that_is_a_declaration(tmp_path, monkeypatch):
    """Only the unverified kind is dropped: `og:title` is the site declaring one."""
    install(monkeypatch, FakeNet().page(
        PAGE,
        '<meta property="og:title" content="A Declared Work">'
        '<div id="app"></div>'))
    result = read_work(PAGE, save_dir=tmp_path)

    assert result["client_rendered"] is True
    assert result["title"] == "A Declared Work"
    assert result["title_verified"] is True


def test_a_hash_routed_shell_names_the_fragment_as_the_reason(tmp_path, monkeypatch):
    """The fragment is the one part of a URL a server never receives.

    So the request that went out was for the site's front page, and the work was
    never asked for — a more precise reason than "it is built in JavaScript", and
    it points at a different fix.
    """
    route = "https://h.example/#/book/2530/"
    install(monkeypatch, FakeNet().page(
        route, '<title>Site</title><div id="app"></div>'))
    result = read_work(route, save_dir=tmp_path)

    assert result["outcome"] == "no-candidates"
    assert result["kind"] == "teaching"
    assert "fragment" in result["detail"]
    assert "never receives a fragment" in result["detail"]


