# Shared API contracts

`packages/shared/src/schemas/api.ts` is the public validation boundary shared by the server and web app. Routes must parse path parameters, query parameters, request bodies, and repository results with these schemas rather than maintaining route-local DTOs.

## Contract families

- Entry: create, partial update, record, complete detail, and tag-filtered summaries.
- Layout: create Section/Facet, rename/reorder groups, and ordered layout responses.
- Entry Tags: assign, move, list assignment, per-type usage counts, and include/exclude filters.
- Entry Content: create, partial update, record, and complete-list reorder.
- Producer: create, partial update, record, Entry linking parameters, Producer Tags, and own/work-tag search.
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
- Producers and Entry Content remain outside `sections`.
- Entry and Producer Tag contracts remain separate even when their display names match.
- `contentType` remains free text.
- HTTP routes consume these schemas in `apps/server/src/http/app.ts`; canonical Import persistence uses its separate reviewed mapping contract in `packages/shared/src/schemas/import.ts`.
