"""Level 0's read: title, cover and the cover's bytes — with nothing left on disk.

The reader in ``unknown_url.py`` answers "what is on this page". This module is what the two Level 0
entries call: it runs that reader, hands the cover's **bytes** to the caller, and removes the scratch
directory the reader needed while downloading. It writes nothing else, and in particular nothing into
the export tree.

**That is a change of contract, and it is deliberate.** Until now a Level 0 read ended in an export
document (``export/<host>/single/items/<id>/metadata.json`` plus the cover beside it), because that
document was how the fields reached the library: the bat wrote it, and a person dragged the folder
into T³. Once T³ could take a link directly — the Add Entry page's "try" button, which reads the page
and stores the cover as the Entry's own media — a handover that no longer happens should not leave a
folder behind. So the cover travels with the answer (base64 on the JSON door) and the caller stores it
where it belongs.

The two consequences worth knowing:

* the reader's scratch directory is the only place a file appears, and it is gone before this returns;
* the cover's path is therefore **not** part of the result. A caller that wants the bytes gets them
  from the second element; the result's ``cover_mime`` and ``cover_bytes`` describe what they are.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

from .unknown_url import Outcome, read_work

# The reader writes the cover under this stem inside the scratch directory.
COVER_STEM = "cover"

# What an image can be, keyed by the extension the reader chose from the response's content type.
# Only these leave this module, because a caller uploads the bytes under the type it is told.
MIME_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
}


def mime_for(path: Path) -> str:
    return MIME_TYPES.get(path.suffix.lower(), "application/octet-stream")


def read_link(url: str) -> tuple[dict[str, Any], bytes | None]:
    """Read one link with no site rule: the reader's result and the cover's bytes, or nothing.

    The bytes are read back from the scratch directory rather than handed over as a path, so no
    caller can depend on a file that is about to be deleted — the same class of mistake as an export
    path that outlives its folder.
    """
    scratch = Path(tempfile.mkdtemp(prefix="level0-"))
    try:
        result = read_work(url, save_dir=scratch, stem=COVER_STEM)
        if result.get("outcome") != Outcome.OK:
            return result, None

        saved = Path(str(result["cover"]))
        data = saved.read_bytes()
        # One owner for the size: what was actually read, not what the reader expected to write.
        result["cover_bytes"] = len(data)
        result["cover_mime"] = mime_for(saved)
        # The scratch path is about to stop existing, so it is never handed out — the key stays, as
        # `None`, because a caller should not have to tell an absent key from an empty one.
        result["cover"] = None
        return result, data
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
