"""Recompute the execution log's index numbers from the headings they name.

The table was written by hand as sections were appended, and every later append pushed the sections
below it down — measured 2026-10-04: the first row said 0048 while its heading had moved to 94, so
the index had drifted by tens of lines. This matches each row's title to a heading by prefix and
rewrites only the rows it can match exactly once; anything ambiguous is left alone and named.
"""
import re
import sys
from pathlib import Path

LOG = Path("D:/Project/TagTraceTrove/docs/siteprobe/siteprobe-execution-log.md")
ROW = re.compile(r"^\| ([^|]+?) \| ([^|]+?) \| (\d+) \|$")

lines = LOG.read_text(encoding="utf-8").split("\n") if "\r\n" not in LOG.read_text(
    encoding="utf-8", errors="replace") else None
# `Path.read_text` translates newlines, which collapses a CRLF file into one line — read it raw.
with LOG.open("r", encoding="utf-8", newline="") as handle:
    lines = handle.read().split("\r\n")
headings: list[tuple[int, str]] = [
    (index + 1, line.lstrip("# ").strip())
    for index, line in enumerate(lines)
    if line.startswith("### ") or line.startswith("# ")
]


def norm(text: str) -> str:
    return re.sub(r"[\s“”\"'（）()：:，,、·。.—-]+", "", text).casefold()


def find(title: str) -> int | None:
    wanted = norm(title)
    hits = [number for number, heading in headings
            if norm(heading).startswith(wanted[:18]) or wanted.startswith(norm(heading)[:18])]
    return hits[0] if len(hits) == 1 else None


changed, unmatched = 0, []
for index, line in enumerate(lines):
    row = ROW.match(line)
    if row is None:
        continue
    category, title, number = row.groups()
    target = find(title)
    if target is None:
        unmatched.append(f"{title} (was {number})")
        continue
    if target != int(number):
        lines[index] = f"| {category} | {title} | {target} |"
        changed += 1

print(f"rows rewritten: {changed}")
print(f"unmatched rows: {len(unmatched)}")
for item in unmatched:
    print("   ?", item)
if "--apply" in sys.argv:
    LOG.write_text("\r\n".join(lines), encoding="utf-8")
    print("written")
else:
    print("(dry run: pass --apply to write)")
