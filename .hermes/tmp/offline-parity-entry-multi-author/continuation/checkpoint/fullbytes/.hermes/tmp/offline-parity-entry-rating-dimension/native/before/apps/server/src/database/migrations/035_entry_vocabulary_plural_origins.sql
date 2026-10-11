-- Distinct immutable creation envelopes may converge on one canonical entity.
-- Keep creation UUID/op identity and scope; only numeric entity uniqueness changes.
CREATE TABLE sync_offline_created_entry_tags_next (
  tag_uid TEXT PRIMARY KEY,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  create_op_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  sync_epoch TEXT NOT NULL
) WITHOUT ROWID;

INSERT INTO sync_offline_created_entry_tags_next
  (tag_uid, tag_id, create_op_id, client_id, library_id, sync_epoch)
SELECT tag_uid, tag_id, create_op_id, client_id, library_id, sync_epoch
FROM sync_offline_created_entry_tags;
DROP TABLE sync_offline_created_entry_tags;
ALTER TABLE sync_offline_created_entry_tags_next RENAME TO sync_offline_created_entry_tags;
CREATE INDEX idx_sync_offline_created_entry_tags_tag_id
ON sync_offline_created_entry_tags(tag_id);

CREATE TABLE sync_offline_created_entry_facets_next (
  facet_uid TEXT PRIMARY KEY,
  facet_id INTEGER NOT NULL REFERENCES tag_groups(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL,
  create_op_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  sync_epoch TEXT NOT NULL
) WITHOUT ROWID;

INSERT INTO sync_offline_created_entry_facets_next
  (facet_uid, facet_id, entry_type, create_op_id, client_id, library_id, sync_epoch)
SELECT facet_uid, facet_id, entry_type, create_op_id, client_id, library_id, sync_epoch
FROM sync_offline_created_entry_facets;
DROP TABLE sync_offline_created_entry_facets;
ALTER TABLE sync_offline_created_entry_facets_next RENAME TO sync_offline_created_entry_facets;
CREATE INDEX idx_sync_offline_created_entry_facets_facet_id
ON sync_offline_created_entry_facets(facet_id);
