# Current data architecture

This document is the authoritative product-data model. It supersedes every earlier collection/field/value schema draft.

## Core model

T³ has two core subjects:

- `Entry` — a collected work or item. `entries.type` supplies its category.
- `Producer` — a creator related to Entries through a many-to-many relation.

```text
Entry ──< entry_producers >── Producer
Entry ──< entry_tags >─────── Entry Tag vocabulary
Producer ──< producer_tag_assignments >── Producer Tag vocabulary
Entry ──< collection_entries >──┐
Producer ──< collection_producers >──┴── Collections (user-curated folders)
```

Gallery is NOT a stored subject — it is a read-time projection grouping Entries by `type`. Collections (migration `010_collections.sql`) are the only user-created grouping subject: lightweight curated folders, described in their own section below. They never influence Entry domain fields, filtering, or templates.

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

## Ratings

A rating is one line of **name + stars**. Slot names (`rating_slots`) are fully templated per subject kind and Gallery: `subject_kind = 'entry'` slots are shared by every Entry of `entries.type`; `subject_kind = 'producer'` slots are partitioned by the Author's dominant Gallery (derived from their works, never stored), so creating a slot from any Author's edit mode automatically applies it to every same-dominant-Gallery Author — there is no apply button on the author side. Stars are 0.5–5 in half steps; `stars IS NULL` means the slot exists on the card but is unrated and is never treated as zero. Values live in `entry_rating_values` / `producer_rating_values` (one row per slot+subject); slot `sort_order` is shared per Gallery/partition as part of the template. The immutable migration is `006_rating_slots.sql`.

## SQLite implementation

The immutable initial migration is `apps/server/src/database/migrations/001_initial.sql`. Author Directory layout is added by the immutable `002_author_directories.sql` migration, and rating slots/values by `006_rating_slots.sql`. All use SQLite syntax and are applied by the checksum-aware migration runner.

Verification commands:

```text
pnpm test:integration
pnpm db:probe
pnpm db:doctor [optional-database-path]
```

Tests use in-memory or temporary SQLite databases and never `.data/library.db`.

## Current repository boundary

- `layout-repository.ts` creates, renames, orders, reads, and safely deletes Section/Facet layouts.
- `entry-tag-repository.ts` normalizes/reuses Tags, assigns and moves them between matching Facets, removes assignments without deleting the vocabulary Tag, aggregates per-type Tag usage, filters Entry summaries, applies one Entry's tag→Facet placement to every other Entry of the same type (`applyEntryTagLayout`), serves the gallery facet filter (aggregated named-Facet options + `allTags` via `listFacetFilterOptions`, filtered summaries via `findEntriesByFacetFilters`), and supplies ranked global Entry/Tag search results.
- `search-ranking.ts` provides the shared lightweight relevance layer for global search: normalized exact/prefix/substring ordering plus bounded edit-distance matching without SQL wildcard interpretation.
- `entry-repository.ts` composes the complete Entry detail: Producers, all Sections/Facets, nested Tags, and separately ordered Content.
- `producer-repository.ts` creates and edits Producers and idempotently links/unlinks them with Entries.
- `producer-tag-repository.ts` manages the independent Producer Tag vocabulary, searches Producers through their own Tags or through one related Entry carrying every selected work Tag, supplies partition-aware filter options for both vocabularies, and provides ranked Author-name search summaries for the global search page.
- `author-directory-repository.ts` persists per-Author Directory presentation layout and membership without changing Entry domain fields.
- `entry-content-repository.ts` creates, edits, deletes, and transactionally reorders layout-independent Entry Content.
- `rating-repository.ts` creates/reuses shared rating slots per subject kind and Gallery, lists the composed rating rows (slot name + stars, unrated = null), upserts values, and reorders slots. Producer slots resolve through the dominant Gallery derivation, so a value always belongs to the partition its author currently sits in.
- `usage-repository.ts` lazily creates each Entry's `entry_usage` row, records views and likes, and returns the updated record; Producer aggregates are composed at read time.
- `partition-repository.ts` reads and flips the per-Gallery SFW/NSFW flags and annotates Gallery/Author summaries with them.
- `collection-repository.ts` manages Collections and their membership (two kinds, one-level nesting for entry folders, folder-level NSFW, per-kind ordering, member composition with preview refs and covers).
- `template-export.ts` turns each applied layout/tag layout into the Gallery's canonical template files under `<dataDir>/templates/` and provides the per-Gallery summaries (`GET /api/templates`) plus the majority-facet lookup that import uses to place tags on arrival.

