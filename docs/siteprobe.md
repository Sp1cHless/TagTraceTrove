# SiteProbe — consolidated board document

> **What this file is.** The single durable reference for SiteProbe, the built-in site-crawling
> tool of T³. It absorbs the technical content of the former `docs/siteprobe/*` set plus the
> "B. Source 失效维护" half of `docs/relation-source-maintenance-offline-plan.md`. It keeps
> final results, contract shapes, hard-won rules and measured facts; it drops the phase-by-phase
> fix churn, intermediate timestamps and superseded plan wording.
>
> **Where the tool lives.** The canonical tool directory is `<T3>/siteprobe/` (the repository's
> top-level `siteprobe/` Python subtree), with `src/generic/` (runtime/core) and `src/builder/`
> (Candidate Harvester / Adapter Builder), root entry scripts `build_adapter.py`,
> `build_listing.py`, `learn.py`, `verify_adapter.py`, `doctor.py`, and the human/CI gates
> `verify_doors.py`, `verify_against_recordings.py`, `check_adapter.py`. Source material used to
> write this board: `siteprobe-index.md`, `siteprobe-completion-plan.md`,
> `siteprobe-adapter-distribution-architecture.md`, `t3-siteprobe-architecture-guidance.md`,
> `siteprobe-t3-integration-plan.md`, `siteprobe-integration-handoff.md`,
> `siteprobe-generic-adapter-hardening-execution-plan.md`, `generic-site-probe-plan.md`,
> `b-advanced-import-plan.md`, `UI.md`, `siteprobe-execution-log.md`, and
> `relation-source-maintenance-offline-plan.md`. All of those retired source documents — including
> the append-only `siteprobe-execution-log.md` — are archived byte-identically under
> `.hermes/archive/docs-pre-consolidation/docs/`. The log's durable conclusions are kept in §13.

---

## Table of contents

