# Database development boundary

SQLite is accessed only by the local backend through explicit SQL and `better-sqlite3`; no ORM or frontend database access.

Every connection applies:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

`:memory:` databases cannot persist WAL and therefore report `journal_mode=memory`; temporary file databases verify WAL behavior.

## Test strategy

- `createMemoryDatabase()` — fast integration tests with real SQLite.
- `createTempFileDatabase()` — disposable DB for WAL and file-level behavior.
- `applyAllMigrations(database)` — applies immutable migrations and validates stored SHA-256 checksums. Hash comparison treats LF and CRLF as equivalent so a Windows Git checkout cannot invalidate an already-applied migration; SQL changes still fail the checksum gate.
- `createMigratedMemoryDatabase()` — isolated real-SQL schema tests.
- `runDatabaseProbe()` — seeds and verifies the current Entry/Producer/Facet scenario.

Tests must start from a known schema version and must not touch `.data/library.db`.

## Derived Source library and Entry merge

Source ownership remains in `entry_contents`. The Source library parses every
HTTP(S) URL from every Content body at read time and groups known sites by a
stable `known:<site>` key, with `host:<hostname>` fallback for unregistered
sites. This keeps a
URL entered manually in any Content type immediately discoverable without a
dual-write table, migration, or repair job. Server-side callers can derive the
Entry IDs for one Source key for future site-wide maintenance operations; the
projection remains server-side until a future bounded Source-management API is needed.

Merging two works is also schema-neutral. One repository transaction validates
same Author and same Gallery, inserts missing `entry_tags`, appends selected
absorbed-Entry URLs as `Source URL` Content, and deletes the absorbed Entry.
Any failed validation or write rolls back Tags, Content, and deletion together.
Other Content, media, Ratings, usage, Directory, Collection, and View later
memberships from the absorbed Entry are deliberately not copied.

## Schema workflow

Schema changes are reviewed SQL migrations. Applied migrations are immutable and checksummed. Database-backed behavior progresses migration → probe → repository integration test → doctor → API → UI.

The current tables and invariants are documented in `current-architecture.md`. `pnpm db:doctor [path]` opens a provided database read-only; without a path it verifies a disposable migrated database. All later migrations follow the same workflow and are included naturally in backups, WAL behavior, and restore swaps:

- `006_rating_slots.sql` — shared rating slots per subject kind + Gallery, and the two value tables.
- `007_entry_usage.sql` — `entry_usage` (lazy per-Entry view counter + last-viewed timestamp, FK CASCADE).
- `008_entry_likes.sql` — adds `like_count` to `entry_usage` (unlimited, re-clickable).
- `009_gallery_partitions.sql` — `gallery_settings` (per Entry type SFW/NSFW flag, default SFW).
- `010_collections.sql` — `collections` (entry/producer kinds, one-level nesting for entry folders, title/description/nsfw/sort order) plus `collection_entries` / `collection_producers` member tables.
- `011_view_later.sql` — one library-wide ordered `view_later_entries` membership list; Entry FK uses `ON DELETE CASCADE`, add/remove are idempotent, and position is preserved across desktop/mobile clients.
- `012_view_later_producers.sql` — an independent ordered `view_later_producers` list for Authors, with unique membership and `ON DELETE CASCADE` cleanup when its Producer is deleted.
- `013_entry_page_indexes.sql` — covering `(type, upload_date, id)` and
  `(type, title COLLATE NOCASE, id)` indexes for deterministic Gallery pages.
  `db:doctor` treats both as required schema objects. Migration tests cover a
  populated temporary-file 12→13 upgrade and prove data/integrity preservation.


## Backup and restore

Whole-library snapshots live under `<dataDir>/backups/` (dataDir = the folder holding `library.db`, i.e. `apps/server/.data`). Each backup is a self-contained directory `backup-<yyyyMMddTHHmmssZ>/` containing a consistent `library.db` snapshot (better-sqlite3 backup API, WAL-safe, read from a read-only connection), a copy of the `assets/` media tree, and a `manifest.json` (createdAt, source database, entry/producer counts counted from the snapshot itself).

- `pnpm db:backup [databasePath]` — create a backup (default database `.data/library.db` relative to the server package, same as the dev server). Prints the backup directory and counts.
- `pnpm db:restore <backupDir> [databasePath]` — restore. Gate 1: the backup must open and pass `db:doctor` (a corrupt/non-SQLite backup is refused before anything is touched). Then the CURRENT library is snapshotted first (`backups/restore-prestore-<ts>/`, best effort — restoring over a corrupt library is the point, so a failed self-snapshot warns but continues). The swap renames the live `library.db` (+`-wal`/`-shm`) and `assets/` aside, copies the backup in, and Gate 3 re-runs `db:doctor` on the restored database. A live connection (running T3 server) holds the files, so the rename fails with a clear "exit the tray / close T3.bat first" error instead of a silent partial overwrite.

Stop the T3 server before restoring. The pre-restore snapshot plus any renamed-aside `.restore-prestore-*` files are the rollback path. Legacy single-file snapshots (`library.db.merge-backup-*` etc.) are not restorable through this tool — only full backup directories (they lack the assets tree).
