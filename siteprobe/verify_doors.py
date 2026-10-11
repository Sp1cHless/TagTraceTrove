"""Open every door this tool has, and report what happened at each one.

The whole test suite imports library modules; a user opens batch files. Every fault found by
hand after the adapter layout changed lived in a door, and not one of them was reachable from a
unit test:

  * `-m tool.comic18.repair_scramble` named a directory the layout had removed, so that batch
    file could only fail — the suite never runs a batch file;
  * `profile` was read inside a function that was never given it, so one entry point died with
    `NameError` the moment it was used — the static check that exists for this class of fault
    called the name "defined somewhere in the module";
  * `uv sync` could not build the package at all, and every batch file starts with it.

So this opens the doors the way a user does: through the project interpreter, with an input that
fails fast, and it reports the outcome per door. A crash marker in the output is a failure, and a
door that does not exit within its budget is a failure. Everything else is recorded, not judged.

    uv run --extra dev python verify_doors.py           # the fast pass, offline
    uv run --extra dev python verify_doors.py --slow    # also the two browser builders

The static half of this file (a batch file's invocations, and what is wrong with them) is the
half `tests/test_site_contract.py` runs on every test run; the dynamic half is what a person
runs after a layout change, because it needs a working interpreter and takes a minute.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INTERPRETER = ROOT / ".venv" / "Scripts" / "python.exe"

# What a traceback or a failed import looks like. These are the shapes a door fails in; a door
# that prints a plain error message about its input is working, and is left alone.
CRASH_MARKERS = (
    "Traceback (most recent call last)",
    "ModuleNotFoundError",
    "UnboundLocalError",
    "No module named",
    "NameError:",
    "AttributeError:",
    "IndentationError",
    "SyntaxError",
)


def tokens(text: str) -> list[str]:
    """One command line as its arguments, with the quoting a batch file uses removed."""
    return [token.strip('"') for token in re.findall(r'"[^"]*"|\S+', text)]


def invocations(bat: Path) -> list[list[str]]:
    """The command each `.bat` hands to the project interpreter.

    Anchored to the start of the line, because the same quoted interpreter also appears in the
    `if not exist ".venv\\Scripts\\python.exe"` guard above every call.
    """
    calls: list[list[str]] = []
    for line in bat.read_text(encoding="utf-8").splitlines():
        found = re.match(r'\s*"\.venv\\Scripts\\python\.exe"\s+(\S.*)', line)
        if found:
            calls.append(tokens(found.group(1)))
    return calls


def bat_problems(bats: list[Path]) -> tuple[list[str], int]:
    """What is wrong with these batch files, and how many invocations were read."""
    problems: list[str] = []
    checked = 0
    for bat in bats:
        if "uv sync" not in bat.read_text(encoding="utf-8"):
            problems.append(f"{bat.name}: never prepares .venv, so a fresh clone cannot run it")
        for call in invocations(bat):
            checked += 1
            target = call[0]
            if target == "-m":
                module = call[1] if len(call) > 1 else ""
                located = ROOT.joinpath(*module.split(".")).with_suffix(".py")
                packaged = ROOT.joinpath(*module.split("."), "__init__.py")
                if not (located.is_file() or packaged.is_file()):
                    problems.append(
                        f"{bat.name}: `-m {module}` names nothing in this tree "
                        f"({located.relative_to(ROOT)} does not exist)"
                    )
            elif target.endswith(".py"):
                if not (ROOT / target).is_file():
                    problems.append(f"{bat.name}: {target} does not exist")
            else:
                problems.append(f"{bat.name}: cannot tell what `{target}` is")
    return problems, checked


def _collect(process: subprocess.Popen, sink, timeout: int, started: float) -> tuple[int | None, str]:
    """Wait for a process with a budget, without ever waiting on a pipe a grandchild holds.

    Output goes to a file rather than a pipe on purpose. A browser started by a builder keeps a
    copy of the pipe's write end, so a timed-out run whose output is piped never returns: the
    child is killed, and `communicate` still waits for a writer that is no longer ours. Measured
    here — one sweep hung with 23 Chrome processes alive. So the parent is killed on the budget
    and whatever it started is left for the person to close, which is what a Ctrl-C does anyway.
    """
    try:
        process.communicate(timeout=timeout)
        code = process.returncode
    except subprocess.TimeoutExpired:
        process.kill()
        code = None
    sink.seek(0)
    return code, sink.read()


def _expand(arguments: list[str], scratch: Path) -> list[str]:
    """Point a door's `{scope}` at the sweep's own throwaway directory."""
    return [argument.replace("{scope}", str(scratch)) for argument in arguments]


def run(arguments: list[str], timeout: int, stdin: str = "") -> tuple[int | None, str, float]:
    """Run one door. `None` as the code means it did not finish in time."""
    started = time.monotonic()
    with tempfile.TemporaryFile("w+", encoding="utf-8", errors="replace") as sink:
        process = subprocess.Popen(
            # `-u` because a door that is killed on its budget must still have said what it
            # reached: block-buffered output is lost with the process, which is how a builder that
            # really did reach its annotation step was reported as silent.
            [str(INTERPRETER), "-u", *arguments], cwd=str(ROOT), stdin=subprocess.PIPE,
            stdout=sink, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
        )
        code, output = _collect(process, sink, timeout, started)
    return code, output, time.monotonic() - started


def crashes(text: str) -> list[str]:
    return [marker for marker in CRASH_MARKERS if marker in text]


# Every door, with the argument that makes it fail fast. `--help` is not used: a door is opened
# with something it must handle, so that its own error path is exercised rather than argparse's.
DOORS: list[tuple[str, list[str], int, str]] = [
    ("通用单条链接 (show_link)", ["show_link.py", "http://127.0.0.1:1/"], 90, ""),
    ("提取单条链接 (probe)", ["probe.py", "http://127.0.0.1:1/"], 90, ""),
    ("提取作者或收藏夹 (pick, menu)", ["pick.py"], 60, "\n"),
    ("probe --list-sites", ["probe.py", "--list-sites"], 60, ""),
    # `--project-root {scope}` because this door *writes*: without it, applying the review rewrote
    # `export/<group>/tag_review.csv` and `taxonomy_dictionary.json` in the person's own tree on
    # every sweep (measured by their mtimes, not by reading the code). With it the same code path
    # runs — registry looked up, site walked, review applied — into a directory this sweep deletes.
    ("应用Tag审核 (tag_review)", ["tag_review.py", "--site", "hitomi.la",
                                 "--project-root", "{scope}"], 90, ""),
    ("下载selection (missing file)", ["selection.py", "no_such_selection.json"], 60, ""),
    ("修复缺失封面预览 (bad scope)", ["repair_media.py", "no_such_scope"], 60, ""),
    ("修复缺失封面预览 (real, dry run)", ["repair_media.py", "18comic_vip"], 180, ""),
    ("修复预览图 (bad scope)", ["run_site_step.py", "18comic.vip", "repair_scramble",
                                "--export-scope", "no_such_scope", "--export-root", "{scope}"],
     120, ""),
    ("修复预览图 (real, dry run)", ["run_site_step.py", "18comic.vip", "repair_scramble",
                                    "--export-scope", "18comic_vip", "--export-root", "{scope}"],
     180, ""),
    ("修复预览图 (missing step)", ["run_site_step.py", "18comic.vip", "no_such_step"], 60, ""),
    ("run_site_step (unknown site)", ["run_site_step.py", "no.such.site", "repair_scramble"], 60, ""),
]

# The two builders open a browser and serve a page, so they are the slow half. Their door input is
# an *unreachable* URL, and what used to happen was measured as a defect (2026-09-28): a silent
# minute, then an annotation page with zero candidates, which reads as stuck. The sound answer —
# and what "reached" means now — is the refusal, named within seconds.
REACHED = "the page could not be read"


# Doors whose **whole output is a contract**: T³ parses this stream, so "did not crash" is not the
# bar. A stray human sentence on stdout, a missing line, or the wrong exit code breaks a caller that
# never sees the message — which is exactly the class of failure this sweep exists for. Each entry is
# (label, argv, timeout, stdin, expected exit code, the event the last line must be).
JSON_DOORS: list[tuple[str, list[str], int, str, int, str]] = [
    ("integration sites (JSON)", ["integration.py", "sites"], 90, "", 0, "sites"),
    ("integration resolve (a hitomi work)", ["integration.py", "resolve",
                                             "https://hitomi.la/galleries/1234.html"], 60, "",
     0, "resolve"),
    ("integration resolve (nothing claims it)", ["integration.py", "resolve",
                                                 "https://example.com/x"], 60, "", 2, "resolve"),
    ("integration selection (missing file)", ["integration.py", "selection",
                                              "no_such_selection.json"], 60, "", 2, "error"),
]


def json_door_problem(code: int | None, output: str, expected_code: int,
                      expected_event: str) -> str | None:
    """Why this door's output is not the contract, or None when it is.

    Deliberately a pure function of the process result so that it can be fed a bad output by hand —
    a check that has never failed on purpose is only reporting zero (`tests/test_site_contract.py`
    does exactly that with a synthetic stream).
    """
    if code is None:
        return "no exit within budget"
    if code != expected_code:
        return f"exit {code}, expected {expected_code}"
    lines = [line for line in output.splitlines() if line.strip()]
    if not lines:
        return "said nothing on stdout"
    events = []
    for line in lines:
        try:
            document = json.loads(line)
        except json.JSONDecodeError as error:
            return f"stdout is not one JSON object per line ({error}); line: {line[:60]!r}"
        if not isinstance(document, dict) or "event" not in document:
            return f"a line has no 'event': {line[:60]!r}"
        events.append(document)
    if events[-1]["event"] != expected_event:
        return f"the last event is {events[-1]['event']!r}, expected {expected_event!r}"
    return None

SLOW_DOORS: list[tuple[str, list[str], int, str]] = [
    ("生成适配器 (build_adapter)", ["build_adapter.py", "--browser", "--install",
                                   "http://127.0.0.1:1/"], 150, "\n\n"),
    ("生成列表适配器 (build_listing)", ["build_listing.py", "--browser", "--install",
                                       "--kind=search", "http://127.0.0.1:1/"], 150, "\n\n"),
]

# Two batch files are not opened with empty input, and for different reasons. `应用Tag审核`
# applies every site's review CSV when no site is named, and a sweep that can be run at any moment
# must never write. `验收.bat` is this file's own door.
NOT_SWEPT = {
    "应用Tag审核.bat": "applies a filled review CSV when no site is named",
    "验收.bat": "this sweep itself",
}


def run_batch_file(bat: Path, timeout: int) -> tuple[int | None, str, float]:
    """Double-click a batch file with nothing to type, which is what a person does by hand."""
    started = time.monotonic()
    with tempfile.TemporaryFile("w+", encoding="utf-8", errors="replace") as sink:
        process = subprocess.Popen(
            ["cmd", "/c", bat.name], cwd=str(ROOT), stdin=subprocess.DEVNULL,
            stdout=sink, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
        )
        code, output = _collect(process, sink, timeout, started)
    return code, output, time.monotonic() - started


def report(label: str, code: int | None, output: str, seconds: float, reached: str = "") -> bool:
    """Print one door's outcome. True when the door is sound."""
    found = crashes(output)
    if reached and reached in output and not found:
        where = "exited" if code is not None else f"held open at {seconds:.0f}s, which is the point"
        print(f"  ok    {label:38} {where}; reached '{reached}'")
        return True
    if code is None:
        print(f"  FAIL  {label:38} no exit within budget ({seconds:.0f}s)")
        for line in output.strip().splitlines()[-4:]:
            print(f"          | {line}")
        return False
    if found:
        print(f"  FAIL  {label:38} exit {code}, {', '.join(found)}")
        for line in output.strip().splitlines()[-6:]:
            print(f"          | {line}")
        return False
    meaningful = [line for line in output.strip().splitlines()
                  if line.strip() and not line.startswith("Press any key")]
    if not meaningful:
        print(f"  FAIL  {label:38} exit {code} but said nothing; a door must explain itself")
        return False
    print(f"  ok    {label:38} exit {code:3}  {seconds:5.1f}s  {meaningful[-1].strip()[:64]}")
    return True


