# HTTP API

The local API is implemented by `apps/server/src/http/app.ts` and served by `apps/server/src/http/server.ts`. Routes validate transport input and output with `@t3/shared` Zod contracts and delegate all persistence to repositories.

## Run locally

```bash
pnpm start:server
# development watch mode
pnpm dev:server
```

Single-process production mode: build the web app once (`pnpm build`), then `pnpm start:server` serves the API **and** the built `apps/web/dist` UI from the same origin (`http://127.0.0.1:8765`). Static files are served before a single-page fallback that returns `index.html` for any non-`/api` GET, so client-side routes deep-link; `/api` responses are never swallowed (unknown API routes keep returning JSON 404s). Packaged entries live at the repo root: **`T3.exe`** (recommended, tray launcher in `tools/t3-launcher/`) starts the server hidden, opens the default browser, and stays in the tray until Exit; **`T3.bat`** runs the same server in the console window (close it to stop). Both start the server as `cd apps\server && node_modules\.bin\tsx.cmd src\http\server-cli.ts` — do NOT wrap that in `npm exec`, which hangs when launched from Explorer and leaves orphan node processes.

Defaults come from `.env.example` conventions:

```text
T3_HOST=127.0.0.1
T3_PORT=8765
T3_DATA_DIR=.data
T3_DB_NAME=library.db
T3_STATIC_ROOT=        # default: <repo>/apps/web/dist when it exists; set empty to disable hosting
T3_OPEN_BROWSER=1      # T3.bat sets this; opens the default browser after listening (Windows only)
```

The server creates the data directory, opens SQLite, and applies migrations before listening. Binding outside localhost is rejected unless `T3_ENABLE_LAN=true` is explicitly set.
Browser CORS responses allow localhost and loopback origins only by default; unrelated web origins receive no CORS permission. In dev, `pnpm dev:server` (API on 8765) runs alongside `pnpm --filter @t3/web dev` (Vite on 5173), which reaches the API cross-origin through that CORS policy; the API-origin static hosting is harmless there.

## Routes

### Entries and layouts

```text
GET    /api/galleries
POST   /api/entries
GET    /api/entries?entryType=...&includeTagIds=1,2&excludeTagIds=3
GET    /api/entries?includeTagIds=1
GET    /api/entries/:entryId
PATCH  /api/entries/:entryId
POST   /api/entries/:entryId/template/apply
POST   /api/entries/:entryId/tag-layout/apply
GET    /api/entries/facet-options/:entryType
POST   /api/entries/filter

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
`entryType` is optional on `GET /api/entries`: Gallery browsing supplies it, while an Entry Tag result page omits it to find matching Entries across all Gallery types.

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
```

`GET /api/entry-tags?entryType=...` returns the Entry Tag vocabulary currently
used by one logical Gallery, including the number of Entries carrying each Tag.
The rename route retargets only the selected Entry assignment to a normalized,
reused-or-created Tag; it does not rename shared uses on other Entries.

### Producers

```text
POST   /api/producers
PATCH  /api/producers/:producerId
GET    /api/producers/:producerId
GET    /api/producers?ownTagIds=1,2&relatedEntryTagIds=3

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

POST   /api/producers/merge/plan
POST   /api/producers/merge
```

The product UI calls Producers `Author / 作者`; the internal route and persistence names remain Producer. `GET /api/producers/:producerId` composes Author basics, independent Producer Tags, loose related Entries, and persisted Directories. `ownTagIds` searches only the Producer Tag vocabulary, independently from Entry Tags. Producer Tag rename retargets only that Producer's assignment and does not rename another Producer's use of the shared vocabulary Tag.

Directories are per-Author presentation layout. Creating one may include initial Entry IDs; moving an Entry into a Directory removes its previous Directory membership for that same Author. Deleting one Directory membership returns the Entry to that Author's loose works without deleting or unlinking the Entry. Directory operations do not change `Entry.type` or create a general-purpose Entry grouping.

