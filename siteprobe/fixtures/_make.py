"""Regenerate the golden fixtures the Harvester's tests read.

The plan (§20.2) asks for content-neutral fixtures so that the tests pin behaviour
without depending on a live site: every site below is invented, and each fixture
carries the values that must be found, so a fixture and its expectation cannot
drift apart.

    fixtures/<case>/
        page.html          the markup, as sent
        network_N.json     a response body, when the case has one
                           (an underscore, not the `network:N` document name:
                            a colon in a Windows filename is a data stream)
        expected.json      {"recall": [...], "provenance": {value: channel}}

Run:  .venv/Scripts/python.exe fixtures/_make.py
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = "https://fixture.test"

STATIC_WORK = """<!doctype html>
<html><head>
  <title>Quiet Harbor - Example Site</title>
  <meta property="og:title" content="Quiet Harbor">
  <meta name="description" content="A short description of the work.">
</head><body>
  <header><nav><a href="/">Home</a><a href="/tags">Tags</a></nav></header>
  <main>
    <h1>Quiet Harbor</h1>
    <img class="cover" src="/media/quiet-harbor/cover.png" width="640" height="900"
         alt="Quiet Harbor cover">
    <div class="meta"><span data-author="Lin Wei">Lin Wei</span></div>
  </main>
</body></html>
"""

JSONLD_WORK = """<!doctype html>
<html><head>
  <title>Salt and Iron - Example Site</title>
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Book","name":"Salt and Iron",
   "image":{"@type":"ImageObject","url":"/media/salt-and-iron.jpg"},
   "author":{"@type":"Person","name":"R. Okafor"},
   "datePublished":"2021-03-04","numberOfPages":248}
  </script>
</head><body><h1>Salt and Iron</h1></body></html>
"""

HYDRATED_WORK = """<!doctype html>
<html><head><title>Example Site</title></head><body>
  <div id="app"></div>
  <script>
    window.__NUXT__ = {"data":[{"work":{"title":"Lantern Season",
      "cover":"\\/media\\/lantern-season.jpg","id":8842,
      "creator":{"name":"Nao Ito"}}}],"config":{"locale":"ja"}};
  </script>
</body></html>
"""

API_SHELL = """<!doctype html>
<html><head><title>Example Site</title></head><body>
  <div id="app"></div>
  <script src="/assets/bundle.js"></script>
</body></html>
"""

API_RESPONSE = {
    "data": {
        "post": {
            "title": "Harbor Lights",
            "image": {"url": "https://cdn.fixture.test/harbor-lights.webp"},
            "creator": {"name": "June Park"},
            "publishedAt": "2022-07-01",
        },
    },
}

REPEATED_LISTING = """<!doctype html>
<html><head><title>Library listing</title></head><body>
  <ul id="grid">
    <li class="card"><a href="/work/1"><h3>First Work</h3></a>
      <img src="/c/1.jpg" width="300" height="420"></li>
    <li class="card"><a href="/work/2"><h3>Second Work</h3></a>
      <img src="/c/2.jpg" width="300" height="420"></li>
    <li class="card"><a href="/work/3"><h3>Third Work</h3></a>
      <img src="/c/3.jpg" width="300" height="420"></li>
  </ul>
</body></html>
"""

PAGINATION = """<!doctype html>
<html><head><title>Library listing</title></head><body>
  <ul><li class="card"><a href="/work/1"><h3>First Work</h3></a></li></ul>
  <nav class="pager">
    <a class="page" href="/list?page=1">1</a>
    <a class="page" href="/list?page=2">2</a>
    <a rel="next" href="/list?page=2">Next</a>
  </nav>
