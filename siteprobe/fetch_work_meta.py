"""Entry point: the Level 0 result as JSON, one line per link.

The machine interface behind `show_link.py`, for when the reader's output is fed to something instead
of read by a person. `cover_base64` carries the cover's bytes, so a caller (T³'s Add Entry page)
can store them as the Entry's own media without any file being written first; `cover_mime` says what
they are. Nothing is left on disk — see `src/generic/level0_link.py` for why the shape changed.

    python fetch_work_meta.py <url> [<url> ...]
    from fetch_work_meta import read_work
"""

from __future__ import annotations

import json
import sys

import base64

from src.generic.level0_link import read_link
from src.generic.unknown_url import read_work

__all__ = ["read_work", "main"]


def main(argv: list[str] | None = None) -> int:
    for url in sys.argv[1:] if argv is None else argv:
        result, cover = read_link(url)
        print(json.dumps({
            **result,
            "cover_base64": base64.b64encode(cover).decode("ascii") if cover else None,
        }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
