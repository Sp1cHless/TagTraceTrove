-- C3 idempotent media upload receipts. Media bytes remain filesystem-backed;
-- this table records the durable identity/result needed to retry a lost HTTP
-- response without appending or replacing media a second time.
CREATE TABLE sync_media_upload_receipts (
  upload_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  server_seq INTEGER NOT NULL CHECK (server_seq >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sync_media_upload_receipts_created
ON sync_media_upload_receipts(created_at, upload_id);
