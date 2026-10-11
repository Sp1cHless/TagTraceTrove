"""Entry point: sign a site in once, into the profile its adapter reads.

The one part of this tool that needs a person: 18comic's favourites are read with the cookies of a
browser session somebody established by hand. Everything else about it is mechanical — the profile
is a per-host directory under the tool's home, and the cookies go to the adapter's own file — so the
door is a script, and the person does only the part only a person can do.

    python login.py <url or site key>

Run it through 登录.bat when the tool is used from T³: a browser window opens, the person signs in,
comes back to the console and presses Enter, and the session is written where the crawl will read it.
No password is ever seen or stored by the tool.

Exit code: 0 the session was written, 2 the input names no site, 1 the browser or the write failed.
"""

from __future__ import annotations

from src.generic.login import main

if __name__ == "__main__":
    raise SystemExit(main())
