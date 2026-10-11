-- C2 synchronization foundation. Numeric IDs remain the local SQLite identity;
-- sync_uid is the immutable transport identity for the first writable resource
-- allowlist (Entries and Entry Contents). Existing rows are backfilled before
-- journal triggers are created, so a migration never invents historical changes.

ALTER TABLE entries ADD COLUMN sync_uid TEXT
  CHECK (
    sync_uid IS NULL OR (
      length(sync_uid) = 36 AND
      substr(sync_uid, 9, 1) = '-' AND
      substr(sync_uid, 14, 1) = '-' AND
      substr(sync_uid, 19, 1) = '-' AND
      substr(sync_uid, 24, 1) = '-'
    )
  );
ALTER TABLE entries ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 1
  CHECK (sync_version >= 1);

ALTER TABLE entry_contents ADD COLUMN sync_uid TEXT
  CHECK (
    sync_uid IS NULL OR (
      length(sync_uid) = 36 AND
      substr(sync_uid, 9, 1) = '-' AND
      substr(sync_uid, 14, 1) = '-' AND
      substr(sync_uid, 19, 1) = '-' AND
      substr(sync_uid, 24, 1) = '-'
    )
  );
ALTER TABLE entry_contents ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 1
  CHECK (sync_version >= 1);

UPDATE entries
SET sync_uid =
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + abs(random()) % 4, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE sync_uid IS NULL;

UPDATE entry_contents
SET sync_uid =
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + abs(random()) % 4, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE sync_uid IS NULL;

CREATE UNIQUE INDEX uq_entries_sync_uid ON entries(sync_uid);
CREATE UNIQUE INDEX uq_entry_contents_sync_uid ON entry_contents(sync_uid);

CREATE TABLE sync_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('entry', 'entry_content')),
  entity_uid TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('create', 'update', 'delete')),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json)),
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sync_changes_entity
ON sync_changes(entity_kind, entity_uid, seq);

