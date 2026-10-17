# T³ database board — SQLite, migrations, backup/restore

> The database development boundary. The product/data model lives in `architecture.md`; HTTP routes in `http-api.md`.
> Everything schema-related follows the order: **immutable migration → `db:probe` → real-SQL integration test →
> `db:doctor` → API → UI**.

## 1. Access boundary

SQLite is accessed **only by the local backend** through explicit SQL and `better-sqlite3`; there is no ORM and no
frontend database access.

Every normal writable connection applies:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

`:memory:` databases cannot persist WAL and therefore report `journal_mode=memory`; **temporary file databases** verify
WAL behavior. Data directory default is `.data` under `apps/server` (holding `library.db`, `assets/`, `backups/`,
`templates/`); override with `T3_DATA_DIR`.

## 2. Migration system

- Migration files live under `apps/server/src/database/migrations/`.
- Applied versions, names, and **SHA-256 checksums** are stored in `schema_migrations`.
- A changed applied migration is **rejected** (checksum gate). Hash comparison treats LF and CRLF as equivalent, so a
  Windows Git checkout cannot invalidate an already-applied migration; real SQL changes still fail the gate.
- Migrations become **immutable after merge**; never change the schema merely to simplify frontend code. All schema
  changes require a **new** immutable migration.
- Tests apply migrations only to memory or temporary databases.
- ⚠ A migration edited twice in quick succession can be applied mid-draft on the live library (the live server applies
  outstanding migrations on a `/api/sync/capabilities` poll) — a checksum mismatch that then bricks startup, repaired by
  restoring the file and adding a new migration.

### Migration inventory

