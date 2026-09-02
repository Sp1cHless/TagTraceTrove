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

The current tables and invariants are documented in `current-architecture.md`. `pnpm db:doctor [path]` opens a provided database read-only; without a path it verifies a disposable migrated database.
