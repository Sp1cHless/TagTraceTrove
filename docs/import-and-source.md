# T³ import & source board — website import, Source library, Source maintenance

> Covers the transactional import commit, the derived Source library, Source invalidation maintenance, relation
> suggestions, taxonomy aliases, and the crawler cursor contract. SiteProbe itself (the crawler tool) is documented in
> `siteprobe.md`; the data model these write into is in `architecture.md`.

## 1. Transactional Import commit

`commitImportBatch(database, batch, mapping)` (in `apps/server/src/import/commit.ts`) is the persistence boundary
between canonical website exports and the Entry/Producer model. **Website adapters remain database-free.**

### Safety model

- The **new portion** of a batch commits in **one SQLite transaction**. Any invalid mapping, missing reviewed Producer
  match, constraint failure, duplicate Source URL, or repeated site work id inside the incoming manifest rolls back all
  new writes.
- Candidate `fields` are **never guessed**. Every field present in the batch must appear in `fieldMappings` or
  `ignoredFields`.
- Existing Producers are linked **only** through explicit `existingProducerIds` entries supplied by the user.
- `createUnmatched: true` explicitly permits new Producers for source values that have no reviewed match. The service
  **never** automatically matches an existing Producer by name (except through the taxonomy dictionary, below).
- Canonical Tags and mapped Tag fields require explicit Facet IDs belonging to the selected Entry type.
- **Re-imports are idempotent** by clean Source URL and by the retained site work id behind it: an Entry whose Source URL
  already exists is skipped, and a work the library already holds under the same site id is skipped even when the site
  has re-spelled its URL. New Entries in the same author manifest still commit.
- Each new Entry retains provenance as **exactly one clean `Source URL` Content row** equal to the source `detail_url`.
  Raw source/body payloads stay out of Content. A `site:workId` external key is no longer purely transient: its site id
  is filed into `site_works` (§5) as the work's durable identity.

### Mapping shape

```json
{
  "entryType": "comic",
  "canonicalTagFacetId": 7,
  "sourceContentType": "source url",
  "externalKeyContentType": "external key",
  "bodyContentType": "body",
  "fieldMappings": {
    "authors": {
      "kind": "producer",
      "createUnmatched": false,
      "existingProducerIds": { "Source Author": 12 }
    },
    "characters": { "kind": "tag", "facetId": 8 },
    "language":   { "kind": "content", "contentType": "language" }
  },
  "ignoredFields": ["works"],
  "authorRatings": [{ "name": "Source Author", "slotName": "画风精美", "stars": 4 }]
}
```

### Same tag in two Facets

A source can name one thing as both a series and a character (a multi-series art collection listing `Goblin Slayer`
under `作品` and `登场人物` at once). The same tag cannot sit in two Facets of one Entry, so the commit keeps the **first
placement** (the Entry's own tags first, then the mapped fields in order, with the tag's established gallery placement
winning for both) and reports the skipped placement in `importCommitResultSchema.warnings` instead of failing the whole
import. The batch review view lists those notes under its notice — the Add Entry page is already gone by then, which is
why the review, not the page that ran the import, is where they are shown.

### Author ratings (import-time)

`authorRatings` records what the review decided about the imported **Authors** rather than about each work, because a
bulk import cannot judge thousands of works while an Author score is one decision per name. Each entry names an Author
from an entry's `authors` field plus one rating dimension; the dimension must already exist as an Entry rating slot of
the import Gallery, and the server **mirrors it onto the Author's own rating partition by name**. These ratings are
written inside the same transaction as the Entries/Producers/links, so a failed import leaves no Author rating behind,
and re-committing a batch (where every work is skipped) upserts the same values instead of duplicating them.
`importCommitResultSchema.authorRatingCount` reports how many were written.

### Producer mapping choices (per candidate field)

- `existingProducerIds` — maps a source string to a reviewed Producer ID.
- `createUnmatched: false` — stops the import if an encountered string has no reviewed ID.
- `createUnmatched: true` — creates new Producers for unmatched strings and reuses those newly created records within
  the same batch.

