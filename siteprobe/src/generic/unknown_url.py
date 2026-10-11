"""Level 0: the reader for one work URL that no site template claims.

The registry refuses a URL no installed adapter was written for, which is
correct — crawling the wrong thing silently is the failure the whole tool exists
to avoid. This module is the honest answer for that refusal: it does not pretend
to know the site, it reads the two fields that survive without a rule, and it
says plainly when it could not.

Scope is deliberately narrow, and it is narrow because it was measured. Across
seven unrelated sites a title and a cover are reachable almost always, a date
about half the time, tags half the time and half of those are SEO noise, and an
author about a quarter of the time with a real chance of it being the work's own
official page rather than a person. So:

    CLAIMED_FIELDS = ("title", "cover")     # what this module will ever assert

Author, date and tags are *not* claimed, and must not become claimed without a
site rule. They are still readable from a page — ``probe_url_meta.py`` reports
them with their source for exactly that reason — but "the page mentions a date"
is not the same as "this work's date", and a library that stores the wrong one
is worse than a library with a blank field.

The cover is fetched and written to disk, because the URL is not the deliverable.
A page loaded from the library later hits Referer restrictions, expiring signed
tokens and TLS fingerprinting; the fetch already works server-side, so the bytes
are what gets kept.

Failure is a first-class outcome, not an empty field. Every result carries an
``outcome`` token and a ``kind`` for it, so a caller can act without matching on
prose:

    found         ok
    insufficient  候选不足 — the page has candidates, none of them usable
    teaching      需要教学 — this site needs a rule to be read at all
    blocked       校验或登录墙 — the site withheld the page rather than show it
    retryable     the page could not be read this time, but it might work later
    invalid       the input was not a usable URL

    python show_link.py <url>            # the report a person reads
    python fetch_work_meta.py <url>      # the same result as JSON
    from src.generic.unknown_url import read_work

The two entry points write an export document for the library; see
``level0_export.py``. This module is the reader they build on.
"""

from __future__ import annotations

import hashlib
import json
import re
import textwrap
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse, urlunparse

from .htmltree import parse_html, select_all, select_one

TIMEOUT = 25
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140 Safari/537.36")

# The fields this reader is allowed to assert. A test pins this tuple against the
# keys a result actually carries, so an unreliable field cannot be smuggled in by
# adding a line somewhere below.
CLAIMED_FIELDS = ("title", "cover")

# A logo is not a cover, and the giveaways are cheap to check — but they are
# checked on the image's own file name and on paths that only ever hold theme
# assets, never on the whole URL. A shared CDN prefix would throw real covers
# away: `…/static/upload/book/cover_1.jpg` is a cover, and `static` was once a
# hint here.
BOILERPLATE_IN_NAME = ("logo", "favicon", "sprite", "icon", "placeholder",
                       "blank", "loading", "default", "share", "banner", "emoji")
BOILERPLATE_IN_PATH = ("/ads/", "/ad/", "/static/images/", "/static/css/",
                       "/assets/icons/")
MIN_SIDE = 180          # a real cover is bigger than a badge
MAX_ASPECT = 4.0        # and is not a 10:1 strip

# Query parameters that never change which image is served, so two candidates
# differing only in these are one image. Deliberately tiny: a CDN's own
# parameters (`?w=`, `?copy=`, a signed token) usually *do* select the bytes, and
# dropping one of those would silently fetch a different image.
TRACKING_PARAMS = ("utm_", "fbclid", "gclid", "msclkid")

OUTCOME_KIND = {
    "ok": "found",
    "cover-only": "insufficient",
    "candidates-rejected": "insufficient",
    "no-candidates": "teaching",
    "no-title": "teaching",
    "not-html": "teaching",
    "http-error": "retryable",
    # Not retryable with the same request: a challenge will refuse it again, and
    # passing it needs a session this reader deliberately does not hold.
    "blocked": "blocked",
    "fetch-failed": "retryable",
    "bad-input": "invalid",
}


# A refusal that is a bot check rather than a verdict about the page. These are
# the markers the major WAFs put in the challenge body they return; nothing here
# is read as content, only as the reason the content was withheld. Measured: a
# request that already impersonates Chrome's TLS fingerprint still gets the
# challenge, and so does a real headless Chrome.
CHALLENGE_MARKERS = (
    ("Cloudflare", ("just a moment", "attention required! | cloudflare", "__cf_chl")),
    ("DataDome", ("datadome", "dd_challenge")),
    ("Imperva", ("incapsula", "_incap_ses")),
    ("Akamai", ("akamai bot manager", "_abck")),
    ("Sucuri", ("sucuri website firewall",)),
)


