"""One bounded runtime check, run before an adapter is trusted (plan §5-A).

The gap this closes is the plan's own words: *the Builder verifies against the markup it already
recorded, and the runtime that will actually be used never runs.* A draft can therefore round-trip
perfectly and still read **nothing** live — the acquisition differs (a rendered listing against an
HTTP shell), the identity differs (a card id against a work id), or a required field simply is not
on the page the runtime fetches. This module runs the runtime once, on a small budget, and says per
stage what happened.

The budget is the plan's initial shape (§5-A): one listing page, one work, one cover; 45s for a page
and 90s for the whole probe, frozen up front and reported as used. Every stage is wrapped so its
failure is a `StageResult`, never an exception out of the probe — a probe exists to *report*, and a
probe that crashes reports nothing.

Runtime calls and the single-cover fetch run in disposable processes. The import stage invokes
T³'s pure TypeScript parser when available; it never opens the library or commits an entry.
"""

from __future__ import annotations

import tempfile
import shutil
import subprocess
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator
from types import SimpleNamespace

from . import diagnostics as diag
from . import registry
from . import probe_process
from .registry import RegistryError
from .runner import RunOptions


@dataclass
class ProbeRequest:
    """What to probe, and the small budget it may spend doing it."""

    url: str
    site_key: str | None = None
    target_kind: str | None = None
    # 'work' probes one work page; 'listing' probes one listing page and then one work from it.
    building: str = "work"
    limit: int = 1
    check_cover: bool = True
    expect_cover: bool = False
    page_seconds: float = 45.0
    total_seconds: float = 90.0
    # A scratch root the probe writes its export under; a caller that omits it gets a temporary
    # directory the probe removes. Never the real export tree: a probe must not touch what a person
    # imports (plan §1).
    project_root: Path | None = None
    # A scratch *home*, so the probe can read a draft the Builder has not installed yet. When set,
    # `SITEPROBE_HOME` points here for the probe's duration and the adapter cache is dropped and
    # restored around it — the same mechanism the tests already use to read a fixture home.
    home: Path | None = None


Run = Callable[[RunOptions], Any]
Progress = Callable[[str], None]


def runtime_probe(request: ProbeRequest, *, run: Run | None = None,
                  progress: Progress | None = None) -> diag.ProbeReport:
    """Run the runtime once, bounded, and report each stage.

    `run` is the runtime entry to call and defaults to `runner.run`; a test passes a stub so the
    classification and the report can be checked without a network, and so this module's own
    behaviour is measured rather than the site's.
    """
    report = diag.ProbeReport(target=request.target_kind or request.building,
                              budget_seconds=request.total_seconds)
    budget = diag.Budget(request.total_seconds)

    def bounded_run(options: RunOptions) -> Any:
        payload = {"raw_input": options.raw_input, "site_key": options.site_key,
                   "target_kind": options.target_kind, "review": options.review,
                   "limit": options.limit, "with_media": False, "max_pages": 1,
                   "project_root": str(options.project_root.resolve())}
        answer = probe_process.worker("run", payload,
                                      seconds=min(request.page_seconds, budget.remaining()))
        findings = [diag.Finding(**finding) for finding in answer.get("findings", [])]
        if "error" in answer:
            raise diag.DiagnosticError(answer["error"], findings)
        return SimpleNamespace(**{**answer, "findings": findings})

    runner: Run = run or bounded_run
    with _home_override(request.home):
        with _workdir(request.project_root) as root:
            if request.building == "listing":
                _probe_listing(request, report, budget, runner, root, progress)
            else:
                _probe_work(request, report, budget, runner, root, progress, url=request.url,
                            primary=True)
    report.used_seconds = budget.used()
    return report


@contextmanager
def _home_override(home: Path | None) -> Iterator[None]:
    """Read adapters from a scratch home for the duration, then put the real one back.

    `adapter_root()` reads `SITEPROBE_HOME` on every call, but the key -> adapter map is cached for
    the life of the process (`registry.registry`), so both have to move together or the probe would
    read the previous home's sites. This is the same pair the tests use; nothing in a normal run sets
    `home`, and the environment is restored exactly as it was found.
    """
    if home is None:
        yield
        return
    import os

    previous = os.environ.get("SITEPROBE_HOME")
    os.environ["SITEPROBE_HOME"] = str(home)
    registry.forget_adapters()
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("SITEPROBE_HOME", None)
        else:
            os.environ["SITEPROBE_HOME"] = previous
        registry.forget_adapters()


