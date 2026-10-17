"""Phase 4: the local server the annotation page runs on.

It exists for one reason: the annotation has to arrive without the user moving a
file. A page opened from the filesystem can only hand its result back through the
browser's download folder, which then has to be found and moved by hand — and the
plan's endpoint is a UI that drives the tool, which can simply receive it. So the
tool serves the page on the loopback interface and accepts the result itself.

Three endpoints, and no way to ask for anything else:

    GET  /                 the annotation page, with the candidates embedded
    GET  /media?c=<id>     the bytes of one candidate image, by candidate id
    POST /api/annotations  the annotation; written into the session directory

`/media` takes a candidate id rather than a URL on purpose: the server can only
serve images it harvested, so the page cannot turn it into a fetcher for arbitrary
addresses.

Bound to 127.0.0.1 on a port the operating system picks. There is no listening
socket anyone else can reach, and the token in the URL keeps another local page
from posting to it.
"""

from __future__ import annotations

import json
import secrets
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse

from . import annotate
from . import text as l10n
from .annotate import Annotation

# How often the wait says it is still waiting.
HEARTBEAT = 30
from .harvest import Harvest
from ..generic import unknown_url


@dataclass
class Session:
    """One annotation run: what was harvested, where it lives, and its decision."""

    harvest: Harvest
    directory: Path
    url: str
    mode: str = "annotate"
    # The page as it was read, when the caller has it. A field answered in 「多个」 derives its
    # rule from the values that were clicked, and the only way to know a rule really reads them
    # is to run it — with the same runtime that will later execute it.
    capture: Any = None
    # Example 2's proposals: what the tool read on this page for each field, so a
    # confirmed value keeps the rule that read it without asking for the choice again.
    applied: dict[str, Any] | None = None
    annotation: Annotation | None = None
    done: threading.Event | None = None
    # Which vocabulary the page shows and what the annotation is keyed by: a work's fields
    # (`title`, `creator`, …) or a listing card's (`source_id`, `title`, `cover_url`, …). The
    # vocabulary also picks the page's tips and its save-button wording, because a card page teaches a
    # different job.
    fields: tuple[tuple[str, str, str], ...] = annotate.FIELDS
    vocabulary: str = "work"
    # Where this page sits in the sequence of pages a builder is reading — as `(index, total)`, which
    # the page renders in its own language — and whether submitting it finishes the whole adapter: the
    # guidance the page shows instead of a console nobody watches.
    position: tuple[int, int] | None = None
    last: bool = False


