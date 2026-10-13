# T³ architecture — data model, projections, and UI shell

> Authoritative product/data model. This supersedes every earlier Collection/Field-Definition/Typed-Value schema draft.
> Related boards: `database.md` (SQLite, migrations, backup/restore), `http-api.md` (routes + shared contracts),
> `import-and-source.md` (import commit, SiteProbe imports, Source library/maintenance), `offline-sync.md` (offline
> library/replay), `mobile.md`, `ui-design.md`, `siteprobe.md`, `development.md` (runtime, launcher, packaging), `roadmap.md`.

## 1. Core model

T³ has two core subjects:

- **Entry** — a collected work or item. `entries.type` supplies its category.
- **Producer** — a creator related to Entries through a many-to-many relation. The product UI calls it **Author / 作者**;
  Producer stays the internal database, repository, schema and HTTP name.

```text
Entry ──< entry_producers >── Producer
Entry ──< entry_tags >─────── Entry Tag vocabulary
Producer ──< producer_tag_assignments >── Producer Tag vocabulary
Entry ──< collection_entries >──┐
Producer ──< collection_producers >──┴── Collections (user-curated folders)
```

**Gallery is NOT a stored subject** — it is a read-time projection grouping Entries by `entries.type` (see §8).
**Collections** (migration `010_collections.sql`) are the only user-created grouping subject: lightweight curated
folders that never influence Entry domain fields, filtering, or templates (§11).

Entry and Producer tags intentionally use **separate vocabularies**. A Producer can still be discovered from the tags of
related Entries by joining through `entry_producers`; Entry tags are never suggested as the Producer's own tags and are
never copied into the Producer vocabulary.

## 2. Entry layout (Section → Facet)

Layouts are shared by `entries.type` and use `tag_groups`:

```text
Section (visible divider)
  └─ Facet (tag row)
```

- A Section never owns tags directly. Every `entry_tags` assignment has a **non-null `facet_id`**.
- When a Section needs tags without a visible facet label, it owns one **Facet whose name is the empty string**. The UI
  hides that label and gives it no independent visual row.
- `createSection()` creates the Section and its unnamed default Facet in one transaction.
- Repository deletion protects the default Facet and refuses to delete a Section or named Facet while it still contains
  assigned Tags.

Database-enforced invariants:

- Section rows have no parent and have a visible (non-empty) name.
- Facet rows have a parent.
- A Facet's parent is a Section with the same `entry_type`.
- An Entry tag assignment targets a Facet whose `entry_type` matches the Entry's `type`.
- A Tag has **one location per Entry**; dragging it changes `entry_tags.facet_id`.

Creating a Facet reuses an existing Facet of the same name within its Section **when that Facet has no assigned Tags**
(it is hidden after its Tags were removed); submitting the same name again for an already-visible Facet is rejected. This
cannot re-insert a duplicate name protected by the unique facet-name index.

In edit mode each visible named Facet exposes up/down controls that reorder only that Section's Facets through a
transactionally persisted `PUT /api/sections/:sectionId/facets/order`. The reorder payload must contain every Facet of
the Section (including its unnamed default Facet) exactly once, mirroring the Content reorder contract.

## 3. Content

Entry content is separate from the Section/Facet layout. `entry_contents.content_type` is a **free-text label, not an
enum**; examples are `short review` and `source url`. The text or URL is stored in `content`. Content rows do not belong
to Sections or Facets.

A Producer has a single scalar `content` field for its important short review/note. Producers have no Section/Facet
layout.

The **Source library is derived directly from this authoritative Content**: every HTTP(S) URL in every Content body is
extracted, normalized, and classified by a small known-site registry (Hitomi, 18comic, Hanime1) with hostname fallback
for all other sites. A manually created custom Content row is therefore recognized immediately, and no synchronized
source table or migration exists. See `import-and-source.md`.

## 4. Ratings

A rating is one line of **name + stars**.

- Slot names live in `rating_slots` and are fully templated per subject kind and Gallery.
- `subject_kind = 'entry'` slots are shared by every Entry of `entries.type`.
- `subject_kind = 'producer'` slots are partitioned by the Author's **dominant Gallery** (derived from their works, never
  stored), so creating a slot from any Author's edit mode automatically applies it to every same-dominant-Gallery Author
  — there is **no apply button** on the author side.
- `subject_kind = 'author_self'` is the third class added by migration 039: a dimension on the **person/studio** itself,
  beside the work's own dimension (see below).
- Stars are **0.5–5 in half steps**. `stars IS NULL` means the slot exists on the card but is **unrated**, and is never
  treated as zero.
