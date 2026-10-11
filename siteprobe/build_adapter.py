"""Entry point: build an adapter for a site from a few of its works, in one run.

This is the manual path, in the shape the other bats have: give it URLs, work through
the pages it opens, and it ends with a draft adapter installed and a command to try
it. It exists because doing it by hand means knowing where each session directory
went and passing them around; this does that part.

    python build_adapter.py --browser <url1> [<url2>] [<url3>]

The first work is annotated — every field is chosen from the candidates the harvester
offered. The others are *confirmed*: the rules learned from the first page are applied
to them and shown with the value they read, so a person only says whether each is
right. That is the plan's three samples, and it is what separates a rule from a guess
a single page happened to fit.

Nothing is moved by hand at any point: the annotation pages are served on the loopback
interface and post their result back into the session directory.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

from src.builder import paths
from src.builder.capture import Capture, captured_nothing, capture_browser, capture_plain
from src.generic import unknown_url
from src.builder.harvest import Harvest, harvest, joined_value
from src.builder.learn import apply_to, draft_site_json, learn, load_session
from src.builder.roundtrip import compare, install, unnameable_targets
from src.builder.session_server import Session, serve

PROJECT_ROOT = Path(__file__).resolve().parent
SESSIONS = paths.home() / "sessions"
LEARNED_ROOT = paths.home() / "local"


def session_directory(capture: Capture, label: str) -> Path:
    host = (capture.final_url or capture.url).split("//")[-1].split("/")[0] or "unknown"
    host = "".join(character if character.isalnum() or character in ".-" else "_"
                   for character in host)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return SESSIONS / host / f"{stamp}-{label}"


def record(capture: Capture, root: Path) -> Harvest:
    result = harvest(capture)
    root.mkdir(parents=True, exist_ok=True)
    capture.write(root / "capture.json")
    result.write(root / "candidates.json")
    return result


def position_for(index: int, total: int) -> tuple[int, int] | None:
    """Where this page sits in the run, in the shape the annotation page renders it.

    A **tuple**, not a formatted sentence: the page turns `(index, total)` into the language's own
    words (`第{cn}个网站（1/3）` / `Site 1 of 3`), and building the sentence here as well was two homes
    for one line — with the page reading `position[0]`/`position[1]` off a *string*, so every run with
    more than one address crashed the page handler and the browser showed nothing at all
    (`ERR_EMPTY_RESPONSE`). Measured on a three-address jable.tv run, 2026-10-04: the address was
    printed, the page answered every other route, and the page itself came back empty.
    """
    return (index, total) if total > 1 else None


def one_sample(url: str, label: str, *, browser: bool, references: list[Path],
               profile: Path | None = None, login: bool = False,
               index: int = 0, total: int = 1) -> Path | None:
    """Capture one work, then open its annotation page and wait for the result.

    `None` when the page could not be captured at all: the caller says so and stops, because an
    annotation page over nothing is a dead end that looks like the tool hanging — measured on a real
    single-work run (2026-09-28), where an unreachable page meant a silent minute and then an
    annotation page with zero candidates to click.
    """
    # The capture itself prints nothing, and it is the longest quiet stretch there is: a browser has
    # to start, the page has up to 45 s to load, then it settles and scrolls. Saying what is happening
    # is what keeps "working" from reading as "stuck".
    print(f"    capturing {url}"
          + (" with a headless browser; this can take up to a minute" if browser else " ..."),
          flush=True)
    capture = capture_browser(url, profile=profile, login=login) if browser else capture_plain(url)
    if captured_nothing(capture):
        print(f"[ERROR] {url}: the page could not be read ({capture.status or 'no response'}).")
        print("        Check the address, or open the site in a browser first and try again.")
        return None
    root = session_directory(capture, label)
    result = record(capture, root)

    applied = None
    mode = "annotate"
    if references:
        # Every page answered so far, not just the first: a field the first work did not
        # carry is still proposed from whichever page has it, which is how an answer given
        # on the second page reaches the third.
        applied = apply_to([load_session(reference, name=f"{reference.name} (reference)")
                            for reference in references], capture)
        mode = "confirm"
        read = ", ".join(f"{field}={joined_value(item['value'])[:28]}"
                         for field, item in applied.items()) or "(no rule read anything)"
        print(f"    applied from the pages before this one: {read}")

    counts: dict[str, int] = {}
    for candidate in result.candidates:
        counts[candidate.kind] = counts.get(candidate.kind, 0) + 1
    print(f"=== {capture.final_url or capture.url}")
    print(f"    {len(result.candidates)} candidate(s): "
          f"{', '.join(f'{kind} {count}' for kind, count in sorted(counts.items()))}")
    for note in result.notes:
        print(f"    note: {note}")
    print(f"    session {root}")
    print(f"    opening the page ({mode}); submit it to continue")

    position = position_for(index, total)
    serve(Session(harvest=result, directory=root, mode=mode, applied=applied,
                  url=capture.final_url or capture.url,
                  position=position, last=index == total - 1))
    if not (root / "annotations.json").is_file():
        print("    [WARN] nothing was submitted; this sample teaches nothing")
    return root


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    browser = "--browser" in arguments
    do_install = "--install" in arguments
    profile: Path | None = None
    login = "--login" in arguments
    for argument in arguments:
        if argument.startswith("--profile="):
            profile = Path(argument.split("=", 1)[1])
    if login and profile is None:
        from urllib.parse import urlparse as _urlparse

        from src.builder.capture import profile_for

        host = _urlparse(next(a for a in arguments if not a.startswith("--"))).hostname or "site"
        profile = profile_for(host)
    if profile is not None or login:
        # A persistent profile is the browser's own storage, so asking for one — or for a window
        # to sign in through — *is* asking for the browser. Two flags that must agree is how a
        # person came to run with `--login` and get the plain reader: no window, no session, and
        # the same 31 links, with nothing in the output to say why.
        browser = True
    targets = [argument for argument in arguments if not argument.startswith("--")]
    if not targets:
        print("Usage: python build_adapter.py [--browser] [--install] <url> [<url>] [<url>]")
        return 3

    directories: list[Path] = []
    for index, url in enumerate(targets):
        directory = one_sample(url, label=f"work{index + 1}", browser=browser,
                               references=list(directories),
                               profile=profile, login=login,
                               index=index, total=len(targets))
        if directory is None:
            if index == 0:
                # Nothing can be learned without a first page: saying so beats an annotation
                # session over an empty harvest.
                return 2
            print(f"    [WARN] work{index + 1} could not be captured; continuing with "
                  f"{len(directories)} sample(s)")
            continue
        directories.append(directory)

    samples = [load_session(directory) for directory in directories]
    # The page the *crawl* will read, beside the one the browser rendered. On a server-rendered site
    # they are the same document; on a JavaScript-driven one they are not, and a rule learned from the
    # rendering reads the shell and finds nothing — measured on iwara (2026-10-11), whose import came
    # out with zero entries for exactly that reason. A fetch that fails is a warning, never a failed
    # run: the samples are still worth learning from.
    for sample in samples:
        try:
            status, body, _kind, _final = unknown_url.fetch(sample.url)
        except Exception as error:  # noqa: BLE001 - a page that will not come back is not fatal
            print(f"    [WARN] could not read {sample.url} as served ({error}); "
                  "learning from the rendered page alone")
            continue
        if status == 200 and body:
            sample.served = body.decode("utf-8", "replace")
    learning = learn(samples)
    draft = draft_site_json(samples, learning)
    draft_path = directories[0] / "draft_site.json"
    draft_path.write_text(json.dumps(draft, ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")
    learning.write(directories[0] / "learning.json")

    print()
    print("=== what the samples decided")
    for report in learning.fields:
        winner = report.chosen()
        print(f"    {report.field:12} {json.dumps(winner.rule) if winner else 'no rule'}")
        for hypothesis in report.hypotheses:
            print(f"        {hypothesis.verdict:9} {json.dumps(hypothesis.rule)}")
            print(f"                  {hypothesis.reason()}")
    for note in learning.notes:
        print(f"    note: {note}")
    unproven = [report.field for report in learning.fields
                if report.chosen() and report.chosen().verdict == "unproven"]
    if unproven:
        print(f"    unproven: {', '.join(unproven)} — only one page could check these")
    print()
    print(f"    learning {directories[0] / 'learning.json'}")
    print(f"    draft    {draft_path}")

    print()
    print("=== does the draft read what the runtime reads")
    result = compare(samples[0], draft, directories[0])
    for item in result.comparisons:
        print(f"    {item.field:12} {item.verdict:10} "
              f"runtime={joined_value(item.runtime)[:40]}")
        print(f"                 {item.detail}")
    for note in result.notes:
        print(f"    note: {note}")
    (directories[0] / "roundtrip.json").write_text(
        json.dumps(result.to_json(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"    {'PASS' if result.ok else 'FAIL'} — "
          f"{len(result.agreeing())}/{len(result.comparisons)} field(s) agree")
    disagreed = [item.field for item in result.disagreeing()]
    if disagreed:
        print(f"    disagreed: {', '.join(disagreed)} — the two sides read different "
              "values, so one of them is wrong")

    if do_install and result.ok:
        # The round trip above reads fields on the pages it was given; it never asks the target
        # pattern whether it matches the address a person will paste. Same fault as the listing
        # builder's, one layer up, and the same answer: refuse to install rather than ship an
        # adapter that resolves through no code path.
        unnameable = unnameable_targets(draft, targets)
        if unnameable:
            print()
            for problem in unnameable:
                print(f"[STOP] {problem}")
            print("       nothing was installed: a target that cannot name its own address "
                  "would be invisible.")
            return 1
        target = install(draft, LEARNED_ROOT, source=str(directories[0]))
        print()
        print(f"=== installed {target}")
        print(f"    try it:  python probe.py {targets[0]}")
        print(f"    the export lands under export/{draft.get('export_group')}/")
        shadowed = json.loads((target / "learned.json").read_text(encoding="utf-8")).get("adapter_beside")
        if shadowed:
            print(f"    note: this site already has a written adapter ({shadowed}), so "
                  "the generated one is not the one in use")
    elif do_install:
        print()
        print("    not installed: the round trip has to agree first, or the adapter"
              " would write values nobody checked")
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
