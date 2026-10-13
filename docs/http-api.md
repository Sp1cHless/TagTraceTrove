# T³ HTTP API board — routes and shared contracts

> The local API is implemented by `apps/server/src/http/app.ts` and served by `apps/server/src/http/server.ts`. Routes
> validate transport input and output with `@t3/shared` Zod contracts and delegate all persistence to repositories.
> Product model: `architecture.md`. Schema: `database.md`. Offline routes: `offline-sync.md`.

## 1. Run locally

```bash
pnpm start:server        # production (API + built web UI from one origin)
pnpm dev:server          # development watch mode
```

Single-process production serves the API **and** the built `apps/web/dist` UI from `http://127.0.0.1:8765`. Static files
are served before a single-page fallback that returns `index.html` for any non-`/api` GET; `/api` responses are never
swallowed. Packaged entries live at the repo root: `T3.exe` (recommended tray launcher) and `T3.bat`. See `development.md`.

Defaults: `T3_HOST=127.0.0.1`, `T3_PORT=8765`, `T3_DATA_DIR=.data`, `T3_DB_NAME=library.db`, `T3_STATIC_ROOT=<repo>/apps/web/dist`.
Binding outside localhost is rejected unless `T3_ENABLE_LAN=true` is explicitly set. Browser CORS responses allow
localhost and loopback origins only by default.

## 2. Shared contract boundary

`packages/shared/src/schemas/api.ts` is the public validation boundary shared by the server and web app. Routes must parse
path parameters, query parameters, request bodies, and repository results with these schemas rather than maintaining
route-local DTOs. `packages/shared/src/schemas/suggestions.ts` holds the Relation-suggestion contracts; the pure
`search/suggestions.ts` policy keeps Relation eligibility separate from ranking.

### Contract families

- **Entry**: create, partial update, record, complete detail, and bounded SQL pages. (The full-array Entry list and tag-filtered summary contracts are retired.)
- **Layout**: create Section/Facet, rename/reorder groups, and ordered layout responses.
- **Entry Tags**: assign, move, list assignment, per-type usage counts, and include/exclude filters.
- **Entry Content**: create, partial update, record, and complete-list reorder.
- **Entry Source projection**: URL records detected from arbitrary Content and the transactional same-Author Entry merge request/report.
- **Ratings**: create shared slot (idempotent by name), upsert `{ slotId, stars }` (null = unrated, 0.5–5 half steps), and composed rating rows embedded in Entry/Author detail responses.
- **Producer**: create, partial update, record, Entry linking parameters, Producer Tags, independent Author/work-Tag filter options, same-work AND Tag search, and Author work summaries carrying view/like/last-viewed usage.
- **Producer pages**: bounded Author summaries for ID-backed lists, ranked search, Tag filters, usage/name/source ordering, and one-shot random samples.
- **Usage**: record-a-view / add-a-like mutations returning the updated `entry_usage` record; the same usage fields ride on Entry and Author summaries and details. **Sorting-only by design** — no numeric or date condition schemas.
- **Gallery partition**: `{ nsfw: boolean }` body on `PUT /api/galleries/:entryType/partition`; `nsfw` flags on Gallery and Producer summaries drive every visibility boundary.
- **Collections**: create/read/update/delete per kind (`entry | producer`), compact trees with member counts/cover previews, folder-level `{ nsfw }` switch, per-kind reorder lists (duplicate IDs rejected), idempotent member put/delete routes, and `for-entry` / `for-producer` membership queries. Member cards use the bounded Entry/Producer page contracts with `collectionId`; the legacy non-compact detail response remains compatible.
- **View later**: strict `{ entryIds: number[], producerIds: number[] }` shared-state response; GET reads both independent library-wide lists. PUT/DELETE by Entry or Producer id are idempotent. `{ entryIds }` merge only imports the legacy browser Entry list without replacing either server list. Duplicate wire IDs are rejected; the client deduplicates legacy input first.
- **Gallery templates**: `GET /api/templates` returns per-Gallery summaries (structure, tag→facet assignments, local file paths, existence flags); apply responses keep relaxed objects (unknown fields ignored) so a version-mismatched server or cached page can never turn a successful apply into a spurious 400.
- **Author alias groups**: save `{ displayName, tagNames }` (duplicate spellings rejected; spellings equal to the display name are dropped) and grouped listings of `{ canonicalName, aliases, producerId, producerName }`; the save response embeds the full producer-merge report that collapsed existing duplicates into the display-name row.
- **Global search**: shared scope enum, trimmed query, optional Entry type, optional Tag-search `includeNsfw`, Entry/Producer card summaries, and partition-aware Tag hit summaries with usage counts.
- **Relation suggestions**: dedicated strict Tag/Author query schemas plus lightweight suggestion DTOs. Query text is trimmed/nonblank/max-200, result limits are 1–20, exclusions are at most 100 unique positive IDs, and response arrays are capped at 20 unique canonical numeric IDs. Relation matching uses the separate pure full-normalized-substring policy rather than global-search fuzzy ranking.
- **Common**: positive integer path IDs, mutation success, and structured API errors.

