# Current data architecture

This document is the authoritative product-data model. It supersedes every earlier collection/field/value schema draft.

## Core model

T³ has two core subjects:

- `Entry` — a collected work or item. `entries.type` supplies its category; there is no Collection entity.
- `Producer` — a creator related to Entries through a many-to-many relation.

```text
Entry ──< entry_producers >── Producer
Entry ──< entry_tags >─────── Entry Tag vocabulary
Producer ──< producer_tag_assignments >── Producer Tag vocabulary
```

Entry and Producer tags intentionally use separate vocabularies. A Producer can still be discovered from the tags of related Entries by joining through `entry_producers`; Entry tags must not be suggested as the Producer's own tags.

## Entry layout

Layouts are shared by `entries.type` and use `tag_groups`:

```text
Section (visible divider)
  └─ Facet (tag row)
```

A Section never owns tags directly. Every Entry tag assignment has a non-null `facet_id`. When a Section needs tags without a visible facet label, it owns one Facet whose name is the empty string. The UI hides that Facet label and gives it no independent visual row.

`createSection()` creates the Section and its unnamed default Facet in one transaction. Repository deletion protects the default Facet and refuses to delete a Section or named Facet while it still contains assigned Tags.

The database enforces:

- Section rows have no parent and have a visible name.
- Facet rows have a parent.
- A Facet parent is a Section with the same `entry_type`.
- An Entry tag assignment targets a Facet whose `entry_type` matches the Entry's `type`.
- A Tag has one location per Entry; dragging it changes `entry_tags.facet_id`.

## Content

Entry content is separate from Section/Facet layout. `entry_contents.content_type` is a free text label, not an enum; examples include `short review` and `source url`. The corresponding text or URL is stored in `content`.

A Producer has a single simple `content` field for its important short review/note. Producers do not have Section/Facet layouts.

## SQLite implementation

The immutable initial migration is `apps/server/src/database/migrations/001_initial.sql`. Author Directory layout is added by the immutable `002_author_directories.sql` migration. Both use SQLite syntax and are applied by the checksum-aware migration runner.

Verification commands:

```text
pnpm test:integration
pnpm db:probe
pnpm db:doctor [optional-database-path]
```

Tests use in-memory or temporary SQLite databases and never `.data/library.db`.

## Current repository boundary

- `layout-repository.ts` creates, renames, orders, reads, and safely deletes Section/Facet layouts.
- `entry-tag-repository.ts` normalizes/reuses Tags, assigns and moves them between matching Facets, removes assignments without deleting the vocabulary Tag, aggregates per-type Tag usage, filters Entry summaries, applies one Entry's tag→Facet placement to every other Entry of the same type (`applyEntryTagLayout`), and serves the gallery facet filter (aggregated named-Facet options + `allTags` via `listFacetFilterOptions`, filtered summaries via `findEntriesByFacetFilters`).
- `entry-repository.ts` composes the complete Entry detail: Producers, all Sections/Facets, nested Tags, and separately ordered Content.
- `producer-repository.ts` creates and edits Producers and idempotently links/unlinks them with Entries.
- `producer-tag-repository.ts` manages the independent Producer Tag vocabulary and searches Producers through their own Tags and the union of their related Entries' Tags.
- `author-directory-repository.ts` persists per-Author Directory presentation layout and membership without changing Entry domain fields.
- `entry-content-repository.ts` creates, edits, deletes, and transactionally reorders layout-independent Entry Content.

Tag filters use AND across included Tag IDs and exclude any Entry carrying an excluded Tag ID.
Producer search also uses AND within each supplied Tag set. Related Entry Tags may be satisfied across multiple works by the same Producer; they are never copied into the Producer Tag vocabulary.

## Shared API boundary

`packages/shared/src/schemas/api.ts` defines the strict Zod request, path, query, response, and error contracts used by both server and web code. It mirrors repository DTOs without exposing SQLite names. Empty update bodies, blank required labels, non-positive IDs, duplicate reorder IDs, and duplicate filter IDs are rejected before repository calls.

Tag-filter query IDs support comma-separated HTTP values and preserve the repository semantics above. Complete Entry responses preserve the real Section → Facet → Tag hierarchy, including unnamed Facets. See `docs/api-contracts.md`.