Rating conditions join the same filter family: `eq`/`gt`/`lt` compare the stars of one shared slot and `unrated` matches slots with no value, all ANDed with the tag and author rows; a rating sort orders high-to-low server-side with unrated entries sinking last (the UI never re-sorts over it). Tag filters use AND across included Tag IDs and exclude any Entry carrying an excluded Tag ID.
Producer search uses AND within each supplied Tag set and AND between the Author-Tag and work-Tag sets. Every selected related Entry Tag must occur on the same work; Tags split across different works by one Producer do not match. Entry Tags are never copied into the Producer Tag vocabulary.

## Shared API boundary

`packages/shared/src/schemas/api.ts` defines the strict Zod request, path, query, response, and error contracts used by both server and web code. It mirrors repository DTOs without exposing SQLite names. Empty update bodies, blank required labels, non-positive IDs, duplicate reorder IDs, and duplicate filter IDs are rejected before repository calls.

Tag-filter query IDs support comma-separated HTTP values and preserve the repository semantics above. Complete Entry responses preserve the real Section → Facet → Tag hierarchy, including unnamed Facets. See `docs/api-contracts.md`.

`apps/server/src/http/app.ts` exposes these contracts through a thin Hono layer. `apps/server/src/http/server.ts` owns startup, migration application, and database shutdown for the localhost process. See `docs/http-api.md`.

Canonical website exports persist only through `apps/server/src/import/commit.ts`. A shared reviewed mapping selects the Entry type, Facets, Producer decisions, Content labels, and ignored candidate fields. The whole batch uses one transaction, preserves provenance as Content, and rejects unreviewed Producer matching. See `docs/import-commit.md`.

`AddEntryPage.vue` reviews an export before commit. Its review section renders a template preview card — the target Gallery's Section → Facet rows carrying the Tag values each reviewed field mapping will produce, plus linked authors and mapped Content — recomputed live as mappings change. When the target template owns a `Type` Facet, a manual content-type input (per import and batch-wide) accepts a value for sites whose exports omit it (e.g. hitomi); the value merges into every Entry's `contentTypes` field and is committed as a Tag under that Facet. The input and its suggestion list are hidden when the template has no `Type` Facet.

## UI localization

`apps/web/src/i18n.ts` is the UI copy boundary. It defines the supported locale IDs, a type-checked flat English dictionary, and a Simplified Chinese dictionary that must contain the same keys. `useI18n()` exposes the reactive locale, interpolation-aware translation lookup, and locale setter without coupling localization to API or persistence DTOs. The selected locale is stored under `t3.locale` in browser storage and mirrored to the document `lang` attribute; English is the fallback for missing or invalid stored values.

`GalleryApp.vue` references dictionary keys for visible copy, placeholders, accessible labels, and local fallback errors. Its header Settings entry contains the `en` / `zh-CN` language selector plus an `Advanced editing` entry (`AdvancedEditingPage.vue`, opened as a full ladder view). Advanced editing has five tabs: Tag dictionary (taxonomy aliases with partitions and placeholder rows), Author merge (plan → execute with backup + integrity report), Unassigned tags (per-gallery cleanup of tags sitting in the unnamed default Facet, with follow-majority suggestions), Gallery templates (per-Gallery template file preview: structure dimensions, tag→facet assignments, local file paths of `<type>.template.json` / `<type>.tag-layout.json`, with an explanation that saving/applying happens from any Entry card of that Gallery), and Author aliases (display-name + spellings groups, see below). New UI copy must be added to both dictionaries rather than embedded in component templates.

## Global search

The permanent sidebar owns a compact search field. Focusing it or submitting a query opens `SearchPage.vue` as another mutually exclusive full ladder view; the page has Entry, Tag, and Author scopes and deliberately stays separate from the Gallery facet-filter state. Entry and Author hits reuse card-style presentation and preserve the existing NSFW visibility preference. Tag search sends that same preference to the server: SFW mode omits tags used only by NSFW Galleries and reports SFW-only counts for shared tags. Tag hits open the existing cross-Gallery Tag results page. Navigation into an Entry, Tag result, or Author carries the current query and scope so Back reconstructs the same search state instead of resetting it.