@contextmanager
def _workdir(root: Path | None) -> Iterator[Path]:
    """The scratch root a probe writes into: the caller's, or a temporary one it owns and removes."""
    if root is not None:
        yield Path(root)
        return
    with tempfile.TemporaryDirectory(prefix="siteprobe-probe-") as name:
        yield Path(name)


def _race(budget: diag.Budget, report: diag.ProbeReport, stage: str) -> bool:
    """Whether the budget is already spent, recording the reason when it is."""
    if not budget.expired():
        return False
    report.add(diag.StageResult(stage, "unavailable", detail="the probe's time budget was spent",
                                findings=[diag.budget_exceeded(stage=stage, seconds=budget.seconds)]))
    return True


def _options(request: ProbeRequest, root: Path, *, review: bool, url: str,
             progress: Progress | None) -> RunOptions:
    return RunOptions(
        raw_input=url,
        site_key=request.site_key,
        target_kind=None if request.building == "listing" and not review else request.target_kind,
        review=review,
        limit=request.limit,
        # Cover fetching is a separate bounded stage; do not fetch previews or all review covers.
        with_media=False,
        max_pages=1,
        project_root=root,
        progress=progress or (lambda message: None),
    )


def _probe_listing(request: ProbeRequest, report: diag.ProbeReport, budget: diag.Budget,
                   runner: Run, root: Path, progress: Progress | None) -> None:
    if _race(budget, report, "acquisition"):
        return
    try:
        result = runner(_options(request, root, review=True, url=request.url, progress=progress))
    except subprocess.TimeoutExpired:
        report.add(diag.StageResult("acquisition", "unavailable", findings=[
            diag.budget_exceeded(stage="acquisition", seconds=min(request.page_seconds,
                                                                 request.total_seconds))]))
        return
    except diag.DiagnosticError as error:
        acquisition_faults = [finding for finding in error.findings if finding.stage == "acquisition"]
        report.add(diag.StageResult("acquisition", "failed" if acquisition_faults else "passed",
                                    detail=str(error) if acquisition_faults else "the listing page was read",
                                    findings=acquisition_faults))
        report.add(diag.StageResult("listing", "unavailable" if acquisition_faults else "failed",
                                    detail=str(error), findings=[finding for finding in error.findings
                                                                if finding.stage != "acquisition"]))
        _probe_import(report, None, budget)
        return
    except (RegistryError, ValueError) as error:
        report.add(diag.StageResult("acquisition", "failed", detail=str(error),
                                    findings=[diag.acquisition_failed(kind=request.target_kind,
                                                                       url=request.url)]))
        report.add(diag.StageResult("listing", "unavailable",
                                    detail="no page was acquired to read cards from"))
        _probe_import(report, None, budget)
        return

    report.add(diag.StageResult("acquisition", "passed", detail="the listing page was read"))
    cards = list(getattr(result, "cards", []) or [])
    listing_findings = [finding for finding in result.findings if finding.stage == "listing"]
    report.add(diag.StageResult("listing", "passed" if cards and not diag.blocking_findings(listing_findings)
                                else "failed",
                                detail=f"{len(cards)} card(s) read", findings=listing_findings))
    if diag.blocking_findings(listing_findings):
        _probe_import(report, None, budget)
        return

    work_url = _first_work_url(cards)
    if work_url is None:
        # The plan's step 5: a listing with no work rule, or no card that carries an address, leaves
        # the work stage *unverified*, and that is a visible state, not a pass.
        report.add(diag.StageResult("work", "skipped",
                                    detail="no card carried a detail address to read as a work"))
        _probe_import(report, None, budget)
        return
    _probe_work(request, report, budget, runner, root, progress, url=work_url, primary=False)