CREATE TABLE sync_tombstones (
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('entry', 'entry_content')),
  entity_uid TEXT NOT NULL,
  deleted_version INTEGER NOT NULL CHECK (deleted_version >= 1),
  change_seq INTEGER NOT NULL UNIQUE,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_kind, entity_uid),
  FOREIGN KEY (change_seq) REFERENCES sync_changes(seq) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE sync_operation_receipts (
  op_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  server_seq INTEGER CHECK (server_seq IS NULL OR server_seq >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sync_operation_receipts_created
ON sync_operation_receipts(created_at, op_id);

-- New rows may omit sync_uid in existing online repositories. Fill it in the
-- same statement transaction, then journal the resulting canonical resource.
CREATE TRIGGER entries_sync_insert
AFTER INSERT ON entries
BEGIN
  UPDATE entries
  SET sync_uid = COALESCE(
    NEW.sync_uid,
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  )
  WHERE id = NEW.id;

  INSERT INTO sync_changes (
    entity_kind, entity_uid, change_kind, resource_version, record_json
  )
  SELECT
    'entry', sync_uid, 'create', sync_version,
    json_object(
      'id', id,
      'syncUid', sync_uid,
      'syncVersion', sync_version,
      'title', title,
      'type', type,
      'coverRef', cover_ref,
      'previewRef', preview_ref,
      'previewRefsJson', preview_refs,
      'pageCount', page_count,
      'uploadDate', upload_date,
      'createdAt', created_at,
      'updatedAt', updated_at
    )
  FROM entries WHERE id = NEW.id;
END;

CREATE TRIGGER entries_sync_update
AFTER UPDATE OF
  title, type, cover_ref, preview_ref, preview_refs, page_count,
  upload_date, created_at, updated_at
ON entries
BEGIN
  UPDATE entries
  SET sync_version = OLD.sync_version + 1
  WHERE id = NEW.id;

  INSERT INTO sync_changes (
    entity_kind, entity_uid, change_kind, resource_version, record_json
  )
  SELECT
    'entry', sync_uid, 'update', sync_version,
    json_object(
      'id', id,
      'syncUid', sync_uid,
      'syncVersion', sync_version,
      'title', title,
      'type', type,
      'coverRef', cover_ref,
      'previewRef', preview_ref,
      'previewRefsJson', preview_refs,
      'pageCount', page_count,
      'uploadDate', upload_date,
      'createdAt', created_at,
      'updatedAt', updated_at
    )
  FROM entries WHERE id = NEW.id;
END;

CREATE TRIGGER entries_sync_delete
AFTER DELETE ON entries
BEGIN
  INSERT INTO sync_changes (
    entity_kind, entity_uid, change_kind, resource_version, record_json
  ) VALUES ('entry', OLD.sync_uid, 'delete', OLD.sync_version + 1, NULL);

  INSERT INTO sync_tombstones (
    entity_kind, entity_uid, deleted_version, change_seq
  ) VALUES ('entry', OLD.sync_uid, OLD.sync_version + 1, last_insert_rowid());
END;

CREATE TRIGGER entries_sync_uid_immutable
BEFORE UPDATE OF sync_uid ON entries
WHEN OLD.sync_uid IS NOT NULL AND NEW.sync_uid IS NOT OLD.sync_uid
BEGIN
  SELECT RAISE(ABORT, 'entry sync_uid is immutable');
END;

CREATE TRIGGER entry_contents_sync_insert
AFTER INSERT ON entry_contents
BEGIN
  UPDATE entry_contents
  SET sync_uid = COALESCE(
    NEW.sync_uid,
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  )
  WHERE id = NEW.id;

  INSERT INTO sync_changes (
    entity_kind, entity_uid, change_kind, resource_version, record_json
  )
  SELECT
    'entry_content', sync_uid, 'create', sync_version,
    json_object(
      'id', id,
      'entryId', entry_id,
      'syncUid', sync_uid,
      'syncVersion', sync_version,
      'contentType', content_type,
      'content', content,
      'sortOrder', sort_order,
      'createdAt', created_at,
      'updatedAt', updated_at
    )
  FROM entry_contents WHERE id = NEW.id;
END;

CREATE TRIGGER entry_contents_sync_update
AFTER UPDATE OF
  entry_id, content_type, content, sort_order, created_at, updated_at
ON entry_contents
BEGIN
  UPDATE entry_contents
  SET sync_version = OLD.sync_version + 1
  WHERE id = NEW.id;

  INSERT INTO sync_changes (
    entity_kind, entity_uid, change_kind, resource_version, record_json
  )
  SELECT
    'entry_content', sync_uid, 'update', sync_version,
    json_object(
      'id', id,
      'entryId', entry_id,
      'syncUid', sync_uid,
      'syncVersion', sync_version,
      'contentType', content_type,
      'content', content,
      'sortOrder', sort_order,
      'createdAt', created_at,
      'updatedAt', updated_at
    )
  FROM entry_contents WHERE id = NEW.id;
END;

CREATE TRIGGER entry_contents_sync_delete
AFTER DELETE ON entry_contents
BEGIN
  INSERT INTO sync_changes (
    entity_kind, entity_uid, change_kind, resource_version, record_json
  ) VALUES (
    'entry_content', OLD.sync_uid, 'delete', OLD.sync_version + 1, NULL
  );

  INSERT INTO sync_tombstones (
    entity_kind, entity_uid, deleted_version, change_seq
  ) VALUES (
    'entry_content', OLD.sync_uid, OLD.sync_version + 1, last_insert_rowid()
  );
END;

CREATE TRIGGER entry_contents_sync_uid_immutable
BEFORE UPDATE OF sync_uid ON entry_contents
WHEN OLD.sync_uid IS NOT NULL AND NEW.sync_uid IS NOT OLD.sync_uid
BEGIN
  SELECT RAISE(ABORT, 'entry content sync_uid is immutable');
END;
