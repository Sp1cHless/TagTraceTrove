-- Per-client durable progress. A served bound is recorded before acknowledging;
-- journal entries and tombstones are never pruned by acknowledgement.
CREATE TABLE sync_feed_cursors (
  library_id TEXT NOT NULL,
  sync_epoch TEXT NOT NULL,
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 200),
  ack_seq INTEGER NOT NULL DEFAULT 0 CHECK (ack_seq >= 0),
  served_seq INTEGER NOT NULL DEFAULT 0 CHECK (served_seq >= ack_seq),
  PRIMARY KEY (library_id, sync_epoch, client_id)
) WITHOUT ROWID;