def _handler_for(session: Session, token: str):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args) -> None:      # a quiet server
            return

        # -- helpers ------------------------------------------------------- #
        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")

        def _authorised(self, query: dict[str, list[str]]) -> bool:
            return secrets.compare_digest(query.get("token", [""])[0], token)

        # -- routes -------------------------------------------------------- #
        def do_GET(self) -> None:                   # noqa: N802 - stdlib naming
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            if not self._authorised(query):
                self._send_json(403, {"ok": False, "error": "bad token"})
                return
            if parsed.path == "/":
                body = annotate.page(session.harvest, url=session.url,
                                     position=session.position, last=session.last,
                                     mode=session.mode, applied=session.applied,
                                     token=token, fields=session.fields,
                                     vocabulary=session.vocabulary,
                                     lang=l10n.lang_from_env()).encode("utf-8")
                self._send(200, body, "text/html; charset=utf-8")
                return
            if parsed.path == "/media":
                self._serve_media(query)
                return
            self._send_json(404, {"ok": False, "error": "no such endpoint"})

        def _serve_media(self, query: dict[str, list[str]]) -> None:
            candidate_id = query.get("c", [""])[0]
            candidate = next((item for item in session.harvest.candidates
                              if item.candidate_id == candidate_id), None)
            if candidate is None or candidate.kind not in ("image", "images"):
                self._send_json(404, {"ok": False, "error": "not an image candidate"})
                return
            # A group of images is shown by its first picture: the row has to say *which*
            # group this is, and twenty addresses in a row do not.
            address = str(candidate.value)
            if candidate.kind == "images":
                members = candidate.context.get("members") or []
                if not members:
                    self._send_json(404, {"ok": False, "error": "the group holds nothing"})
                    return
                address = str(members[0])
            # Cached under the session, so a second look does not refetch and the
            # session stays replayable offline.
            directory = session.directory / "media"
            existing = next(iter(sorted(directory.glob(f"{candidate_id}.*"))), None)
            if existing is None:
                fetched = fetch_image(address, session.url)
                if fetched is None:
                    self._send_json(502, {"ok": False, "error": "image could not be fetched"})
                    return
                content, extension = fetched
                existing = directory / f"{candidate_id}{extension}"
                existing.parent.mkdir(parents=True, exist_ok=True)
                existing.write_bytes(content)
            self._send(200, existing.read_bytes(), _content_type(existing.suffix))

        def do_POST(self) -> None:                  # noqa: N802 - stdlib naming
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            if parsed.path != "/api/annotations" or not self._authorised(query):
                self._send_json(403, {"ok": False, "error": "bad token or endpoint"})
                return
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > 1_000_000:
                self._send_json(400, {"ok": False, "error": "bad body length"})
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                annotation = Annotation.from_json(payload)
                annotation.fields = annotate.normalise_selected_members(
                    annotation.fields, session.harvest, annotation.picks, session.fields,
                    annotation.multi)
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                self._send_json(400, {"ok": False, "error": f"bad json: {error}"})
                return

            # Written by the tool, into the session directory: nothing lands in a
            # download folder and nothing has to be moved afterwards.
            path = session.directory / "annotations.json"
            try:
                hypotheses = annotate.hypotheses(
                    annotation.fields, session.harvest,
                    picks=annotation.picks, applied=session.applied,
                    fields=session.fields, multi=annotation.multi,
                    capture=session.capture)
            except ValueError as error:
                self._send_json(400, {"ok": False, "error": str(error)})
                return
            path.write_text(json.dumps({
                **annotation.to_json(),
                "hypotheses": hypotheses,
            }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            session.annotation = annotation
            # The flag is set before the reply goes out: whoever is waiting on it must
            # not be able to observe the answer first and read the flag as unset.
            if session.done is not None:
                session.done.set()
            # What the derived rules read beyond what was picked: the page says it, because
            # "these are the authors" and "these, and the rest of the page's" are different
            # answers and the person is the one who knows which they meant.
            extra = [member for hypothesis in hypotheses.values()
                     for member in (hypothesis.get("extra") or [])]
            self._send_json(200, {"ok": True, "path": str(path),
                                  "fields": sorted(hypotheses), "extra": extra})

    return Handler


def fetch_image(url: str, referer: str) -> tuple[bytes, str] | None:
    """One candidate image, or None.

    The page address is sent as the referer because several CDNs refuse an image
    request without it, and the page we harvested is the natural one to claim.
    """
    # Rendered pages routinely keep same-site images as `/cover.jpg` or
    # `//cdn.example/cover.jpg`.  The browser resolves those against the page;
    # the loopback preview proxy has to do the same before handing the address
    # to the HTTP reader.  Iwara listing cards use the protocol-relative form.
    resolved = urljoin(referer, url.strip())
    try:
        status, body, content_type, _final = unknown_url.fetch(resolved, referer=referer)
    except Exception:  # noqa: BLE001 - reported as a failed image, not raised
        return None
    if status != 200 or not body:
        return None
    extension = unknown_url.extension_for(content_type, body)
    if not extension:
        return None
    return body, extension


def _content_type(suffix: str) -> str:
    return {".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}.get(
        suffix.lower(), "image/jpeg")


def start(session: Session, *, port: int = 0) -> tuple[ThreadingHTTPServer, str]:
    """Bind the loopback port and serve in a background thread; returns (server, url).

    Separate from `serve` so the round trip can be exercised without a browser: the
    point of the server is that the annotation arrives without being moved by hand,
    and that is a property worth a test.
    """
    token = secrets.token_urlsafe(16)
    session.done = session.done or threading.Event()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), _handler_for(session, token))
    url = f"http://127.0.0.1:{httpd.server_address[1]}/?token={token}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, url


def serve(session: Session, *, port: int = 0, open_browser: bool = True) -> str:
    """Serve the annotation page until it is submitted. Returns the URL it used."""
    httpd, url = start(session, port=port)
    try:
        # Printed before the wait, and the wait says how long it has been: a server
        # waiting for a submit used to look exactly like a hang, which is what a
        # several-minute run without a word looked like.
        print(f"    annotation page: {url}")
        print("    waiting for the annotation to be submitted (Ctrl-C to stop)")
        if open_browser:
            import webbrowser

            webbrowser.open(url)
        waited = 0
        while not session.done.wait(timeout=HEARTBEAT):
            waited += HEARTBEAT
            print(f"    still waiting ... {waited}s  (nothing is stuck: the page has "
                  f"not been submitted yet)")
    finally:
        httpd.shutdown()
        httpd.server_close()
    return url


