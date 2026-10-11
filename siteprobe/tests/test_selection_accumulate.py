import json
from pathlib import Path

from src.generic.selection import _selection_manifest


class Template:
    raw = {"manifest": {"accumulate": True}}


def test_selected_second_batch_keeps_first_batch_manifest(tmp_path):
    listing = tmp_path / "listing"
    listing.mkdir()
    previous = {"items": ["first"], "item_count": 1}
    (listing / "metadata.json").write_text(json.dumps(previous), encoding="utf-8")
    current = {"items": ["second"], "item_count": 1}
    result = _selection_manifest(Template(), listing, current, [])
    assert result["items"] == ["first", "second"]
    assert result["item_count"] == 2
