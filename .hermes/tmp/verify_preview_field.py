"""Verify the preview field against real recorded pages, offline and read-only.

Reads three real buondua sessions, marks the image group each page offers the way the
annotation page posts it, learns, drafts, and compares the draft against the record the
runtime writes. Writes only into a scratch directory it is given.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(r"D:/Project/TagTraceTrove/siteprobe")
sys.path.insert(0, str(ROOT))

from src.builder.harvest import harvest  # noqa: E402
from src.builder.annotate import FIELD_LIMITS  # noqa: E402
from src.builder.learn import draft_site_json, learn, load_session  # noqa: E402
from src.builder.roundtrip import compare  # noqa: E402

SESSIONS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    r"D:/Project/TagTraceTrove/apps/server/.data/siteprobe/sessions/18comic.vip")
NAMES = sys.argv[2:] or ["20260919-234346-work1", "20260919-234603-work2",
                         "20260919-234656-work3"]
SCRATCH = Path(r"D:/Project/TagTraceTrove/.hermes/tmp/preview-check")

shutil.rmtree(SCRATCH, ignore_errors=True)
SCRATCH.mkdir(parents=True, exist_ok=True)


def work_id(url: str) -> str:
    """The work's own id, read out of the page address the samples share."""
    match = re.search(r"/(?:album|photos|work|detail)/(\d+)", url)
    if match:
        return match.group(1)
    # Sites that end the address with the id (`…-55596`).
    return re.search(r"-(\d+)/?$", url).group(1) if re.search(r"-(\d+)/?$", url) else ""

samples = []
for name in NAMES:
    directory = SESSIONS / name
    sample = load_session(directory)
    groups = sample.harvest.by_kind("images")
    print(f"== {name} {sample.url}")
    print(f"   image candidates: {len(sample.harvest.by_kind('image'))}"
          f" · preview groups offered: {len(groups)}")
    for group in groups:
        print(f"   - {group.context['selector']!r} → {group.context['count']} 张"
              f" · first: {group.context['members'][0][:70]}")
    if not groups:
        print("   !! no group on this page")
        continue
    # Standing in for the person who looks at the thumbnails: the work's own pictures are
    # the group whose members all carry this page's work id in their address. The tool
    # itself does not do this — the annotation page shows each group's first picture and
    # its count, and the person clicks the right one.
    ident = work_id(sample.url)
    own = [group for group in groups
           if ident and all(ident in member for member in group.context["members"])]
    chosen = max(own, key=lambda candidate: candidate.context["count"]) if own else None
    if chosen is None:
        print(f"   !! no group belongs to work {ident}")
        continue
    # What the capped field records: the first three pictures of the group, which is what
    # the annotation page posts for a field with a declared limit.
    kept = list(chosen.context["members"])[:FIELD_LIMITS["preview"]]
    print(f"   picked: {chosen.context['selector']!r} ({chosen.context['count']} 张 → 记 {len(kept)})")
    sample.annotated["preview"] = kept
    sample.annotated.setdefault("title", "placeholder")
    samples.append(sample)

if len(samples) < 2:
    print("not enough samples with a group; stopping")
    raise SystemExit(1)

learning = learn(samples)
print("\n== learning")
report = next((item for item in learning.fields if item.field == "preview"), None)
if report is None:
    print("no preview field learned; notes:", learning.notes)
    raise SystemExit(1)
for hypothesis in report.hypotheses:
    print(f"   rule {json.dumps(hypothesis.rule, ensure_ascii=False)}")
    print(f"      verdict={hypothesis.verdict} · {hypothesis.reason()}")
chosen = learning.chosen_rules().get("preview")
print(f"   chosen: {json.dumps(chosen, ensure_ascii=False)}")

draft = draft_site_json(samples, learning)
print("\n== draft")
print(f"   work.fields keys: {sorted(draft['work']['fields'])}")
print(f"   preview_urls: {json.dumps(draft['work']['fields'].get('preview_urls'), ensure_ascii=False)}")

result = compare(samples[0], draft, SCRATCH)
print("\n== round trip (sample 1, through the runtime's own reader)")
for comparison in result.comparisons:
    read = comparison.runtime
    if isinstance(read, list):
        read = f"{len(read)} values: {str(read[:1])[:80]}"
    print(f"   {comparison.field}: verdict={comparison.verdict}"
          f" in_record={comparison.in_record} runtime={read}")
    if comparison.field == "preview_urls":
        print(f"      detail: {comparison.detail}")
        record_previews = (comparison.in_record, len(comparison.runtime or []))
        print(f"      pictures carried into the record: {record_previews[1]}"
              f" · carried={record_previews[0]}")
print(f"\nscratch: {SCRATCH}")
