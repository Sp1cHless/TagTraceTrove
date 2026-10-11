"""Work-URL parsing, for the forms a person actually pastes.

A copied work link carries a page anchor (`...html#1`), a query, a trailing slash
or a percent-encoded title. Getting this wrong reads the wrong work or fails
outright, and it has broken twice, so every site's parser is pinned here.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic.registry import resolve_input  # noqa: E402
# The adapters are data in the SiteProbe home now, so each is imported from where it lives —
# the same way the runtime loads a site's reader (`registry.load_fetcher`).
from src.builder import paths  # noqa: E402

_INSTALLED = paths.home() / "installed"
sys.path.insert(0, str(_INSTALLED))
from comic18.fetch import work_id_from_url as comic_id  # noqa: E402
from hanime1_me.fetch import work_id_from_url as hanime_id  # noqa: E402
from hitomi_la.fetch import work_id_from_url as hitomi_id  # noqa: E402

HITOMI_FORMS = {
    "https://hitomi.la/galleries/1023558.html": "1023558",
    "https://hitomi.la/galleries/1023558.html#3": "1023558",
    "https://hitomi.la/galleries/1023558/": "1023558",
    "https://hitomi.la/doujinshi/x-1023558.html": "1023558",
    # a percent-encoded title, plus the page anchor a copied link carries
    "https://hitomi.la/doujinshi/mechanized-memories--decensored--%E4%B8%AD%E6%96%87-3160571.html#1":
        "3160571",
    "https://hitomi.la/cg/foo-999.html?lang=zh": "999",
}


@pytest.mark.parametrize("url,expected", HITOMI_FORMS.items(), ids=list(HITOMI_FORMS))
def test_hitomi_reads_the_id_from_every_url_form(url, expected):
    assert hitomi_id(url) == expected


def test_hanime_and_comic_read_their_ids():
    assert hanime_id("https://hanime1.me/watch?v=406781") == "406781"
    assert hanime_id("https://hanime1.me/watch?list=1&v=406781#top") == "406781"
    assert comic_id("https://18comic.vip/album/1472965/") == "1472965"
    assert comic_id("https://18comic.vip/album/1472965/a-slug?series_sort=2") == "1472965"


def test_an_unreadable_url_says_so():
    with pytest.raises(ValueError):
        hitomi_id("https://hitomi.la/artist/someone-all.html")


@pytest.mark.parametrize("url,kind", [
    ("https://hitomi.la/doujinshi/x-1023558.html#1", "work"),
    ("https://hitomi.la/galleries/1023558.html", "work"),
    ("https://hanime1.me/watch?v=406781", "work"),
    ("https://18comic.vip/album/1472965/", "album"),
])
def test_a_pasted_work_url_resolves_to_a_single_work_target(url, kind):
    template, resolved_kind, ref = resolve_input(url)
    assert resolved_kind == kind
    assert template.targets[kind].single, "a work URL must be marked single"
    assert ref["id"]