def challenge_of(text: str) -> str | None:
    """Which bot check refused the request, if the refusal was one."""
    head = text[:65536].casefold()
    for name, markers in CHALLENGE_MARKERS:
        if any(marker in head for marker in markers):
            return name
    return None


# Containers whose contents are on every page of a site. A login form inside one
# of these is the site's own chrome; the same form anywhere else is the page
# asking the visitor to authenticate before it shows anything.
CHROME_ANCESTORS = ("header", "nav", "footer", "aside")


def in_site_chrome(element) -> bool:
    node = element.parent
    while node is not None:
        if node.tag in CHROME_ANCESTORS:
            return True
        node = node.parent
    return False


def login_gate(root) -> bool:
    """Whether this page is asking the visitor to log in rather than showing a work.

    A password field is the one thing only a login form has, and where it sits is
    what separates the two cases. Getting this wrong in the other direction is
    worse than not asking at all: a login page answers 200, and a login page that
    declares og tags — which sites do so the page shares well — reads as a complete
    work, so the library would take on an entry titled "请先登录" carrying the login
    page's hero image as its cover.
    """
    return any(
        (field.attr("type") or "").strip().lower() == "password"
        and not in_site_chrome(field)
        for field in select_all(root, "input")
    )


class Outcome:
    """The tokens, so a caller never spells one by hand."""

    OK = "ok"
    COVER_ONLY = "cover-only"
    CANDIDATES_REJECTED = "candidates-rejected"
    NO_CANDIDATES = "no-candidates"
    NO_TITLE = "no-title"
    NOT_HTML = "not-html"
    HTTP_ERROR = "http-error"
    BLOCKED = "blocked"
    FETCH_FAILED = "fetch-failed"
    BAD_INPUT = "bad-input"


def outcome_kind(outcome: str) -> str:
    return OUTCOME_KIND.get(outcome, "invalid")


# --- fetching -------------------------------------------------------------- #

def fetch(url: str, *, referer: str | None = None) -> tuple[int, bytes, str, str]:
    """(status, body, content_type, final_url) — impersonated when possible."""
    headers = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}
    if referer:
        headers["Referer"] = referer
    try:
        from curl_cffi import requests as curl_requests

        response = curl_requests.get(url, impersonate="chrome", headers=headers,
                                     timeout=TIMEOUT, allow_redirects=True)
        return (response.status_code, response.content,
                response.headers.get("content-type", ""), str(response.url))
    except ImportError:
        import urllib.request

        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=TIMEOUT) as reply:
            return reply.status, reply.read(), reply.headers.get("content-type", ""), reply.url


def readable_url(raw: str) -> bool:
    """Only http(s) can be fetched; anything else is a caller mistake."""
    scheme = urlparse(raw.strip()).scheme.lower()
    return scheme in ("http", "https")


# --- URL identity ---------------------------------------------------------- #

def comparison_url(url: str) -> str:
    """The identity two candidates are deduplicated on.

    Kept apart from the URL actually fetched: a signed or query-carrying URL is
    what serves the bytes, and rewriting it would break the download. Only the
    parts that cannot change which image is served are removed.
    """
    parsed = urlparse(url)
    kept = "&".join(
        pair for pair in parsed.query.split("&")
        if pair and not pair.split("=", 1)[0].lower().startswith(TRACKING_PARAMS)
    )
    return urlunparse((
        parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, parsed.params,
        kept, "",          # a fragment never identifies a different image
    ))


# --- JSON-LD --------------------------------------------------------------- #

def jsonld_nodes(html: str):
    """Every object in every JSON-LD block, arrays and ``@graph`` flattened out.

    Shared by the title and the cover so a page's structured data is parsed once
    and both readers see the same nodes.
    """
    for match in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.DOTALL | re.IGNORECASE,
    ):
        try:
            payload = json.loads(match.group(1).strip())
        except json.JSONDecodeError:
            continue
        stack = [payload]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
                continue
            if not isinstance(node, dict):
                continue
            yield node
            for key in ("@graph", "mainEntity", "itemListElement"):
                if isinstance(node.get(key), (dict, list)):
                    stack.append(node[key])


# --- title ---------------------------------------------------------------- #

OG_TITLE = ("og:title", "twitter:title")