def _probe_work(request: ProbeRequest, report: diag.ProbeReport, budget: diag.Budget,
                runner: Run, root: Path, progress: Progress | None, *, url: str,
                primary: bool) -> None:
    """Read one work page. `primary` is the direct work build, where this run *is* acquisition.

    When a listing probe calls it, acquisition already happened and this is only the work stage; a
    work page that will not read is then "not verified", not a second acquisition failure.
    """
    if _race(budget, report, "acquisition" if primary else "work"):
        return
    try:
        result = runner(_options(request, root, review=False, url=url, progress=progress))
    except subprocess.TimeoutExpired:
        stage = "acquisition" if primary else "work"
        report.add(diag.StageResult(stage, "unavailable", findings=[
            diag.budget_exceeded(stage=stage, seconds=min(request.page_seconds, request.total_seconds))]))
        return
    except diag.DiagnosticError as error:
        report.add(diag.StageResult("acquisition" if primary else "work", "failed",
                                    detail=str(error), findings=list(error.findings)))
        _probe_import(report, None, budget)
        return
    except (RegistryError, ValueError) as error:
        if primary:
            report.add(diag.StageResult("acquisition", "failed", detail=str(error), findings=[
                diag.acquisition_failed(kind=request.target_kind, url=url)]))
        else:
            # The commonest one here, and the plan names it: a listing adapter with no work rule
            # cannot read a work page, so this is "not verified", not "broken".
            report.add(diag.StageResult("work", "unavailable", detail=str(error)))
        _probe_import(report, None, budget)
        return

    if primary:
        report.add(diag.StageResult("acquisition", "passed", detail="the work page was read"))
    records = list(getattr(result, "records", []) or [])
    work_findings = [finding for finding in result.findings if finding.stage == "work"]
    report.add(diag.StageResult("work", "passed" if records else "failed",
                                detail=f"{len(records)} work(s) read", findings=work_findings))
    _probe_cover(request, report, records, Path(result.listing_dir), budget)
    export = Path(result.listing_dir) / "metadata.json" if records else None
    _probe_import(report, export, budget)


def _probe_cover(request: ProbeRequest, report: diag.ProbeReport,
                 records: list[dict[str, Any]], listing: Path, budget: diag.Budget) -> None:
    if not request.check_cover:
        report.add(diag.StageResult("media", "skipped", detail="no cover was checked"))
        return
    if not records:
        report.add(diag.StageResult("media", "skipped", detail="no work was read to look for a cover"))
        return
    cover = (records[0].get("cover") or {}).get("url")
    if cover:
        if _race(budget, report, "media"):
            return
        try:
            answer = probe_process.worker("cover", {"record": records[0], "listing": str(listing)},
                                          seconds=min(request.page_seconds, budget.remaining()))
            if not answer.get("ok"):
                raise ValueError("the response did not yield a supported image")
            records[0]["cover"] = answer["cover"]
            report.add(diag.StageResult("media", "passed", detail="one cover image was fetched and verified"))
        except subprocess.TimeoutExpired:
            report.add(diag.StageResult("media", "unavailable", findings=[
                diag.budget_exceeded(stage="media", seconds=request.page_seconds)]))
        except (ValueError, OSError) as error:
            report.add(diag.StageResult("media", "failed", findings=[
                diag.cover_fetch_failed(detail=str(error))]))
    else:
        finding = diag.cover_url_empty(ids=[str(records[0].get("source_id") or "")],
                                       expected=request.expect_cover)
        if request.expect_cover:
            finding.severity = "error"
        report.add(diag.StageResult("media", "failed" if request.expect_cover else "skipped",
                                    findings=[finding]))


def _probe_import(report: diag.ProbeReport, export: Path | None, budget: diag.Budget) -> None:
    if export is None:
        report.add(diag.StageResult("import", "unavailable", detail="no export was produced to parse"))
        return
    report.export = str(export)
    if _race(budget, report, "import"):
        return
    repository = Path(__file__).resolve().parents[3]
    cli = repository / "apps/server/src/import/site-probe-check-cli.ts"
    tsx = repository / "apps/server/node_modules/tsx/dist/cli.mjs"
    node = shutil.which("node")
    if not node or not cli.is_file() or not tsx.is_file():
        report.add(diag.StageResult("import", "unavailable", detail="T³ parser runtime is not installed"))
        return
    try:
        answer = probe_process.execute([node, str(tsx), str(cli), str(export.resolve())],
                                       seconds=budget.remaining())
        report.add(diag.StageResult("import", "passed", detail=f"{answer['entries']} entry(s) parsed by T³"))
    except subprocess.TimeoutExpired:
        report.add(diag.StageResult("import", "unavailable", findings=[
            diag.budget_exceeded(stage="import", seconds=budget.seconds)]))
    except (ValueError, OSError) as error:
        report.add(diag.StageResult("import", "failed", findings=[
            diag.import_contract_rejected(detail=str(error)[:1500])]))


def _first_work_url(cards: list[dict[str, Any]]) -> str | None:
    """The first card that carries an address naming the work."""
    for card in cards:
        for key in ("detail_url", "url"):
            value = card.get(key)
            if isinstance(value, str) and value.startswith(("http://", "https://")):
                return value
    return None