</body></html>
"""

FIXTURES: dict[str, dict] = {
    "static_work": {
        "page.html": STATIC_WORK,
        "expected.json": {
            "recall": ["Quiet Harbor", "Lin Wei",
                       f"{BASE}/media/quiet-harbor/cover.png"],
            "provenance": {f"{BASE}/media/quiet-harbor/cover.png": "markup"},
        },
    },
    "jsonld_work": {
        "page.html": JSONLD_WORK,
        "expected.json": {
            "recall": ["Salt and Iron", "R. Okafor", "2021-03-04", "248",
                       f"{BASE}/media/salt-and-iron.jpg"],
            "provenance": {"R. Okafor": "jsonld",
                           f"{BASE}/media/salt-and-iron.jpg": "jsonld"},
        },
    },
    "hydrated_work": {
        "page.html": HYDRATED_WORK,
        "expected.json": {
            # The path is written with escaped slashes, which is why a string scan
            # cannot reach it and a real parse is what the channel is for.
            "recall": ["Lantern Season", "Nao Ito", "8842",
                       f"{BASE}/media/lantern-season.jpg"],
            "provenance": {"Lantern Season": "inline"},
        },
    },
    "api_work": {
        "page.html": API_SHELL,
        "network_0.json": json.dumps(
            {"url": "https://api.fixture.test/post/AB12CD34", "body": API_RESPONSE}, indent=2),
        "expected.json": {
            "recall": ["Harbor Lights", "June Park", "2022-07-01",
                       "https://cdn.fixture.test/harbor-lights.webp"],
            "provenance": {"Harbor Lights": "network"},
        },
    },
    # The shape measured on a real API: the page's own work sits at the root of one
    # response, and the works beside it sit under `results[]` of another. The two are
    # shaped identically, so only the path tells them apart.
    "related_api_work": {
        "page.html": API_SHELL,
        "network_0.json": json.dumps({
            "url": "https://api.fixture.test/video/AB12CD34",
            "body": {
                "title": "Quiet Harbor",
                "file": {"id": "11112222-3333-4444-5555-666677778888"},
                "user": {"name": "June Park"},
                "numComments": 4,
                "limit": 32,
            },
        }, indent=2),
        "network_1.json": json.dumps({
            "url": "https://api.fixture.test/video/AB12CD34/related",
            "body": {
                "results": [
                    {"title": "Some Other Work", "user": {"name": "Someone Else"}},
                    {"title": "Yet Another Work", "user": {"name": "Third Person"}},
                ],
                "limit": 32,
            },
        }, indent=2),
        "expected.json": {
            # Everything is still offered: recall does not depend on the ranking.
            "recall": ["Quiet Harbor", "Some Other Work", "Yet Another Work",
                       "June Park", "Someone Else"],
            "provenance": {"Quiet Harbor": "network"},
        },
    },
    "repeated_listing": {
        "page.html": REPEATED_LISTING,
        "expected.json": {
            # Nothing may be collapsed away before a person has chosen: the plan's
            # Phase 7 learns repeated cards from exactly this shape.
            "recall": ["First Work", "Second Work", "Third Work",
                       f"{BASE}/work/1", f"{BASE}/work/2", f"{BASE}/work/3",
                       f"{BASE}/c/1.jpg", f"{BASE}/c/2.jpg", f"{BASE}/c/3.jpg"],
        },
    },
    "pagination": {
        "page.html": PAGINATION,
        "expected.json": {
            "recall": [f"{BASE}/list?page=1", f"{BASE}/list?page=2"],
        },
    },
}


# --- three samples of one site, for Phase 5 --------------------------------- #
#
# The same structure three times, with two deliberate differences:
#   * the h1's class changes on the third page, so a rule learned from it reads
#     nothing there and has to be pruned — the plan's Example 2;
#   * `creator` is only in the first sample's annotation, so its rule is neither
#     supported nor contradicted and must be reported as unproven, not as a rule.
SAMPLE_PAGE = """<!doctype html>
<html><head>
  <title>{title} - Example Site</title>
  <meta property="og:title" content="{title}">
</head><body>
  <h1 class="{heading_class}">{title}</h1>
  <img class="work-cover" src="/media/{slug}/cover.jpg" width="600" height="850">
  <span class="byline">{creator}</span>
</body></html>
"""

SAMPLES = {
    "sample1": {"title": "Quiet Harbor", "slug": "quiet-harbor",
                "creator": "Lin Wei", "heading_class": "work-title",
                "annotation": {"title": "Quiet Harbor", "cover": "Quiet Harbor",
                               "creator": "Lin Wei"}},
    "sample2": {"title": "Salt and Iron", "slug": "salt-and-iron",
                "creator": "R. Okafor", "heading_class": "work-title",
                "annotation": {"title": "Salt and Iron", "cover": "Salt and Iron"}},
    "sample3": {"title": "Lantern Season", "slug": "lantern-season",
                "creator": "Nao Ito", "heading_class": "title",
                "annotation": {"title": "Lantern Season", "cover": "Lantern Season"}},
}

for name, values in SAMPLES.items():
    FIXTURES[f"learned_site/{name}"] = {
        "page.html": SAMPLE_PAGE.format(**values),
        "expected.json": values["annotation"],
    }


def main() -> int:
    for name, files in FIXTURES.items():
        directory = HERE / name
        directory.mkdir(parents=True, exist_ok=True)
        for filename, content in files.items():
            text = content if isinstance(content, str) else json.dumps(content, indent=2,
                                                                    ensure_ascii=False)
            (directory / filename).write_text(text + ("" if text.endswith("\n") else "\n"),
                                              encoding="utf-8")
        print(f"  wrote fixtures/{name}/ ({', '.join(sorted(files))})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