# A title is only read from a JSON-LD node that describes a creative work. A
# `WebSite` or `Organization` node also has a `name`, and it is the site's, not
# this page's — taking it would be the wrong-title failure in a new costume.
WORK_TYPES = ("ComicStory", "Book", "Movie", "TVSeries", "VideoObject",
              "CreativeWork", "Article", "Product", "ImageGallery")
JSONLD_TITLE_KEYS = ("name", "headline", "alternativeHeadline")


def site_name_of(root) -> str | None:
    """The site's own name, when the page declares one."""
    for key in ("og:site_name", "application-name"):
        meta = select_one(root, f'meta[property="{key}"]') or select_one(root, f'meta[name="{key}"]')
        if meta is not None:
            value = (meta.attr("content") or "").strip()
            if value:
                return value
    return None


def is_site_name(value: str, site: str | None) -> bool:
    """Whether this text is the site's own name rather than the work's title.

    A page that hardcodes `og:title` and `og:site_name` to the same string is
    declaring its own name as the title. Measured on a site whose shell does
    exactly that: taking it would put "Kemono" in the library as the name of a
    work, and calling it *confirmed* is worse than finding no title at all.
    """
    if not site:
        return False
    return value.strip().strip("|-–—·:, ").casefold() == site.strip().casefold()


def title_of(root, html: str, host: str | None = None) -> tuple[str | None, str | None, bool, list[str]]:
    """A title, its source, whether a structured source confirmed it, and what was refused.

    ``verified`` is the difference between "the site declares this is the page's
    title" and "this is the text a human would read first". A gallery page that
    renders itself in JavaScript leaves the second kind empty of meaning: its
    ``<h1>`` holds site chrome, and reporting that as the work's title is a wrong
    answer rather than a missing one.

    A candidate that is the site talking about itself — its own declared name, or
    its own domain — is refused rather than returned, so a later source still gets
    its turn: a page can put the site in `og:title` and the work in its `<h1>`.
    ``refused`` names the sources that were refused that way, because "the page
    called itself the title" and "the page has no title at all" are different
    findings and must not be reported as one.

    Element text and attribute values are already entity-decoded by the parser
    (``html.parser`` unescapes attribute values and ``convert_charrefs`` handles
    text), so nothing here runs a second unescape over them.
    """
    site = site_name_of(root)
    refused: list[str] = []

    def is_chrome(value: str) -> bool:
        return is_site_name(value, site) or mentions_host(value, host)

    def take(value: str, source: str, verified: bool) -> tuple[str, str, bool, list[str]] | None:
        if not value.strip():
            return None
        if is_chrome(value):
            refused.append(source)
            return None
        return value.strip(), source, verified, refused

    for key in OG_TITLE:
        meta = select_one(root, f'meta[property="{key}"]') or select_one(root, f'meta[name="{key}"]')
        if meta is not None:
            taken = take(meta.attr("content") or "", f"meta:{key}", True)
            if taken is not None:
                return taken

    for node in jsonld_nodes(html):
        kind = str(node.get("@type", ""))
        if not any(work in kind for work in WORK_TYPES):
            continue
        for key in JSONLD_TITLE_KEYS:
            value = node.get(key)
            if isinstance(value, str):
                taken = take(value, f"jsonld:{key}", True)
                if taken is not None:
                    return taken

    heading = select_one(root, "h1")
    if heading is not None:
        taken = take(heading.text(), "h1", False)
        if taken is not None:
            return taken
    node = select_one(root, "title")
    if node is not None:
        taken = take(node.text(), "title", False)
        if taken is not None:
            return taken
    return None, None, False, refused


# --- cover candidates ------------------------------------------------------ #

def _candidates_meta(root) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for key in ("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"):
        meta = select_one(root, f'meta[property="{key}"]') or select_one(root, f'meta[name="{key}"]')
        if meta is not None:
            value = (meta.attr("content") or "").strip()
            if value:
                found.append((value, "meta"))
    return found


def _candidates_jsonld(html: str) -> list[tuple[str, str]]:
    """`image` / `thumbnailUrl` / `primaryImageOfPage`, from every JSON-LD node."""
    found: list[tuple[str, str]] = []
    for node in jsonld_nodes(html):
        for key in ("image", "thumbnailUrl", "primaryImageOfPage"):
            value = node.get(key)
            if isinstance(value, str) and value.strip():
                found.append((value.strip(), "jsonld"))
            elif isinstance(value, dict) and isinstance(value.get("url"), str):
                found.append((value["url"].strip(), "jsonld"))
            elif isinstance(value, list) and value and isinstance(value[0], str):
                found.append((value[0].strip(), "jsonld"))
    return found


