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
PUT    /api/galleries/:entryType/partition
GET    /api/templates
POST   /api/entries
GET    /api/entries?entryType=...&includeTagIds=1,2&excludeTagIds=3
GET    /api/entries?includeTagIds=1
GET    /api/entries/:entryId
PATCH  /api/entries/:entryId
POST   /api/entries/:entryId/template/apply
POST   /api/entries/:entryId/tag-layout/apply
GET    /api/entries/facet-options/:entryType
POST   /api/entries/filter
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
`entryType` is optional on `GET /api/entries`: Gallery browsing supplies it, while an Entry Tag result page omits it to find matching Entries across all Gallery types.

`PUT /api/galleries/:entryType/partition` (body `{ nsfw: boolean }`) flips the whole Gallery between SFW and NSFW (`gallery_settings`, default SFW). Individual Entries are never partitioned. `GET /api/galleries` and Producer summaries carry the resulting `nsfw` flags; the web client's Show NSFW preference (localStorage `t3.showNsfw`) decides visibility: hidden NSFW Galleries in the sidebar, hidden NSFW Authors, and — via the search routes — NSFW-only tags omitted from tag results.

### Usage tracking (views and likes)

```text
POST   /api/entries/:entryId/views
POST   /api/entries/:entryId/likes
```

`POST .../views` increments the Entry's `entry_usage` row (created lazily; a missing row means never viewed) and returns the updated record. The client records a view only when the user actually opens the Entry's `source url` (recorded before `window.open`); opening the detail card itself never counts. `POST .../likes` adds 1 to `like_count` on the same row — likes are unlimited and re-clickable. Author-side view/like/last-viewed numbers are derived by aggregating their works (`SUM`/`MAX`), never stored. Entry summaries, Entry details, Author summaries, and Author details all embed `viewCount` / `likeCount` / `lastViewedAt`. The UI offers usage as sorting only (view count / last viewed / likes); there are no numeric or date condition rows.

### Shared View later

```text
GET    /api/view-later
POST   /api/view-later/merge
PUT    /api/view-later/:entryId
DELETE /api/view-later/:entryId
PUT    /api/view-later/producers/:producerId
DELETE /api/view-later/producers/:producerId
```

Two independent SQLite-backed lists (Entries and Producers/Authors) are authoritative for every desktop/mobile browser connected to the library. GET and every mutation return `{ entryIds: number[], producerIds: number[] }` in insertion order. PUT adds one existing subject idempotently; DELETE removes membership without deleting the subject; deleting an Entry or Author cascades its membership. Merge accepts `{ entryIds }`, appends surviving missing legacy Entry memberships without replacing server state, and ignores stale ids from deleted Entries. The web client merges `t3.view-later` once, removes that localStorage key only after success, then refreshes both lists on startup, View later entry, and window focus. No WebSocket/SSE is required: clients may be briefly stale but converge on the next pull.

### Collections

```text
GET    /api/collections?kind=entry|producer
POST   /api/collections
GET    /api/collections/:collectionId
PATCH  /api/collections/:collectionId
DELETE /api/collections/:collectionId
PUT    /api/collections/:collectionId/nsfw
PUT    /api/collections/order
PUT    /api/collections/:collectionId/entries/:entryId
DELETE /api/collections/:collectionId/entries/:entryId
PUT    /api/collections/:collectionId/producers/:producerId
DELETE /api/collections/:collectionId/producers/:producerId
GET    /api/collections/for-entry/:entryId
GET    /api/collections/for-producer/:producerId
```

Collections are user-curated folders of Entries or Producers (internal name unchanged: Entry/Producer). `kind` is fixed at creation (`entry` or `producer`); entry collections may nest child folders exactly one level deep, producer collections stay flat. The folder-level NSFW switch (`PUT .../nsfw`) hides the whole folder regardless of the members' own states. `PUT /api/collections/order` persists one kind's visible order; membership routes are idempotent links, and removal only unlinks. The detail response embeds member Entry summaries (including preview refs) and Producer summaries (including covers); usage statistics over members stay derived, consistent with the rest of the app. The `for-entry` / `for-producer` queries return the collections a subject already belongs to (drives the ✓-marked add-to-collection menus on detail pages).

