-- Add Collection and shared rating-layout resources, stable Directory UIDs,
-- and Producer revision journaling for directory metadata/membership. Expand
-- journal kinds while preserving every prior sequence number and tombstone.

ALTER TABLE collections ADD COLUMN sync_uid TEXT
  CHECK (
    sync_uid IS NULL OR (
      length(sync_uid) = 36 AND substr(sync_uid, 9, 1) = '-' AND
      substr(sync_uid, 14, 1) = '-' AND substr(sync_uid, 19, 1) = '-' AND
      substr(sync_uid, 24, 1) = '-'
    )
  );
ALTER TABLE collections ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 1
  CHECK (sync_version >= 1);
UPDATE collections
SET sync_uid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + abs(random()) % 4, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
WHERE sync_uid IS NULL;
CREATE UNIQUE INDEX uq_collections_sync_uid ON collections(sync_uid);

ALTER TABLE author_directories ADD COLUMN sync_uid TEXT
  CHECK (
    sync_uid IS NULL OR (
      length(sync_uid) = 36 AND substr(sync_uid, 9, 1) = '-' AND
      substr(sync_uid, 14, 1) = '-' AND substr(sync_uid, 19, 1) = '-' AND
      substr(sync_uid, 24, 1) = '-'
    )
  );
UPDATE author_directories
SET sync_uid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + abs(random()) % 4, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
WHERE sync_uid IS NULL;
CREATE UNIQUE INDEX uq_author_directories_sync_uid ON author_directories(sync_uid);

CREATE TABLE author_directory_sets (
  id INTEGER PRIMARY KEY,
  producer_id INTEGER NOT NULL UNIQUE,
  sync_uid TEXT NOT NULL CHECK (
    length(sync_uid) = 36 AND substr(sync_uid, 9, 1) = '-' AND
    substr(sync_uid, 14, 1) = '-' AND substr(sync_uid, 19, 1) = '-' AND
    substr(sync_uid, 24, 1) = '-'
  ),
  sync_version INTEGER NOT NULL DEFAULT 1 CHECK (sync_version >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (producer_id) REFERENCES producers(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_author_directory_sets_producer_id ON author_directory_sets(producer_id);
CREATE UNIQUE INDEX uq_author_directory_sets_sync_uid ON author_directory_sets(sync_uid);
INSERT INTO author_directory_sets (producer_id, sync_uid, sync_version)
SELECT id,
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + abs(random()) % 4, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  1
FROM producers;

CREATE TABLE rating_slot_layouts (
  id INTEGER PRIMARY KEY,
  sync_uid TEXT NOT NULL CHECK (
    length(sync_uid) = 36 AND substr(sync_uid, 9, 1) = '-' AND
    substr(sync_uid, 14, 1) = '-' AND substr(sync_uid, 19, 1) = '-' AND
    substr(sync_uid, 24, 1) = '-'
  ),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('entry', 'producer')),
  entry_type TEXT NOT NULL CHECK (length(trim(entry_type)) > 0),
  sync_version INTEGER NOT NULL DEFAULT 1 CHECK (sync_version >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX uq_rating_slot_layouts_sync_uid ON rating_slot_layouts(sync_uid);
CREATE UNIQUE INDEX uq_rating_slot_layouts_partition ON rating_slot_layouts(subject_kind, entry_type);

-- Baseline identities are metadata, not historical user mutations: they do not
-- add synthetic rows to the existing journal.
INSERT INTO rating_slot_layouts (sync_uid, subject_kind, entry_type, sync_version)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  layouts.subject_kind,
  layouts.entry_type,
  1
FROM (
  SELECT 'entry' AS subject_kind, type AS entry_type FROM entries GROUP BY type
  UNION
  SELECT 'producer' AS subject_kind, type AS entry_type FROM entries GROUP BY type
  UNION
  SELECT subject_kind, entry_type FROM rating_slots GROUP BY subject_kind, entry_type
) AS layouts;

-- SQLite validates persistent trigger references during DROP TABLE, so remove
-- only the three existing journal-trigger families while rebuilding the tables.
DROP TRIGGER entries_sync_insert;
DROP TRIGGER entries_sync_update;
DROP TRIGGER entries_sync_delete;
DROP TRIGGER entry_contents_sync_insert;
DROP TRIGGER entry_contents_sync_update;
DROP TRIGGER entry_contents_sync_delete;
DROP TRIGGER producers_sync_insert;
DROP TRIGGER producers_sync_update;
DROP TRIGGER producers_sync_delete;

CREATE TEMP TABLE sync_changes_sequence_v28 (seq INTEGER NOT NULL);
INSERT INTO sync_changes_sequence_v28 (seq)
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'sync_changes'), 0);

CREATE TABLE sync_changes_v28 (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN (
    'entry', 'entry_content', 'producer', 'collection', 'rating_layout', 'author_directory_set'
  )),
  entity_uid TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('create', 'update', 'delete')),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json)),
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO sync_changes_v28 (seq, entity_kind, entity_uid, change_kind, resource_version, record_json, changed_at)
SELECT seq, entity_kind, entity_uid, change_kind, resource_version, record_json, changed_at
FROM sync_changes ORDER BY seq;

