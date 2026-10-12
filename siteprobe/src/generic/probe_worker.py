"""Private JSON worker for bounded runtime and single-cover checks."""
from __future__ import annotations

import contextlib
import io
import json
import sys
from pathlib import Path

from src.generic import canonical, diagnostics as diag, export_layout, media
from src.generic.runner import RunOptions, run


def main(action: str, payload: dict) -> dict:
    if action == "run":
        payload["project_root"] = Path(payload["project_root"])
        options = RunOptions(**payload, progress=lambda _message: None)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                result = run(options)
            return {"listing_dir": str(result.listing_dir), "records": result.records,
                    "cards": result.cards, "findings": [f.to_json() for f in result.findings]}
        except diag.DiagnosticError as error:
            return {"error": str(error), "findings": [f.to_json() for f in error.findings]}
    if action == "cover":
        record = payload["record"]
        cover = record["cover"]
        listing = Path(payload["listing"])
        source_id = str(record["source_id"])
        # One cover only; no previews and no retries. The parent owns the deadline.
        path = media.download_image(str(cover.get("fetch_url") or cover["url"]),
                                    export_layout.item_dir(listing, source_id) / "cover", "cover",
                                    fetch=lambda url: media.fetch_bytes(
                                        url, referer=record.get("detail_url"), attempts=1))
        if path is None:
            return {"ok": False}
        canonical.attach_local_file(cover, stored_filename=path.name,
                                    local_path=f"items/{source_id}/cover/{path.name}")
        canonical.scrub_fetch_urls(record)
        export_layout.write_json(export_layout.item_dir(listing, source_id) / "metadata.json", record)
        manifest_path = listing / "metadata.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["items"] = [record if isinstance(item, dict) and item.get("source_id") == source_id
                             else item for item in manifest.get("items", [])]
        export_layout.write_json(manifest_path, manifest)
        return {"ok": True, "cover": cover}
    raise ValueError(f"unknown probe action: {action}")


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1], json.load(sys.stdin)), ensure_ascii=True))
