"""The site registry — the only supported way to add a site.

Every folder under one of the four adapter sources holding a ``site.json`` is a site. The
CLI never names a site in code: it asks this registry what exists, offers that list, and
dispatches to whatever the folder provides. Dropping in a new folder is therefore
the complete installation procedure, and no shared file changes.

The sources are the ones the distribution architecture prescribes (§15), and they live in
the SiteProbe home rather than beside this file: `<T³ user data>/siteprobe/` holds
`development/`, `local/`, `installed/` and `builtin/`, in that priority order (§17). A site
is data, so `load_fetcher` and `site_module` import it from the directory it sits in and
never from a package name.

This is also the seam a future unknown-site feature plugs into: it would
synthesise a template at runtime instead of reading one from disk, and every
downstream step would keep working unchanged.
"""

from __future__ import annotations

import importlib
import json
from functools import lru_cache
from pathlib import Path

from .template import SiteTemplate, TemplateError, load_template


class RegistryError(RuntimeError):
    """A site could not be named, found, or read.

    `code` is the machine-readable half of the same fact. A caller that must answer with a typed
    result — the JSON contract T³ drives (`src/generic/integration.py`) — cannot classify a failure
    by reading its sentence: the sentence is for a person, and it changes whenever it is worded
    better. The code is what a program branches on, so it is set where the failure is raised.
    """

    def __init__(self, message: str, code: str = "REGISTRY") -> None:
        super().__init__(message)
        self.code = code


# The four adapter sources of the distribution architecture
# (docs/siteprobe/siteprobe-adapter-distribution-architecture.md §15), highest priority first
# (§17): a development build covers everything, a person's own trained rules cover what was
# downloaded, and anything downloaded covers what shipped. `builtin` is the one that comes from
# the repository rather than the home (guidance §34).
SOURCES = ("development", "local", "installed", "builtin")


def user_data_dir() -> Path:
    """T³'s writable data root: `T3_DATA_DIR`, else `.data` under the server package.

    This is where `library.db` and `assets/` already live, which is the point: SiteProbe's own
    writable data then falls inside the root the person actually backs up and cleans (guidance
    §34) instead of living in a second one beside it. `T3_DATA_DIR` is resolved the way the server
    resolves it — against the server package, because that is the launcher's working directory
    (`T3.bat` switches to `apps/server`).
    """
    import os

    configured = os.environ.get("T3_DATA_DIR")
    here = Path(__file__).resolve()
    for base in (here.parents[2], here.parents[3]):
        server = base / "apps" / "server"
        if server.is_dir():
            return server / configured if configured else server / ".data"
    if configured:
        return Path(configured)
    return here.parents[2] / ".data"


def adapters_root() -> Path:
    """Adapters that ship with the tool, in the repository (guidance §34).

    Not user data: a shipped adapter is read-only code and is never copied into the home, so
    `builtin` is read from here while `development`, `local` and `installed` come from the home.
    """
    return Path(__file__).resolve().parents[2] / "adapters"


def adapter_root() -> Path:
    """Where this machine keeps its own adapters (guidance §34: `<T3_DATA_DIR>/siteprobe/`).

    Three ways to know, in order. `SITEPROBE_HOME` is what T³ passes when it starts the tool, so
    it wins. A `siteprobe.json` beside the tool names the home for anyone double-clicking a bat in
    a checkout, which is what keeps "the bat I ran" and "the T³ I started" on the same home —
    a relative path in that file is read against the file's own directory, not the caller's cwd.
    With neither, the home follows T³'s data root.
    """
    import os

    configured = os.environ.get("SITEPROBE_HOME")
    if configured:
        return Path(configured)
    here = Path(__file__).resolve()
    for base in (here.parents[2], here.parents[3]):
        setting = base / "siteprobe.json"
        if setting.is_file():
            import json

            try:
                home = json.loads(setting.read_text(encoding="utf-8")).get("home")
            except (OSError, ValueError):
                home = None
            if home:
                named = Path(home)
                return named if named.is_absolute() else (base / named)
    return user_data_dir() / "siteprobe"