`apps/server/src/http/app.ts` exposes these contracts through a thin Hono layer. `apps/server/src/http/server.ts` owns startup, migration application, and database shutdown for the localhost process. See `docs/http-api.md`.

Canonical website exports persist only through `apps/server/src/import/commit.ts`. A shared reviewed mapping selects the Entry type, Facets, Producer decisions, Content labels, and ignored candidate fields. The whole batch uses one transaction, preserves provenance as Content, and rejects unreviewed Producer matching. See `docs/import-commit.md`.

## UI localization

`apps/web/src/i18n.ts` is the UI copy boundary. It defines the supported locale IDs, a type-checked flat English dictionary, and a Simplified Chinese dictionary that must contain the same keys. `useI18n()` exposes the reactive locale, interpolation-aware translation lookup, and locale setter without coupling localization to API or persistence DTOs. The selected locale is stored under `t3.locale` in browser storage and mirrored to the document `lang` attribute; English is the fallback for missing or invalid stored values.

`GalleryApp.vue` references dictionary keys for visible copy, placeholders, accessible labels, and local fallback errors. Its header Settings entry currently contains only the `en` / `zh-CN` language selector. New UI copy must be added to both dictionaries rather than embedded in component templates.

## Gallery projection

Gallery is product vocabulary for grouping Entries by `Entry.type`; it is not a table or independently persisted subject. Creating an Entry with a previously unused type makes that Gallery appear. Every later Entry with the exact same type is shown in that Gallery. `GET /api/galleries` is a `GROUP BY entries.type` projection with counts, while Gallery contents use the existing Entry type filter.