CREATE TABLE sync_tombstones_v28 (
  entity_kind TEXT NOT NULL CHECK (entity_kind IN (
    'entry', 'entry_content', 'producer', 'collection', 'rating_layout', 'author_directory_set'
  )),
  entity_uid TEXT NOT NULL,
  deleted_version INTEGER NOT NULL CHECK (deleted_version >= 1),
  change_seq INTEGER NOT NULL UNIQUE,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_kind, entity_uid),
  FOREIGN KEY (change_seq) REFERENCES sync_changes_v28(seq) ON DELETE RESTRICT
) WITHOUT ROWID;
INSERT INTO sync_tombstones_v28 (entity_kind, entity_uid, deleted_version, change_seq, deleted_at)
SELECT entity_kind, entity_uid, deleted_version, change_seq, deleted_at
FROM sync_tombstones;

DROP TABLE sync_tombstones;
DROP TABLE sync_changes;
ALTER TABLE sync_changes_v28 RENAME TO sync_changes;
ALTER TABLE sync_tombstones_v28 RENAME TO sync_tombstones;
CREATE INDEX idx_sync_changes_entity ON sync_changes(entity_kind, entity_uid, seq);
UPDATE sqlite_sequence
SET seq = MAX(seq, (SELECT seq FROM sync_changes_sequence_v28))
WHERE name = 'sync_changes';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'sync_changes', seq FROM sync_changes_sequence_v28
WHERE seq > 0 AND NOT EXISTS (
  SELECT 1 FROM sqlite_sequence WHERE name = 'sync_changes'
);
DROP TABLE sync_changes_sequence_v28;

-- Restore the original Entry / Content / Producer journaling unchanged.
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
  UPDATE producers SET sync_uid = COALESCE(NEW.sync_uid,
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
  ) WHERE id = NEW.id;
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

-- Collections own their own identity/revision. Every metadata update and every
-- Entry/Producer membership edge advances that Collection, never its members.
CREATE TRIGGER collections_sync_insert
AFTER INSERT ON collections
BEGIN
  UPDATE collections SET sync_uid = COALESCE(NEW.sync_uid,
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
  ) WHERE id = NEW.id;
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'collection', sync_uid, 'create', sync_version,
    json_object('id', id, 'syncUid', sync_uid, 'syncVersion', sync_version,
      'kind', kind, 'title', title, 'description', description, 'sortOrder', sort_order)
  FROM collections WHERE id = NEW.id;
END;

CREATE TRIGGER collections_sync_revision
AFTER UPDATE OF sync_version ON collections
WHEN NEW.sync_version = OLD.sync_version + 1
BEGIN
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'collection', sync_uid, 'update', sync_version,
    json_object('id', id, 'syncUid', sync_uid, 'syncVersion', sync_version,
      'kind', kind, 'title', title, 'description', description, 'sortOrder', sort_order)
  FROM collections WHERE id = NEW.id;
END;

CREATE TRIGGER collections_sync_update
AFTER UPDATE OF kind, title, description, nsfw, parent_id, sort_order, gallery_type, updated_at ON collections
WHEN OLD.kind IS NOT NEW.kind OR OLD.title IS NOT NEW.title OR
  OLD.description IS NOT NEW.description OR OLD.nsfw IS NOT NEW.nsfw OR
  OLD.parent_id IS NOT NEW.parent_id OR OLD.sort_order IS NOT NEW.sort_order OR
  OLD.gallery_type IS NOT NEW.gallery_type OR OLD.updated_at IS NOT NEW.updated_at
BEGIN
  UPDATE collections SET sync_version = OLD.sync_version + 1 WHERE id = NEW.id;
END;

CREATE TRIGGER collections_sync_delete
AFTER DELETE ON collections
BEGIN
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  VALUES ('collection', OLD.sync_uid, 'delete', OLD.sync_version + 1, NULL);
  INSERT INTO sync_tombstones (entity_kind, entity_uid, deleted_version, change_seq)
  VALUES ('collection', OLD.sync_uid, OLD.sync_version + 1, last_insert_rowid());
END;

CREATE TRIGGER collections_sync_uid_immutable
BEFORE UPDATE OF sync_uid ON collections
WHEN OLD.sync_uid IS NOT NULL AND NEW.sync_uid IS NOT OLD.sync_uid
BEGIN
  SELECT RAISE(ABORT, 'collection sync_uid is immutable');