- Values live in `entry_rating_values` / `producer_rating_values` (one row per slot+subject). Slot `sort_order` is
  shared per Gallery/partition as part of the template. The immutable migration is `006_rating_slots.sql`; classes +
  `producers.gallery_anchor` come from `039_rating_classes_and_author_anchor.sql`, corrected by `040` (re-adds the two
  `entries` triggers that `039`'s table rebuild dropped) and backfilled by `041`.

**Three rating classes (migration 039/041).** The original two names were never a good description: `rating_slots`
always knew `'entry'` (the work) and `'producer'` — but `'producer'` was really the **works summary** (what an unrated
work inherits), and **every pre-039 row** is that class. The new `'author_self'` is the person/studio's own class.
A Gallery's work dimensions ARE the works summary's dimensions by construction: the apply button was deleted and `041`
backfilled the drift, so the summary follows the Gallery's template automatically. Both author classes are
**Gallery-partitioned**. A dimension is deleted from its own row's ×. A freshly added rating row defaults to
`greater than 3`.

An Author's rating dimensions mirror the Gallery's Entry rating dimensions **by name**: recording an Author rating from
an import creates the `producer` slot carrying the same name as the Entry slot inside the Author's dominant-Gallery
partition, so the two sides describe the same dimension without a synchronized table. Because those are separate slot
rows per kind, entry-side tooling never assumes a shared `slotId`.

One place crosses kinds by name: the rating sort's **`applyAuthorRating`** mode falls back to the Author value for the
same-named dimension when a work carries none of its own, using the highest Author value and only for works with fewer
than four Authors. Rating **filters** stay entry-only, so a work that borrows an Author rating still counts as unrated
there.

## 5. SQLite implementation

The immutable initial migration is `apps/server/src/database/migrations/001_initial.sql`. All migrations use SQLite
syntax and are applied by the checksum-aware runner. The full migration list and the schema workflow are in
`database.md`.

Verification commands:

```text
pnpm test:integration
pnpm db:probe
pnpm db:doctor [optional-database-path]
```

Tests use in-memory or temporary SQLite databases and never `.data/library.db`.

## 6. Repository boundary

Each repository owns one concern; routes and the UI never touch SQLite directly.

- `layout-repository.ts` — creates, renames, orders, reads, and safely deletes Section/Facet layouts.
- `entry-tag-repository.ts` — normalizes/reuses Tags, assigns and moves them between matching Facets, removes
  assignments without deleting the vocabulary Tag, aggregates per-type Tag usage, filters Entry summaries, applies one
  Entry's tag→Facet placement to every other Entry of the same type (`applyEntryTagLayout`), serves the Gallery facet
  filter, and owns the bounded Entry-summary query used for Gallery pages, ID-backed lists, Entry Tag results, Recently
  viewed, random samples, and ranked Entry search pages. The full-array Entry list/browse readers
  are retired — every one of those surfaces uses the bounded query; only the Producer full-list
  route remains (editor autocomplete).
- `search-ranking.ts` — the shared lightweight relevance layer for global search: normalized exact/prefix/substring
  ordering plus bounded edit-distance matching without SQL wildcard interpretation.
- `suggestion-repository.ts` — the separate Relation autocomplete read model. Applies strict normalized full-query
  substring eligibility before deterministic ranking, returns at most 20 lightweight suggestions, keeps Entry Tag /
  Producer Tag / Author identity namespaces separate, excludes already-linked numeric IDs server-side, includes workless
  Authors, and scopes aliases by vocabulary plus dictionary partition. It never reuses global-search fuzzy eligibility.
- `entry-repository.ts` — composes the complete Entry detail: Producers, all Sections/Facets, nested Tags, and
  separately ordered Content.
- `producer-repository.ts` — creates and edits Producers and idempotently links/unlinks them with Entries.
- `producer-tag-repository.ts` — manages the independent Producer Tag vocabulary, searches Producers through their own
  Tags or through one related Entry carrying every selected work Tag, supplies partition-aware filter options for both
  vocabularies, and provides ranked Author-name search summaries.
- `author-directory-repository.ts` — persists per-Author Directory presentation layout and membership without changing
  Entry domain fields.
- `entry-content-repository.ts` — creates, edits, deletes, and transactionally reorders layout-independent Entry
  Content.
- `rating-repository.ts` — creates/reuses shared rating slots per subject kind and Gallery, lists composed rating rows
  (slot name + stars, unrated = null), upserts values, and reorders slots. Producer slots resolve through the dominant
  Gallery derivation, so a value always belongs to the partition its author currently sits in.
- `usage-repository.ts` — lazily creates each Entry's `entry_usage` row, records views and likes, returns the updated
  record; Producer aggregates are composed at read time.
- `partition-repository.ts` — reads and flips the per-Gallery SFW/NSFW flags and annotates Gallery/Author summaries.
- `collection-repository.ts` — manages Collections and their membership (two kinds, one-level nesting for entry folders,
  folder-level NSFW, per-kind ordering, member composition with preview refs and covers). Collection cards prefer each
  work's primary cover, fall back to its first preview, and use the canonical paged Entry query to repair empty/stale
  nested-folder summaries when a parent folder is opened; count/preview fallbacks prevent a stale zero from hiding known
  members. Collection list requests are generation- and visibility-guarded; switching from NSFW-visible to SFW clears
  inclusive folder/member previews immediately, then rejects late requests, so an in-flight response cannot repopulate
  hidden content.
- `template-export.ts` — turns each applied layout/tag layout into the Gallery's canonical template files under
  `<dataDir>/templates/` and provides the per-Gallery summaries (`GET /api/templates`) plus the majority-facet lookup
  that import uses to place tags on arrival.

**Filter/sort semantics.** Rating conditions join the same filter family: `eq`/`gt`/`lt` compare the stars of one shared
slot and `unrated` matches slots with no value, all ANDed with the tag and author rows; a rating sort orders high-to-low
server-side with unrated entries sinking last (the UI never re-sorts over it). The sort's optional `applyAuthorRating`
mode lets a work without its own value borrow its Authors' rating for the same-named dimension; the sort control carries
that mode as a second option per dimension instead of adding a filter-bar slot, keeping the bar usable on phones. Tag
filters use AND across included Tag IDs and exclude any Entry carrying an excluded Tag ID.

Producer search uses AND within each supplied Tag set and AND between the Author-Tag and work-Tag sets. Every selected
related Entry Tag must occur on the **same work**; Tags split across different works by one Producer do not match.

## 7. Application shell / view routing

`GalleryApp.vue` owns one mutually exclusive view state.

- **Sidebar entries are top-priority navigation**: every sidebar entry runs `leaveAllViews()` first, so clicking any
  entry wins from any depth (detail pages, creation forms, batch review).
- Detail pages remember their source in `returnView` (recent / viewLater / collections / batch) or `entryOrigin`
  (author, search, tag results), and an app-scoped navigation-memory registry retains pagination plus page-local
  tab/sort/filter state across the intentional component remount.
- Author/Directory and Collection nesting retain their direct-parent path and scroll stack independently. Opening a
  child always starts at the top; either the page-local Back or the permanent top-bar Back reconstructs the exact source
  and restores its page and scroll position.
- Successful Entry deletion follows that same canonical Back path rather than re-selecting the backing Gallery: an Entry
  opened from Author, Search, Tag results, Recent, View later, Collection, Random, or batch review returns to that exact
  source; a Gallery-opened Entry returns to the same filtered/paged Gallery after its mounted card data is refreshed.
  Deleted ids are removed from retained Tag/batch snapshots before reconstruction.
- The top-bar control is disabled on Home. Every view carries a fixed pair of floating controls in the lower-right
  corner: **Back above scroll-to-top**. The floating arrow runs the exact same `navigateBackFromTopBar` action and
  disabled state as the top-bar arrow (disabled on Home, where the top-bar one is too) rather than a second back
  implementation; the scroll-to-top half smooth-scrolls the current view to the top. The pair belongs to the app shell.
- Views must never be torn down before the destination's data is ready: opening an Entry from an Author loads the detail
  first and switches afterwards, so no intermediate view flashes.
- A single manual or folder-imported Entry opens its new detail directly. Multi-entry folder imports and batch imports
  land in an in-memory, one-time **batch review** group (only the new cards from that run, click-through, Back returns to
  the group, dismissed by `Complete` or any sidebar navigation); the group is never persisted as a Collection. The
  review can file the whole run into a Collection named `临时`/`临时2`/… so a batch too large to check in one sitting
  survives the one-time group. That group loads its cards from the committed Entry ids alone — an id is exact, while
  also filtering by Gallery type would empty the group whenever the typed spelling differed in case from the stored one
  (or the Gallery was later renamed).

## 8. Gallery projection

Gallery is product vocabulary for grouping Entries by `Entry.type`; it is **not a table** or independently persisted
subject. Creating an Entry with a previously unused type makes that Gallery appear. `GET /api/galleries` is a
`GROUP BY entries.type` projection with counts; Gallery contents use the existing Entry type filter. The UI must never
create, update, or delete a separate Gallery record.

- Sidebar Gallery order is a stored, library-wide revision (`036_gallery_order.sql` + `037_gallery_order_sync.sql`);
  it is a library-wide order vector, not a Gallery row.
- Gallery browsing is fully server-paged: deterministic date/title sorts and all existing
  Facet/Author/Rating/Usage filters call `POST /api/entries/query`; SQLite returns only the measured card page plus the
  filtered total.
- `PagedCardGrid` has a controlled mode that renders an already-bounded page without slicing it, emits page/page-size
  changes, keeps the app-scoped navigation-memory page key, and preserves the mobile two-times-row multiplier.
  Filter/sort changes reset to page 1; Entry Back keeps the remembered Gallery page and scroll state. Random uses a
  request-level seed so every page in the current random order is stable.
- Author works/directories and Collection members use the same bounded Entry/Producer page contracts; their parent
  detail/tree responses carry only metadata, counts, and small cover previews.

**Entry edit mode** starts from the detail toolbar; the repeatable Like action remains visible directly below Edit in
read mode.

- Double-clicking the title opens an inline editor; Enter or blur persists a trimmed title through
  `PATCH /api/entries/:entryId`; Escape cancels.
- Sections, named Facets, and Tag assignments are added through compact inline inputs that submit on Enter or blur; Tags
  can be dragged, removed, or double-clicked to rename the selected Entry assignment.
- In read mode, double-clicking an Entry Tag opens a result page containing every matching Entry across Gallery types.
- Ordered Entry Content is added, edited, deleted, and moved up/down inline.
- A Ratings section sits after the Section information board and before Content: in edit mode each shared slot row
  exposes a ten-zone half-star picker plus a clear button, `+ Rating` adds a new shared slot for the whole Gallery, and
  picking stars updates the row in place without a full detail reload; in read mode rated rows show a static partially
  filled ★ and unrated rows show an "Unrated" label. Each rating row also exposes up/down controls that reorder the
  SHARED slot list (`PUT /api/entries/:entryId/rating-slots/order`), so slot order is part of the Gallery template.
- Sections stack behind dashed dividers. An empty Section shows `+ Facet` and `+ Tag` together in its first row.
  Choosing `+ Tag` uses the Section's empty-name Facet to satisfy persistence rules, but that row is visible only while
  it carries Tags. Once a named Facet is visible, no additional empty-name control row is rendered; moving or deleting
  the last direct Tag removes its blank row immediately. Every visible Facet owns a left label column and a right Tag
  column. Read mode exposes no mutation or drag controls.
- Entry edit mode offers two structure operations in the detail toolbar: **`Save as template`** rebuilds the type's
  shared layout, while **`Apply tag layout`** only syncs the open Entry's tag→Facet placements onto every other Entry of
  the same type (skipping tags the Entry does not carry) — layout edits stay shared per type, but per-Entry tag placement
  stays free and can be re-aligned from any Entry.

**Facet filter bar** above each Gallery grid: rows of the shape Facet + tags (combo boxes with free input) plus a
separate `+ Authors` action that creates the optional Author row. EVERYTHING combines with AND — every picked tag must
be present under its Facet, so more tags always narrow the result (the same tag may appear under several Facets across
Entries and stays selectable under each, but a tag can be picked only once across rows — duplicates are rejected inline;
an "All tags" row matches tags regardless of Facet, and the Author row ORs its authors). The Author page shows the SAME
bar above its works: options are aggregated for that Author's works only (`facet-options?authorId=`), the Authors action
is hidden, and the bar only appears when all of the Author's works share one Gallery type. While a filter or server-side
sort is active, Directories are **UNFOLDED** — every matching work, loose or inside a Directory, is shown as one plain
card in a single sorted/paginated grid (Directory rows are browsing structure and dissolve under a filter); clearing the
filter restores the pinned Directory row + loose grid.

**Counts follow the projection**: the Gallery heading shows `filtered / total` while a filter or server-side sort is
active (total from the sidebar projection), a Tag result page shows its entry count, and the Author list header shows
the visible author count. These common actions do not require dialogs.

**Author list** keeps its dominant-Gallery type buttons and last-viewed / most-viewed / most-liked sorts, then offers
two explicit filter groups: `Author tags` queries the independent Producer Tag vocabulary, while `Works contain tags`
queries Entry Tags without copying them onto the Author. Multiple work Tags must coexist on one related Entry. Both
groups combine through `POST /api/producers/query`; filter options come from `/api/producers/filter-options` and respect
the current SFW/NSFW visibility boundary.

## 9. Author and Directory projection

The UI consistently calls the Producer subject `Author / 作者`; Producer remains the internal name.

- Author list/query/search results include **only Producers that currently have at least one linked Entry**, so deleting
  an Author's final work hides that Author everywhere discoverable without deleting the Producer row or coupling Entry
  deletion to Producer deletion. Direct detail access remains available for the create/edit flow, and a future import
  can safely relink the hidden Producer. The global Author navigation appears only after at least one visible Author
  exists. See `database.md` for `pruneWorklessProducers` and migrations 018/019.
- Entry edit mode supports explicit creation/linking, filtered user-directed linking of an existing Author, and
  unlinking through compact controls that submit on Enter or blur; **matching is never automatic**.
- It offers a one-click **`Convert all Authors / 全部转为多作者`** action on works with several Authors: every credited
  Author is replaced by one shared `multiple author` Author, and the action deliberately does not judge who deserves to
  stay. Anthologies mix one-off contributors with real Authors, and an Author who only ever appears in anthologies would
  otherwise keep resurfacing; absorbing everyone both clears the work and lets such an Author fall to zero works, which
  hides them. Authors that keep other works simply lose this one. The converted Author rows are preserved and simply
  stop being discoverable, so a later import can still relink them. The action appears only on a work with at least two
  credited Authors that are not already the `multiple author` Author. In read mode, double-clicking an Author chip opens
  that Author.
- An Entry opened from an Author returns to that Author, including the specific Directory when applicable, and the
  return label names that Author or Directory rather than the Entry type.

`AuthorPage.vue` composes basics, the independent Producer Tag row, and Producer Content inside one information board,
with its Ratings section below that board (edit mode: half-star picker, `+ Rating`, and shared up/down reordering inside
the Author's dominant-Gallery partition; a workless Author shows an explanatory hint because there is no dominant Gallery
to partition into). Authors have no Section or Facet layout. Clicking a Producer Tag in read mode opens only the Authors
carrying that Producer Tag; it never searches the Entry Tag vocabulary. Related Entries appear below as Gallery-style
work cards, one server page per screenful: the request asks for exactly the cards `.author-card-grid` can show (its
fixed 6 / 3 / 2 columns × the rows-per-page preference, doubled on phones), so the last row is never half empty and the
page bar never appears a screen early. Both the Author list cards and the detail board show the Author's other recorded
names as a faded sub-line, derived at render time from the `producer` dictionary.

### Directories

`author_directories` and their membership rows persist **only the per-Author presentation layout**.

- A Directory has a title and description; its cover is derived from the first three ordered member Entry covers.
- In Author edit mode, `+ Directory` creates an empty Directory. Dropping one loose work onto another creates a
  Directory with an i18n default title (`New Directory / 新建文件夹`) and a numeric suffix on collision; dropping a work
  onto an existing Directory moves it there.
- Directory edit mode also exposes a drop target that removes only the Directory membership, returning the Entry to the
  Author's loose works. Finishing Directory editing saves title and description inline without a separate Save action.
- This organization never changes `Entry.type`, never creates a Gallery, and is included naturally in SQLite backup and
  restore.

### Author work merge

Author edit mode exposes a separate **`Merge works / 合并作品`** state. It temporarily unfolds Directory membership and
pages all of that Author's works; card clicks select exactly two same-Gallery Entries and cannot trigger Directory
creation or movement. The confirmation dialog chooses the keeper/title, whether to union Tags, and which detected URLs
from the absorbed Entry become new `Source URL` Content. One server transaction copies deduplicated selections and all
Producer/Author links, then deletes the absorbed Entry; cancelling either stage writes nothing. See also
`http-api.md` (`POST /api/entries/merge`) and `database.md` (merge is schema-neutral).

## 10. Author alias groups

An Author can be recorded under structurally different names per source site — Japanese kana/kanji renderings, a
translated Chinese name, romaji/English — which character normalization alone can never match. The Advanced editing
"Author aliases" tab manages this as groups: one **display name** (纯显示字符, may coincide with one of the spellings but
is kept separate) plus every tag name that must resolve to it.

- A group is persisted as plain `producer`-vocabulary dictionary rows (alias → display name, partition `authors`) — **no
  new schema** — so import-time resolution, the author merge, and the faded alternates all reuse one mechanism.
- Saving a group writes the rows and immediately runs the dictionary merge: existing duplicate producers collapse into a
  single row carrying the display name, so every spelling links to exactly one Author and clicking any of them opens the
  same person.
- Repository piece: `author-alias-repository.ts` (`GET/POST /api/author-alias-groups`).

## 11. Collections

Collections (`010_collections.sql`, Gallery scope added by `017_collection_gallery_scope.sql`) are user-curated folders
— the lightweight "put these together" layer, deliberately **without facets, templates, or filtering of their own**.

- Two kinds exist, fixed at creation: `entry` collections (may nest child folders **exactly one level deep**) and
  `producer` collections (flat).
- The collection tree is compact: each node returns filtered counts and at most three cover-preview members. Opening a
  node pages members independently through the Entry or Producer query contract.
- A **folder-level NSFW switch** hides the entire folder regardless of its members' own states; SFW mode also filters
  NSFW members from previews, counts, and pages.
- A folder's edit view can put one Tag on every work it holds (child folders included) through
  `POST /api/collections/:collectionId/tags`, reusing each Gallery's own placement rule for that name; it reports how
  many works were tagged, already carried it, or could not take it because their Gallery has no structure yet.
- Membership (`collection_entries` / `collection_producers`) is idempotent linking; removal only unlinks.

**Add-to-collection menu.** On a work it offers the folders curated onto **that work's own Gallery page** (child folders
included), plus the unfiled ones, which sit on no page and therefore stay usable from anywhere; a folder the work is
already in stays listed even if it belongs to another page, so an existing membership can still be seen and left again.
Producer folders are unaffected — never Gallery-scoped, so an Author's menu keeps offering all of them.

