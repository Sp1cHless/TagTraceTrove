-- Causal identity registry. Receipts contain numeric results, not entity kinds.
CREATE TABLE sync_offline_created_producers (
 producer_uid TEXT PRIMARY KEY,
 producer_id INTEGER NOT NULL,
 create_op_id TEXT NOT NULL UNIQUE,
 client_id TEXT NOT NULL,
 library_id TEXT NOT NULL,
 sync_epoch TEXT NOT NULL
) WITHOUT ROWID;