All object schemas are **strict**. Required labels are trimmed and reject blank values. Partial update bodies reject empty
objects. IDs are positive integers. Reorder lists and tag-filter lists reject duplicate IDs. Empty update bodies, blank
required labels, non-positive IDs, duplicate reorder IDs, duplicate filter IDs, blank suggestion queries, and suggestion
limits above 20 are rejected **before** repository calls.

### Bounded long-list contract

`entryPageQueryRequestSchema` is the additive bounded long-list contract used by Gallery, Entry search, Entry Tag results,
Recently viewed, Random works, View later entries, and batch-import review. It keeps the existing Facet/Author/Rating/Usage
filter body and adds optional source constraints: `entryType`, `entryIds`, `includeTagIds`, `excludeEntryTypes`,
`searchQuery`, `recentOnly`, `producerDirectoryId`, `looseForProducerId`, `collectionId`, and `includeNsfw`.

- Generic sort values are `date-desc | date-asc | title-asc | title-desc | type | source-order | random`;
  `source-order` requires `entryIds` and preserves their wire order, while random accepts a stable request seed.
- `page` is positive and one-based, `pageSize` is bounded to 1–100. Defaults: newest-first, page 1, 30 cards.
- Strict response: `{ items, total, page, pageSize }`; `total` is the complete filtered count, not the current page length.
- Usage count fields (`views`, `likes`) take non-negative integers; `lastViewed` takes `yyyy-mm-dd`.
- **Sort precedence** when generic, rating, and usage sorts coexist: usage sort wins over rating sort, which wins over
  generic sort. Upload-date nulls retain the old Gallery behavior (last under descending, first under ascending). Title
  ordering is deterministic SQLite `NOCASE` ordering with `id` tie-breaks.

The full-array Entry browse/filter routes are retired; every list surface uses the bounded query. Only the legacy
full Producer list remains, for editor autocomplete. Random works use one bounded server sample
and keep that returned set in the page state; `source-order` lets ID-backed lists avoid loading every Gallery. Entry search
preserves the established ranked search implementation on the server and slices only the requested result page before
crossing the HTTP boundary.

### Query encoding

Tag filter queries accept either number arrays after framework parsing or comma-separated wire values:

```text
?entryType=game&includeTagIds=1,2&excludeTagIds=3
?entryType=game
?ownTagIds=4&relatedEntryTagIds=1,2
```

Every include/search set retains repository AND semantics. Excluded Entry Tags retain `NOT EXISTS` semantics. Global
search uses `?q=...` (required, trimmed, 1–200 characters); Entry-title search alone also accepts optional `entryType` for
an exact Gallery boundary, while Tag search accepts optional `includeNsfw=true|false`. `searchScopeSchema` is the
UI/shared vocabulary (`entries | tags | producers`), while the wire API keeps one explicit endpoint per scope.

The per-type Entry Tag query returns `{ id, name, normalizedName, entryCount }` records for building one Gallery's filter
controls.

An Entry detail's `producers` entries carry a derived `entryCount` — the number of Entries linking that Author — which
Entry edit mode uses to offer the multi-author cleanup only while some Author is limited to the open work.
`multiAuthorProducerName` (`multiple author`) is the shared canonical Author that cleanup targets, so both sides agree on
the name without duplicating the string.