**Gallery scope.** Entry folders are curated onto one Gallery page: `collections.gallery_type` names it. The Collections
page is ONE flat row of pages — every Gallery, then "Unfiled" when such folders exist, then Authors last — so there is no
Works/Authors level above the Galleries. Hiding an NSFW Gallery in SFW mode therefore takes its page and its folders with
it. When every Gallery page is hidden, Authors is the only page left and the page list hands over to it. Folders whose
members span Galleries, or that have no members yet, stay unfiled (`gallery_type` is NULL) and appear on their own
"Unfiled" page, which no Gallery partition can hide; the migration backfills existing folders from their members and
gives nested folders their parent's page. A new folder is created on the page it was started from, and a nested folder
can never leave its parent's page. Producer folders keep no scope at all: an Author's Gallery is derived from works and
would move as the library grows. The scope is a name, not a foreign key: `db:doctor` reports a folder whose Gallery no
longer exists. Page switching never renders the other kind's folders.

**UI.** `CollectionsPage.vue` is a permanent sidebar entry (below View later) with Works/Authors tabs in the shared
connected-tab style; edit mode creates, deletes, and drag-reorders folders, and folder covers are built from the first
member covers. Inside an entry collection, edit mode offers `+ New subfolder` — child folders render above the members as
folder cards, opening one navigates in without leaving the current Edit mode, and its back button returns to the parent
folder rather than the list. Normal-mode member clicks open Entry detail; Edit-mode clicks select the member for
organization instead, and a separate 44px removal control deletes only the active folder's `collection_entries` link.
Pending removals are deduplicated, and a failed removal keeps the member grid visible with an inline error. Entry detail
pages and the Author information board carry a persistent short 📁+ button that opens an add-to-collection menu (freshly
fetched on open; already-joined folders show ✓ and are disabled). The same add-to menu pattern applies to entry cards'
detail toolbar. The `snapshot` payload ships `collections[].galleryType` so the offline projection groups folders the
same way; rows written before the column read as unfiled.