# --- choosing which card represents the listing ----------------------------- #
#
# The plan's §8 picker, in the half that needs a page. "The first card of the set" is the right
# default and not always the right answer: measured on a real search page, the first album link
# on the page belonged to a recommendation block above the results, and on a real artist page
# the tool once marked a card from the middle. A person can already name a card (`--card-of=N`);
# this is the same choice made by looking, which is how a person actually decides.
#
# Same bargain as the annotation page: served on the loopback interface, chosen by clicking,
# posted straight back to the tool, and nothing lands in a download folder.

# Raw: like the annotation page, its script has a regex (`/\{(\w+)\}/`).
CHOOSER_TEMPLATE = r"""<!doctype html>
<html lang="__LANG__"><head><meta charset="utf-8"><title>__TITLE__</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:13px/1.5 system-ui,sans-serif; background:#14161a; color:#e6e6e6; }
  header { padding:10px 14px; border-bottom:1px solid #2a2e35; position:sticky; top:0;
           background:#14161a; }
  header .url { color:#8aa0b8; word-break:break-all; }
  main { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:12px;
         padding:14px; }
  .card { border:1px solid #2a2e35; border-radius:6px; padding:8px; }
  .card.picked { border-color:#4a9e5c; }
  .card img { max-width:100%; max-height:190px; border-radius:4px; background:#000;
              display:block; margin:0 auto 6px; }
  .card .t { font-weight:600; word-break:break-all; }
  .card code { display:block; background:#101317; padding:2px 4px; border-radius:3px;
               color:#8aa0b8; word-break:break-all; margin:4px 0; user-select:text; }
  button { background:#26456b; color:#e6e6e6; border:1px solid #4a9eff; border-radius:6px;
           padding:4px 8px; cursor:pointer; }
  .hint { color:#6b7480; font-size:12px; }
  /* The wait, in the middle of the screen — the same thing the annotation page does after it is
     submitted. Picking a card is followed by the tool harvesting it and opening its annotation page;
     a line in the header is where nobody looks. It swallows clicks: this page is done. */
  .veil { position:fixed; inset:0; z-index:9; display:none; align-items:center; justify-content:center;
          padding:24px; background:rgba(20,22,26,.94); }
  .veil.show { display:flex; }
  .veil .panel { max-width:660px; text-align:center; }
  .veil .pulse { width:72px; height:4px; margin:0 auto 20px; border-radius:2px;
                 background:#2a2e35; overflow:hidden; }
  .veil .pulse i { display:block; width:40%; height:100%; background:#4a9eff;
                   animation:slide 1.2s ease-in-out infinite; }
  @keyframes slide { from { transform:translateX(-100%); } to { transform:translateX(250%); } }
  .veil .headline { font-size:26px; font-weight:600; line-height:1.35; }
  .veil .detail { margin-top:12px; color:#8aa0b8; word-break:break-word; }
</style></head><body>
<header>
  <div class="url" id="url"></div>
  <div class="hint" id="intro"></div>
  <div class="hint" id="status"></div>
</header>
<main id="grid"></main>
<div class="veil" id="veil" role="status" aria-live="polite">
  <div class="panel">
    <div class="pulse"><i></i></div>
    <div class="headline" id="veilHead"></div>
    <div class="detail" id="veilDetail"></div>
  </div>
</div>
<script>
const DATA = __PAYLOAD__;
const T = DATA.text;
const fill = (template, values) => template.replace(/\{(\w+)\}/g,
  (whole, name) => (name in values ? String(values[name]) : whole));
// The middle-of-the-screen wait, and the way back down from it: `null` takes it away, which is the
// failure path — a choice that could not be recorded says so in the header, where it always did.
const veil = (headline, detail) => {
  const box = document.getElementById('veil');
  if (headline === null) { box.className = 'veil'; document.body.style.overflow = ''; return; }
  document.getElementById('veilHead').textContent = headline;
  document.getElementById('veilDetail').textContent = detail || '';
  box.className = 'veil show';
  document.body.style.overflow = 'hidden';
};
const grid = document.getElementById('grid');
document.getElementById('url').textContent = DATA.url;
document.getElementById('intro').textContent = fill(T.count, { count: DATA.cards.length });
for (const card of DATA.cards) {
  const box = document.createElement('div'); box.className = 'card';
  if (card.thumb) {
    const img = document.createElement('img');
    img.loading = 'lazy'; img.src = card.thumb;
    img.onerror = () => {
      const note = document.createElement('div');
      note.className = 'hint'; note.textContent = T.pictureFailed;
      img.replaceWith(note);
    };
    box.appendChild(img);
  }
  const title = document.createElement('div'); title.className = 't';
  title.textContent = '[' + card.index + '] ' + card.title;
  box.appendChild(title);
  const link = document.createElement('code'); link.textContent = card.link;
  box.appendChild(link);
  const button = document.createElement('button');
  button.textContent = T.use;
  button.onclick = async () => {
    const status = document.getElementById('status');
    status.textContent = '';
    // The wait starts on the click: the choice is made, and what happens next is not on this page.
    veil(T.submitting, '');
    try {
      const reply = await fetch(DATA.save_url, {method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({index: card.index})});
      const result = await reply.json();
      if (!result.ok) {
        veil(null, '');
        status.textContent = fill(T.saveFailed, { error: result.error || '' });
        return;
      }
      box.className = 'card picked';
      veil(T.waitHeadline, fill(T.chosen, { index: card.index }));
    } catch (error) {
      veil(null, '');
      status.textContent = fill(T.saveFailed, { error: String(error) });
    }
  };
  box.appendChild(button);
  grid.appendChild(box);
}
</script>
</body></html>
"""