Offline sync contracts (`schemas/sync.ts`) are strict end to end: see `offline-sync.md` §2. Source maintenance contracts
are strict as well: see `import-and-source.md` §5.

### Errors

```json
{
  "error": {
    "code": "VALIDATION_ERROR | NOT_FOUND | CONFLICT | INTERNAL_ERROR",
    "message": "Human-readable summary",
    "details": {}
  }
}
```

`details` is optional. Routes must **not** expose raw SQLite errors or database terminology in normal UI messages.

### Deliberate boundaries

- The complete Entry response preserves unnamed Facets as `name: ""`; presentation code decides whether to hide their label.
- Producers and Entry Content remain outside `sections`; rating rows ride on the detail responses as `ratings`, never inside Sections.
- Entry and Producer Tag contracts remain separate even when their display names match.
- `contentType` remains free text.
- HTTP routes consume these schemas in `apps/server/src/http/app.ts`; canonical Import persistence uses its separate reviewed mapping contract in `packages/shared/src/schemas/import.ts`.

## 3. Route inventory

### Entries and layouts

```text
GET    /api/galleries
PUT    /api/galleries/:entryType/partition
GET    /api/templates
POST   /api/entries
POST   /api/entries/query
GET    /api/entries/:entryId
PATCH  /api/entries/:entryId
POST   /api/entries/merge
POST   /api/entries/:entryId/multi-author
POST   /api/entries/titles/plan
POST   /api/entries/titles/apply
GET    /api/entries/:entryId/sources
POST   /api/entries/:entryId/template/apply
POST   /api/entries/:entryId/tag-layout/apply
GET    /api/entries/facet-options/:entryType
GET    /api/tags/unassigned
POST   /api/tags/unassigned/move

POST   /api/sections
POST   /api/facets
GET    /api/layouts/:entryType
PATCH  /api/tag-groups/:groupId/name
PATCH  /api/tag-groups/:groupId/order
PUT    /api/sections/:sectionId/facets/order
DELETE /api/facets/:facetId
DELETE /api/sections/:sectionId
```

`GET /api/galleries` derives its results by grouping existing Entries by `type`; it does not read a Gallery table.
`entryType` is optional on `POST /api/entries/query`: Gallery browsing supplies it, while an Entry Tag result page omits it
to find matching Entries across all Gallery types.

`POST /api/entries/merge` is the Author-edit work merge. Its body selects one keeper Entry, one absorbed Entry, whether to
union Tags, which detected Source URLs to copy, and optionally the `title` to store on the keeper. The server requires two
different Entries linked to the same active Author and belonging to the same Gallery. It validates that every selected URL
came from Content on the absorbed Entry, copies missing Tags, deduplicated URLs as new `Source URL` Content rows, and all
Producer/Author links onto the keeper, then deletes the absorbed Entry in one SQLite transaction. A trimmed, non-empty
`title` overwrites the keeper's title; omitting `title` keeps whatever it already had. No third Entry is created. Other
Content/media/Ratings/usage/Directory/Collection/View later from the absorbed Entry are deliberately not copied. Media
cleanup runs after the database commit; if filesystem cleanup fails the merge still returns HTTP 200 with
`mediaCleanupFailed: true` so clients do not misreport an already committed destructive operation as a failed merge.

`POST /api/entries/:entryId/multi-author` takes no body. It replaces every credited Author of that Entry with one shared
Author named `multiple author`, reusing an existing Author of that name when present. The server refuses an Entry with
fewer than two linked Authors with HTTP 409 and writes nothing. A work that already carries only the `multiple author`
Author succeeds with an empty `convertedAuthors`. Response reports `entryId`, `multiAuthorId`, `multiAuthorName`,
`convertedAuthors`.

`GET /api/entries/:entryId/sources` extracts every HTTP(S) URL from every Content body and classifies known hosts;
unknown sites remain queryable under `host:<hostname>`; registered sites use `known:<site>`. There is intentionally no
unbounded library-wide HTTP listing yet.