`apps/web/src/GalleryApp.vue` consumes this projection, lets the user create an Entry with either a new or existing type, browses Entries by type, and opens composed Entry details. Edit mode starts from the detail toolbar. Sections, named Facets, and Tag assignments are added through compact inline inputs that submit on Enter or blur; Tags can be dragged, removed, or double-clicked to rename the selected Entry assignment. In read mode, double-clicking an Entry Tag opens a result page containing every matching Entry across Gallery types. Ordered Entry Content is added, edited, deleted, and moved up or down inline. Sections stack behind dashed dividers. An empty Section shows `+ Facet` and `+ Tag` together in its first row. Choosing `+ Tag` uses the Section's empty-name Facet to satisfy persistence rules, but that row is visible only while it carries Tags. Once a named Facet is visible, no additional empty-name control row is rendered; moving or deleting the last direct Tag removes its blank row immediately. Every visible Facet owns a left label column and a right Tag column. Read mode exposes no mutation or drag controls. Entry edit mode additionally offers two structure operations in the detail toolbar: `Save as template` rebuilds the type's shared layout, while `Apply tag layout` only syncs the open Entry's tag→Facet placements onto every other Entry of the same type (skipping tags the Entry does not carry) — layout edits stay shared per type, but per-Entry tag placement stays free and can be re-aligned from any Entry. Each Gallery view shows a facet filter bar above the grid: rows of the shape Facet + tags (combo boxes with free input) plus an optional Author row, where EVERYTHING combines with AND — every picked tag must be present under its Facet, so more tags always narrow the result (the same tag may appear under several Facets across Entries, and the options keep it selectable under each, but a tag can only be picked once across rows — duplicates are rejected inline; an "All tags" row matches tags regardless of Facet, and the Author row ORs its authors). The Author page shows the SAME bar above its works: options are aggregated for that Author's works only (`facet-options?authorId=`), the Authors row is hidden (the author is fixed), and the bar only appears when all of the Author's works share one Gallery type. While a filter is active, Directories are UNFOLDED — every matching work, whether loose or inside a Directory, is shown as one plain card in a single sorted/paginated grid (Directory rows are browsing structure and dissolve under a filter); clearing the filter restores the pinned Directory row + loose grid. Author list cards and the Author detail header carry a `galleryType` badge naming the Author's dominant Gallery (derived from their works' Entry types, never stored). These common actions do not require dialogs. The UI must not create, update, or delete a separate Gallery record.

Creating a Facet reuses an existing Facet of the same name within its Section when that Facet has no assigned Tags (it is hidden after its Tags were removed); submitting the same name again for an already-visible Facet is rejected. This cannot re-insert a duplicate name protected by the unique facet-name index.

In edit mode each visible named Facet exposes up/down controls that reorder only that Section's Facets through a transactionally persisted `PUT /api/sections/:sectionId/facets/order`. The reorder payload must contain every Facet of the Section (including its unnamed default Facet) exactly once, mirroring the Content reorder contract.

## Author and Directory projection

The UI consistently calls the Producer subject `Author / 作者`; Producer remains the internal database, repository, schema, and HTTP name. The global Author navigation appears only after at least one Producer exists. Entry edit mode supports explicit creation/linking, filtered user-directed linking of an existing Author, and unlinking through compact controls that submit on Enter or blur; matching is never automatic. In Entry read mode, double-clicking an Author chip opens that Author. An Entry opened from an Author returns to that Author, including the specific Directory when applicable, and the return label names that Author or Directory rather than the Entry type.

`AuthorPage.vue` composes basics, the independent Producer Tag row, and Producer Content inside one information board. Authors have no Section or Facet layout. Clicking a Producer Tag in read mode opens only the Authors carrying that Producer Tag; it never searches the separate Entry Tag vocabulary. Related Entries appear below as Gallery-style work cards, with at most 25 top-level work/Directory cards per page; opening a work reuses Entry detail navigation.

`author_directories` and their membership rows persist only the per-Author presentation layout. A Directory has a title and description, and its cover is derived from the first three ordered member Entry covers. In Author edit mode, `+ Directory` creates an empty Directory. Dropping one loose work onto another creates a Directory with an i18n default title (`New Directory / 新建文件夹`) and a numeric suffix on collision; dropping a work onto an existing Directory moves it there. Directory edit mode also exposes a drop target that removes only the Directory membership, returning the Entry to the Author's loose works. Finishing Directory editing saves title and description inline without a separate Save action. This organization never changes `Entry.type`, never creates a Gallery, and is included naturally in SQLite backup and restore.

## Running modes

Two run shapes share the same server entry (`apps/server/src/http/server-cli.ts` → `startApiServer`):

- **Development** — `pnpm dev:server` (API, tsx watch, `127.0.0.1:8765`) + `pnpm --filter @t3/web dev` (Vite, `127.0.0.1:5173`). The web app reaches the API cross-origin via the loopback CORS policy. `T3_DATA_DIR` defaults to `.data` under the server package.
- **Production single-process** — `pnpm build` once, then `pnpm start:server`: `createApiApp` receives `staticRoot` (default `<repo>/apps/web/dist` when the directory exists; override `T3_STATIC_ROOT`, empty disables) and serves the built UI from the API origin. `serveStatic` (hono) answers real files first; the `app.notFound` handler returns `index.html` for any non-`/api` GET (SPA fallback, client-side routes deep-link) and keeps JSON 404s for unknown `/api` routes. `T3_OPEN_BROWSER=1` spawns `cmd /c start` at the origin after listening (Windows only).
- **Packaged entries (repo root)** — `T3.bat`: port check (already listening → open browser, exit), first-run `pnpm run build`, then `cd apps\server && call node_modules\.bin\tsx.cmd src\http\server-cli.ts` with `T3_OPEN_BROWSER=1`; closing its window stops the server. **`T3.exe` (tray launcher, `tools/t3-launcher/`, C# WinForms net10.0-windows, framework-dependent single-file publish via `build-launcher.bat`)**: the recommended entry — double-click starts the server hidden (`cmd /c <tsx.cmd> src\http\server-cli.ts`, cwd `apps\server`, stdout/stderr pumped to `t3-server.log`), opens the default browser once port 8765 answers, and stays in the system tray (menu: Open T3 / Exit; Exit kills the server process tree). A second launch while the server is up only re-opens the browser and exits. First run builds the web UI automatically. ⚠ Both entries start the server via the workspace-local `tsx.cmd`, NEVER `npm exec … pnpm start:server` — the npm-exec chain hangs when double-clicked from Explorer (no TTY) and survives window close as orphan node processes; this was the real "connection refused" cause on 2026-09-03. Icon is intentionally unset for now (SystemIcons.Application placeholder; add `<ApplicationIcon>` + a real .ico later).