1. [What SiteProbe is, and the T³ boundary](#1-what-siteprobe-is-and-the-t3-boundary)
2. [The two halves: per-site crawl vs generic pipeline](#2-the-two-halves-per-site-crawl-vs-generic-pipeline)
3. [Adapter contract, package and the Repository/Package/Installed model](#3-adapter-contract-package-and-the-repositorypackageinstalled-model)
4. [Adapter sources, registry, priority, install/uninstall/update](#4-adapter-sources-registry-priority-installuninstallupdate)
5. [The Builder: annotate → learn → verify/install → probe, and the listing builder](#5-the-builder-annotate--learn--verifyinstall--probe-and-the-listing-builder)
6. [Learned-rule semantics and field shapes](#6-learned-rule-semantics-and-field-shapes)
7. [The generic pipeline and its measured limits (Levels A–D)](#7-the-generic-pipeline-and-its-measured-limits-levels-ad)
8. [Source maintenance ("B" half) and its DB tables](#8-source-maintenance-b-half-and-its-db-tables)
9. [T³ integration: machine interface, commands, UI entry points](#9-t3-integration-machine-interface-commands-ui-entry-points)
10. [Data root, settings, environment quirks](#10-data-root-settings-environment-quirks)
11. [Test, fixture and gate strategy](#11-test-fixture-and-gate-strategy)
12. [Durable findings & rules index](#12-durable-findings--rules-index)
13. [Phase history, acceptance, and consciously-stopped limits](#13-phase-history-acceptance-and-consciously-stopped-limits)
14. [Generic-adapter hardening (2026-10-11) — the current runtime architecture](#14-generic-adapter-hardening-2026-10-11--the-current-runtime-architecture)

---

## 1. What SiteProbe is, and the T³ boundary

T³ is a **content-neutral, local-first personal collection/media manager**. SiteProbe is its
official subsystem, engineering-sized enough to stand alone:

> **SiteProbe turns web pages into standard structured entries for T³** — an extensible
> acquisition system, not a scraper for one kind of content, not a crawler collection for a few
> sites, and not a scatter of per-site `if/else` inside T³.

The relationship:

```
T³
├── Library / DB / Taxonomy / Collections / Import UI
└── SiteProbe
    ├── Generic Capture (Level 0)
    ├── Adapter Runtime
    ├── Adapter Builder (Level 1)
    ├── Candidate Harvester
    ├── Review / Selection
    └── Adapter Contract
```

### 1.1 The architectural boundary (must hold long-term)

```
T³ Core            does not know how any specific site is crawled
SiteProbe Core     does not know what the content domain is
Adapter            only knows its own domain / page structure
T³ Database        only consumes normalized results
```

Forbidden: `if site == ...` in T³ core; `if site == ...` in SiteProbe generic; a
`specific_site_special_field` in the DB schema.

### 1.2 Responsibility split

**T³ owns** (guidance §16.1): the user library, DB, entry lifecycle, taxonomy, collections, the
import transaction, the final business rules for duplicate resolution, user permissions/settings,
the main UI, app-level features such as the clipboard, and the (future) adapter-management entry.

**SiteProbe owns** (guidance §16.2): URL/domain detection, adapter matching, page acquisition,
the Adapter Builder, listing/search, review, selection, media fetch/validation, export, site
origin/source metadata, crawl-side state, and adapter validation.

**An Adapter owns** (guidance §16.3): its site's URL rules, DOM/API structure, listing, field
mapping, special fetching, and special media logic.

### 1.3 SiteProbe never controls the T³ DB

The long-term rule is `SiteProbe → standard output → T³ import/commit`, never
`SiteProbe → write T³ tables`. Reasons: standalone testability; SiteProbe remains a true
subsystem; adapters get no DB permission; exactly one import entry point; schema changes do not
force every adapter to change. The transport is not fixed by the architecture (subprocess JSON,
local API, IPC are all allowed), but it must not bypass the `ImportBatch → commit` boundary.

The realized boundary: SiteProbe exports files; `apps/server/src/import/site-probe.ts` converts
them to the `ImportBatch` defined in `packages/shared/src/schemas/import.ts`, and
`apps/server/src/import/commit.ts` is the single library commit entry point. SiteProbe does not
connect to the T³ database.

**Crawl state ≠ library state** (guidance §29). SiteProbe crawl state records what was crawled,
inventory, cursor, and duplicate-download avoidance. T³ DB state records which entries are
committed, source-id → entry, duplicate detection, and library history. Neither replaces the
other.

### 1.4 Standard output contract (neutral shape)

SiteProbe outputs content-neutral data; the concrete schema follows the shared schema, but the
contract uses work/media abstractions, never a site-specific field as the root:

```json
{
  "source": { "site": "example-site", "url": "https://example.com/work/1", "source_id": "1" },
  "work":   { "title": "...", "creator": [], "date": null, "tags": [], "media": [] },
  "origin": { "adapter_id": "example-site", "adapter_version": "1.2.0" }
}
```

Every import result should retain: adapter id, source site/domain, source work id, source URL,
and adapter version. That makes URL-shape changes still deduplicate, adapter upgrades traceable,
and failures attributable to the rule version that produced the data.

### 1.5 Adapter capabilities and "supported" as capability + health

An adapter should not just say `supported = true/false`. It declares capabilities:
`single_work`, `search`, `creator_listing`, `collection_listing`, `review`, `incremental`,
`authentication`, `custom_media`. The T³/SiteProbe UI derives which choices to show from
capabilities. In this codebase the capability-driven UI is currently **substituted by
`targets[kind]`** (`single`, `accepts_name`, `label`): `adapter.json` is written but has no
reader yet, and `capabilities` has no vocabulary or consumer — this is deliberately deferred to
the "freeze the adapter contract" step (guidance §28 Step 2/4). "A site is supported" should
eventually become `single_work: stable`, `search: stable`, `listing: experimental`,
`last_verified: date`.

---

## 2. The two halves: per-site crawl vs generic pipeline

The founding question was whether "read a page's information" and "crawl pages and save them"
can be separated with the saving half generic. **Yes** — the generic half already existed; what
was missing was a declarative front half.

Two halves:

| Stage | Location | Generic? |
|---|---|---|
| Login, paging, anti-bot, fetch the raw page | adapter's `fetch.py` | site-specific |
| Raw document → standard fields | adapter `site.json` + `src/generic/` | generic engine |
| review page → selection | `src/generic/review.py` | generic |
| selection → download only selected → export | `src/generic/selection.py` | generic |
| incremental crawl state | `src/generic/crawl_state.py` | generic |

Fetching deliberately stays outside T³ proper: the guardrails forbid web-wide crawling inside
the product, T³ has no HTTP client, no SSRF surface and no headless browser, and the crawler
stays a **dumb fetcher** that dumps raw documents per URL. T³/SiteProbe owns the interpretation,
so per-site knowledge stays versioned, fixtured and reviewable in this repo.

The site interface contract lives in `src/generic/site_api.py`:

```
read_work(template, url, options) -> RawItem      # required
list_work_urls(template, kind, ref, options)      # optional: enumerate
list_cards(template, kind, ref, options)          # optional: cards with title/cover, for review
scan_review(template, kind, ref, options)         # optional: the site's own review (hitomi)
export_selection(template, path, options)         # optional: the site's own selection export (hitomi)
```

- `read_work` is the only required primitive: given a work URL, produce that work's raw document.
- `scan_review` / `export_selection` exist only for hitomi (its own original code).
- Registry discovery is from disk: as many `site.json` as exist are as many sites.

### 2.1 Reusable machinery already present

`commit.ts` is fully site-agnostic: `commitImportBatch(database, batch, mapping)` knows nothing
about any specific site. Site-specific assumptions historically lived in `site-probe.ts` (three
hand-written item schemas and three adapters). `ImportEntry.fields` is a plain record and
`commit.ts` requires every *present* field to be mapped or ignored, so a site without a
work-type field simply produces no key — the hardcoding was an artifact, not a model limitation.

The listing half already had a working general engine for HTML search: the differential-
extraction idea (search once with a probe keyword and once with a nonce, group anchors by URL
signature, keep the group present under the probe but absent under the nonce) is a technique to
extend, not invent.

---

## 3. Adapter contract, package and the Repository/Package/Installed model

### 3.1 The three-layer model (most important distinction in distribution)

1. **Source Repository** — developer/maintainer form: a Git repo holding `registry.json`,
   `adapters/<site>/`, and tooling. Normal T³ users do not clone it.
2. **Adapter Package** — the distribution unit: one site per zip, e.g.
   `site-a-1.4.2.zip`, containing `adapter.json`, `site.json`, optional `fetch.py`, `README.md`.
   A user downloads only what they need.
3. **Installed Adapter** — what Runtime actually scans: `builtin/`, `installed/`, `local/`
   under the SiteProbe home, regardless of which Git repo it came from.

Repository is the developer organization; **Package is the普通用户 distribution unit.**

### 3.2 Two adapter forms

- **Declarative adapter** — only `adapter.json` + `site.json`; runs the Core's generic engine;
  lower risk. The Builder defaults to this.
- **Executable adapter** — additionally ships `fetch.py`, i.e. installing it executes
  third-party code. The install UI must clearly warn: *"This adapter contains executable
  code."* Future trust/signature/sandbox/permission models are possible, but an executable
  adapter must never be treated as plain JSON silently.

`fetch.py` is only for behavior that cannot be declarative: special login/session, special API,
required browser interaction, non-standard pagination, special media handling, request signing,
and other site mechanics. **If `site.json` can express it, do not write Python.**

### 3.3 `adapter.json` (package manifest) vs `site.json`

`adapter.json` is package metadata only, never extraction rules:

```json
{
  "id": "site-a",
  "name": "Site A",
  "version": "1.4.2",
  "domains": ["example.com"],
  "schema_version": 1,
  "minimum_siteprobe_version": "1.2.0",
  "type": "executable",
  "content_classification": "general",
  "capabilities": ["single_work", "search"]
}
```

`type` distinguishes at least `declarative` and `executable`. Extensible fields: `homepage`,
`license`, `maintainer`, `description`, `update_channel`.

`site.json` continues to carry what the runtime actually needs — `key`, `display_name`, `tool`,
`source_site`, `export_group`, `media_id_prefix`, `hosts`, `targets`, plus `extraction`/`listing`/
`manifest`/`naming`/`review`/`session` rules. When `domains`/`capabilities` can be derived from
`hosts`/`targets`, do not keep a second source of truth; if a registry caches them the validator
must check both sides agree.

An Adapter Package is a complete self-contained directory:

```
example-site/
├── adapter.json
├── site.json
├── fetch.py          # optional
├── README.md
└── tests/
```

### 3.4 Versioning

At least three versions must be distinguished: T³ version (`T3 1.x`), SiteProbe contract/schema
version (`siteprobe_schema = 1`), and adapter version (`adapter 1.4.2`). The manifest declares
`minimum_siteprobe_version` and `schema_version`, so a site fix does not require a new T³
release. Adapter release updates `site adapter 1.2.3`; a site changing one selector must not
force a whole T³ release.

### 3.5 What a package needs versus what a site rule needs

Adapter contract freeze (guidance §28 Step 2) must pin down: adapter metadata, `site.json`
schema, the optional `fetch.py` API, capabilities, and output schema. `site.json` currently has
no `schema_version` and the loader does not validate one; freezing should add a top-level integer
`schema_version` (first version = 1) and make the loader fail loudly on an unknown major rather
than guessing config shape from tool version.

### 3.6 The Builder's local output is the same package

The Level-1 Builder writes `local/<domain>/` with `adapter.json` + `site.json` (and no Python by
default). A user who later hand-extends it with `fetch.py` still has the same package kind. To the
runtime, `builtin` / external / local-generated / developer adapters differ only in `origin`,
`trust`, and `update policy` — never in extraction API.

### 3.7 Repository dependency is one-way

```
TagTraceTrove → SiteProbe Core → Adapter Contract ← external adapters
```

An adapter repo may depend on schema/contract/test-kit, but **SiteProbe Core must never import
an external adapter**. This is enforced by the mandatory architectural test:

> remove/disable every real adapter, then require: T³ build passes, SiteProbe core tests pass,
> generic capture passes, Adapter Builder passes, neutral fixtures pass.

If that fails, Core is polluted by site code. (At the last measured baseline this invariant was
**red** — deleting the three real adapters broke contract/discovery/recording tests — and the
plan is to build neutral fixtures first, then make Core CI green without real adapters.)

### 3.8 Safety and trust boundary

Executable adapters run third-party code. Registry downloads must **never execute registry
content**: `download registry JSON → inspect metadata → user installs → download package →
verify → unpack → runtime loads`. Not `download registry → execute what it returns`.

Package integrity: prefer SHA-256 per package; install is `download → hash → compare → unpack`.
Future cryptographic signing can be added. Sensitive/age-restricted adapters must not silently
land: even when a URL obviously belongs to a supported site, do
`detect compatible adapter → prompt user → user explicitly installs`, never `detect domain →
auto-download`. Installation is an explicit operation. The install UI shows at least adapter
name, source, version, declarative/executable, and capabilities.

T³ Core must contain **no site list**. Forbidden: `SENSITIVE_SITES = [...]`, `if adult_mode`,
`siteprobe/adult/`. Core understands only Adapter, Adapter Source, Capability, Trust. Content
classification belongs in adapter metadata / distribution policy (e.g.
`"content_classification": "restricted"`), used for UI filter, source policy and user preference
— never to change the generic runtime code path.

---

## 4. Adapter sources, registry, priority, install/uninstall/update

### 4.1 Adapter Source abstraction

T³/SiteProbe Core must not hard-code `general adapters` / `adult adapters`. The general
abstraction is an **Adapter Source** providing registry metadata, package locations, versions,
hashes and capabilities. Core understands only: `add_source`, `remove_source`, `refresh_source`,
`search_adapter`, `install_adapter`, `update_adapter`. Core does not need to know what content a
source holds. Content type is adapter metadata or the Source's own matter, not runtime branching.

Default T³ may configure only an "Official General Adapter Source", or initially no remote source
at all — just Generic Capture and the Adapter Builder. Users add sources only when they need
other support. A sensitive source must be user-added/enabled; T³ Core is unaware that any
NSFW adapter repository exists.

### 4.2 Runtime adapter roots

Runtime supports four roots:

```
builtin        ships with T³: generic, neutral demonstration adapters, a very few content-neutral builtin adapters
installed      downloaded via an Adapter Source
local          generated by the Level-1 Builder (per-user, git-ignored)
development    mounted for dev/debug; not relied on by a release
```

All four use the **same contract**. Runtime scans roots uniformly:
`adapter roots → adapter.json → domain / capabilities / version`, and to Runtime they are all
just "Adapter". `builtin` is read-only code shipped with the program and lives in the repository
(`siteprobe/adapters/builtin/`), not in user data. `development` is mounted by an explicit dev
path. The registry merges builtin/installed/local/development, but `cache`, `sessions`, `export`,
cookies and browser profiles always stay under the data root and are explicitly managed by backup
and cleanup policy.

**Registry status states**: Available, Installed, Update available, Disabled, Broken,
Incompatible. For a URL: installed match, available match, generic fallback.

### 4.3 Priority — ability first, layer as tiebreak

The conceptual layer order (distribution doc §17) is:

```
development > local > installed > builtin > generic
```

Rationale: a dev build should be able to override a release; user-trained rules can override a
downloaded version; installed is easier to update than builtin; generic is always the last
fallback.

**But the final, implemented rule (user-decided "A") is ability-first, layer-as-tiebreak.** Three
entry points ask "who reads this URL" and they must agree:

1. an adapter that **declares this URL's target** beats one that only shares the host;
2. among those, one that **can actually read** beats one that cannot (a single-work target needs
   `work.fields`);
3. only then does §17's layer order decide (`development > local > installed > builtin`).

Layer stays last on purpose: "my own trained rule overrides the downloaded version" is still the
right answer.

Implementation (all in `src/generic/registry.py`):

- `answers_kind(template, kind)` — the single definition. Two things must both hold: (a) the
  target can **declare** an address (`url_pattern` has a capture group, otherwise `match` always
  returns `None`); and (b) it can **read** it (a single target needs `work.fields`; a listing
  target is read by the learned rule itself, so declaration is a promise). With a URL in hand,
  (a) is guaranteed by matching, so one function serves both doors.
- `url_preference(template, url) -> (matched_is_none, not_reads, source_rank)`; `site_for_url`
  becomes `min(matches, key=url_preference)`; `resolve_input` sorts by the same key and treats
  only ties as ambiguous.
- `adapter_for_kind(templates, kind)` — the menu has no URL, so it can ask only the first two
  halves; `targets[].source` in the sites menu now reports the layer that will answer, not "the
  first that declared it". `accepts_name` stays a union (if a site can turn a keyword into a
  search address that is its capability; hiding it would present an input the resolver then
  rejects).

Historical shells (the `local/18comic_vip`, `hanime1_me`, `hitomi_la` listing drafts with empty
`work` and capture-group-less patterns) shadowed the three installed adapters in the key map while
matching no URL at all; they were retired byte-identically into
`retired/empty-listing-shells-2026-10-08/` (SHA-256 compared before/after; reason, who was
shadowed, and how to restore written into that directory's `README.md`), then deleted from
`local/`. `retired/` is not in `tool_roots()`. `local/buondua_com` is the same shape but has no
installed counterpart, so retiring it would only remove a menu key — left in place for the user
to decide.

### 4.4 Discovery and per-site identity

- `discover()` / `tool_roots()` scan the roots; a partial/broken `site.json` must not take down
  the whole registry (a load error is contained per adapter).
- `site_module` loads an adapter as a plain directory: it puts the adapter's parent dir on
  `sys.path` and imports `<dirname>.<module>`; PEP 420 namespace packages suffice (the old empty
  `__init__.py` markers were removed).
- `reader_for(key)` picks the adapter that **can read a work page** (not just `get(key)`), used
  when downloading a selection — otherwise a listing-only rule set (with empty `work.fields`)
  silently discards the whole record set while reporting success.
- `site_identity(key)` treats `display_name` / `export_group` / `source_site` as **site**
  attributes; because the Builder wrote the key verbatim into those fields, a value equal to the
  key is treated as "not declared". `export_layout.site_root` uses it too (otherwise one site
  would get two export trees).
- `runner.resolve`'s `--site` branch uses `get_for(key, kind)`, so a menu that just told the UI
  "this site can read album" does not then resolve to the learned rule set that only declares
  `search`.
- `shadowed_sites()` reports a three-tuple (key / who is shadowed / who is effective) so
  `--list-sites` can name each adapter's role instead of mislabelling the hand-written installed
  adapter as "a rule set learned for this site".

### 4.5 Install / uninstall / update flow

Install: `download single adapter package → verify → unpack into installed/ → reload adapter
registry → re-match URL → run adapter`.

Update: Runtime can `refresh enabled sources` and compare `installed site-a 1.4.2` vs
`source latest 1.4.3`, showing "Update available"; the user updates. A site changing a selector
must not trigger a whole T³ release.

Uninstall: `delete installed/<adapter>` must not delete imported T³ data, not delete a user
`local` adapter, and not affect other adapters. Adapter and library-data lifecycles are separate.

Deleting a source does **not** auto-uninstall adapters installed from it; recommendation:
`Source removed / installed adapters remain / no future updates` unless the user uninstalls.
Adapter update only changes how future crawls work; it must never automatically rewrite existing
T³ data (any future re-fetch/reconcile is a separate flow).

**Local adapters must not be overwritten by remote**: if `local/example.com` and
`installed/example.com` both exist, prefer `local` and clearly tell the user an override exists.

### 4.6 Offline behavior

With no network, `builtin` / `installed` / `local` must all run. Adapter Sources only affect
discovery, install and update — they must not become a per-crawl hard dependency.

### 4.7 Registry schema (design)

```json
{
  "schema_version": 1,
  "adapters": {
    "site-a": {
      "name": "Site A", "version": "1.4.2", "domains": ["example.com"],
      "capabilities": ["single_work", "search", "creator_listing"],
      "package": "releases/site-a-1.4.2.zip", "sha256": "...",
      "minimum_siteprobe_version": "1.2.0"
    }
  }
}
```

`sources.json`:

```json
{ "sources": [
  { "id": "official-general", "registry": "...", "enabled": true },
  { "id": "user-source-1",     "registry": "...", "enabled": true }
] }
```

Core must not carry `source_type = adult`; content classification belongs in adapter metadata or
the source itself, never runtime branching.

### 4.8 CI/Release for an adapter repo

`PR → contract validation → fixture tests → package build → hash → release → registry update`.
Do not hand-maintain a pile of zips. GitHub repo is for source/issue/PR/CI/release; the release
asset is the per-site package and the registry points at it. Git submodules are **not** the final
distribution mechanism (`.gitmodules` still exposes the repo, painful for users and release flow,
cannot install just one adapter, unsuitable for a GUI adapter manager); submodule at most for
development.

### 4.9 Builder vs Repository

The Builder is a local feature; an adapter Repository is a distribution ecosystem. The Builder
saves to `local/` only and uploads nowhere. Export-to-contribute is an explicit user action.

### 4.10 Realized local layout (verified)

```
<T3_DATA_DIR>/siteprobe/
├── installed/        # comic18, hanime1_me, hitomi_la
├── local/            # learned rule sets: acg_gamer_com_tw, buondua_com, e_hentai_org, jable_tv,
│                     # manwa_me, rule34video_com, www_agedm_io, www_bilinovel_com,
│                     # www_iwara_tv, www_vikacg_com
├── cache/
├── sessions/
├── export/           # crawl output tree
├── browser_profiles/ # per-host persistent profiles (cookies/tokens; git-ignored)
├── sources/          # empty: registry has readers not yet written
└── retired/          # byte-identical retiring copies of removed adapters
```

`builtin/` has no `site.json` on this machine (only a README in the repo's
`siteprobe/adapters/builtin/`); the `generic` layer is implemented as **code**
(`src/generic/declarative.py`, `src/generic/unknown_url.py`, `src/generic/level0_link.py`), not
as a data directory.

---

## 5. The Builder: annotate → learn → verify/install → probe, and the listing builder

The Builder is the Level-1 subsystem that, for a previously unsupported ordinary site, collects
candidates, lets the user annotate values, learns rules, blind-validates, and outputs a
declarative `site.json`/adapter package that runs on the existing deterministic generic runtime
(no LLM at runtime). Builder modules live in `src/builder/`:
`annotate.py`, `capture.py`, `cards.py`, `harvest.py`, `health.py`, `learn.py`, `listing.py`,
`paths.py`, `roundtrip.py`, `session_server.py`, `text.py`. Root wrappers:
`build_adapter.py` (single-work), `build_listing.py` (listing/search), `learn.py`,
`verify_adapter.py`, and the read-only `doctor.py`.

### 5.1 Sample flow and latest-answer policy

The interactive work builder uses `prefer_latest=True`. Each field keeps its latest explicit answer, selected rule,
date meaning and One/Several mode; an earlier page's disagreement is advisory after that field has been corrected.
Fields not reselected on a later page keep their previous answer. The draft records `rule_policy: latest_annotation`
and its source sessions; both builder verification and `verify_adapter.py` compare each field against its own latest
recorded page. Creator rules may map to runtime `author` or `authors`; both names participate in the same verification.

**Example 1 — Discovery + Annotation.** URL → BrowserCapture → Candidate Harvester →
Normalize/Deduplicate → candidate UI → the user marks which candidate is which field → rule
hypotheses. The user marks scalars (title, date, description, ...), single-or-multiple creators, media scalars
(cover), and collections (tags, characters/subjects, preview/media list, other repeated values).
Author/tag/character fields offer **One / Several**. Several mode accepts individual clicks or one collection/block;
chips show the selected or split members. The derived rule is read by the real runtime against the recorded capture.
If it reads a superset, the saved hypotheses and UI report its `extra` members; those additional members are imported
too. Single mode preserves the selected element's positional rule. Each field stores multiple candidate sources (DOM
selector, meta path, JSON-LD path, inline JSON path, network response + JSON path); do not lock a
single rule at Example 1.

**Example 2 — Confirmation / Pruning.** Automatically apply the hypotheses; the user only marks
each field ✓ correct / ✗ incorrect (re-open candidates only for wrong items). Record
hit/miss, value agreement, type agreement, collection cardinality, source stability. Reselecting a field replaces its
earlier answer. Superset agreement applies only to fields explicitly answered in Several mode, not legacy scalar picks.

**Example 3 — Blind Validation.** The third page is fully extracted by the generated rules with
no re-picking; the user only does final acceptance. Only then generate the formal adapter. A
failure is field-specific and returns to that field's hypotheses (no whole-site re-teach).

**Runtime round-trip (§17/§20, Phase 6)** is the decisive acceptance: `Builder extraction ==
generated site.json == existing generic runtime extraction`. Otherwise the Builder is just
another system and is not "done".

**Verdicts.** Cross-sample results describe the evidence for a hypothesis; they do not override a newer explicit
annotation. Three verdicts are kept, and the third is deliberate:

- `keep` — read the right value on every sample that has an expectation;
- `prune` — read a wrong value, or nothing;
- `unproven` — **only the annotated page can check it** (neither supported nor refuted). Kept, but
  explicitly flagged as unproven — never silently promoted to a rule the samples agreed on.

The annotated page is **excluded from its own verdicts**: a field once read `keep` because it
"matched" the annotation itself (that is the annotation, not corroboration). Validation needs **no
network** — the samples are recorded sessions, so rules are resolved in documents already on disk
(the whole reason `capture.json` exists).

**The adapter document contract is `capture_to_bag`.** Resolving a rule needs the runtime's own
`DocumentBag`, so the Builder rebuilds one from a capture — and that rebuild *is* the definition of
what a generated adapter must expose:

```text
page        the markup itself
jsonld      the page's JSON-LD block, as JSON
network:N   each recorded response body
inline:N    a script body, iff it parses as JSON
```

The `json` channel reads JSON documents, so anything not exposed under one of those names cannot
be read by any rule. A non-JSON script is skipped — the same reason a positional literal gets no
rule at all.

### 5.2 Candidate Harvester

Named-section headings can label long paragraphs as description candidates, including an abstract whose label is a
sibling heading. Long blocks are bounded to 400–12,000 characters and a 100,000-character page budget. Candidates
already truncated by the source retain `cut_short` metadata; a shortened UI preview never shortens the saved answer.

The Harvester's first duty is **recall**, not field decision: `capture → normalize → deduplicate →
type → relate sources → rank`. It must not decide "this is author/tag/title"; the user confirms
semantics.

Capture channels:

- **Browser runtime (Playwright first)** — Chromium launch, post-JS rendered DOM,
  request/response events, XHR/fetch, response body/JSON, browser context, cookies/session, CDP
  when needed. Do not rewrite "F12 network monitoring". Builder may be heavier than the final
  runtime; do not constrain the Builder because the runtime is light.
- **DOM inventory** — visible text nodes, `h1/h2/...`, link text+href, images (`src`,
  `currentSrc`, `srcset`, lazy-load attrs), `data-*`, `aria-*`, `title`, common content attrs,
  parent/sibling context, bounding box, visibility, DOM path, candidate selector.
- **Meta / structured data** — `<title>`, canonical, OpenGraph, Twitter card, JSON-LD, Microdata,
  other `<meta name/property>`. JSON-LD recursively flattened (`$.name`, `$.image`,
  `$.author.name`, `$.datePublished`...). Only as candidates; a key named `author` is not
  automatically a formal field; standard keys may rank higher but never bypass user confirmation.
- **Inline script / hydration data** — parseable `application/json`, `application/ld+json`, common
  hydration state, page init objects, with size/depth limits. `parseable object → recursive
  flatten → scalar/list candidates → record source path`.
- **Network JSON** — Playwright response monitoring; prefer `application/json`, GraphQL JSON,
  fetch/XHR JSON, reasonably sized structured responses. Keep request URL, method,
  request payload/query, response status, content-type, JSON path, value. Filter analytics, ads,
  telemetry, config, oversized responses and unrelated background requests. Do not chase perfect
  semantic judgment in v1.
- **Media inventory** — `<img>`/`<picture>`, CSS `background-image`, video poster, OG image,
  structured-data image, real image responses, visible size, intrinsic size, page position,
  URL query/token info. Merge "same image, different URL": strip fragment, configurable strip of
  tracking query, local hash after download, same-size/path weak match.

**Candidate data model — Candidate Graph / Candidate Record** (a rule points at a
`candidate_id`, not just a selector):

```json
{
  "candidate_id": "cand_0012", "kind": "text",
  "normalized_value": "Example Work", "display_value": "Example Work",
  "sources": [
    { "channel": "dom", "selector": "main h1.title", "dom_path": "…", "visible": true },
    { "channel": "meta", "path": "og:title" },
    { "channel": "jsonld", "path": "$.name" },
    { "channel": "network_json", "request_fingerprint": "…", "path": "$.data.work.title" }
  ],
  "context": { "nearby_text": [], "bbox": null, "attributes": {} },
  "score": null
}
```

Image candidates add width/height/mime/source-variants/downloadable/same-resource hash;
collection candidates add member candidates / repeated parent / common selector / array source
path. The same title from DOM `h1`, OG title, JSON-LD name and API title is shown as one
candidate listing four sources; cross-source consistency raises ranking.

**Candidate ranking** (deterministic heuristics, no model): multi-source agreement, visible, DOM
heading, in main content area, image size large, near page center/main card, standard structured-
data key, stable API key, repeat frequency, looks like nav/footer/logo, same-domain resource,
high-frequency sitewide boilerplate. Ranking's goal is to show sensible options first, not to
decide fields; the UI must still allow viewing all candidates, filtering by type, searching
value/path/selector, and expanding sources.

### 5.3 Selector generation and learning libraries (measured verdicts)

- **`@medv/finder`** — short unique CSS selectors on click; filter out hash classes, generated
  ids and unstable attributes. MIT. Used on the browser/front-end side.
- **OpenPicker** — hover highlight, click-lock, selector inspector, DOM navigator, match count,
  selector edit, Shadow-DOM-isolated UI, cross-tab/cross-origin picker protocol. MIT. Only its
  design/protocol is referenced; a PoC decides whether to reuse the picker SDK.
- **AutoScraper** — **not adopted.** It learned the correct structure on a static page but all
  three retrieval methods returned empty, its rule dialect (`>` combinator + exact attribute
  dict) is incompatible with `htmltree.py` (which rejects `>`), and its attribute dict included
  full `style`. Measured 2026-09-19.
- **Scrapling** — **not adopted.** Its `Adaptor` had no `auto*` methods in the evaluated version;
  adaptive matching is rejected anyway because the plan forbids it becoming an unexplainable main
  rule. BSD-3.
- **Portia** — design reference only; repo archived/read-only since 2026-06-24. Not a runtime
  dependency.
- **Crawl4AI** — optional schema-generation reference only; its "generate once, then run
  deterministically" validates the SiteProbe principle, but it is not a second runtime.
- **Playwright** — the one external dependency adopted (for the **Builder** only; the runtime does
  not depend on it). Apache-2.0.

The positive conclusion of the library PoCs: the rule that needs learning is very short and is
fully expressible in the existing vocabulary, e.g.
`{"from":"html","select":"h1.detail-main-info-title","text":true}` (1 match) and
`{"from":"html","select":"img.lazy","attr":"data-original"}` (11 matches). So the Builder does not
need a "rule-learning library" — it needs candidate discovery plus a human pointing at the right
candidate, and the produced rules land natively in the runtime vocabulary (no translation layer
where "learned but runtime can't use it").

### 5.4 Candidate sources → existing selector vocabulary (exact mapping)

```
Candidate source type                  → current selector (src/generic/select.py)
DOM visible text / raw text            → html {document, scope/select, text|html}
DOM attribute                          → html {attr, absolute?, filter?}
DOM href query parameter               → html_param {attr, param}
meta name/property                     → meta {name|property}
JSON scalar / object path              → json {document, path}
JSON object-array projection           → json_list {path, where?, take?}
JSON collection/string length          → json_length {path}
regex fallback over one document       → regex {document, pattern, group?}
source URL / captured URL group        → url {pattern?, template?}
listing-card value reused by work rule → card {field}
constant/default                       → const {value}
JSON-path assembly of a value          → json_template {document, template}   # the 12th reader, added late
```

All selectors may use `transform` and `fallback`; HTML/JSON list selectors also support
filter/list/offset/limit projections. `extract_listing_page()` already reuses the same selector
resolver on each card's relative DOM subtree, so the Builder needs no separate selector DSL for
listing fields.

Known limits that must be written into the Builder validator: JSON path is only dotted key +
numeric index; CSS capability is whatever `htmltree.py` implements (not full browser
`querySelector`); a network response needs a stable request recipe and a document name before it
can be a selector document. New primitives must be cross-site general and ship with a neutral
fixture test; **no per-site special case in the generic layer.**

### 5.5 Builder pipeline entry points and the probe gate

`build_adapter.py` (single-work) and `build_listing.py` (listing/search) run: harvest → annotate →
learn → (verify) → install. `verify_adapter.py --install` installs; `probe` is now called before
install.

The **probe gate** (added in the hardening plan) makes "generated successfully but imported 0
items" a locatable failure at the install/run point:

- new `src/generic/diagnostics.py`: a finding contract (`code`, `stage`, `severity`, `field`,
  `target_kind`, `message`, `evidence`, `suggested_action`), the initial error codes, `redact_url`,
  `Budget`, `StageResult`, `ProbeReport`, `classify_cards`, `classify_records`,
  `blocking_findings`.
- new `src/generic/probe.py`: a bounded `runtime_probe` reporting five stages
  `acquisition / listing / work / media / import`; budget 45 s per page, 90 s total; `home` can be
  overridden so a draft is probed in a temp home.
- `runner.py`'s `RunResult` gains `findings`/`cards`; both review and download paths emit
  structured findings; an empty listing, a dropped required field, or a duplicate id no longer
  ends as "success".
- `integration.py`'s `result`/`review`/`error` events carry `findings` (`error.code` keeps its
  enum); a new `probe` command / `event:"probe"` document exists.
- `src/builder/roundtrip.py` gets `probe_draft` (install the draft into a temp home, then probe)
  and `format_probe_report`.
- `build_adapter.py`, `build_listing.py`, `verify_adapter.py` call the probe before install;
  `--no-probe` skips it, `--force` overrides a blocking finding.
- Initial error codes: `TARGET_NOT_MATCHED`, `TARGET_ID_AMBIGUOUS`, `ACQUISITION_EMPTY`,
  `ACQUISITION_FAILED`, `DOCUMENT_UNAVAILABLE`, `LISTING_ROWS_EMPTY`, `SOURCE_ID_EMPTY`,
  `SOURCE_ID_DUPLICATED`, `WORK_FIELD_EMPTY`, `COVER_URL_EMPTY`, `COVER_FETCH_FAILED`,
  `IMPORT_CONTRACT_REJECTED`, `CAPABILITY_UNSUPPORTED`, `BUDGET_EXCEEDED`.

A single probe checks: one work for a work rule, or one listing page (multiple cards, then read
one card that has a `detail_url`); one annotated cover only; the standard export is handed to the
T³ pure-parse entry (reads a temp export dir, never calls commit, never touches the real library).
Results distinguish `passed / failed / skipped / unavailable`; a budget exhaustion is never
packaged as a pass. When T³ is unavailable, standalone SiteProbe can still generate rules and the
import stage records `unavailable`; the Python core must not hard-depend on a running T³ server
(bridge via the existing transport/temp artifacts; parsing logic stays in TypeScript).

### 5.6 The listing builder

Target kinds keep the existing target concept: `single work`, `search`, `creator/author listing`,
`collection/favorite/playlist-like listing`. The user declares whether a page is a search page or
some list page; the Builder does not guess business semantics. The Builder's fixed kind set maps
to the user's four kinds as: `work→work`; `search→search`; `album+artist→album` (an author page
is a collection page); `favorite+playlist→playlist`; `folder` is declared by no one and is hidden.

**Repeated-card detection** (`src/builder/cards.py`): from DOM — sibling repeated subtree,
similar tag/class structure, repeated link/image/text combos; from JSON — object arrays where
each object has similar URL/id/title/image keys. Harvester outputs `RepeatedGroup { member count,
common parent, common selector, representative members }`. The user picks one card and marks work
URL, title, cover, id, optional metadata; the system generates a `baseSelector` and card-relative
field selectors.

**Pagination learning** — priority order: (1) URL page parameter; (2) explicit next link;
(3) numbered pagination; (4) load-more button; (5) infinite scroll. 1–3 are the minimum
completion; 4–5 are experimental or "manual/custom fetch required". Validation:
`page 1 → next → page 2 → confirm new item ids appear`. Termination prefers **"no new ids on this
page"**, not trusting the UI's next marker.

**The listing contract the Builder must meet** (so it reuses the existing review/selection
unchanged): `list_cards(template, kind, ref, options)` returns cards, each with a stable
`source_id` and at least one `detail_url` or `url`; `title`, `cover_url`, `author`, `tags`,
`language`, size, page count are review-display enhancements. The selection payload keeps
`source_site`, `target_kind`, `target_ref`, `source_url`, `selected_source_ids`, `selected_items`.
Generic selection re-calls `list_cards`, finds the selected cards by stable `source_id`, passes
them to `collect_items()`, and calls `read_work` only for the selected URLs. A Builder-generated
target must be declared non-single in `site.json.targets`, and fetch/runtime must provide
`list_cards`; an ordinary HTML listing reuses `extract_listing_page()`. No second review/selection
contract is introduced.

### 5.7 Builder session intermediates

Each teach saves a session:
`builder_sessions/<domain>/<session-id>/{example1,example2,example3}/` with `capture.json`,
`candidates.json`, `screenshot.*`, then `annotations.json`, `hypotheses.json`, `validation.json`,
`draft_site.json`. Benefits: debug, replay without re-visiting the site, regression fixtures, and
local-AI inspection of failures. In the realized layout session roots live under
`<home>/sessions/` (the old `<tool>/builder_sessions` was a second, divergent root).

### 5.8 Health / maintenance half (drift)

`src/builder/health.py` + `check_adapter.py` form the "later maintenance" half. If an adapter's
original selector breaks on a small site change, the tool can offer candidate replacements and
repair suggestions — but adaptive matching must be an aid, never an unexplainable main rule, and
must never silently modify a formal adapter.

### 5.9 rule `kind` selects the tool's listing door

The listing adapter's `kind` selects which listing door of the tool is used (work / search / album
/ playlist). `resolve` must reject an address that is not that site's `<kind>` page
(`matched:false`, `reason:"NO_MATCH"`), and a non-URL input is accepted only by kinds declaring
`accepts_name` (search / artist); other kinds return `INVALID_INPUT`. This makes front-end input
validation a real interface: validate before applying, and disable Apply when `matched:false`.

---

## 6. Learned-rule semantics and field shapes

This is the durable core of what the Builder learned the hard way. Each item is a rule that
governs behaviour, with the measurement that produced it.

### 6.1 A rule must name its own addresses (read the value on its own page)

**A learned rule must read the same value on the page it was learned on.** If it cannot even read
the value the human marked on page 1, it must not be installed. The round-trip check
(`compare`) enforces this: each field rule is applied to the annotated page and must reproduce the
annotated value. A rule that only coincidentally worked because it read "the first match" while the
human picked the second is pruned.

**"Read a value" ≠ "read the right value."** A served page can carry `og:title = "Iwara"` (the
site name); a rule reads a value, so fallback (which only triggers on no-value) cannot rescue it.
The fix is **server-page validation**: the learning bag's `page` document is the actual document
the crawl will fetch (`Sample.served`), so a rule reading the site name is judged "not the
annotation" and pruned. Without `served`, behaviour is byte-identical to before.

### 6.2 A learned listing needs an address, not just an id

Learning a listing requires **the second page's address**, whose purpose is to learn a pattern
that walks every page — not to "recognize that one address". Fixing the URL pattern must actually
be able to capture its own sample (a pattern with no capture group makes `TargetRule.match` return
`None`). A pattern self-check runs before install:
`target_pattern_problem(url_pattern, samples)` reuses the runtime `TargetRule.match` rather than a
second implementation.

### 6.3 The row selector must name the set the person saw

The row/card selector must designate the group of rows the human actually saw, not "all elements
on the page sharing that class". If several blocks share a class, the learned rule must scope to
the block that contains the cards. Related hard cases the Builder hit and fixed generically:

- two repeated structures on one page can both look like a list — the human names which one is
  the list;
- a model/listing page's "tag cloud" can be mistaken for a card set — a collection is read inside
  its own block (one group of cards, two numbers);
- "the card itself is the link" — the card is a link and multiple sections share a class; the
  in-row selector and block scope must be unified;
- a value that is "one of a pile of sibling rows" — the container+label selector read the wrong
  row; the row must be addressed by the label.

### 6.4 Listing identity: address-derived ids, not guesses

- Prefer explicit `id_group`, then named id, then compatible positional groups.
- Listing card ids reuse the learned **work target**; only if it cannot be reused does the tool
  propose a candidate identity rule.
- The id rule takes the **last number in the address and anchors the end** (so
  `/videos/snos-357/`, `/doujinshi/title-3547173/`, `/2025/05/work-123/` all read the id). This
  was validated against a 14-row address-shape table (`tests/test_listing.py::ID_SHAPES`). The
  `work id` is a number (user-decided 2026-10-04); both the work path and the listing path must
  give the same id for the same URL. A sort parameter or a page parameter must not change listing
  identity.
- Distinct `source_id`, `detail_url`, human-readable slug, listing identity and pagination
  parameters. Relative hrefs are resolved against the page URL **before** unified matching —
  never extract an id and then absolute-ize it to a URL.
- Do not case-fold or otherwise change an existing `source_id`; an identity change can create
  duplicate imports and must be shown explicitly.
- Two plausible id candidates are shown side by side as an id preview, for the user to choose —
  no domain-hardcoded guessing.
- The work target pattern prefers the path segment the site's own requests repeat (added optional
  `prefer`), because e.g. iwara's address has two varying segments (key + slug) and the last is the
  slug (a 404), while the repeated segment is the key.

### 6.5 Page-declared identity and attribute aliases

- **A value the page declares is an identity.** If the site declares a value via an attribute
  (e.g. a declared author attribute), the selector must read the declared attribute, not only the
  class. This is the fix for "18comic's author was never read".
- **Attribute aliases**: image/media reading must accept aliases such as `data-src` alongside
  `src`, and the same alias set is used when counting positions, so the two halves do not drift.
- **`sibling_label` must distinguish a label from a sibling value.** Several values live as
  sibling rows inside the title string (author value living next to a label, embedded in the title
  text); the generic shape sometimes genuinely cannot learn it and that must be reported, not
  faked.

### 6.6 Multi-value splitting and collection shapes

- **Multi-value splitting**: comma-class separators (including CJK forms), semicolons, slashes and pipes take
  precedence and preserve spaces inside multi-word members. Whitespace separates members only when no strong
  separator exists. A leading list label such as `Keywords:` is removed from the first member. Annotation, learning
  and runtime share `split_members`; selecting a whole block shows its split members while retaining the original
  block as the recorded answer.
- **A list field's members must be handled by one helper regardless of how the template produced
  them.** `_as_members` (renamed from `_as_category_list`) is shared by previews and categories:
  a single string must not be iterated character-by-character (a one-picture preview once became
  179 record entries, one per character). A one-picture preview is one picture in the record.
- **A JSON array of objects where every item carries one key** ⇒ "list of that key's values":
  `{from: json_list, path: tags, take: id, list: true}`. This is offered **beside** the
  individual-index reading (e.g. `tags[1].id`), never replacing it — a site whose field is one item
  of an array still works.
- **Long text vs truncation**: labelled paragraphs and paragraphs within a named section can supply full descriptions.
  UI previews abbreviate long text with an explicit character-count notice; annotations/rules retain the full value.
  A source value already cut short by the website has its own warning and lower ranking. Selector indices are judged
  against the value the indexed rule actually reads, not against unrelated matches of its selector.
- **Merge image variants**: the same image at several sizes/paths is one candidate with several
  sources (e.g. `/image/original/.../thumbnail-05.jpg` and `/image/thumbnail/.../thumbnail-05.jpg`).
  The merge key (`picture_key`) is **equality of the path-segment sequence** after stripping
  resize tokens (`thumb/` insertions, `250px-` prefixes, `-300x400` suffixes, adjacent duplicate
  segments) — **equality, never substring**. Substring would fuse `…/book/1/cover.jpg` with
  `…/book/2/cover.png`; the safe failure is leaving a duplicate for the human to pick, the unsafe
  one is fusing two works' covers. URLs differing only by fragment/tracking params also merge.
- **Page-level uniqueness (`unique`)** — a listing field whose per-row rule cannot tell which of
  several same-class links is the work (hitomi's work link, date link and tag links share one
  class; row structure cannot separate them) is read by asking the **whole page**: the listing
  reader reads *all* candidates per row, discards any value another row also carries, then applies
  `filter`/`group`. The predicate (`select.first_unique`) is **shared** by the reader and the
  generator. `unique` is offered **only for link rules** (`attr == "href"`) — text is naturally
  unique and an image address identifies nothing.

### 6.7 Positional and derived pictures

- **`index`** — when a selector matches more than one element, offer (beside the original rule)
  a rule with `index` that names position N (0-based). Runtime has always supported `index`
  (`select._project`); harvest just never emitted it. This is the fix for "site declares
  `og:image` but the human picked a different photo".
- **`list` + `offset` + `limit`** — the run "the N pictures after the first". Runtime `_finish_list`
  skips by offset then truncates by limit. The `hanime1_me` hand-written adapter already used
  `offset`. Offered as a purely additive candidate: only when ≥2 pictures remain after the first,
  and every existing whole-group/single-picture/source candidate is untouched.
- **Position rules are used for proposals too**: when match counts tie, a rule that can name
  *which* one (`index`) wins. The confirmation page must propose the same picture the human
  marked on page 1 — otherwise cover/preview are pruned for a two-page disagreement.
- **`json_template`** (the 12th runtime reader): `{"from":"json_template","document":"<json doc>",
  "template":"https://i.iwara.tv/image/original/{file.id}/thumbnail-05.jpg"}`. `{path}` reads from
  the same JSON document; **any path that fails to read makes the whole value unreadable**
  (returns `None`), because half an address is worse than empty and "unreadable" lets `fallback`
  take over. It is **derived from multiple works** (`learn.assembled_rule(samples, field)`):
  split each work's address into common prefix/suffix, keep the middle as fill positions; a string
  part must appear as a whole token in every work; a numeric part must **change with the work**
  (so a constant like `limit: 1` is excluded, and the `i.{sites[0].id}.tv` garbage template can
  never be generated); zero-pad width is decided by the number strings each address actually
  writes; finally the runtime's own reader (`select._assemble`) must rebuild **every** work's own
  address byte-for-byte, else return `None` (this site is not applicable) rather than fabricate.
  A late correction: do not pre-guess common prefix/suffix by character (two `file.id`s both began
  with `9`, which got swallowed into the prefix); and a digit must correspond to a whole numeric
  token (a digit inside a UUID, glued to letters, does not count).
- **Draw-in-the-picture (CSS background) rules**: the runtime already supports "read an attribute +
  regex group N", and harvest's background regex (`_BACKGROUND`) is the same one. Generate a rule
  for a picture painted by CSS:
  `{"from":"html","select":"div.vjs-poster","attr":"style","filter":["url\\(\\s*[\"']?([^\"')]+)"],"group":1,"absolute":true,"matches":1}`.
  Only the first painted address gets a rule. **Do not emit a rule for a picture already judged
  chrome (favicon/logo)** — a source with a rule is a source shown to the human, so a favicon with
  score −1 would become "picture 1" if the real cover had no rule.

### 6.8 Values and rules must be read by the same rule

**A field limit must act on the value and the rule at once, never on one side only.** `apply_to`
once read a proposal's value with an unbounded rule but recorded a bounded rule (`limit: 3`), so
the confirmation page showed 19 images while the rule said 3; the page records what it was shown,
so the field was pruned. Proposals now read value and rule with the same rule.

### 6.9 `rule_for` ordering keys (accumulated)

1. a rule that **can read the value the human marked on the annotated page** (`_reads_the_annotation`,
   compared with `same_members`) wins; ranking is only a fallback;
2. a rule reading `network:N` sorts **last** ("a rule that cannot run must not beat one that can");
3. then structured-source preference, match count, and length — with an added tiebreak that prefers
   a value exactly equal to the human's annotation (so `title` "Mornye" beats slug "mornye");
4. `apply_to` prefers the **candidate the human actually clicked** (`Sample.picks`, loaded from
   `annotations.json`), with value matching only as a fallback — otherwise two fields sharing a
   word (title "Mornye" and character "mornye") get each other's rules.

### 6.10 Field shapes and the record

Canonical record fields include `source_site`, `source_id`, `title`, `detail_url`, `author`,
`date_added`, `tags`, `characters`, `works`, `series`, `cover_url`, `preview_urls`,
`contentTypes`/category. The record must not lie: before writing, verify each `local_path` file
actually exists on disk; a missing file's key is dropped (after a real incident where 53 records
claimed covers and 20 files did not exist, while the export *looked* complete). Media gaps are
named (`missing_media`) in the run summary, not just counted. Metadata read success and cover
failure are separate findings so one missing cover never reads as "imported 0 items".

### 6.11 The "common template" (Gallery template) and tags

When a gallery has no template, tag import has no facet to land in
(`canonicalTagFacetId` is null and the submit button is disabled — a dead end). A **Common
template** extracted from a manually built gallery is stored in the repository at
`apps/server/src/templates/common-template.json` (not under `.data`, so it is packaged), applied
as a **copy, not a link** (segments/dimensions become that gallery's own rows and can be renamed,
cleared or deleted afterwards — hence "common", not "default"); a gallery that already has a
template is **rejected**, not merged. Advanced settings shows it; the review page offers two ways
out when a selected gallery has no template: use the common template, or create your own (reusing
the quick-import "create-with-template" door). Only that explicit path allows a null
`canonicalTagFacetId`.

---

## 7. The generic pipeline and its measured limits (Levels A–D)

### 7.1 Level 0 — reliable generic quick capture

Goal: for an arbitrary unknown URL, reliably obtain `title + cover + source URL`; other fields are
low-confidence candidates and are not written as formal data by default. On error, say plainly
"not found / not enough candidates / needs teaching" — never silently fill wrong data. Level 0
**reads without writing**: it reads the page only, the cover bytes return with the answer
(`coverDataUrl`), the page decodes them to a file, and **no file is written** (no export dir, no
intermediate state). The companion entry is `通用单条链接.bat` / `src/generic/level0_link.py`;
`fetch_work_meta.py` is the blind-reader prototype (and deliberately bypasses the registry,
answering "what can be read with no rules").

Measured: the generic rule reader (zero site rules) over 7 different work pages gives title
**7/7** and cover **7/7** (and the cover URL actually fetches an image). Date about half; tags
about half and half of those are SEO noise (`拷貝漫畫_海賊王…`); author about **1/4**, and it can
mistake a work's official homepage for the author. Conclusion: **the generic layer only carries
title + cover**; author and tags are left to the site template or the human.

### 7.2 Level A / B / C / D search-mechanism tiers

The listing/search builder supports search-entry discovery in tiers rather than "automatically
understand any site's search":

- **Level A — URL-template search**: the user performs one search, the URL gains a query; record
  before URL / after URL / query term, infer a query-parameter template, verify with a second
  keyword.
- **Level B — form-based search**: the user actually searches in the browser; capture form, input,
  submit, method, request URL, query/body; generate a search recipe.
- **Level C — network-backed search**: if UI search triggers XHR/fetch, record request fingerprint,
  query parameter/body path, response type; verify with a second keyword. This is also how a
  "SPA" site is handled: the browser is the discovery instrument (find the XHR, record the request
  recipe and JSON path) and the runtime then needs no browser.
- **Level D — custom site mechanism**: if search depends on a special index, multi-stage requests,
  custom signing, non-standard JS or special auth, the Builder must say plainly
  `Generic search recipe unsupported. Custom fetch adapter required.` Do not pollute the core
  chasing "100% generic".

**Measured facts that set these limits:**

- **`gallery-dl` / `yt-dlp` (preset-site-list tools) support 1 of 7 sites** (e-hentai, and only
  with throttling or it times out); jable was *actively removed* by yt-dlp. Their site lists and
  the site types we need barely overlap. This direction cannot be solved with off-the-shelf tools.
- **Browser rendering measured as not worth it** as a default path: 4–8 s per capture vs
  0.06–1.0 s for a plain request (a fixed floor per capture), which conflicts with "fast daily
  use". The rendered candidate space is noisier (iwara's first 5 images are ad banners and
  avatars; ~2 of 19 JSON responses are relevant), and rendering does not guarantee a cover
  (nshens renders the title but all 6 images are `data:` SVG placeholders, with the real cover only
  in the hydration block). So it cannot enter Level 0's default path.
- **Playwright launch is what gets blocked; attach is infeasible; the generic road ends at
  Level D.** Measured on a bot-checked site: `--profile` (persistent context) shows a security page
  even on the homepage; `--login` (open root then deep-link) same; `--disable-blink-features=
  AutomationControlled` same; `--attach` (start a normal Chrome, then attach) is **infeasible on
  this platform** — with a fresh unused profile directory, Chrome still exits immediately and hands
  the URL to an already-running Chrome (Windows process-singleton behaviour), so while the user's
  Chrome is open the tool cannot get its own instance and thus no debug port. Both directions are
  blocked (own browser → detected; normal Chrome → no readable instance). This is Level D: the
  site's own bespoke adapter. `--attach` stays in `capture.py` (default off, affects no existing
  path, and now fails with one clear line instead of silently waiting 60 s).
- **Login is a user choice, never a detection.** The only generalized layer is the **session**:
  `--profile <dir>` starts Playwright with a persistent context (the profile's session then
  applies to every later crawl — the one truly generic mechanism, using the browser's own
  mechanism), and `--login` opens headed and waits for one Enter; the human types the password into
  Chrome and **the tool never touches credentials**. `profile_for(host)` keeps one directory per
  host (`browser_profiles/<host>`, git-ignored). Default behaviour is unchanged when no
  `--profile` is given. What is *not* generalized: "data after login" — if a site sends data only
  to session-bound requests (signing, device fingerprint, multi-step auth), that can only be that
  site's custom adapter (Level D).
- **Login-state result sets the tool cannot reach**: measured 43 (logged-in browser) vs 31 (fresh
  tool session) for the same address — the difference is session/login state, not scroll, page
  parameter or branching. This is Level D.
- **The `--site` door with no capture group**: an address whose pattern has no capture group
  matches nothing, so the tool falls back silently; a learned target must capture its own id.

### 7.3 JS-rendered sites, anti-bot, semantic ambiguity, dates

- **JS-rendered sites**: the builder compares HTTP and rendered samples and selects browser acquisition when it
  recovers annotated fields without losing the HTTP fields. A manually verified browser session retains its profile
  in the generated adapter. System Edge/Chrome and matching bundled Chromium/Firefox builds are supported; security
  or login gates remain user-directed browser steps rather than an automatic bypass.
- **Anti-bot gates**: nonce-cookie pages are a known encountered problem (fixture set contains
  `60ti.com-nonce.html`, `kanman.com-nonce.html`); solving it belongs in the crawler/adapter.
- **Semantic ambiguity across sites**: two sites' `tags` do not mean the same thing. A template can
  declare a preferred facet name (auto-mapping by normalized facet name already exists in web
  review), but meaning stays a review-time judgement.
- **Dates**: many sites have no reliable upload date. The cursor falls back to id ordering and by
  exact `filter` set-difference when neither is trustworthy.

### 7.4 Video duration (measured)

Duration as an entry fact on the level of `page_count`: measured across five video sites, **only
2/5 can be read from served HTML** and only from OG metadata —
`<meta property="og:video:duration" content="805">` (hanime1.me, missav.ws) is readable with a
zero-change rule `{"from":"meta","property":"og:video:duration","transform":["int"]}`. The other
three (jable.tv, yhdm7.net, nnyy.in) show the duration only in a player computed from the HLS
playlist; the total is `sum of #EXTINF`, which is "fetch a second network document and sum" — not
expressible as a selector rule, so it is a **new capability** (a derived field), not a template
rule. Duration is "an optional fact a minority of sites have, not a page every site has". Do not
auto-detect duration; do not put it in `page_count` (pages ≠ seconds).

### 7.5 The safety guard the runtime needs: "did this page mention the work?"

`capture.mentions_the_work(url, html, responses)` — a captured page is "the work you asked for"
only if the last two URL segments (the slug and its adjacent id) appear in the page **body** or in
a request it made. **Do not look at `head`**: a real "Loading" page had
`<meta property="og:url" content="…/sOAekITnnSb24p/fleurdelys">` in its head (an SPA copies the
address into head before rendering), so head is not evidence. `capture_browser` re-reads (reload +
progressively longer settle, at most 2 times) when what came back is not that page, then records a
clear note. This is a generic guard, not site-specific.

### 7.6 Network document naming by request shape

`network:N` is arrival order, not identity: page 1's `network:4` was `api.iwara.tv/video/<id>`
(where the title lives) but page 2's `network:4` was `api.iwara.tv/page/sitewide-announcement`, so
a rule reading `network:4` read a sitewide announcement. The fix: name a network response by its
request's shape, replacing the work's own key with `{id}`:
`network:api.iwara.tv/video/{id}`. The key is **measured**, not guessed: the page-address segment
that the site's own requests repeat as a path segment (at least two responses) and that is not the
first segment of the response path. Learning and proposal both build bags under the same stable
name, with the old name kept as an alias so old annotations/adapters still read. The draft then
declares the recipe `{"format":"json","request":"https://api.iwara.tv/video/{id}","from":"target"}`
in `documents.work` — the runtime already fetched documents by recipe, the Builder just never
emitted one.

---

## 8. Source maintenance ("B" half) and its DB tables

Source maintenance is a distinct T³ workflow (not SiteProbe crawling): it repairs a **derived
Source projection** whose upstream page has died. It is grouped with the Relation/Tag input work
and the mobile-offline work in the retired `relation-source-maintenance-offline-plan.md`
(archived under `.hermes/archive/docs-pre-consolidation/docs/`); only the "B" half
belongs to this board.

### 8.1 Product semantics and immutable boundary

A Source is still a **derived projection** extracted from each Entry's arbitrary Content body:

```
entry_contents.content → URL extraction → known-site/host classification → source groups / per-entry rows
```

Showing a group must not be mistaken for owning a Source. The only business write that adds a
Source is appending a Content to the Entry: `content_type = "Source URL"`,
`content = canonical target item URL`.

Immutable boundary:

- Original Content and original URLs are never replaced, rewritten or deleted.
- The Entry numeric `id` is identity; title is only matching evidence.
- Never merge Entries by title; never reintroduce title-as-identity.
- No batch delete of Sources.
- A new target URL already present on the same Entry is an idempotent skip.
- A new target URL already owned by another Entry must be blocked and require human resolution.
- Media, Tag, Author, Gallery and Entry title are not modified by this workflow.

### 8.2 Is title alone enough?

Usually a site's search result title equals the current Entry title after normalization, and the
same language makes it a strong candidate; if the target site only needs a URL added, the search
result page's title/URL/language/thumbnail suffice for a first retrieval round. But the same title
can mean: a prototype short story vs a later serialization; a manga vs its anime adaptation;
a volume vs a chapter vs a collection vs a remake; same-name different authors; the same work in
different languages/scanlation groups; or search-result noise/the same candidate claimed by
multiple Entries. So "same title + same language" may be pre-selected by default but must not be
auto-written in the background; uniqueness and conflict evidence must be checked and the user must
explicitly Commit.

### 8.3 No LLM for translated titles

- Do **not** use LLM/embedding for title identity.
- Do **not** crawl a generic search engine as a core dependency.
- Do **not** guess search parameters for an arbitrary user homepage or auto-traverse a site.
- Do **not** treat an edit-distance/Jaccard score crossing a threshold as "same work".
- Do **not** probe every detail page to judge each candidate; ambiguous items go to human review.

Recommended: an **external catalog alias graph**. Provider priority (all verified feasible):
Bangumi (Chinese/Japanese manga/anime aliases, author and form evidence) → MangaDex (multilingual
`altTitles`, Author/Artist) → Wikidata (cross-language labels/aliases, cross-catalog IDs; its Blue
Box entity provided EN/JA/ZH labels and aliases `Ao no Hako`, `藍箱`, `青之箱`, `青色之箱`) → Kitsu
(Romaji/English/Japanese supplement; note same-name prototype vs serial may return two records, so
never take only the first) → AniList (optional; its GraphQL endpoint returned a transient 403 in
the 2026-09-12 test) → MAL (only if a user configures a key; official API needs client ID/key).
**Provider failure only lowers evidence; it must never fail the whole run.**

Local deterministic normalization (conservative only): NFKC; trim/collapse spaces/case-fold;
punctuation and full/half-width unification; keep the original full title; generate candidate
fragments from explicit separators (e.g. `Romaji | 中文译名`) without discarding the full title;
Traditional/Simplified may add extra query variants via the project-pinned OpenCC (never depend on
a global Python); do not auto-strip author/number/volume/`OVA`/`oneshot` tokens that may decide
identity — make them structured evidence instead. Romaji is a strong cross-name bridge but still
needs protection against prototype-vs-serial same names.

Optional second evidence: thumbnail perceptual hash (pHash/dHash) — only supporting evidence
(watermarks, crops, different volume covers cause false negatives; shared series covers cause false
positives); first version may just record `thumbnailUrl`.

### 8.4 Why an arbitrary homepage cannot be auto-searched

Sites use GET query, POST form, GraphQL or internal JSON APIs; JS hydration; login/cookie;
CAPTCHA/Cloudflare/rate limits; and different pagination, language, canonical URLs and result
structures. So the UI may accept a target homepage, but the server may only map it to an
implemented adapter. An unknown site shows `Unsupported target; adapter required` and keeps
per-item manual URL input; it must not start a generic crawler.

Target network requests must be issued by the local server (avoid browser CORS, centralize rate
limiting). Because the homepage is user input, SSRF protection is mandatory; the safest first
version is an **adapter hard allowlist**, not free fetch.

### 8.5 Source adapter / catalog provider contract

Suggested directory `apps/server/src/source-maintenance/`: `source-search-adapter.ts`,
`adapter-registry.ts`, `adapters/<target>.ts`, `title-variants.ts`, `evidence.ts`,
`catalog-provider.ts`, `catalogs/{bangumi,mangadex,wikidata,kitsu}.ts`, `job-manager.ts`,
`repository.ts`.

```ts
interface SourceSearchAdapter {
  key: string;
  displayName: string;
  acceptsHomepage(url: URL): boolean;
  canonicalizeHomepage(url: URL): URL;
  canonicalizeItemUrl(url: URL): string;
  search(input: { title: string; language?: string; signal: AbortSignal }): Promise<SourceCandidate[]>;
  rateLimit: { concurrency: number; minDelayMs: number };
}

type SourceCandidate = {
  url: string; title: string; language?: string; creators?: string[];
  workKind?: string; thumbnailUrl?: string; adapterEvidence: Record<string, unknown>;
};

interface TitleCatalogProvider { key: string; lookup(query: TitleVariant, signal: AbortSignal): Promise<CatalogWork[]>; }

type CatalogWork = {
  providerId: string;
  titles: Array<{ value: string; language?: string; kind: 'title' | 'alias' | 'romaji' }>;
  creators: string[]; workKind?: string; externalIds: Record<string, string>;
};
```

Every adapter/provider must have a saved HTML/JSON fixture; tests must never hit the live network.

### 8.6 Retrieval / eligibility / evidence bands

**Retrieval** (per Entry): build local title variants; query catalog providers with the original
title/clear fragments for a bounded alias set; dedupe and cap query variants (e.g. ≤6); call the
target adapter searches in order, merging candidates with the same canonical URL; save raw
provider/adapter evidence for review and reproducibility.

**Candidate eligibility** — a candidate must satisfy at least one: normalized target title exactly
equals some trusted Entry title/alias; target title and Entry title resolve to the same canonical
provider ID; exact Romaji title with non-conflicting creator; a user-entered URL. Similarity-only
candidates cannot enter the auto pre-selection but may remain under "Other search results".

**Evidence bands, not one magic threshold:**
- `exact-safe`: target title exactly hits canonical/trusted alias; unique among the Entry's
  candidates; target URL not assigned to another Entry; no language/work-kind/creator conflict.
- `strong-review`: same catalog canonical ID with at least one of creator/work-kind supporting; or
  exact Romaji + creator support; or same title + same language but missing work-form info.
- `ambiguous`: multiple target candidates share a title; only a translated alias with no
  oneshot/series/adaptation distinction; only cover hash or partial title support.
- `conflict`: explicit conflict in creator, work kind, language or target-URL ownership.
- `no-match/error`: no candidate, provider unavailable, adapter parse failure, rate limit exhausted.

Rules: `exact-safe` may be pre-checked but is still not auto-written; `strong-review` and
`ambiguous` must be confirmed item by item; `conflict` is not submittable unless the user enters a
URL manually and re-confirms; no band may skip the库-wide URL-ownership check.

### 8.7 Data model (source maintenance)

Source membership is still not materialized; the Advanced page is a low-frequency management
operation and continues to derive from Content, only designing a rebuildable cache if real
measurement shows scanning is unacceptable. Use the next available migration number (do not
hard-code `014`):

```sql
CREATE TABLE source_statuses (
  source_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active', 'invalid')),
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE source_maintenance_runs (
  id INTEGER PRIMARY KEY,
  origin_source_key TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  adapter_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','running','paused','review','committed','cancelled','failed')),
  mark_origin_invalid INTEGER NOT NULL DEFAULT 0 CHECK (mark_origin_invalid IN (0,1)),
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE source_maintenance_items (
  run_id INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  entry_title_snapshot TEXT NOT NULL,
  origin_urls_json TEXT NOT NULL,
  query_titles_json TEXT NOT NULL DEFAULT '[]',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','accept','skip','conflict','error')),
  selected_url TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_text TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, entry_id),
  FOREIGN KEY (run_id) REFERENCES source_maintenance_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) WITHOUT ROWID;
```

Notes: `source_statuses` is a source-group annotation; Content remains the real membership.
`state=invalid` only adds a badge/sort in the UI — it never hides, disables or forbids the old URL.
runs/items persist network results and human decisions so a server restart can resume. JSON must be
parsed through shared Zod schemas, never propagated as arbitrary objects. A future single-URL
invalid state would add `entry_source_annotations(entry_id, normalized_url, ...)`; do not implement
two levels at once.

### 8.8 Advanced UI workflow and commit contract

The child panel hangs off `apps/web/src/AdvancedEditingPage.vue`, not the big component. Five
steps: **Origin** (show source library: name/hosts/Entry count/active-invalid; pick an origin group;
checkbox "mark this group invalid after commit" with an explicit note that it deletes/hides
nothing); **Target** (enter target homepage; server does only an adapter probe — canonicalize
origin, show adapter name and capability; unsupported site stops here and keeps manual URL review,
no generic crawl; show expected Entry count, request cap and minimum estimated time); **Search
job** (Start/Pause/Resume/Cancel; show processed/matched/ambiguous/no-match/errors; per-host
concurrency 1–2, honour `Retry-After`, no exponential concurrency; the server checkpoints in small
batches and never holds a SQLite transaction during a network fetch); **Review** (per row: Entry
id, current title, Author, language, old URL; target title/URL/optional thumbnail; exact title /
alias / Romaji / author / language / work-kind / URL-ownership evidence badges; `Open target`,
candidate radio, manual URL, Skip; evidence band and conflict reason; filters exact-safe,
strong-review, ambiguous, conflict, no-match, error, already-present); **Commit** (summary of new
Contents, idempotent skips, unresolved, whether the origin group is marked invalid, backup path;
two-click arm pattern — first arm, second execute).

**Commit contract** — network search is strictly separated from writing. Before commit: re-read
each accepted Entry; verify it still exists; compare `entry_title_snapshot` and origin URL snapshot
(any stale item returns 409 and the whole batch writes nothing); canonicalize the selected URL;
the selected URL must belong to the adapter target origin; different Entries in the batch must not
choose the same normalized URL; scan the whole library (same-Entry URL → idempotent skip; another
Entry's URL → conflict, whole batch writes nothing); create a formal DB backup; a single SQLite
transaction (append one `Source URL` Content per accepted Entry with sort order at the end;
upsert `source_statuses` to invalid if the checkbox was on; mark the run committed); after the
transaction re-derive Source rows and return created/skipped/conflict counts. Commit performs no
network access, media download, old-URL deletion or Entry merge.

**Key APIs** (strict schemas in `packages/shared/src/schemas/source-maintenance.ts`):

```
GET    /api/source-library
PATCH  /api/source-statuses/:sourceKey
POST   /api/source-maintenance/runs
GET    /api/source-maintenance/runs/:runId
POST   /api/source-maintenance/runs/:runId/{start,pause,resume,cancel}
GET    /api/source-maintenance/runs/:runId/items?page=&pageSize=&state=
PATCH  /api/source-maintenance/runs/:runId/items/:entryId
POST   /api/source-maintenance/runs/:runId/commit
```

If the server exits while a run is running, mark it paused on startup; the user must explicitly
resume from the unfinished item. Never start a daemon that auto-visits external sites.

**Network / security / polite access**: HTTPS-only targets unless a hard-coded adapter proves HTTP
is required; adapter allowlist limits hostname/port and rejects credentials, fragments and
non-standard dangerous ports; re-validate scheme/host/IP on every redirect and cap redirects;
forbid loopback/private/link-local/metadata IPs and local file protocols (defeat DNS rebinding);
cap response bytes, decompressed size, Content-Type, timeout and total requests; recognize
429/503 and `Retry-After` and persist a pause instead of infinite retry; a fixed descriptive
User-Agent (Bangumi documents a UA requirement); respect robots/terms; do not bypass CAPTCHA, do
not reuse user browser cookies, do not record credentials; logs record only adapter, status,
timing, entry id and redacted URLs, credentials always `[REDACTED]`.

**B-half implementation order** (TDD): B1 lock source/status/run schemas →
B2 add an immutable migration (test empty DB, populated DB, repeated apply, checksum,
rollback/restore; update `db:probe` and `db:doctor`) → B3 source status overlay (first prove status
does not change derived membership/URL) → B4 title variants + evidence engine (fixtures
`青色之箱/蓝箱/青春之箱/アオのハコ/Ao no Hako/Blue Box`; test oneshot/series, same name different
author, same URL multiple Entries, alias collision) → B5 catalog providers fixture-first
(Bangumi → MangaDex → Wikidata → Kitsu; each: save a minimal JSON fixture, RED parser test, minimal
HTTP client, test timeout/429/malformed/missing fields; live endpoint only a single manual smoke) →
B6 the first target-site adapter (the only input the user must supply: origin source group, target
homepage, 3–5 reproducible target search URLs/fixtures — normal/no-result/multi-result/special-
chars/pagination; without these the agent must stop at the adapter contract/fixture scaffold and
must not guess the site) → B7 resumable job manager (bounded concurrency, pause/resume/cancel,
checkpoint, restart→paused; deterministic tests with fake adapter + fake clock) → B8 commit service
(RED cases: old Content byte-unchanged; accepted candidate appends `Source URL`; same-Entry dup
idempotent skip; cross-Entry dup aborts all; duplicate selected URL in run aborts all; stale
snapshot 409 zero writes; one invalid URL zero writes; group invalid commits atomically; injected
failure rolls back all new contents/status; backup failure prevents the transaction) → B9
HTTP/web API/Advanced panel → B10 isolated QA (temporary DB seeded with duplicate titles,
translation aliases, oneshot/series, workless Author, unknown host, malformed Content; fake
adapter full wizard with no network; staging/live adapter searches only a few authorized samples
and never commits the real library; before a real batch: backup, doctor, preview counts again).

**B-half common pitfalls**: mistaking the Source projection for a second Source-ownership table
that must be double-written; treating the target homepage as an arbitrary fetch URL (SSRF);
silently returning a wrong URL after a target search HTML change instead of failing closed; writing
the first result or the top fuzzy score; `青色之箱` hitting both a prototype and a serial (ignore
work kind/page count); batch-assigning one target URL to several Entries; inconsistent URL query
order/fragment/trailing-slash normalization; checking only `Content.type === 'Source URL'` while
missing URLs already in other Content bodies; holding a SQLite transaction across a long search;
auto-resuming external access after restart when the user thinks it stopped; continuing to write
when Entry/title/source changed at commit; hiding/deleting/disabling old URLs when marking invalid;
a provider outage wiping all candidates without keeping completed results; leaking external API
results, credentials or adult titles into normal logs; modifying an already-released migration or
running destructive QA on the real DB.

**B-half success and rollback**: the user can pick an origin Source, enter a supported target
homepage, pause/resume the search and review item by item; different translated names produce
candidates via the alias graph with explainable evidence; unmatched and ambiguous items do not
block saving reviewed results, and one Commit is atomic over the selected set; each newly added
target URL corresponds to a new `Source URL` Content and old Contents are unchanged; invalid is
only a status annotation and batch delete has no entry point or API; network failures, restarts and
429 are recoverable and Commit retries are idempotent. Rollback: an uncommitted run can be
cancelled/deleted; committed new Contents are not batch-deleted by automatic rollback (a separate
reverse-review list is generated for the user to confirm item by item); `source_statuses` can flip
back to active without touching Content; migrations are not rewritten/deleted and new tables stay
inert and harmless if code is rolled back.

---

## 9. T³ integration: machine interface, commands, UI entry points

Two meanings of "matching" in the integration plan: **(A) input → who claims it**
(`resolve_input`: which site, which target kind, what ref); **(B) one run → which export dir →
which batch of entries** (selection/export → `ImportBatch` → commit).

### 9.1 The machine interface (the tool side)

Without a machine-readable exit, T³ could only hard-code a site list (forbidden by guidance §33).
So the tool side first adds `src/generic/integration.py` plus a root entry `integration.py`
(same wrapper shape as `probe.py`); the human CLI is unchanged.

```text
integration sites   [--json]                 # registry snapshot (incl. two-adapters-per-domain relation)
integration resolve [--json] <input> [--site K] [--kind K]
integration run     [--json] <input> [--site K] [--kind K] [--review] [--limit N] [--refresh]
integration selection [--json] <selection.json>
integration probe   <url> [--building work|listing]
```

**stdout is JSON-lines only** (one object per line, easy to stream); human logs go to stderr.
Events: `sites`, `resolve`, `progress`, `review`, `result`, `error`, `probe`.

```jsonc
// sites
{"event":"sites","sites":[{"key":"18comic.vip","display_name":"18comic.vip","export_group":"18comic.vip",
  "source":"installed","sources":["installed","local"],
  "adapters":[{"source":"installed","reads":"declarative","readme":true}],
  "targets":[{"kind":"album","label":"Album","single":true,"accepts_name":false},
             {"kind":"search","label":"Search","single":false,"accepts_name":true}]}]}

// resolve — matched:false is a successful answer, not an error
{"event":"resolve","matched":true,"site":"18comic.vip","kind":"album","ref":{"id":"1472965"}}
{"event":"resolve","matched":false,"reason":"no-site","input":"https://example.com/x","known":["…"]}
{"event":"resolve","matched":false,"reason":"ambiguous","candidates":[{"site":"a","kind":"search"}]}

// run / selection — an event stream, always ending in result or error
{"event":"progress","phase":"scan","message":"listing page 3","count":80}
{"event":"review","path":"…\\export\\18comic_vip\\search_x\\review.html","url":"http://127.0.0.1:PORT/?token=…","count":42}
{"event":"result","site":"18comic.vip","kind":"search","ref":"x","works":218,
 "listing":"…","export":"…\\search_x\\metadata.json","origin":{"kind":"search","ref":"x"},
 "media":{"cover":218,"previews":0,"failed":0},"warnings":[],"findings":[]}
{"event":"error","code":"NO_MATCH|UNKNOWN_KIND|NETWORK|BLOCKED|NEEDS_LOGIN|INTERNAL","message":"…"}
{"event":"readme","site":"18comic.vip","source":"installed","text":"<markdown>"}   // only when the human clicks "?"
{"event":"probe", …}
```

Key points:

- **`export` is the only parameter T³ needs**: T³ passes it to `loadSiteProbeExport` and needs no
  site knowledge (the shape of `metadata.json` is still decided by each site's `site.json`
  `manifest`).
- `resolve` answers by "the adapter that declares this target" and includes `source`
  (`installed`/`local`/…) so the two-adapter situation is explainable in the UI.
- Exit codes: `0` success, `2` input/match failure, `1` run failure; **errors also appear as an
  `error` event** so the parent need not parse sentences (the `[ERROR]` prefix stays for humans).
- Cancel: the parent kills the child directly (the tool has no shared state; export is written file
  by file with `metadata.json` last, so a mid-kill leaves one export that the next run can trim —
  matching the existing "cursor belongs to the crawl" design).
- Registry errors carry a `code` assigned at the throw site (`RegistryError` with
  `NO_MATCH` / `INVALID_INPUT` / `AMBIGUOUS` / `UNKNOWN_SITE` / `NO_MODULE`).
- `resolve` is tightened (the input-validation interface): a URL-shaped input must match that
  `--site`/`--kind` `url_pattern`, else `matched:false` + `reason:"NO_MATCH"`; a non-URL input is
  accepted only by kinds declaring `accepts_name`.
- `review` carries a uniform integer `count` ("how many items on this page"); generic review uses
  `len(cards)`, a site's own review uses its summary total. So "found N items, filter?" needs no
  site-field guessing.
- `run` may run **with review** (`--review` produces `review.html` + `cards.json` +
  `review_media/`) or without (direct export).
- The review handoff: a run's `review` event gives a loopback URL; the front end opens it in a new
  tab; the page exports `selection_<ref>.json` with `source_site` / `selected_source_ids` /
  `whitelisted_source_ids` / `excluded_source_ids` / `selected_items` plus `target_kind` /
  `target_ref`.

`run --site X --kind K <input>`: `--site` without `--kind` still parses the whole string as before
(existing bats unaffected). Also: the selection export must not print Chinese prose to stdout
(one line `作品文档：x/y` broke the JSON-lines contract and produced a fake `INTERNAL`).

Also implemented tool-side (b-advanced P1): an adapter entry in `sites` gains a boolean
`readme`; a lazy `readme --site <key>` command (stdout `{"event":"readme",…}`, exit 2 with empty
text on unknown site / no readme); hitomi's explicit index prefixes (`artist:`, `tag:`, `series:`,
`character:`, `group:`, `language:`, `type:` pin the search to that index — a bare name still walks
the seven-index auto-detection); and a login gate `login.py` + `登录.bat`:
`resolve` the site → the site's persistent profile (`<home>/browser_profiles/<host>`) → open headed
to the homepage → print "log in / pass the check, then press Enter in T³" → collect
`context.cookies()` → if the adapter exports `save_cookies(profile, cookies)` hand them over
(18comic reads them back this way), else write `<profile>/../session-cookies.json`; exit 0/2/1.
The tool saves no passwords and reads no passwords.

### 9.2 T³ server channel

New `apps/server/src/siteprobe/`: `home.ts` (resolve the SiteProbe home and the interpreter),
`transport.ts` (spawn, read JSON-lines, timeout, kill; never parse human logs), `jobs.ts`
(in-memory per-process run registry: id/status/event ring buffer/cancel/selection watch),
`runtime.ts` (the launcher holds it and closes it with the server — otherwise a child outlives the
parent), plus `reveal.ts` and `log.ts`/`link-meta.ts`.

Interpreter discovery order: `SITEPROBE_PYTHON` (env, overridable) →
`<repo>/siteprobe/.venv/Scripts/python.exe` (Windows) → `<repo>/siteprobe/.venv/bin/python`
(other) → otherwise **fail loudly** ("run `uv sync` once in siteprobe/"), never silently fall back
to a system python (which lacks `curl_cffi`/`playwright`/`Pillow`).

Routes (all under `/api/siteprobe/`):

```text
GET  /api/siteprobe/status        → { home, python, ok, detail }
GET  /api/siteprobe/sites         → passthrough of integration sites
POST /api/siteprobe/resolve       → { input } → resolve event
POST /api/siteprobe/runs          → { input, site?, kind?, review?, limit?, refresh? } → { id }
GET  /api/siteprobe/runs/:id      → { status, events[], selection?, error? } (poll; SSE could live here)
POST /api/siteprobe/runs/:id/cancel
POST /api/siteprobe/login         → { input } → spawn the login gate in a new console window
GET  /api/siteprobe/readme?site=<key>
POST /api/siteprobe/reveal-folder → { folder: 'installed'|'local'|'home' } → { folder, path }
GET  /api/siteprobe/export-file?path=<abs>   # within the export root, .html/.json only
POST /api/imports/site-probe/preview-path    → { metadataPath } → SiteProbeUploadPreview
POST /api/imports/commit-path
```

Constraints and rules:

- `resolve`'s miss is **200 + `matched:false`** (that is the clipboard flow's question; "none" is
  an answer).
- Only one **export writer** runs at a time; a builder waiting on annotation may coexist with an import using an
  installed adapter. Builders serialize with builders, and sign-ins retain exclusive profile use. A conflict returns
  409 with `error.details.runId` and `logPath`; UUID-suffixed logs record the request and blocking job independently.
  Synchronous launch failures remove their provisional running record. Reopening the import panel recovers running
  imports, selection jobs, sign-ins or builders, with a stop control independent of site/kind selection.
- `preview-path` path guard: must be **absolute** and resolve inside `<home>/export/` (checked
  after resolve, `..` included); three escape attempts were measured and blocked with 400.
  `preserveRelativeMediaPaths` becomes `false`.
- `commit-path` has the server read from disk and store media (the browser does not hold the
  files), and **names** every file it cannot store (from a real incident: 53 records claimed
  covers, 20 files were not on disk).
- `export-file` uses the same `resolveInsideExportRoot` guard as media: only inside that site's
  export root, only `.html`/`.json`, `Content-Type` by extension, `..` always rejected.
- `reveal-folder` accepts **only a level name, never a path** (`strictObject` enum
  `installed|local|home`; a request carrying a `path` is rejected, not ignored). It
  `mkdirSync(recursive)`s the target (a fresh install has no `installed/`), picks
  `explorer.exe`/`open`/`xdg-open` per platform, and uses `detached + stdio:'ignore'` **without
  waiting for the exit code** (explorer returns non-zero after handing off; only "cannot start"
  counts as failure).
- `GET /status` and `GET /link-meta` currently have **two identical registrations** in
  `apps/server/src/http/app.ts` (the later, commented one is shadowed dead code); byte-identical,
  so no behaviour difference today, but the commented copy should be the one kept.

### 9.3 The command chain (user-visible, one path)

```
[user]  Import area → "Get from a website"
[UI]    tool (site) dropdown ← GET /api/siteprobe/sites   (menu from the registry; core has no site list)
[UI]    object-type dropdown ← that site's targets[kind]; label and "input name / input URL" from the same data
[UI]    input box (URL or name) + "manual filter" checkbox
[T³]    POST /api/siteprobe/runs → spawn a child
         no manual filter: run → export directly
         manual filter:    run --review → review.html + cards.json + review_media/
[UI]    progress (JSON-lines phases/counts) + cancel
[user]  manual filter: open the review page → pick → export selection
[T³]    take selection (watched directory) → second child: selection → download only selected → export
[T³]    POST /api/imports/site-probe/preview-path (server-side local path, no upload)
[UI]    preview (the existing commit preview UI, unchanged)
[T³]    POST /api/imports/commit (batch with origin → migration 021 cursor advances here)
```

Clipboard scenario (D4, **shelved by the user — "not critical"**): window focus reads the clipboard
once (`navigator.clipboard.readText()`, localhost is a secure context; if the URL is http(s), call
`POST /resolve`; on a hit show a non-blocking prompt bar; never auto-create an entry — provider
matching must be user-initiated).

### 9.4 Advanced import (UI "B")

The Advanced import page uses rules already installed for a site. The user does **not** choose a
tool: they paste any URL of the target site (homepage or work page), and the host is derived.

- No learned rule/adapter: show a hint and a `go to rule building` button that jumps to the rule
  creation page with the URL copied over.
- Rule found: show `rule found · target: <host>`, and an `adaptor existing ?` badge (with a readme
  popup) when the adapter ships with the tool (source `builtin`/`installed`; learned
  `local`/`development` show only `rule found`).
- Four rule kinds are listed as rows, not a dropdown, each with a scope explanation: **work**
  (one work page with cover/title/author), **search** (a meaningful keyword — author, tag — not an
  over-broad hundreds-of-results query), **album** (a large collection page, an author page or a
  special keyword's result page), **playlist** (account-login favorites/playlists; most need
  login, so a generic tool often cannot adapt and a dedicated adapter is needed). Only the kinds a
  site actually declares are shown.
- Per-kind input: work/album/playlist a URL box; search a keyword box; playlist also "does this
  need login?" (recorded only, interface reserved; selecting Yes routes to the login button; no
  login-gated playlist fetch is implemented).
- Apply runs `resolve` validation first; long waits show a working status (`working, now…`),
  a bug → "please report + copy diagnostics"; done.
- Multiple items: "found N items, may contain duplicates/multi-language/junk, already lightly
  organized — do a quick manual filter? if it's a clean folder or personal collection you can
  skip." Yes → review page (T³ route, new tab) → selection (existing watcher) → download only the
  selected → import. No → run again without review → import.
- Import reuses the folder-drop import and batch import screens: T³ front-end drives, the tool runs
  in the back, data downloads locally, then auto-submits to T³'s import screen to confirm.

Server support for B: `login` job kind (run the login bat in a new console window; that job's stdout
is plain text, progress lines written by T³, process exit = done); `readme` passthrough;
`export-file`; and two small `AddEntryPage` changes (after a preview is produced, switch
`activeTab` to `files`; a parent-held `ruleDraftUrl` passed from B to the rule-creation page).

### 9.5 Rule-learning page (UI "C") and the fourth/fifth tabs

The Add Entry page became four tabs: **快速导入 (Quick import)** — the fast create-entry page;
**高级导入 (Advanced import)** — the rule-use panel; **导入规则创建 (Rule creation)** — the guided
builder; **文件直接导入 (Direct file import)** — the original folder-drop + batch. Review/import
was later moved to its own tab. The rule page must be step-by-step (one state at a time, a
"restart" at each state's top-right): an intro state (explaining the tool captures everything
touchable and generates a filterer for the human to pick the right cover/title/tag, and that it
first learns a single work page then a list), then a "prepare 2–3 work URLs" state, then the
single-work adapter state (three URL boxes — at least the first required; usage tips about
preferring the cleanest matching value and combining multi-author/multi-tag options), then the
listing-adapter state (choose type search/artist/favorites/album/playlist; first-page URL and
**second-page URL to learn paging**; then pick one reference card). The adapter pages hide all
code/markup; image fields are auto-named by score ("图片1, 图片2…"); "no learnable rule" fields
are not shown (a field with no rule cannot be learned — pure interference); on completion it tells
the user to return to T³, then imports the first work for preview. The listing preview downloads
**the first 10 works only** (just to see the effect; the user may leave without recording).

---

## 10. Data root, settings, environment quirks

### 10.1 The one writable root

The data root is `<T3_DATA_DIR>/siteprobe/`. Resolution order for `adapter_root()`:

1. `SITEPROBE_HOME` (env, highest priority — lets the real home be read from the process env;
   T³ passes `SITEPROBE_HOME=<T3_DATA_DIR>/siteprobe` explicitly when spawning);
2. the `home` key in `siteprobe.json`, found under `parents[2]/[3]` of the module (a relative
   value is resolved **against that file's own directory**, not the caller's cwd);
3. `user_data_dir()/siteprobe`, where `user_data_dir()` = `T3_DATA_DIR` (relative values resolved
   against the server package, consistent with the server) or, absent that, `apps/server/.data`.

`builtin` is an exception: it is read-only code shipped with the package and lives in the
**repository** at `siteprobe/adapters/builtin/`, not in user data.

The repository root has `siteprobe.json`:

```json
{ "home": "apps/server/.data/siteprobe" }
```

so double-clicking a bat and being launched by T³ land on the same home. Verified on this machine:
`adapter_root()` = `D:\Project\TagTraceTrove\apps\server\.data\siteprobe`. The data root was moved
here (412 MB, item-by-item move with entry counts checked before/after: installed 844, local 20,
cache 814, sessions 735, export 10, browser_profiles 329, sources 0). T³ data lives in
`<repo>/apps/server/.data` because `T3.bat:71` does `cd apps\server`.

Caution: T³'s backup **explicitly enumerates** `library.db` + `assets/` + `manifest.json`
(`backup-restore.ts`), not the whole `.data`, so the moved 412 MB is not swept into a library
backup — but "explicitly managed by backup/cleanup" is **not yet true** (guidance §34). Suggested
shape: back up only `local/` (20 files) and `installed/` (844), skip `cache/ sessions/
browser_profiles/` — because 6 of the 10 learned rule sets have their source session gone from
disk, so the installed `site.json` is the only copy of those rules.

### 10.2 Settings and environment

- `SITEPROBE_HOME` — the SiteProbe home (highest priority).
- `SITEPROBE_PYTHON` — the interpreter override (see §9.2).
- `T3_DATA_DIR`, `T3_DB_NAME`, `T3_PORT`, `T3_HOST`, `T3_LOG_LEVEL`, `T3_ENABLE_LAN`,
  `T3_STATIC_ROOT`, `T3_OPEN_BROWSER` — T³ server env (`T3_DATA_DIR` defaults to `.data`, resolved
  from the server package).
- Python packaging: `pyproject.toml` requires Python `>=3.11`; base dependency is
  `opencc-python-reimplemented`; extras are `browser = playwright/httpx/curl_cffi`,
  `media = pillow`, `dev = pytest`.
- The launcher `T3.exe` currently only locates Node/pnpm/local `tsx` and starts the server; it
  provides no Python, virtualenv, Playwright browser or adapter-dependency installer. So the
  SiteProbe runtime's bundled interpreter/venv/bootstrap and health check must enter the formal
  release design.
- Where each concern lives: `sources.json` (source registry) is not yet read; `adapter.json` is
  written but not read; `development` adapters are mounted by an explicit dev path; `cache`,
  `sessions`, `export`, cookies and browser profiles always stay under the data root.

### 10.3 Private material must not enter the public repo

Separate `tests/fixtures/neutral` from local `recordings/private`, `cache`, `exports`, `cookies`,
`browser profile`. Must be git-ignored: cookies, session, auth, exported media, personal review
selection, local adapters (unless the user publishes them), browser profiles.

### 10.4 Environment quirks measured

- Playwright's browser binary was version-mismatched locally: the package wanted
  `chromium_headless_shell-1243`, the downloaded one was `-1208`; use `channel="chrome"` to reuse
  the system Chrome (measured 153.0.8010.50) and skip the ~150 MB `playwright install`. If the
  bundled chromium is used later, run `playwright install` first.
- Python 3.11.6; `uv` at `/c/Users/hzy/AppData/Local/hermes/bin/uv`.
- The temporarily installed `autoscraper` and `scrapling` (with lxml/beautifulsoup4/cssselect/
  orjson/tld/w3lib) were uninstalled after the verdict; re-running `poc/rule_learning*.py`
  requires installing them again.
- Node: a first verification mistakenly used the system Node 26 and native SQLite reported an ABI
  mismatch; switching back to the repo's Node 22 passed. That environment failure was not a
  product defect.
- `.bat` hygiene: every `.bat` must be CRLF + pure ASCII (LF makes CMD eat the first character of
  each line; non-ASCII derails the parser — both actually happened). One bat had a `0x01` control
  byte embedded in a path (`export<0x01>8comic_vip`), so the bat gate now also checks control
  bytes (not just `> 127`).
- eslint config ignores `**/.data/**` and `**/.venv/**` (otherwise it scans the tool venv and the
  Chrome profile extension scripts — 34,502 problems, plus `.data` is where output lands).

---

## 11. Test, fixture and gate strategy

### 11.1 Core CI vs adapter CI vs live tests

- **Core CI** needs no network: generic parser, Candidate Harvester fixtures, Builder fixtures,
  adapter schema, review, selection, neutral adapters.
- **Adapter CI** (per adapter): recorded fixtures, contract validation, optional live smoke.
- **Live tests** must not be a hard dependency of the main repo's CI.

### 11.2 The "every door is opened" acceptance principle

"Tests pass" and "it breaks the moment the user opens it" can both be true; the fix is to test at
the layer the user touches:

1. Test with the **same interpreter** the bats use (`siteprobe/.venv`; it had no pytest because only
   `browser`/`media` extras were installed — the agent env passing is a different layer).
2. Gates must actually be exercised: 10 bats + 12 command lines; a green unit suite that only
   imports library modules never touches them.
3. A check must **prove it can fail**: a scope-sensitive `check_undefined_names.py` (names are
   visible only in the scope that binds them and its nested scopes) fed a synthetic broken file
   must report the bug — a module-level name set that reports `[]` is only reporting zero.

Realized gates: `tests/test_site_contract.py` (each bat's target must exist, each bat must
`uv sync` first, no control bytes / LF-only / non-ASCII — with a self-test feeding a synthetic
historical-failure bat); `tests/check_undefined_names.py` (scope-sensitive, verified on six
shapes); `verify_doors.py` + `验收.bat` (static audit + real run of the 12 command-line doors with
the project `.venv` + opening the 8 bats double-click-empty; excludes `应用Tag审核.bat` and
`验收.bat` itself so it is runnable at any time without changing data). `verify_doors.py` itself
learned: "must exit" wrongly failed the two builder doors that are designed to stop on the
annotation page (changed to "reached the annotation page without crashing"), and `subprocess.run
(timeout=)` can hang forever holding a pipe (23 Chromes running) — changed to write output to a
file and kill only the parent. It also cleans up **only the sessions it created this sweep**.

`verify_doors.py` gains JSON doors: `integration sites --json` must exit 0 with each line
`json.loads`-able, **with a self-test** that a bad stream (empty output / a human sentence mixed
in / wrong exit code / wrong event name) must be judged a failure.

### 11.3 Fixtures

Build content-neutral golden fixtures and never let all tests depend on live sites. Fixture set
(present under `siteprobe/fixtures/`): `static_work`, `jsonld_work`, `hydrated_work`, `api_work`,
`repeated_listing`, `pagination`, plus `labelled_row_site`, `learned_site`, `related_api_work`, and
`adapter_contract/{multivalue_tags, opaque_id_relative_date}`. Each fixture stores HTML, JSON,
expected candidate set, expected adapter and expected extraction. The neutral-fixture set the plan
calls for (`book-demo`, `movie-demo`, `gallery-demo`, `api-demo`, `dynamic-demo`) is the policy for
the README/demo being content-neutral and CI being stable.

### 11.4 Test suites present

Python (under `siteprobe/tests/`): `test_generic_probe`, `test_site_contract`, `test_work_urls`,
`test_home_and_resolution`, `test_integration_api`, `test_cards`, `test_listing`, `test_learn`,
`test_annotate`, `test_acquisition`, `test_identity`, `test_transforms_media`, `test_doctor`,
`test_diagnostics`, `test_collection_groups`, `test_comic_ladder`, `test_date_fragments`,
`test_embedded_json_safety`, `test_generic_review_selection`, `test_harvester`, `test_health`,
`test_login`, `test_media_fetch`, `test_nested_label_rows`, `test_review_return`,
`test_roundtrip`, `test_runtime_cover`, `test_selection_accumulate`, `test_unknown_url`,
`test_verify_doors_cleanup`, plus `tests/check_undefined_names.py`. Recorded-corpus regression
`verify_against_recordings.py` (last measured: 327 comparisons / 0 mismatches). Structural guards:
site contract (every site implements `read_work`; every declared target is implemented — this once
caught "declared album but did not implement it"), URL parsing (paste shapes), bat hygiene, and the
scope-sensitive undefined-name scan (once caught two defects, one of which would crash hitomi's
artist path).

TypeScript: `apps/server/tests/unit/siteprobe-findings.test.ts`,
`siteprobe-reveal.test.ts`, and integration tests for the routes/findings.

Test data isolation is mandatory: use isolated in-memory DBs for repository behavior and temp file
DBs for WAL/backup/migration/corruption/doctor; tests must never touch the real
`.data/library.db` or real assets. Transport tests use a stub interpreter (a small script that
prints the contract JSON to stdout) via `SITEPROBE_PYTHON`, so integration tests need no real
venv, no network and no `.data`. Read the real library only through a `better-sqlite3` `backup()`
copy and query it read-only.

### 11.5 Manual acceptance gate (the door only a human can walk)

```
cd D:\Project\TagTraceTrove\siteprobe && .venv\Scripts\python.exe verify_doors.py --slow
cd D:\Project\TagTraceTrove && pnpm test && pnpm test:integration && pnpm db:probe && pnpm db:doctor && pnpm lint && pnpm typecheck
```

Plus: `T3.bat → import area → get from a website → pick a site → single work → import → an entry
with a cover in the library → again → search → manual filter → pick 3 → download only those 3 →
import → cursor advances`. The user is responsible for real-site and UI acceptance; automated
checks cannot substitute for it.

### 11.6 License governance (pre-open-source deps)

Playwright Python (Apache-2.0), OpenPicker (MIT), `@medv/finder` (MIT), AutoScraper (MIT),
Scrapling (BSD-3-Clause), Portia (BSD-3-Clause, reference only, not recommended as a dependency).
Before release, re-read the actual lockfile and LICENSE files; this list is not a legal audit.

---

## 12. Durable findings & rules index

### 12.1 Rules that govern behaviour

- **A rule must name its own addresses** — a learned rule must read the value the human marked
  *on the page it was learned on*; a rule that cannot read page 1's own annotation is never
  installed.
- **A learned listing needs an address, not just an id** — learning a listing needs the second
  page's address to learn a pattern that walks every page, not to recognize one address.
- **The row selector must name the set the person saw** — not "all elements sharing a class".
- **The listing adapter's `kind` selects the tool's listing door** (work / search / album /
  playlist); an address that is not that site's `<kind>` page is rejected, not approximated.
- **The second page address is for learning the pattern**, not for recognizing that one page.
- **Login is a user choice, never a detection** — the tool generalizes only the session, never the
  credential; it never saves or reads passwords.
- **Adapter is per-site; a learned set is not distributed** — an adapter is per-site; a learned
  rule set is the individual user's (`local/`, git-ignored) and is not an adapter; when a domain
  has both, both are kept and each serves the target it declares.
- **The execution log is the record; corrections are appended, not overwritten** — including
  attempts that failed and were reverted, so the history is honest.
- **Ability first, layer as tiebreak** — see §4.3.
- **Install only if the runtime reads it** (`install_if_the_runtime_reads()`): ask the runtime with
  the draft file, so what is measured is what will be installed; if it reads no cards, `[STOP]` and
  install nothing — otherwise an unreadable adapter lands and shadows the site's existing adapter.
- **A field limit acts on the value and the rule at once**, never one side only.
- **"Read a value" ≠ "read the right value"** — validate against the served page, not the rendered
  page.
- **A rule that cannot run must not beat one that can** (`network:N` sorts last; a rule with no
  request recipe loses to one that runs).
- **A field is proposed with its own pick when two fields share a word** — otherwise title and
  character swap rules.
- **Read-only doctor, explicit upgrade** — doctor never modifies a user file; upgrade previews a
  diff, saves a byte-identical recovery copy, and atomically replaces only the named file.
- **Old rules stay readable; upgrades show a diff and a byte-identical backup.**
- **Unknown fields are preserved** on upgrade; never silently delete.
- **Identity changes are explicit** — never silently rename an already-exported work directory, and
  never case-fold an existing `source_id`.
- **One export writer at a time**; rule learning can coexist with an installed-adapter import (§9.2).
- **`resolve`'s "no match" is a successful answer, not an error.**
- **The menu cannot be hardcoded; T³ never parses site rules; common actions do not pop dialogs;
  provider matching is always user-initiated.**

### 12.2 Measured facts

- Generic reader (zero site rules) over 7 work pages: title 7/7, cover 7/7, date ~1/2, tags ~1/2
  (half SEO noise), author ~1/4 (and can mistake a work's homepage for the author) → the generic
  layer carries only title + cover.
- `gallery-dl` / `yt-dlp` support **1 of 7** sites (e-hentai with throttling; jable removed by
  yt-dlp); their site lists barely overlap ours → this direction is unusable.
- Browser rendering measured as **not worth it**: 4–8 s vs 0.06–1.0 s per capture; noisier
  candidates; rendering does not guarantee a cover.
- **Playwright launch is what gets blocked; attach is infeasible; the generic road ends at
  Level D** (all four attempts measured). `--profile`/`--login` remain as generic capabilities for
  sites without such protection.
- Login-state result set unreachable by the tool: 43 (logged-in browser) vs 31 (fresh session).
- **LLM is authoring-time only, never runtime** — a 3–8 B model is 2–4.5 GB and 20–60 s/CPU page
  while one search is hundreds of works (hundreds of times the cost), and a cover URL is a
  verbatim-copy task where small models are least reliable; the model may only help produce
  `site.json`. Runtime stays deterministic and dependency-free.
- Video duration: only **2/5** video sites expose it in served HTML (`og:video:duration`); the
  other 3 need HLS `#EXTINF` summation, which is a new capability, not a selector rule.
- AutoScraper and Scrapling are **not adopted** (measured: AutoScraper learned but could not
  retrieve and uses an incompatible dialect; Scrapling lacked the adaptive API).
- Recorded-corpus regression: **327 comparisons / 0 mismatches**.
- `site_works` populated across all three sites proves imports went through commit; author cursors
  were manually backfilled for `kakao` (18comic) and `rinhee` (hanime).
- Generation-time catalogues: `taxonomy_dictionary.json` + `tag_review.csv` were replaced by
  originals (with `.pre-migration` backups); hitomi's `author_list.json` was **merged** (251 + 1 =
  252, to keep `sharekoube`) not overwritten; `character.json` was not migrated (a truncated
  fragment with no writer).

### 12.3 Verified module map

- `siteprobe/src/generic/`: `site_api.py`, `registry.py`, `select.py`, `extract.py`, `template.py`,
  `declarative.py`, `acquisition.py`, `document.py`, `identity.py`, `canonical.py`, `media.py`,
  `review.py`, `review_media.py`, `selection.py`, `crawl_state.py`, `pages.py`, `htmltree.py`,
  `dates.py`, `text_normalization.py`, `bundle.py`, `export_layout.py`, `taxonomy.py`,
  `diagnostics.py`, `probe.py`, `probe_process.py`, `probe_worker.py`, `doctor.py`,
  `integration.py`, `login.py`, `unknown_url.py`, `level0_link.py`, `cli.py`, `runner.py`,
  `site_api.py`.
- `siteprobe/src/builder/`: `annotate.py`, `capture.py`, `cards.py`, `harvest.py`, `health.py`,
  `learn.py`, `listing.py`, `paths.py`, `roundtrip.py`, `session_server.py`, `text.py`.
- Root entry scripts: `build_adapter.py`, `build_listing.py`, `learn.py`, `verify_adapter.py`,
  `doctor.py`, `integration.py`, `probe.py`, `pick.py`, `selection.py`, `refresh_review.py`,
  `repair_media.py`, `repair_crawl_state.py`, `run_site_step.py`, `show_link.py`,
  `fetch_work_meta.py`, `harvest.py`, `annotate.py`, `login.py`, `migrate_site_data.py`,
  `compare_tools.py`, `check_adapter.py`, `verify_doors.py`, `verify_against_recordings.py`.
- Human/ops bats: `提取单条链接.bat`, `提取作者或收藏夹.bat`, `下载selection.bat`,
  `应用Tag审核.bat`, `修复缺失封面预览.bat`, `修复预览图.bat`, `生成适配器.bat`,
  `生成列表适配器.bat`, `登录.bat`, `通用单条链接.bat`, `验收.bat`.
- T³ side: `apps/server/src/siteprobe/{home,transport,jobs,runtime,reveal,log,link-meta}.ts`;
  `apps/server/src/import/site-probe.ts`; `apps/server/src/import/commit.ts`;
  `packages/shared/src/schemas/{import,siteprobe,source-maintenance}.ts`;
  `apps/web/src/components/{AdvancedImportPanel,RuleBuilderPanel}.vue`;
  `apps/web/src/siteprobe/adapter-status.ts`.

### 12.4 T³ DB objects (integration)

Migration `021_site_crawl_state.sql` creates `site_works` (`(source_site, source_id) → entry_id`,
the landing place for "keep an id for every recorded work", the only proof a work was received
after the crawl files are deleted) and `site_crawl_sources` (one cursor row per listing). Commit
records ids for **both new and existing (skipped)** works, so re-running an export backfills ids
into an old library without parsing old URLs. Dedup order: **Source URL first, then site work id**
(so a site changing URL shape does not create duplicates). The batch gains `origin` (shared schema
+ `site-probe.ts` passthrough + commit advancing the cursor). `import:cursor` CLI supports
`status` / `filter` / `list` / `set`, where `filter` is the exact "given a batch of ids, which are
already held?" interface. A search whose keyword is an author name additionally registers an author
cursor (ref = normalized name, display = card spelling) — generic, no site branch.

The crawl-side cursor lives in the **export tree**, not the T³ DB:

```
export/<site>/crawl_state.json
  inventory   the work ids this listing already has on disk (derived from items/, cannot drift from reality)
  cursor      the newest work seen (for reporting; also readable by the library side later)
```

Trimming uses **inventory, not cursor** (cursor is an assumption about order; inventory is the
exact answer). `--review` deliberately lists everything; `--refresh` bypasses trimming. The cursor
advances by "all ids the listing showed", so a run that fetched nothing still advances it; an
undated entry never passes a dated cursor — normal for a site with no dates, conservative for one
with dates. The library-side cursor (`site_crawl_sources`) is kept but is no longer the trimming
authority.

---

## 13. Phase history, acceptance, and consciously-stopped limits

The tool was built in numbered phases, each with its own acceptance gate. That work was recorded
in an append-only running log (`docs/siteprobe/siteprobe-execution-log.md`); the log has been
retired as development churn, and this section keeps its durable conclusions. Everything below is
either already stated in the sections above or is the phase's verdict.

### 13.1 Phase 1 — Library PoC (2026-09-19)

Environment on which the PoC was measured: Python 3.11.6, playwright 1.63.0, curl-cffi 0.16.3,
Pillow 12.3.0. Four acceptance decisions:

| Decision | Verdict |
| --- | --- |
| Browser capture | **Playwright with `channel="chrome"`**, used **only as the Builder's discovery tool — never in the runtime**. *(This was the Phase-1 decision; the 2026-10-11 hardening later let the runtime honor a rule that declares browser/api acquisition — see §14.5.)* |
| Picker / selector strategy | Deferred to Phase 4 (JSON/CLI annotation first). |
| DOM rule learner | **No external library** — built on the existing selector vocabulary. |
| Adaptive matching | **Not done** — the evaluated library (Scrapling) lacked it in that version, and it would introduce an unexplainable primary rule. |

**The most important finding:** the site that looked hardest (iwara — judged a "JS shell needing a
browser or an API rule") needed **no browser at runtime**. The browser capture merely revealed
`api.iwara.tv`; the data came straight from that JSON API over `curl_cffi` with chrome
impersonation, no browser and no cookie.

### 13.2 Phase 2 — Candidate Harvester v1

- `capture.json` is the Harvester's **single input** — so a run is replayable, debuggable after the
  fact, and fixture-able. Input is never a live page.
- Five channels: `markup`, `jsonld`, `inline`, `network`, `media`. `inline` is a **string-literal
  scan only** — compressed framework state hides values behind positional arguments, which needs a
  JavaScript evaluator; every degradation is recorded in `notes`, so the recall given up is
  visible, not silent.
- Six content-neutral fixtures: `static_work`, `jsonld_work`, `hydrated_work`, `api_work`,
  `repeated_listing`, `pagination`.
- Ranking scores by **distinct channel count, not source count** — a value repeated three times in
  one channel is *templated*, not corroborated (this moved the real cover from rank 479 to 1).
  Media needed its own signals because lazy-load sites declare no size.

### 13.3 Phase 3 — Normalize / Deduplicate / Ranking

- **Images and text must not share one score scale.** The Phase-2 target "iwara cover must reach
  top-5 overall" was the **wrong form** of the question: the cover ranked **4 / 29 within images**.
  A multi-channel text value will always beat a picture on a single mixed leaderboard, but they do
  not compete for the same field. The CLI now groups by type (`strongest image` / `url` / `text` /
  `number`). Chasing the mixed "top-5" would have meant piling special cases onto a non-problem.
- Ranking signals added (all from the plan): field-name keys over API parameters, shallow values,
  "the response is about this page's subject", and penalties for list members
  (`results`/`related`/`comments`, index > 0), site chrome, and unkeyed literals. `capture.json`
  gained `Document.source_url` so the subject test is possible.
- Image-variant merge by `picture_key` **equality** (see §6.6); NFKC text comparison with the
  display value preserved; entity decoding applied to the JSON channel **only**; URL dedupe by
  `comparison_url`.

### 13.4 Phase 4 — Annotation UI

The hard constraint (**T³ will be the operation window; nothing may require the user to move files
by hand**) changed the delivery form: a local service on loopback serves the annotation page and
receives the result, instead of "generate a self-contained HTML and download the result back".
`/media` takes a **candidate id, not a URL**, so the endpoint cannot become an arbitrary fetcher.
An annotation produces an **executable rule**, not a field name; and a rule is a **hypothesis**, so
it records `matches: N` (a rule that matches every `a` on the page reads the first one). The
generated adapter must expose the page's JSON-LD as a **`jsonld` JSON document**, or the JSON-LD
rule cannot run. Collection candidates: any selector that reads several values becomes a
collection candidate (`list: true`).

### 13.5 Phase 6 — Runtime Round-trip

- A generated adapter is **configuration, not a second system**: the declarative reader lives in
  the **runtime** (`src/generic/declarative.py`), so a generated adapter never imports the Builder.
  The registry falls back to `site.json` when a site has **no `fetch.py`** — a `fetch.py` that
  exists but fails to import is still a loud error; the fallback covers **absence, not breakage**.
- Generated adapters live in `local/` (git-ignored): **two files, no Python** (`site.json` +
  `adapter.json`).
- The whole chain was proven on real manwa works with no file moving, and the learned title rule
  (`h1.detail-main-info-title`) matched what the Phase-1 PoC had independently measured.
- A generated adapter **satisfies what it needs to run, not the full human-written adapter
  contract** (its `naming` / `manifest` / listing sections are not generated — recorded, not
  hidden).

### 13.6 Phase 7 — Listing builder, and its four lessons

1. **Page-level uniqueness** is a primitive in its own right (`unique`; §6.6) — cross-row
   uniqueness is a page property a per-row rule cannot express.
2. **Numbering takes the last number in the address**, with an end anchor — early attempts took a
   date or issue number out of the title segment.
3. **Cards must be visible and nameable** — the representative card is not always the first
   (§5.6), so the choosing page lists the cards and accepts `--card-of=N`.
4. **A listing's date may be absent** (the work page supplies it) and **a search page is far more
   permissive than an author page** — neither blocks rule learning.

### 13.7 Consciously-stopped limits

- **Login-state result sets are a real boundary.** Measured on 18comic: the same address returned
  31 works in the tool's fresh session and 43 signed in — not scroll, not a `page` parameter, not
  sharding, but the session. This is Level D (custom mechanism/auth) and is served by a
  hand-written adapter. The tool generalizes only the **session** (`--profile`); it never touches
  credentials.
- **`--attach` is infeasible on this machine** (Windows Chrome single-instance hands the URL to an
  already-running Chrome). It stays in `capture.py`, off by default, and fails with one clear line
  rather than a silent 60-second wait. Per-site fingerprint tuning / block-page detection /
  CAPTCHA solving are explicitly **out of scope** for `src/generic`.
- **No adaptive auto-substitution of a live adapter** — a maintenance suggestion must land back on
  a deterministic selector; the health check only reports, it never writes.
- **The single mixed image/text leaderboard** is not needed (§13.3).

### 13.8 An acceptance principle established en route

The verification method itself was corrected once: from "the tests pass" to **"open every door
once"** (§11.2) — after 275 green tests coexisted with bugs a person found in a minute of clicking.
A clean suite is not acceptance; every user-visible door must be walked.

---

## 14. Generic-adapter hardening (2026-10-11) — the current runtime architecture

This is the **newest architectural layer**, and where any earlier record disagrees with it, **the
newer date governs** (§14.5). Its one-sentence outcome: **the Builder and the runtime converge on
the same Core** for acquisition, identity, transforms and images, so a common site difference can be
expressed as a user's declarative rule instead of a SiteProbe source change.

**Goal:** reduce how often a new site requires editing SiteProbe source. A site's domain, API
address and selectors may live only in user-created rules and case data — **never as a per-domain
branch in Core**. The plan is a *stabilization* layer inside the existing architecture: it does not
replace the distribution model, Provider matching, the data model, or the user-verification rules.

It was authorized in two batches — Stage A (minimal), then Stages B–F at once. Stage A is already
detailed in §5.5 (the probe gate); this section is the index of the whole update.

### 14.1 The staged plan (A → F)

| Stage | Unified | Durable entry points |
| --- | --- | --- |
| **A** Error classification + minimal run contract | `diagnostics.py` (finding contract, codes, `redact_url`, `Budget`, `StageResult`, `ProbeReport`, `blocking_findings`), `probe.py` (bounded `runtime_probe`, five stages), install-time probe gate — full detail in §5.5 |
| **B** Acquisition & document sources | `acquisition.py` (`AcquisitionPlan` / `plan_for` / `PageRead` / `HttpSession` / `BrowserSession` / `session` / `read_page`); the browser read engine **moved from `builder/capture.py` into Core**, `capture_browser` is now a thin adapter (same signature/defaults); `declarative.py` reads a listing's pages in **one session** (one Chrome per listing run, not per page); `read_work` honors `work.acquisition`; `template.work_acquisition` added |
| **C** Work & listing identity | `identity.py` (`extract` / `work_id` / `narrowing` / `candidates` / `ambiguous` / `absolute`); **both** `template.TargetRule.match` and `builder/listing.target_rule_for_id` call it; query-id and relative-href (`base`) resolution supported |
| **D** Transforms & images | run-level **frozen clock** in `select.py` (`freeze_clock` / `frozen_clock`) used by `_relative_date`, frozen once at `runner.run` start; `COVER_FETCH_FAILED` distinct from `WORK_FIELD_EMPTY` / `COVER_URL_EMPTY`; image responses validated by `media.detect_extension` magic bytes (a 200 HTML challenge page is never written as `.jpg`) |
| **E** T³ display & import parsing | `packages/shared/src/siteprobe/findings.ts` (`describeFindings` / `primaryFinding` / `findingAdvice`); `AdvancedImportPanel.vue` shows stage-ordered findings + advice; parsing still goes through the existing `loadSiteProbeExport` — **no second importer** |
| **F** Compatibility, doctor, regression cases | `doctor.py` (read-only `diagnose` + explicit `upgrade`) and CLI `siteprobe/doctor.py`; `siteprobe/fixtures/adapter_contract/` (`opaque_id_relative_date`, `multivalue_tags`) |

New machine entry from Stage A: `integration probe <url> [--building work|listing]`, emitting
`event: "probe"` (`siteprobeProbeEventSchema`). `RunResult` gains `findings`/`cards`; the
`result`/`review`/`error` events carry an always-present `findings` array (old callers that ignore
it are unaffected; `error.code` keeps its original enum).

### 14.2 Completion definition (what "done" means)

1. common HTTP HTML, browser-rendered pages, and replayable JSON requests are all expressible by
   configuration;
2. one rule has the **same document source, identity interpretation and field transforms** in the
   Builder and the runtime;
3. a listing's work id **reuses the work target rule first**, and ambiguity is never resolved
   silently into a "success";
4. a **required-field** failure is reported clearly at install/run; a missing **optional** field is
   allowed and its impact stated;
5. T³ can show **which stage** failed (acquisition / listing / work / media / import);
6. old rules stay readable; upgrade has a diff preview and a recovery copy;
7. each fixed generic phenomenon has a minimal, selectively replayable case.

**Not promised:** not every site is declaratively adaptable. Binary indexes, image reordering,
dynamic signatures and the like remain custom plugins — and must **report the capability gap rather
than fake an empty-list success**.

### 14.3 Decisions carried

- **Python Core never hard-depends on a running T³.** The standard export is the boundary; TS
  parsing stays in T³; a standalone CLI marks the import stage `unverified`.
- **Explicit acquisition intent is never silently changed** — an explicit `browser` rule never
  silently downgrades to HTTP, an explicit HTTP rule never opens a login window, and `api` means
  "execute a declared request recipe", not "auto-scan the site's interface".
- **Identity changes are explicit** — never silently case-fold or rename an existing `source_id` or
  export directory.
- **Upgrade is explicit** — preview the diff, save a byte-identical recovery copy, atomically
  replace only the named file, preserve unknown fields; `doctor` is read-only and never touches the
  network or the user's files.
- **Diagnostics redact** sensitive URL query values and never print cookies / Authorization /
  browser storage.

### 14.4 Verified outcome of the hardening

Regression on the same tree: siteprobe Python suite **433 passed**;
`verify_against_recordings.py` **327 comparisons / 0 mismatches**; `integration.py sites` lists 12
sites all with a target; 5 real URLs all `resolve`d. This is automation, not real-device/site
acceptance.

### 14.5 Date precedence — the conflicts, resolved

Where an older record contradicts this section, **the newer (2026-10-11) statement wins**:

| Older statement | Newer (governing) |
| --- | --- |
| Phase 1 (§13.1): the browser is a **Builder-only discovery tool, never in the runtime**. | The runtime **shares** the acquisition layer and **honors a rule that declares browser/api acquisition** (§14.1 Stage B). HTTP stays the default; what survives from Phase 1 is that a browser is *not required by default* and that many "JS shell" sites resolve over HTTP/API. |
| `network:N` is a response **arrival order** (earlier §5.2 / the opening of §7.6). | A network document is named by its **request shape** (`network:api.iwara.tv/video/{id}`), measured from the site's own requests; the old name is kept as an alias (§7.6). |
| Work target and listing card infer identity **independently**, with looser rules. | **One shared** `identity.extract`, called by both (§14.1 Stage C). |
| Acquisition is a bare string (`acquisition: "browser"`) with no plan. | An internal `AcquisitionPlan` (mode / session / recipe / wait condition / budget) that the old string still feeds into (§14.1 Stage B). |
| Relative dates converted ad-hoc per call. | One **run-frozen clock** so a page cannot drift across midnight mid-run (§14.1 Stage D). |

Earlier sections already reflect the newer rules where they were updated (§5.5 probe gate, §7.6
request-shape document naming, §12.3 module map); §13.1's Phase-1 table is the historical decision
record and is to be read through this table.