`POST /api/entries/query` is the single bounded Entry-summary endpoint (see §2). Gallery, Entry search, Entry Tag results,
Recently viewed, Random works, View later entries, batch-import review, Home recents, Author works/directories, and
Collection Entry members use this route. Full-array Entry browse/filter routes are retired; the remaining full Producer
list is limited to editor autocomplete until that surface becomes remotely searchable.

`POST /api/entries/titles/plan` takes no body and lists every Entry whose title carries exactly one `|` with a non-empty
side on each end, as `{ candidates: [{ entryId, title, keepFront, keepBack, suggested }] }`. `suggested` is `back` when
the part after the separator carries Han or Kana text, `front` when that part carries only Hangul, and null when both
sides are ASCII. `POST /api/entries/titles/apply` takes the chosen `changes`, writes a `<db>.title-backup-<timestamp>`
snapshot for a file-backed database first, and applies only changes whose Entry still carries the reviewed `title` —
anything else is counted in `skippedCount`.

`POST /api/entries/:entryId/template/apply` rebuilds the shared Section/Facet layout of the Entry's type from its current
structure (names and order), then re-maps every Entry of that type onto the rebuilt Facets — assignments match by
normalized (Section name, Facet name), duplicate spellings collapse, and tags whose old Facet is gone move to the Tags
default Facet. File-backed databases get a `<db>.template-backup-<timestamp>` snapshot first; the response reports
`entriesAffected`, `tagsRelinked`, `orphansMoved`, `sectionsRecreated`, `backupPath` and FK/doctor results.

`POST /api/entries/:entryId/tag-layout/apply` is the tag-only sibling: it never touches the shared layout. Each tag the
source Entry carries becomes the standard placement — every other Entry of the SAME type that has that tag under a
different Facet has its assignment moved onto the source Facet. Peers without the tag and other Entry types are untouched.
File-backed databases get a `<db>.taglayout-backup-<timestamp>` snapshot first; the response reports `entriesAffected`,
`tagsMoved`, `entriesScanned`, `backupPath` and FK/doctor results.

`GET /api/entries/facet-options/:entryType` aggregates, across all Entries of one type, every named Facet and the tags
assigned to it (unnamed default Facets are omitted as rows, but their tags are still listed), plus `allTags` and `authors`.
A tag that different Entries place under different Facets deliberately appears under each of those Facets. An optional
`?authorId=` scopes the aggregation to one Author's works. It also returns the Gallery's shared `ratingSlots` so the filter
bar can render its rating rows.

**Template files.** `template/apply` and `tag-layout/apply` each also rewrite that Gallery's canonical template files under
`<dataDir>/templates/`: `<type>.template.json` (Section → Facet structure) and `<type>.tag-layout.json` (every tag's facet
placement, refreshed whenever a placement is applied). `GET /api/templates` lists per-Gallery summaries. Import
(`commitImportBatch`, single and batch) consults the same data: each imported tag is placed by the majority facet of that
tag inside the target Gallery.

### Entry media and thumbnails

```text
PUT    /api/entries/:entryId/media/cover
PUT    /api/entries/:entryId/media/preview
GET    /api/assets/entries/:entryId/:fileName
GET    /api/thumbnails/entries/:entryId/:fileName
GET    /api/assets/entries/:entryId/thumbnails/:hashedFileName
```

Cover/preview uploads retain the original file and generate a card-only WebP with a 512px maximum dimension. Cards request
the thumbnail resolver, which issues a no-cache redirect to a source-hash-addressed WebP; hashed thumbnail responses are
private, immutable for one year. If an existing source has not been backfilled yet, the resolver redirects to the original
asset. Entry detail pages request originals directly. `pnpm media:thumbnails` backfills `<dataDir>/assets`; completed images
are skipped and failures do not stop later images. **No database row or migration stores thumbnail state.**

### Usage tracking (views and likes)

```text
POST   /api/entries/:entryId/views
POST   /api/entries/:entryId/likes
```

`POST .../views` increments the Entry's `entry_usage` row (created lazily) and returns the updated record. The client
records a view only when the user actually opens the Entry's `source url` (recorded before `window.open`); opening the
detail card never counts. `POST .../likes` adds 1 to `like_count` — unlimited and re-clickable. Author-side numbers are
derived by aggregating their works. The UI offers usage as **sorting only**.

