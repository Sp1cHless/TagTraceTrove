"""Run one of a site's own steps, wherever that site's adapter lives.

    python run_site_step.py <site-key> <step> [step arguments...]

An adapter is data in the SiteProbe home (`<T³ user data>/siteprobe/installed/<site>/`), so
a step of its own is a file beside it and not an importable package. That is why
`python -m tool.comic18.repair_scramble` stopped naming anything when the layout changed, and
why this door loads the step the same way `load_fetcher` reads a site: from the directory.

Site keys are the ones `--list-sites` prints (`18comic.vip`), not folder names.

A step that takes a directory takes `{scope}`, which this file replaces with the site's export
group under the site's export root — so a batch file never has to know where either one is:

    run_site_step.py 18comic.vip repair_scramble --export-root "{scope}" --apply

`--export-scope <name>` names another group; `{export}` is the export root itself.
"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic.registry import (  # noqa: E402
    RegistryError,
    adapter_root,
    get_with_module,
    site_module,
)


def expand(arguments: list[str], export_root: Path, scope: str) -> list[str]:
    """`{scope}` and `{export}` in a step's own arguments, resolved to real paths."""
    return [argument.replace("{scope}", str(export_root / scope))
                    .replace("{export}", str(export_root))
            for argument in arguments]


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) < 2:
        print("usage: run_site_step.py <site-key> <step> [step arguments...]", file=sys.stderr)
        print("       e.g. run_site_step.py 18comic.vip repair_scramble --export-root \"{scope}\"",
              file=sys.stderr)
        return 3

    key, step, rest = argv[0], argv[1], argv[2:]
    scope = ""
    if "--export-scope" in rest:
        index = rest.index("--export-scope")
        try:
            scope = rest[index + 1]
        except IndexError:
            print("[ERROR] --export-scope needs a name", file=sys.stderr)
            return 3
        del rest[index:index + 2]

    template = None
    try:
        # Resolved by the step, not by the key: a learned rule set carries the same key as the
        # written adapter and ships none of its steps, and §17 puts the learned set first.
        template = get_with_module(key, step)
    except RegistryError as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 2

    export_root = adapter_root() / "export"
    if not scope:
        scope = template.export_group or template.directory.name
    rest = expand(rest, export_root, scope)

    try:
        module = site_module(template, step)
    except RegistryError as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 2

    if "{scope}" in " ".join(argv) or "{export}" in " ".join(argv):
        print(f"scope    {export_root / scope}")
        print(f"adapter  {template.directory}")

    # Two idioms exist among the steps: an argparse pair (`build_parser` + `run`), which
    # returns a code, and a bare `main()` that reads `sys.argv`. Both are called as their
    # author wrote them rather than one being rewritten into the other.
    if hasattr(module, "build_parser") and hasattr(module, "run"):
        return int(module.run(module.build_parser().parse_args(rest)) or 0)
    if hasattr(module, "main"):
        sys.argv = [f"{template.directory.name}/{step}.py", *rest]
        result = module.main()
        return int(result or 0)
    print(f"[ERROR] {key}/{step}.py has no run() or main() to call", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
