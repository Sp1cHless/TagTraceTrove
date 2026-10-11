"""Find names a module calls but never defines.

Rewriting a fetcher's entry point can silently delete helpers that lived further
down the file, and the failure only shows at runtime on the branch that uses them.
This walks each module's AST so every such name is found in one pass.

Scopes are resolved the way Python resolves them, because one module-wide set of names is not
enough: a name bound only inside `main` is NOT defined inside the helper beside it. Measured on a
real regression — `profile` was a parameter of `main` and read inside `one_sample`, the
module-wide check called it defined, and the tool died with `NameError` on the one argument path
nobody had run yet. Whichever scope binds a name, that name is visible there, in the scopes
nested inside it, and nowhere else.

Covers the site fetchers, the generic layer, the builder, and the root entry points — an entry
point is small, which is exactly why a rename there goes unnoticed until it runs.
"""

from __future__ import annotations

import ast
import builtins
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Bound by the language, not by this module: an `except ... as error` target and
# a module's own dunders are never definitions to look for.
IGNORED = {"__file__", "__name__", "__doc__", "error", "exc", "self", "cls"}

# A name bound in a module body is visible in every function below it, so the module scope is the
# one scope that is never checked against anything.
KNOWN = set(dir(builtins)) | IGNORED


def _bindings(nodes: list[ast.AST]) -> set[str]:
    """Every name these nodes bind, without entering a nested function or class body.

    A nested function's *name* is bound here; its body has a scope of its own and is walked
    separately. Each node is dispatched before its children are queued — an `import` and a `def`
    are themselves the things that bind, and looking only at their children finds neither.

    Lambdas and comprehensions are not split out on purpose: their arguments can only make this
    check more forgiving, never less, and a false alarm on a correct module would cost more than
    the rare miss.
    """
    names: set[str] = set()
    stack = list(nodes)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
            continue
        if isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                names.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.ExceptHandler):
            if node.name:
                names.add(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names.update(node.names)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            names.add(node.id)
        stack.extend(ast.iter_child_nodes(node))
    return names


def _reads(body: list[ast.AST]) -> list[ast.Name]:
    """Every name read by these statements, without descending into nested scopes."""
    found: list[ast.Name] = []
    stack = list(body)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            found.append(node)
        stack.extend(ast.iter_child_nodes(node))
    return found


def _check(body: list[ast.stmt], inherited: set[str], problems: dict[str, int]) -> None:
    """Record the reads in `body` that no visible scope binds, then descend into the nesting."""
    visible = inherited | _bindings(body)
    for node in _reads(body):
        if node.id not in visible:
            problems.setdefault(node.id, node.lineno)
    for statement in body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # A function's own parameters are the first thing its body may read, and they are not
            # inside its body — so they are bound here rather than found by walking it.
            _check(statement.body, visible | _bindings([statement.args]), problems)
        elif isinstance(statement, ast.ClassDef):
            # A class body cannot really see the enclosing function's locals, but treating it as
            # if it could only ever hides a name — it never invents one — and this file's job is
            # to be believed, not to be clever.
            _check(statement.body, visible, problems)


def undefined_calls(path: pathlib.Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf8"))
    problems: dict[str, int] = {}
    _check(tree.body, KNOWN | _bindings(tree.body), problems)
    return [f"line {line}: {name}" for name, line in sorted(problems.items(), key=lambda kv: kv[1])]


def targets() -> list[pathlib.Path]:
    """Every module this tree ships, plus the installed adapters when the home has any.

    An adapter lives in the SiteProbe home rather than in this tree, and its entry point is the
    one that runs against a live page — so it is checked too, and a home that is empty is not an
    error.
    """
    found = (sorted(ROOT.glob("*.py"))
             + sorted(ROOT.glob("src/generic/*.py"))
             + sorted(ROOT.glob("src/builder/*.py")))
    try:
        from src.generic.registry import tool_roots
    except ImportError:
        return found
    for root in tool_roots():
        found.extend(sorted(root.glob("*/fetch.py")))
        found.extend(sorted(root.glob("*/*.py")))
    return found


if __name__ == "__main__":
    files = targets()
    # A check that quietly covers nothing is worse than no check at all: that is the shape which
    # let a whole set of batch files keep calling a directory that no longer existed.
    own = [path for path in files if ROOT in path.parents]
    if len(own) < 10:
        print(f"only {len(own)} module(s) of this tree were found; the globs are stale")
        raise SystemExit(1)

    failures = 0
    for target in files:
        missing = undefined_calls(target)
        label = target.relative_to(ROOT) if ROOT in target.parents else target
        if missing:
            failures += 1
            print(f"{label}")
            for entry in missing:
                print(f"    {entry}")
    print(f"checked {len(files)} module(s); {failures} with an undefined name")
    raise SystemExit(1 if failures else 0)
