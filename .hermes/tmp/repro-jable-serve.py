"""Serve the jable.tv session's annotation page the way the builder does, and fetch it.

The replay of `annotate.page` alone worked (640 KB), so the empty response must come from the
*serving* path. This starts the real session server for that session and asks it for the page and for
one of its media URLs, printing status and byte counts.
"""
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, "D:/Project/TagTraceTrove/siteprobe")

from src.builder.learn import load_session                        # noqa: E402
from src.builder.session_server import Session, start             # noqa: E402

DIRECTORY = Path("D:/Project/TagTraceTrove/apps/server/.data/siteprobe/sessions/jable.tv/"
                 "20261004-185444-work1")

sample = load_session(DIRECTORY)
session = Session(harvest=sample.harvest, directory=DIRECTORY, url=sample.capture.url)
httpd, url = start(session)
print("serving", url)
try:
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(url, timeout=20) as reply:
                body = reply.read()
                print(f"  attempt {attempt}: {reply.status} {reply.headers.get('content-type')} "
                      f"{len(body)} bytes")
        except urllib.error.HTTPError as error:
            print(f"  attempt {attempt}: HTTP {error.code} {error.read()[:120]!r}")
        except Exception as error:                                 # noqa: BLE001 - the diagnosis
            print(f"  attempt {attempt}: {type(error).__name__}: {error}")

    # One media URL the page itself uses, with the same token the page has.
    token = url.split("token=")[-1]
    import json
    payload_start = None
    with urllib.request.urlopen(url, timeout=20) as reply:
        page = reply.read().decode("utf-8")
    payload_start = page.index("const DATA = ") + len("const DATA = ")
    payload = json.loads(page[payload_start:page.index(";\nconst T", payload_start)])
    thumbs = [row.get("thumb") for row in payload["candidates"] if row.get("thumb")][:3]
    print("  media URLs in the page:", len([row for row in payload["candidates"] if row.get("thumb")]))
    for thumb in thumbs:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{url.split(':')[2].split('/')[0]}{thumb}",
                                        timeout=20) as reply:
                print(f"    {thumb[:60]}: {reply.status} {len(reply.read())} bytes")
        except Exception as error:                                 # noqa: BLE001 - the diagnosis
            print(f"    {thumb[:60]}: {type(error).__name__}: {error}")
finally:
    httpd.shutdown()
    httpd.server_close()