def boilerplate_reason(url: str) -> str | None:
    """Why this URL looks like site chrome rather than a cover, or None."""
    parsed = urlparse(url)
    name = parsed.path.rstrip("/").rsplit("/", 1)[-1].lower()
    for hint in BOILERPLATE_IN_NAME:
        if hint in name:
            return f"name contains {hint!r}"
    path = parsed.path.lower()
    for hint in BOILERPLATE_IN_PATH:
        if hint in path:
            return f"path contains {hint!r}"
    return None


# The attributes an <img> can carry its real image in, the lazy ones first. A
# lazy-loading site puts a 1px placeholder in `src` and the real URL in a `data-*`
# attribute, so reading `src` first — as this did — finds the placeholder, stops,
# and never sees the cover at all.
IMAGE_SOURCE_ATTRS = ("data-original", "data-src", "data-lazy-src",
                      "data-actualsrc", "src")


def _image_sources(image) -> list[str]:
    """Every image URL this <img> declares, the likeliest real one first."""
    found: list[str] = []
    for attr in IMAGE_SOURCE_ATTRS:
        value = (image.attr(attr) or "").strip()
        if value and value not in found:
            found.append(value)
    return found


def _candidates_images(root) -> tuple[list[tuple[str, str]], list[str]]:
    """Images on the page, ranked by how much they look like a cover.

    Size attributes are a strong signal when the site declares them, and the
    surrounding words catch the rest. A candidate that looks like site chrome is
    dropped outright rather than merely ranked lower — picking a logo as a cover
    is the worst available outcome, worse than returning nothing — and the reason
    it was dropped is kept, because a page whose every image was skipped looks
    exactly like a page with no images at all.

    Sources are returned as written, relative and protocol-relative ones
    included: ``/cover.jpg`` is the commonest way to point at a cover, and
    absolutising belongs to the caller that knows the page URL.
    """
    scored: list[tuple[int, list[str]]] = []
    skipped: list[str] = []
    for image in select_all(root, "img"):
        declared = _image_sources(image)
        if not declared:
            continue
        sources = [src for src in declared if boilerplate_reason(src) is None]
        if not sources:
            reason = boilerplate_reason(declared[0]) or "site chrome"
            skipped.append(reason)
            continue
        hay = " ".join(filter(None, (image.attr("class"), image.attr("id"),
                                    image.attr("alt"), image.attr("itemprop")))).lower()
        score = 0
        score += sum(2 for word in ("cover", "poster", "thumbnail", "main", "detail",
                                    "album", "book") if word in hay)
        score += sum(1 for word in ("cover", "poster") if word in sources[0].lower())
        for attr in ("width", "height"):
            value = image.attr(attr)
            if value and value.isdigit():
                score += min(int(value) // 150, 6)
        scored.append((score, sources))
    scored.sort(key=lambda pair: -pair[0])
    pairs = [(src, "img") for _score, sources in scored[:8] for src in sources]
    return pairs, skipped


def cover_candidates(root, html: str, page_url: str) -> tuple[list[tuple[str, str]], list[str]]:
    """Every candidate, best first, absolutised and deduplicated by identity.

    Returns ``(candidates, skipped)``. ``candidates`` holds the URL to fetch —
    the candidate as written on the page, resolved against it — and its channel.
    A candidate that repeats with only a fragment or a tracking parameter added is
    the same image and is tried once, not twice. A source that resolves to
    something other than http(s) — a `data:` or `javascript:` URI — is dropped
    here rather than handed to a transport that cannot fetch it.

    ``skipped`` counts what discovery threw away and why, aggregated. Without it a
    page whose every image was dismissed as chrome is indistinguishable from a
    page with no images.
    """
    ordered: list[tuple[str, str]] = []
    for source in (_candidates_meta(root), _candidates_jsonld(html)):
        ordered.extend(source)
    image_pairs, image_skipped = _candidates_images(root)
    ordered.extend(image_pairs)

    skipped = Counter(image_skipped)
    seen: set[str] = set()
    result: list[tuple[str, str]] = []
    for value, label in ordered:
        absolute = urljoin(page_url, value).strip()
        if not absolute.startswith(("http://", "https://")):
            skipped["does not resolve to an http(s) URL"] += 1
            continue
        key = comparison_url(absolute)
        if key in seen:
            skipped["the same image, repeated"] += 1
            continue
        seen.add(key)
        result.append((absolute, label))

    reasons = [f"{count} image(s): {reason}" for reason, count in sorted(skipped.items())]
    return result, reasons


# --- validating a candidate ------------------------------------------------ #

def inspect_image(data: bytes) -> tuple[int, int] | None:
    """Pixel size, ``(0, 0)`` when the bytes are not an image, ``None`` with no Pillow."""
    try:
        import io

        from PIL import Image
    except ImportError:
        return None

    try:
        with Image.open(io.BytesIO(data)) as image:
            return int(image.width), int(image.height)
    except Exception:  # noqa: BLE001 - unreadable means unusable
        return (0, 0)


def acceptable(width: int, height: int) -> tuple[bool, str]:
    if width <= 0 or height <= 0:
        return False, "not an image"
    if min(width, height) < MIN_SIDE:
        return False, f"too small ({width}x{height})"
    longest, shortest = max(width, height), min(width, height)
    if longest / shortest > MAX_ASPECT:
        return False, f"bad shape ({width}x{height})"
    return True, f"{width}x{height}"


def extension_for(content_type: str, data: bytes) -> str:
    kind = content_type.split(";")[0].strip().lower()
    if kind in ("image/jpeg", "image/jpg"):
        return ".jpg"
    if kind == "image/png":
        return ".png"
    if kind == "image/webp":
        return ".webp"
    if data[:2] == b"\xff\xd8":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"RIFF":
        return ".webp"
    return ""


# A page that builds itself in JavaScript ships an empty mount point and tells the
# visitor to enable JavaScript. Nothing in it can be read without a browser, and
# saying which kind of unreadable this is matters: "this site needs a selector"
# and "the data was never sent" are different work with different costs.
MOUNT_POINTS = ("#app", "#root", "#__next", "#nuxt", "#__nuxt", "#__layout",
                "#svelte", "#main-app")
JS_REQUIRED = re.compile(
    r"enable\s+javascript|requires?\s+javascript|turn\s+on\s+javascript"
    r"|请(?:开启|启用)\s*javascript|需要\s*javascript",
    re.IGNORECASE,
)

# A framework's hydration state, embedded as script source rather than as JSON.
# The data was sent — unlike a page that ships nothing but its bundle — but it is
# not something a parser can lift out either: it is minified JavaScript, with the
# values behind positional parameters and escapes like \u002F standing in for /.
HYDRATION_MARKERS = ("window.__NUXT__", "__NEXT_DATA__", "__INITIAL_STATE__",
                     "window.__PRELOADED_STATE__", "__APOLLO_STATE__")


def client_rendered(root, html: str) -> bool:
    """Whether the page's content is built by script rather than sent as HTML."""
    noscript = select_one(root, "noscript")
    if noscript is not None and JS_REQUIRED.search(noscript.text() or ""):
        return True
    for selector in MOUNT_POINTS:
        mount = select_one(root, selector)
        if mount is not None and not mount.text():
            return True
    return False


def hydration_blob(html: str) -> str | None:
    """The name of an embedded state blob, when the page ships one."""
    for marker in HYDRATION_MARKERS:
        if marker in html:
            return marker
    return None


def mentions_host(value: str, host: str | None) -> bool:
    """Whether a title names the page's own domain, which makes it chrome.

    "女神社 - nshens.com" is a site's name plus its address, and it is the shape a
    blog's ``<title>`` almost always has. A work is not titled with the domain of
    the site it is published on.
    """
    if not host:
        return False
    bare = host[4:] if host.startswith("www.") else host
    return bool(bare) and bare.casefold() in value.casefold()


# --- the entry point ------------------------------------------------------- #

def _blank(url: str) -> dict[str, Any]:
    return {
        "input_url": url,
        "source_url": None,
        "outcome": Outcome.FETCH_FAILED,
        "kind": "retryable",
        "detail": "",
        "status": None,
        "title": None,
        "title_from": None,
        "title_verified": False,
        "cover": None,
        "cover_source": None,
        "cover_from": None,
        "cover_size": None,
        "cover_bytes": None,
        "cover_rank": None,
        "cover_verified": False,
        "candidates": 0,
        "rejected": [],
        "skipped": [],
        "client_rendered": False,
        "hydration": None,
        "challenge": None,
        "notes": [],
    }


def _finish(result: dict[str, Any], outcome: str, detail: str) -> dict[str, Any]:
    result["outcome"] = outcome
    result["kind"] = outcome_kind(outcome)
    result["detail"] = detail
    return result


def read_work(url: str, *, save_dir: Path, stem: str | None = None) -> dict[str, Any]:
    """Title plus a cover that has been fetched and checked. Never raises.

    ``save_dir`` is required because the bytes are the deliverable: a cover URL is
    not, since a page loaded later hits Referer restrictions, expiring tokens and
    TLS fingerprinting. The caller decides where they land — ``level0_export``
    puts them in the export document's own folder.

    ``source_url`` is the URL after redirects and is the stable identity of the
    work; ``input_url`` is what the caller passed. ``cover_source`` is the URL the
    cover bytes came from, which may carry a token and so is not an identity.
    """
    result = _blank(url)

    if not readable_url(url):
        return _finish(result, Outcome.BAD_INPUT,
                       "not an http(s) URL, so there is nothing to fetch")

    try:
        status, body, kind, final = fetch(url)
    except Exception as error:  # noqa: BLE001 - reported, not raised
        result["notes"].append(f"page fetch failed: {type(error).__name__}: {str(error)[:60]}")
        return _finish(result, Outcome.FETCH_FAILED,
                       f"the page could not be fetched ({type(error).__name__}); it may work later")

    result["status"] = status
    result["source_url"] = final

    # An error page has a <title> too, and reporting it as the work's title is
    # exactly the silent wrong answer this reader must not give. The body is not
    # read for content, but it does say *why* the content was withheld, and a bot
    # check is a different problem from a missing page.
    if not (200 <= status < 300):
        challenge = challenge_of(body.decode("utf-8", "replace"))
        result["challenge"] = challenge
        if challenge:
            return _finish(result, Outcome.BLOCKED,
                           f"the server refused the request (HTTP {status}) with a "
                           f"{challenge} bot check, which a plain request cannot pass; "
                           "it needs a browser session or a saved cookie")
        return _finish(result, Outcome.HTTP_ERROR,
                       f"the page answered HTTP {status}, so its body was not read")

    if "html" not in kind and not body.lstrip().startswith(b"<"):
        return _finish(result, Outcome.NOT_HTML,
                       f"not an HTML page ({kind or 'unknown type'}); this needs a site rule")

    html = body.decode("utf-8", "replace")
    root = parse_html(html)

    # Checked before anything is read from the page: a gate that declares og tags
    # and shows an image would otherwise be taken for a complete work.
    if login_gate(root):
        return _finish(result, Outcome.BLOCKED,
                       "the page is a login form: it asks for credentials before "
                       "showing anything, so this work needs a session this reader "
                       "does not hold")

    candidates, skipped = cover_candidates(root, html, final)
    result["candidates"] = len(candidates)
    result["skipped"] = skipped
    # A property of the page, not of this run's failure: a JavaScript-built page
    # can also lose its cover for an ordinary reason, and a page that yielded both
    # fields is readable whatever it is built with.
    result["client_rendered"] = client_rendered(root, html)
    result["hydration"] = hydration_blob(html)

    # A shell serves one <title> for every route it has, so on a page that carried
    # nothing else that title is the same string every page of the site shows. It
    # cannot be this work's, and taking it puts the site's name in the library.
    carried_nothing = (result["client_rendered"] and not candidates
                       and not result["hydration"])

    title, title_source, title_verified, refused_titles = title_of(
        root, html, urlparse(final).hostname,
    )
    if carried_nothing and title is not None and not title_verified:
        result["notes"].append(
            f"the page carried nothing but its shell, so the title it shows ({title!r}) "
            "is the one every page of this site has, not this work's"
        )
        title, title_source = None, None
    result["title"] = title
    result["title_from"] = title_source
    result["title_verified"] = title_verified
    if title is not None and not title_verified:
        result["notes"].append(
            "the only title found was page text (h1/title) and no structured source "
            "confirmed it, so it may be site chrome rather than this work's title"
        )
    if title is None and refused_titles:
        # Only when something was actually refused: "the page called itself the
        # title" is a finding, and reporting it for a page that has no title at all
        # states something that did not happen.
        site = site_name_of(root)
        if site:
            result["notes"].append(
                f"every title on the page is the site's own name ({site!r}), so none "
                "of them was taken as this work's title"
            )
        else:
            result["notes"].append(
                "every title on the page names the site itself, so none of them was "
                "taken as this work's title"
            )

    # A JavaScript shell explains the whole page, so it is said before any single
    # missing field is: nothing here is readable, and the reason is the shell
    # rather than whichever field happened to be looked for first.
    if result["client_rendered"] and not candidates:
        return _finish(result, Outcome.NO_CANDIDATES, _shell_detail(result, url))

    if title is None and not candidates:
        return _finish(result, Outcome.NO_TITLE,
                       "neither a title nor a cover could be read; this site needs a rule")

    cover_outcome = _fetch_cover(result, candidates, final, save_dir, stem)

    # A `meta` or `jsonld` candidate is the site *declaring* a cover; an `img` one
    # is this reader guessing at one. That difference decides whether the page is
    # unreadable in principle or merely had an unusable cover, and it is the
    # difference a JavaScript-rendered gallery turns on: its declared cover does
    # not exist in the HTML, so only a ghost placeholder is ever found.
    declared = any(label != "img" for _url, label in candidates)

    if cover_outcome == "saved":
        if title is None:
            return _finish(result, Outcome.COVER_ONLY,
                           "a cover was saved but no title could be read")
        return _finish(result, Outcome.OK,
                       f"{len(candidates)} candidate(s); the first usable one was saved")

    # A JavaScript-built page explains itself better than a failed candidate does:
    # what such a shell "declares" is its own logo and its own name, so a declared
    # cover that was refused is a symptom, not the reason.
    if result["client_rendered"]:
        return _finish(result, Outcome.NO_CANDIDATES, _shell_detail(result, url))
    if declared:
        return _finish(result, Outcome.CANDIDATES_REJECTED,
                       f"all {len(candidates)} cover candidate(s) the page declares "
                       "were tried and none was usable")
    return _finish(result, Outcome.NO_CANDIDATES,
                   "the page declares no cover and shows no usable image, so this "
                   "site needs a rule to be read")


def _shell_detail(result: dict[str, Any], url: str) -> str:
    """Why a JavaScript shell cannot be read, named as precisely as it is known."""
    fragment = urlparse(url).fragment
    if fragment.startswith(("/", "!/")):
        # A hash router keeps the whole route in the fragment, and a fragment is
        # the one part of a URL a server never receives: the request that went out
        # was for the site's front page, so the work was never asked for at all.
        return ("the page is a JavaScript shell whose route lives in the URL fragment "
                f"({fragment!r}); a server never receives a fragment, so the request "
                "was for the site's front page and this work's data was never sent")
    if result["hydration"]:
        return (f"the page is a JavaScript shell that ships its data as "
                f"{result['hydration']}, script source rather than markup or JSON, "
                "so reading it needs a rule")
    return ("the page builds itself in JavaScript: its HTML carries an empty mount "
            "point and no data at all, so nothing here can be read without a browser "
            "or an API rule")


def _fetch_cover(result: dict[str, Any], candidates: list[tuple[str, str]],
                 page_url: str, save_dir: Path, stem: str | None) -> str:
    """Try each candidate in order; the first usable one is saved. "saved"/"rejected"/"none"."""
    if not candidates:
        return "none"

    # The page URL is the referer: several of these CDNs refuse an image request
    # without it, and the page we just read is the natural one to claim.
    target_dir = save_dir
    target_stem = stem or _stem_for(page_url)
    unverified = False

    for index, (candidate, label) in enumerate(candidates, start=1):
        try:
            image_status, data, content_type, _ = fetch(candidate, referer=page_url)
        except Exception as error:  # noqa: BLE001 - try the next candidate
            result["rejected"].append(f"{label}: {type(error).__name__}")
            continue
        if image_status != 200 or not data:
            result["rejected"].append(f"{label}: HTTP {image_status}")
            continue
        extension = extension_for(content_type, data)
        if not extension:
            kind = (content_type or "?").split(";")[0].strip().lower()
            if kind == "image/svg+xml":
                # An SVG is an image; it is just not a cover. A site whose og:image
                # is its own logo is declaring chrome, and there is no way to check
                # the drawn size of a vector anyway.
                result["rejected"].append(f"{label}: an SVG is site chrome, not a cover")
            else:
                result["rejected"].append(f"{label}: not an image ({content_type or '?'})")
            continue

        measured = inspect_image(data)
        if measured is None:
            # Pillow is an optional extra. Without it the bytes can still be
            # served and saved, but nothing here can promise they are a cover
            # rather than a badge — so say so instead of failing every candidate.
            unverified = True
            detail = f"{len(data)} bytes, unverified"
        else:
            ok, detail = acceptable(*measured)
            if not ok:
                result["rejected"].append(f"{label}: {detail}")
                continue

        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / f"{target_stem}{extension}"
        path.write_bytes(data)
        result["cover"] = str(path)
        result["cover_source"] = candidate
        result["cover_from"] = label
        result["cover_size"] = detail
        result["cover_bytes"] = len(data)
        result["cover_rank"] = index
        result["cover_verified"] = not unverified
        if unverified:
            result["notes"].append(
                "Pillow is not installed, so the image was saved without checking its "
                "dimensions; install the 'media' extra to reject badges and logos"
            )
        return "saved"

    return "rejected"


def _stem_for(url: str) -> str:
    """A file name that no other work can claim.

    The host and path tail are for a human reading the folder; the digest is what
    makes it unique. Two different works routinely share a path shape (`/view`,
    `/`, `/post`), and without the digest the second one silently overwrites the
    first — a cover that was downloaded and then lost.
    """
    parsed = urlparse(url)
    tail = re.sub(r"[^A-Za-z0-9._-]+", "_", (parsed.path.rstrip("/").rsplit("/", 1) or [""])[-1])
    host = re.sub(r"[^A-Za-z0-9.-]+", "_", parsed.hostname or "cover")
    digest = hashlib.sha1(comparison_url(url).encode("utf-8")).hexdigest()[:6]
    return f"{host}_{tail or 'cover'}_{digest}"[:96]


# --- the human report ------------------------------------------------------ #

RULE = "=" * 72
THIN = "-" * 72
INDENT = " " * 9


def _label(name: str) -> str:
    return f" {name:<7} "


def _emit(lines: list[str], text: str, width: int = 70) -> None:
    for chunk in textwrap.wrap(text, width=width) or [""]:
        lines.append(INDENT + chunk)


def format_report(result: dict[str, Any]) -> str:
    """One result as a block a person reads, for the standalone CLI.

    Says what it read, where each value came from, and — when it could not read
    the page — what stopped it. The `rejected` lines are the evidence: a page that
    looks like it should work and does not is only diagnosable from them.

    Prose wraps; a URL and a file path do not. A path broken across two lines is
    one a person cannot copy or click, which is the only thing they want it for.
    """
    lines: list[str] = [RULE, " LEVEL 0  title + cover, any site, no site rule", RULE]

    lines.append(_label("link") + str(result.get("input_url") or ""))
    status = result.get("status")
    lines.append(_label("page") + (f"HTTP {status}" if status is not None else "not fetched"))
    lines.append(_label("final") + str(result.get("source_url") or "(unknown)"))
    lines.append(THIN)

    lines.append(_label("result") + f"{result.get('outcome')}  [{result.get('kind')}]")
    _emit(lines, str(result.get("detail") or ""))

    title = result.get("title")
    if title is None:
        lines.append(_label("title") + "none")
    else:
        mark = "confirmed" if result.get("title_verified") else "UNCONFIRMED"
        lines.append(_label("title") + str(title))
        _emit(lines, f"source: {result.get('title_from')} ({mark})")

    cover = result.get("cover_source")
    if cover is None:
        lines.append(_label("cover") + "none")
    else:
        image = "verified" if result.get("cover_verified") else "UNVERIFIED (no Pillow)"
        lines.append(_label("cover") + (
            f"saved  {result.get('cover_size')}  {result.get('cover_bytes')} bytes  "
            f"{image}  (candidate #{result.get('cover_rank')} via {result.get('cover_from')})"
        ))
        # Which URL it came from is what tells a person whether this is the cover
        # or an illustration from the page's sidebar.
        lines.append(INDENT + f"from {result.get('cover_source')}")
        if result.get("cover_mime"):
            lines.append(INDENT + f"{result.get('cover_mime')}")

    # What happened to what was read. This line used to be the export path the library would
    # collect; Level 0 writes no files now, so it says that instead of leaving a person hunting for
    # a folder that no longer appears.
    lines.append(_label("kept") + (
        "nothing — Level 0 reads and reports; it writes no files"
    ))

    for heading in ("rejected", "skipped", "notes"):
        entries = result.get(heading) or []
        if not entries:
            continue
        lines.append(THIN)
        lines.append(_label(heading) + f"{len(entries)}")
        for entry in entries:
            _emit(lines, str(entry))

    lines.append(RULE)
    return "\n".join(lines)