def tool_roots() -> list[Path]:
    """Every root an adapter may live in, in the priority order of §17.

    `development`, `local` and `installed` are the person's own data under the home; `builtin`
    ships with the tool and is read from this repository (`adapters/builtin`), never from user
    data (guidance §34). Whatever exists is searched, in that order, and nothing else: measured
    with two copies of the same domains in place, every URL became ambiguous, and refusing to
    guess is the right answer.
    """
    base = adapter_root()
    roots = [base / "development", base / "local", base / "installed",
             adapters_root() / "builtin"]
    seen: list[Path] = []
    for root in roots:
        if root.is_dir() and root not in seen:
            seen.append(root)
    return seen


def discover(tool_directory: Path | None = None) -> list[SiteTemplate]:
    """Every site on disk, ordered by folder name so the menu is stable.

    A `site.json` that cannot be read is **skipped and remembered**, never raised. Discovery is how
    *every* site is found, so one unreadable file used to take the whole tool down: measured by
    leaving a file cut off mid-write (what a killed install leaves) beside a good one, `discover`
    raised `JSONDecodeError` and the good site was unreachable too, because the loop never returned.
    One adapter's problem stays that adapter's problem — `unreadable_sites()` names it and why, so a
    site that vanishes from the list can be explained rather than guessed at.
    """
    directories = [tool_directory] if tool_directory is not None else tool_roots()
    templates: list[SiteTemplate] = []
    unreadable: list[tuple[str, str]] = []
    for directory in directories:
        if not directory.is_dir():
            continue
        for path in sorted(directory.iterdir()):
            site_json = path / "site.json"
            if not (path.is_dir() and site_json.is_file()):
                continue
            try:
                templates.append(load_template(site_json))
            except Exception as error:  # noqa: BLE001 - any fault is this adapter's, not the run's
                unreadable.append((str(path), f"{type(error).__name__}: {error}"))
    _UNREADABLE[:] = unreadable
    return templates


@lru_cache(maxsize=1)
def registry() -> dict[str, SiteTemplate]:
    by_key: dict[str, SiteTemplate] = {}
    shadowed: list[tuple[str, str, str]] = []
    for template in discover():
        if template.key in by_key:
            # Two adapters for one domain is a duplicate, not a reason to stop working: the
            # architecture's order (§17) decides which one this map keeps, and the other stays on
            # disk for the targets it alone declares. Measured on a real gallery: the Builder
            # installed a learned adapter for a site this toolkit already reads, and from then on
            # *every* URL failed with "two site templates claim the key" — one builder session
            # taking the whole tool down with it.
            shadowed.append((template.key, str(template.directory),
                             str(by_key[template.key].directory)))
            continue
        by_key[template.key] = template
    _SHADOWED[:] = shadowed
    return by_key


_SHADOWED: list[tuple[str, str, str]] = []


def shadowed_sites() -> list[tuple[str, str, str]]:
    """Adapters that lost a key to another one, as (key, the one kept out, the one kept).

    Reported rather than dropped silently: a person who built a rule set needs to know both that
    it is there and which of the two answers a URL. Neither is unused — `resolve_input` picks by
    the targets each declares, and this map only answers "which site is this key".
    """
    return _SHADOWED


_UNREADABLE: list[tuple[str, str]] = []


def unreadable_sites() -> list[tuple[str, str]]:
    """Adapters discovery had to skip, as (folder, why), in the order it met them.

    The other half of `shadowed_sites`: an adapter that is on disk but cannot be read is invisible
    from every other surface, and "the site I built has disappeared from the list" is exactly the
    report that needs an answer. Whatever wrote the file was interrupted, or the disk was full —
    the site is not gone, its file is.
    """
    return _UNREADABLE


def site_keys() -> list[str]:
    return list(registry())


def get_for(key: str, kind: str | None = None) -> SiteTemplate:
    """The adapter for a site, preferring one that declares this target kind.

    Two adapters can carry the same key: a written adapter with every target, and a rule set
    learned for one of them. `get` answers "which site is this key" by the architecture's
    priority (§17) and may therefore hand back the narrower one — right for resolution, wrong for
    anything that needs a capability the narrow one does not declare. Measured on the recordings
    check, which read an `18comic.vip` template that had no work fields at all.
    """
    ranked = templates_for(key)
    if kind is not None:
        ranked = [t for t in ranked if kind in t.targets] or ranked
    if not ranked:
        raise RegistryError(
            f"unknown site {key!r}; known sites: {', '.join(site_keys()) or '(none)'}",
            "UNKNOWN_SITE",
        )
    return ranked[0]


