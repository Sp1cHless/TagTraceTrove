"""Where the tool keeps what is not source. The definition lives in the registry, so that the
adapters, the export tree and everything beside it are found by one rule rather than several."""
from __future__ import annotations

from pathlib import Path

from ..generic.registry import adapter_root


def home() -> Path:
    """The SiteProbe home: the four adapter sources and the data beside them."""
    return adapter_root()
