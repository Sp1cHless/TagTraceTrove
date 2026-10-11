-- A client-assigned online Entry UID must prove its original create request before
-- an offline replay can adopt it. Legacy creates without that UID have no claim.
-- This table is separate from sync_offline_created_entries, which grants media
-- staging only after an actual applied offline create receipt exists.
CREATE TABLE sync_online_entry_creates (
  entry_uid TEXT PRIMARY KEY REFERENCES entries(sync_uid) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  entry_version INTEGER NOT NULL CHECK (entry_version > 0),
  adopted_op_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