def templates_for(key: str) -> list[SiteTemplate]:
    """Every adapter that carries this key, best first — both of them, when there are two.

    The key alone does not name one adapter: a rule set learned for a site's listing page carries
    the same key as the written adapter that reads its work pages, and the architecture's order
    puts the learned one first. Callers that need something the first one may lack (`get_for`,
    `get_with_module`, and the report `--list-sites` prints) ask here instead of using `get`.
    """
    return sorted((template for template in all_templates() if template.key == key),
                  key=source_rank)


def site_identity(key: str) -> dict[str, str]:
    """A site's own name, export group and source id, taken from whichever file says something.

    These three are properties of the **site**, but they are read off a file: `display_name`,
    `export_group` and `source_site` come from whichever `site.json` the loader was given, and a rule
    set the Builder learned writes the key back into all three as placeholders
    (`local/18comic_vip`: `display_name: "18comic.vip"`, `export_group: "18comic.vip"` — measured).
    So asking the key-priority file answers with the placeholder, and two files of one site disagree
    about where that site's exports live: the learned one wrote `export/18comic.vip/` while the
    written adapter wrote `export/18comic_vip/`, which is also the group the hand-written tools used.
    A value equal to the key therefore counts as undeclared, and §17's layer order decides among the
    files that say something real.
    """
    templates = templates_for(key)
    if not templates:
        raise RegistryError(
            f"unknown site {key!r}; known sites: {', '.join(site_keys()) or '(none)'}",
            "UNKNOWN_SITE",
        )
    return {field: _declared(templates, field)
            for field in ("display_name", "export_group", "source_site")}


def _declared(templates: list[SiteTemplate], field: str) -> str:
    """The first value for `field` that is not the key, else the first declared, else the attribute."""
    fallback: str | None = None
    for template in templates:
        declared = template.raw.get(field)
        if not isinstance(declared, str) or not declared:
            continue
        if declared != template.key:
            return declared
        fallback = fallback or declared
    return fallback or getattr(templates[0], field)


def reader_for(key: str) -> SiteTemplate:
    """The adapter of `key` that can read a **work** page, not merely list one.

    A selection names its site by key, and one key can carry two files: the written adapter that
    reads work pages, and a rule set learned from one of that site's *listings* — which declares the
    same key and outranks it under §17. `get` answers the key, so downloading a review selection read
    the works through an adapter whose `work.fields` is empty: measured on this machine for all three
    sites that have both files (0 work fields against 11/13/11), so every record would have been
    dropped as incomplete while the run reported success. The capability is the tie-breaker here,
    exactly as it is in `resolve_input`.
    """
    candidates = templates_for(key)
    if not candidates:
        raise RegistryError(
            f"unknown site {key!r}; known sites: {', '.join(site_keys()) or '(none)'}",
            "UNKNOWN_SITE",
        )
    for template in candidates:
        if template.work_fields:
            return template
    return candidates[0]


def get_with_module(key: str, name: str) -> SiteTemplate:
    """The adapter for a site that actually ships this module, in the architecture's order.

    The same problem as `get_for`, one level down. A step of a site's own is a file beside the
    adapter, so "a site may ship this" is a fact about a file rather than a declared target: a rule
    set learned for 18comic's search page carries the same key as the written adapter that owns
    the preview repair and ships none of it, and §17 puts the learned set first. Measured on a real
    door — `修复预览图.bat` became unable to find a step that was sitting on disk.
    """
    candidates = sorted((template for template in all_templates() if template.key == key),
                        key=source_rank)
    if not candidates:
        raise RegistryError(
            f"unknown site {key!r}; known sites: {', '.join(site_keys()) or '(none)'}",
            "UNKNOWN_SITE",
        )
    for template in candidates:
        if (template.directory / f"{name}.py").is_file():
            return template
    searched = ", ".join(str(template.directory) for template in candidates)
    raise RegistryError(
        f"no adapter of {key!r} ships a {name!r} step; searched {searched}",
        "NO_MODULE",
    )


def get(key: str) -> SiteTemplate:
    try:
        return registry()[key]
    except KeyError:
        raise RegistryError(
            f"unknown site {key!r}; known sites: {', '.join(site_keys()) or '(none)'}",
            "UNKNOWN_SITE",
        ) from None