## 12. Usage tracking

`entry_usage` (migrations `007_entry_usage.sql` + `008_entry_likes.sql`) is a **lazy per-Entry row**: `view_count`,
`last_viewed_at`, `like_count`; a missing row means never viewed.

- A view is recorded **only when the user opens the Entry's source URL** (the client records before the navigation;
  opening the detail card does not count). Likes are unlimited and re-clickable (+1 per call).
- Author-side numbers are always derived by aggregating their works (`SUM` counts, `MAX` last view) — never stored.
- Entry summaries, Entry details, Author summaries, and Author details all embed `viewCount` / `likeCount` /
  `lastViewedAt`.
- Usage is **sort-only** in the UI (views / last viewed / likes) — no numeric or date condition rows.

## 13. Usage views (Recent / View later)

- `RecentViewPage.vue` groups the current mode by Gallery with browser-style tabs whose active edge joins the content
  panel. It opens in ★ Last-viewed mode by default, hides works with no view record at all, shows at most 72 cards
  (about three pages), and removes every NSFW Gallery tab while Show NSFW is off.
- `ViewLaterPage.vue` uses the same shell and adds independent Entries/Authors pages. Membership is library data:
  `011_view_later.sql` and `012_view_later_producers.sql` create ordered Entry and Producer lists with unique membership
  and `ON DELETE CASCADE`. `GET /api/view-later` returns both authorities; idempotent PUT/DELETE routes mutate one Entry
  or Author membership; `POST /api/view-later/merge` only imports the old browser Entry list while ignoring stale
  deleted ids.
