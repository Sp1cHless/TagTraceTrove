"""A read-only look at a rule set: what it can and cannot run, before anything touches the network.

The plan's Phase F (§5-F) is compatibility and diagnosis, and its two rules shape this module:

* **config-only by default.** Everything here is answerable from the files alone — a target whose
  pattern captures no id, a rule naming a document the reader cannot produce, a transform this Core
  does not know. Doctor does **not** visit a site; "needs a network" is a different question and is
  left to `health.py` (which reads a page) and the probe.
* **read-only unless asked.** `diagnose` opens files and writes nothing. `upgrade` is a separate,
  explicit call that previews a diff, saves a **byte-identical** backup, and replaces atomically — so
  a rule set can always be put back exactly as it was. Nothing here ever deletes an unknown field: a
  key this version does not understand is data the user put there.

The compatibility contract, kept deliberately loose (plan §5-F.1): this Core runs a rule set that
declares `schema_version` 1, or none at all. Adding an optional field never requires an upgrade; the
things that *do* require one are a missing `adapter.json` and a stale `learned.json`, and those are
`repairable` hints rather than errors.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import declarative, select
from .export_layout import replace_with_retry
from .template import TemplateError, load_template

#: The rule-format version this Core runs. A file may declare it or omit it; both are version 1.
FORMAT_VERSION = 1
#: Transform names this Core can execute. `relative_date` is handled in `apply_transforms` rather
#: than in the table (it needs the run's frozen clock), so it is listed here too.
KNOWN_TRANSFORMS = frozenset(select._TRANSFORMS) | {"relative_date"}
#: The one record field only a *rule* can supply. `source_id` comes from the target pattern and
#: `detail_url` defaults to the work's own address (`extract_work`), so neither has to be declared —
#: measured against the real adapters, where nine of them declare no `detail_url` and read fine.
REQUIRED_RECORD_FIELDS = ("title",)


@dataclass
class Note:
    """One thing doctor has to say about a rule set."""

    level: str            # error | warning | info
    code: str
    message: str
    path: str = ""
    #: True when `upgrade` can fix it in place (a missing `adapter.json`, a stale `learned.json`).
    repairable: bool = False

    def to_json(self) -> dict[str, Any]:
        return {"level": self.level, "code": self.code, "message": self.message,
                "path": self.path, "repairable": self.repairable}


@dataclass
class DoctorReport:
    site: str
    directory: str
    notes: list[Note] = field(default_factory=list)

    def add(self, note: Note) -> None:
        self.notes.append(note)

    @property
    def ok(self) -> bool:
        return not any(note.level == "error" for note in self.notes)

    def errors(self) -> list[Note]:
        return [note for note in self.notes if note.level == "error"]

    def repairable(self) -> list[Note]:
        return [note for note in self.notes if note.repairable]

    def to_json(self) -> dict[str, Any]:
        return {"site": self.site, "directory": self.directory, "ok": self.ok,
                "notes": [note.to_json() for note in self.notes]}


def _walk_rules(node: Any) -> list[dict[str, Any]]:
    """Every rule-shaped dict inside a section, however deeply nested (`fallback`, lists, scopes)."""
    found: list[dict[str, Any]] = []
    if isinstance(node, dict):
        found.append(node)
        for value in node.values():
            found.extend(_walk_rules(value))
    elif isinstance(node, list):
        for value in node:
            found.extend(_walk_rules(value))
    return found


def _transforms_of(node: Any) -> list[str]:
    names: list[str] = []
    for rule in _walk_rules(node):
        transform = rule.get("transform")
        if isinstance(transform, str):
            names.append(transform)
        elif isinstance(transform, list):
            names.extend(str(name) for name in transform)
    return names


def _documents_named(node: Any) -> set[str]:
    names: set[str] = set()
    for rule in _walk_rules(node):
        document = rule.get("document")
        if isinstance(document, str) and document:
            names.add(document)
    return names


def _is_declarative(directory: Path) -> bool:
    """Whether this adapter is read from `site.json` alone — the registry's own rule.

    A site that ships no `fetch.py` is read declaratively; a `fetch.py` that imports the generic
    reader is the declarative shim. Only then must every document a rule names be one *this* reader
    can produce. A written adapter (`comic18`, `hanime1_me`) builds its own documents in its own
    `fetch.py` — `detail_html`, a redacted page — and doctor must not flag those as unproducible.
    """
    fetch = directory / "fetch.py"
    if not fetch.is_file():
        return True
    try:
        text = fetch.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return True
    return "declarative" in text


def diagnose(path: Path) -> DoctorReport:
    """Every config-only fact about one rule set. Reads files; writes nothing; visits no site."""
    path = Path(path)
    directory = path if path.is_dir() else path.parent
    site_json = directory / "site.json"
    report = DoctorReport(site=directory.name, directory=str(directory))
    if not site_json.is_file():
        report.add(Note("error", "NO_SITE_JSON", f"no site.json in {directory}", str(site_json)))
        return report

    try:
        template = load_template(site_json)
    except (TemplateError, ValueError) as error:
        report.add(Note("error", "SITE_JSON_UNREADABLE", f"site.json cannot be read: {error}",
                        str(site_json)))
        return report
    report.site = template.key

    # Targets: a pattern that captures no id resolves through no code path at all (the plan's §2 row).
    for kind, rule in template.targets.items():
        if rule.url_pattern is None:
            report.add(Note("warning", "TARGET_NO_PATTERN",
                            f"target {kind!r} declares no url_pattern", str(site_json)))
            continue
        if not rule.url_pattern.groups:
            report.add(Note("error", "TARGET_CAPTURES_NO_ID",
                            f"target {kind!r} matches but captures no id, so no address can be named "
                            f"through it", str(site_json)))

    # Documents: a work rule whose *primary* document the reader cannot produce reads nothing. A
    # document named only inside a `fallback` branch is a different thing — the field still reads
    # through its primary, so an unreachable fallback is a warning, not a failure (measured on
    # rule34video, whose `date_added` primary is `jsonld` and whose fallback names a Builder-only
    # `inline:0`). Only a declarative adapter is held to this: a written one produces its own.
    if _is_declarative(directory):
        producible = declarative.producible_documents(template)
        for name, rule in ((template.raw.get("work") or {}).get("fields") or {}).items():
            if not isinstance(rule, dict):
                continue
            primary = rule.get("document")
            if isinstance(primary, str) and primary and primary not in producible:
                report.add(Note("error", "DOCUMENT_UNAVAILABLE",
                                f"work field {name!r} reads document {primary!r}, which this reader "
                                f"cannot produce, so the field reads nothing", str(site_json)))
            for branch in rule.get("fallback") or []:
                for document in _documents_named(branch):
                    if document not in producible:
                        report.add(Note("warning", "DOCUMENT_UNAVAILABLE_FALLBACK",
                                        f"work field {name!r} has a fallback naming document "
                                        f"{document!r}, which this reader cannot produce; the "
                                        f"fallback will never run", str(site_json)))

    # Transforms: an unknown name is a rule this Core cannot execute.
    for section in ("work", "listing", "listings"):
        block = template.raw.get(section) or {}
        for name in _transforms_of(block):
            if name not in KNOWN_TRANSFORMS:
                report.add(Note("error", "TRANSFORM_UNKNOWN",
                                f"unknown transform {name!r}; this Core cannot run the rule",
                                str(site_json)))

    # Required fields: a work adapter that cannot produce a title or a detail address imports nothing.
    work_fields = set((template.raw.get("work") or {}).get("fields") or {})
    if work_fields:
        for name in REQUIRED_RECORD_FIELDS:
            if name not in work_fields:
                report.add(Note("warning", "REQUIRED_FIELD_NOT_DECLARED",
                                f"the work section declares no {name!r} field", str(site_json)))

    # Metadata consistency: repairable hints, never errors (plan §5-F.4).
    _metadata_notes(directory, template, report)
    return report


def _metadata_notes(directory: Path, template: Any, report: DoctorReport) -> None:
    adapter = directory / "adapter.json"
    if not adapter.is_file():
        report.add(Note("warning", "ADAPTER_JSON_MISSING",
                        "no adapter.json; discovery reads it for the domain and capabilities",
                        str(adapter), repairable=True))
    else:
        try:
            payload = json.loads(adapter.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            payload = None
        if not isinstance(payload, dict):
            report.add(Note("warning", "ADAPTER_JSON_UNREADABLE",
                            "adapter.json is not a JSON object", str(adapter), repairable=True))
        else:
            if payload.get("domain") not in (None, template.key):
                report.add(Note("warning", "ADAPTER_DOMAIN_MISMATCH",
                                f"adapter.json names domain {payload.get('domain')!r} while "
                                f"site.json is {template.key!r}", str(adapter), repairable=True))
            if not isinstance(payload.get("capabilities"), list):
                report.add(Note("warning", "ADAPTER_CAPABILITIES_MISSING",
                                "adapter.json declares no capabilities list", str(adapter),
                                repairable=True))
    learned = directory / "learned.json"
    if learned.is_file():
        try:
            payload = json.loads(learned.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            payload = None
        if isinstance(payload, dict) and "schema_version" not in payload:
            report.add(Note("warning", "LEARNED_SCHEMA_MISSING",
                            "learned.json carries no schema_version", str(learned), repairable=True))


@dataclass
class UpgradeResult:
    applied: bool
    changes: list[dict[str, str]] = field(default_factory=list)
    backups: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {"applied": self.applied, "changes": self.changes, "backups": self.backups}


def _capabilities_of(template: Any) -> list[str]:
    """The field names the rule set can produce — what `adapter.json` records."""
    names: set[str] = set((template.raw.get("work") or {}).get("fields") or {})
    for listing in (template.raw.get("listings") or {}).values():
        if isinstance(listing, dict):
            names.update((listing.get("fields") or {}).keys())
    return sorted(names)


def upgrade(directory: Path, *, apply: bool = False) -> UpgradeResult:
    """Bring a rule set's metadata up to this Core's shape — previewed, backed up, atomic.

    Two files are touched at most, and only to *add* what is missing: `adapter.json` gains the domain
    and the capability list it should have had, and `learned.json` gains `schema_version`. Everything
    already in a file is kept — an unknown field is the user's, not this tool's to drop (plan §5-F.6).
    With `apply=False` (the default) nothing is written and the diff is returned for review.
    """
    directory = Path(directory)
    site_json = directory / "site.json"
    template = load_template(site_json)
    result = UpgradeResult(applied=False)

    adapter_path = directory / "adapter.json"
    existing: dict[str, Any] = {}
    if adapter_path.is_file():
        try:
            loaded = json.loads(adapter_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                existing = loaded
        except (OSError, ValueError):
            existing = {}
    wanted_adapter = {
        **existing,
        "schema_version": existing.get("schema_version", 1),
        "domain": template.key,
        "capabilities": _capabilities_of(template),
        "source": existing.get("source", "local"),
    }
    if not adapter_path.is_file() or existing.get("domain") != template.key \
            or existing.get("capabilities") != wanted_adapter["capabilities"]:
        result.changes.append({
            "path": str(adapter_path),
            "before": adapter_path.read_text(encoding="utf-8") if adapter_path.is_file() else "",
            "after": json.dumps(wanted_adapter, ensure_ascii=False, indent=2) + "\n",
        })

    learned_path = directory / "learned.json"
    if learned_path.is_file():
        try:
            loaded = json.loads(learned_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            loaded = {}
        if isinstance(loaded, dict) and "schema_version" not in loaded:
            wanted_learned = {"schema_version": 1, **loaded}
            result.changes.append({
                "path": str(learned_path),
                "before": learned_path.read_text(encoding="utf-8"),
                "after": json.dumps(wanted_learned, ensure_ascii=False, indent=2) + "\n",
            })

    if not apply or not result.changes:
        return result

    for change in result.changes:
        target = Path(change["path"])
        if target.is_file():
            # A byte-identical copy beside it, so the original is recoverable exactly — not a
            # re-serialised approximation of it.
            backup = target.with_suffix(target.suffix + ".bak")
            backup.write_bytes(target.read_bytes())
            result.backups.append(str(backup))
        _write_atomic(target, change["after"])
    result.applied = True
    return result


def _write_atomic(path: Path, text: str) -> None:
    """Write via a temporary and a replace: a reader sees the whole new file or the whole old one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    replace_with_retry(temporary, path)
