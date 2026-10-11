-- Add immutable transport identity and revision tracking for Authors. Expand the
-- journal's entity allowlist by rebuilding both journal tables so existing rows,
-- tombstones, sequence numbers, and their FK relationship are preserved.
ALTER TABLE producers ADD COLUMN sync_uid TEXT
  CHECK (
    sync_uid IS NULL OR (
      length(sync_uid) = 36 AND
      substr(sync_uid, 9, 1) = '-' AND
      substr(sync_uid, 14, 1) = '-' AND
      substr(sync_uid, 19, 1) = '-' AND
      substr(sync_uid, 24, 1) = '-'
    )
  );
ALTER TABLE producers ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 1
  CHECK (sync_version >= 1);

UPDATE producers
SET sync_uid =
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + abs(random()) % 4, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE sync_uid IS NULL;
CREATE UNIQUE INDEX uq_producers_sync_uid ON producers(sync_uid);

-- SQLite validates persistent triggers when a referenced table is dropped, so
-- temporarily remove and restore the existing journal triggers around rebuild.
DROP TRIGGER entries_sync_insert;
DROP TRIGGER entries_sync_update;
DROP TRIGGER entries_sync_delete;
DROP TRIGGER entry_contents_sync_insert;
DROP TRIGGER entry_contents_sync_update;
DROP TRIGGER entry_contents_sync_delete;

CREATE TEMP TABLE sync_changes_sequence_v25 (seq INTEGER NOT NULL);
INSERT INTO sync_changes_sequence_v25 (seq)
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'sync_changes'), 0);

CREATE TABLE sync_changes_v25 (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('entry', 'entry_content', 'producer')),
  entity_uid TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('create', 'update', 'delete')),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json)),
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO sync_changes_v25 (seq, entity_kind, entity_uid, change_kind, resource_version, record_json, changed_at)
SELECT seq, entity_kind, entity_uid, change_kind, resource_version, record_json, changed_at
FROM sync_changes ORDER BY seq;

CREATE TABLE sync_tombstones_v25 (
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('entry', 'entry_content', 'producer')),
  entity_uid TEXT NOT NULL,
  deleted_version INTEGER NOT NULL CHECK (deleted_version >= 1),
  change_seq INTEGER NOT NULL UNIQUE,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_kind, entity_uid),
  FOREIGN KEY (change_seq) REFERENCES sync_changes_v25(seq) ON DELETE RESTRICT
) WITHOUT ROWID;
INSERT INTO sync_tombstones_v25 (entity_kind, entity_uid, deleted_version, change_seq, deleted_at)
SELECT entity_kind, entity_uid, deleted_version, change_seq, deleted_at
FROM sync_tombstones;

DROP TABLE sync_tombstones;
DROP TABLE sync_changes;
ALTER TABLE sync_changes_v25 RENAME TO sync_changes;
ALTER TABLE sync_tombstones_v25 RENAME TO sync_tombstones;
CREATE INDEX idx_sync_changes_entity ON sync_changes(entity_kind, entity_uid, seq);
UPDATE sqlite_sequence
SET seq = MAX(seq, (SELECT seq FROM sync_changes_sequence_v25))
WHERE name = 'sync_changes';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'sync_changes', seq FROM sync_changes_sequence_v25
WHERE seq > 0 AND NOT EXISTS (
  SELECT 1 FROM sqlite_sequence WHERE name = 'sync_changes'
);
DROP TABLE sync_changes_sequence_v25;

CREATE TRIGGER entries_sync_insert
AFTER INSERT ON entries
BEGIN
  UPDATE entries SET sync_uid = COALESCE(NEW.sync_uid,
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
  ) WHERE id = NEW.id;
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'entry', sync_uid, 'create', sync_version,
    json_object('id', id, 'syncUid', sync_uid, 'syncVersion', sync_version,
      'title', title, 'type', type, 'coverRef', cover_ref, 'previewRef', preview_ref,
      'previewRefsJson', preview_refs, 'pageCount', page_count, 'uploadDate', upload_date,
      'createdAt', created_at, 'updatedAt', updated_at)
  FROM entries WHERE id = NEW.id;
END;

CREATE TRIGGER entries_sync_update
AFTER UPDATE OF title, type, cover_ref, preview_ref, preview_refs, page_count, upload_date, created_at, updated_at ON entries
BEGIN
  UPDATE entries SET sync_version = OLD.sync_version + 1 WHERE id = NEW.id;
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'entry', sync_uid, 'update', sync_version,
    json_object('id', id, 'syncUid', sync_uid, 'syncVersion', sync_version,
      'title', title, 'type', type, 'coverRef', cover_ref, 'previewRef', preview_ref,
      'previewRefsJson', preview_refs, 'pageCount', page_count, 'uploadDate', upload_date,
      'createdAt', created_at, 'updatedAt', updated_at)
  FROM entries WHERE id = NEW.id;