def url_preference(template: SiteTemplate, url: str) -> tuple[bool, bool, int]:
    """How well one adapter answers one URL, best first — the one rule both doors use.

    Two adapters can cover one site (a written adapter and a rule set learned for one of its pages),
    and the layer order alone put the *learned* one in front: a rule set with no work fields, which
    then read nothing — measured on a real album, where `installed/comic18` reads 11 work fields
    while `local/18comic_vip` declares a search and nothing else. So:

    1. an adapter that declares a target **matching this URL** beats one that only shares the host;
    2. of those, one that can actually **read** what it matched beats one that cannot — a
       single-work target in an adapter with no work fields reads nothing;
    3. and only then does the layer decide (architecture §17).

    The layer stays the last word on purpose: "my own rules cover the downloaded version" is still
    the right answer when two adapters *can* both read the same thing.
    """
    matched = template.match_target(url)
    if matched is None:
        return (True, True, source_rank(template))
    return (False, not answers_kind(template, matched[0]), source_rank(template))


def answers_kind(template: SiteTemplate, kind: str) -> bool:
    """Whether an adapter that declares `kind` could answer an address of it. One rule, both doors.

    With an address in hand (rule A) the first half is already settled \u2014 a kind only comes back from
    a target that matched. The menu asks the same question with no address, so it has to ask both:

    * the target must be able to **claim** an address at all: a pattern with no capturing group
      matches nothing (`TargetRule.match` answers None), which is what the three learned shells in
      `local/` did while every address went to the written adapter beside them;
    * and it must be able to **read** what it claimed: a single-work target with no work fields reads
      nothing. A listing target is read by the learned rules themselves, so declaring it is the whole
      promise.
    """
    rule = template.targets.get(kind)
    if rule is None:
        return False
    if rule.url_pattern is None or rule.url_pattern.groups == 0:
        return False
    return bool(template.work_fields) if rule.single else True


def adapter_for_kind(templates: list[SiteTemplate], kind: str) -> SiteTemplate:
    """Of the adapters declaring one kind, the one resolution would use — the same rule, no address.

    A menu has no URL to match against, so only the first two halves of `url_preference` can be asked
    here, and that is exactly what "who answers this kind" means: the one that can read it, and only
    then the layer (§17).
    """
    declaring = [template for template in templates if kind in template.targets]
    return min(declaring, key=lambda template: (not answers_kind(template, kind),
                                               source_rank(template)))


def site_for_url(url: str) -> SiteTemplate | None:
    """The site that should read this URL, chosen by the same rule `resolve_input` uses.

    Asking "which site is this URL" must not answer with an adapter that cannot read it; this used
    to return whichever `registry()` kept, which for a listing-only rule set is a site with no work
    fields at all.
    """
    matches = [template for template in all_templates() if template.is_host(url)]
    if not matches:
        return None
    return min(matches, key=lambda template: url_preference(template, url))


def source_rank(template: SiteTemplate) -> int:
    """Which layer of the architecture this adapter came from, as a sort key.

    Read off the directory the adapter sits in, so it works for a shipped `builtin` adapter in
    the repository exactly as it does for one under the home.
    """
    name = template.directory.parent.name
    return SOURCES.index(name) if name in SOURCES else len(SOURCES)


def forget_adapters() -> None:
    """Drop the cached key -> adapter map.

    `registry()` caches one home's worth of adapters for the life of the process, which is right for
    a run and wrong for a test that points `SITEPROBE_HOME` somewhere else: the cache would answer
    with the previous home's sites and the next test would read a world that no longer exists.
    Nothing in the product needs this; a test that changes the home does.
    """
    registry.cache_clear()


def all_templates() -> list[SiteTemplate]:
    """Every adapter on disk, keyed or not.

    `registry()` answers "which site is this key", and collapses two adapters for one domain to
    the first found — which is how a rule set learned for a site came to hide the written adapter
    that actually covers its work pages. Resolution needs the *whole* set, so it asks here.
    """
    return discover()


