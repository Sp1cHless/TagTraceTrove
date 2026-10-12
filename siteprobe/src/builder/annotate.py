"""Phase 4: annotation — a person says which candidate is which field.

The plan's §13.1: the harvester offers candidates, and the person marks "which value
is what field". What makes that mechanical is that a candidate already carries the
rule which would read it again (`Source.rule`), so choosing a candidate *is*
choosing a rule. This module holds the field vocabulary, the mapping from an
annotation to rule hypotheses, and the page itself.

Two things it deliberately cannot do, both of which need the live page rather than
the harvested one:

* highlight the element on the real page;
* let a person pick an element the harvester never offered.

That is the picker the plan defers, and its absence has a consequence worth saying
out loud on the page itself: a value that is not in the list cannot be chosen here,
so the escape hatch is a manual rule or another channel — not a click.

Delivery is by POST to the local server, never by download: a session that ends in
a file landing in a browser's download folder is one the user has to move by hand,
and the plan's endpoint is a UI that runs the tool, which can receive it directly.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from urllib.parse import quote
from typing import Any

from ..generic.select import split_members
from . import text as l10n
from .harvest import COLLECTION_JOIN, Candidate, Harvest, joined_value, same_members

# The fields the plan's §13.1 lists, and what shape each takes. A collection is
# marked once and enlarged by the rule, never one element at a time —
# "use all similar/repeated elements" is the button, not forty clicks.
#
# `preview` is that same act applied to pictures: the field is many images, so it is
# marked once as a group (the harvester offers one candidate per repeated image rule)
# and the rule reads them all. A cover and a preview are chosen the same way; what
# differs is only what the import does with the answer.
#
# Free text has exactly one home in the import: the Entry's `body`, a content beside
# the source URL. `description` is offered because that home exists, and it is carried
# there as a declared passthrough key — see `learn.FIELD_TO_RUNTIME`. It is the only
# field here whose T³ side is not yet wired; the log records what T³ must add.
FIELDS: tuple[tuple[str, str, str], ...] = (
    ("title", "scalar", "作品标题"),
    ("creator", "scalar", "作者 / 创作者"),
    ("date", "scalar", "日期"),
    ("description", "scalar", "简介"),
    ("cover", "image", "封面"),
    ("preview", "images", "预览图"),
    ("tags", "collection", "分类标签"),
    ("characters", "collection", "登场人物"),
    ("series", "collection", "作品系列"),
)

# How many members a field keeps, when the page offers more. A preview set is the case
# this exists for: the entry shows a cover and the pictures behind it, the stack shows four
# layers, and a work with twenty screenshots would otherwise import twenty pictures of
# which a person sees four. The cap is a property of the *field*, and it is applied to both
# halves — the value the page records and the `limit` the rule reads with — because a
# truncated annotation against a rule that reads everything is how a correct rule was
# pruned once already.
FIELD_LIMITS: dict[str, int] = {
    "preview": 3,
}

# Which candidate kind each field can take, so the page can narrow the list instead
# of making a person scroll past four hundred text values to find the cover.
ACCEPTS: dict[str, tuple[str, ...]] = {
    "scalar": ("text", "number", "url"),
    "image": ("image", "url"),
    "images": ("images",),
    "collection": ("text", "collection"),
}

# What each field is asking for, in the words of the page rather than the schema's. Shown
# under the field's name, because the names alone are not enough: measured on a real run,
# `作品 id` was left unmarked — nothing said that the answer is the card's *link* — and a
# listing card with no id is dropped by the runtime, so the whole listing read zero cards.
# The usage tips the annotation page shows in place of its log notes (the C specification:
     # the harvest's own diagnostics are log material, not guidance). One list, so the page and any
     # future surface teach the same three.
USAGE_TIPS: tuple[str, ...] = (
    "保持原网页打开，多复制粘贴：直接复制原网页的内容（作者名、标题、tag），"
    "在搜索框里搜索，就会弹出相应的内容，选择最匹配的。",
    "核心原则：选择最匹配的信息！适配器会打分给出最可能的候选，但最匹配的才是重要的。"
    "\"$作者S$\"、\"123标题456\" 这类像代码的值可能被打高分，"
    "但只要纯净的字段显示在网页上，适配器就一定抓得到——一定要找最匹配的！",
    "多字段组合：适配器可能同时抓到 \"作者S，作者H\" 和分开的 \"作者S\"、\"作者H\"，"
    "要选择包含最多的选项。tag 也是如此。",
)

FIELD_HINTS: dict[str, str] = {
    # a work's page
    "title": "点页面上的作品标题",
    "creator": "点作者 / 创作者的名字",
    "date": "点发布日期",
    "description": "点简介正文（会作为条目正文导入）",
    "cover": "点封面图，或它在页面上的图片地址",
    "preview": "点整组预览图那一项（images 类型，右侧写着有几张；只保留前 "
               f"{FIELD_LIMITS['preview']} 张，本作品没有预览图就不用点）",
    "tags": "点一个分类标签，或整段标签（多位值会自动按逗号 / 空格拆开）",
    "characters": "点一个登场人物，或整段人物（同上，会拆成多位）",
    "series": "点作品系列 / 所属作品",
    # a listing card
    "source_id": "必填：点这张卡上通往作品的链接，编号会从链接里取出来",
    "cover_url": "点卡片上的封面图",
    "date_added": "点卡片上的日期；列表页常常不显示日期，没有就留空",
    "author": "点卡片上的作者 / 社团",
}


# The same shape for a listing's card, under the names the runtime already reads from a
# row (`source_id`, `title`, `cover_url`). Using the runtime's own names is deliberate: a
# listing rule that comes out of this then has no translation step, which is what lets the
# existing review and selection pages consume a generated listing unchanged.
LISTING_FIELDS: tuple[tuple[str, str, str], ...] = (
    ("source_id", "scalar", "作品 id"),
    ("title", "scalar", "标题"),
    ("cover_url", "image", "封面"),
    ("date_added", "scalar", "日期"),
    ("author", "scalar", "作者"),
)


def fields_for(kind: str) -> list[tuple[str, str, str]]:
    return [field for field in FIELDS if field[1] == kind]


def rule_for(candidate: Candidate) -> dict[str, Any] | None:
    """The rule that would read this value again, from whichever source has one.

    A later source is preferred when it is a structured one: an API path survives a
    redesign that a class name does not.
    """
    # Prefer a rule the runtime can actually run, then a structured source, then a rule whose
    # matches all read the same value, then the rule that names fewest elements: a rule that
    # matches forty siblings reads the first of them — unless it was *measured* to read
    # different values at its matches, in which case it is offered last however few they are.
    #
    # A rule naming a *captured response* (`network:4`) cannot run at all until a request recipe
    # exists for it, which the builder does not derive yet (execution log §731). So it must not
    # win over a rule that can: measured on iwara (2026-10-10) the title had a page rule reading
    # exactly one element and the tool still preferred the API path — and because a response is
    # named by its capture *order*, the same name is a different response on the next page, so the
    # confirm page proposed the site's own announcement banner as the work's title.
    #
    # At equal matches, the rule that says *which* of them wins. That is what `index` is for, and
    # without this the proposal path ignored it: measured on buondua (2026-10-10), the annotation
    # held the set's second picture while the confirm page proposed the first — the person accepted
    # the proposal, the two pages then disagreed, and the cover was pruned for good even though a
    # rule that read exactly the annotated picture was sitting right there.
    ranked = sorted(candidate.sources,
                    key=lambda source: (_needs_a_recipe(source.rule),
                                        source.channel == "markup",
                                        (source.rule or {}).get("matches", 1),
                                        0 if "index" in (source.rule or {}) else 1))
    for source in ranked:
        rule = source.rule
        if not rule:
            continue
        if rule.get("conflict"):
            # Measured on the page it came from to read a different value at one of the
            # elements it matches. Proposing it is how 登場人物 came to be filled with the
            # works block (`原神`) on every following page — the field is better left
            # unproposed than proposed with another field's value.
            continue
        return rule
    return None


def _needs_a_recipe(rule: dict[str, Any] | None) -> int:
    """1 when the rule names a captured response, which nothing can fetch yet — else 0.

    A `network:N` document is one the capture recorded, named by its *order* among the responses.
    The runtime fetches such a document by a request recipe, and the builder derives none (execution
    log §731), so the rule reads nothing wherever it is installed — while the same name on another
    page is a different response entirely.
    """
    document = str((rule or {}).get("document") or "")
    return 1 if document.startswith("network:") else 0


def hypotheses(annotation: dict[str, str], harvest: Harvest,
               picks: dict[str, str] | None = None,
               applied: dict[str, dict[str, Any]] | None = None,
               fields: tuple[tuple[str, str, str], ...] = FIELDS) -> dict[str, Any]:
    """Turn `{field: value}` into the rule hypothesis for each field.

    A value with a `pick` takes its rule from the candidate that was clicked. A value
    confirmed in `confirm` mode has no pick — the tool proposed it — so its rule comes
    from what was applied, which is the same rule that read the value.

    One rule per field, and the value it currently reads, which is what the plan's
    Example 2 shows a person to confirm. A field with no rule at all is left out
    rather than guessed at.
    """
    by_id = {candidate.candidate_id: candidate for candidate in harvest.candidates}
    # Keyed by the candidate's value, which is one line — a collection's members joined
    # — so a submitted list is looked up by the same line it was written as.
    by_value = {candidate.value: candidate for candidate in harvest.candidates}
    kinds = {field: kind for field, kind, _label in fields}

    def candidate_for(field: str, value: Any) -> Any:
        """The candidate a submitted value came from, by its line and then by its members.

        A candidate's line is the members joined the way the *harvester* joins them, so a value
        submitted for a field the page writes with other separators (`a b c` beside `a / b / c`)
        misses that line — and the field then looked like one with no candidate behind it, which is
        how the rule that reads it was never offered. Collections and image groups are compared as
        members; every other field stays a line, because a title is not a list.
        """
        line = joined_value(value)
        exact = by_value.get(line)
        if exact is not None:
            return exact
        if kinds.get(field) not in ("collection", "images"):
            return None
        wanted = split_members(line)
        if len(wanted) < 2:
            return None
        return next((candidate for candidate in harvest.candidates
                     if same_members(split_members(candidate.value), wanted)), None)

    result: dict[str, Any] = {}
    for field, _kind, _label in fields:
        value = annotation.get(field)
        if not value:
            continue
        candidate = by_id.get((picks or {}).get(field, "")) \
            or candidate_for(field, value)
        proposal = (applied or {}).get(field) or {}
        rule = proposal.get("rule") or (rule_for(candidate) if candidate else None)
        if rule is None:
            continue
        result[field] = {
            "value": value,
            "score": candidate.score if candidate else None,
            "rule": rule,
            "from": ([source.channel for source in candidate.sources] if candidate
                     else ["confirmed"]),
        }
        if candidate is not None and field in (picks or {}):
            result[field]["candidate_id"] = candidate.candidate_id
        date_kind = proposal.get("date_kind") or (candidate.context.get("date_kind") if candidate else None)
        if date_kind and field in ("date", "date_added"):
            result[field]["date_kind"] = date_kind
    return result


@dataclass
class Annotation:
    """What a person decided, plus what the tool knows about the page it came from."""

    url: str
    fields: dict[str, Any]                  # field -> the value a person accepted
    # Fields this page simply does not carry. A work is not required to have every
    # field: characters may live inside the tags, or only some works declare them.
    # Saying so is what keeps "read nothing here" from being read as a broken rule.
    absent: list[str] = field(default_factory=list)
    picks: dict[str, str] = field(default_factory=dict)      # field -> candidate clicked
    verdicts: dict[str, str] = field(default_factory=dict)    # confirm mode: ok | bad
    mode: str = "annotate"          # annotate | confirm | validate

    def to_json(self) -> dict[str, Any]:
        return {"url": self.url, "mode": self.mode, "fields": self.fields,
                "picks": self.picks, "verdicts": self.verdicts,
                "absent": self.absent}

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> Annotation:
        def text_map(key: str) -> dict[str, str]:
            return {str(k): str(v) for k, v in (payload.get(key) or {}).items()}

        return cls(url=str(payload.get("url") or ""),
                   fields={str(k): kept_value(v)
                           for k, v in (payload.get("fields") or {}).items()},
                   picks=text_map("picks"), verdicts=text_map("verdicts"),
                   absent=[str(name) for name in (payload.get("absent") or [])],
                   mode=str(payload.get("mode") or "annotate"))


def kept_value(value: Any) -> Any:
    """A submitted value as it was submitted: a collection stays a list.

    Stringifying it here is what turned a work's tags into the Python repr of a list,
    brackets and quotes included — and then the rule, which reads the same tags into a
    list, "disagreed" with the value a person had just accepted and was pruned as if
    the rule were the wrong half.
    """
    if isinstance(value, (list, tuple)):
        return [str(member) for member in value]
    return str(value)


def page(harvest: Harvest, *, url: str, mode: str = "annotate",
         applied: dict[str, dict[str, Any]] | None = None, token: str = "",
         fields: tuple[tuple[str, str, str], ...] = FIELDS,
         position: tuple[int, int] | None = None, last: bool = False,
         vocabulary: str = "work", lang: str | None = None) -> str:
    """The annotation page: one self-contained document, no framework, no build.

    Everything it needs is embedded, so it works from a plain HTTP response with no
    second request for data — and the only requests it makes are for the cover
    images it shows, which the same server proxies from its own candidate list.

    `lang` is the whole page's language (`l10n.CHROME`); it defaults to the one T³ passed in the
    environment, because the person reading this page is inside T³ and not in a terminal.

    `vocabulary` is which page this is — a work's, or a listing card's. The card page teaches a
    different job (the card is one sample of a set), so its tips and the words around the save
    button differ; everything else about the page is the same page.
    """
    quoted = quote(token, safe="")
    language = lang if lang in l10n.LANGS else l10n.lang_from_env()
    # Pictures are named by score order (图片1, 图片2, …): an address like
    # `…/files/article/image/4/4525/4525s.jpg` says nothing a person can tell apart, and the same
    # name on the next page is how they confirm "the same picture as last time". The candidate's
    # *value* stays the address — that is what the rule learns — only what the row shows changes.
    named_images: dict[str, str] = {}
    for order, candidate in enumerate(
            sorted((item for item in harvest.candidates if item.kind == "image"),
                   key=lambda item: (-item.score, item.candidate_id)),
            start=1):
        named_images[candidate.candidate_id] = l10n.picture_name(language, order)

    payload = json.dumps({
        "url": url,
        "mode": mode,
        # Where this page sits in the site's sequence, and whether submitting it finishes the
        # adapter — the guidance the console used to carry.
        "lang": language,
        # Rendered by the page, so the numeral is the language's (`第一个网站` / `Site 1 of 3`).
        "position": (None if position is None
                     else {"text": l10n.position_text(language, position[0], position[1])}),
        "last": last,
        "tips": list(l10n.tips_for(vocabulary, language)),
        # The page's own words. Sent rather than written into the script because the script is one
        # string with one language in it, and this page is served in whichever one T³ is in.
        "text": l10n.chrome_for(vocabulary, language),
        "kindLabels": l10n.kind_labels(language),
        "save_url": f"/api/annotations?token={quoted}",
        "fields": [{"key": key, "kind": kind,
                    "label": l10n.field_label(language, key, label),
                    "hint": l10n.field_hint(language, key, limit=FIELD_LIMITS.get(key))}
                   for key, kind, label in fields],
        # What a collection's members are joined with, sent rather than written into the
        # page: the two sides have to agree on it, and a page that guesses records one
        # long tag where the rule reads twelve.
        "join": COLLECTION_JOIN,
        # Example 2: what the tool proposes, for a person to accept or reject.
        "applied": {key: {"value": entry.get("value"), "rule": entry.get("rule")}
                    for key, entry in (applied or {}).items()},
        "accepts": ACCEPTS,
        # How many members a field keeps. Sent rather than written into the page for the
        # same reason the join is: the two sides must agree, and a page keeping three
        # where the rule reads twenty records a value the rule disagrees with.
        "limits": FIELD_LIMITS,
        # Address → 图片N, for the *field* side of the page: a field's answer is an image's address,
        # and the question the left column has to answer is "is that the picture I mean?" — which
        # only the name can, because the name is the one the list on the right shows. Sent rather
        # than rebuilt in the page, so the two sides cannot drift apart.
        "image_names": {candidate.value: named_images[candidate.candidate_id]
                        for candidate in harvest.candidates
                        if candidate.candidate_id in named_images},
        "candidates": [
            {
                "id": candidate.candidate_id,
                "kind": candidate.kind,
                "value": candidate.value,
                "display": candidate.display,
                "date_kind": candidate.context.get("date_kind"),
                "count": candidate.context.get("count"),
                "score": candidate.score,
                "sources": [source.to_json() for source in candidate.sources],
                "has_rule": rule_for(candidate) is not None,
                # Built here, not by the page: the server is the side that knows the
                # token, and a page assembling its own URLs is how every cover came to
                # be requested without one and refused with a 403. A group of images shows
                # its first picture, because twenty addresses in a row say less about
                # which group is the previews than one of its faces does.
                "thumb": (f"/media?c={quote(candidate.candidate_id, safe='')}&token={quoted}"
                          if candidate.kind in ("image", "images") else None),
                # 图片N by score order, for images; the value underneath stays the address.
                "label": named_images.get(candidate.candidate_id),
                "ambiguous": max([source.rule.get("matches", 1)
                                  for source in candidate.sources
                                  if source.rule] or [1]) > 1,
            }
            for candidate in harvest.candidates
        ],
    }, ensure_ascii=False).replace("<", "\\u003c")
    return (_TEMPLATE.replace("__PAYLOAD__", payload)
            .replace("__LANG__", language)
            .replace("__TITLE__", l10n.chrome(language)["docTitle"]))


# The page is deliberately plain: it renders a list, lets two clicks make an
# assignment, and posts the result. No framework, no build step, nothing to install
# — the plan asks for a working view before a nice one, and this is the view that
# answers whether annotation produces anything executable.
# Raw: the script inside it has regexes (`/\{(\w+)\}/`), and a normal string would warn.
_TEMPLATE = r"""<!doctype html>
<html lang="__LANG__"><head><meta charset="utf-8">
<title>__TITLE__</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:13px/1.5 system-ui,sans-serif; background:#14161a; color:#e6e6e6; }
  header { padding:10px 14px; border-bottom:1px solid #2a2e35; position:sticky; top:0;
           background:#14161a; z-index:3; }
  header .url { color:#8aa0b8; word-break:break-all; }
  main { display:flex; gap:14px; padding:14px; align-items:flex-start; }
  /* The field column scrolls on its own. Pinned to the viewport, it used to be as tall as its
     contents, so its lower half — the save button included — could only come into view once the
     *right* column (a page's worth of candidates) had been scrolled to the bottom; measured in the
     app on 2026-10-03, on a page whose field list was taller than the window. */
  .fields { width:290px; flex:none; position:sticky; top:56px;
            max-height:calc(100vh - 70px); overflow-y:auto; }
  .cands { flex:1; min-width:0; }
  .field { border:1px solid #2a2e35; border-radius:6px; padding:8px; margin-bottom:6px; }
  .field.sel { border-color:#4a9eff; }
  .field .name { font-weight:600; }
  .field .val { color:#8fd694; word-break:break-all; font-size:12px; }
  .field .hint { color:#6b7480; font-size:12px; }
  .bar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
  input[type=search] { flex:1; min-width:180px; background:#1b1f25; color:#e6e6e6;
                       border:1px solid #2a2e35; border-radius:6px; padding:6px 8px; }
  button { background:#1b1f25; color:#e6e6e6; border:1px solid #2a2e35; border-radius:6px;
           padding:6px 10px; cursor:pointer; }
  button.on { background:#26456b; border-color:#4a9eff; }
  button.ok { background:#2f6b3a; border-color:#4a9e5c; }
  button.bad { background:#6b2f2f; border-color:#9e4a4a; }
  button.primary { background:#2f6b3a; border-color:#4a9e5c; }
  .cand { border:1px solid #2a2e35; border-radius:6px; padding:8px; margin-bottom:6px;
          display:flex; gap:10px; align-items:flex-start; }
  .cand img { max-width:120px; max-height:160px; border-radius:4px; background:#000; flex:none; }
  .cand code { display:block; background:#101317; padding:2px 4px; border-radius:3px; user-select:text; }
  .cand .thumb-link { display:block; color:#8aa0b8; margin:2px 0; }
  .cand .v { word-break:break-all; }
  .cand .src { color:#6b7480; font-size:12px; word-break:break-all; }
  .cand .score { color:#c9a227; flex:none; }
  .cand.assigned { border-color:#4a9e5c; }
  .empty { color:#6b7480; }
  .send { margin-left:auto; }
  /* The wait, in the middle of the screen. Submitting a page is followed by several seconds of the
     tool capturing the next site (a headless browser, sometimes a minute) and then opening its page;
     the sentence that used to carry this sat in the left column under the save button, which is
     exactly where a person is no longer looking. Opaque enough to be the only thing on screen, and
     it swallows clicks because there is nothing left to do on this page. */
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
  <div class="hint" id="hint"></div>
</header>
<main>
  <section class="fields"><div id="fields"></div>
    <button class="primary send" id="save"></button>
    <div class="hint" id="saveNote"></div>
    <div class="hint" id="status"></div>
  </section>
  <section class="cands">
    <div class="bar">
      <input type="search" id="q">
      <span id="kinds"></span>
    </div>
    <div id="list"></div>
  </section>
</main>
<!-- What the page says once this one is submitted. The tool then captures the next site with a
     headless browser (several seconds) and opens its page, so the wait is the whole message; the
     line under the save button is where nobody looks. -->
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
// `{name}` in a sentence is filled here, so a translation can order its own placeholders.
const fill = (template, values) => template.replace(/\{(\w+)\}/g,
  (whole, name) => (name in values ? String(values[name]) : whole));
// The middle-of-the-screen wait, and the way back down from it: `null` takes it away, which is the
// failure path — a page that could not be saved says so beside the button, where the action was.
// The page's own scrollbar goes with it: a fixed panel leaves it showing along the edge of the veil,
// which reads as "there is still something to do down there".
const veil = (headline, detail) => {
  const box = document.getElementById('veil');
  if (headline === null) { box.className = 'veil'; document.body.style.overflow = ''; return; }
  document.getElementById('veilHead').textContent = headline;
  document.getElementById('veilDetail').textContent = detail || '';
  box.className = 'veil show';
  document.body.style.overflow = 'hidden';
};
// A field's answer is a *value*; the candidate id is only provenance, for the case
// where a person picked it off the list. Conflating the two is why confirming a
// proposal did nothing: accepting a proposal was implemented as finding a candidate
// whose value matched it exactly, and when the rule had read a value no candidate
// carried, the answer became `undefined` — so the buttons came back and the save
// threw on `byId.get(undefined).value`.
const values = {};                // field -> the value a person accepted
const picked = {};                // field -> the candidate id, when one was clicked
const absent = new Set();         // fields this page simply does not carry
let selectedField = null;
let kindFilter = null;

const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const byId = new Map(DATA.candidates.map(c => [c.id, c]));
const join = DATA.join;
const KIND = {};
for (const field of DATA.fields) KIND[field.key] = field.kind;
// A value written as one line. A collection is a list of its members; showing it as
// anything shorter — five of sixteen tags, or the first 300 characters of a cast list
// — is how a person came to accept a partial value and the rule that read all of it
// was pruned as if the rule were the broken half.
const textOf = (value) => Array.isArray(value) ? value.join(join) : String(value);
const counted = (text, value) => Array.isArray(value)
  ? text + fill(T.counted, { count: value.length }) : text;
// A name for an address, so a field answers with the same name the candidate list shows. An address
// says nothing a person can tell apart, and the question the left side has to answer is "is that the
// picture I mean?" — which only the name can, because the name is the one on the right.
const NAME_BY_VALUE = new Map(Object.entries(DATA.image_names || {}));
const isImageField = (key) => KIND[key] === 'image' || KIND[key] === 'images';
// A candidate that *is* a picture (or a group of them), as opposed to one that answers a picture
// field. The chip filter works on this, because what a person looks for there is looked up by eye.
const isPictureKind = (kind) => kind === 'image' || kind === 'images';
const named = (key, value) => {
  if (!isImageField(key)) return null;
  const members = Array.isArray(value) ? value : [value];
  const names = members.map(member => NAME_BY_VALUE.get(member));
  // One address the page did not offer stays an address: naming the rest would hide which one is
  // unknown, and a rule that read something else is exactly what a person has to see here.
  return names.every(Boolean) ? names.join(join) : null;
};
// What a field's answer reads as: the name for images, the value itself otherwise.
const answerText = (key, value) => counted(named(key, value) ?? textOf(value), value);
// What a candidate means as a field's value: assigning a collection assigns its
// members, which is what the rule reads and what the record carries — and a group of
// images assigns the addresses of all of them, for the same reason. A field with a
// declared limit keeps the first that many, which is the same `limit` its rule carries.
const valueOf = (c) => {
  const value = (c.kind === 'collection' || c.kind === 'images')
    ? c.value.split(join) : c.value;
  const cap = DATA.limits[selectedField];
  return Array.isArray(value) && cap ? value.slice(0, cap) : value;
};

function render() {
  document.getElementById('url').textContent =
    (DATA.position ? DATA.position.text + '  ·  ' : '') + DATA.url;
  const hint = document.getElementById('hint');
  hint.textContent = T.pickHint + (DATA.mode === 'annotate' ? T.noRuleHint : '');
  // The usage tips sit where the harvest's log notes used to be: the notes are diagnostics and
  // stay in the session folder, and this page teaches instead.
  for (const tip of DATA.tips) {
    const line = el('div', 'hint'); line.textContent = tip;
    hint.appendChild(line);
  }

  const fields = document.getElementById('fields');
  fields.textContent = '';
  for (const field of DATA.fields) {
    const box = el('div', 'field' + (selectedField === field.key ? ' sel' : ''));
    const name = el('div', 'name'); name.textContent = field.label + '  (' + field.key + ')';
    box.appendChild(name);
    // What the field is asking for, in the page's own words — the field names alone had a
    // person leave the work-id field unmarked on a real run, and a card with no id is dropped.
    if (field.hint) { const why = el('div', 'hint'); why.textContent = field.hint; box.appendChild(why); }
    const proposal = (DATA.applied || {})[field.key];
    const answered = Object.prototype.hasOwnProperty.call(values, field.key);
    const shown = el('div', answered ? 'val' : 'hint');
    if (absent.has(field.key)) shown.textContent = T.absentValue;
    else if (answered) shown.textContent = answerText(field.key, values[field.key]);
    else if (proposal) shown.textContent = (proposal.value === null
      ? T.unreadable : answerText(field.key, proposal.value));
    else shown.textContent = T.unassigned;
    box.appendChild(shown);
    if (proposal && !answered) {
      const accept = el('button', 'ok'); accept.textContent = T.accept;
      accept.onclick = (event) => { event.stopPropagation();
        absent.delete(field.key);
        // The tool proposed a value *and* the rule that read it, so accepting needs
        // nothing else — no candidate has to exist for it.
        values[field.key] = proposal.value;
        render(); };
      const reject = el('button', 'bad'); reject.textContent = T.reject;
      reject.onclick = (event) => { event.stopPropagation();
        absent.delete(field.key);
        delete values[field.key]; delete picked[field.key];
        selectedField = field.key; render(); };
      box.appendChild(accept); box.appendChild(reject);
    }
    // A third answer, and the one that was missing: a work is not required to carry
    // every field. Characters may live inside the tags, or only some works declare
    // them, and neither "correct" nor "wrong" describes that — so it can be said.
    if (!answered) {
      const none = el('button', absent.has(field.key) ? 'on' : '');
      none.textContent = T.absentButton;
      none.onclick = (event) => { event.stopPropagation();
        delete values[field.key]; delete picked[field.key];
        if (absent.has(field.key)) absent.delete(field.key); else absent.add(field.key);
        selectedField = null; render(); };
      box.appendChild(none);
    }
    box.onclick = () => { selectedField = selectedField === field.key ? null : field.key; render(); };
    fields.appendChild(box);
  }

  const kinds = document.getElementById('kinds');
  kinds.textContent = '';
  const counts = {};
  for (const c of DATA.candidates) if (c.has_rule) counts[c.kind] = (counts[c.kind] || 0) + 1;
  const all = el('button', kindFilter === null ? 'on' : '');
  all.textContent = T.kindAll + ' ' + DATA.candidates.length;
  all.onclick = () => { kindFilter = null; render(); };
  kinds.appendChild(all);
  for (const kind of Object.keys(counts).sort()) {
    const b = el('button', kindFilter === kind ? 'on' : '');
    b.textContent = (DATA.kindLabels[kind] || kind) + ' ' + counts[kind];
    b.onclick = () => {
      // Switching to the pictures drops whatever was typed for the field before: a picture is
      // looked up by eye, its value is an address, and a query about the previous field would
      // filter the pictures by it and hide the one being looked for.
      if (isPictureKind(kind)) document.getElementById('q').value = '';
      kindFilter = kind; render();
    };
    kinds.appendChild(b);
  }

  const query = document.getElementById('q').value.trim().toLowerCase();
  const list = document.getElementById('list');
  list.textContent = '';
  const assignedIds = new Set(Object.values(picked));
  const shown = DATA.candidates.filter(c => {
    // No rule, no offer: the tool cannot learn from it, so showing it only invites a pick that
    // teaches nothing.
    if (!c.has_rule) return false;
    if (kindFilter && c.kind !== kindFilter) return false;
    if (!query) return true;
    return c.value.toLowerCase().includes(query)
        || c.sources.some(s => (s.detail || '').toLowerCase().includes(query));
  });
  if (!shown.length) {
    const none = el('div', 'empty'); none.textContent = T.noMatches; list.appendChild(none);
  }
  // A huge page offers more than a person can read at once, so the list stops — and
  // says so, because a list that stops silently reads as a page that has no more.
  const MAX_ROWS = 400;
  for (const c of shown.slice(0, MAX_ROWS)) {
    const row = el('div', 'cand' + (assignedIds.has(c.id) ? ' assigned' : ''));
    if (c.thumb) {
      const img = el('img');
      img.loading = 'lazy';
      img.src = c.thumb;
      img.onerror = () => {
        const note = el('span', 'hint');
        note.textContent = T.pictureFailed;
        img.replaceWith(note);
      };
      const link = el('a', 'thumb-link');
      link.href = c.thumb; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = T.openPicture;
      row.appendChild(link);
      row.appendChild(img);
    }
    const body = el('div'); body.style.minWidth = '0';
    const value = el('div', 'v');
    if (c.thumb) {
      // The name, not the address: a URL says nothing a person can tell apart, and the same name on
      // the next page is how they confirm "the same picture as last time". The address stays in
      // the folded provenance and in the recorded value.
      const name = el('strong');
      name.textContent = c.label || T.pictureBare;
      value.appendChild(name);
      const code = el('code');
      code.textContent = c.value;
      value.appendChild(code);
    } else {
      value.textContent = c.date_kind ? c.display : c.value;
    }
    body.appendChild(value);
    // Where the value came from is how a rule is diagnosed, not something a person
    // annotating a page needs to read past — so it is folded away, one line, closed by
    // default, and the row stays a value and a click.
    const src = el('details', 'src');
    const head = el('summary');
    head.textContent = (c.count ? fill(T.sourceCount, { count: c.count }) : T.source)
      + T.sourceOpen;
    src.appendChild(head);
    const detail = el('div');
    detail.textContent = c.sources.map(s => s.channel + ':' + s.detail).join('  |  ')
      + (c.ambiguous ? ' ' + T.ambiguous : '');
    src.appendChild(detail);
    body.appendChild(src);
    row.appendChild(body);
    const score = el('span', 'score'); score.textContent = c.score;
    row.appendChild(score);
    row.onclick = (event) => {
      // Selecting the address, opening the image, or unfolding the provenance is not
      // choosing a field.
      if (event.target.closest('a, code, details')) return;
      if (!selectedField) { document.getElementById('status').textContent = T.needField; return; }
      values[selectedField] = valueOf(c);
      picked[selectedField] = c.id;
      document.getElementById('status').textContent = '';
      // Choosing a picture ends the search that led to it: an address is not searchable, so a query
      // left in the box would filter the *next* field's values by a word about this one.
      if (c.thumb) document.getElementById('q').value = '';
      render();
    };
    list.appendChild(row);
  }
  if (shown.length > MAX_ROWS) {
    const more = el('div', 'empty');
    more.textContent = fill(T.tooMany, { count: shown.length, max: MAX_ROWS });
    list.appendChild(more);
  }
}

document.getElementById('save').textContent = T.save;
document.getElementById('saveNote').textContent = T.saveNote;
document.getElementById('q').placeholder = T.searchPlaceholder;
document.getElementById('q').oninput = render;
// Clicking the search box means "search everything": a kind filter left on from the last field would
// silently hide the value being looked for, and the box looks like it searches the whole list. A
// click rather than a focus event, because a box that already has the caret fires no focus when it
// is clicked again.
document.getElementById('q').onclick = () => {
  if (kindFilter === null) return;
  kindFilter = null;
  render();
};

document.getElementById('save').onclick = async () => {
  const status = document.getElementById('status');
  status.textContent = '';
  // The wait starts on the click, not on the answer: the person has committed to this page and the
  // next thing that happens is not on it. A failure takes it back down and reports beside the button,
  // where the action was.
  veil(T.submitting, '');
  try {
    const reply = await fetch(DATA.save_url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        url: DATA.url, mode: DATA.mode,
        fields: values,
        picks: picked,
        absent: Array.from(absent),
      }),
    });
    const result = await reply.json();
    if (!result.ok) {
      veil(null, '');
      status.textContent = fill(T.saveFailed, { error: result.error || reply.status });
      return;
    }
    veil(DATA.last ? T.doneHeadline : T.waitHeadline,
         DATA.last ? T.savedLast
                   : fill(T.savedNext,
                          { fields: (result.fields || []).join(', ') || T.savedNothing }));
  } catch (error) {
    veil(null, '');
    status.textContent = fill(T.saveFailed, { error: String(error) });
  }
};

render();
</script>
</body></html>
"""