### Gallery template files

`POST /api/entries/:entryId/template/apply` and `POST /api/entries/:entryId/tag-layout/apply` not only mutate the database — each successful call also rewrites that Gallery's canonical template files under `<dataDir>/templates/`: `<type>.template.json` (Section → Facet structure) and `<type>.tag-layout.json` (every tag's facet placement, refreshed whenever a placement is applied). `GET /api/templates` lists per-Gallery summaries (structure dimensions, tag→facet assignments, both file paths, existence flags) for the Advanced editing "Gallery templates" tab. Import (`commitImportBatch`, single and batch) consults the same data: each imported tag is placed by the majority facet of that tag inside the target Gallery, so steady-state imports land in the template's facet layout without manual re-sorting; only never-seen tags fall back to the default location.

### Global search

```text
GET    /api/search/entries?q=...&entryType=...
GET    /api/search/tags?q=...&includeNsfw=false
GET    /api/search/producers?q=...
```

`q` is required, trimmed, and limited to 200 characters. Entry search optionally accepts one exact Gallery type. Tag search optionally accepts `includeNsfw=true|false` (omitted preserves the complete vocabulary); the web client always supplies the current Show NSFW preference. With `false`, tags used only by NSFW Galleries are omitted, and `entryCount` counts only SFW usage for shared tags. All three scopes rank case-insensitive exact/prefix/substring matches first and then allow a lightweight edit-distance match for queries of at least four characters; punctuation such as `%` and `_` is interpreted literally rather than as SQL wildcards. Entry and Author responses reuse their normal card summary contracts. Tag hits return `{ tagId, name, normalizedName, entryCount }` and the web client opens the existing cross-Gallery Tag results view.

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

`GET /api/entry-tags?entryType=...` returns the Entry Tag vocabulary currently
used by one logical Gallery, including the number of Entries carrying each Tag.
With `entryType` omitted it returns the same usage counts across every Gallery
(the random-tag picker uses this).
The rename route retargets only the selected Entry assignment to a normalized,
reused-or-created Tag; it does not rename shared uses on other Entries.

### Producers