- On first successful startup the web store merges legacy localStorage `t3.view-later` once and removes that key.
  Thereafter startup, opening View later, and regaining window focus pull both server lists, while all client operations
  are serialized so a stale response cannot overwrite a newer mutation.
- Entry and Author detail toolbars use the same inactive clock / active checked-clock control.
- Every general sort surface — Gallery, Author works, Author list, Recently viewed, and both View later pages — also
  offers stable random ordering via a shuffled copy, without mutating source arrays or continuously reshuffling on
  unrelated renders. The usage switches are **toggles**: clicking the active mode again exits it. Their compact card
  grids use bounded card geometry so media cannot escape into neighboring cards.

## 14. Gallery partitions (SFW / NSFW)

`gallery_settings` (`009_gallery_partitions.sql`) marks a whole Entry type (Gallery) SFW or NSFW — individual Entries are
never partitioned, and the **default is SFW**. Author partitioning is **derived** (any work in an NSFW Gallery makes the
Author NSFW) and flips instantly with the Gallery switch.

The client's **Show NSFW** preference (localStorage `t3.showNsfw`, toggled in Settings) is a global visibility boundary:
it hides NSFW Galleries from the sidebar and Recently viewed tabs, NSFW Authors, NSFW members/covers/counts inside
Collections, and NSFW Works/Authors/Tags from Random pick. View later is inside the same boundary: its Entries page
reloads with the current preference and drops both the NSFW works and their Gallery tab. Every one of these surfaces
reads the stored partition flag or the server's `includeNsfw` answer — **never the Gallery type name**.

