"""Why a run produced nothing — said as data a program can branch on, not as prose.

The hard case this exists for is the one the plan names first (§2, §5-A): **an adapter installs,
reports success, and the import that follows finds the required fields empty**. The step that
produced the emptiness knew why — a listing read zero rows, two cards answered the same id, a work
page had no title — but it said so in a sentence, and a sentence is not something a caller can act
on. Here those states become `Finding`s: a stable `code`, the `stage` that produced it, a
`severity`, and the small evidence needed to name the fault.

Two rules this module keeps, both from the plan:

* **Nothing here is site-specific.** A finding describes a shape (an empty card set, a repeated id,
  a field no page answered), never a domain. Which sites hit which shape is the caller's business.
* **Evidence is bounded and safe.** Counts, field names, a few ids, an HTTP status, a document name
  — never a cookie, an Authorization header, browser storage, or a full private response. A URL that
  reaches a finding is passed through `redact_url` first, so a signed or session-bearing query
  string becomes `…`.

The vocabulary is shared with the TypeScript side (`packages/shared/src/schemas/siteprobe.ts`), and
the plan's own §4.1 table is the contract: keep the two in step by hand, the same way `ERROR_CODES`
already is.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from dataclasses import field as dc_field
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit

# Where a fault was seen. Ordered the way a run proceeds, so a report reads top to bottom.
STAGES = ("target", "acquisition", "listing", "work", "media", "import")

SEVERITIES = ("error", "warning", "info")

# How a probe stage ended. `skipped` is a stage there was nothing to do for (a site with no cover
# marked); `unavailable` is a stage that could not be reached from here (T³'s parser while the CLI
# runs alone) — the two are kept apart because "not applicable" and "not checked" are different
# answers, and the plan's §5-A.8 forbids wrapping either as a pass.
STATUSES = ("passed", "failed", "skipped", "unavailable")

# The initial set the plan fixes (§4.1). A code is added here only when a stage can actually emit
# it, so the set stays honest about what the tool can currently say.
FINDING_CODES = frozenset({
    "TARGET_NOT_MATCHED",     # no target rule claims the input
    "TARGET_ID_AMBIGUOUS",    # two candidate ids; a person must choose
    "ACQUISITION_EMPTY",      # the page was reached but held no document
    "ACQUISITION_FAILED",     # the fetch/rendering did not complete
    "DOCUMENT_UNAVAILABLE",   # a rule names a document the reader cannot produce
    "LISTING_ROWS_EMPTY",     # the listing produced no card
    "SOURCE_ID_EMPTY",        # a card/work carries no id
    "SOURCE_ID_DUPLICATED",   # two cards/work answer the same id
    "WORK_FIELD_EMPTY",       # a required field no page answered
    "COVER_URL_EMPTY",        # no cover address was read (usually legitimate)
    "COVER_FETCH_FAILED",     # a cover address was read but the bytes did not arrive
    "IMPORT_CONTRACT_REJECTED",  # T³'s importer refused the export
    "CAPABILITY_UNSUPPORTED",  # the shape needs a custom adapter, not a rule
    "BUDGET_EXCEEDED",        # the probe's own time budget ran out
})

# A field is "required" when a record without it cannot be imported — the same four the export
# writer refuses to build a manifest around (`canonical.REQUIRED_KEYS`). Kept as a literal here so
# this module reads no other module; the two are checked against each other in the tests.
REQUIRED_FIELDS = ("source_site", "source_id", "title", "detail_url")

_REDACTED = "…"


def redact_url(url: str) -> str:
    """A URL safe to put in a report: no credentials, no query values.

    A query value is where a session token, an `authkey`, or a share signature lives, and a finding
    travels to a log and sometimes to a screen. The parameter *names* are kept — they are the shape
    of the address and are not secret — and every value becomes `…`. Userinfo is dropped outright.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if not parts.scheme and not parts.netloc:
        # Not an address (a bare id, a name); there is nothing to redact.
        return url
    host = parts.hostname or ""
    netloc = f"{host}:{parts.port}" if parts.port else host
    query = ""
    if parts.query:
        names = [pair.split("=", 1)[0] for pair in parts.query.split("&") if pair]
        query = "&".join(f"{name}={_REDACTED}" for name in names)
    return urlunsplit((parts.scheme, netloc, parts.path, query, ""))


