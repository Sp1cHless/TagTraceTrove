"""Entry point: the JSON contract T³ drives. See `src/generic/integration.py`.

A separate door from `probe.py` on purpose. `probe.py` prints prose for a person and shows a menu;
this one prints one JSON object per line for a program and never asks anything. Both dispatch
through the same registry and runner, so what T³ asks for is what a bat would have done.

    python integration.py sites
    python integration.py resolve "https://hitomi.la/galleries/1234.html"
    python integration.py run "<url>" --review
    python integration.py selection export/<site>/<listing>/selection_x.json
"""

from src.generic.integration import main

if __name__ == "__main__":
    raise SystemExit(main())
