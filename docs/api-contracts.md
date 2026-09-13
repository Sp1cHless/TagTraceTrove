# Shared API contracts

`packages/shared/src/schemas/api.ts` is the public validation boundary shared by the server and web app. Routes must parse path parameters, query parameters, request bodies, and repository results with these schemas rather than maintaining route-local DTOs.

## Contract families

- Entry: create, partial update, record, complete detail, legacy full-list/tag-filtered summaries, and bounded SQL pages.
- Layout: create Section/Facet, rename/reorder groups, and ordered layout responses.
- Entry Tags: assign, move, list assignment, per-type usage counts, and include/exclude filters.
- Entry Content: create, partial update, record, and complete-list reorder.
- Entry Source projection: URL records detected from arbitrary Content and the transactional same-Author Entry merge request/report.
- Ratings: create shared slot (idempotent by name), upsert `{ slotId, stars }` (null = unrated, 0.5–5 half steps), and composed rating rows embedded in Entry/Author detail responses.
- Producer: create, partial update, record, Entry linking parameters, Producer Tags, independent Author/work-Tag filter options, same-work AND Tag search, and Author work summaries carrying view/like/last-viewed usage.
- Producer pages: bounded Author summaries for ID-backed lists, ranked search, Tag filters, usage/name/source ordering, and one-shot random samples.
- Usage: record-a-view / add-a-like mutations returning the updated `entry_usage` record (view count, last-viewed timestamp, like count); the same usage fields ride on Entry and Author summaries and details. Sorting-only by design — no numeric or date condition schemas.
- Gallery partition: `{ nsfw: boolean }` body on `PUT /api/galleries/:entryType/partition`; `nsfw` flags on Gallery and Producer summaries drive every visibility boundary.
- Collections: create/read/update/delete per kind (`entry | producer`), compact trees with member counts/cover previews, folder-level `{ nsfw }` switch, per-kind reorder lists (duplicate IDs rejected), idempotent member put/delete routes, and `for-entry` / `for-producer` membership queries. Member cards use the bounded Entry/Producer page contracts with `collectionId`; the legacy non-compact detail response remains compatible.
- View later: strict `{ entryIds: number[], producerIds: number[] }` shared-state response; GET reads both independent library-wide lists. PUT/DELETE by Entry or Producer id are idempotent. `{ entryIds }` merge only imports the legacy browser Entry list without replacing either server list. Duplicate wire IDs are rejected; the client deduplicates legacy input first.
- Gallery templates: `GET /api/templates` returns per-Gallery summaries (structure, tag→facet assignments, local file paths, existence flags); apply responses keep relaxed objects (unknown fields ignored) so a version-mismatched server or cached page can never turn a successful apply into a spurious 400.
- Author alias groups: save `{ displayName, tagNames }` (duplicate spellings rejected; spellings equal to the display name are dropped) and grouped listings of `{ canonicalName, aliases, producerId, producerName }`; the save response embeds the full producer-merge report that collapsed existing duplicates into the display-name row.
- Global search: shared scope enum, trimmed query, optional Entry type, optional Tag-search `includeNsfw`, Entry/Producer card summaries, and partition-aware Tag hit summaries with usage counts.
- Relation suggestions: dedicated strict Tag/Author query schemas plus lightweight suggestion DTOs. Query text is trimmed/nonblank/max-200, result limits are 1–20, exclusions are at most 100 unique positive IDs, and response arrays are capped at 20 unique canonical numeric IDs. Relation matching uses the separate pure full-normalized-substring policy rather than global-search fuzzy ranking.
- Common: positive integer path IDs, mutation success, and structured API errors.

All object schemas are strict. Required labels are trimmed and reject blank values. Partial update bodies reject empty objects. IDs are positive integers. Reorder lists and tag-filter lists reject duplicate IDs.

`entryPageQueryRequestSchema` is the additive bounded long-list contract used by
Gallery, Entry search, Entry Tag results, Recently viewed, Random works, View
later entries, and batch-import review. It keeps the existing
Facet/Author/Rating/Usage filter body and adds optional source constraints:
`entryType`, `entryIds`, `includeTagIds`, `excludeEntryTypes`, `searchQuery`,
`recentOnly`, `producerDirectoryId`, `looseForProducerId`, `collectionId`, and
`includeNsfw`. Generic sort values are `date-desc | date-asc | title-asc |
title-desc | type | source-order | random`; `source-order` requires `entryIds`
and preserves their wire order, while random accepts a stable request seed. `page` is positive and one-based, while `pageSize`
is bounded to 1–100. Defaults are newest-first, page 1, 30 cards. The strict
response is `{ items, total, page, pageSize }`; `total` is the complete filtered
count, not the current page length. Usage count fields (`views`, `likes`) take
non-negative integers, while `lastViewed` takes `yyyy-mm-dd`.

