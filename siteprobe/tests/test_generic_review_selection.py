"""Generic review handoff regressions, using real review files and a temporary export."""
import json

from src.generic.review import selection_payload, write_review
from src.generic import runner, selection
from src.generic.template import load_template
from src.builder import paths
import pytest


def test_favorite_review_selection_preserves_user_folder_and_listing(tmp_path, monkeypatch):
    template = load_template(paths.home() / "installed" / "comic18" / "site.json")
    url = "https://18comic.vip/user/SomeUser/favorite/albums?folder=42"
    matched = template.match_target(url)
    assert matched is not None
    kind, ref = matched
    options = runner.RunOptions(raw_input=url, project_root=tmp_path, review=True,
                                progress=lambda message: None)
    name = runner.listing_name(template, kind, ref, options)
    cards = [{"source_id": "123", "title": "Selected"}]
    monkeypatch.setattr(runner, "resolve", lambda options: (template, kind, ref))
    monkeypatch.setattr(runner, "load_fetcher", lambda template: object())
    monkeypatch.setattr(runner.site_api, "optional_scan_review", lambda fetcher: None)
    monkeypatch.setattr(runner.site_api, "optional_list_cards", lambda fetcher: lambda *args: cards)
    monkeypatch.setattr(runner.site_api, "listing_url", lambda *args: url)
    monkeypatch.setattr(runner.review_media, "localize_covers", lambda *args: None)
    result = runner.run(options)
    assert result.listing_dir.name == name
    meta = json.loads((result.listing_dir / "review.html").read_text(encoding="utf-8").split("const META = ", 1)[1].split(";", 1)[0])
    document = selection_payload(cards, meta, ["123"])
    assert document["target_ref_fields"] == ref
    assert document["listing"] == name
    path = tmp_path / "selection.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    monkeypatch.setattr(selection, "reader_for", lambda key: template)
    monkeypatch.setattr(selection, "load_fetcher", lambda template: object())
    seen = []
    def check_cards(template, actual_kind, actual_ref, scan_options):
        seen.append((actual_kind, actual_ref, scan_options["export_dir"].name))
        raise RuntimeError("listing verified")
    monkeypatch.setattr(selection.site_api, "optional_list_cards", lambda fetcher: check_cards)
    with pytest.raises(RuntimeError, match="listing verified"):
        selection.run_selection(path, project_root=tmp_path, progress=lambda message: None)
    assert seen == [(kind, ref, name)]


def test_review_writes_cards_and_page_before_selection(tmp_path):
    cards = [{"source_id": "42", "title": "A card"}]
    meta = {"source_site": "example", "target_kind": "favorite", "target_ref": "42"}
    page = write_review(tmp_path, cards, meta)
    assert page.is_file()
    assert json.loads((tmp_path / "cards.json").read_text(encoding="utf-8")) == cards
    assert selection_payload(cards, meta, ["42"])["selected_source_ids"] == ["42"]