**Dictionary resolution.** Producer names resolve through the `producer` taxonomy vocabulary exactly like Entry tags
resolve through `entry`: an imported alias spelling (`bob`) links to or creates the canonical author (`鲍勃`). Both the
reviewed map keys and created Producer names use the resolved canonical spelling, so dictionary-driven author merges
survive future imports of any spelling. The link side is also enforced server-side: when the resolved canonical name
already exists as a Producer, the import **links to that row** instead of creating a second one, whether or not the
review preselected it (a work credited to `冷泉` lands on the existing `和泉`). A Producer named after the canonical is
created only when no such row exists yet.

### Merging duplicate / dictionary-equivalent authors

`pnpm merge:authors [<library.db path>] [--dry-run|--commit]` (default `apps/server/.data/library.db`) merges Producers
in three passes:

1. Identical normalized names (NFKC, trimmed, collapsed whitespace, lowercased).
2. **Spelling variants**, where `_`, `-`, and `.` count as whitespace, so `arai_kazuki` and `Arai Kazuki` are one
   Author. This looser key is local to merge detection: `normalizeTag` itself keeps its stricter meaning for tag dedupe,
   import field keys, and dictionary lookups, so imports still match names exactly as before.
3. Names that resolve through the `producer` taxonomy vocabulary to a different canonical name (`bob` → `鲍勃`) merge
   under that canonical name; a lone alias-spelled Producer is renamed to its dictionary canonical.

Each group collapses to the row with the most linked works; on equal work counts the separator-free spelling becomes the
display name, and the lowest id breaks any remaining tie. Works, Producer tags, Author rating values, and directories
transfer to the survivor. The alternates sub-label shown under author names in the UI is derived from the same taxonomy
rows at render time — no schema change. See `database.md` §4 for the transaction/backup/verification details.

### Commit command

First produce and review a canonical artifact:

```text
pnpm import:site-probe <export-root>/metadata.json --output <canonical.json>
```

Then prepare the mapping JSON against the target database's Entry type, Facets, and reviewed Producer IDs. Commit requires
both an explicit database path and the final `--commit` acknowledgement:

```text
pnpm import:commit <canonical.json> <mapping.json> <database-path> --commit
```

The command applies outstanding immutable migrations, validates both JSON documents, commits once, and prints only the
created IDs and aggregate counts. Omitting `--commit` performs no database write.

### Post-commit report

A commit answers `existingEntryIds` (the works those source URLs already belong to) alongside
`skippedExistingEntryCount`: the works whose source URL the library already had. They are not created again, but the
caller can still record that this run carried them — a work appearing in another folder is itself information. An import
files **every** work the run carried into its temporary review, including the ones the library already had; the review
marks those cards "Already in the library" and states how many there were.

## 2. Sites, work ids, and update cursors

(Data model in `database.md` §5.) A batch declares which listing it came from through an optional `origin`, and the
export declares it in snake_case beside `source_site`:

```json
{
  "source_site": "hitomi.la",
  "origin": { "kind": "folder", "ref": "folder-42", "display_name": "Folder 42" },
  "items": ["3220586", "3220587"]
}
```

The site itself is `batch.source`, so an origin only names the listing. It is optional: a hand-made manifest belongs to
no tracked listing, so it leaves work ids but records no cursor. When an origin is present the commit files **every**
work it carried — newly created **and** already held — under its site id, and advances that listing's cursor. Filing the
skip path too means re-running one export over an existing library backfills ids for works imported before this table
existed.

The crawler reads/reports this through one command, which prints JSON on stdout and applies outstanding migrations
first:

```text
pnpm import:cursor status --site hitomi.la --kind folder --ref folder-42 [--db <path>]
pnpm import:cursor filter --site hitomi.la (--ids 100,120 | --ids-file folder.json) [--db <path>]
pnpm import:cursor list   [--site hitomi.la] [--db <path>]
pnpm import:cursor set    --site hitomi.la --kind artist --ref some-artist \
                          [--source-id 3220586] [--work-date 2026-08-01] --commit
```