END;

CREATE TRIGGER entries_sync_delete
AFTER DELETE ON entries
BEGIN
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  VALUES ('entry', OLD.sync_uid, 'delete', OLD.sync_version + 1, NULL);
  INSERT INTO sync_tombstones (entity_kind, entity_uid, deleted_version, change_seq)
  VALUES ('entry', OLD.sync_uid, OLD.sync_version + 1, last_insert_rowid());
END;

CREATE TRIGGER entry_contents_sync_insert
AFTER INSERT ON entry_contents
BEGIN
  UPDATE entry_contents SET sync_uid = COALESCE(NEW.sync_uid,
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
  ) WHERE id = NEW.id;
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'entry_content', sync_uid, 'create', sync_version,
    json_object('id', id, 'entryId', entry_id, 'syncUid', sync_uid, 'syncVersion', sync_version,
      'contentType', content_type, 'content', content, 'sortOrder', sort_order,
      'createdAt', created_at, 'updatedAt', updated_at)
  FROM entry_contents WHERE id = NEW.id;
END;

CREATE TRIGGER entry_contents_sync_update
AFTER UPDATE OF entry_id, content_type, content, sort_order, created_at, updated_at ON entry_contents
BEGIN
  UPDATE entry_contents SET sync_version = OLD.sync_version + 1 WHERE id = NEW.id;
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'entry_content', sync_uid, 'update', sync_version,
    json_object('id', id, 'entryId', entry_id, 'syncUid', sync_uid, 'syncVersion', sync_version,
      'contentType', content_type, 'content', content, 'sortOrder', sort_order,
      'createdAt', created_at, 'updatedAt', updated_at)
  FROM entry_contents WHERE id = NEW.id;
END;

CREATE TRIGGER entry_contents_sync_delete
AFTER DELETE ON entry_contents
BEGIN
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  VALUES ('entry_content', OLD.sync_uid, 'delete', OLD.sync_version + 1, NULL);
  INSERT INTO sync_tombstones (entity_kind, entity_uid, deleted_version, change_seq)
  VALUES ('entry_content', OLD.sync_uid, OLD.sync_version + 1, last_insert_rowid());
END;

CREATE TRIGGER producers_sync_insert
AFTER INSERT ON producers
BEGIN
  UPDATE producers
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

  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'producer', sync_uid, 'create', sync_version,
         json_object('id', id, 'syncUid', sync_uid, 'syncVersion', sync_version,
                     'name', name, 'occupation', occupation, 'artworkRef', artwork_ref, 'content', content)
  FROM producers WHERE id = NEW.id;
END;

CREATE TRIGGER producers_sync_update
AFTER UPDATE OF name, occupation, artwork_ref, content, updated_at ON producers
BEGIN
  UPDATE producers SET sync_version = OLD.sync_version + 1 WHERE id = NEW.id;
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'producer', sync_uid, 'update', sync_version,
         json_object('id', id, 'syncUid', sync_uid, 'syncVersion', sync_version,
                     'name', name, 'occupation', occupation, 'artworkRef', artwork_ref, 'content', content)
  FROM producers WHERE id = NEW.id;
END;

CREATE TRIGGER producers_sync_delete
AFTER DELETE ON producers
BEGIN
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  VALUES ('producer', OLD.sync_uid, 'delete', OLD.sync_version + 1, NULL);
  INSERT INTO sync_tombstones (entity_kind, entity_uid, deleted_version, change_seq)
  VALUES ('producer', OLD.sync_uid, OLD.sync_version + 1, last_insert_rowid());
END;

CREATE TRIGGER producers_sync_uid_immutable
BEFORE UPDATE OF sync_uid ON producers
WHEN OLD.sync_uid IS NOT NULL AND NEW.sync_uid IS NOT OLD.sync_uid
BEGIN
  SELECT RAISE(ABORT, 'producer sync_uid is immutable');
END;

-- The membership is part of the Producer resource's revision. Updating
-- updated_at invokes the normal producer journal trigger in the same transaction.
CREATE TRIGGER view_later_producers_sync_insert
AFTER INSERT ON view_later_producers
BEGIN
  UPDATE producers SET updated_at = updated_at WHERE id = NEW.producer_id;
END;
CREATE TRIGGER view_later_producers_sync_delete
AFTER DELETE ON view_later_producers
BEGIN
  UPDATE producers SET updated_at = updated_at WHERE id = OLD.producer_id;
END;