def sessions_before() -> set[Path]:
    """The session directories already in the home, so a sweep's own are recognised."""
    try:
        from src.generic.registry import adapter_root

        root = adapter_root() / "sessions"
    except Exception:  # noqa: BLE001 - a sweep must not fail on the home being unreadable
        return set()
    return set(root.glob("*")) if root.is_dir() else set()


def drop_new_sessions(before: set[Path]) -> list[str]:
    """Do not delete sessions without a trustworthy per-run ownership marker.

    Creation after a sweep starts does not prove ownership: another Builder process
    may create a session concurrently. Leave sessions for explicit user cleanup.
    """
    return []


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    slow = "--slow" in argv
    existing_sessions = sessions_before()

    bats = sorted(ROOT.glob("*.bat"))
    print(f"batch files under {ROOT.name}: {len(bats)}")
    problems, checked = bat_problems(bats)
    for entry in problems:
        print(f"  FAIL  {entry}")
    print(f"  {checked} interpreter invocation(s) audited, {len(problems)} referencing "
          f"something that does not exist")

    if not INTERPRETER.is_file():
        print(f"\nthe project interpreter is missing: {INTERPRETER}")
        print("run any batch file once, or `uv sync --extra browser --extra media --extra dev`")
        return 1

    # One throwaway tree for the doors that write: created here, deleted at the end, and named
    # in a door's arguments as `{scope}` so a door can be pointed at it without knowing
    # this exists.
    scratch = Path(tempfile.mkdtemp(prefix="t3-door-scope-"))
    print(f"\nopening {len(DOORS)} door(s) through {INTERPRETER.relative_to(ROOT)}")
    sound = 0
    for label, arguments, timeout, stdin in DOORS:
        code, output, seconds = run(_expand(arguments, scratch), timeout, stdin)
        sound += report(label, code, output, seconds)

    print(f"\nopening {len(JSON_DOORS)} JSON door(s) — their stdout is a contract, so it is judged")
    for label, arguments, timeout, stdin, expected_code, expected_event in JSON_DOORS:
        code, output, seconds = run(arguments, timeout, stdin)
        problem = json_door_problem(code, output, expected_code, expected_event)
        if problem:
            print(f"  FAIL  {label:38} {problem}")
            for line in output.strip().splitlines()[-4:]:
                print(f"          | {line}")
            continue
        sound += 1
        print(f"  ok    {label:38} exit {code:3}  {seconds:5.1f}s  "
              f"{len(output.strip().splitlines())} JSON line(s)")

    if slow:
        print(f"\nopening {len(SLOW_DOORS)} slow door(s) — a browser is started for each, and each "
              f"stops at the annotation step by design")
        for label, arguments, timeout, stdin in SLOW_DOORS:
            code, output, seconds = run(_expand(arguments, scratch), timeout, stdin)
            sound += report(label, code, output, seconds, reached=REACHED)

    openable = [bat for bat in bats if bat.name not in NOT_SWEPT]
    print(f"\ndouble-clicking {len(openable)} batch file(s) with nothing to type "
          f"({', '.join(sorted(NOT_SWEPT))} left out: they write, or they are this sweep)")
    for bat in openable:
        code, output, seconds = run_batch_file(bat, 90)
        sound += report(bat.name, code, output, seconds)

    total = len(DOORS) + len(JSON_DOORS) + len(openable) + (len(SLOW_DOORS) if slow else 0)
    shutil.rmtree(scratch, ignore_errors=True)
    removed = drop_new_sessions(existing_sessions)
    if removed:
        print(f"\nremoved {len(removed)} session directory(ies) this sweep created: "
              f"{', '.join(removed)}")
    print(f"\n{sound}/{total} door(s) sound; {len(problems)} static problem(s) in the batch files")
    return 0 if sound == total and not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
