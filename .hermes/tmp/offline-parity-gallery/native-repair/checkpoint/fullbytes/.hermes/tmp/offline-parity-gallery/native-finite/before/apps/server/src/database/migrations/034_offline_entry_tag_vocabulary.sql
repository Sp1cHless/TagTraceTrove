-- Stable Entry Tag / Section / Facet transport identity and shared per-type
-- layout revision. Numeric IDs remain the SQLite/UI join identity.

ALTER TABLE tags ADD COLUMN sync_uid TEXT;
ALTER TABLE tag_groups ADD COLUMN sync_uid TEXT;

UPDATE tags SET sync_uid =
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + abs(random()) % 4, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
WHERE sync_uid IS NULL;

UPDATE tag_groups SET sync_uid =
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + abs(random()) % 4, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
WHERE sync_uid IS NULL;

CREATE UNIQUE INDEX uq_tags_sync_uid ON tags(sync_uid);
CREATE UNIQUE INDEX uq_tag_groups_sync_uid ON tag_groups(sync_uid);

CREATE TABLE entry_tag_layouts (
  entry_type TEXT PRIMARY KEY CHECK (trim(entry_type) <> ''),
  sync_uid TEXT NOT NULL UNIQUE,
  sync_version INTEGER NOT NULL DEFAULT 1 CHECK (sync_version >= 1),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO entry_tag_layouts (entry_type, sync_uid)
SELECT entry_type,
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + abs(random()) % 4, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
FROM (
  SELECT DISTINCT entry_type FROM tag_groups
  UNION
  SELECT DISTINCT type AS entry_type FROM entries
)
WHERE trim(entry_type) <> '';

CREATE TABLE sync_offline_created_entry_tags (
  tag_uid TEXT PRIMARY KEY,
  tag_id INTEGER NOT NULL UNIQUE REFERENCES tags(id) ON DELETE CASCADE,
  create_op_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  sync_epoch TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE sync_offline_created_entry_facets (
  facet_uid TEXT PRIMARY KEY,
  facet_id INTEGER NOT NULL UNIQUE REFERENCES tag_groups(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL,
  create_op_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  sync_epoch TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE sync_entry_taxonomy_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('entry_tag', 'entry_tag_layout')),
  resource_uid TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('create', 'update', 'delete')),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json)),
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sync_entry_taxonomy_changes_resource
ON sync_entry_taxonomy_changes(resource_kind, resource_uid, seq);

CREATE TRIGGER tags_sync_identity_insert
AFTER INSERT ON tags
BEGIN
  UPDATE tags SET sync_uid = COALESCE(NEW.sync_uid,
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
  ) WHERE id = NEW.id;

  INSERT INTO sync_entry_taxonomy_changes (
    resource_kind, resource_uid, change_kind, resource_version, record_json
  )
  SELECT 'entry_tag', sync_uid, 'create', 1,
    json_object('id', id, 'syncUid', sync_uid, 'name', name, 'normalizedName', normalized_name)
  FROM tags WHERE id = NEW.id;
END;

CREATE TRIGGER tags_sync_uid_immutable
BEFORE UPDATE OF sync_uid ON tags
WHEN OLD.sync_uid IS NOT NULL AND NEW.sync_uid IS NOT OLD.sync_uid
BEGIN
  SELECT RAISE(ABORT, 'entry tag sync_uid is immutable');
END;

CREATE TRIGGER tags_sync_update
AFTER UPDATE OF name, normalized_name ON tags
BEGIN
  INSERT INTO sync_entry_taxonomy_changes (
    resource_kind, resource_uid, change_kind, resource_version, record_json
  ) VALUES (
    'entry_tag', NEW.sync_uid, 'update', 1,
    json_object('id', NEW.id, 'syncUid', NEW.sync_uid, 'name', NEW.name, 'normalizedName', NEW.normalized_name)
  );
END;

CREATE TRIGGER tags_sync_delete
AFTER DELETE ON tags
BEGIN
  INSERT INTO sync_entry_taxonomy_changes (
    resource_kind, resource_uid, change_kind, resource_version, record_json
  ) VALUES ('entry_tag', OLD.sync_uid, 'delete', 1, NULL);
END;

CREATE TRIGGER tag_groups_sync_identity_layout_insert
AFTER INSERT ON tag_groups
BEGIN
  UPDATE tag_groups SET sync_uid = COALESCE(NEW.sync_uid,
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
  ) WHERE id = NEW.id;

  INSERT OR IGNORE INTO entry_tag_layouts (entry_type, sync_uid)
  VALUES (NEW.entry_type,
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
  );

  UPDATE entry_tag_layouts
  SET sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE entry_type = NEW.entry_type;

  INSERT INTO sync_entry_taxonomy_changes (
    resource_kind, resource_uid, change_kind, resource_version, record_json
  )
  SELECT 'entry_tag_layout', layout.sync_uid, 'update', layout.sync_version,
    json_object('entryType', layout.entry_type, 'syncUid', layout.sync_uid,
      'syncVersion', layout.sync_version)
  FROM entry_tag_layouts AS layout WHERE layout.entry_type = NEW.entry_type;
END;

CREATE TRIGGER tag_groups_sync_uid_immutable
BEFORE UPDATE OF sync_uid ON tag_groups
WHEN OLD.sync_uid IS NOT NULL AND NEW.sync_uid IS NOT OLD.sync_uid
BEGIN
  SELECT RAISE(ABORT, 'tag group sync_uid is immutable');
END;

CREATE TRIGGER tag_groups_sync_layout_update
AFTER UPDATE OF entry_type, name, group_kind, parent_id, sort_order ON tag_groups
BEGIN
  UPDATE entry_tag_layouts
  SET sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE entry_type = OLD.entry_type;

  INSERT OR IGNORE INTO entry_tag_layouts (entry_type, sync_uid)
  VALUES (NEW.entry_type,
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
  );

  UPDATE entry_tag_layouts
  SET sync_version = sync_version + CASE WHEN NEW.entry_type = OLD.entry_type THEN 0 ELSE 1 END,
      updated_at = CURRENT_TIMESTAMP
  WHERE entry_type = NEW.entry_type;

  INSERT INTO sync_entry_taxonomy_changes (
    resource_kind, resource_uid, change_kind, resource_version, record_json
  )
  SELECT 'entry_tag_layout', layout.sync_uid, 'update', layout.sync_version,
    json_object('entryType', layout.entry_type, 'syncUid', layout.sync_uid,
      'syncVersion', layout.sync_version)
  FROM entry_tag_layouts AS layout
  WHERE layout.entry_type IN (OLD.entry_type, NEW.entry_type);
END;

CREATE TRIGGER tag_groups_sync_layout_delete
AFTER DELETE ON tag_groups
BEGIN
  UPDATE entry_tag_layouts
  SET sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE entry_type = OLD.entry_type;

  INSERT INTO sync_entry_taxonomy_changes (
    resource_kind, resource_uid, change_kind, resource_version, record_json
  )
  SELECT 'entry_tag_layout', layout.sync_uid, 'update', layout.sync_version,
    json_object('entryType', layout.entry_type, 'syncUid', layout.sync_uid,
      'syncVersion', layout.sync_version)
  FROM entry_tag_layouts AS layout WHERE layout.entry_type = OLD.entry_type;
END;