END;

CREATE TRIGGER collection_entries_sync_insert
AFTER INSERT ON collection_entries
BEGIN
  UPDATE collections SET sync_version = sync_version + 1 WHERE id = NEW.collection_id;
END;
CREATE TRIGGER collection_entries_sync_delete
AFTER DELETE ON collection_entries
BEGIN
  UPDATE collections SET sync_version = sync_version + 1 WHERE id = OLD.collection_id;
END;
CREATE TRIGGER collection_producers_sync_insert
AFTER INSERT ON collection_producers
BEGIN
  UPDATE collections SET sync_version = sync_version + 1 WHERE id = NEW.collection_id;
END;
CREATE TRIGGER collection_producers_sync_delete
AFTER DELETE ON collection_producers
BEGIN
  UPDATE collections SET sync_version = sync_version + 1 WHERE id = OLD.collection_id;
END;

-- The Directory set is a separate per-Author aggregate. Its own stable identity
-- and revision deliberately do not advance the Producer profile/tag/rating chain.
CREATE TRIGGER author_directory_sets_sync_update
AFTER UPDATE OF sync_version ON author_directory_sets
WHEN NEW.sync_version = OLD.sync_version + 1
BEGIN
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'author_directory_set', sync_uid, 'update', sync_version,
    json_object('id', id, 'producerId', producer_id, 'syncUid', sync_uid,
      'syncVersion', sync_version)
  FROM author_directory_sets WHERE id = NEW.id;
END;

CREATE TRIGGER author_directory_sets_sync_delete
AFTER DELETE ON author_directory_sets
BEGIN
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  VALUES ('author_directory_set', OLD.sync_uid, 'delete', OLD.sync_version + 1, NULL);
  INSERT INTO sync_tombstones (entity_kind, entity_uid, deleted_version, change_seq)
  VALUES ('author_directory_set', OLD.sync_uid, OLD.sync_version + 1, last_insert_rowid());
END;

CREATE TRIGGER author_directory_sets_sync_uid_immutable
BEFORE UPDATE OF sync_uid, producer_id ON author_directory_sets
WHEN OLD.sync_uid IS NOT NEW.sync_uid OR OLD.producer_id IS NOT NEW.producer_id
BEGIN
  SELECT RAISE(ABORT, 'Author Directory set identity is immutable');
END;

CREATE TRIGGER producers_directory_set_insert
AFTER INSERT ON producers
BEGIN
  INSERT INTO author_directory_sets (producer_id, sync_uid, sync_version)
  VALUES (NEW.id,
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
    1);
END;

CREATE TRIGGER author_directories_sync_insert
AFTER INSERT ON author_directories
BEGIN
  UPDATE author_directories SET sync_uid = COALESCE(NEW.sync_uid,
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
  ) WHERE id = NEW.id;
  UPDATE author_directory_sets SET sync_version = sync_version + 1
  WHERE producer_id = NEW.producer_id;
END;

CREATE TRIGGER author_directories_sync_update
AFTER UPDATE OF producer_id, title, description, sort_order ON author_directories
WHEN OLD.producer_id IS NOT NEW.producer_id OR OLD.title IS NOT NEW.title OR
  OLD.description IS NOT NEW.description OR OLD.sort_order IS NOT NEW.sort_order
BEGIN
  UPDATE author_directory_sets SET sync_version = sync_version + 1
  WHERE producer_id = OLD.producer_id;
  UPDATE author_directory_sets SET sync_version = sync_version + 1
  WHERE producer_id = NEW.producer_id AND NEW.producer_id IS NOT OLD.producer_id;
END;

CREATE TRIGGER author_directories_sync_delete
AFTER DELETE ON author_directories
BEGIN
  UPDATE author_directory_sets SET sync_version = sync_version + 1
  WHERE producer_id = OLD.producer_id;
END;

CREATE TRIGGER author_directories_sync_uid_immutable
BEFORE UPDATE OF sync_uid ON author_directories
WHEN OLD.sync_uid IS NOT NULL AND NEW.sync_uid IS NOT OLD.sync_uid
BEGIN
  SELECT RAISE(ABORT, 'author directory sync_uid is immutable');
END;

CREATE TRIGGER author_directory_entries_sync_insert
AFTER INSERT ON author_directory_entries
BEGIN
  UPDATE author_directory_sets SET sync_version = sync_version + 1
  WHERE producer_id = NEW.producer_id;
END;
CREATE TRIGGER author_directory_entries_sync_delete
AFTER DELETE ON author_directory_entries
BEGIN
  UPDATE author_directory_sets SET sync_version = sync_version + 1
  WHERE producer_id = OLD.producer_id;