- Sidebar Author and View later numbers come from the single `GET /api/navigation-counts` interface, which answers the
  same question for all of them under one boundary instead of each surface counting its own raw list. The endpoint is
  the one place that knows an Author is NSFW when any of their works is, so the numbers cannot drift from what those
  pages list.
- Search routes and Tag relation suggestions use their `includeNsfw` contract so tags used only by NSFW Galleries do not
  leak through visibility filters.
- For a **Tag input** the boundary follows the **subject being edited**, not the browser-wide switch: an Entry editor
  offers only the vocabulary its own Gallery's partition can show, and an Author editor follows that Author's derived
  partition. The global dictionary editor (Advanced editing) stays on the Show NSFW switch, because it manages the
  vocabulary itself rather than one subject.
- A Gallery that does not exist yet is its own partition and starts SFW: nothing about a new type is inherited.
- Turning Show NSFW off while Random results are visible clears that deal immediately.

## 15. Global search

The permanent sidebar owns a compact search field. Focusing it or submitting a query opens `SearchPage.vue` as another
mutually exclusive full ladder view; the page has **Entry, Tag, and Author** scopes and deliberately stays separate from
the Gallery facet-filter state.

- Entry and Author hits reuse card-style presentation and preserve the existing NSFW visibility preference. Tag search
  sends that same preference to the server: SFW mode omits tags used only by NSFW Galleries and reports SFW-only counts
  for shared tags. Tag hits open the existing cross-Gallery Tag results page.
