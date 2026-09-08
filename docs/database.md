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
- `applyAllMigrations(database)` — applies immutable migrations and validates stored SHA-256 checksums.
- `createMigratedMemoryDatabase()` — isolated real-SQL schema tests.
- `runDatabaseProbe()` — seeds and verifies the current Entry/Producer/Facet scenario.

Tests must start from a known schema version and must not touch `.data/library.db`.

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

## Backup and restore

Whole-library snapshots live under `<dataDir>/backups/` (dataDir = the folder holding `library.db`, i.e. `apps/server/.data`). Each backup is a self-contained directory `backup-<yyyyMMddTHHmmssZ>/` containing a consistent `library.db` snapshot (better-sqlite3 backup API, WAL-safe, read from a read-only connection), a copy of the `assets/` media tree, and a `manifest.json` (createdAt, source database, entry/producer counts counted from the snapshot itself).

- `pnpm db:backup [databasePath]` — create a backup (default database `.data/library.db` relative to the server package, same as the dev server). Prints the backup directory and counts.
- `pnpm db:restore <backupDir> [databasePath]` — restore. Gate 1: the backup must open and pass `db:doctor` (a corrupt/non-SQLite backup is refused before anything is touched). Then the CURRENT library is snapshotted first (`backups/restore-prestore-<ts>/`, best effort — restoring over a corrupt library is the point, so a failed self-snapshot warns but continues). The swap renames the live `library.db` (+`-wal`/`-shm`) and `assets/` aside, copies the backup in, and Gate 3 re-runs `db:doctor` on the restored database. A live connection (running T3 server) holds the files, so the rename fails with a clear "exit the tray / close T3.bat first" error instead of a silent partial overwrite.

Stop the T3 server before restoring. The pre-restore snapshot plus any renamed-aside `.restore-prestore-*` files are the rollback path. Legacy single-file snapshots (`library.db.merge-backup-*` etc.) are not restorable through this tool — only full backup directories (they lack the assets tree).