END;
CREATE TRIGGER author_directory_entries_sync_update
AFTER UPDATE OF directory_id, producer_id, entry_id, sort_order ON author_directory_entries
WHEN OLD.directory_id IS NOT NEW.directory_id OR OLD.producer_id IS NOT NEW.producer_id OR
  OLD.entry_id IS NOT NEW.entry_id OR OLD.sort_order IS NOT NEW.sort_order
BEGIN
  UPDATE author_directory_sets SET sync_version = sync_version + 1
  WHERE producer_id = OLD.producer_id;
  UPDATE author_directory_sets SET sync_version = sync_version + 1
  WHERE producer_id = NEW.producer_id AND NEW.producer_id IS NOT OLD.producer_id;
END;

-- A layout row is a baseline per subject/type partition. Creating a new Entry
-- type creates these identities as derived metadata without a synthetic change;
-- the first slot edit below advances and journals the layout revision.
CREATE TRIGGER rating_slot_layouts_sync_update
AFTER UPDATE OF sync_version ON rating_slot_layouts
WHEN NEW.sync_version = OLD.sync_version + 1
BEGIN
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'rating_layout', sync_uid, 'update', sync_version,
    json_object('syncUid', sync_uid, 'syncVersion', sync_version,
      'subjectKind', subject_kind, 'entryType', entry_type)
  FROM rating_slot_layouts WHERE id = NEW.id;
END;

CREATE TRIGGER rating_slot_layouts_sync_delete
AFTER DELETE ON rating_slot_layouts
BEGIN
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  VALUES ('rating_layout', OLD.sync_uid, 'delete', OLD.sync_version + 1, NULL);
  INSERT INTO sync_tombstones (entity_kind, entity_uid, deleted_version, change_seq)
  VALUES ('rating_layout', OLD.sync_uid, OLD.sync_version + 1, last_insert_rowid());
END;

CREATE TRIGGER rating_slot_layouts_sync_identity_immutable
BEFORE UPDATE OF sync_uid, subject_kind, entry_type ON rating_slot_layouts
WHEN OLD.sync_uid IS NOT NEW.sync_uid OR OLD.subject_kind IS NOT NEW.subject_kind OR
  OLD.entry_type IS NOT NEW.entry_type
BEGIN
  SELECT RAISE(ABORT, 'rating layout identity is immutable');
END;

CREATE TRIGGER rating_slots_ensure_layout_before_insert
BEFORE INSERT ON rating_slots
BEGIN
  INSERT OR IGNORE INTO rating_slot_layouts (sync_uid, subject_kind, entry_type, sync_version)
  VALUES (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-' ||
      substr('89ab', 1 + abs(random()) % 4, 1) ||
      substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
    NEW.subject_kind, NEW.entry_type, 1
  );
END;

CREATE TRIGGER rating_slots_layout_insert
AFTER INSERT ON rating_slots
BEGIN
  UPDATE rating_slot_layouts SET sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE subject_kind = NEW.subject_kind AND entry_type = NEW.entry_type;
END;

CREATE TRIGGER rating_slots_layout_update
AFTER UPDATE OF subject_kind, entry_type, name, sort_order ON rating_slots
WHEN OLD.subject_kind IS NOT NEW.subject_kind OR OLD.entry_type IS NOT NEW.entry_type OR
  OLD.name IS NOT NEW.name OR OLD.sort_order IS NOT NEW.sort_order
BEGIN
  UPDATE rating_slot_layouts SET sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE subject_kind = OLD.subject_kind AND entry_type = OLD.entry_type;
  UPDATE rating_slot_layouts SET sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE subject_kind = NEW.subject_kind AND entry_type = NEW.entry_type
    AND (NEW.subject_kind IS NOT OLD.subject_kind OR NEW.entry_type IS NOT OLD.entry_type);
END;

CREATE TRIGGER rating_slots_layout_delete
AFTER DELETE ON rating_slots
BEGIN
  UPDATE rating_slot_layouts SET sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE subject_kind = OLD.subject_kind AND entry_type = OLD.entry_type;
END;

CREATE TRIGGER entries_rating_layout_insert
AFTER INSERT ON entries
BEGIN
  INSERT OR IGNORE INTO rating_slot_layouts (sync_uid, subject_kind, entry_type, sync_version)
  VALUES
    (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) ||
      substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'entry', NEW.type, 1),
    (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) ||
      substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'producer', NEW.type, 1);
END;

CREATE TRIGGER entries_rating_layout_type_update
AFTER UPDATE OF type ON entries
WHEN OLD.type IS NOT NEW.type
BEGIN
  INSERT OR IGNORE INTO rating_slot_layouts (sync_uid, subject_kind, entry_type, sync_version)
  VALUES
    (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) ||
      substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'entry', NEW.type, 1),
    (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) ||
      substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'producer', NEW.type, 1);
END;