### Shared View later

```text
GET    /api/view-later
POST   /api/view-later/merge
PUT    /api/view-later/:entryId
DELETE /api/view-later/:entryId
PUT    /api/view-later/producers/:producerId
DELETE /api/view-later/producers/:producerId
```

Two independent SQLite-backed lists (Entries and Producers/Authors) are authoritative for every desktop/mobile browser
connected to the library. GET and every mutation return `{ entryIds: number[], producerIds: number[] }` in insertion
order. PUT adds one existing subject idempotently; DELETE removes membership without deleting the subject; deleting an
Entry or Author cascades its membership. Merge accepts `{ entryIds }`, appends surviving missing legacy Entry memberships
without replacing server state, and ignores stale ids. The web client merges `t3.view-later` once, removes that
localStorage key only after success, then refreshes both lists on startup, View later entry, and window focus. No
WebSocket/SSE: clients may be briefly stale but converge on the next pull.

### Navigation counts

```text
GET /api/navigation-counts?includeNsfw=true|false
```

One interface answers the sidebar's visibility-aware numbers: `{ authors, viewLaterEntries, viewLaterAuthors }` (see
`architecture.md` §19).

### Collections

```text
GET    /api/collections?kind=entry|producer
POST   /api/collections
PATCH  /api/collections/:collectionId
DELETE /api/collections/:collectionId
PUT    /api/collections/:collectionId/nsfw
POST   /api/collections/temporary
PUT    /api/collections/order
POST   /api/collections/:collectionId/tags
PUT    /api/collections/:collectionId/entries/:entryId
DELETE /api/collections/:collectionId/entries/:entryId
PUT    /api/collections/:collectionId/producers/:producerId
DELETE /api/collections/:collectionId/producers/:producerId
GET    /api/collections/for-entry/:entryId
GET    /api/collections/for-producer/:producerId
```

`POST /api/collections/temporary` takes `{ entryIds }` and files that whole batch into a new Collection named `临时`, then
`临时2`, `临时3`, … (the server picks the first free name), returning `{ collectionId, title, entryCount }` in one
transaction; ids that no longer exist are skipped. `PUT /api/collections/order` persists one kind's visible order.
Membership routes are idempotent links; removal only unlinks. The web directory calls
`GET /api/collections?...&compact=true&includeNsfw=...`: each folder carries filtered member counts and at most three
member previews for its cover. Opening a folder pages Entry members through `/api/entries/query` or Author members through
`/api/producers/query` with `collectionId`. The `for-entry` / `for-producer` queries return the collections a subject
already belongs to (drives the ✓-marked add-to-collection menus).

`POST /api/collections/:collectionId/tags` with `{ name }` puts one Tag on every work that folder holds (child folders'
works included) and answers `{ tagId, entriesAffected, alreadyPresent, skipped }`. Each work keeps the placement its own
Gallery already uses; an unseen name lands in the Gallery's default empty-named Facet. A work whose Gallery has no
structure yet is reported as `skipped` instead of failing the request.

Every Collection record carries `galleryType` (migration 017). On an entry folder it names the Gallery page the folder is
curated under; `null` means unfiled; a producer folder is always `null`. `POST /api/collections` accepts an optional
`galleryType` for `kind: "entry"`; a nested folder always inherits its parent's page and rejects a different one; asking
for a Gallery on a producer folder is refused. `POST /api/collections/temporary` files an imported batch by its members'
Entry type, staying unfiled only when the batch spans Galleries.

### Global search

```text
GET    /api/search/tags?q=...&includeNsfw=false
```

Entry and Author search submit `searchQuery` to their bounded page endpoints; only Tag search retains a dedicated GET
route. Search text is trimmed and limited to 200 characters. Tag search accepts `includeNsfw`; with `false`, tags used
only by NSFW Galleries are omitted and shared-tag counts include only SFW usage. Tag hits return
`{ tagId, name, normalizedName, entryCount }` and open the cross-Gallery Tag results view.

### Offline sync

