"""Work keys survive query strings and a shared route's optional deeper path."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.builder.capture import Capture, plain_documents
from src.builder.harvest import harvest
from src.builder.learn import Sample, draft_site_json, learn
from src.builder.roundtrip import compare, unnameable_targets
from src.generic.identity import work_id
from src.generic.template import load_template


WORK = "https://archiveofourown.org/works/88719301?view_adult=true"
CHAPTER = "https://archiveofourown.org/works/88722341/chapters/235422001"


def sample(url, number):
    title = f"Fixture work {number}"
    capture = Capture(url=url, final_url=url)
    capture.status = 200
    capture.content_type = "text/html"
    capture.documents = plain_documents(f'<html><h1>{title}</h1></html>')
    return Sample(name=f"work{number}", capture=capture, harvest=harvest(capture),
                  annotated={"title": title})


@pytest.mark.parametrize("urls", [
    [WORK],
    [WORK, WORK],
    [WORK, CHAPTER],
    [CHAPTER, WORK],
    [WORK, "https://archiveofourown.org/works/88722341?view_adult=true"],
])
def test_work_and_chapter_urls_share_the_work_key(urls, tmp_path):
    samples = [sample(url, index) for index, url in enumerate(urls, 1)]
    draft = draft_site_json(samples, learn(samples))
    path = tmp_path / "site.json"
    path.write_text(json.dumps(draft), encoding="utf-8")
    template = load_template(path)
    assert not unnameable_targets(draft, [WORK, CHAPTER])
    pattern = draft["targets"]["work"]["url_pattern"]
    for url, identifier in [
        (WORK, "88719301"),
        (CHAPTER, "88722341"),
        (CHAPTER + "?view_adult=true#comments", "88722341"),
        ("https://archiveofourown.org/works/88722341", "88722341"),
        ("https://archiveofourown.org/works/88722341/chapters/999999", "88722341"),
        ("https://archiveofourown.org/works/88722341/?view_full_work=true", "88722341"),
    ]:
        assert template.match_target(url) == ("work", {"id": identifier})
        assert work_id(url, pattern) == identifier
    for url in [
        "https://archiveofourown.org/users/88722341",
        "https://archiveofourown.org/works/",
        "https://archiveofourown.org/works/88722341oops",
        "https://archiveofourown.org.evil.test/works/88722341",
        "https://other.test/works/88722341",
    ]:
        assert template.match_target(url) is None
    for index, item in enumerate(samples):
        directory = tmp_path / f"roundtrip-{index}"
        directory.mkdir()
        result = compare(item, draft, directory)
        assert result.agreeing() and not result.unverified(), result.to_json()


def test_unrelated_depths_do_not_invent_a_work_key(tmp_path):
    samples = [sample("https://fixture.test/users/alice", 1),
               sample("https://fixture.test/works/123/chapter", 2)]
    draft = draft_site_json(samples, learn(samples))
    assert unnameable_targets(draft, [item.url for item in samples])


def test_slug_key_does_not_include_query_or_fragment(tmp_path):
    samples = [sample("https://fixture.test/work/first", 1),
               sample("https://fixture.test/work/second", 2)]
    draft = draft_site_json(samples, learn(samples))
    path = tmp_path / "site.json"
    path.write_text(json.dumps(draft), encoding="utf-8")
    assert load_template(path).match_target("https://fixture.test/work/third?from=list#top") == (
        "work", {"id": "third"})
