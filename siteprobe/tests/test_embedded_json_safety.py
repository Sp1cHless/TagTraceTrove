"""Untrusted values must remain data inside executable HTML script blocks."""
import json
import urllib.request
import webbrowser
from html.parser import HTMLParser

from src.generic.review import review_page
from src.builder.annotate import page
from src.builder.harvest import _Registry
from src.builder import session_server

ATTACK = '</script><script>window.__siteprobe_breakout = 1</script>'


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.active = False

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.active = True
            self.scripts.append('')

    def handle_endtag(self, tag):
        if tag == 'script':
            self.active = False

    def handle_data(self, data):
        if self.active:
            self.scripts[-1] += data


def assert_embedded(page_html, variable, key, expected):
    parser = Scripts()
    parser.feed(page_html)
    assert len(parser.scripts) == 1
    payload = parser.scripts[0].split(f'const {variable} = ', 1)[1].split(';', 1)[0]
    assert json.loads(payload)[key] == expected
    assert ATTACK not in page_html


def test_review_card_title_cannot_break_out_of_script():
    cards = [{'source_id': '42', 'title': ATTACK, 'tags': ['normal'] }]
    assert_embedded(review_page(cards, {'source_site': 'normal'}), 'META', 'cards', cards)


def test_annotation_url_cannot_break_out_of_script():
    harvested = type('HarvestLike', (), {'candidates': [], 'notes': []})()
    assert_embedded(page(harvested, url=ATTACK), 'DATA', 'url', ATTACK)


def test_chooser_card_title_cannot_break_out_of_script(monkeypatch):
    captured = []
    def open_page(url):
        captured.append(urllib.request.urlopen(url).read().decode('utf-8'))
        request = urllib.request.Request(url.replace('/?','/api/choose?'),
                                         data=b'{"index":0}',
                                         headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(request).read()
    monkeypatch.setattr(webbrowser, 'open', open_page)
    cards = [{'index': 0, 'title': ATTACK, 'link': 'https://example.test/normal'}]
    assert session_server.choose_card('https://example.test', cards) == 0
    assert_embedded(captured[0], 'DATA', 'cards', [dict(cards[0], thumb=None)])