```text
GET  /api/sync/capabilities
GET  /api/sync/snapshot?media=none|thumbnails
POST /api/sync/replay
PUT  /api/sync/media/:uploadId
```

Full contract (capability flags, snapshot format, replay operation kinds, idempotency, media rules) is in `offline-sync.md`.

### Source maintenance

```text
GET    /api/source-library
GET    /api/source-statuses
PATCH  /api/source-statuses/:sourceKey
POST   /api/source-maintenance/adapter-probe
POST   /api/source-maintenance/runs
GET    /api/source-maintenance/runs/:runId
POST   /api/source-maintenance/runs/:runId/start|pause|resume|cancel
GET    /api/source-maintenance/runs/:runId/items?page=&pageSize=&state=
PATCH  /api/source-maintenance/runs/:runId/items/:entryId
POST   /api/source-maintenance/runs/:runId/commit
```

See `import-and-source.md` §4–5 for the derived read model, the SSRF-checked adapter probe, and the run/commit lifecycle
(re-verify everything, real backup, one transaction, 409 + zero writes on any stale fact).

### Relation suggestions

```text
GET /api/suggestions/tags?vocabulary=entry|producer&q=...&limit=20&excludeIds=1,2&entryType=...&facetId=...&includeNsfw=true|false
GET /api/suggestions/producers?q=...&limit=20&excludeIds=1,2
```

Read-only, separate from global search and bounded page queries. See `import-and-source.md` §6.

### Entry Tags and Content

```text
GET    /api/entry-tags?entryType=...
POST   /api/entries/:entryId/tags
GET    /api/entries/:entryId/tags
PATCH  /api/entries/:entryId/tags/:tagId
PATCH  /api/entries/:entryId/tags/:tagId/name
DELETE /api/entries/:entryId/tags/:tagId

POST   /api/entries/:entryId/contents
PATCH  /api/contents/:contentId
DELETE /api/contents/:contentId
PUT    /api/entries/:entryId/contents/order

POST   /api/entries/:entryId/rating-slots
PUT    /api/entries/:entryId/ratings
```

`GET /api/entry-tags?entryType=...` returns the Entry Tag vocabulary currently used by one logical Gallery, including the
number of Entries carrying each Tag. With `entryType` omitted it returns the same usage counts across every Gallery (the
random-tag picker uses this). The rename route retargets only the selected Entry assignment to a normalized,
reused-or-created Tag; it does not rename shared uses on other Entries.

### Producers (Authors)

```text
POST   /api/producers
PATCH  /api/producers/:producerId
GET    /api/producers/:producerId
GET    /api/producers?ownTagIds=1,2&relatedEntryTagIds=3
POST   /api/producers/query
GET    /api/producers/filter-options?entryType=Comic&includeNsfw=false

PUT    /api/entries/:entryId/producers/:producerId
DELETE /api/entries/:entryId/producers/:producerId

POST   /api/producers/:producerId/tags
GET    /api/producers/:producerId/tags
PATCH  /api/producers/:producerId/tags/:tagId/name
DELETE /api/producers/:producerId/tags/:tagId

POST   /api/producers/:producerId/directories
PATCH  /api/author-directories/:directoryId
PUT    /api/producers/:producerId/directories/:directoryId/entries/:entryId
DELETE /api/producers/:producerId/directories/:directoryId/entries/:entryId

POST   /api/producers/:producerId/rating-slots
PUT    /api/producers/:producerId/ratings

POST   /api/producers/merge/plan
POST   /api/producers/merge
```

`POST /api/producers/query` is the bounded summary counterpart to the compatibility `GET /api/producers` route (which
remains only for editor autocomplete). It supports ID-backed lists, Collection membership, ranked name search,
dominant-Gallery and NSFW boundaries, the two Tag filter sets, usage/name/source ordering, and seeded random ordering;
filtering, stable sorting, count, and `LIMIT/OFFSET` occur before card cover enrichment. Page size is capped at 100.
`GET /api/producers/:producerId` returns Author metadata, counts, cover previews, Tags, Ratings, and compact Directory
summaries; works are paged through `/api/entries/query`. `ownTagIds` searches only the Producer Tag vocabulary.
`searchQuery` matches an author's display name and their recorded alias spellings. `relatedEntryTagIds` requires one
related Entry to carry every selected Entry Tag; the two sets AND together.
`GET /api/producers/filter-options` returns the assigned Author Tag and related-work Tag vocabularies used by eligible
Authors; `entryType` optionally scopes Authors by dominant Gallery and `includeNsfw=false` excludes options belonging only
to hidden NSFW Authors. Producer responses carry `galleryType` (the Author's dominant Gallery, derived at read time,
never stored). `GET /api/producers`, `POST /api/producers/query`, and name search **exclude Producers with no linked
Entries** (a read-time visibility rule, not automatic deletion); `GET /api/producers/:producerId` still permits direct
create/edit access to a workless Producer.