- Navigation into an Entry, Tag result, or Author carries the current query and scope so Back reconstructs the same
  search state instead of resetting it.
- Entry- and Author-scope search use the bounded `POST /api/entries/query` and `POST /api/producers/query` contracts,
  while Tag search keeps its dedicated route. Author search matches the spellings recorded for an author as well as
  their display name, so typing an alias (`ishikei`) finds the author it resolves to (`石恵`); the result card keeps the
  author's own name and shows the matched spelling underneath. Alias rows whose canonical name is still empty are
  placeholders from a dictionary import and belong to no author.
- Production builds derive the API root from the current serving origin (`/api/`); development still defaults to
  `http://127.0.0.1:8765/api/`, with `VITE_API_BASE_URL` as the explicit override.

## 16. Shared cards, images, and comboboxes

All work cards — Gallery grid, Author works (including Directory contents), Recently viewed, View later, Random picks,
Collection member lists, tag results — use the shared `components/EntryCard.vue` (multi-cover perspective stack + title +
type + optional usage note, with a `corner` slot for extra buttons). Pages must not re-implement card layout.

- `LazyCardImage.vue` children receive their real asset URL only after `IntersectionObserver` approval, request
  immediately after approval without a second native-lazy gate, retain async decoding, and stay visually hidden over the
  reserved card geometry until load completes; browsers without IntersectionObserver receive the URL immediately.
- Managed Entry media on card-sized surfaces goes through `entryCardMediaRef`: `/api/thumbnails/...` resolves to a
  source-hash-addressed 512px WebP with immutable caching, while a not-yet-backfilled source redirects safely to the
  original. Entry detail media deliberately bypasses this helper and retains the original asset.
- New uploads generate thumbnails immediately; `pnpm media:thumbnails` is the resumable existing-assets backfill.
  Thumbnails are derived files under each Entry's asset directory, **not database state**.
- Reusable comboboxes (`TagCombobox.vue`) provide the filter rows' typeahead with the same near-character ranking as
  global search.
- **Relation input on editing surfaces is a different control with a different contract**: `components/SuggestionInput.vue`
  owns the debounce/abort/IME/keyboard interaction and renders only server-suggested candidates from the
  `/api/suggestions/*` read endpoints (already-bound IDs are excluded server-side so the 20-item budget stays intact).
  Entry Tag add, Entry Author link, and Author (Producer Tag) add all submit **canonical names on candidate select** — an
  alias hit must never persist the alias text — while creatable mode falls back to the typed text on Enter with no
  highlighted candidate; id-only mode (Author link) submits nothing without an explicit selection, and blur only closes
  the dropdown. The create-and-link Author form stays independent but shows a best-effort duplicate warning when the
  typed name matches an existing Author. Editing no longer loads full Tag/Author vocabularies for autocomplete; browse
  filters and global search keep their own components and ranking.

## 17. Manual composer and import review (UI surfaces)

The manual composer on `AddEntryPage.vue` stays a plain cover-and-fields form: it can either create the Entry outright,
or hand it to detailed editing through one secondary button under the Gallery field, which reads "Template ready — open
detailed editing" for an existing Gallery and "New Gallery — create its template" for a type that does not exist yet.
Either way it creates the work with what is filled in and opens that work's own editor — the template is the Gallery's
shared structure and that is the surface that shows it; the creation page never invents a second, Entry-local notion of
structure. A new Gallery starts from the bare Entry, and to stop the first work of a Gallery from quietly keeping its
structure private, clicking Done on a work whose Gallery has no Sections yet — and which is that Gallery's only work —
raises a modal: apply this work's Sections and Facets to the whole Gallery, or not now. Applying does exactly what the
toolbar's `Save as template` does.

`AddEntryPage.vue` also reviews an export before commit. Its review section renders a template preview card — the target
Gallery's Section → Facet rows carrying the Tag values each reviewed field mapping will produce, plus linked authors and
mapped Content — recomputed live as mappings change. When the target template owns a `Type` Facet, a manual content-type
input (per import and batch-wide) accepts a value for sites whose exports omit it (e.g. hitomi); the value merges into
every Entry's `contentTypes` field and is committed as a Tag under that Facet. The input and its suggestion list are
hidden when the template has no `Type` Facet. See `import-and-source.md` for the commit contract and review semantics.

## 18. UI localization and app font

`apps/web/src/i18n.ts` is the UI copy boundary. It defines the supported locale IDs, a **type-checked flat English
dictionary**, and a Simplified Chinese dictionary that must contain the same keys. `useI18n()` exposes the reactive
locale, interpolation-aware translation lookup, and locale setter without coupling localization to API or persistence
DTOs. The selected locale is stored under `t3.locale` in browser storage and mirrored to the document `lang` attribute;
English is the fallback for missing or invalid stored values. **Dictionary parity is enforced by the compiler**: `zh-CN`
is declared `satisfies Record<MessageKey, string>` over `keyof typeof en`, so a missing or extra key is a type error in
either direction. New UI copy must be added to **both** dictionaries rather than embedded in component templates.

