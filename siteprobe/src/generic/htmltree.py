"""A minimal HTML element tree plus a CSS-subset selector engine.

The generic extractor must read any site's saved HTML without that site's tool
owning a parser. BeautifulSoup is only installed in one of the three site
virtualenvs and the other two have no HTML library at all, so the generic layer
carries its own small implementation on top of the standard library's
``html.parser``. That keeps the shared layer dependency-free and lets every
site tool share identical matching semantics.

Supported selector syntax (deliberately a subset — every real site so far fits
inside it):

    tag              div
    .class           .video-title
    #id              #book-name
    [attr]           [data-href]
    [attr=value]     [data-type="works"]
    [attr~=word]     a[rel~=next]      (whitespace-separated word match)
    [attr*=part]     img[src*=/media/albums/]   (substring match)
    [attr^=part]     div[id^=favorites_album_]  (starts-with match)
    a, b             selector list (union, document order)
    descendants      div.video-tags-wrapper div.single-video-tag a
    *                any element

Not supported on purpose: sibling combinators, pseudo-classes. A template
needing one of those is a sign the site should keep a hand-written parser.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser

# Tags whose content is not markup. Their text is kept verbatim so a stray
# `class=` inside a script body can never be mistaken for an attribute.
_RAW_TEXT_TAGS = {"script", "style"}

_COMPOUND_RE = re.compile(
    r"""
    (?P<tag>[*]|[A-Za-z][A-Za-z0-9-]*)?            # element name
    (?P<rest>(?:\#[^.#\[\]\s]+|\.{1}[^.#\[\]\s]+|\[[^\]]*\])*)
    """,
    re.VERBOSE,
)
_ATTR_RE = re.compile(
    r"\[([^\[\]=~*^]+)"                     # attribute name
    r"(?:(~?=|\*=|\^=)\s*\"([^\"]*)\""      # "quoted value"
    r"|(~?=|\*=|\^=)\s*'([^']*)'"           # 'quoted value'
    r"|(~?=|\*=|\^=)\s*([^\]\s]*))?"        # bare value
    r"\]"
)


class Element:
    """One element node. ``children`` holds Element and str items in order."""

    __slots__ = ("tag", "attrs", "children", "parent", "order")

    _counter = 0

    def __init__(self, tag: str, attrs: dict[str, str], parent: Element | None) -> None:
        self.tag = tag
        self.attrs = attrs
        self.children: list[Element | str] = []
        self.parent = parent
        # Document position, assigned as the tree is built. A selector list is a
        # union, and CSS returns that union in document order rather than grouped
        # by alternative, so the order has to be recoverable after the fact.
        Element._counter += 1
        self.order = Element._counter

    # -- text --------------------------------------------------------------
    def text(self) -> str:
        """All descendant text, whitespace-collapsed."""
        parts: list[str] = []
        for child in self.children:
            parts.append(child if isinstance(child, str) else child.text())
        return re.sub(r"\s+", " ", "".join(parts)).strip()

    def raw_text(self) -> str:
        """All descendant text with whitespace preserved."""
        parts: list[str] = []
        for child in self.children:
            parts.append(child if isinstance(child, str) else child.raw_text())
        return "".join(parts)

    def attr(self, name: str) -> str | None:
        return self.attrs.get(name)

    def iter(self):
        """Depth-first iteration over this element and every descendant."""
        yield self
        for child in self.children:
            if isinstance(child, Element):
                yield from child.iter()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Element {self.tag} {self.attrs!r}>"


class _TreeBuilder(HTMLParser):
    # HTML voids need no closing tag; without this the parser would nest every
    # following sibling inside the last <img>/<br>.
    VOID = {
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Element("#root", {}, None)
        self._stack = [self.root]
        self._raw_tag: str | None = None

    def handle_starttag(self, tag, attrs):
        node = Element(tag, {name: value or "" for name, value in attrs}, self._stack[-1])
        self._stack[-1].children.append(node)
        if tag in _RAW_TEXT_TAGS:
            self._raw_tag = tag
            return
        if tag not in self.VOID:
            self._stack.append(node)

    def handle_startendtag(self, tag, attrs):
        node = Element(tag, {name: value or "" for name, value in attrs}, self._stack[-1])
        self._stack[-1].children.append(node)

    def handle_endtag(self, tag):
        if tag == self._raw_tag:
            self._raw_tag = None
        # Unwind to the matching open element; a stray close tag is ignored
        # rather than allowed to close an ancestor it never opened.
        for index in range(len(self._stack) - 1, 0, -1):
            if self._stack[index].tag == tag:
                del self._stack[index:]
                return

    def handle_data(self, data):
        self._stack[-1].children.append(data)

    def error(self, message):  # pragma: no cover - Python 3.11 compat shim
        return None


def parse_html(html: str) -> Element:
    """Parse an HTML document into a tree rooted at a synthetic ``#root``."""
    builder = _TreeBuilder()
    # A malformed page must still yield whatever it did contain: html.parser is
    # already tolerant, and a site redesign should degrade to "field missing"
    # rather than abort the run.
    builder.feed(html)
    builder.close()
    return builder.root


class _Compound:
    __slots__ = ("tag", "id", "classes", "attrs")

    def __init__(self, tag: str | None, element_id: str | None,
                 classes: list[str], attrs: list[tuple[str, str | None, str | None]]) -> None:
        self.tag = tag
        self.id = element_id
        self.classes = classes
        # (name, operator, value); operator is None for presence, "=", "~="
        self.attrs = attrs

    def matches(self, node: Element) -> bool:
        if self.tag is not None and self.tag != "*" and node.tag != self.tag:
            return False
        if self.id is not None and node.attrs.get("id") != self.id:
            return False
        if self.classes:
            present = (node.attrs.get("class") or "").split()
            if not all(name in present for name in self.classes):
                return False
        for name, operator, value in self.attrs:
            actual = node.attrs.get(name)
            if actual is None:
                return False
            if operator == "=" and actual != value:
                return False
            if operator == "~=" and (value or "") not in actual.split():
                return False
            if operator == "*=" and (value or "") not in actual:
                return False
            if operator == "^=" and not actual.startswith(value or ""):
                return False
        return True


def _parse_compound(text: str) -> _Compound:
    match = _COMPOUND_RE.fullmatch(text)
    if match is None:
        raise ValueError(f"unsupported selector step: {text!r}")
    tag = match.group("tag")
    element_id = None
    classes: list[str] = []
    attrs: list[tuple[str, str | None, str | None]] = []
    for token in re.findall(r"\#[^.#\[\]\s]+|\.{1}[^.#\[\]\s]+|\[[^\]]*\]", match.group("rest") or ""):
        if token.startswith("#"):
            element_id = token[1:]
        elif token.startswith("."):
            classes.append(token[1:])
        else:
            attribute = _ATTR_RE.fullmatch(token)
            if attribute is None:
                raise ValueError(f"unsupported attribute selector: {token!r}")
            name = attribute.group(1).strip()
            operator = attribute.group(2) or attribute.group(4) or attribute.group(6)
            value = attribute.group(3) or attribute.group(5) or attribute.group(7)
            attrs.append((name, operator, value))
    return _Compound(tag, element_id, classes, attrs)


def select_all(root: Element, selector: str) -> list[Element]:
    """Every descendant (plus ``root`` itself) matching ``selector``, in document order.

    A comma-separated selector is a union: results are collected per alternative
    and merged without duplicates, keeping each alternative's document order
    (the same order the site's own selector list implies).
    """
    found: list[Element] = []
    seen: set[int] = set()
    for alternative in selector.split(","):
        alternative = alternative.strip()
        if not alternative:
            continue
        for element in _select_single(root, alternative):
            if id(element) not in seen:
                seen.add(id(element))
                found.append(element)
    found.sort(key=lambda element: element.order)
    return found


def _select_single(root: Element, selector: str) -> list[Element]:
    steps = [_parse_compound(step) for step in selector.split()]
    if not steps:
        return []

    matched: list[Element] = []

    def walk(node: Element, depth: int) -> None:
        if steps[depth].matches(node):
            if depth == len(steps) - 1:
                matched.append(node)
            else:
                for child in node.children:
                    if isinstance(child, Element):
                        walk(child, depth + 1)
            # A descendant combinator may also match deeper inside the same
            # subtree, so keep descending even after a full match.
        for child in node.children:
            if isinstance(child, Element):
                walk(child, depth)

    for child in root.children:
        if isinstance(child, Element):
            walk(child, 0)
    return matched


def select_one(root: Element, selector: str) -> Element | None:
    found = select_all(root, selector)
    return found[0] if found else None
