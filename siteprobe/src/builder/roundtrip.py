"""Phase 6: does the draft run under the runtime, and does it read what the Builder read?

The plan calls this the decisive acceptance:

    Builder extraction == generated site.json == existing generic runtime extraction
    否则 Builder 只是另一套系统，不能算完成。

Two legs of that are checked here, offline, against a recorded session:

* **Builder extraction** — the annotation's own rules, resolved against the bag
  `capture_to_bag` builds.
* **The generated `site.json` under the runtime** — the same draft loaded by
  `load_template`, its documents produced by `src/generic/declarative.py`, and its
  `work.fields` resolved by `src/generic/select.py`.

Both are compared with the value a person accepted, so agreement between two wrong
answers is not mistaken for success. The third leg — the installed adapter fetching
the live page — is what `--install` sets up and what a person runs by hand.

A field whose rule names a document the declarative reader cannot produce is
reported as `unrunnable` rather than skipped: that is the honest state of an
API-backed rule whose request recipe has not been derived yet, and a round trip that
stayed silent about it would be claiming more than it checked.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..generic import declarative
from ..generic.document import Document as RuntimeDocument
from ..generic.document import DocumentBag
from ..generic.canonical import CATEGORY_FIELDS
from ..generic.bundle import RawItem
from ..generic.extract import build_bag, extract_work
from ..generic.select import resolve
from ..generic.template import SiteTemplate, load_template
from .capture import Capture
from .harvest import Harvest, joined_value, members_of, parse_loose, same_members
from .learn import (FIELD_TO_RUNTIME, Sample, answer_members, key_at, key_index,
                      capture_to_bag, network_names)

AGREE = "agree"
DISAGREE = "disagree"
UNRUNNABLE = "unrunnable"
# Nothing on this page says what the field should be — the sample never answered it —
# so agreement between the two readers here is agreement between two guesses.
UNCHECKED = "unchecked"


@dataclass
class Comparison:
    """One field: read by the runtime, and carried into the record it produces.

    Both halves matter, and the second is the one that was missing. A rule can resolve
    perfectly and still leave the record empty, because `extract_work` writes a record
    from its own field names — measured on a real generated adapter, whose cover was
    learned, verified against the annotation, and then absent from the export.
    """

    field: str
    accepted: Any
    builder: Any
    runtime: Any
    verdict: str
    detail: str = ""
    in_record: bool = False

    def to_json(self) -> dict[str, Any]:
        return {"field": self.field, "accepted": self.accepted, "builder": self.builder,
                "runtime": self.runtime, "verdict": self.verdict,
                "detail": self.detail, "in_record": self.in_record}


@dataclass
class RoundTrip:
    url: str
    comparisons: list[Comparison] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def agreeing(self) -> list[Comparison]:
        return [item for item in self.comparisons if item.verdict == AGREE]

    def disagreeing(self) -> list[Comparison]:
        return [item for item in self.comparisons if item.verdict == DISAGREE]

    def unverified(self) -> list[Comparison]:
        return [item for item in self.comparisons if item.verdict != AGREE]

    @property
    def ok(self) -> bool:
        """Whether nothing was contradicted — not whether everything was verified.

        A field the rules could not confirm is kept out of what gets installed and named
        there instead: refusing the whole adapter because one field is weak is the wrong
        trade, and a page is not required to carry every field anyway.

        A field the two sides *disagree* about is the opposite case, and it was measured
        on a real gallery: four fields agreed, the fifth read a work's tags on the
        runtime side as the Python repr of a list, and the summary still said PASS. One
        of the two is wrong there, so that is a failure, not a caveat.
        """
        return bool(self.comparisons) and not self.disagreeing()

    def to_json(self) -> dict[str, Any]:
        return {"url": self.url, "ok": self.ok, "notes": self.notes,
                "comparisons": [item.to_json() for item in self.comparisons]}


def template_from(draft: dict[str, Any], directory: Path) -> SiteTemplate:
    """Load the draft through the runtime's own loader, not a private one."""
    path = directory / "site.json"
    path.write_text(json.dumps(draft, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    return load_template(path)


def runtime_item(template: SiteTemplate, capture: Capture,
                 names: dict[str, str] | None = None) -> RawItem:
    """The item a declarative adapter would hand the extractor, from a recorded page.

    `names` gives a recorded response the name its request has — what the runtime's recipe produces —
    so a rule naming `network:api.example/work/{id}` finds it here as well.
    """
    markup = capture.markup
    text = markup.text if markup is not None else ""
    item_texts = dict(declarative.documents_from(template, text))
    for document in capture.of_format("json"):
        stable = (names or {}).get(document.name)
        if stable:
            item_texts.setdefault(stable, document.text)
        item_texts.setdefault(document.name, document.text)
    for document in capture.of_format("script"):
        if parse_loose(document.text) is not None:
            item_texts.setdefault(document.name, document.text)

    item = RawItem(source_id="roundtrip", target_url=capture.final_url or capture.url)
    for name, value in item_texts.items():
        item.add(name, value)
    return item


def record_carries(record: dict[str, Any], field: str, value: Any) -> bool:
    """Whether the value a rule read actually reached the record, by name.

    `extract_work` writes only the fields it knows: `cover_url`, not `cover`;
    `author`, not `creator`. A key it does not recognise is dropped, and the export
    then looks like a page with no cover rather than like a broken adapter.
    """
    if field == "cover_url":
        return _same((record.get("cover") or {}).get("url"), value)
    if field == "preview_urls":
        # The previews reach the record as the media list, one entry per picture, each
        # with the address it came from — the same name mismatch as the cover's, and the
        # same answer: ask the record for the addresses it kept.
        return _carried([(entry or {}).get("url")
                         for entry in record.get("preview_images") or []], value)
    if field in CATEGORY_FIELDS:
        members = (record.get("分类信息") or {}).get(CATEGORY_FIELDS[field]) or []
        return _carried(members, value)
    slot = record.get(field)
    if isinstance(slot, list):
        return _carried(slot, value)
    return _same(slot, value)


def _carried(record_members: list[Any], value: Any) -> bool:
    """Whether every member of a value reached the record's own list.

    A collection's value holds several members and the record carries them as its list,
    so asking whether the *whole* value looks like one of them answers no however right
    the record is — which is how a field that arrived whole would be reported as lost.
    """
    wanted = members_of(value)
    if not wanted:
        return False
    return all(any(_same(member, carried) or str(member) in str(carried)
                   for carried in record_members)
               for member in wanted)


def runtime_bag(template: SiteTemplate, capture: Capture,
                names: dict[str, str] | None = None) -> DocumentBag:
    """The bag the runtime builds for a declarative adapter, from a recorded page.

    Built through `extract.build_bag` with documents produced by
    `declarative.documents_from`, so the comparison exercises the same code an
    installed adapter runs — including the format hints, which is where a
    `json` rule silently stops working if `jsonld` is declared as HTML.

    `names` gives a recorded response the name its request has, the same way the runtime's recipe
    does: a rule naming `network:api.example/work/{id}` has to find it here as well.
    """
    markup = capture.markup
    text = markup.text if markup is not None else ""
    documents = declarative.documents_from(template, text)
    item = runtime_item(template, capture, names)
    return build_bag(template, item)


def unnameable_targets(draft: dict[str, Any], urls: list[str]) -> list[str]:
    """Which of the addresses this draft was built from it still could not name.

    The round trip below reads *fields* on the pages it was given; it never asks the draft's target
    patterns whether they match the address a person will paste. Both halves of that fault were
    measured live (plan d4, and the §2.2 debt table): a derived pattern with no capture group, and
    the `^https?://<host>/` fallback `draft_site_json` writes when the samples do not share a host —
    each installs, prints success, and then resolves through no code path at all, because
    `TargetRule.match` answers `None` when there is neither a named nor a positional group.

    Asked through the runtime's own `TargetRule` rather than a second copy of the decision, so this
    cannot drift from what resolution does. Every address must be named by *some* declared target; a
    draft that declares none is reported too, since nothing could reach it.
    """
    from ..generic.template import TargetRule

    rules: dict[str, TargetRule] = {}
    for kind, rule in (draft.get("targets") or {}).items():
        if not isinstance(rule, dict) or not rule.get("url_pattern"):
            continue
        rules[str(kind)] = TargetRule(
            kind=str(kind), url_pattern=re.compile(str(rule["url_pattern"])),
            id_group=rule.get("id_group"), label=str(rule.get("label") or kind),
            accepts_name=bool(rule.get("accepts_name")), single=bool(rule.get("single")),
        )

    problems: list[str] = []
    for url in urls:
        if any(rule.match(url) is not None for rule in rules.values()):
            continue
        if not rules:
            problems.append(
                f"this draft declares no target, so the address it was built from ({url!r}) "
                "could never reach it")
            continue
        textual = [kind for kind, rule in rules.items() if rule.url_pattern.search(url)]
        if textual:
            problems.append(
                f"target {textual[0]!r} matches {url!r} but captures no id, so this site's own "
                "address cannot be named again: `TargetRule.match` reads the id from a named "
                "group, else a positional one, and answers `None` when there is neither")
        else:
            problems.append(
                f"no target of this draft matches {url!r}, an address it was learned from, so the "
                "installed adapter could not be reached by the URL that produced it")
    return problems


def compare(sample: Sample, draft: dict[str, Any], directory: Path) -> RoundTrip:
    """Every field of the draft, read by the Builder and by the runtime."""
    template = template_from(draft, directory)
    result = RoundTrip(url=sample.url)
    # The draft names a recorded response by its request, so the page it is compared against has to
    # offer it under that name too — measured from this page's own captured responses, the same way
    # the draft's names were.
    pages = [(sample.url, sample.capture)]
    sample.document_names = network_names(sample.url, sample.capture,
                                         key_at(sample.url, key_index(pages)))
    fields = (draft.get("work") or {}).get("fields") or {}
    if not fields:
        result.notes.append("the draft carries no field rules, so there is nothing to run")
        return result

    builder_bag = capture_to_bag(sample.capture, sample.document_names)
    installed_bag = runtime_bag(template, sample.capture, sample.document_names)
    record = extract_work(template, runtime_item(template, sample.capture, sample.document_names))
    # What the reader *declares* it can produce. Asking it what it produces for an
    # empty page answers a different question — and answered it wrongly: `jsonld` is
    # produced from the page's own text, so every JSON-LD rule was reported unrunnable
    # and nothing could ever be installed.
    producible = declarative.producible_documents(template) | {
        document.name for document in sample.capture.documents}
    if not (template.documents or {}).get("work"):
        result.notes.append(
            "the template declares no documents, so every rule falls back to the markup")

    for field_name, rule in fields.items():
        # The draft names a field the way the runtime does; the annotation is keyed by
        # the name a person saw, and those differ for `creator`, `date`, `cover`.
        annotation_name = next((name for name, runtime_name in FIELD_TO_RUNTIME.items()
                                if runtime_name == field_name), field_name)
        # The answer as the members it holds, the same reading the learner uses: a tags block the
        # page writes with spaces and the list a rule reads back are the same answer, and comparing
        # the two written forms instead refused the install of a real bilinovel adapter over
        # `转生 / 奇幻 / …` vs `转生 奇幻 …` (2026-10-03). The annotation is keyed by the name a
        # person saw, so the field's kind comes from that name.
        accepted = answer_members(
            annotation_name,
            sample.annotated.get(annotation_name) or sample.annotated.get(field_name))
        document = rule.get("document") if isinstance(rule, dict) else None
        if document and document not in producible:
            result.comparisons.append(Comparison(
                field=field_name, accepted=accepted, builder=None, runtime=None,
                verdict=UNRUNNABLE,
                detail=f"the rule reads document {document!r}, which this reader cannot "
                       "produce; it needs a request recipe"))
            continue
        builder_value = _read(rule, builder_bag, sample.url)
        runtime_value = _read(rule, installed_bag, sample.url)
        if accepted is None:
            # Measured on a real session: one work carried no 登場人物 and no 系列, so the
            # rules learned from the *next* page had nothing to be checked against here —
            # and a rule reading another field's block was reported as agreeing, twice.
            detail = ("this page never said what the field is, so nothing here checks it"
                      + ("" if builder_value is not None or runtime_value is not None
                         else "; both sides read nothing"))
            verdict = UNCHECKED
        elif builder_value is None and runtime_value is None:
            detail = "read nothing on both sides, where this page does have the field"
            verdict = DISAGREE
        elif _same(builder_value, runtime_value):
            if _same(runtime_value, accepted):
                detail = "the runtime read the accepted value"
                verdict = AGREE
            else:
                detail = (f"both sides read {_text(runtime_value)!r}, not the accepted "
                          f"{_text(accepted)!r}")
                verdict = DISAGREE
        else:
            detail = f"builder {_text(builder_value)!r} vs runtime {_text(runtime_value)!r}"
            verdict = DISAGREE
        # The second half: did it reach the record under a name the runtime reads?
        carried = record_carries(record, field_name, runtime_value)
        if verdict == AGREE and not carried:
            verdict = DISAGREE
            detail = (f"the runtime read {_text(runtime_value)!r} but the record has no "
                      f"{field_name!r}; `extract_work` writes only the fields it knows")
        result.comparisons.append(Comparison(
            field=field_name, accepted=accepted, builder=builder_value,
            runtime=runtime_value, verdict=verdict, detail=detail, in_record=carried))
    return result


def _read(rule: Any, bag: DocumentBag, url: str) -> Any:
    if not isinstance(rule, dict):
        return None
    try:
        value = resolve(rule, bag, context={"url": url})
    except Exception:  # noqa: BLE001 - a rule that cannot run reads nothing
        return None
    if value is None or value == "" or value == []:
        return None
    return value


def _same(one: Any, other: Any) -> bool:
    """Both values hold the same members, in order — one member each, usually."""
    return same_members(one, other)


def _text(value: Any) -> str:
    """A value as one line, for a report a person reads."""
    return joined_value(value) if value is not None else ""


def _write_json(path: Path, payload: Any) -> None:
    """JSON with a trailing newline, written atomically.

    `site.json` is the one file the registry reads to find a site, and this used to be the one writer
    in the toolkit that truncated in place. A writer cut off mid-write — a killed install, a full
    disk — left the file half a JSON document, and discovery then could not read *any* site: measured
    by putting a file cut off mid-write beside a good one, `discover` raised `JSONDecodeError` and the
    good site was unreachable too. Every other file this project writes already goes through a
    temporary and a replace (`export_layout.write_json`, `crawl_state.save`); this is that same
    shape, so a reader either sees the whole new file or the whole old one.
    """
    from ..generic.export_layout import replace_with_retry

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write(chr(10))
    except BaseException:
        # The destination is untouched, which is the point — but the half-written temporary is litter
        # in the adapter folder, and nothing else would ever collect it.
        temporary.unlink(missing_ok=True)
        raise
    replace_with_retry(temporary, path)


def install(draft: dict[str, Any], generated_root: Path, slug: str | None = None,
            *, source: str | None = None,
            unverified: list[str] | None = None) -> Path:
    """Put the draft where the registry looks for generated adapters.

    Two files and no Python, which is plan 25's shape: a `site.json` the runtime reads
    declaratively, and an `adapter.json` recording what it is. It lands in the
    generated root rather than beside the hand-written sites, because those are pinned
    by this project's own tests and a built adapter must not be mistaken for one.

    **A site's adapter has two halves and a build owns only one of them.** The work builder writes
    `work` + its `targets`/`documents`; the listing builder writes `listings` + its own. Both land in
    the same folder, because the folder is the site — so writing the file wholesale meant the second
    build *deleted the first half*: measured on bilinovel on 2026-10-04, where a listing run erased
    the work adapter built the day before, and the site's own export tree quietly stopped describing
    its works. An install now replaces the sections it was built for and keeps the ones it was not.
    """
    name = _slug(slug or str(draft.get("tool") or draft.get("key") or "site"))
    target = generated_root / name
    # `tool` is written back as the name the folder actually got: the loader resolves
    # the site's reader by that name, so the two disagreeing is a site the registry
    # discovers and cannot read. The file itself is assembled below, from the draft and whatever
    # half of this site is already on disk.
    payload = _merged_with_what_is_already_there(target, draft, name)
    _write_json(target / "site.json", payload)
    # What the T3 side still has to do for this adapter's fields to arrive whole. It
    # travels with the adapter because that is where whoever imports it will look.
    needs: list[str] = []
    if "description" in ((draft.get("work") or {}).get("passthrough") or []):
        needs.append(
            "site-probe.ts: map the export document's `description` to the import "
            "entry's `body`. zod strips keys it does not declare, so without this the "
            "value is silently dropped.")
        needs.append(
            "the commit mapping must name a `bodyContentType` for it: commit.ts throws "
            "'Import Entry body has no reviewed Content mapping' when a body arrives "
            "without one, so the import flow gains a required choice.")
    payload = _merged_with_what_is_already_there(target, draft, name)
    _write_json(target / "site.json", payload)
    # Two files, two purposes: `adapter.json` is what discovery reads (§16 — domain,
    # capabilities, version), and `learned.json` records how these rules came about. Both describe
    # the *file*, not the draft: a kept half's capabilities belong to the adapter too, and a list
    # that named only this build's fields would hide the half the site already had.
    _write_json(target / "adapter.json", {
        "schema_version": 1,
        "domain": payload.get("key"),
        "version": 1,
        "capabilities": sorted(
            set(_field_names(payload.get("work") or {}))
            | {field for listing in (payload.get("listings") or {}).values()
               for field in _field_names(listing)}),
        "source": "local",
    })
    _write_json(target / "learned.json", {
        "schema_version": 1,
        "generated_by": "siteprobe-builder",
        "kind": "declarative",
        "source": source,
        "fields": sorted(((payload.get("work") or {}).get("fields") or {})),
        "passthrough": list(((payload.get("work") or {}).get("passthrough") or [])),
        # Fields the rules could not confirm on the sampled pages. Kept and named
        # rather than dropped silently: a field that reads a wrong value is worse than
        # a field that reads none.
        "unverified": list(unverified or []),
        # And when the site already has a written adapter, this one is not what runs:
        # the registry keeps the written site and this `site.json` stays on disk unread.
        # Measured on a real gallery, where the Builder learned a site the toolkit
        # already reads — so the person who built it has to be told.
        "adapter_beside": _adapter_beside(generated_root, name),
        "t3_needs": needs,
    })
    return target


def _field_names(section: Any) -> list[str]:
    """The field names a `work` / `listing` section declares.

    A section is a plain dict in a written `site.json` and may be an object in a draft, and reading
    only the object form is how a listing's capabilities came out **empty** on a real install
    (`getattr` on a dict answers the default, silently). Measured on the bilinovel install of
    2026-10-04, whose `adapter.json` listed no capabilities at all.
    """
    fields = section.get("fields") if isinstance(section, dict) else getattr(section, "fields", None)
    return sorted(fields or {})


def _merged_with_what_is_already_there(target: Path, draft: dict[str, Any],
                                       name: str) -> dict[str, Any]:
    """The draft plus the halves of the site's adapter this draft was not built for.

    A site's `site.json` carries one section per half — `work` for the work builder, `listings` for
    the listing one — and the halves share nothing else (`targets` and `documents` are keyed by the
    section that reads them). So the merge is section-wise: everything this build wrote wins, and
    everything it did not mention is kept from the file. See `install` for the measurement that made
    this necessary.
    """
    import json

    path = target / "site.json"
    existing: dict[str, Any] = {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            existing = loaded
    except (OSError, ValueError):
        existing = {}

    merged = {**existing, **draft}
    for keyed in ("targets", "documents"):
        merged[keyed] = {**(existing.get(keyed) or {}), **(draft.get(keyed) or {})}
    for half in ("work", "listings"):
        if not draft.get(half) and existing.get(half):
            merged[half] = existing[half]
    return {**merged, "tool": name}


def _adapter_beside(learned_root: Path, name: str) -> str | None:
    """The written adapter for the same site, if there is one.

    Matched by the site `key` rather than by folder name: an adapter's folder is named after the
    tool (`comic18`), not after the domain it serves (`18comic.vip`), so a folder-name check
    would miss exactly the sites that already have both.
    """
    import json

    for candidate in sorted((learned_root.parent).glob("*/site.json")):
        if candidate.parent == learned_root:
            continue
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if payload.get("key") == name:
            return str(candidate)
    return None


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9_]+", "_", value.casefold()).strip("_") or "site"