`GalleryApi` calls the three `/api/search/*` routes and parses the normal Entry/Producer summary schemas or `tagSearchHitSchema`. Production builds derive the API root from the current serving origin (`/api/`); development still defaults to `http://127.0.0.1:8765/api/`, with `VITE_API_BASE_URL` remaining the explicit override.

## Usage tracking

`entry_usage` (migrations `007_entry_usage.sql` + `008_entry_likes.sql`) is a lazy per-Entry row: `view_count`, `last_viewed_at`, and `like_count`; a missing row means never viewed. A view is recorded only when the user opens the Entry's source URL (the client records before the navigation; opening the detail card does not count). Likes are unlimited and re-clickable (+1 per call). Author-side numbers are always derived by aggregating their works (`SUM` counts, `MAX` last view) — never stored.

## Gallery partitions (SFW / NSFW)

`gallery_settings` (`009_gallery_partitions.sql`) marks a whole Entry type (Gallery) SFW or NSFW — individual Entries are never partitioned, and the default is SFW. Author partitioning is derived (any work in an NSFW Gallery makes the Author NSFW) and flips instantly with the Gallery switch. The client's Show NSFW preference (localStorage `t3.showNsfw`, toggled in Settings) is a global visibility boundary: it hides NSFW Galleries from the sidebar and Recently viewed tabs, NSFW Authors, NSFW members/covers/counts inside Collections, and NSFW Works/Authors/Tags from Random pick. Search routes use their `includeNsfw` contract so tags used only by NSFW Galleries do not leak through visibility filters. Turning Show NSFW off while Random results are visible clears that deal immediately.

## Collections

Collections (`010_collections.sql`) are user-curated folders — the lightweight "put these together" layer, deliberately without facets, templates, or filtering of their own. Two kinds exist, fixed at creation: `entry` collections (may nest child folders exactly one level deep, for e.g. a whole series) and `producer` collections (flat). A folder-level NSFW switch hides the entire folder regardless of its members' own states; when Show NSFW is off, an otherwise-SFW folder also filters member Entries whose Gallery is NSFW and derived-NSFW Authors, including those members' covers and displayed counts. Membership (`collection_entries` / `collection_producers`) is idempotent linking; removal only unlinks. Usage statistics shown for a folder (views/likes/last view) are derived from its members, consistent with Authors.

In the UI, `CollectionsPage.vue` is a permanent sidebar entry (below View later) with Works/Authors tabs in the shared connected-tab style; edit mode creates, deletes, and drag-reorders folders, and folder covers are built from the first member covers. Inside an entry collection, edit mode offers `+ New subfolder` — child folders render above the members as folder cards, opening one navigates in, and its back button returns to the parent folder rather than the list. Entry detail pages and the Author information board carry a persistent short 📁+ button that opens an add-to-collection menu (freshly fetched on open; already-joined folders show ✓ and are disabled). The same add-to menu pattern applies to entry cards' detail toolbar.

## Usage views

`RecentViewPage.vue` groups the current mode by Gallery with browser-style tabs whose active edge joins the content panel. It opens in ★ Last-viewed mode by default, hides works with no view record at all, shows at most 72 cards (about three pages), and removes every NSFW Gallery tab while Show NSFW is off. `ViewLaterPage.vue` uses the same shell and adds independent Entries/Authors pages. Membership is library data: `011_view_later.sql` and `012_view_later_producers.sql` create ordered Entry and Producer lists with unique membership and `ON DELETE CASCADE`. `GET /api/view-later` returns both authorities; idempotent PUT/DELETE routes mutate one Entry or Author membership; `POST /api/view-later/merge` only imports the old browser Entry list while ignoring stale deleted ids. On first successful startup the web store merges legacy localStorage `t3.view-later` once and removes that key. Thereafter startup, opening View later, and regaining window focus pull both server lists, while all client operations are serialized so a stale response cannot overwrite a newer mutation. Entry and Author detail toolbars use the same inactive clock / active checked-clock control. Every general sort surface—Gallery, Author works, Author list, Recently viewed, and both View later pages—also offers stable random ordering via a shuffled copy, without mutating source arrays or continuously reshuffling on unrelated renders. The usage switches are toggles: clicking the active mode again exits it. Their compact card grids use bounded card geometry so media cannot escape into neighboring cards. On an Author detail page, work summaries carry `viewCount`, `likeCount`, and `lastViewedAt`; choosing a usage sort unfolds Directories, preserves the server ranking, and shows the corresponding value beneath each work card. The UI intentionally offers usage as sorting only (views / last viewed / likes), not as arbitrary numeric or date conditions.