def choose_card(url: str, cards: list[dict[str, Any]], *, port: int = 0,
                opened: list[str] | None = None) -> int:
    """Serve the cards on the loopback interface and wait for the one that is chosen.

    Returns the chosen index, or 0 when the page was closed without choosing — the same
    default the command line uses, so someone who wants the first card can ignore the page.
    """
    # The language T³ is in, so this page reads like the rest of what the person is looking at.
    lang = l10n.lang_from_env()
    import json as _json
    import secrets
    import threading
    import webbrowser
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs, quote, urlparse

    token = secrets.token_urlsafe(16)
    chosen: list[int] = []
    done = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args) -> None:              # a quiet server
            return

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, payload: dict[str, Any]) -> None:
            self._send(status, _json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")

        def _authorised(self, query: dict[str, list[str]]) -> bool:
            return query.get("token", [""])[0] == token

        def do_GET(self) -> None:                           # noqa: N802 - http.server
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            if not self._authorised(query):
                self._json(403, {"ok": False, "error": "bad token"})
                return
            if parsed.path == "/":
                words = l10n.chooser(lang)
                payload = _json.dumps({
                    "url": url,
                    "text": words,
                    "save_url": f"/api/choose?token={quote(token, safe='')}",
                    "cards": [dict(card, thumb=(f"/cover?i={card['index']}&token="
                                                f"{quote(token, safe='')}")
                                  if card.get("cover_url") else None)
                              for card in cards],
                }, ensure_ascii=False).replace("<", "\\u003c")
                body = (CHOOSER_TEMPLATE.replace("__PAYLOAD__", payload)
                        .replace("__LANG__", lang)
                        .replace("__TITLE__", words["docTitle"])).encode("utf-8")
                self._send(200, body, "text/html; charset=utf-8")
                return
            if parsed.path == "/cover":
                index = int(query.get("i", ["0"])[0])
                if not 0 <= index < len(cards) or not cards[index].get("cover_url"):
                    self._send(404, b"", "text/plain; charset=utf-8")
                    return
                data, extension = fetch_image(cards[index]["cover_url"], url)
                if not data:
                    self._send(404, b"", "text/plain; charset=utf-8")
                    return
                self._send(200, data, f"image/{extension.lstrip('.') or 'jpeg'}")
                return
            self._send(404, b"", "text/plain; charset=utf-8")

        def do_POST(self) -> None:                          # noqa: N802 - http.server
            parsed = urlparse(self.path)
            if not self._authorised(parse_qs(parsed.query)):
                self._json(403, {"ok": False, "error": "bad token"})
                return
            length = int(self.headers.get("content-length") or 0)
            try:
                payload = _json.loads(self.rfile.read(length) or b"{}")
            except (_json.JSONDecodeError, UnicodeDecodeError) as error:
                self._json(400, {"ok": False, "error": f"bad json: {error}"})
                return
            index = int(payload.get("index", 0))
            chosen.append(index)
            # Set before the reply goes out: whoever is waiting must not be left waiting.
            done.set()
            self._json(200, {"ok": True, "index": index})

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    address = f"http://127.0.0.1:{httpd.server_address[1]}/?token={quote(token, safe='')}"
    if opened is not None:
        # The address is printed for a person to click; this is the same string handed back to
        # whoever started the server, which is how a test finds it without reading stdout.
        opened.append(address)
    print(f"    which card? {address}")
    try:
        webbrowser.open(address)
    except Exception:  # noqa: BLE001 - a browser that cannot open is not a failure
        pass
    while not done.wait(timeout=HEARTBEAT):
        print(f"    still waiting ... {HEARTBEAT}s  (nothing is stuck: the page has not been "
              "answered yet)", flush=True)
    httpd.shutdown()
    httpd.server_close()
    return chosen[0] if chosen else 0
