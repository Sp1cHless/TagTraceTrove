"""The machine contract: one JSON object per line, on stdout, and nothing else.

T³ drives this file. The rule it exists to keep is the architecture's: **the Core never names a
site** (guidance §33), so a UI that offers "which site?" and "which kind?" has to be told by the
registry rather than by a list someone maintains in TypeScript. The human entry points
(`probe.py`, `pick.py`, …) print prose for a person; this one answers four questions a program
asks, and every answer is a JSON line:

    integration sites                       -> every site, what it reads, which layer it came from
    integration resolve <input> [--site K]  -> who claims this input, as what, with which ref
    integration run <input> [--review] …    -> acquire/scan, reporting progress as it goes
    integration selection <file.json> …     -> download the works a review selection names

Why a line per event rather than one document at the end: a scan of a few hundred works takes
minutes, and a caller that can only read the final document cannot show anything until then, nor
tell a hung run from a slow one. stdout is therefore **only** these lines; every human sentence the
runner produces is re-emitted as a `progress` event, and a traceback goes to stderr.

Exit codes, so a caller can branch without reading a sentence:

    0   the command did what it was asked
    2   the input was wrong, or no site claims it, or two do (the answer is "ask the person")
    1   the work failed (a site misbehaved, the network did, a record could not be read)

Every failure also arrives as an `error` event with a `code` from `ERROR_CODES`, because a non-zero
exit alone cannot say *what* went wrong — and a caller that has to match on the text of a message
is a caller that breaks the next time the message is worded better.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any, Callable, Iterable

from . import registry
from .registry import RegistryError
from .runner import PROJECT_ROOT, RunOptions
from .runner import resolve as resolve_run
from .runner import run as run_once
from .selection import run_selection

Emit = Callable[[dict[str, Any]], None]

# The input/matching class: the caller asked for something that cannot be answered, and the
# answer is a question back to the person rather than a retry.
INPUT_CODES = {"NO_MATCH", "INVALID_INPUT", "AMBIGUOUS", "UNKNOWN_SITE"}

ERROR_CODES = INPUT_CODES | {
    "NO_MODULE",      # the site exists but ships no such step
    "NO_REVIEW",      # the site offers neither a review nor a card listing
    "NOTHING_LISTED",  # the listing resolved but named no work
    "RUN_FAILED",     # the run itself failed
    "INTERNAL",       # a fault in this tool
}


def _source_name(directory: Path) -> str:
    """Which adapter layer a template came from, read off the directory it lives in."""
    name = directory.parent.name
    return name if name in registry.SOURCES else "unknown"


README_NAME = "README.md"


def emit_to_stdout(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def sites_event() -> dict[str, Any]:
    """Every site on disk, with everything a menu needs — and nothing site-specific.

    A key can carry two adapters (a written one and a rule set learned for one of its pages), so
    the targets are the **union** over both files. That union is the honest answer to "what can T³
    offer for this site": resolution picks by declared target and only then by layer, so a menu built
    from one file alone hides capabilities that work — measured on this machine, where the learned
    `18comic.vip` file reads searches while the written one reads albums, favorites and searches.

    Each target names the layer that **answers** it, not the first one that declares it: a rule set
    with no work fields declares the same kind and would otherwise name itself while every address
    goes to the adapter beside it.
    """
    sites: list[dict[str, Any]] = []
    for key in registry.site_keys():
        templates = registry.templates_for(key)
        targets: dict[str, dict[str, Any]] = {}
        for template in templates:
            for kind, rule in template.targets.items():
                existing = targets.get(kind)
                if existing is None:
                    answering = registry.adapter_for_kind(templates, kind)
                    winner = answering.targets[kind]
                    targets[kind] = {
                        "kind": kind,
                        "label": winner.label,
                        "single": winner.single,
                        "accepts_name": winner.accepts_name,
                        "source": _source_name(answering.directory),
                    }
                    continue
                # `accepts_name` is the union, not the winner's: a keyword one of the site's
                # adapters can turn into a search URL is a capability of the site, and a menu that
                # hid it would show a text box the resolver then refused (measured on 18comic,
                # whose learned file declares its search without it while the written adapter
                # beside it accepts a name). The label and the source stay the winner's.
                existing["accepts_name"] = bool(existing["accepts_name"] or rule.accepts_name)
        hosts: list[str] = []
        for template in templates:
            for host in template.hosts:
                if host not in hosts:
                    hosts.append(host)
        identity = registry.site_identity(key)
        sites.append({
            "key": key,
            "display_name": identity["display_name"],
            "export_group": identity["export_group"],
            "hosts": hosts,
            "targets": list(targets.values()),
            "adapters": [
                {"source": _source_name(template.directory),
                 "reads": list(template.targets),
                 # Whether the folder explains itself. The readme is the site's own words about
                 # what it covers, so the menu can offer it without T³ reading the tool's tree.
                 "readme": README_NAME in {item.name for item in template.directory.iterdir()
                                           if item.is_file()}}
                for template in templates
            ],
        })
    return {"event": "sites", "home": str(registry.adapter_root()), "sites": sites}


def readme_event(site_key: str) -> dict[str, Any]:
    """One site's own description of itself, as markdown.

    A separate command rather than a field on `sites`: the menu needs to know a readme *exists*,
    and the text is only wanted when somebody opens it — and the tool's own tree stays something
    only the tool reads.
    """
    if site_key not in registry.site_keys():
        raise RegistryError(f"unknown site {site_key!r}", "UNKNOWN_SITE")
    for template in registry.templates_for(site_key):
        path = template.directory / README_NAME
        if not path.is_file():
            continue
        return {"event": "readme", "site": template.key,
                "source": _source_name(template.directory),
                "text": path.read_text(encoding="utf-8")}
    # A site with no readme is not an error: the menu asked whether there is one, and there is not.
    return {"event": "readme", "site": site_key, "source": None, "text": ""}


def resolve_event(raw: str, site_key: str | None = None,
                  kind: str | None = None) -> dict[str, Any]:
    """Who claims this input, and as what.

    A miss is an answer, not an error: `matched: false` with a reason is what the clipboard flow
    needs ("is there a tool for this URL?"), so this returns a normal event and lets `main` decide
    the exit code. Resolution is `runner.resolve`, the same call a run makes, so what this reports
    is what a run would actually do — including an explicit `--site`/`--kind` override.
    """
    options = RunOptions(raw_input=raw, site_key=site_key, target_kind=kind)
    try:
        template, target_kind, ref = resolve_run(options)
    except (RegistryError, ValueError) as error:
        code = error.code if isinstance(error, RegistryError) else "RUN_FAILED"
        return {
            "event": "resolve",
            "matched": False,
            "input": raw,
            "reason": code,
            "detail": str(error),
        }
    rule = template.targets[target_kind]
    return {
        "event": "resolve",
        "matched": True,
        "input": raw,
        "site": template.key,
        "display_name": template.display_name,
        "export_group": template.export_group,
        "source": _source_name(template.directory),
        "kind": target_kind,
        "label": rule.label,
        "single": rule.single,
        "ref": ref,
    }


def _result_event(command: str, template: Any, kind: str, ref: str, listing: Path,
                  *, works: int | None, origin: dict[str, Any] | None,
                  media: dict[str, int] | None, warnings: Iterable[str],
                  review_html: Path | None = None) -> dict[str, Any]:
    """The one event a caller waits for: where the export landed and what is in it.

    `export` is the path T³ hands to its own importer (`loadSiteProbeExport`), and it is `None`
    for a review run on purpose — that run's product is a page for a person, and its export
    appears only after a selection is downloaded. `origin` is what the library's update cursor
    reads (migration 021), so it travels with the answer instead of having to be dug back out of
    the manifest.
    """
    return {
        "event": "result",
        "command": command,
        "site": template.key,
        "kind": kind,
        "ref": ref,
        "works": works,
        "listing": str(listing),
        "export": str(listing / "metadata.json") if review_html is None else None,
        "review_html": str(review_html) if review_html is not None else None,
        "origin": origin,
        "media": media or {},
        "warnings": list(warnings),
    }


def run_events(raw: str, *, site_key: str | None = None, kind: str | None = None,
               review: bool = False, limit: int | None = None, refresh: bool = False,
               name: str | None = None, with_media: bool = True,
               project_root: Path = PROJECT_ROOT, emit: Emit = emit_to_stdout) -> int:
    """Acquire or scan for one input, reporting as it goes. Returns the exit code."""
    options = RunOptions(
        raw_input=raw, site_key=site_key, target_kind=kind, review=review, limit=limit,
        refresh=refresh, name=name, with_media=with_media, project_root=project_root,
        progress=lambda message: emit({"event": "progress", "message": message}),
    )
    try:
        result = run_once(options)
    except (RegistryError, ValueError) as error:
        return _report_failure(error, emit)
    if result.review_html is not None:
        review = {
            "event": "review",
            "site": result.template.key,
            "kind": result.target_kind,
            "ref": result.target_ref,
            "listing": str(result.listing_dir),
            "review_html": str(result.review_html),
            "summary": result.review_summary,
            "warnings": result.warnings,
        }
        # How many the page holds, under one name. A site's own review summarises in its own
        # vocabulary (hitomi says `total_items`), and a caller asking "did this find one work or
        # four hundred?" should not have to know that.
        count = (result.review_summary or {}).get("count")
        if isinstance(count, int):
            review["count"] = count
        emit(review)
    emit(_result_event(
        "run", result.template, result.target_kind, result.target_ref, result.listing_dir,
        works=None if result.review_html is not None else result.record_count,
        origin=result.origin, media=result.media_stats, warnings=result.warnings,
        review_html=result.review_html,
    ))
    return 0


def selection_events(paths: list[Path], *, project_root: Path = PROJECT_ROOT, workers: int = 4,
                     emit: Emit = emit_to_stdout) -> int:
    """Download the works each selection names, one result event per file.

    A missing file is checked here rather than left to `run_selection`'s `ValueError`, because the
    two are different answers for a caller: a file that is not there is the caller's input being
    wrong (exit 2, ask again), while a listing that cannot be re-read is the crawl failing (exit
    1, show the reason).
    """
    failed = 0
    for path in paths:
        if not path.is_file():
            emit({"event": "error", "command": "selection", "code": "INVALID_INPUT",
                  "message": f"selection file not found: {path}", "selection": str(path)})
            failed = 2
            continue
        try:
            listing = Path(run_selection(path, project_root=project_root, workers=workers,
                                         progress=lambda message: emit(
                                             {"event": "progress", "message": message})))
        except (RegistryError, ValueError) as error:
            code = _failure_code(error)
            emit({"event": "error", "command": "selection", "code": code,
                  "message": str(error), "selection": str(path)})
            failed = max(failed, 2 if code in INPUT_CODES else 1)
            continue
        manifest = _read_manifest(listing)
        origin = manifest.get("origin")
        emit({
            "event": "result",
            "command": "selection",
            "selection": str(path),
            "site": str(manifest.get("source_site") or ""),
            "kind": str(origin.get("kind") or "") if isinstance(origin, dict) else "",
            "ref": str(origin.get("ref") or "") if isinstance(origin, dict) else "",
            "works": _manifest_count(manifest),
            "listing": str(listing),
            "export": str(listing / "metadata.json"),
            "review_html": None,
            "origin": origin if isinstance(origin, dict) else None,
            "media": {},
            "warnings": [],
        })
    return failed


def _read_manifest(listing: Path) -> dict[str, Any]:
    """The listing's manifest, or an empty document when it cannot be read.

    Read for the result event only, so a manifest that is unreadable is reported by its absence
    rather than by failing a download that has already succeeded.
    """
    try:
        document = json.loads((listing / "metadata.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return document if isinstance(document, dict) else {}


def _manifest_count(manifest: dict[str, Any]) -> int | None:
    items = manifest.get("items")
    if isinstance(items, list):
        return len(items)
    count = manifest.get("item_count")
    return count if isinstance(count, int) else None


def _failure_code(error: BaseException) -> str:
    if isinstance(error, RegistryError):
        return error.code
    if isinstance(error, ValueError):
        return "RUN_FAILED"
    return "INTERNAL"


def _report_failure(error: BaseException, emit: Emit, *, command: str = "run") -> int:
    """Emit the failure as an event and answer with the exit code for its class."""
    code = _failure_code(error)
    if code == "INTERNAL":
        traceback.print_exc(file=sys.stderr)
    emit({"event": "error", "command": command, "code": code,
          "message": f"{type(error).__name__}: {error}" if code == "INTERNAL" else str(error)})
    return 2 if code in INPUT_CODES else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="integration",
        description="The JSON contract T³ drives: sites, readme, resolve, run, selection.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("sites", help="every site, what it reads, and which layer it came from")

    readme = commands.add_parser("readme", help="one site's own description of itself")
    readme.add_argument("--site", dest="site_key", required=True)

    resolve = commands.add_parser("resolve", help="who claims this input, and as what")
    resolve.add_argument("input")
    resolve.add_argument("--site", dest="site_key")
    resolve.add_argument("--kind")

    run = commands.add_parser("run", help="acquire or scan for one input")
    run.add_argument("input")
    run.add_argument("--site", dest="site_key")
    run.add_argument("--kind")
    run.add_argument("--review", action="store_true",
                     help="scan for review (write the review page) instead of downloading")
    run.add_argument("--limit", type=int)
    run.add_argument("--refresh", action="store_true")
    run.add_argument("--name")
    run.add_argument("--no-media", action="store_true")
    run.add_argument("--project-root", type=Path, default=PROJECT_ROOT)

    selection = commands.add_parser("selection", help="download what a selection names")
    selection.add_argument("selection", nargs="+", type=Path)
    selection.add_argument("--workers", type=int, default=4)
    selection.add_argument("--project-root", type=Path, default=PROJECT_ROOT)

    args = parser.parse_args(argv)

    if args.command == "sites":
        emit_to_stdout(sites_event())
        return 0
    if args.command == "readme":
        try:
            emit_to_stdout(readme_event(args.site_key))
        except RegistryError as error:
            emit_to_stdout({"event": "error", "command": "readme", "code": error.code,
                            "message": str(error)})
            return 2
        return 0
    if args.command == "resolve":
        if not args.input.strip():
            emit_to_stdout({"event": "resolve", "matched": False, "input": args.input,
                            "reason": "INVALID_INPUT", "detail": "no input given"})
            return 2
        event = resolve_event(args.input, site_key=args.site_key, kind=args.kind)
        emit_to_stdout(event)
        if event["matched"]:
            return 0
        return 2 if event["reason"] in INPUT_CODES else 1
    if args.command == "run":
        if not args.input.strip():
            emit_to_stdout({"event": "error", "command": "run", "code": "INVALID_INPUT",
                            "message": "no input given"})
            return 2
        return run_events(
            args.input, site_key=args.site_key, kind=args.kind, review=args.review,
            limit=args.limit, refresh=args.refresh, name=args.name,
            with_media=not args.no_media, project_root=args.project_root,
        )
    return selection_events(args.selection, project_root=args.project_root,
                            workers=args.workers)


if __name__ == "__main__":
    raise SystemExit(main())
