"""Entry point: choose a site, then paste a link. See `src/generic/cli.py`."""

from src.generic.cli import pick_main

if __name__ == "__main__":
    raise SystemExit(pick_main())
