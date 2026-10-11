"""Why did the annotation page for jable.tv answer with nothing?

The page is served by a handler that builds the whole document in one call, so an exception there
closes the socket without a single byte — which is exactly what the browser showed
(`ERR_EMPTY_RESPONSE`). This replays the page from the session the run left behind, so the failure
can be read instead of guessed.
"""
import sys
import traceback
from pathlib import Path

sys.path.insert(0, "D:/Project/TagTraceTrove/siteprobe")

from src.builder import annotate, text as l10n                    # noqa: E402
from src.builder.learn import load_session                        # noqa: E402

DIRECTORY = Path("D:/Project/TagTraceTrove/apps/server/.data/siteprobe/sessions/jable.tv/"
                 "20261004-185444-work1")

sample = load_session(DIRECTORY)
print("url        :", sample.capture.url)
print("candidates :", len(sample.harvest.candidates))
kinds: dict[str, int] = {}
for candidate in sample.harvest.candidates:
    kinds[candidate.kind] = kinds.get(candidate.kind, 0) + 1
print("by kind    :", kinds)
print("annotated  :", sample.annotated)
print("notes      :", sample.harvest.notes[:2])

try:
    html = annotate.page(sample.harvest, url=sample.capture.url, token="probe")
    print("page bytes :", len(html))
except Exception:                                                  # noqa: BLE001 - the diagnosis
    print("\n--- the page could not be built ---")
    traceback.print_exc()
    raise SystemExit(1)