@dataclass
class Finding:
    """One explanation of one state, in the shape the caller branches on.

    `message` is a sentence for a person and may be reworded; `code`, `stage` and `severity` are the
    contract and are not. `evidence` is deliberately a small open mapping — a caller that does not
    know a key ignores it — rather than a fixed schema that would have to grow with every stage.
    """

    code: str
    stage: str
    severity: str
    message: str
    field: str | None = None
    target_kind: str | None = None
    evidence: dict[str, Any] = dc_field(default_factory=dict)
    suggested_action: str | None = None

    def __post_init__(self) -> None:
        # A typo in a code or a stage would travel all the way to a UI as an unknown branch, so it is
        # caught at the raise site instead.
        if self.code not in FINDING_CODES:
            raise ValueError(f"unknown finding code {self.code!r}")
        if self.stage not in STAGES:
            raise ValueError(f"unknown stage {self.stage!r}")
        if self.severity not in SEVERITIES:
            raise ValueError(f"unknown severity {self.severity!r}")

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "code": self.code,
            "stage": self.stage,
            "severity": self.severity,
            "message": self.message,
        }
        # Absent keys are absent, not null: a caller reading `finding.field` gets undefined rather
        # than a null it has to special-case.
        if self.field:
            payload["field"] = self.field
        if self.target_kind:
            payload["target_kind"] = self.target_kind
        if self.evidence:
            payload["evidence"] = self.evidence
        if self.suggested_action:
            payload["suggested_action"] = self.suggested_action
        return payload


# --- the findings the core actually produces ------------------------------------------------ #
#
# Each is a named constructor rather than a raw `Finding(...)` at the raise site, so the wording and
# the severity of one shape are decided in one place. Severity follows the plan's rule (§4.4): an
# optional field that is genuinely absent is `info`, an annotated field that failed to arrive is
# `warning`, and anything that leaves a record un-importable is `error`.

def listing_rows_empty(*, kind: str | None = None, url: str | None = None,
                       read: int = 0) -> Finding:
    evidence: dict[str, Any] = {"rows": read}
    if url:
        evidence["url"] = redact_url(url)
    return Finding(
        code="LISTING_ROWS_EMPTY", stage="listing", severity="error",
        target_kind=kind,
        message="the listing page was read but produced no card, so the run would import nothing",
        evidence=evidence,
        suggested_action="re-open the listing in the Builder and mark a card whose link carries "
                         "the work id",
    )


def acquisition_empty(*, kind: str | None = None, url: str | None = None) -> Finding:
    evidence: dict[str, Any] = {}
    if url:
        evidence["url"] = redact_url(url)
    return Finding(
        code="ACQUISITION_EMPTY", stage="acquisition", severity="error", target_kind=kind,
        message="the address was reached but returned no document",
        evidence=evidence,
        suggested_action="check the address, or sign in if the site needs it",
    )


def acquisition_failed(*, kind: str | None = None, url: str | None = None,
                       detail: str = "") -> Finding:
    evidence: dict[str, Any] = {}
    if url:
        evidence["url"] = redact_url(url)
    if detail:
        evidence["detail"] = detail
    return Finding(
        code="ACQUISITION_FAILED", stage="acquisition", severity="error", target_kind=kind,
        message="the page could not be read (network, rendering or a bot check)",
        evidence=evidence,
        suggested_action="retry, and sign in first if the site needs it",
    )


def document_unavailable(*, document: str, field: str | None = None) -> Finding:
    return Finding(
        code="DOCUMENT_UNAVAILABLE", stage="work", severity="error", field=field,
        message=f"a rule reads document {document!r}, which this reader cannot produce",
        evidence={"document": document},
        suggested_action="the rule needs a request recipe for that document",
    )


def source_id_empty(*, where: str, count: int = 1, stage: str = "listing") -> Finding:
    return Finding(
        code="SOURCE_ID_EMPTY", stage=stage, severity="error",
        message=f"{count} {where} carried no id and were dropped, so they cannot be imported",
        evidence={"count": count},
        suggested_action="mark the card's link as `作品 id` in the Builder",
    )


def source_id_duplicated(ids: Iterable[str], *, stage: str = "listing",
                         target_kind: str | None = None) -> Finding:
    values = [str(value) for value in ids]
    return Finding(
        code="SOURCE_ID_DUPLICATED", stage=stage, severity="error", target_kind=target_kind,
        message=f"{len(values)} id(s) answer more than one work, so the listing is not reading "
                f"distinct works",
        evidence={"count": len(values), "ids": values[:5]},
        suggested_action="the id rule is reading something that repeats (a class, a constant); "
                         "re-mark the field that actually names the work",
    )


