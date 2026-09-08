# Shared API contracts

`packages/shared/src/schemas/api.ts` is the public validation boundary shared by the server and web app. Routes must parse path parameters, query parameters, request bodies, and repository results with these schemas rather than maintaining route-local DTOs.

## Contract families

- Entry: create, partial update, record, complete detail, and tag-filtered summaries.
- Layout: create Section/Facet, rename/reorder groups, and ordered layout responses.
- Entry Tags: assign, move, list assignment, per-type usage counts, and include/exclude filters.
- Entry Content: create, partial update, record, and complete-list reorder.
- Ratings: create shared slot (idempotent by name), upsert `{ slotId, stars }` (null = unrated, 0.5–5 half steps), and composed rating rows embedded in Entry/Author detail responses.
- Producer: create, partial update, record, Entry linking parameters, Producer Tags, independent Author/work-Tag filter options, same-work AND Tag search, and Author work summaries carrying view/like/last-viewed usage.
- Usage: record-a-view / add-a-like mutations returning the updated `entry_usage` record (view count, last-viewed timestamp, like count); the same usage fields ride on Entry and Author summaries and details. Sorting-only by design — no numeric or date condition schemas.
- Gallery partition: `{ nsfw: boolean }` body on `PUT /api/galleries/:entryType/partition`; `nsfw` flags on Gallery and Producer summaries drive every visibility boundary.
- Collections: create/read/update/delete per kind (`entry | producer`), folder-level `{ nsfw }` switch, per-kind reorder lists (duplicate IDs rejected), idempotent member put/delete routes, and `for-entry` / `for-producer` membership queries. Detail responses embed member Entry summaries (with preview refs) and Producer summaries (with covers).
- View later: strict `{ entryIds: number[], producerIds: number[] }` shared-state response; GET reads both independent library-wide lists. PUT/DELETE by Entry or Producer id are idempotent. `{ entryIds }` merge only imports the legacy browser Entry list without replacing either server list. Duplicate wire IDs are rejected; the client deduplicates legacy input first.
- Gallery templates: `GET /api/templates` returns per-Gallery summaries (structure, tag→facet assignments, local file paths, existence flags); apply responses keep relaxed objects (unknown fields ignored) so a version-mismatched server or cached page can never turn a successful apply into a spurious 400.
- Author alias groups: save `{ displayName, tagNames }` (duplicate spellings rejected; spellings equal to the display name are dropped) and grouped listings of `{ canonicalName, aliases, producerId, producerName }`; the save response embeds the full producer-merge report that collapsed existing duplicates into the display-name row.
- Global search: shared scope enum, trimmed query, optional Entry type, optional Tag-search `includeNsfw`, Entry/Producer card summaries, and partition-aware Tag hit summaries with usage counts.
- Common: positive integer path IDs, mutation success, and structured API errors.

All object schemas are strict. Required labels are trimmed and reject blank values. Partial update bodies reject empty objects. IDs are positive integers. Reorder lists and tag-filter lists reject duplicate IDs.

## Query encoding

Tag filter queries accept either number arrays after framework parsing or comma-separated wire values:

```text
?entryType=game&includeTagIds=1,2&excludeTagIds=3
?entryType=game
?ownTagIds=4&relatedEntryTagIds=1,2
```

Every include/search set retains repository AND semantics. Excluded Entry Tags retain `NOT EXISTS` semantics.
Global search uses `?q=...` (required, trimmed, 1–200 characters); Entry-title search alone also accepts optional `entryType` for an exact Gallery boundary, while Tag search accepts optional `includeNsfw=true|false`. `searchScopeSchema` is the UI/shared vocabulary (`entries | tags | producers`), while the wire API keeps one explicit endpoint per scope.
The per-type Entry Tag query returns `{ id, name, normalizedName, entryCount }`
records for building one Gallery's filter controls.

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