| # | File | Adds |
| --- | --- | --- |
| 001 | `001_initial.sql` | Core tables: `entries`, `producers`, `entry_producers`, `tags`, `tag_groups`, `entry_tags`, `producer_tags`, `producer_tag_assignments`, `entry_contents`, `producers.content`. |
| 002 | `002_author_directories.sql` | Author Directory layout + membership. |
| 003 | `003_taxonomy_aliases.sql` | Taxonomy alias dictionary (spelling → canonical). |
| 004 | `004_entry_page_media.sql` | `page_count` + ordered `preview_refs` (multi-page preview images). |
| 005 | `005_taxonomy_alias_partitions.sql` | `taxonomy_aliases.partition` label + placeholder rows (empty canonical). |
| 006 | `006_rating_slots.sql` | Shared rating slots per subject kind + Gallery; the two value tables. |
| 007 | `007_entry_usage.sql` | `entry_usage` (lazy per-Entry view counter + last-viewed, FK CASCADE). |
| 008 | `008_entry_likes.sql` | `like_count` on `entry_usage` (unlimited, re-clickable). |
| 009 | `009_gallery_partitions.sql` | `gallery_settings` (per Entry-type hideable flag `nsfw`, default not hideable). |
| 010 | `010_collections.sql` | `collections` (entry/producer kinds, one-level entry nesting, title/description/nsfw/sort order) + `collection_entries` / `collection_producers`. |
| 011 | `011_view_later.sql` | Library-wide ordered `view_later_entries` (FK CASCADE, idempotent, position preserved). |
| 012 | `012_view_later_producers.sql` | Independent ordered `view_later_producers` list. |
| 013 | `013_entry_page_indexes.sql` | Covering `(type, upload_date, id)` and NOCASE `(type, title, id)` indexes for deterministic Gallery pages. |
| 014 | `014_source_maintenance.sql` | Source invalidation status + durable review-workflow tables (`source_statuses`, `source_maintenance_runs/items`). |
| 015 | `015_sync_metadata.sql` | Sync identity singleton (`libraryId`); stays empty, lazily seeded with a random id on first access. |
| 016 | `016_sync_foundation.sql` | C2 foundation: immutable `sync_uid` + monotonic `syncVersion` on Entries/Entry Contents; `sync_changes` journal + `sync_tombstones` (triggers); `sync_operation_receipts`. Rows backfilled before triggers install. |
| 017 | `017_collection_gallery_scope.sql` | `collections.gallery_type` (Entry folders curated onto one Gallery page). |
| 018 | `018_prune_workless_authors.sql` | Removes Authors left holding no work (residue). |
| 019 | `019_clear_orphan_author_memberships.sql` | Clears membership rows pointing at a deleted Author (pre-merge-cleanup residue). |
| 020 | `020_prune_unused_tags.sql` | Removes tags no work (and no Author for the Producer vocabulary) carries. |
| 021 | `021_site_crawl_state.sql` | `site_works` (`(site, workId)` → Entry identity, `WITHOUT ROWID`) + `site_crawl_sources` (one update cursor per crawled listing). **Not** on the sync allowlist. |
| 022 | `022_sync_media_receipts.sql` | C3 idempotent media upload receipts (bytes stay filesystem-backed). |
| 023 | `023_sync_offline_created_entries.sql` | Registers which Entry UUIDs came from offline `entry.create` replay (media endpoint restricted to these). |
| 024 | `024_rating_slot_sync_identity.sql` | Permanent immutable `sync_uid` per rating slot (numeric rowids can be reused). |
| 025 | `025_producer_view_later_sync.sql` | Immutable transport identity + revision tracking for Authors; journal entity allowlist expanded (both journal tables rebuilt, sequences/tombstones preserved). |
| 026 | `026_producer_rating_sync.sql` | Producer rating values share the Producer revision via DB trigger. |
| 027 | `027_producer_tags_sync.sql` | Stable offline identities for the shared Producer-tag vocabulary. |
| 028 | `028_author_resource_sync.sql` | Collection + shared rating-layout resources, stable Directory UIDs, Producer directory-metadata/membership journaling. |
| 029 | `029_entry_author_links_sync.sql` | `entry_producers` insert/delete journaled on the owning Entry revision. |
| 030 | `030_entry_tags_sync.sql` | Entry tag assignments advance their Entry revision + journal. |
| 031 | `031_sync_change_feed_ack.sql` | Per-client durable served/ack cursor (journal/tombstones never pruned by ack). |
| 032 | `032_online_entry_create_claims.sql` | A client-assigned online Entry UID must prove its original create request before offline replay adopts it. |
| 033 | `033_offline_producer_origins.sql` | Causal identity registry for Producer creation (origin op/client/library/epoch + receipt opId). |
| 034 | `034_offline_entry_tag_vocabulary.sql` | Stable Entry Tag / Section / Facet transport identity + shared per-type layout revision. |
| 035 | `035_entry_vocabulary_plural_origins.sql` | Lets distinct creation envelopes converge on one canonical entity. |
| 036 | `036_gallery_order.sql` | Library-wide Gallery sidebar order (Gallery is derived from `entries.type`, so its order had nowhere to live). |
| 037 | `037_gallery_order_sync.sql` | Independent library-wide Gallery order revision; preserves journal high-water mark. |
| 038 | `038_entry_duration.sql` | `duration_seconds` (whole seconds) — a video's runtime, the peer of `page_count`. |
| 039 | `039_rating_classes_and_author_anchor.sql` | Three rating classes (`entry` / `producer` = works summary / `author_self`) + stored `producers.gallery_anchor`. |
| 040 | `040_entry_rating_layout_triggers.sql` | Correction to 039: restores the two `entries` triggers that `039`'s table rebuild dropped. |
| 041 | `041_works_summary_follows_gallery.sql` | Backfills every Gallery's works summary to match its work dimensions. |
| 042 | `042_standalone_author_directory_seed.sql` | New standalone creates may pre-supply an independent Directory-set identity. |
| 043 | `043_gallery_partition_sync.sql` | Dedicated per-type partition overlay revision; Gallery stays derived from `entries.type`. |
| 044 | `044_gallery_card_layout.sql` | Per-Gallery `card_layout` (`vertical` default / `horizontal`) on `gallery_settings`; independent of `nsfw`, excluded from snapshot/journal contracts. |

## 3. Database-backed behavior verification

```text
pnpm test                 # unit / component (excludes *.integration.test.ts)
pnpm test:integration     # real-SQL integration
pnpm db:probe             # seeds + verifies the current Entry/Producer/Facet scenario
pnpm db:doctor [path]     # opens a provided DB read-only, or a disposable migrated DB
pnpm db:backup [path]
pnpm db:restore <backupDir> [path]
```