**Ratings.** `POST /api/entries/:entryId/rating-slots` (body `{ name }`) creates the slot for the Entry's whole Gallery
(idempotent); `PUT /api/entries/:entryId/ratings` (body `{ slotId, stars }`) upserts the Entry's value; `stars: null`
clears to unrated, anything outside 0.5–5 half steps is a 400. The Producer pair is partition-aware: the slot joins the
Author's dominant-Gallery partition (409 when a workless Author has none) and instantly appears on every
same-dominant-Gallery Author. Both detail responses embed composed `ratings` rows (slotId, name, stars|null) in slot
order. `PUT /api/entries/:entryId/rating-slots/order` and `PUT /api/producers/:producerId/rating-slots/order` (body
`{ orderedSlotIds }`, every slot exactly once) reorder the rating section on every same-Gallery card / same-partition
Author in one call. `GET /api/rating-slots?entryType=...` lists a Gallery's shared slots for the import/entry-composer
rating pickers.

Rating filtering rides on `POST /api/entries/query`: `ratingConditions` (`{ slotId, operator: eq|gt|lt|unrated, stars }`)
AND with every tag row and the author list (`unrated` takes no stars; a slot from a foreign Gallery is a 409), and
`ratingSort` (`{ slotId, direction: 'desc', applyAuthorRating }`) orders high-to-low with unrated sinking below every
rated one. `applyAuthorRating` (default false) makes a work fall back to its Authors' rating for the same-named Author
dimension when the work carries no value; the work's own value always wins, a work with four or more Authors never
inherits one, and a Gallery with no matching Author dimension has nothing to fall back to.

`POST /api/producers/merge/plan` returns the would-be merge plan without writing. `POST /api/producers/merge` executes it:
backs up a file-backed database first (`<db>.merge-backup-<timestamp>`; in-memory returns `backupPath: null`), runs in one
transaction with foreign keys temporarily disabled, then reports per-plan rows and totals plus `foreign_key_check` +
doctor results.

### Author alias groups

```text
GET    /api/author-alias-groups
POST   /api/author-alias-groups
```

An alias group is `{ displayName, tagNames: [...] }`: every tag name maps to the display name as a `producer`-vocabulary
dictionary row (partition `authors`). `POST` writes the rows and then runs the producer merge (with the same file-backed
backup), collapsing existing duplicate producers into one row that carries the display name. Duplicate spellings inside
one request are a 400; spellings equal to the display name are dropped as no-ops. `GET` groups the dictionary back into
`{ canonicalName, aliases[], producerId, producerName }` rows (`producer*` null when no Author row exists yet). See
`architecture.md` §10.

### Taxonomy aliases

```text
GET    /api/taxonomy-aliases?vocabulary=entry|producer
POST   /api/taxonomy-aliases
POST   /api/taxonomy-aliases/import
DELETE /api/taxonomy-aliases/:aliasId
```

See `import-and-source.md` §7.

## 4. Error boundary

- malformed JSON or invalid Zod input → `400 VALIDATION_ERROR`
- missing route or repository subject → `404 NOT_FOUND`
- SQLite/domain constraint conflict → `409 CONFLICT`
- unexpected failure → `500 INTERNAL_ERROR`

Raw SQLite errors are never returned.

### Unassigned tag cleanup (Advanced editing)

```text
GET  /api/tags/unassigned
POST /api/tags/unassigned/move   body: { entryType, tagId, targetFacetId }
```

See `import-and-source.md` §7.