`filter` is the exact answer for a site whose ids carry no usable order: list the folder, ask, and fetch only the ids it
reports as `unknown`. Its `--ids-file` accepts a bare JSON array, a hitomi-shaped `{"items": [...]}` manifest, or one id
per line. Only `set` writes, and it requires `--commit`; the others never modify the library. `--db` defaults to
`apps/server/.data/library.db` under the repo root.

## 3. Web import workflow (Add Entry page)

The Add Entry page accepts either a complete `site_probe` manifest root **or** a directly selected single-item folder
from any supported adapter (`hitomi.la`, `18comic.vip`, `hanime1.me`).

- For direct item folders, canonical media paths such as `items/<id>/cover/...` and `items/<id>/previews/...` are
  relativized to `cover/...` and `previews/...`; unrelated files such as `raw.html`, diagnostics, and source-specific
  auxiliary metadata do not participate in parsing.
- The folder is read recursively and its relative paths (`webkitRelativePath`) are preserved; local cover and preview
  image files are uploaded to the created Entries **after** the database transaction succeeds.
- A Hitomi author manifest is a list of work ids, and one unusable entry must not block the folder: a work whose
  `items/<id>/metadata.json` is absent (an interrupted extraction leaves the id behind) is skipped and reported in the
  batch's `warnings`, which the review lists as skipped items; the remaining works still preview and commit. A work that
  is present but does not match the export schema is still refused, and the error names **both the work id and the
  offending field**.
- Source metadata is read **tolerantly** where a site simply has no value: an unknown `language` (`null` code and/or
  name, or the key omitted) imports as a work without a Language Facet value rather than as a malformed export.

**Mapping prefill.** The mapping is prefilled automatically from the selected Entry type's shared layout (the layout
created by template Entries of that type). Import type input is resolved against existing Gallery types with NFKC,
trimming, and case-insensitive comparison, so selecting or typing `hentai` reuses the persisted `Hentai` type and its
Hentai template layout instead of creating/querying a separate lowercase type. `分类标签` tags land in the Tags Section's
canonical Facet, while `作品`→Series, `登场人物`→Characters, `作品类型`→Type, and `language`→Language Facets are matched
by normalized Facet name, and `作者` becomes a Producer. Fields whose selected template has no matching Facet remain
explicitly ignored. Comic remains the initial default when present, but changing the import type immediately reloads and
remaps against that type's layout; batch import uses the same type resolution.

**Review never rates individual works.** Bulk imports cannot judge every work, and a uniform score across a batch is
wrong because works by one Author differ, so the review instead offers **per-Author ratings**: each Author row carries an
`implement rating` checkbox, and only ticking it reveals that Author's rating dimensions. Values are keyed by Author name
and re-sent by every commit in a batch run, so one reviewed decision covers the whole run. Choosing a batch folder
previews its first work so those Author rows exist before the run starts; while the batch dialog is open the review shows
a hint instead of its own single-work commit button, because the batch button commits the run.

**Auto `Original` series.** When an imported Entry's meta carries no series information (and nothing was entered), the
commit auto-assigns an `Original` tag under the Gallery's `Series` facet (matched by normalized facet name); Entries that
do carry a series tag are untouched, and Galleries without a Series facet are skipped.

**Post-commit media matching.** Because skipped records make response indexes diverge from manifest indexes, post-commit
local media is matched back to created Entries by `externalKey`, **never by array position**.

**Temporary review Collection.** `POST /api/collections/temporary { entryIds }` files the whole batch into a new
Collection named `临时`, then `临时2`, `临时3`, … (the server picks the first free name) in one transaction; ids that no
longer exist are skipped instead of failing the save. It exists because the batch review after an import is one-time
while a bulk import can be too large to check in one sitting. The review files **both halves** of the run — created and
matched. See `architecture.md` §7 (batch review) and §11 (Collections).

## 4. Source library (derived)

