-- Sync identity (plan §25.1, needed by the C1 capabilities endpoint). The
-- table stays empty here: the server lazily seeds row 1 with a fresh random
-- libraryId on first access, keeping this migration deterministic. Backup
-- restores rotate `sync_epoch` (never library_id) so change sequences from a
-- restore point can never be confused with the live one.

CREATE TABLE sync_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  library_id TEXT NOT NULL,
  sync_epoch TEXT NOT NULL,
  snapshot_seq INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_seq >= 0),
  protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version >= 1),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
