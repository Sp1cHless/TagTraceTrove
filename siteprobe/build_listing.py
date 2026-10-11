"""Entry point: a listing page into a `listings` rule (Phase 7 of the plan).

    python build_listing.py [--browser] [--kind search] [--card N] [--install] \
        <listing-url> [<page-2-url> ...]

A listing is a *set* of cards, so the person's job is smaller than for a work: mark **one**
card, and the rest of the page — and the next page — is machinery. Everything after the
click is the Phase 5/6 pipeline, unchanged, because a card is harvested as a small page
(`cards.card_page`) and the runtime reads a listing field exactly that way: one row as the
field's whole document.

The pages after the first are not annotated; they are *checked*. Nobody knows what the
second page's cards should say, but everybody knows its ids should be new ones — which is
the plan's §17 terminal condition, applied to cards (`listing.check_over_cards`).

Writes into the first page's session directory:

    draft_listing.json   the `targets` and `listings` sections, ready to install
    learning.json        every hypothesis the card offered, and its verdict
"""

from __future__ import annotations

import dataclasses
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlparse

from src.builder import paths
from src.builder.annotate import LISTING_FIELDS
# Answered prompts are read through the shared helper, so a run with no console attached ends
# with the door's own "nothing chosen" default instead of an EOFError traceback.
from src.generic.cli import ask
from src.builder.capture import Capture, captured_nothing, capture_browser, capture_plain, plain_documents
from src.builder.cards import (card_elements, card_page, cards_of, cards_of_group,
                               preview_of)
from src.builder.harvest import harvest
from src.builder.learn import draft_base, learn, load_session
from src.builder.listing import (card_rule_for_id, cards_as_read_by_the_runtime,
                                 check_over_cards, listing_draft, listing_rules,
                                 pagination_from, rule_from, target_pattern_problem)
from src.builder.roundtrip import install
from src.builder.session_server import Session, choose_card, serve

PROJECT_ROOT = Path(__file__).resolve().parent
LEARNED_ROOT = paths.home() / "local"

# How many cards the choosing page shows. A set of three hundred is a page nobody reads; the
# command line can still name any of them.
MAX_CHOICES = 60


def page_url_for(path: str) -> str:
    """What a saved page stands in for, so the derived patterns stay absolute."""
    return "https://" + Path(path).stem.replace("_", "-") + "/list"


def session_directory(capture: Capture, label: str) -> Path:
    from datetime import datetime

    root = paths.home() / "sessions" / (urlparse(
        capture.final_url or capture.url).hostname or "site")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    directory = root / f"{stamp}-{label}"
    directory.mkdir(parents=True, exist_ok=True)
    capture.write(directory / "capture.json")
    return directory


def url_pattern_for(page_url: str, page_parameter: str | None = None,
                    kind: str | None = None) -> str:
    """The pattern that names this listing, with a group for its identity.

    Host and path, with the query left open because a listing's page parameter lives there — plus
    a capture group, because a pattern with no group can never match: `TargetRule.match` takes the
    id from a named group, else a positional one, and returns `None` when there is neither.
    Measured on a learned search set built by the older version of this function — its target
    resolved through no code path at all, and only the hand-written adapter kept that URL working.

    Which part of the address is the identity is read off the sample rather than assumed: the one
    query parameter that is not the paging parameter, or the last path segment when the address
    has no query.
    """
    parsed = urlparse(page_url)
    host = re.escape(parsed.hostname or "")
    if kind == "artist":
        # Artist listings often end in a fixed view (`/profile/<name>/videos`) and carry sorting
        # controls in the query.  The identity is the segment after the route's subject marker,
        # not `sort=date` and not the fixed `videos` suffix.
        parts = [part for part in parsed.path.split("/") if part]
        markers = {"artist", "author", "profile", "user", "creator", "model"}
        marker = next((index for index, part in enumerate(parts[:-1])
                       if part.casefold() in markers), None)
        if marker is not None:
            before = "/" + "/".join(parts[:marker + 1])
            after = "/" + "/".join(parts[marker + 2:]) if parts[marker + 2:] else ""
            return (rf"^https?://{host}{re.escape(before)}/(?P<id>[^/?#]+)"
                    rf"{re.escape(after)}/?(?:[?#].*)?$")
    identity = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True)
                if key != page_parameter]
    if identity:
        head = rf"^https?://{host}{re.escape(parsed.path)}"
        if len(identity) == 1:
            # The value alone, the way the hand-written adapters name it (`search_query=`, `folder=`
            # are the parameter; the export folder wants `x`, not `search_query=x`).
            return rf"{head}\?(?:[^#]*&)?{re.escape(identity[0][0])}=(?P<id>[^&#]+)"
        # Several parameters and no way to tell which one is the identity: keep the whole query,
        # which is stable for the first page — the only page whose ref is used.
        return rf"{head}\?(?P<id>[^#]+)"
    directory = parsed.path.rstrip("/").rpartition("/")[0]
    return (rf"^https?://{host}{re.escape(directory)}/(?P<id>[^/?#]+)/?(?:[?#].*)?$")