The Source library is a **derived read model, not a second writable store.** `GET /api/entries/:entryId/sources`
extracts every HTTP(S) URL from every Content body, including manually added custom Content, then classifies known hosts
such as Hitomi, 18comic, and Hanime1. Unknown sites remain queryable under their `host:<hostname>` key instead of being
rejected; registered sites use `known:<site>`. Because the projection is rebuilt from authoritative Content,
create/update/delete operations cannot leave a stale Source index and no migration or backfill is required. There is
intentionally no unbounded library-wide HTTP listing yet.

`GET /api/source-library` groups the records and derives matching Entry IDs; a group-level `source_statuses` overlay
(`state: active|invalid`, plus a note) annotates a group **without ever touching Content** (never changes membership or
hides URLs).

## 5. Source maintenance (invalidation workflow)

`source-maintenance/` is the Source invalidation subsystem. `source_statuses` annotates a derived Source group without
touching Content; `source_maintenance_runs` / `_items` persist the durable review workflow so a server restart marks
mid-flight runs `paused` and nothing re-fetches silently.

### Title variants and evidence

- Title variants stay **conservative**: NFKC, separator fragments, the full title preserved, ≤6 queries.
- The evidence layer **bands** candidates rather than using one magic threshold:
  - `exact-safe` requires a **unique full-string trusted-title match**, a free URL and no creator/work-kind conflict.
  - `strong-review` — catalog identity or exact Romaji plus creator support.
  - `ambiguous` / `conflict` / `no-match` / `error` are the other bands; similarity alone is never eligible.
- **Catalog providers** (Bangumi → MangaDex → Wikidata → Kitsu, fixture-first parsers behind an injectable fetch) only
  **supply evidence**. They never commit.

### Target-site adapters

Target sites are reached through registered `SourceSearchAdapter`s with saved fixtures:

- the **never-networked QA adapter** (`fake`),
- **`mangabz`** (hand-written HTML parser),
- **`manhuagui`** (the first config-driven site via the declarative `template-html.ts` template — a new simple-HTML-list
  site now joins with a template config plus fixtures instead of code).

On top of the registry, **`generic-html.ts`** is the fully generic layer for UNKNOWN targets: it discovers the search
endpoint (form → bare input → a bounded set of conventional URL shapes), takes its probe keyword from the site's own
titles, and identifies the result list by **differential search** (probe minus a nonce keyword) — language-independent
and fail-closed. Verified blind against six foreign sites: it fully auto-discovered `dongmanhi.com` (12 rows, reusable
template) and `nhentai.net` / `kanman` / `manben` / `60ti` / `mh03` fall into three honest buckets (bot-block 403 / SPA
needing a JSON adapter / no differentiable HTML list).

`POST /api/source-maintenance/adapter-probe` maps a user-supplied target homepage onto one registered adapter behind an
**SSRF checklist** (https-only, no credentials, standard port, no loopback/private/metadata hosts); anything else answers
422 "Unsupported target; adapter required".

### Run/commit lifecycle

- `start`/`resume` execute the resumable job in the background; runs found `running` at server startup are flipped to
  `paused` and wait for an explicit resume.
- `commit` **re-verifies every accepted item** (entry existence, title and origin snapshot, URL normalization,
  target-origin pinning, full-library URL ownership), takes a **real backup**, then appends the new `Source URL` Contents
  plus the optional group invalid annotation in one transaction — any stale or conflicting fact aborts the batch with
  409 and **zero writes**.
- Old URLs are never replaced or deleted.

## 6. Relation suggestions (autocomplete read model)

Read-only endpoints intentionally separate from global search and bounded page queries. A candidate is eligible **only**
when its canonical normalized name or an allowed normalized alias **contains the complete normalized query**;
popularity never admits an otherwise ineligible candidate. Ranking then prefers canonical exact/prefix/word-boundary/
substring matches, followed by the equivalent alias classes, context usage, total usage, normalized name, and numeric ID.

- `q` is required after trimming (max 200 chars), `limit` is 1–20, and at most 100 unique positive exclusion IDs.
- Entry Tag aliases use only the Entry vocabulary; Producer Tag aliases exclude the `authors` partition; Author identity
  suggestions use only that partition and include Authors with no linked works.