The starting locale, with no stored choice, follows `navigator.languages` (any `zh*` ⇒ `zh-CN`); a stored choice wins and
the switcher persists.

**App font (v48).** T³'s own Chinese voice is **霞鹜文楷** (LXGW WenKai, lightweight build, SIL OFL 1.1). Because that
font cannot also be the content font, the split is: the face is applied app-wide on `body` and restricted by
`unicode-range` to Han, so Latin and Arabic numerals stay in Inter; every value that came out of the library wears
`.t3-library-text` and goes back to the platform stack. The library is scraped from many sites and carries rare kanji,
traditional forms, Korean and emoji, so a bundled subset cannot cover it by construction, while the app's own copy is a
closed set a subset can cover exactly. `tools/fonts/subset-wenkai.py` cuts the subset (GB/T 2312 + Big5 + JIS X 0208 +
kana + punctuation = 18109 glyphs / 3890 KB). A font `unicode-range`/`font: inherit` interaction under Vue's scoped
two-component selectors is why the tag-chip rule carries `!important`.

`GalleryApp.vue` references dictionary keys for visible copy, placeholders, accessible labels, and local fallback errors.
Its header Settings entry contains the `en` / `zh-CN` language selector plus an `Advanced editing` entry
(`AdvancedEditingPage.vue`, opened as a full ladder view).

### Advanced editing tabs

Advanced editing has five tabs: **Tags** (Entry-vocabulary taxonomy aliases with partitions and placeholder rows, plus
a Tag-merge module — pick the kept tag and the tags to absorb via the relation autocomplete; assignments re-point to the
kept tag and the merged tag rows are deleted outright, with a pre-transaction database backup), **Authors** (a compact
one-button Author merge — first tap plans duplicate groups, second tap executes with backup + integrity report — above
the Author-aliases groups whose name inputs use the relation autocomplete with fill-on-select), **Gallery templates**
(per-Gallery template file preview: structure dimensions, tag→facet assignments, local file paths of
`<type>.template.json` / `<type>.tag-layout.json`, with an explanation that saving/applying happens from any Entry card
of that Gallery), **Title shortening**, and **Source maintenance**. Title shortening is now a `.advanced-subcard` inside
the Templates card (its `data-testid="advanced-titles"` kept, its tab removed). The former Unassigned-tags tab was
removed; author identity aliases are managed only in the Authors tab (they share the same `taxonomy_aliases`
producer-vocabulary storage, so import-time resolution is unchanged). Unassigned Entry tags are surfaced instead through
`GET /api/tags/unassigned` + `POST /api/tags/unassigned/move` (see `http-api.md`).

**Title shortening.** Handles Entries titled `<original> | <translation>`, where the second half duplicates the title and
only lengthens every card: planning lists each candidate with both sides and a suggested side — the translated one when
it carries Han/Kana text, the original when the other side is only Hangul, and nothing when both sides are ASCII and the
direction is unknowable — the review overrides any suggestion with one click, applying needs a second confirming tap,
writes a database backup first, and re-verifies each Entry's current title so a plan that went stale cannot overwrite a
later rename.

### Tag dictionary unification

The Simplified↔Traditional dictionary is built in (`opencc-js`, verified identical to the site tool's t2s output over
7709 names). Partitions were abandoned as a resolution mechanism (they never resolved anything; the real split is Facet
placement). One button migrates hand-written translations. Three traps are recorded: old rows stop matching once the key
simplifies; one reversed pair can 500 the whole batch; delete-before-update on the unique key.

## 19. Navigation counts and shared-state endpoints

`GET /api/navigation-counts?includeNsfw=` returns `{ authors, viewLaterEntries, viewLaterAuthors }` — one interface for
the sidebar's visibility-aware numbers. `authors` counts the same universe the Authors page can list (a workless Author
is never counted); with `includeNsfw=false` an Author counts only when none of their works sits in an NSFW Gallery. A
saved work/Author counts only when the current boundary can actually show it. The web client refreshes these on startup,
when Show NSFW is toggled, and whenever either View later list changes.

## 20. Running modes (summary)

Two run shapes share the server entry `apps/server/src/http/server-cli.ts` → `startApiServer`:

- **Development** — `pnpm dev:server` (API, tsx watch, `127.0.0.1:8765`) + `pnpm --filter @t3/web dev` (Vite,
  `127.0.0.1:5173`). The web app reaches the API cross-origin via the loopback CORS policy. `T3_DATA_DIR` defaults to
  `.data` under the server package.
- **Production single-process** — `pnpm build` once, then `pnpm start:server`: serves the API **and** the built
  `apps/web/dist` UI from the same origin (`http://127.0.0.1:8765`), with SPA fallback.
- **Packaged entries (repo root)** — `T3.exe` (tray launcher, recommended) and `T3.bat`.

Full details, the launcher/packaging chain, environment variables, and the Node-runtime selection are in
`development.md`.