## Navigation shell and shared cards

`GalleryApp.vue` owns one mutually exclusive view state. Every sidebar entry runs `leaveAllViews()` first, so clicking any entry wins from any depth (detail pages, creation forms, batch review) — sidebar navigation is always top priority. Detail pages remember their source in `returnView` (recent / viewLater / collections / batch) or `entryOrigin` (author, search, tag results), and one app-scoped navigation-memory registry retains pagination plus page-local tab/sort/filter state across the intentional component remount. Author/Directory and Collection nesting retain their direct-parent path and scroll stack independently. Opening a child always starts it at the top; either the page-local Back or the permanent top-bar Back reconstructs the exact source and restores its page and scroll position. The top-bar control is disabled on Home, while fixed lower-right up-arrow controls on Entry and Author details provide immediate return to the top of long pages. Views must never be torn down before the destination's data is ready: opening an Entry from an Author loads the detail first and switches afterwards, so no intermediate view flashes. A single manual or folder-imported Entry opens its new detail directly. Multi-entry folder imports and batch imports land in an in-memory, one-time "batch review" group (only the new cards from that run, click-through, Back returns to the group, dismissed by `Complete` or any sidebar navigation); the group is never persisted as a Collection.

The sidebar also owns a permanent Random pick entry (`RandomPage.vue`): a clean filter-style page with Works / Authors / Tags modes. Works can be dealt from all visible Galleries at once, or from one visible Gallery under the full facet filter bar; Authors are filtered by their derived NSFW state; the Tag vocabulary is deduplicated from the currently visible Galleries so NSFW-only tags cannot be dealt in SFW mode. Every press of the random button deals a fresh page (24 work/author cards or exactly one Tag). The single Tag uses a large theme-token-based reveal card and opens the regular Tag results page, which returns to Random on back. Theme accent is the other app-wide preference: `accent` in `stores/preferences.ts` (localStorage `t3.accent`) drives a `data-accent` attribute on the app root, and `theme.css` retints per preset (blue default, teal, violet, rose, amber, green) the `--accent` / `--accent-hover` pair, the whole tag palette (chips, sidebar active states, badges), and the faintly tinted neutrals (page background, borders) — every retint is a pure hue rotation, so saturation/lightness and thus depth never change. Components only ever read the variables, never hardcoded accent colors.

All work cards — Gallery grid, Recently viewed, View later, Random picks, Collection member lists, tag results — use the shared `components/EntryCard.vue` (multi-cover perspective stack + title + type + optional usage note, with a `corner` slot for extra buttons). Its `LazyCardImage.vue` children receive their real asset URL only after `IntersectionObserver` approval, request immediately after approval without a second native-lazy gate, retain async decoding, and stay visually hidden over the reserved card geometry until load completes; browsers without IntersectionObserver receive the URL immediately. Card visuals are changed in exactly one place; pages must not re-implement card layout. Reusable comboboxes (`TagCombobox.vue`) provide the filter rows' typeahead with the same near-character ranking as global search.

## Gallery projection

Gallery is product vocabulary for grouping Entries by `Entry.type`; it is not a table or independently persisted subject. Creating an Entry with a previously unused type makes that Gallery appear. Every later Entry with the exact same type is shown in that Gallery. `GET /api/galleries` is a `GROUP BY entries.type` projection with counts, while Gallery contents use the existing Entry type filter.

