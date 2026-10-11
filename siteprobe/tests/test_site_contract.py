"""Every installed site must satisfy the contract, or the tool silently half-works.

The bug this prevents: a target kind was declared in `site.json` but the fetcher
never implemented it, so a work URL was passed to the listing path and produced
unrelated results. These checks run against every site on disk, so a new site
cannot join without meeting the same bar.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.builder import paths  # noqa: E402
from src.generic.registry import (  # noqa: E402
    discover,
    load_fetcher,
)
# One implementation of "what does this batch file call", shared with the acceptance run, so the
# test and the door sweep can never disagree about it.
from verify_doors import bat_problems, json_door_problem  # noqa: E402
from src.generic.site_api import optional_list_work_urls, require_read_work  # noqa: E402

# The written sites. A generated adapter lives in the Builder's own root and is
# discovered too, but the full site contract — naming, manifest, listing support —
# is what the hand-written three are held to; a generated adapter meets the part it
# needs to run and nothing more yet.
SITES = discover(paths.home() / "installed")


def test_at_least_the_three_migrated_sites_are_installed():
    assert {template.key for template in SITES} >= {"hitomi.la", "hanime1.me", "18comic.vip"}


@pytest.mark.parametrize("template", SITES, ids=[template.key for template in SITES])
def test_every_site_can_read_one_work(template):
    """The primitive. Without it a site cannot be used from a work URL at all."""
    fetcher = load_fetcher(template)
    assert callable(require_read_work(fetcher, template.key))


@pytest.mark.parametrize("template", SITES, ids=[template.key for template in SITES])
def test_every_declared_target_kind_is_supported(template):
    """A declared kind with no implementation is a trap, so it must not exist."""
    fetcher = load_fetcher(template)
    for kind, rule in template.targets.items():
        if rule.single:
            continue
        assert callable(optional_list_work_urls(fetcher)), (
            f"{template.key} declares a {kind} target but its fetch.py has no "
            f"list_work_urls, so a {kind} input could only fail at runtime"
        )


@pytest.mark.parametrize("template", SITES, ids=[template.key for template in SITES])
def test_each_site_shows_where_single_work_output_accumulates(template):
    naming = template.raw.get("naming") or {}
    assert naming.get("work"), f"{template.key} does not name its single-work folder"


@pytest.mark.parametrize("template", SITES, ids=[template.key for template in SITES])
def test_single_work_targets_are_declared_not_guessed(template):
    """The runner must not have to recognise a kind name like `album`."""
    assert any(rule.single for rule in template.targets.values()), (
        f"{template.key} marks no target as a single work"
    )


def test_no_site_calls_a_function_it_never_defines():
    """Rewriting an entry point can silently delete helpers used further down.

    That has broken the 18comic favourites path and the hitomi artist path in the
    same way, so the whole tree is checked statically as part of the suite.
    """
    import subprocess
    from pathlib import Path as _Path

    checker = _Path(__file__).resolve().parent / "check_undefined_names.py"
    result = subprocess.run([sys.executable, str(checker)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout


def test_the_login_bat_takes_its_address_from_the_environment():
    """`cmd` splits batch arguments on `=`, and every favourite or search address has one.

    Measured on the real bat: `https://18comic.vip/user/spechzy/favorite/albums?folder=4717648` arrived
    as two arguments (`...?folder` and `4717648`), which both truncated the address and pushed the
    `--no-pause` flag out of the position the bat checked — so the bat paused under the pipe T³ holds
    open and a finished sign-in sat there looking stuck.
    """
    login = (PROJECT_ROOT / "登录.bat").read_bytes().decode("ascii", "replace")

    assert "SITEPROBE_LOGIN_TARGET" in login, (
        "the address has to travel out of band; a positional URL is split on `=`")
    assert 'if "%TARGET%"=="" set "TARGET=%~1"' in login, (
        "a person running the bat by hand still passes a URL the ordinary way")


def test_every_bat_is_cmd_parseable():
    """LF endings or a stray non-ASCII byte silently break a batch file.

    An LF-only .bat makes CMD eat the first characters of each line, so
    `setlocal` becomes `'local'` and `echo` becomes `'cho'` — the whole file
    becomes a cascade of "not recognized as a command" errors. The original
    tools carried a `keep this file plain ASCII` note and a test for it for the
    same reason, so the merged tool asserts both properties.
    """
    bats = sorted(PROJECT_ROOT.glob("*.bat"))
    assert bats, "no bat files found"

    problems: list[str] = []
    for bat in bats:
        raw = bat.read_bytes()
        if raw.count(b"\r\n") != raw.count(b"\n"):
            problems.append(f"{bat.name}: has LF-only line endings (CMD needs CRLF)")
        offending = sorted({byte for byte in raw if byte > 127})
        if offending:
            problems.append(f"{bat.name}: contains non-ASCII bytes {offending}")
        if raw.startswith(b"\xef\xbb\xbf"):
            problems.append(f"{bat.name}: starts with a UTF-8 BOM")
        # A control byte is not "non-ASCII", so it slipped past the three checks above once: a
        # real 0x01 stood where `\1` belonged in a default path, and the door then worked in a
        # directory that cannot exist while reporting nothing wrong.
        controls = sorted({byte for byte in raw if byte < 32 and byte not in (9, 10, 13)})
        if controls:
            problems.append(f"{bat.name}: contains control bytes {controls}")
    assert not problems, problems


def test_every_bat_calls_something_that_exists():
    """A batch file is the only door a user has, and nothing else checks what it calls.

    Every bug a hand-run turned up after the adapter layout changed lived here: a module path
    naming a directory the layout had removed (`-m tool.comic18...`), a script that had been
    renamed, an interpreter that could not even be built. None of it is reachable from a unit
    test that imports the library, so the doors are audited the way a user opens them.

    The dynamic half of the same audit is `verify_doors.py`, which runs each door's command.
    """
    bats = sorted(PROJECT_ROOT.glob("*.bat"))
    assert bats, "no bat files found"

    problems, checked = bat_problems(bats)
    # The regex finding nothing would make this test pass while checking nothing, which is the
    # exact failure it exists to prevent.
    assert checked >= len(bats), f"only {checked} invocation(s) found across {len(bats)} bat(s)"
    assert not problems, problems



def test_the_bat_audit_catches_the_breakage_it_was_written_for(tmp_path):
    """The audit is only worth having if it fails on the real fault, so it is fed that fault."""
    broken = tmp_path / "broken.bat"
    broken.write_text(
        '@echo off\r\n'
        'if not exist ".venv\\Scripts\\python.exe" (\r\n'
        '  uv sync --extra browser --extra media\r\n'
        ')\r\n'
        '".venv\\Scripts\\python.exe" -m tool.comic18.repair_scramble --export-root export\r\n'
        '".venv\\Scripts\\python.exe" gone_script.py\r\n',
        encoding="utf-8",
    )
    problems, checked = bat_problems([broken])
    assert checked == 2, problems
    assert any("tool.comic18" in problem for problem in problems), problems
    assert any("gone_script.py" in problem for problem in problems), problems


def test_the_json_contract_doors_are_open():
    """`integration.py` is what T³ drives, so its doors are opened here, not only by hand.

    The verdict is the JSON stream, not "did not crash": a caller parses it, and a stray human line
    on stdout (or a missing line) breaks that caller while an exit code of 0 hides it. These run
    offline through the project interpreter, and each one exits non-zero on purpose except the first
    two.
    """
    import subprocess

    from verify_doors import JSON_DOORS

    interpreter = PROJECT_ROOT / ".venv" / "Scripts" / "python.exe"
    assert interpreter.is_file(), f"the project interpreter is missing: {interpreter}"
    for label, arguments, _timeout, _stdin, expected_code, expected_event in JSON_DOORS:
        completed = subprocess.run([str(interpreter), *arguments], cwd=str(PROJECT_ROOT),
                                   capture_output=True, text=True, encoding="utf-8",
                                   errors="replace", timeout=90)
        problem = json_door_problem(completed.returncode, completed.stdout, expected_code,
                                    expected_event)
        assert problem is None, f"{label}: {problem}\n{completed.stdout[:400]}"


def test_the_json_door_verdict_fails_on_a_bad_stream():
    """What makes the door above a check rather than a report: it is fed the faults it looks for.

    Every one of these is a real way the contract breaks — an empty stdout, a human sentence mixed
    into the stream, a wrong exit code, and a stream that ends with a different event. Without this
    the verdict could return "no problem" for all of them and nobody would know.
    """
    good = '{"event": "sites", "home": "x", "sites": []}\n'
    assert json_door_problem(0, good, 0, "sites") is None

    assert json_door_problem(0, "", 0, "sites") is not None
    assert json_door_problem(0, "everything is fine\n", 0, "sites") is not None
    assert json_door_problem(0, "all good\n" + good, 0, "sites") is not None, (
        "a human line on stdout is the fault a caller cannot see past")
    assert json_door_problem(1, good, 0, "sites") is not None, "wrong exit code"
    assert json_door_problem(0, '{"event": "resolve"}\n', 0, "sites") is not None
    assert json_door_problem(0, '{"home": "x"}\n', 0, "sites") is not None, "a line with no event"
    assert json_door_problem(None, good, 0, "sites") is not None, "no exit within budget"
