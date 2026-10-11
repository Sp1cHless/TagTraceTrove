-- C3 media staging is intentionally limited to Entries created by offline
-- entry.create replay. Register that origin in the same transaction as the
-- create operation receipt so the media endpoint cannot mutate existing Entries.
CREATE TABLE sync_offline_created_entries (
  entry_uid TEXT PRIMARY KEY
    REFERENCES entries(sync_uid) ON DELETE CASCADE,
  create_op_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