def work_field_empty(field: str, *, ids: Iterable[str] = (), count: int | None = None,
                     severity: str = "error") -> Finding:
    values = [str(value) for value in ids]
    total = count if count is not None else len(values)
    return Finding(
        code="WORK_FIELD_EMPTY", stage="work", severity=severity, field=field,
        message=f"{total} work(s) had no {field}; a record without it cannot be imported",
        evidence={"count": total, **({"ids": values[:5]} if values else {})},
        suggested_action=f"check which page the {field} rule reads, and re-annotate that field",
    )


def cover_url_empty(*, ids: Iterable[str] = (), expected: bool = False) -> Finding:
    values = [str(value) for value in ids]
    return Finding(
        code="COVER_URL_EMPTY", stage="media",
        # `expected` is the plan's distinction: a cover the person marked that did not arrive is a
        # warning; a site that simply has no cover is information.
        severity="warning" if expected else "info",
        field="cover_url",
        message=("a cover was marked but no page produced one"
                 if expected else "no cover address was read (this site may simply have none)"),
        evidence={**({"ids": values[:5]} if values else {})},
        suggested_action="re-mark the cover in the Builder" if expected else None,
    )


def cover_fetch_failed(*, url: str | None = None, status: int | None = None,
                       detail: str = "") -> Finding:
    evidence: dict[str, Any] = {}
    if url:
        evidence["url"] = redact_url(url)
    if status is not None:
        evidence["status"] = status
    if detail:
        evidence["detail"] = detail
    return Finding(
        code="COVER_FETCH_FAILED", stage="media", severity="warning", field="cover_url",
        message="a cover address was read but its bytes did not arrive",
        evidence=evidence,
        suggested_action="retry; if the site needs a referer or a session, sign in first",
    )


def import_contract_rejected(*, detail: str = "") -> Finding:
    return Finding(
        code="IMPORT_CONTRACT_REJECTED", stage="import", severity="error",
        message="the export did not satisfy the import contract",
        evidence=({"detail": detail} if detail else {}),
        suggested_action="copy the diagnostics and report them",
    )


def capability_unsupported(*, what: str) -> Finding:
    return Finding(
        code="CAPABILITY_UNSUPPORTED", stage="target", severity="error",
        message=f"this shape needs a custom adapter rather than a declarative rule: {what}",
        suggested_action="report the capability gap; a rule set cannot express this",
    )


def budget_exceeded(*, stage: str, seconds: float) -> Finding:
    return Finding(
        code="BUDGET_EXCEEDED", stage=stage, severity="error",
        message=f"the probe spent its whole {seconds:.0f}s budget before finishing this stage",
        evidence={"seconds": round(seconds, 1)},
        suggested_action="retry, or probe a single page/work by hand",
    )


# --- a bounded probe's own report ------------------------------------------------------------ #

@dataclass
class Budget:
    """One clock for one probe run, frozen at the start.

    The plan (§4.4) freezes a run's clock so a relative date and a relative timeout agree on "now",
    and caps a probe so it cannot turn into an open-ended crawl (§5-A, 45s + 90s). Measured against
    `monotonic`, which cannot go backwards under a clock adjustment the way `time.time()` can.
    """

    seconds: float
    started: float = dc_field(default_factory=time.monotonic)

    def used(self) -> float:
        return time.monotonic() - self.started

    def remaining(self) -> float:
        return max(0.0, self.seconds - self.used())

    def expired(self) -> bool:
        return self.used() >= self.seconds


@dataclass
class StageResult:
    """One stage's verdict: did it run, and what did it find."""

    stage: str
    status: str
    detail: str = ""
    findings: list[Finding] = dc_field(default_factory=list)

    def __post_init__(self) -> None:
        if self.stage not in STAGES:
            raise ValueError(f"unknown stage {self.stage!r}")
        if self.status not in STATUSES:
            raise ValueError(f"unknown status {self.status!r}")

    def to_json(self) -> dict[str, Any]:
        return {
            "stage": self.stage,
            "status": self.status,
            "detail": self.detail,
            "findings": [finding.to_json() for finding in self.findings],
        }