### Test helpers

- `createMemoryDatabase()` — fast integration tests with real SQLite.
- `createTempFileDatabase()` — disposable DB for WAL and file-level behavior.
- `createMigratedMemoryDatabase()` — isolated real-SQL schema tests.
- `applyAllMigrations(database)` — applies immutable migrations and validates stored SHA-256 checksums.
- `runDatabaseProbe()` — seeds and verifies the current Entry/Producer/Facet scenario.

Tests must start from a known schema version and **must never touch `.data/library.db`**.

### `db:probe` proves

1. the schema migrates on real SQLite;
2. Entry/Producer many-to-many relations work;
3. unnamed and named Facets work;
4. Entry Tags can move only between matching Facets;
5. Producer Tags use a separate vocabulary;
6. Producers can be found through related Entry Tags;
7. arbitrary Entry content labels work;
8. canonical Import commit and the type-derived Gallery projection work;
9. per-Gallery Entry Tag usage aggregation works;
10. doctor invariants are clean.

No database-backed product UI is valid until these gates pass.

### Database Doctor

`pnpm db:doctor [path]` repeats the cross-row/cross-table invariants the triggers enforce, read-only, against a provided
database (or a disposable migrated one without a path). It also checks the sync identities and unique indexes when the
v16 columns are present, and reports a Collection folder whose `gallery_type` no longer names an existing Gallery (no
page would list it).

### Adding a migration safely

1. Write a new immutable migration file; never edit an applied one.
2. Add/extend a `db:probe` check for the new behavior.
3. Add real-SQL integration tests.
4. Run `db:doctor` (disposable or a scratch copy).
5. If the migration adds an Entry column, the **incremental-migration fixtures** populate an older schema with today's
   writer — use the version-faithful `insertLegacyEntry` helper and bump hardcoded version pins.
6. Only then update the API and UI.

**Rebuilding a cascade-parent table** (a changed CHECK/UNIQUE forces a rebuild): `RENAME TO` rewrites the child's FK
text, so a later `DROP` cascades every value away with no error (`foreign_keys=OFF` is a no-op inside the migration
transaction; `legacy_alter_table` did not help). Safe order: build-new → drop the **old child first** → drop the old
parent → rename; drop every trigger naming those tables first. Prove it on a read-only copy of the real library with
before/after digests.

## 4. Derived Source library and Entry merge

**Source ownership stays in `entry_contents`.** The Source library parses every HTTP(S) URL from every Content body at
read time and groups known sites by a stable `known:<site>` key, with `host:<hostname>` fallback for unregistered sites.
This keeps a URL entered manually in any Content type immediately discoverable without a dual-write table, migration, or
repair job. Server-side callers can derive the Entry IDs for one Source key for future site-wide maintenance; the
projection stays server-side until a bounded Source-management API is needed. See `import-and-source.md` §Source
library.

**Merging two works is schema-neutral.** One repository transaction validates same Author and same Gallery, inserts
missing `entry_tags`, appends selected absorbed-Entry URLs as `Source URL` Content, and deletes the absorbed Entry. Any
failed validation or write rolls back Tags, Content, and deletion together. Other Content, media, Ratings, usage,
Directory, Collection, and View later memberships from the absorbed Entry are deliberately **not** copied.

`pnpm merge:authors` merges Producers in three passes (identical normalized names → separator-variant spellings where
`_`/`-`/`.` count as whitespace and which is local to merge detection → `producer`-vocabulary dictionary canonicalization).
Each group collapses to the row with the most linked works; on equal counts the separator-free spelling becomes the
display name, then the lowest id. Works, Producer tags, Author rating values, and directories transfer to the survivor;
values left dangling by an earlier run are dropped; directories absorb each other's works and colliding memberships
deduplicate in the keeper's favour. The run writes a `<db>.merge-backup-<timestamp>` snapshot, executes in one
transaction with foreign keys temporarily disabled, then re-enables them and verifies `PRAGMA foreign_key_check` + doctor
invariants. Dry-run (default) writes nothing. The same plan/execute logic is exposed in the UI (Settings → Advanced
editing → Author merge) via `POST /api/producers/merge/plan` and `POST /api/producers/merge`. See `import-and-source.md`
for the author/dictionary rules and `http-api.md` for the route contract.

