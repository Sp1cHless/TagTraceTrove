"""Rebuild bilinovel's work half from the sessions it was learned in, and install it.

Why: the listing run of 2026-10-04 wrote `site.json` wholesale, which deleted the work adapter the
day before. The sessions are the record the original install was made from, so the half is rebuilt
through the same code path (`load_session` → `learn` → `draft_site_json` → `compare` → `install`),
verified against the same recorded pages, and merged with whatever half is on disk now.
"""
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path("D:/Project/TagTraceTrove/siteprobe")
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder import paths                                            # noqa: E402
from src.builder.learn import draft_site_json, learn, load_session        # noqa: E402
from src.builder.roundtrip import compare, install                       # noqa: E402

HOME = paths.home()
HOST = "www.bilinovel.com"
SESSIONS = HOME / "sessions" / HOST

directories = [
    SESSIONS / "20261003-221623-work1",
    SESSIONS / "20261003-221815-work2",
    SESSIONS / "20261003-221943-work3",
]
for directory in directories:
    print("sample:", directory.name, "|", json.loads((directory / "annotations.json")
          .read_text(encoding="utf-8"))["url"])

samples = [load_session(directory) for directory in directories]
learning = learn(samples)
draft = draft_site_json(samples, learning)

print()
print("fields learned:", json.dumps(draft["work"]["fields"], ensure_ascii=False))
print("passthrough   :", draft["work"]["passthrough"])
print("target pattern:", draft["targets"]["work"]["url_pattern"])

result = compare(samples[0], draft, directories[0])
print()
print(f"round trip: {'PASS' if result.ok else 'FAIL'} — "
      f"{len(result.agreeing())}/{len(result.comparisons)} field(s) agree")
for item in result.disagreeing():
    print("   disagree:", item.field, item.detail)

if not result.ok:
    print("nothing installed: the rebuilt half does not read what the recorded pages say")
    raise SystemExit(1)

target = install(draft, HOME / "local", source=str(directories[0]))
written = json.loads((target / "site.json").read_text(encoding="utf-8"))
print()
print("installed:", target)
print("halves now in site.json:", sorted(k for k in written if k in ("work", "listings")),
      "| targets:", sorted(written.get("targets", {})),
      "| documents:", sorted(written.get("documents", {})))
print("capabilities:", json.loads((target / "adapter.json").read_text(encoding="utf-8"))["capabilities"])
