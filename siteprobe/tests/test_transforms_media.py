"""Phase D's focused check (plan §5-D): a frozen date clock, and media failures that are their own.

The plan asks this phase for four things this file pins with a saved case and no network:

* a **relative date** converts against one **frozen** clock, so a run that crosses midnight does not
  give two works two different dates — and an unknown spelling is preserved, never erased;
* a **protocol-relative** image address (`//cdn/…`) resolves against the page, the way a rendered page
  writes it;
* a **200 response that is not an image** (an HTML challenge page) is refused, not saved as a JPEG —
  the plan's §5-D.5;
* a missing field, a missing cover *address*, and a cover whose bytes did not arrive are **three
  different findings**, not one "no cover" (§5-D.6).
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src.generic import diagnostics as diag  # noqa: E402
from src.generic import media, select  # noqa: E402
from src.generic.document import Document, DocumentBag  # noqa: E402


def test_a_relative_date_is_read_against_the_frozen_clock():
    with select.frozen_clock(date(2026, 3, 10)):
        assert select.apply_transforms("5 days ago", ["relative_date"]) == "2026-03-05"
        assert select.apply_transforms("yesterday", ["relative_date"]) == "2026-03-09"
        assert select.apply_transforms("today", ["relative_date"]) == "2026-03-10"
        # An absolute date still passes through the ordinary normaliser, and an unknown spelling is
        # preserved rather than erased.
        assert select.apply_transforms("2026-09-01", ["relative_date"]) == "2026-09-01"
        assert select.apply_transforms("sometime", ["relative_date"]) == "sometime"


def test_two_reads_a_minute_apart_agree_even_across_midnight():
    """The point of freezing: the clock is set once for the run, so it cannot move under a run."""
    with select.frozen_clock(date(2026, 3, 10)) as frozen:
        assert frozen == date(2026, 3, 10)
        first = select.apply_transforms("2 days ago", ["relative_date"])
        second = select.apply_transforms("2 days ago", ["relative_date"])
        assert first == second == "2026-03-08"
    # Outside the block the clock is restored, so a run does not leak its day into the next reader.
    assert select.apply_transforms("today", ["relative_date"]) == date.today().isoformat()


def test_a_protocol_relative_image_address_resolves_against_the_page():
    bag = DocumentBag()
    bag.add(Document(name="page", text='<img src="//cdn.test/a.jpg">', format="html",
                     url="https://page.test/work/1"))
    value = select.resolve(
        {"from": "html", "document": "page", "select": "img", "attr": "src", "absolute": True},
        bag, context={"url": "https://page.test/work/1"})
    assert value == "https://cdn.test/a.jpg"


def test_a_200_that_is_not_an_image_is_refused_not_saved(tmp_path):
    """§5-D.5: a bot-check HTML page answered 200, and must not become a `.jpg` on disk."""
    with pytest.raises(ValueError):
        media.detect_extension(b"<!doctype html><html><body>checking your browser</body></html>")
    saved = media.download_image("https://cdn.test/a.jpg", tmp_path / "cover", "cover",
                                 fetch=lambda url: b"<!doctype html><html>nope</html>")
    assert saved is None, "an HTML body is not a cover"
    assert not (tmp_path / "cover").exists() or not any((tmp_path / "cover").iterdir())


def test_missing_field_missing_address_and_failed_bytes_are_three_findings():
    field = diag.work_field_empty("title", ids=["1"], severity="error")
    address = diag.cover_url_empty(ids=["1"])
    failed = diag.cover_fetch_failed(detail="1 work(s) are missing media: 1 (cover)")
    codes = {finding.code for finding in (field, address, failed)}
    assert codes == {"WORK_FIELD_EMPTY", "COVER_URL_EMPTY", "COVER_FETCH_FAILED"}
    # And only the required-field one blocks; a cover problem warns or informs.
    assert [f.code for f in diag.blocking_findings([field, address, failed])] == ["WORK_FIELD_EMPTY"]
    assert failed.severity == "warning" and address.severity == "info"


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
