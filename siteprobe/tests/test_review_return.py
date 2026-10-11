from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic.review import review_page  # noqa: E402


def test_review_export_posts_selected_payload_to_the_active_t3_run():
    page = review_page(
        [{"source_id": "42", "title": "Chosen work"}],
        {"source_site": "demo.test", "target_kind": "search", "target_ref": "x"},
    )

    assert "selectionRunId" in page
    assert "fetch(`/api/siteprobe/runs/${encodeURIComponent(selectionRunId)}/selection`" in page
    assert "selected_source_ids: chosen" in page
    assert "mode: 'same-origin'" in page
    assert "window.showSaveFilePicker" in page