`POST /api/producers/merge/plan` returns the would-be merge plan without writing (identical normalized names, plus `producer`-vocabulary dictionary merges). `POST /api/producers/merge` executes the same plan: it backs up a file-backed database first (`<db>.merge-backup-<timestamp>`; in-memory databases return `backupPath: null`), runs inside one transaction with foreign keys temporarily disabled, then reports per-plan rows (keeper, absorbed producers, relinked works/tags, moved/merged directories), totals, and `foreign_key_check` + doctor results. The Advanced editing page drives both endpoints; the `merge:authors` CLI wraps the same logic for one-shot runs.

`POST /api/entries/:entryId/template/apply` rebuilds the shared Section/Facet layout of the Entry's type from its current structure (names and order), then re-maps every Entry of that type onto the rebuilt Facets — assignments match by normalized (Section name, Facet name), duplicate spellings collapse, and tags whose old Facet is gone move to the Tags default Facet. File-backed databases get a `<db>.template-backup-<timestamp>` snapshot first; the response reports `entriesAffected`, `tagsRelinked`, `orphansMoved`, `sectionsRecreated`, `backupPath` and FK/doctor results.

`POST /api/entries/:entryId/tag-layout/apply` is the tag-only sibling of the template route: it never touches the shared layout. Each tag the source Entry carries becomes the standard placement — every other Entry of the SAME type that has that tag under a different Facet has its assignment moved onto the source Facet. Peers without the tag and tags the source does not carry are left alone, and other Entry types are never modified (the tag vocabulary is global, so a tag name may legitimately sit in different Facets per type). File-backed databases get a `<db>.taglayout-backup-<timestamp>` snapshot first; the response reports `entriesAffected`, `tagsMoved`, `entriesScanned`, `backupPath` and FK/doctor results.

`GET /api/entries/facet-options/:entryType` aggregates, across all Entries of one type, every named Facet and the tags assigned to it (unnamed default Facets are omitted as rows, but their tags are still listed), plus `allTags` (the full distinct tag vocabulary of the type) and `authors` (the Producers linked to Entries of the type). A tag that different Entries place under different Facets deliberately appears under each of those Facets, because the filter must be able to match either placement. An optional `?authorId=` query scopes the whole aggregation to one Author's works (the Author page filter bar) — `authors` then contains that Author alone.

Producer responses (`GET /api/producers`, `GET /api/producers/:producerId`) now also carry `galleryType`: the Author's dominant Gallery (Entry type with the most works, name tie-break; `null` with no works), derived at read time and never stored — the Author list cards and detail header show it as their home-Gallery badge.

`POST /api/entries/filter` filters Entries of one type: body `{ entryType, conditions: [{ facetId, tagIds }], authorIds }` where EVERY tag id of a condition must be present under the chosen Facet (AND inside a row — more tags always narrow the result), all conditions AND across rows, `facetId: null` matches tags in any Facet (the "All tags" row), and `authorIds` OR within the list and AND with every tag row (empty for tag-only filtering; `conditions` may be empty for author-only filtering). Responses are the same lean Entry summaries as `GET /api/entries`. Selecting the same tag in two rows is rejected client-side (a tag is unique globally, so a duplicate row can never match).

### Taxonomy aliases

```text
GET    /api/taxonomy-aliases?vocabulary=entry|producer
POST   /api/taxonomy-aliases
POST   /api/taxonomy-aliases/import
DELETE /api/taxonomy-aliases/:aliasId
```

Alias rows map a spelling to a canonical name per vocabulary (`entry` / `producer`). Rows carry a `partition` label (series / characters / types / tags / authors / `''`) so dictionary imports keep their source buckets. A row whose `canonicalName` is empty is a placeholder: it records a name still awaiting a canonical and never participates in name resolution — the Advanced editing page lists placeholders with a one-click fill into the alias form. `POST /api/taxonomy-aliases` upserts a single row and rejects an empty canonical for hand entry; `POST /api/taxonomy-aliases/import` bulk-imports parsed dictionary rows (placeholders allowed) and never downgrades an already-filled mapping to a placeholder.

## Error boundary

- malformed JSON or invalid Zod input → `400 VALIDATION_ERROR`
- missing route or repository subject → `404 NOT_FOUND`
- SQLite/domain constraint conflict → `409 CONFLICT`
- unexpected failure → `500 INTERNAL_ERROR`

Raw SQLite errors are never returned. Full request/response schemas are documented in `docs/api-contracts.md`.
