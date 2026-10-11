"""Verification against the sites' own recorded raw documents.

This is the check that matters for the merge: the generic extractor must produce
the same data the three hand-written tools produced, from the same raw pages,
using only what `site.json` declares. This file contains no per-site *extraction*
logic — it only points at a directory of recorded documents and its golden output,
and knows which fields that golden file is able to testify about.

Recorded corpora already on disk:

    hitomi    exports/artist_<slug>/cache/galleryinfo/*.js   -> works.json   (620 works)
    hanime1   exports/playlist_<id>/items/<id>/raw.html and
              exports/playlist_<id>/raw/playlist*.html       -> items/<id>/metadata.json (65 works)
    18comic   output/v2_dry_run/items/<id>/raw.html          -> items/<id>/metadata.json (21 works)

Two known differences from the golden files are expected and are asserted as such
rather than skipped, so they cannot silently regress:

1. `date_added` is normalised to `YYYY-MM-DD`. The hitomi scan record kept the
   site's raw `2017-02-12 19:01:00-06`; the T³ importer sliced it to ten
   characters anyway, and the crawl cursor needs the date form.
2. `分类信息.分类标签` is filtered by the site's migrated dictionary (`raw` minus
   屏蔽). The hitomi golden is already filtered this way; the hanime golden kept
   every tag, and the older 18comic golden predates the taxonomy step, so those are
   compared against the field that carries the same meaning.

Run:  .venv/Scripts/python.exe verify_against_recordings.py [-v]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic import taxonomy  # noqa: E402
from src.generic.bundle import RawItem  # noqa: E402
from src.generic.extract import extract_listing_page, extract_work  # noqa: E402
from src.generic.registry import get as get_site, get_for  # noqa: E402

SITE_PROBE = Path(r"D:\Project\Dataextracted\site_probe")
CATEGORY_KEYS = ("作品", "登场人物", "分类标签", "作者", "作品类型")


class Report:
    def __init__(self) -> None:
        self.checks = 0
        self.failures: list[str] = []

    def equal(self, label: str, expected, actual) -> None:
        self.checks += 1
        if expected != actual:
            self.failures.append(
                f"{label}\n      golden {json.dumps(expected, ensure_ascii=False)}"
                f"\n      actual {json.dumps(actual, ensure_ascii=False)}"
            )

    def true(self, label: str, condition: bool, detail: str = "") -> None:
        self.checks += 1
        if not condition:
            self.failures.append(f"{label}{(' — ' + detail) if detail else ''}")

    def tag_set(self, label: str, golden: list, actual: list, rejected: set) -> None:
        """Golden tags must survive, and only 屏蔽 tags may be gone.

        A golden record is a snapshot of the dictionary at the moment it was
        written. The user has curated 屏蔽 tags since, so the current output
        legitimately carries fewer tags than its golden — but it may never carry
        a tag the golden had, and it may never drop a tag for any other reason.
        """
        self.checks += 1
        want = {_strip_gender(tag) for tag in golden if _strip_gender(tag).casefold() not in rejected}
        got = {_strip_gender(tag) for tag in actual if _strip_gender(tag).casefold() not in rejected}
        lost = sorted(want - got)
        gained = sorted(got - want)
        if lost or gained:
            self.failures.append(
                f"{label}: beyond the dictionary's 屏蔽 decisions — lost {lost[:6]}, gained {gained[:6]}"
            )


def policy_for(group: str) -> dict:
    return taxonomy.load_tag_policy(SITE_PROBE / group / "exports")


def _date_prefix(value):
    return value[:10] if isinstance(value, str) else value


def _single_spaced(value):
    return " ".join(str(value).split()) if isinstance(value, str) else value


def _strip_gender(value):
    """`… Izuru ♀ Shinkan …` and `… Izuru Shinkan …` are the same tag."""
    import re as _re
    return _re.sub(r"\s*[♀️]\s*", " ", str(value)).strip()


# --- hitomi --------------------------------------------------------------- #

def verify_hitomi(report: Report, verbose: bool) -> int:
    template = get_for("hitomi.la", "work")
    policy = policy_for("hitomi_la")
    works = 0
    for artist_dir in sorted((SITE_PROBE / "hitomi_la" / "exports").iterdir()):
        gallery_dir = artist_dir / "cache" / "galleryinfo"
        works_file = artist_dir / "works.json"
        if not gallery_dir.is_dir() or not works_file.is_file():
            continue
        document = json.loads(works_file.read_text(encoding="utf-8"))
        records = document if isinstance(document, list) else document.get("records", [])
        by_id = {str(record["source_id"]): record for record in records}

        for path in sorted(gallery_dir.glob("*.js")):
            golden = by_id.get(path.stem)
            if golden is None:
                continue
            works += 1
            item = RawItem(source_id=path.stem, target_url=golden.get("detail_url") or "")
            item.add("galleryinfo", path.read_text(encoding="utf-8"))
            # The author this artist directory was crawled from, which the real
            # fetcher also supplies, so 分类信息.作者 can be ordered the same way.
            item.card["primary_artist"] = artist_dir.name.removeprefix("artist_").replace("_", " ")
            actual = taxonomy.apply_policy_to_record(extract_work(template, item), policy)

            # Known difference 3: titles are single-spaced. The site publishes
            # `… Ii  | 我與 …` with a doubled space; collapsing it is a deliberate
            # invariant of the canonical record (it also keeps the title index
            # free of phantom spacing).
            report.equal(f"hitomi {path.stem}.title",
                         _single_spaced(golden.get("title")), actual["title"])
            report.equal(f"hitomi {path.stem}.detail_url",
                         golden.get("detail_url"), actual["detail_url"])
            # Known difference 1: the raw date spelling is normalised on purpose.
            report.equal(f"hitomi {path.stem}.date_added",
                         _date_prefix(golden.get("date_added")), actual["date_added"])
            report.equal(f"hitomi {path.stem}.page_count",
                         golden.get("page_count"), actual["page_count"])
            report.equal(f"hitomi {path.stem}.language",
                         dict(golden["language"]), actual["language"])
            for key in ("作品", "登场人物", "作者"):
                report.equal(f"hitomi {path.stem}.{key}",
                             golden.get("分类信息", {}).get(key, []),
                             actual["分类信息"][key])
            report.tag_set(f"hitomi {path.stem}.分类标签",
                           golden.get("分类信息", {}).get("分类标签", []),
                           actual["分类信息"]["分类标签"], policy["rejected"])
            # The scan record keeps `type` top-level; the export moves it into
            # 分类信息.作品类型, which is the shape produced here.
            report.equal(f"hitomi {path.stem}.作品类型",
                         [str(golden["type"]).title()] if golden.get("type") else [],
                         actual["分类信息"]["作品类型"])
            if verbose and works % 100 == 0:
                print(f"  hitomi {path.stem} {actual['title'][:44]!r}")
    return works


# --- hanime1 -------------------------------------------------------------- #

def verify_hanime(report: Report, verbose: bool) -> int:
    template = get_for("hanime1.me", "work")
    policy = policy_for("hanime1_me")
    works = 0
    for playlist_dir in sorted((SITE_PROBE / "hanime1_me" / "exports").iterdir()):
        items_dir = playlist_dir / "items"
        if not items_dir.is_dir():
            continue
        for item_dir in sorted(path for path in items_dir.iterdir() if path.is_dir()):
            golden_path, raw_path = item_dir / "metadata.json", item_dir / "raw.html"
            if not golden_path.is_file() or not raw_path.is_file():
                continue
            golden = json.loads(golden_path.read_text(encoding="utf-8"))
            works += 1

            item = RawItem(source_id=item_dir.name,
                           target_url=f"https://hanime1.me/watch?v={item_dir.name}")
            item.add("detail_html", raw_path.read_text(encoding="utf-8"), item.target_url)
            # The card values the old tool had already parsed out of the playlist
            # page. The listing reader itself is verified separately below.
            item.card = {
                "title": golden.get("title"),
                "author": golden.get("author"),
                "cover_url": (golden.get("cover") or {}).get("source_path"),
            }
            actual = taxonomy.apply_policy_to_record(extract_work(template, item), policy)

            for field in ("source_site", "source_id", "title", "detail_url", "video_url",
                          "author", "date_added", "page_count", "language"):
                report.equal(f"hanime {item_dir.name}.{field}", golden.get(field), actual.get(field))
            for key in ("作品", "登场人物", "作者"):
                report.equal(f"hanime {item_dir.name}.{key}",
                             golden["分类信息"].get(key, []), actual["分类信息"][key])
            # Known difference 2: hanime's own tool never filtered 分类标签, so the
            # golden field carrying the same meaning is `source_tags_raw`.
            report.tag_set(f"hanime {item_dir.name}.分类标签 (vs golden source_tags_raw)",
                           golden.get("source_tags_raw") or [],
                           actual["分类信息"]["分类标签"], policy["rejected"])
            report.equal(f"hanime {item_dir.name}.tags", golden.get("tags"), actual.get("tags"))
            report.equal(f"hanime {item_dir.name}.cover.source_path",
                         (golden.get("cover") or {}).get("source_path"),
                         (actual.get("cover") or {}).get("source_path"))
            if verbose and works % 20 == 0:
                print(f"  hanime {item_dir.name} {actual['title'][:44]!r}")
    return works


def verify_hanime_listing(report: Report, verbose: bool) -> int:
    """The playlist reader against the recorded playlist pages themselves."""
    template = get_for("hanime1.me", "playlist")
    pages = 0
    for playlist_dir in sorted((SITE_PROBE / "hanime1_me" / "exports").iterdir()):
        page = playlist_dir / "raw" / "playlist.html"
        if not page.is_file():
            continue
        pages += 1
        manifest_path = playlist_dir / "metadata.json"
        expected_total = None
        if manifest_path.is_file():
            expected_total = json.loads(manifest_path.read_text(encoding="utf-8")).get("item_count")
        cards, next_url = extract_listing_page(
            template, "listing_html", page.read_text(encoding="utf-8"),
            "https://hanime1.me/playlist?list=1",
        )
        # The site renders at most 100 cards per page; page 1 of a longer playlist
        # is truncated there, and reaching past 100 is the bug this reader keeps
        # fixed. A short playlist legitimately renders fewer.
        report.true(f"hanime listing {playlist_dir.name}.card_count",
                    len(cards) <= 100, f"page 1 rendered {len(cards)} cards")
        page_two = playlist_dir / "raw" / "playlist-page2.html"
        first_ids = {card["source_id"] for card in cards}
        combined = set(first_ids)
        if page_two.is_file():
            report.true(f"hanime listing {playlist_dir.name}.has_next",
                        next_url is not None, "page 2 exists but rel=next was not found")
            second, _ = extract_listing_page(template, "listing_html:2",
                                             page_two.read_text(encoding="utf-8"), next_url or "")
            second_ids = {card["source_id"] for card in second}
            report.true(f"hanime listing {playlist_dir.name}.page2_new_items",
                        len(second_ids - first_ids) > 0,
                        "page 2 contributed no items beyond page 1")
            combined |= second_ids
        elif expected_total is not None:
            # A single recorded page must account for the whole playlist, which is
            # what proves the 100-card truncation is not silently losing items.
            report.equal(f"hanime listing {playlist_dir.name}.total",
                         expected_total, len(first_ids))
        missing = [
            (card.get("source_id"), field)
            for card in cards
            for field in ("source_id", "title", "cover_url", "author")
            if not card.get(field)
        ]
        report.true(f"hanime listing {playlist_dir.name}.card_fields",
                    not missing, f"cards missing fields: {missing[:3]}")
        report.true(f"hanime listing {playlist_dir.name}.cover_host",
                    all("hembed.com" in (card.get("cover_url") or "") for card in cards),
                    "a card cover does not point at the site's image host")
        if verbose:
            print(f"  hanime listing {playlist_dir.name}: {len(cards)} cards, next={next_url}")
    return pages


# --- 18comic -------------------------------------------------------------- #

def verify_comic18(report: Report, verbose: bool) -> int:
    template = get_for("18comic.vip", "album")
    works = 0
    for item_dir in sorted((SITE_PROBE / "18comic_vip" / "output").glob("*/items/*")):
        golden_path, raw_path = item_dir / "metadata.json", item_dir / "raw.html"
        if not golden_path.is_file() or not raw_path.is_file():
            continue
        golden = json.loads(golden_path.read_text(encoding="utf-8"))
        source_id = str(golden.get("source_id") or item_dir.name)
        detail_url = golden.get("detail_url") or "https://18comic.vip/album/1/"
        works += 1

        item = RawItem(source_id=source_id, target_url=detail_url)
        item.add("detail_html", raw_path.read_text(encoding="utf-8", errors="replace"), detail_url)
        # The golden file predates the taxonomy step, so it holds pre-policy tags.
        raw = extract_work(template, item)

        for field in ("source_site", "source_id", "title", "detail_url", "keywords_raw"):
            report.equal(f"18comic {source_id}.{field}", golden.get(field), raw[field])
        for key in ("作品", "登场人物", "作者", "作品类型"):
            report.equal(f"18comic {source_id}.{key}",
                         golden.get("分类信息", {}).get(key, []), raw["分类信息"][key])
        report.tag_set(f"18comic {source_id}.分类标签",
                       golden.get("分类信息", {}).get("分类标签", []),
                       raw["分类信息"]["分类标签"], policy_for("18comic_vip")["rejected"])
        # Fields this golden file predates: asserted against the page itself.
        report.true(f"18comic {source_id}.date_added", bool(raw["date_added"]),
                    "no upload date extracted")
        report.true(f"18comic {source_id}.page_count", isinstance(raw["page_count"], int),
                    f"page_count is {raw['page_count']!r}")
        report.equal(f"18comic {source_id}.language",
                     {"code": "chinese", "name": "中文"}, raw["language"])
        report.equal(f"18comic {source_id}.preview_count",
                     len(golden.get("preview_images") or []), len(raw["preview_images"]))
        report.equal(f"18comic {source_id}.cover_url",
                     (golden.get("cover") or {}).get("url"), (raw.get("cover") or {}).get("url"))
        if verbose:
            print(f"  18comic {source_id} {raw['title'][:44]!r}")
    return works


# --- tag policy ----------------------------------------------------------- #

def verify_taxonomy(report: Report, verbose: bool) -> int:
    """Migrated dictionaries must load and filter the way they used to."""
    checks = 0
    for site_key, group in (("hitomi.la", "hitomi_la"), ("hanime1.me", "hanime1_me"),
                            ("18comic.vip", "18comic_vip")):
        root = SITE_PROBE / group / "exports"
        checks += 1
        if not (root / "taxonomy_dictionary.json").is_file():
            report.failures.append(f"{site_key}: dictionary missing at {root}")
            continue
        policy = taxonomy.load_tag_policy(root)
        report.true(f"taxonomy {site_key}.non_empty",
                    bool(policy["accepted"] or policy["rejected"]),
                    "both accepted and rejected are empty after migration")
        checks += 1
        blocked = next(iter(policy["rejected"]), "blocked-tag")
        record = {
            "source_id": "1", "title": "t",
            "source_tags_raw": [blocked, "pending-tag"],
            "分类信息": {"作品": [], "登场人物": [],
                        "分类标签": [blocked, "pending-tag"], "作者": [], "作品类型": []},
        }
        filtered = taxonomy.apply_policy_to_record(record, policy)
        checks += 1
        kept = [t for t in filtered["分类信息"]["分类标签"] if t.casefold() in policy["rejected"]]
        report.true(f"taxonomy {site_key}.no_rejected_survives", not kept, str(kept))
        report.true(f"taxonomy {site_key}.pending_kept_in_raw",
                    "pending-tag" in filtered["source_tags_raw"])
        report.true(f"taxonomy {site_key}.pending_not_accepted",
                    "pending-tag" not in filtered["tags"])
        if verbose:
            print(f"  taxonomy {site_key}: {len(policy['accepted'])} accepted, "
                  f"{len(policy['rejected'])} rejected")
    return checks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", help="verify only one site")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    report = Report()
    if args.site in (None, "hitomi.la"):
        print("\n=== hitomi.la  (recorded galleryinfo payloads -> works.json) ===")
        print(f"  {verify_hitomi(report, args.verbose)} work(s)")
    if args.site in (None, "hanime1.me"):
        print("\n=== hanime1.me  (recorded playlist + detail pages -> items/*/metadata.json) ===")
        pages = verify_hanime_listing(report, args.verbose)
        print(f"  {verify_hanime(report, args.verbose)} work(s), {pages} playlist page(s)")
    if args.site in (None, "18comic.vip"):
        print("\n=== 18comic.vip  (recorded album pages -> items/*/metadata.json) ===")
        print(f"  {verify_comic18(report, args.verbose)} work(s)")
    if args.site is None:
        print("\n=== tag policy  (migrated dictionaries) ===")
        print(f"  {verify_taxonomy(report, args.verbose)} check(s)")

    print()
    if report.failures:
        print(f"FAIL — {len(report.failures)} problem(s) out of {report.checks} comparison(s)")
        for failure in report.failures[:25]:
            print(f"  - {failure}")
        return 1
    print(f"PASS — {report.checks} comparison(s), 0 mismatches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