```text
POST   /api/producers
PATCH  /api/producers/:producerId
GET    /api/producers/:producerId
GET    /api/producers?ownTagIds=1,2&relatedEntryTagIds=3
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

The product UI calls Producers `Author / 作者`; the internal route and persistence names remain Producer. `GET /api/producers/:producerId` composes Author basics, independent Producer Tags, loose related Entries, and persisted Directories. `ownTagIds` searches only the Producer Tag vocabulary, independently from Entry Tags. `relatedEntryTagIds` requires one related Entry to carry every selected Entry Tag; Tags split across different works do not match. The two sets AND together. `GET /api/producers/filter-options` returns the assigned Author Tag and related-work Tag vocabularies used by eligible Authors; `entryType` optionally scopes Authors by dominant Gallery and `includeNsfw=false` excludes options belonging only to hidden NSFW Authors. Producer Tag rename retargets only that Producer's assignment and does not rename another Producer's use of the shared vocabulary Tag.

Directories are per-Author presentation layout. Creating one may include initial Entry IDs; moving an Entry into a Directory removes its previous Directory membership for that same Author. Deleting one Directory membership returns the Entry to that Author's loose works without deleting or unlinking the Entry. Directory operations do not change `Entry.type` or create a general-purpose Entry grouping.

Ratings are shared name+stars lines. `POST /api/entries/:entryId/rating-slots` (body `{ name }`) creates the slot for the Entry's whole Gallery — the same name is idempotent and returns the existing shared slot — while `PUT /api/entries/:entryId/ratings` (body `{ slotId, stars }`) upserts the Entry's value; `stars: null` clears back to the unrated state, and anything outside 0.5–5 half steps is a 400. The Producer pair is partition-aware instead of Entry-typed: the slot joins the Author's dominant-Gallery partition (409 when a workless Author has none) and instantly appears on every same-dominant-Gallery Author. Both detail responses (`GET /api/entries/:entryId`, `GET /api/producers/:producerId`) embed the composed `ratings` rows (slotId, name, stars|null) in slot order.

Slot order is part of the shared template too: `PUT /api/entries/:entryId/rating-slots/order` and `PUT /api/producers/:producerId/rating-slots/order` (body `{ orderedSlotIds }`, every slot exactly once) reorder the rating section on every same-Gallery card / same-partition Author in one call. `GET /api/rating-slots?entryType=...` lists a Gallery's shared slots for the import/entry-composer rating pickers.

Rating filtering rides on `POST /api/entries/filter`: `ratingConditions` (`{ slotId, operator: eq|gt|lt|unrated, stars }`) AND with every tag row and the author list (`unrated` takes no stars; a slot from a foreign Gallery is a 409), and `ratingSort` (`{ slotId, direction: 'desc' }`) orders the response from high to low with unrated entries sinking below every rated one. `GET /api/entries/facet-options/:entryType` now also returns the Gallery's shared `ratingSlots` so the filter bar can render its rating rows (the Author page variant inherits them for its works).

`POST /api/producers/merge/plan` returns the would-be merge plan without writing (identical normalized names, plus `producer`-vocabulary dictionary merges). `POST /api/producers/merge` executes the same plan: it backs up a file-backed database first (`<db>.merge-backup-<timestamp>`; in-memory databases return `backupPath: null`), runs inside one transaction with foreign keys temporarily disabled, then reports per-plan rows (keeper, absorbed producers, relinked works/tags, moved/merged directories), totals, and `foreign_key_check` + doctor results. The Advanced editing page drives both endpoints; the `merge:authors` CLI wraps the same logic for one-shot runs.

### Author alias groups

```text
GET    /api/author-alias-groups
POST   /api/author-alias-groups
```

One author may be recorded under several names — Japanese kana/kanji, a translated Chinese name, romaji/English — depending on the source site. An alias group is `{ displayName, tagNames: [...] }`: every tag name maps to the display name as a `producer`-vocabulary dictionary row (partition `authors`), so import-time name resolution, the author merge, and the faded alternate spellings under author names all reuse the existing dictionary machinery. `POST` writes the rows and then runs the producer merge (with the same file-backed backup), collapsing existing duplicate producers into one row that carries the display name — clicking any spelling therefore finds the single Author. Duplicate spellings inside one request are a 400; spellings equal to the display name are dropped as no-ops. `GET` groups the dictionary back into `{ canonicalName, aliases[], producerId, producerName }` rows (`producer*` null when no Author row exists yet — it is created/relinked on the next import or merge).

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

### Unassigned tag cleanup (Advanced editing)

```text
GET  /api/tags/unassigned
POST /api/tags/unassigned/move   body: { entryType, tagId, targetFacetId }
```

`GET /api/tags/unassigned` returns one group per Entry type that still has tags sitting in the type's unnamed default Facet ("未分类"). Each group carries the type's named Facets (the valid move targets) and its unassigned tags with `entryCount` (placements to move) and an optional `suggestion` = the named Facet where the REST of that type's entries keep the tag (majority by entry count, used by the one-click "follow" action). `POST .../move` relocates every unassigned placement of ONE tag within ONE type onto a named target Facet of the same type; placements already on named Facets and other types are untouched (cross-type targets conflict 409). The tag vocabulary is global, so the same tag name can be unassigned in one gallery and classified in another — grouping per type is what keeps the target list honest. No schema change; pure `UPDATE entry_tags` (like apply-tag-layout).