@dataclass
class ProbeReport:
    """A single bounded run's result, per stage, with its budget made visible.

    `ok` is "nothing the probe could not explain", not "everything was verified": a stage that was
    `skipped` or `unavailable` is visible and is not a pass, and an error-severity finding makes the
    report fail even when some stages passed.
    """

    target: str
    budget_seconds: float = 90.0
    used_seconds: float = 0.0
    stages: list[StageResult] = dc_field(default_factory=list)
    export: str | None = None

    def add(self, result: StageResult) -> StageResult:
        self.stages.append(result)
        return result

    def findings(self) -> list[Finding]:
        return [finding for stage in self.stages for finding in stage.findings]

    def errors(self) -> list[Finding]:
        return [finding for finding in self.findings() if finding.severity == "error"]

    def stage(self, name: str) -> StageResult | None:
        return next((result for result in self.stages if result.stage == name), None)

    @property
    def ok(self) -> bool:
        return not self.errors()

    def to_json(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "ok": self.ok,
            "budget": {"seconds": self.budget_seconds, "used": round(self.used_seconds, 3)},
            "export": self.export,
            "stages": [stage.to_json() for stage in self.stages],
            "findings": [finding.to_json() for finding in self.findings()],
        }


class DiagnosticError(ValueError):
    """A failure that carries its findings to the caller.

    Subclasses `ValueError` on purpose: every caller that already catches a run's `ValueError`
    (`integration._failure_code`, the door scripts) keeps working unchanged, so the exit-code meaning
    is preserved — only the findings are new. The `error` event keeps its old `code` for the same
    reason: `RUN_FAILED` is in the caller's enum, and the *specific* reason travels as a finding.
    """

    def __init__(self, message: str, findings: Iterable[Finding] = ()) -> None:
        super().__init__(message)
        self.findings: list[Finding] = list(findings)


# --- classifying what a run already produced -------------------------------------------------- #

def classify_cards(cards: list[dict[str, Any]], *, target_kind: str | None = None,
                   url: str | None = None) -> list[Finding]:
    """Findings for one listing's card set: empty, id-less, and repeated ids.

    Called where the cards are produced (`runner.run`'s review path and `probe`), because a rule set
    that slipped past the Builder must not pass silently here — the plan's §2 row "验收只覆盖局部".
    """
    findings: list[Finding] = []
    if not cards:
        findings.append(listing_rows_empty(kind=target_kind, url=url))
        return findings
    id_less = sum(1 for card in cards if not card.get("source_id"))
    if id_less:
        findings.append(source_id_empty(where="card(s)", count=id_less))
    repeated = _repeated([str(card.get("source_id")) for card in cards if card.get("source_id")])
    if repeated:
        findings.append(source_id_duplicated(repeated, stage="listing", target_kind=target_kind))
    return findings


def classify_records(records: list[dict[str, Any]], *,
                     target_kind: str | None = None,
                     dropped: list[tuple[str, list[str]]] | None = None,
                     expect_cover: bool = False) -> list[Finding]:
    """Findings for the records a download run produced.

    `dropped` is the works that were read and then thrown away for a missing required field, as
    `(source_id, missing_fields)` pairs — the exact state the plan's first batch exists to make
    visible, since those works leave the export with nothing else to say about them.
    """
    findings: list[Finding] = []
    for _source_id, missing in dropped or []:
        if "source_id" in missing:
            findings.append(source_id_empty(where="work(s)", count=1, stage="work"))
        others = [name for name in missing if name != "source_id"]
        if others:
            findings.append(work_field_empty(others[0],
                                             count=1,
                                             severity="error"))
    ids = [str(record.get("source_id")) for record in records if record.get("source_id")]
    repeated = _repeated(ids)
    if repeated:
        findings.append(source_id_duplicated(repeated, stage="work", target_kind=target_kind))
    title_less = [str(record.get("source_id")) for record in records if not record.get("title")]
    if title_less:
        findings.append(work_field_empty("title", ids=title_less, severity="warning"))
    if expect_cover:
        uncovered = [str(record.get("source_id")) for record in records
                     if not (record.get("cover") or {}).get("url")]
        if uncovered:
            findings.append(cover_url_empty(ids=uncovered, expected=True))
    return findings


def _repeated(values: list[str]) -> list[str]:
    """Values that appear more than once, first-seen order, de-duplicated."""
    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return [value for value, count in counts.items() if count > 1]


def blocking_findings(findings: Iterable[Finding]) -> list[Finding]:
    """The findings that should stop an install, as opposed to those that are reported only.

    An **acquisition** failure is excluded on purpose, and the plan's own risk table is the reason:
    an occasional network failure is not a broken rule, and refusing to install over one would make
    a transient error look like a data fault. What blocks is a fault in the *data* — a listing that
    read no card, a work missing a required field, a repeated id — because those are the states that
    install cleanly and then import nothing.
    """
    return [finding for finding in findings
            if finding.severity == "error" and finding.stage != "acquisition"]