`apps/web/src/GalleryApp.vue` consumes this projection, lets the user create an Entry with either a new or existing type, browses Entries by type, and opens composed Entry details. Edit mode starts from the detail toolbar, while the repeatable Like action remains visible directly below Edit in read mode. Sections, named Facets, and Tag assignments are added through compact inline inputs that submit on Enter or blur; Tags can be dragged, removed, or double-clicked to rename the selected Entry assignment. In read mode, double-clicking an Entry Tag opens a result page containing every matching Entry across Gallery types. Ordered Entry Content is added, edited, deleted, and moved up or down inline. A Ratings section sits after the Section information board and before Content: in edit mode each shared slot row exposes a ten-zone half-star picker plus a clear button, `+ Rating` adds a new shared slot for the whole Gallery, and picking stars updates the row in place without a full detail reload; in read mode rated rows show a static partially filled ★ display and unrated rows show an "Unrated" label. In edit mode each rating row also exposes up/down controls that reorder the SHARED slot list (`PUT /api/entries/:entryId/rating-slots/order`), so slot order — like the slots themselves — is part of the Gallery template and changes propagate to every same-type card without an apply step. Sections stack behind dashed dividers. An empty Section shows `+ Facet` and `+ Tag` together in its first row. Choosing `+ Tag` uses the Section's empty-name Facet to satisfy persistence rules, but that row is visible only while it carries Tags. Once a named Facet is visible, no additional empty-name control row is rendered; moving or deleting the last direct Tag removes its blank row immediately. Every visible Facet owns a left label column and a right Tag column. Read mode exposes no mutation or drag controls. Entry edit mode additionally offers two structure operations in the detail toolbar: `Save as template` rebuilds the type's shared layout, while `Apply tag layout` only syncs the open Entry's tag→Facet placements onto every other Entry of the same type (skipping tags the Entry does not carry) — layout edits stay shared per type, but per-Entry tag placement stays free and can be re-aligned from any Entry. Each Gallery view shows a facet filter bar above the grid: rows of the shape Facet + tags (combo boxes with free input) plus a separate `+ Authors` action that creates the optional Author row, where EVERYTHING combines with AND — every picked tag must be present under its Facet, so more tags always narrow the result (the same tag may appear under several Facets across Entries, and the options keep it selectable under each, but a tag can only be picked once across rows — duplicates are rejected inline; an "All tags" row matches tags regardless of Facet, and the Author row ORs its authors). The Author page shows the SAME bar above its works: options are aggregated for that Author's works only (`facet-options?authorId=`), the Authors action is hidden (the author is fixed), and the bar only appears when all of the Author's works share one Gallery type. While a filter or server-side sort is active, Directories are UNFOLDED — every matching work, whether loose or inside a Directory, is shown as one plain card in a single sorted/paginated grid (Directory rows are browsing structure and dissolve under a filter); clearing the filter restores the pinned Directory row + loose grid. Author list cards and the Author detail header carry a `galleryType` badge naming the Author's dominant Gallery (derived from their works' Entry types, never stored). Counts follow the projection: the Gallery heading shows `filtered / total` entries while a filter or server-side sort is active (total from the sidebar projection), a Tag result page shows its entry count, and the Author list header shows the visible author count. These common actions do not require dialogs. The UI must not create, update, or delete a separate Gallery record.

The Author list keeps its dominant-Gallery type buttons and last-viewed / most-viewed / most-liked sorts, then offers two explicit filter groups: `Author tags` queries the independent Producer Tag vocabulary, while `Works contain tags` queries Entry Tags without copying them onto the Author. Multiple work Tags must coexist on one related Entry. Both groups combine through `GET /api/producers`; filter options come from `/api/producers/filter-options` and respect the current SFW/NSFW visibility boundary.

Creating a Facet reuses an existing Facet of the same name within its Section when that Facet has no assigned Tags (it is hidden after its Tags were removed); submitting the same name again for an already-visible Facet is rejected. This cannot re-insert a duplicate name protected by the unique facet-name index.

In edit mode each visible named Facet exposes up/down controls that reorder only that Section's Facets through a transactionally persisted `PUT /api/sections/:sectionId/facets/order`. The reorder payload must contain every Facet of the Section (including its unnamed default Facet) exactly once, mirroring the Content reorder contract.

## Author and Directory projection

The UI consistently calls the Producer subject `Author / 作者`; Producer remains the internal database, repository, schema, and HTTP name. The global Author navigation appears only after at least one Producer exists. Entry edit mode supports explicit creation/linking, filtered user-directed linking of an existing Author, and unlinking through compact controls that submit on Enter or blur; matching is never automatic. In Entry read mode, double-clicking an Author chip opens that Author. An Entry opened from an Author returns to that Author, including the specific Directory when applicable, and the return label names that Author or Directory rather than the Entry type.

`AuthorPage.vue` composes basics, the independent Producer Tag row, and Producer Content inside one information board, with its Ratings section below that board (edit mode: half-star picker, `+ Rating`, and shared up/down reordering inside the Author's dominant-Gallery partition; a workless Author shows an explanatory hint because there is no dominant Gallery to partition into). Authors have no Section or Facet layout. Clicking a Producer Tag in read mode opens only the Authors carrying that Producer Tag; it never searches the separate Entry Tag vocabulary. Related Entries appear below as Gallery-style work cards, with at most 25 top-level work/Directory cards per page; opening a work reuses Entry detail navigation. Both the Author list cards and the detail board show the Author's other recorded names as a faded sub-line, derived at render time from the `producer` dictionary.

## Author alias groups

An Author can be recorded under structurally different names per source site — Japanese kana/kanji renderings, a translated Chinese name, romaji/English — which character normalization alone can never match. The Advanced editing "Author aliases" tab manages this as groups: one display name (纯显示字符, may coincide with one of the spellings but is kept separate) plus every tag name that must resolve to it. A group is persisted as plain `producer`-vocabulary dictionary rows (alias → display name, partition `authors`) — no new schema — so import-time resolution, the author merge, and the faded alternates all reuse one mechanism. Saving a group writes the rows and immediately runs the dictionary merge: existing duplicate producers collapse into a single row that carries the display name, so every spelling links to exactly one Author and clicking any of them opens the same person. The repository piece is `author-alias-repository.ts` (`GET/POST /api/author-alias-groups`).

`author_directories` and their membership rows persist only the per-Author presentation layout. A Directory has a title and description, and its cover is derived from the first three ordered member Entry covers. In Author edit mode, `+ Directory` creates an empty Directory. Dropping one loose work onto another creates a Directory with an i18n default title (`New Directory / 新建文件夹`) and a numeric suffix on collision; dropping a work onto an existing Directory moves it there. Directory edit mode also exposes a drop target that removes only the Directory membership, returning the Entry to the Author's loose works. Finishing Directory editing saves title and description inline without a separate Save action. This organization never changes `Entry.type`, never creates a Gallery, and is included naturally in SQLite backup and restore.

## Running modes

Two run shapes share the same server entry (`apps/server/src/http/server-cli.ts` → `startApiServer`):

- **Development** — `pnpm dev:server` (API, tsx watch, `127.0.0.1:8765`) + `pnpm --filter @t3/web dev` (Vite, `127.0.0.1:5173`). The web app reaches the API cross-origin via the loopback CORS policy. `T3_DATA_DIR` defaults to `.data` under the server package.
- **Production single-process** — `pnpm build` once, then `pnpm start:server`: `createApiApp` receives `staticRoot` (default `<repo>/apps/web/dist` when the directory exists; override `T3_STATIC_ROOT`, empty disables) and serves the built UI from the API origin. `serveStatic` (hono) answers real files first; the `app.notFound` handler returns `index.html` for any non-`/api` GET (SPA fallback, client-side routes deep-link) and keeps JSON 404s for unknown `/api` routes. `T3_OPEN_BROWSER=1` spawns `cmd /c start` at the origin after listening (Windows only).
- **Packaged entries (repo root)** — `T3.bat`: port check (already listening → open browser, exit), first-run `pnpm run build`, then `cd apps\server && call node_modules\.bin\tsx.cmd src\http\server-cli.ts` with `T3_OPEN_BROWSER=1`; closing its window stops the server. **`T3.exe` (tray launcher, `tools/t3-launcher/`, C# WinForms net10.0-windows, framework-dependent single-file publish via `build-launcher.bat`)**: the recommended entry — default launch explicitly binds `127.0.0.1`; the tray's `Allow phone access (LAN)` confirms trusted-network intent, restarts the owned server with `T3_ENABLE_LAN=true` and `T3_HOST=0.0.0.0`, while health checks and `Open T3` remain on localhost. `Mobile addresses` lists every active RFC1918 IPv4 URL and copies the selected URL; firewall help is manual and Private-network-only. Disabling LAN restarts localhost-only, and Exit kills the server process tree. `--lan` and `--no-browser` are available for explicit startup/smoke tests. A second launch while the server is up only re-opens the browser and exits. First run builds the web UI automatically. ⚠ Both entries start the server via the workspace-local `tsx.cmd`, NEVER `npm exec … pnpm start:server` — the npm-exec chain hangs when double-clicked from Explorer (no TTY) and survives window close as orphan node processes; this was the real "connection refused" cause on 2026-09-03. Icon is intentionally unset for now (SystemIcons.Application placeholder; add `<ApplicationIcon>` + a real .ico later).