## 5. Sites, work ids, and update cursors

A site_probe export folder is deleted once its works are in, so nothing on disk remembers what a folder or author
already contained. The library remembers instead, in two tables from `021_site_crawl_state.sql`:

- **`site_works`** — one row per `(site, workId)` pointing at the Entry it became. This is the "have we already ingested
  hitomi work 3220586?" map. It lets a later run skip works whose export file no longer exists, and survives the source
  re-spelling its own URLs.
- **`site_crawl_sources`** — one row per crawled listing (`artist`, `folder`, `work`, or `search`), carrying
  `last_seen_source_id` / `last_seen_work_date` / `last_seen_order_key`: the newest work already held for that listing.

Work identity is **global per site** while the cursor is **per listing**, because one work legitimately arrives from
several listings. Neither table joins the sync allowlist: they describe the local crawl, not the curated library.

Cursor order is a single comparable string built from `(workDate, id)`: the source's published date (when it has one),
padded numeric ids so `9` sorts before `10`. It only ever moves forward, so a re-crawl returning nothing new, or an
older page fetched out of order, cannot pull it back. An undated work sorts before every dated work, so an undated row
can never advance a cursor past real dated works; a listing that mixes the two falls back to exact membership. The
crawler reads/reports this through `pnpm import:cursor` (see `http-api.md` and `import-and-source.md`).

## 6. Backup and restore

Whole-library snapshots live under `<dataDir>/backups/` (dataDir = the folder holding `library.db`, i.e.
`apps/server/.data`). Each backup is a **self-contained directory** `backup-<yyyyMMddTHHmmssZ>/` containing:

- a consistent `library.db` snapshot (better-sqlite3 backup API, WAL-safe, read from a read-only connection),
- a copy of the `assets/` media tree,
- a `manifest.json` (createdAt, source database, entry/producer counts counted from the snapshot itself).

- `pnpm db:backup [databasePath]` — create a backup (default `.data/library.db`). Prints the backup directory and counts.
- `pnpm db:restore <backupDir> [databasePath]` — restore. **Gate 1**: the backup must open and pass `db:doctor` (a
  corrupt/non-SQLite backup is refused before anything is touched). Then the CURRENT library is snapshotted first
  (`backups/restore-prestore-<ts>/`, best effort — restoring over a corrupt library is the point, so a failed
  self-snapshot warns but continues). The swap renames the live `library.db` (+`-wal`/`-shm`) and `assets/` aside, copies
  the backup in, and **Gate 3** re-runs `db:doctor` on the restored database. A live connection (running T3 server) holds
  the files, so the rename fails with a clear "exit the tray / close T3.bat first" error instead of a silent partial
  overwrite.

Stop the T3 server before restoring. The pre-restore snapshot plus any renamed-aside `.restore-prestore-*` files are the
rollback path. Legacy single-file snapshots (`library.db.merge-backup-*` etc.) are **not** restorable through this tool —
only full backup directories (they lack the assets tree).

The UI-level backup/restore (Desktop System page) is a **staged** restore: the upload is validated read-only as a real
T³ library, kept in `<dataDir>/restore-staged/`, and applied by `applyStagedRestore` at the next start **before** the
database is opened, which first copies the library it replaces into `backups/`. See `offline-sync.md` §System page.

## 7. Data-safety invariants (durable)

- Tests never touch the real library; use isolated in-memory / temp-file databases.
- Cleanup that destroys data belongs to the **commit** (the operation's landing proof), never to the queue — cancelling
  a queued operation must not destroy data.
- Never restore a large dirty file from HEAD without proving no uncommitted work would be lost.
- The live server applies outstanding migrations on a `/api/sync/capabilities` poll **without a restart**, while the
  running process keeps its pre-change request schemas until restarted. Don't restart it yourself.