The old full-array endpoints remain compatible for consumers not yet converted.
Random works now use one bounded server sample and keep that returned set in the
page state; `source-order` lets ID-backed lists avoid loading every Gallery.
Entry search preserves the established ranked search implementation on the
server and slices only the requested result page before crossing the HTTP
boundary. If generic, rating, and usage sorts coexist, usage sort wins over
rating sort, which wins over generic sort. Upload-date nulls retain the old
Gallery behavior (last under descending, first under ascending). Title ordering
is deterministic SQLite `NOCASE` ordering with `id` tie-breaks.

## Query encoding

Tag filter queries accept either number arrays after framework parsing or comma-separated wire values:

```text
?entryType=game&includeTagIds=1,2&excludeTagIds=3
?entryType=game
?ownTagIds=4&relatedEntryTagIds=1,2
```

Every include/search set retains repository AND semantics. Excluded Entry Tags retain `NOT EXISTS` semantics.
Global search uses `?q=...` (required, trimmed, 1–200 characters); Entry-title search alone also accepts optional `entryType` for an exact Gallery boundary, while Tag search accepts optional `includeNsfw=true|false`. `searchScopeSchema` is the UI/shared vocabulary (`entries | tags | producers`), while the wire API keeps one explicit endpoint per scope.
Offline sync contracts (`schemas/sync.ts`) are strict end to end: the
capabilities response is a closed object, the snapshot header carries the
identity pair (`libraryId`, `syncEpoch`), the monotonic `snapshotSeq`,
schema/format versions, bounded counts and the checksum, and the payload is
a closed set of read-model row arrays (entries, producers, tag vocabularies
and groups, contents, ratings, collections, directories, usage, View later,
Gallery partitions, media refs). Clients verify the checksum before atomically
switching their active IndexedDB generation and fail closed on library or
epoch mismatches.

Source maintenance contracts are strict as well: run creation requires an
origin source key, a registered adapter key and an explicit
`markOriginInvalid` boolean; candidates carry an evidence band
(`exact-safe | strong-review | ambiguous | conflict | no-match | error`)
with machine-readable reasons and their external `catalogIds`; item patches
accept only `decision` and `selectedUrl`; item pages are bounded (pageSize
1–100) with an `all|pending|accepted|skipped|unresolved` state filter; the
commit response is a strict `{ runId, status, createdCount, skippedCount,
unresolvedCount, originMarkedInvalid, backupDir }`. Stored `candidates_json`
is parsed back through the shared schema on every read.

Relation suggestions also use `?q=...`, but their contracts are distinct: Tag suggestions require `vocabulary=entry|producer`, optionally accept ranking context (`entryType`, `facetId`), and both Tag/Producer endpoints accept comma-separated `excludeIds`. Empty/Unicode-whitespace-only queries are invalid at the HTTP boundary and produce no client request. The editing surfaces (`SuggestionInput.vue`) enforce the same rule locally: they send the normalized query only after a visible character, debounce at 150ms, abort superseded requests, drop stale responses, suppress requests and commits during IME composition, and treat blur as close-only — committing is an explicit Enter (highlighted candidate, or the typed text in creatable mode) or a candidate click.
The per-type Entry Tag query returns `{ id, name, normalizedName, entryCount }`
records for building one Gallery's filter controls.
An Entry detail's `producers` entries carry a derived `entryCount` — the number of
Entries linking that Author — which Entry edit mode uses to offer the multi-author
cleanup only while some Author is limited to the open work. `multiAuthorProducerName`
(`multiple author`) is the shared canonical Author that cleanup targets, so both
sides agree on the name without duplicating the string.

## Errors

Routes return:

```json
{
  "error": {
    "code": "VALIDATION_ERROR | NOT_FOUND | CONFLICT | INTERNAL_ERROR",
    "message": "Human-readable summary",
    "details": {}
  }
}
```

`details` is optional. Routes must not expose raw SQLite errors or database terminology in normal UI messages.

## Deliberate boundaries

- The complete Entry response preserves unnamed Facets as `name: ""`; presentation code decides whether to hide their label.
- Producers and Entry Content remain outside `sections`; rating rows ride on the detail responses as `ratings`, never inside Sections.
- Entry and Producer Tag contracts remain separate even when their display names match.
- `contentType` remains free text.
- HTTP routes consume these schemas in `apps/server/src/http/app.ts`; canonical Import persistence uses its separate reviewed mapping contract in `packages/shared/src/schemas/import.ts`.
