"""A generic review page: pick works before anything is downloaded.

hitomi's review page is its own (cluster pools, same-title evidence, content-hash
coverage) and stays untouched. This is the layer underneath it, for any site whose
listing is a plain search result: the cards the listing already carries are enough
to decide with, so the page is built from them and **no work's detail page is
fetched** until the user has picked. That is what makes a few hundred results
usable instead of a few hundred downloads.

What the page offers, all from the listing's own fields:

* works grouped by a normalised title — one work with several language releases
  arrives as several entries with different names, and reading them one by one is
  the problem being solved;
* filtering by text (title / author / tag / id) and by language;
* per-group selection, "select shown", and live selected / shown counters.

Language comes from the card's tags, since a site tags a work with its language.
A site that has no such convention declares no table and simply loses the filter.

The exported selection uses the keys hitomi's page emits, so the same
`下载selection.bat` consumes either one, plus `target_kind` / `target_ref`, which is
what lets the generic consumer re-list the works without any stored state.
"""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any

from . import export_layout

REVIEW_FILENAME = "review.html"
CARDS_FILENAME = "cards.json"

PAGE = r"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review · __SITE__ · __REF__</title>
<style>
:root { color-scheme: dark; --line:#2a2f38; --mut:#8b94a3; --blue:#2f6feb; }
body { margin:0; font:14px/1.5 system-ui,"Segoe UI",sans-serif; background:#14161a; color:#e6e8eb; }
header { position:sticky; top:0; z-index:3; background:#1b1e24; border-bottom:1px solid var(--line); }
.bar { display:flex; gap:10px; align-items:center; padding:10px 14px; flex-wrap:wrap; }
h1 { font-size:15px; margin:0; font-weight:600; }
.count { color:var(--mut); }
.count b { color:#e6e8eb; }
small { color:var(--mut); }
button { font:inherit; padding:5px 11px; border-radius:6px; border:1px solid #39404d;
         background:#232833; color:#e6e8eb; cursor:pointer; }
button.primary { background:var(--blue); border-color:var(--blue); }
button.toggle.on { background:var(--blue); border-color:var(--blue); }
input[type=search] { font:inherit; padding:5px 10px; border-radius:6px; border:1px solid #39404d;
                     background:#191c22; color:#e6e8eb; min-width:190px; }
select { font:inherit; padding:5px 8px; border-radius:6px; border:1px solid #39404d;
         background:#191c22; color:#e6e8eb; }
main { padding:14px; }
.group { border:1px solid var(--line); border-radius:10px; margin-bottom:12px; background:#17191f; }
.ghead { display:flex; gap:10px; align-items:center; padding:8px 12px; }
.ghead.multi { cursor:pointer; border-bottom:1px solid var(--line); }
.gname { font-weight:600; font-size:13px; flex:1; }
.gsub { color:var(--mut); font-size:12px; white-space:nowrap; }
.gbody { display:grid; gap:10px; padding:12px; border-top:1px solid var(--line);
         grid-template-columns:repeat(auto-fill,minmax(168px,1fr)); }
.gbody.hidden { display:none; }
.card { display:flex; flex-direction:column; gap:6px; cursor:pointer; border:1px solid var(--line);
        border-radius:9px; padding:7px; background:#191c22; position:relative; }
.card:has(input:checked) { border-color:var(--blue); box-shadow:0 0 0 1px var(--blue) inset; }
.card input { position:absolute; top:11px; left:11px; transform:scale(1.25); z-index:1; }
.thumb { overflow:hidden; border-radius:6px; background:#0f1115; }
/* Only a card with no known shape gets a standing box, so a grid without covers
   still lines up; a real cover sets its own ratio from the file it came from. */
.thumb.unknown { aspect-ratio:3/4; }
.thumb img { width:100%; height:auto; display:block; }
.meta { display:flex; flex-direction:column; gap:2px; }
.title { font-size:12.5px; line-height:1.35; display:-webkit-box; -webkit-line-clamp:2;
         -webkit-box-orient:vertical; overflow:hidden; }
.sub { color:var(--mut); font-size:11px; }
.tags { color:#6f7887; font-size:10.5px; line-height:1.45; word-break:break-word; }
.lang { position:absolute; top:10px; right:10px; background:#000b; border-radius:4px;
        padding:1px 6px; font-size:11px; z-index:1; }
.title a, .open { color:inherit; text-decoration:none; }
.title a:hover { text-decoration:underline; }
.open { position:absolute; bottom:7px; right:9px; font-size:11px; color:var(--mut); }
.open:hover { color:#e6e8eb; }
.hidden { display:none !important; }
</style>
</head>
<body>
<header>
  <div class="bar">
    <h1>Review · __SITE__ · __REF__</h1>
    <span class="count"><b id="nsel">0</b> selected · <b id="nshow">0</b> shown of __TOTAL__</span>
    <input type="search" id="q" placeholder="filter title / author / tag / id">
    <select id="lang"><option value="">all languages</option></select>
    <button id="all">Select shown</button>
    <button id="none">Clear</button>
    <button id="only" class="toggle">Show selected only</button>
    <button id="expand" class="toggle">Expand groups</button>
    <button id="export" class="primary">Export selection</button>
  </div>
  <div class="bar" id="where">Export saves into this folder — keep it there so the download tool finds it.</div>
</header>
<main id="groups"></main>
<script>
const META = __META__;
const CARDS = META.cards || [];
const LANGUAGES = META.language_tags || {};
const lookup = Object.entries(LANGUAGES).map(([marker, name]) => [marker.toLowerCase(), name]);

// Language is read from the card's own tags and title: a site tags a work with its
// language, and the same work in another language is titled differently, so both
// are checked. No table declared means no filter, not a wrong answer.
function languageOf(card) {
  // A site that states a language on the card is taken at its word; only then is
  // one inferred from tags, which is what a site without the field needs.
  if (card.language) return String(card.language);
  const hay = [card.title || '', ...(card.tags || [])].join(' ').toLowerCase();
  for (const [marker, name] of lookup) if (hay.includes(marker)) return name;
  return '';
}

// Bracketed prefixes and language-edition tails are noise for grouping: the same
// work arrives as "[组] Title [中国翻訳]" and "[组] Title [DL版]".
const NOISE = /[\[\(（【][^\]\)）】]*[\]\)）】]/g;
const EDITIONS = /\b(dl版|中国翻訳|中文|漢化|汉化|無修正|无修正|decensored|uncensored|full ?color|全彩|英訳|한국어)\b/g;
function groupKey(card) {
  const s = (card.title || '')
    .toLowerCase()
    .replace(NOISE, ' ')
    .replace(EDITIONS, ' ')
    .replace(/[\s\-_.,:;!?'"~～·、。]+/g, ' ')
    .trim();
  return s || String(card.title || card.source_id || '');
}

const cards = CARDS.map((card, index) => ({
  ...card, index, lang: languageOf(card), key: groupKey(card),
}));
const groups = new Map();
for (const card of cards) {
  if (!groups.has(card.key)) groups.set(card.key, []);
  groups.get(card.key).push(card);
}
const ordered = [...groups.entries()]
  .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

const root = document.getElementById('groups');
const groupSelectors = [];
for (const [key, members] of ordered) {
  const multi = members.length > 1;
  const box = document.createElement('section');
  box.className = 'group';

  const head = document.createElement('div');
  head.className = 'ghead' + (multi ? ' multi' : '');
  const langs = [...new Set(members.map(m => m.lang).filter(Boolean))];
  const name = document.createElement('span');
  name.className = 'gname';
  name.textContent = members[0].title || key;
  const sub = document.createElement('span');
  sub.className = 'gsub';
  sub.textContent = members.length + (multi ? ' entries' : ' entry')
    + (langs.length > 1 ? ' · ' + langs.join(' / ') : '');
  head.append(name, sub);
  let selector = null;
  if (multi) {
    selector = document.createElement('input');
    selector.type = 'checkbox';
    head.prepend(selector);
  }

  const body = document.createElement('div');
  body.className = 'gbody' + (multi ? ' hidden' : '');
  if (multi) head.addEventListener('click', (event) => {
    if (event.target !== selector) body.classList.toggle('hidden');
  });

  for (const card of members) {
    const label = document.createElement('label');
    label.className = 'card';
    label.dataset.lang = card.lang || '';
    label.dataset.hay = [card.title, card.author, card.source_id, ...(card.tags || [])]
      .filter(Boolean).join(' ').toLowerCase();

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(card.source_id);
    input.addEventListener('change', () => {
      // With the filter on, unticking a card means it no longer belongs in view.
      if (onlySelected) recompute();
      refresh();
    });
    label.appendChild(input);

    if (card.lang) {
      const badge = document.createElement('span');
      badge.className = 'lang';
      badge.textContent = card.lang;
      label.appendChild(badge);
    }
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const cover = String(card.cover_url || '');
    if (card.cover_width && card.cover_height) {
      thumb.style.aspectRatio = card.cover_width + ' / ' + card.cover_height;
    } else {
      thumb.classList.add('unknown');
    }
    // A localized cover is a path relative to this page, so the test is "is there
    // anything to show", not "is it an absolute URL" — gating on http silently
    // skipped every cover the scan had just downloaded.
    if (cover) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = cover;
      img.alt = '';
      img.onerror = () => { img.remove(); };
      thumb.appendChild(img);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    // The original page is one click away: deciding whether to keep a work often
    // means going and looking at it, and the card alone cannot answer that.
    const url = String(card.detail_url || card.url || '');
    const title = document.createElement(url.startsWith('http') ? 'a' : 'span');
    title.className = 'title';
    title.textContent = card.title || ('work ' + card.source_id);
    if (url.startsWith('http')) {
      title.href = url;
      title.target = '_blank';
      title.rel = 'noreferrer noopener';
      // The card is a label for its checkbox, so a click on the link must not also
      // toggle the selection.
      title.addEventListener('click', event => event.stopPropagation());
    }
    const line = document.createElement('span');
    line.className = 'sub';
    // Page count is shown whenever the listing carries it. A search result page
    // usually does not — 18comic's has no page count at all — and fetching every
    // work just to fill this in is exactly the cost a review exists to avoid.
    const pages = card.page_count ? card.page_count + ' pages' : '';
    line.textContent = [card.author, card.source_id, card.category, pages]
      .filter(Boolean).join(' · ');
    const tagLine = document.createElement('div');
    tagLine.className = 'tags';
    tagLine.textContent = (card.tags || []).join(' ');
    meta.append(title, line, tagLine);
    label.append(thumb, meta);
    if (url.startsWith('http')) {
      const open = document.createElement('a');
      open.className = 'open';
      open.href = url;
      open.target = '_blank';
      open.rel = 'noreferrer noopener';
      open.textContent = 'open ↗';
      open.title = url;
      open.addEventListener('click', event => event.stopPropagation());
      label.appendChild(open);
    }
    body.appendChild(label);
  }
  if (selector) {
    const group = {selector, labels: [...body.children]};
    selector.addEventListener('change', () => {
      group.labels.forEach(label => {
        if (!label.classList.contains('hidden')) label.querySelector('input').checked = selector.checked;
      });
      refresh();
    });
    groupSelectors.push(group);
  }
  box.append(head, body);
  root.appendChild(box);
}

let onlySelected = false;

const languages = [...new Set(cards.map(c => c.lang).filter(Boolean))].sort();
const langSelect = document.getElementById('lang');
if (languages.length > 1) {
  for (const name of languages) langSelect.appendChild(new Option(name, name));
} else {
  langSelect.classList.add('hidden');
}

const allCards = () => [...document.querySelectorAll('.card')];
const shownCards = () => allCards().filter(el => !el.classList.contains('hidden'));
const isChecked = (label) => label.querySelector('input').checked;

// Counters only read the page, so they can run on every tick without moving
// anything under the pointer.
function refresh() {
  document.getElementById('nsel').textContent = allCards().filter(isChecked).length;
  document.getElementById('nshow').textContent = shownCards().length;
}

// Visibility. Kept apart from the counters because ticking a card can change what
// should be visible, and re-filtering must not re-enter through the counters.
function recompute() {
  const needle = document.getElementById('q').value.trim().toLowerCase();
  const lang = langSelect.value;
  for (const label of allCards()) {
    const okText = needle === '' || label.dataset.hay.includes(needle);
    const okLang = lang === '' || label.dataset.lang === lang;
    const okSel = !onlySelected || isChecked(label);
    label.classList.toggle('hidden', !(okText && okLang && okSel));
  }
  for (const box of document.querySelectorAll('.group')) {
    const any = [...box.querySelectorAll('.card')].some(el => !el.classList.contains('hidden'));
    box.classList.toggle('hidden', !any);
    // While filtering, groups open themselves: a match hidden inside a collapsed
    // group is indistinguishable from no match at all.
    if ((needle !== '' || lang !== '' || onlySelected) && any) {
      box.querySelector('.gbody').classList.remove('hidden');
    }
  }
  const group = document.getElementById('expand');
  const collapsed = [...document.querySelectorAll('.gbody')].some(b => b.classList.contains('hidden'));
  group.textContent = collapsed ? 'Expand groups' : 'Collapse groups';
}
function apply() {
  recompute();
  refresh();
}
const onlyButton = document.getElementById('only');
// One control for both directions, so there is always a way back and no second
// mode to look for.
function setOnlySelected(next) {
  onlySelected = next;
  onlyButton.classList.toggle('on', onlySelected);
  onlyButton.textContent = onlySelected ? 'Show all' : 'Show selected only';
  apply();
}
onlyButton.onclick = () => setOnlySelected(!onlySelected);
document.getElementById('q').addEventListener('input', apply);
langSelect.addEventListener('change', apply);
document.getElementById('all').onclick = () => {
  shownCards().forEach(el => { el.querySelector('input').checked = true; });
  refresh();
};
document.getElementById('none').onclick = () => {
  allCards().forEach(el => { el.querySelector('input').checked = false; });
  refresh();
};
document.getElementById('expand').onclick = () => {
  const bodies = [...document.querySelectorAll('.gbody')];
  const collapsed = bodies.some(b => b.classList.contains('hidden'));
  bodies.forEach(b => b.classList.toggle('hidden', !collapsed));
  apply();
};
// The page is opened from the folder it belongs to, so it can name that folder
// exactly and ask the save dialog to start there.
const HERE = (() => {
  try {
    const path = decodeURIComponent(location.pathname).replace(/\\/g, '/');
    return path.replace(/\/[^/]*$/, '');
  } catch (error) { return ''; }
})();
document.getElementById('where').textContent = HERE
  ? 'Export saves into ' + HERE + ' — pick that folder in the dialog so the download tool finds it.'
  : 'Export the selection, then drag the JSON onto 下载selection.bat.';

function download(payload, name) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), {href: url, download: name});
  document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}

document.getElementById('export').onclick = async () => {
  const chosen = allCards().filter(el => el.querySelector('input').checked)
    .map(el => el.querySelector('input').value);
  if (chosen.length === 0) { alert('Nothing selected.'); return; }
  const picked = new Set(chosen);
  const payload = Object.assign({}, META, {
    item_count: CARDS.length,
    selected_source_ids: chosen,
    whitelisted_source_ids: [],
    excluded_source_ids: [],
    selected_items: CARDS.filter(c => picked.has(String(c.source_id))),
  });
  delete payload.cards;
  const name = 'selection_' + (META.target_ref || 'review') + '.json';

  // When T³ opened this page for a live review run, return the choice to that exact run over the
  // same-origin API. A malformed or hand-opened file:// page retains the save/download workflow.
  const selectionRunId = new URLSearchParams(location.search).get('selectionRunId');
  if (selectionRunId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selectionRunId)) {
    try {
      const response = await fetch(`/api/siteprobe/runs/${encodeURIComponent(selectionRunId)}/selection`, {
        method: 'POST',
        mode: 'same-origin',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name, content: JSON.stringify(payload, null, 2)}),
      });
      if (!response.ok) throw new Error('T³ refused the selection (' + response.status + ').');
      document.getElementById('where').textContent =
        'Selection sent to T³. Return to the import window; it will continue automatically.';
      return;
    } catch (error) {
      document.getElementById('where').textContent =
        'Could not return the selection to T³. You can still save or download the JSON manually.';
    }
  }

  // A page served from the filesystem cannot write a file by itself, so the save
  // dialog is the only way to choose the folder. Chrome treats file:// as a
  // secure context, so the picker is available; without it, fall back to a plain
  // download, which lands in the browser's download folder.
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{description: 'selection', accept: {'application/json': ['.json']}}],
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([JSON.stringify(payload, null, 2)],
                                    {type: 'application/json'}));
      await writable.close();
      document.getElementById('where').textContent =
        'Saved: ' + handle.name + (HERE ? ' (check that it is in ' + HERE + ')' : '');
      return;
    } catch (error) {
      if (error && error.name === 'AbortError') return;
    }
  }
  download(payload, name);
};
apply();
</script>
</body>
</html>
"""


def selection_payload(cards: list[dict[str, Any]], meta: dict[str, Any],
                      chosen: list[str]) -> dict[str, Any]:
    """The selection file, shaped like the original page's output."""
    picked = set(chosen)
    return {
        "source_site": meta.get("source_site"),
        "target_kind": meta.get("target_kind"),
        "target_ref": meta.get("target_ref"),
        "target_ref_fields": meta.get("target_ref_fields"),
        "listing": meta.get("listing"),
        "artist": meta.get("target_ref"),
        "source_url": meta.get("source_url"),
        "item_count": len(cards),
        "selected_source_ids": chosen,
        "whitelisted_source_ids": [],
        "excluded_source_ids": [],
        "selected_items": [c for c in cards if str(c.get("source_id")) in picked],
    }


def review_page(cards: list[dict[str, Any]], meta: dict[str, Any]) -> str:
    """The page, with the cards and their metadata embedded."""
    page_meta = {**meta, "cards": cards}
    return (
        PAGE.replace("__SITE__", html.escape(str(meta.get("source_site") or "")))
        .replace("__REF__", html.escape(str(meta.get("target_ref") or "")))
        .replace("__TOTAL__", str(len(cards)))
        .replace("__META__", json.dumps(page_meta, ensure_ascii=False).replace("<", "\\u003c"))
    )


def write_review(directory: Path, cards: list[dict[str, Any]],
                 meta: dict[str, Any]) -> Path:
    """Write review.html plus the cards it was built from, and return the page."""
    directory.mkdir(parents=True, exist_ok=True)
    export_layout.write_text(directory / CARDS_FILENAME,
        json.dumps(cards, ensure_ascii=False, indent=2) + "\n"
    )
    page = directory / REVIEW_FILENAME
    export_layout.write_text(page, review_page(cards, meta))
    return page