def learned_work_pattern(page_url: str) -> str | None:
    """The local work target already learned for this host, when one exists."""
    base = draft_base(page_url)
    path = LEARNED_ROOT / str(base["tool"]) / "site.json"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    pattern = (((document.get("targets") or {}).get("work") or {}).get("url_pattern"))
    return str(pattern) if pattern else None


def row_selector_for(root, group, members: list, *, picked: list[str]) -> str | None:
    """The selector that names **this set** and nothing else on the page.

    A class can be shared with another block — measured on a jable.tv model page (2026-10-05), whose tag
    cloud and video list both write `div.col-6.col-sm-4`: the person was shown 24 works, the rule written
    for them read 145 elements, and every check (and the crawl) judged the wrong rows — so the `作品 id`
    they marked "could not be read on all cards" and the adapter installed with no id rule at all. The
    block the group repeats in is the narrower name; a candidate is taken only when it selects
    *exactly* the set the person was shown.
    """
    from src.generic.htmltree import parse_html, select_all

    joined = ", ".join(dict.fromkeys(picked))
    wanted = {id(element) for element in members}
    if group.container:
        inside = [element for block in select_all(root, group.container)
                  for element in select_all(block, joined)]
        if {id(element) for element in inside} == wanted:
            return group.container
    return None


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    browser = "--browser" in arguments
    do_install = "--install" in arguments
    kind = "search"
    verbose = "--verbose" in arguments
    for argument in arguments:
        if argument.startswith("--kind="):
            kind = argument.split("=", 1)[1]
    card_index: int | None = None
    for argument in arguments:
        if argument.startswith("--card="):
            card_index = int(argument.split("=", 1)[1])
    # Which card of the set represents it. "The first one" is the right default and not always
    # the right answer: measured on a real search page, the first album link on the page
    # belonged to a block of recommendations above the results. Naming a card is the human half
    # of the picker the plan defers, and it needs no page of its own.
    card_of = 0
    card_of_given = False
    for argument in arguments:
        if argument.startswith("--card-of="):
            card_of = int(argument.split("=", 1)[1])
            card_of_given = True
    offline: list[str] = []
    for argument in arguments:
        if argument.startswith("--offline="):
            offline.append(argument.split("=", 1)[1])
    profile: Path | None = None
    login = "--login" in arguments
    for argument in arguments:
        if argument.startswith("--profile="):
            profile = Path(argument.split("=", 1)[1])
    if login and profile is None:
        from urllib.parse import urlparse as _urlparse

        from src.builder.capture import profile_for

        host = _urlparse(next(a for a in arguments if not a.startswith("--"))).hostname or "site"
        profile = profile_for(host)
    if profile is not None or login:
        # A persistent profile is the browser's own storage, so asking for one — or for a window
        # to sign in through — *is* asking for the browser. Two flags that must agree is how a
        # person came to run with `--login` and get the plain reader: no window, no session, and
        # the same 31 links, with nothing in the output to say why.
        browser = True
    targets = [argument for argument in arguments if not argument.startswith("--")]
    if not targets and not offline:
        print("Usage: python build_listing.py [--browser] [--kind=search] [--card=N] "
              "[--card-of=N] [--install] [--offline=page.html] <listing-url> "
              "[<page-2-url> ...]")
        return 3

    pages: list[tuple[str, str]] = []
    captures: list[Capture] = []
    attach = "--attach" in arguments
    if attach:
        browser = True
    reader = "an attached browser" if attach else ("the browser" if browser else "a plain request")
    print(f"    reading with {reader}"
          + (f", profile {profile}" if profile is not None else "")
          + (", signing in first" if login else ""))
    for url in targets:
        # Same quiet stretch as the work builder's: name it, or it reads as stuck.
        print(f"    reading {url} ...", flush=True)
        if attach:
            from src.builder.capture import capture_attached

            capture = capture_attached(url, profile=profile)
        else:
            capture = capture_browser(url, profile=profile,
                                      login=login) if browser else capture_plain(url)
        if captured_nothing(capture):
            print(f"[ERROR] {url}: no markup was captured ({capture.status})")
            return 2
        pages.append((capture.final_url or url, capture.markup.text))
        captures.append(capture)
    for path in offline:
        # A saved page, with no network: what the tool needs to be tried — or repaired —
        # without visiting the site again.
        markup = Path(path).read_text(encoding="utf-8", errors="replace")
        capture = Capture(url=f"file://{Path(path).name}", final_url=page_url_for(path))
        capture.status = 200
        capture.content_type = "text/html"
        capture.documents = plain_documents(markup)
        pages.append((capture.final_url, markup))
        captures.append(capture)
    if not captures:
        print("[ERROR] nothing to read")
        return 2

    print(f"=== {pages[0][0]}")
    groups = cards_of(pages[0][1])
    if not groups:
        print("    no repeated card structure was found on this page")
        return 1
    # In the person's words, not the Builder's: what the card *is*, not what its selector
    # says. A page with two card sets at once — twenty works and five of something else — is
    # unreadable as `div.imageset` and `div.acg`, and readable as the titles they carry.
    # Which site the cards' own links point at, because a "card set" whose links leave the
    # page is an advertisement: measured on a real search page, whose second-largest group was
    # a promotional block linking to another domain. The tool says so instead of hoping the
    # person notices the address.
    page_host = urlparse(pages[0][0]).hostname or ""
    for index, group in enumerate(groups):
        shown = preview_of(group)
        marks = "+".join(group.hints)
        offsite = bool(shown["link"].startswith("http")
                       and page_host and page_host not in shown["link"])
        flag = "  ← off-site link, not this site's listing" if offsite else ""
        print(f"    [{index}] {group.count:4} card(s)  [{marks}]  «{shown['title']}»{flag}")
        if shown["link"] or shown["cover"]:
            print(f"           link {shown['link']}   cover {shown['cover']}")
        if verbose:
            print(f"           (selector {group.selector}, container {group.container})")
    if len(groups) > 1:
        largest = max(range(len(groups)), key=lambda index: groups[index].count)
        print()
        print(f"    The set with the most cards is [{largest}]. Pick the one that holds the "
              "works this page lists;")
        print("    the sample lines above are the first card of each set, so they say which "
              "is which.")
    if card_index is None:
        # Asked *after* the list is on screen, because that list is the answer to the
        # question — and one group needs no question at all.
        if len(groups) == 1:
            picked = [0]
        else:
            print()
            print("    A page can list its works in more than one block — measured on a real")
            print("    artist page: twenty imagesets and five CG works. Enter one number, or")
            print("    several separated by commas to treat them as one listing.")
            chosen = ask("    Which group(s)? [0] ")
            picked = [int(part) for part in chosen.split(",") if part.strip().isdigit()] or [0]
    else:
        picked = [card_index]
    bad = [index for index in picked if not 0 <= index < len(groups)]
    if bad:
        print(f"[ERROR] card group(s) {bad} are not among the {len(groups)} above")
        return 2
    # One row selector for the set, as the comma-separated list the runtime's selector
    # grammar already reads (`select_all` splits on commas and merges). The card that is
    # marked comes from the first block; the rows the rules are measured against come from
    # all of them, so a rule that only works in one block loses.
    # Every block the person chose, as one set: their cards in document order, each block
    # narrowed to the kind of link most of *its* members carry. Measured on a real search page
    # whose results were split across two column widths: with only the first block's cards, the
    # choosing page showed the later half of the results and the earlier half was never offered.
    # One parse for the whole choice: the set, the scope check below and the card that gets marked all
    # have to be the *same* elements, and two parses of one page give two sets of objects.
    from src.generic.htmltree import parse_html
    page_root = parse_html(pages[0][1])
    members: dict = {}
    for index in picked:
        for element in cards_of_group(pages[0][1], groups[index], root=page_root):
            members[id(element)] = element
    pick = sorted(members.values(), key=lambda element: element.order)
    if len(pick) < 2:
        print(f"[ERROR] {groups[picked[0]].selector} names {len(pick)} element(s); "
              "a listing needs a set")
        return 2
    group = dataclasses.replace(
        groups[picked[0]], count=len(pick),
        selector=", ".join(dict.fromkeys(groups[index].selector for index in picked)),
        scope=row_selector_for(page_root, groups[picked[0]], pick,
                               picked=[groups[index].selector for index in picked]))
    if len(picked) > 1:
        print(f"    treating {len(picked)} block(s) as one listing: {group.count} card(s)")

    # Which card is which, printed and then asked. Printed because a person should be able to
    # see the set without opening anything; asked through a page because *looking* at the covers
    # is how a person decides, and "the first card" is the right default rather than always the
    # right answer — measured on a real search page whose first album link belonged to a
    # recommendation block above the results.
    shown_cards = [dict(preview_of(dataclasses.replace(group, element=element)), index=index)
                   for index, element in enumerate(pick[:MAX_CHOICES])]
    if len(pick) > 1:
        print(f"    {len(pick)} card(s) in this set")
        for card in shown_cards[:3] + shown_cards[-1:]:
            print(f"        [{card['index']}] «{card['title'][:44]}»  {card['link'][:38]}")
        if len(shown_cards) > 4:
            print(f"        … {len(shown_cards) - 4} more, shown on the page …")
    if card_of_given:
        chosen = card_of
    elif len(pick) > 1:
        chosen = choose_card(pages[0][0], shown_cards)
        if chosen:
            print(f"    using card [{chosen}]")
    else:
        chosen = 0
    if not 0 <= chosen < len(pick):
        print(f"[ERROR] card {chosen} is not one of the {len(pick)} in this set")
        return 2
    card_of = chosen

    # The card the person marks becomes its own page, and is harvested and annotated by the
    # same code a work uses — the only difference is which field vocabulary the page shows.
    # The card the person saw in the listing: the detector's own representative, *not* the
    # first element its selector happens to match in document order. Measured on a real search
    # page, where the first `div.col-xs-6.col-sm-4` is an empty layout column and the real card
    # is further down — the mark landed on the empty one and the annotation page offered two
    # candidates, neither of them a work.
    marked = dataclasses.replace(group, element=pick[card_of])
    directory = session_directory(captures[0], "listing")
    capture = card_page(marked, pages[0][0])
    capture.write(directory / "capture.json")
    result = harvest(capture)
    result.write(directory / "candidates.json")
    print()
    print(f"    card  {group.selector}  (1 of {group.count})")
    print(f"    {len(result.candidates)} candidate(s) inside the card")
    print(f"    session {directory}")
    print(f"    opening the page (annotate); submit it to continue")

    # `last=True` and the listing vocabulary: the card is the whole annotation for this adapter, so
    # the page says "saved, go back to T³" instead of promising a next page that does not exist — and
    # it teaches the listing's own four tips rather than the work page's three.
    serve(Session(harvest=result, directory=directory, mode="annotate",
                  url=pages[0][0], fields=LISTING_FIELDS, vocabulary="listing", last=True))
    if not (directory / "annotations.json").is_file():
        print("    [WARN] nothing was submitted; the card teaches nothing")
        return 1

    sample = load_session(directory)
    learning = learn([sample], fields=LISTING_FIELDS)
    learning.write(directory / "learning.json")
    # One card from every other block the person included: their layout is not the marked
    # card's, so only their own card can say how a field is written there.
    extra = []
    for index in picked[1:]:
        other = groups[index]
        members = card_elements(pages[0][1], other.selector)
        if members:
            other_card = card_page(dataclasses.replace(other, element=members[0]), pages[0][0])
            print(f"    reading one card of block [{index}] for its own rules")
            extra.append((harvest(other_card), other.selector))
    rules = listing_rules(learning, group, pages, answers=sample.annotated, extra=extra,
                          work_url_pattern=learned_work_pattern(pages[0][0]))
    print()
    print("    what the card was learned as")
    for name, rule in rules.items():
        print(f"        {name:12} {json.dumps(rule, ensure_ascii=False)}")
    for note in learning.notes:
        print(f"    note: {note}")

    # The person marks the card's link; the id is the number inside it, and the narrowing happens
    # where the rule is chosen (`listing_rules._as_shipped`) so that what was measured over the cards
    # is exactly what ships. Narrowing it again here was the second home for one rule.
    if "source_id" not in rules and "source_id" in sample.annotated:
        # Said plainly, because the console used to claim the field "was not learned" when it
        # had been: what happened is that the rules it was learned as do not read the cards
        # the same way. Measured on a real page, one of its two blocks has a different layout.
        print(f"    [WARN] 作品 id 标了，但在 {len(pick)} 张卡上没有任何一条规则能同时读到它；")
        print("           两块布局不同时，先只装能读到的那部分，或者把两块分开各跑一次。")
    rule = rule_from(group, rules)
    for name in rule["_builder"]["missing"]:
        print(f"    [WARN] {name} was not learned; a listing needs it")
    findings = check_over_cards(rule, pages)
    for finding in findings:
        print(f"    [CHECK] {finding}")
    if not findings:
        print(f"    [CHECK] {len(pick)} card(s) read, ids distinct, "
              f"across {len(pages)} page(s)")

    pagination = pagination_from(pages)
    draft = {
        **draft_base(pages[0][0]),
        **listing_draft(host=urlparse(pages[0][0]).hostname or "",
                        kind=kind,
                        url_pattern=url_pattern_for(pages[0][0], pagination.page_param, kind),
                        rule=rule, pagination=pagination,
                        acquisition="browser" if browser else "http"),
    }
    draft_path = directory / "draft_listing.json"
    draft_path.write_text(json.dumps(draft, ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")
    print()
    print(f"    draft    {draft_path}")

    # The checks above read the *cards*, so they cannot see this: a target pattern that matches
    # none of the pages the rules were measured on. Such an adapter installs, reports success, and
    # then resolves through no code path at all.
    problem = target_pattern_problem(draft["targets"][kind]["url_pattern"],
                                     [url for url, _ in pages])
    if problem:
        print(f"\n[STOP] {problem}")
        print("       nothing was installed: a target that cannot match would be invisible.")
        return 1

    # The third leg of the plan's acceptance, for a listing: the reader an installed adapter uses
    # must produce the cards the Builder just marked — and it is asked **before** installing, which
    # is where the work builder asks its round trip and for the same reason. An adapter whose rule
    # reads nothing resolves through no code path, and installed it shadows whatever the site had:
    # measured on jable.tv's model page (2026-10-05), where the id rule read no card, the adapter
    # was written anyway, and the crawl that followed came back with 0 items. The draft is the file
    # the runtime is asked about, so what is measured is what would be installed, and a site the
    # tool has never seen fails here — loudly, at the terminal — instead of on the user's next run.
    installed, read = install_if_the_runtime_reads(draft, draft_path, pages[0][0], pages[0][1],
                                                   source=str(directory))
    if installed is None:
        # The commonest reason by far, and worth naming: a listing card with no id is dropped
        # by the reader, so nothing at all comes back.
        print("\n[STOP] the runtime read no cards from this page: a card with no id is dropped, so "
              "`作品 id` has to be marked")
        print("       nothing was installed: an adapter that reads nothing would shadow the site.")
        return 1

    print(f"=== installed {installed}")
    print(f"    try it:  python probe.py {pages[0][0]}")
    shadowed = json.loads((installed / "learned.json").read_text(encoding="utf-8")).get("adapter_beside")
    if shadowed:
        print(f"    note: this site already has a written adapter ({shadowed}), so the "
              "generated one is not the one in use")
    print(f"    the runtime reads {len(read)} card(s) from this page")
    for card in read[:3]:
        print(f"        {card.get('source_id')}  {str(card.get('title'))[:48]}")
    return 0


def install_if_the_runtime_reads(draft: dict, draft_path: Path, page_url: str, html: str,
                                 *, root: Path | None = None,
                                 source: str | None = None) -> tuple[Path | None, list]:
    """Install the draft, but only if the runtime reads cards from the page it was measured on.

    The order is the whole point: the work builder's round trip is asked before installing, so a
    draft whose two sides disagree never reaches the registry. A listing's equivalent question is
    "does the reader produce the cards the person marked", and asked after installing it is not a
    gate at all — the adapter is already on disk, shadowing the site's own, and the answer only
    reaches the terminal.

    Returns `(installed_directory, cards)`; the directory is None when nothing was installed, which
    is the caller's signal to stop rather than report success.
    """
    read = cards_as_read_by_the_runtime(draft_path, page_url, html)
    if not read:
        return None, []
    return install(draft, root or LEARNED_ROOT, source=source), read


if __name__ == "__main__":
    raise SystemExit(main())