def resolve_input(raw: str) -> tuple[SiteTemplate, str, dict[str, str]]:
    """Decide which site and which target kind an input names.

    A URL is matched against every site's target patterns; a bare string is
    offered to sites that accept a name (hitomi's artist). Ambiguity is an error
    rather than a guess, because crawling the wrong listing silently is exactly
    the failure the whole tool exists to avoid.
    """
    text = raw.strip()
    if not text:
        raise RegistryError("no input given", "INVALID_INPUT")

    is_url = "://" in text
    matches: list[tuple[SiteTemplate, str, dict[str, str]]] = []
    if is_url:
        ranked: list[tuple[tuple[bool, bool, int], SiteTemplate, str, dict[str, str]]] = []
        for template in all_templates():
            matched = template.match_target(text)
            if matched is None:
                continue
            kind, info = matched
            ranked.append((url_preference(template, text), template, kind, info))
        if ranked:
            # More than one adapter may cover the same URL — a written adapter and a rule set learned
            # for the same site. `url_preference` settles it: the one that can read this URL first,
            # the layer last; only a tie on all three is left ambiguous, which is where guessing
            # would be wrong.
            best = min(preference for preference, *_ in ranked)
            ranked = [row for row in ranked if row[0] == best]
        matches = [(template, kind, info) for _preference, template, kind, info in ranked]
    else:
        for template in all_templates():
            for kind, rule in template.targets.items():
                if rule.accepts_name:
                    matches.append((template, kind, {"id": text}))

    if not matches:
        if is_url:
            raise RegistryError(
                f"no site claims {text!r}. Known sites: {', '.join(site_keys()) or '(none)'}",
                "NO_MATCH",
            )
        raise RegistryError(
            f"{text!r} is neither a recognized URL nor a name any site accepts",
            "INVALID_INPUT",
        )
    if len(matches) > 1:
        described = ", ".join(f"{template.key}:{kind}" for template, kind, _ in matches)
        raise RegistryError(
            f"{text!r} is ambiguous ({described}); pass --site to choose", "AMBIGUOUS"
        )
    return matches[0]


def site_module(template: SiteTemplate, name: str):
    """One of an adapter's own modules, loaded from the directory it lives in.

    `fetch` is the reader every site must have; a site may also ship its own steps —
    18comic's `repair_scramble` is one — and a step is called the same way, by directory,
    because an adapter is data in the SiteProbe home and not a package installed beside the
    tool. The directory's parent goes on `sys.path` for the import, which is what keeps an
    adapter's own siblings working whether it imports them relatively
    (`from .image_scramble import …`) or by name.
    """
    path = template.directory / f"{name}.py"
    if not path.is_file():
        raise RegistryError(
            f"site {template.key!r} ships no {name!r} step: {path} does not exist",
            "NO_MODULE",
        )
    module_name = f"{template.directory.name}.{name}"
    import sys

    root = str(template.directory.parent)
    if root not in sys.path:
        sys.path.insert(0, root)
    try:
        return importlib.import_module(module_name)
    except ImportError as error:
        raise RegistryError(
            f"site {template.key!r} has a {name!r} module that does not import "
            f"({module_name}): {error}",
            "NO_MODULE",
        ) from error


def load_fetcher(template: SiteTemplate):
    """The site's reader: its own fetch module, or the declarative one.

    A site that ships no `fetch.py` is read from its `site.json` alone, which is what
    lets a generated adapter be a config file. A `fetch.py` that exists and does not
    import stays a loud error — the fallback is for the *absence* of a module, not for
    a broken one.
    """
    if not (template.directory / "fetch.py").is_file():
        from . import declarative

        return declarative
    return site_module(template, "fetch")


def describe_sites() -> list[dict[str, object]]:
    """What the CLI prints for `--list-sites`, and what the picker shows."""
    described: list[dict[str, object]] = []
    for template in registry().values():
        described.append({
            "key": template.key,
            "display_name": template.display_name,
            "export_group": template.export_group,
            "hosts": template.hosts,
            "targets": [
                {"kind": kind, "label": rule.label, "accepts_name": rule.accepts_name}
                for kind, rule in template.targets.items()
            ],
        })
    return described


def summarize_site(template: SiteTemplate) -> str:
    targets = ", ".join(
        f"{kind}({rule.label})" + ("[name]" if rule.accepts_name else "")
        for kind, rule in template.targets.items()
    )
    return f"{template.key:<16} {template.display_name:<12} {targets}"


def ensure_site_manifest(template: SiteTemplate) -> dict:
    """The site's own manifest declaration, reused by the export writer."""
    manifest = template.raw.get("manifest")
    if not isinstance(manifest, dict):
        raise TemplateError(f"{template.key}: site.json has no 'manifest' section")
    return manifest


def dump_sites() -> str:
    return json.dumps(describe_sites(), ensure_ascii=False, indent=2)
