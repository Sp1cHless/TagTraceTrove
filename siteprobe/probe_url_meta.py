"""Generic single-URL reader: given a work page, find cover / title / author / tags.

No per-site rules. The order of sources is the order of trustworthiness:

    JSON-LD (schema.org)  >  OpenGraph / Twitter cards  >  plain meta  >  heuristics

Each field records which source produced it, because "found nothing" and "found
something wrong" need telling apart when deciding whether a site needs a template.

    python probe_url_meta.py <url> [<url> ...]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.generic.htmltree import parse_html, select_all, select_one  # noqa: E402

TIMEOUT = 25
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140 Safari/537.36")


def fetch(url: str) -> tuple[int, str, str]:
    """(status, body, final_url). Impersonated when curl_cffi is available."""
    headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    try:
        from curl_cffi import requests as curl_requests

        response = curl_requests.get(url, impersonate="chrome", headers=headers,
                                     timeout=TIMEOUT, allow_redirects=True)
        return response.status_code, response.text, str(response.url)
    except ImportError:
        import urllib.request

        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=TIMEOUT) as reply:
            return reply.status, reply.read().decode("utf-8", "replace"), reply.url


# --- sources --------------------------------------------------------------- #

def jsonld_documents(html: str) -> list[dict[str, Any]]:
    """Every JSON-LD object on the page, flattened out of arrays and @graph."""
    found: list[dict[str, Any]] = []
    for match in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.DOTALL | re.IGNORECASE,
    ):
        raw = match.group(1).strip()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        stack = [payload]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                found.append(node)
                for key in ("@graph", "itemListElement", "mainEntity", "about"):
                    if isinstance(node.get(key), (dict, list)):
                        stack.append(node[key])
            elif isinstance(node, list):
                stack.extend(node)
    return found


def _text(value: Any) -> str | None:
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        for key in ("name", "@id", "url"):
            if isinstance(value.get(key), str) and value[key].strip():
                return value[key].strip()
    if isinstance(value, list) and value:
        return _text(value[0])
    return None


def _image(value: Any) -> str | None:
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        for key in ("url", "contentUrl", "@id"):
            if isinstance(value.get(key), str) and value[key].strip():
                return value[key].strip()
    if isinstance(value, list) and value:
        return _image(value[0])
    return None


JSONLD_FIELDS = {
    "title": ("name", "headline", "alternativeHeadline"),
    "author": ("author", "creator", "director", "byArtist"),
    "date": ("datePublished", "dateCreated", "uploadDate"),
    "tags": ("keywords", "genre"),
    "description": ("description",),
}


def from_jsonld(html: str) -> dict[str, str]:
    """A `@type` that looks like a work wins over a bare organisation node."""
    documents = jsonld_documents(html)
    if not documents:
        return {}
    preferred = ("ComicStory", "Book", "Movie", "TVSeries", "VideoObject",
                 "CreativeWork", "Article", "Product", "ImageGallery")
    documents.sort(key=lambda node: 0 if any(
        kind in str(node.get("@type", "")) for kind in preferred) else 1)

    result: dict[str, str] = {}
    for node in documents:
        for field, keys in JSONLD_FIELDS.items():
            if field in result:
                continue
            for key in keys:
                value = node.get(key)
                text = _image(value) if field == "cover" else _text(value)
                if isinstance(value, list) and field == "tags":
                    text = ", ".join(v for v in (_text(v) for v in value) if v)
                if text:
                    result[field] = text
                    break
        image = None
        for key in ("image", "thumbnailUrl", "primaryImageOfPage"):
            image = _image(node.get(key))
            if image:
                break
        if image and "cover" not in result:
            result["cover"] = image
    return result


META_FIELDS = (
    ("title", ("og:title", "twitter:title")),
    ("cover", ("og:image", "og:image:secure_url", "twitter:image")),
    ("description", ("og:description", "twitter:description", "description")),
    ("date", ("article:published_time", "og:updated_time", "date")),
    ("author", ("author", "article:author", "og:article:author")),
    ("tags", ("keywords", "news_keywords", "article:tag")),
    ("type", ("og:type",)),
)


def from_meta(root) -> dict[str, str]:
    """OpenGraph / Twitter / plain meta, in that order within each field."""
    result: dict[str, str] = {}
    metas = select_all(root, "meta")
    by_property: dict[str, str] = {}
    by_name: dict[str, str] = {}
    for meta in metas:
        content = meta.attr("content")
        if not content:
            continue
        prop = (meta.attr("property") or "").strip().lower()
        name = (meta.attr("name") or meta.attr("itemprop") or "").strip().lower()
        if prop:
            by_property.setdefault(prop, content.strip())
        if name:
            by_name.setdefault(name, content.strip())
    for field, keys in META_FIELDS:
        for key in keys:
            value = by_property.get(key) or by_name.get(key)
            if value:
                result[field] = value
                break
    return result


def from_page(root, page_url: str) -> dict[str, str]:
    """Last resort: the parts of a page that a human would read first."""
    result: dict[str, str] = {}
    title = select_one(root, "title")
    if title is not None and title.text():
        result["title"] = title.text()
    heading = select_one(root, "h1")
    if heading is not None and heading.text():
        result["heading"] = heading.text()
    when = select_one(root, "time")
    if when is not None:
        stamp = when.attr("datetime")
        if stamp:
            result["date"] = stamp
    canonical = select_one(root, "link[rel='canonical']")
    if canonical is not None and canonical.attr("href"):
        result["canonical"] = canonical.attr("href")
    best: tuple[int, str] | None = None
    for image in select_all(root, "img"):
        src = image.attr("src") or image.attr("data-src") or image.attr("data-original")
        if not src:
            continue
        # Absolutised against the final URL, exactly as the reader does it: a
        # site-relative `/cover.jpg` is the commonest way to point at a cover, and
        # skipping it here would report "no cover" for the commonest markup.
        src = urljoin(page_url, src.strip())
        if not src.startswith(("http://", "https://")):
            continue
        score = 0
        if image.attr("srcset"):
            score += 1
        hay = (src + " " + (image.attr("class") or "") + " " + (image.attr("alt") or "")).lower()
        score += sum(2 for word in ("cover", "poster", "thumb", "main", "detail") if word in hay)
        for attr in ("width", "height"):
            value = image.attr(attr)
            if value and value.isdigit():
                score += min(int(value) // 200, 4)
        if best is None or score > best[0]:
            best = (score, src)
    if best is not None:
        result["cover"] = best[1]
    return result


def cover_reachable(url: str) -> str:
    """Whether the cover URL actually serves an image — a URL string proves nothing."""
    try:
        from curl_cffi import requests as curl_requests

        response = curl_requests.get(url, impersonate="chrome", timeout=TIMEOUT,
                                     headers={"User-Agent": UA}, stream=True)
        kind = (response.headers.get("content-type") or "").split(";")[0]
        return f"{response.status_code} {kind}"
    except ImportError:
        return "no curl_cffi"


def probe(url: str) -> dict[str, Any]:
    try:
        status, html, final = fetch(url)
    except Exception as error:  # noqa: BLE001 - reported, not raised
        return {"url": url, "error": f"{type(error).__name__}: {str(error)[:70]}"}

    root = parse_html(html)
    layers = [
        ("jsonld", from_jsonld(html)),
        ("meta", from_meta(root)),
        ("page", from_page(root, final)),
    ]
    out: dict[str, Any] = {"url": url, "status": status, "bytes": len(html)}
    for field in ("title", "cover", "author", "date", "tags", "description"):
        for name, layer in layers:
            if layer.get(field):
                out[field] = layer[field]
                out[f"{field}_from"] = name
                break
    page_layer = layers[2][1]
    for extra in ("heading", "canonical"):
        if page_layer.get(extra):
            out[extra] = page_layer[extra]
    if out.get("cover", "").startswith("http"):
        out["cover_http"] = cover_reachable(out["cover"])
    return out


def main(argv: list[str]) -> int:
    for url in argv:
        row = probe(url)
        print(json.dumps(row, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