- `includeNsfw=false` puts Tag suggestions inside the same visibility boundary as everything else: a tag whose every
  assignment sits in a hideable Gallery (or, for the Producer vocabulary, on an Author whose works are all in hideable
  Galleries) is not offered. A tag nothing carries is never offered at all, in either mode.
- Clients pass `false` for a subject whose own partition is not hideable (the Entry editor uses its Gallery, the Author editor the
  Author's derived state) and the **Show hideable galleries** switch only where no single subject is being edited.
- Responses are strict lightweight `{ id, name, matchedAlias?, sameContextUsageCount, totalUsageCount }[]` capped at 20.
  No migration or write is involved.

The editing control (`SuggestionInput.vue`) enforces the same rule locally: it sends the normalized query only after a
visible character, debounces at 150ms, aborts superseded requests, drops stale responses, suppresses requests and commits
during IME composition, and treats blur as close-only — committing is an explicit Enter (highlighted candidate, or the
typed text in creatable mode) or a candidate click. See `architecture.md` §16.

## 7. Taxonomy aliases and tag cleanup

Alias rows map a spelling to a canonical name per vocabulary (`entry` / `producer`). Rows carry a `partition` label
(series / characters / types / tags / authors / `''`) so dictionary imports keep their source buckets. A row whose
`canonicalName` is empty is a **placeholder**: it records a name still awaiting a canonical and never participates in
name resolution — the Advanced editing page lists placeholders with a one-click fill into the alias form.
`POST /api/taxonomy-aliases` upserts a single row and rejects an empty canonical for hand entry;
`POST /api/taxonomy-aliases/import` bulk-imports parsed dictionary rows (placeholders allowed) and never downgrades an
already-filled mapping to a placeholder.

The current Tags page asks for `includeTags=1` and reads a catalog derived from the Entry tag vocabulary plus these
stored mappings. Tags created by new works therefore appear immediately as unmapped; translating them inserts an alias
mapping rather than requiring a site dictionary file first. The visible groups are unmapped and mapped, independent of
the historical partition labels. A catalog row carries `tagId`; its delete-tag action removes that library tag after
confirmation. A stored alias row instead offers removal of the mapping. Author identity aliases remain on Authors.

**Unassigned Entry tag cleanup.** `GET /api/tags/unassigned` returns one group per Entry type that still has tags sitting
in the type's unnamed default Facet ("未分类"). Each group carries the type's named Facets (the valid move targets) and
its unassigned tags with `entryCount` plus an optional `suggestion` = the named Facet where the REST of that type's
entries keep the tag (majority by entry count). `POST /api/tags/unassigned/move { entryType, tagId, targetFacetId }`
relocates every unassigned placement of ONE tag within ONE type onto a named target Facet of the same type; placements
already on named Facets and other types are untouched (cross-type targets conflict 409). The tag vocabulary is global,
so the same tag name can be unassigned in one gallery and classified in another — grouping per type keeps the target
list honest. No schema change; pure `UPDATE entry_tags`.

## 8. Legacy schema-integration note (historical)

Website adapters intentionally persist nothing. `packages/shared/src/schemas/import.ts` is the runtime-validated canonical
import boundary; adapters emit `ImportBatch`, and persistence consumes that type rather than website JSON.
`apps/server/src/import/site-probe.ts` loads 18comic / Hanime1 / Hitomi exports, validates source documents, confines
local media paths to the export root, and returns canonical entries. `apps/server/src/import/preview.ts` provides a
database-free structural preview; commit rejects duplicate normalized titles, duplicate external keys, and unreviewed
fields or Producer matches. Legacy site mapping: 18comic — only `分类信息.分类标签` becomes canonical tags (works,
characters, authors remain candidate fields); Hanime1 — accepted `tags` become canonical tags, raw tags remain a
candidate field, and the watch page is stored only as a source (no playback/download); Hitomi — an author manifest is
resolved through its explicit `items/<source_id>/metadata.json` references, with type/language/date/page count as
candidate fields. Baozimh has no export data, so no selectors or format were invented.
