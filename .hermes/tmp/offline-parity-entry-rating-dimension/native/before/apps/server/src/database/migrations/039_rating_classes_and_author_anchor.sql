-- Three rating classes, and an Author's Gallery as a stored anchor.
--
-- `rating_slots` has always known two classes, and the names were never a good description of them:
--
--   'entry'     the WORK's own dimensions.
--   'producer'  the author's WORKS SUMMARY — the Gallery's work dimensions, rated once for the
--               author as a whole. This is the class an unrated work inherits, and the only class
--               that existed for producers before this migration, so every existing row keeps its
--               meaning and the inheritance in `authorRatingSortValueSql` keeps reading it.
--   'author_self' (NEW) — the author themselves: dimensions about the person or the studio, which
--               have nothing to do with any work's dimensions. An actor is no longer rated on the
--               film's 剧情.
--
-- Both author classes stay partitioned by the author's Gallery, which is the whole point: the
-- dimension SET is shared per (class, Gallery), so it can be applied to every author of that
-- Gallery at once.
--
-- `rating_slots` is the FK parent of both value tables with `ON DELETE CASCADE`, and the CHECK
-- cannot be altered in place, so the table is rebuilt. Measured on a scratch copy of a real
-- library (2026-10-08): dropping the parent first cascades the children away — every rating value
-- is lost, silently. The safe order is the one `025`/`028`/`037` already use: build the new tables,
-- drop the OLD CHILD first so the old parent has nothing left to cascade to, then the old parent,
-- then rename. `PRAGMA foreign_keys` cannot be turned off here (the runner runs each migration
-- inside a transaction) and `PRAGMA legacy_alter_table` does not stop SQLite rewriting the child's
-- FK text, so this order is not a preference — it is the only correct one.

-- Every trigger that names one of the four tables is dropped first. The last two are on `entries`
-- and were missed by the first draft: `ALTER TABLE ... RENAME` makes SQLite re-parse every trigger,
-- so a trigger left pointing at a table that is momentarily gone aborts the whole migration
-- ("error in trigger entries_rating_layout_insert: no such table: main.rating_slot_layouts" —
-- measured on a scratch copy). They are recreated verbatim at the end. Their bodies still name only
-- 'entry' and 'producer': the third class's partition row is created on first use by
-- `rating_slots_ensure_layout_before_insert`, which is how a new partition has always been born.
DROP TRIGGER rating_slots_sync_uid_required_insert;
DROP TRIGGER rating_slots_sync_uid_immutable;
DROP TRIGGER rating_slots_ensure_layout_before_insert;
DROP TRIGGER rating_slots_layout_insert;
DROP TRIGGER rating_slots_layout_update;
DROP TRIGGER rating_slots_layout_delete;
DROP TRIGGER rating_slot_layouts_sync_update;
DROP TRIGGER rating_slot_layouts_sync_delete;
DROP TRIGGER rating_slot_layouts_sync_identity_immutable;
DROP TRIGGER producer_rating_values_sync_insert;
DROP TRIGGER producer_rating_values_sync_update;
DROP TRIGGER producer_rating_values_sync_delete;
DROP TRIGGER entries_rating_layout_insert;
DROP TRIGGER entries_rating_layout_type_update;

CREATE TABLE rating_slots_next (
    id INTEGER PRIMARY KEY,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('entry', 'producer', 'author_self')),
    entry_type TEXT NOT NULL CHECK (trim(entry_type) <> ''),
    name TEXT NOT NULL CHECK (trim(name) <> ''),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sync_uid TEXT,
    UNIQUE (subject_kind, entry_type, name)
);
INSERT INTO rating_slots_next
  (id, subject_kind, entry_type, name, sort_order, created_at, updated_at, sync_uid)
SELECT id, subject_kind, entry_type, name, sort_order, created_at, updated_at, sync_uid
FROM rating_slots;

CREATE TABLE entry_rating_values_next (
    slot_id INTEGER NOT NULL,
    entry_id INTEGER NOT NULL,
    stars REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (slot_id, entry_id),
    CHECK (
        stars IS NULL
        OR (stars >= 0.5 AND stars <= 5 AND stars * 2 = CAST(stars * 2 AS INTEGER))
    ),
    FOREIGN KEY (slot_id) REFERENCES rating_slots_next(id) ON DELETE CASCADE,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) WITHOUT ROWID;
INSERT INTO entry_rating_values_next (slot_id, entry_id, stars, updated_at)
SELECT slot_id, entry_id, stars, updated_at FROM entry_rating_values;

CREATE TABLE producer_rating_values_next (
    slot_id INTEGER NOT NULL,
    producer_id INTEGER NOT NULL,
    stars REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (slot_id, producer_id),
    CHECK (
        stars IS NULL
        OR (stars >= 0.5 AND stars <= 5 AND stars * 2 = CAST(stars * 2 AS INTEGER))
    ),
    FOREIGN KEY (slot_id) REFERENCES rating_slots_next(id) ON DELETE CASCADE,
    FOREIGN KEY (producer_id) REFERENCES producers(id) ON DELETE CASCADE
) WITHOUT ROWID;
INSERT INTO producer_rating_values_next (slot_id, producer_id, stars, updated_at)
SELECT slot_id, producer_id, stars, updated_at FROM producer_rating_values;

-- The children go first: with them gone, the old parent has nothing to cascade to.
DROP TABLE entry_rating_values;
DROP TABLE producer_rating_values;
DROP TABLE rating_slots;

ALTER TABLE rating_slots_next RENAME TO rating_slots;
ALTER TABLE producer_rating_values_next RENAME TO producer_rating_values;
ALTER TABLE entry_rating_values_next RENAME TO entry_rating_values;

CREATE INDEX idx_rating_slots_lookup
ON rating_slots(subject_kind, entry_type, sort_order, id);
CREATE UNIQUE INDEX idx_rating_slots_sync_uid
ON rating_slots(sync_uid);
CREATE INDEX idx_entry_rating_values_entry
ON entry_rating_values(entry_id);
CREATE INDEX idx_producer_rating_values_producer
ON producer_rating_values(producer_id);

-- The layouts table is the sync/journal owner of one (class, Gallery) partition, so the third
-- class needs its third value here too. Nothing references this table, so it is a plain rebuild.
CREATE TABLE rating_slot_layouts_next (
  id INTEGER PRIMARY KEY,
  sync_uid TEXT NOT NULL CHECK (
    length(sync_uid) = 36 AND substr(sync_uid, 9, 1) = '-' AND
    substr(sync_uid, 14, 1) = '-' AND substr(sync_uid, 19, 1) = '-' AND
    substr(sync_uid, 24, 1) = '-'
  ),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('entry', 'producer', 'author_self')),
  entry_type TEXT NOT NULL CHECK (length(trim(entry_type)) > 0),
  sync_version INTEGER NOT NULL DEFAULT 1 CHECK (sync_version >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO rating_slot_layouts_next
  (id, sync_uid, subject_kind, entry_type, sync_version, created_at, updated_at)
SELECT id, sync_uid, subject_kind, entry_type, sync_version, created_at, updated_at
FROM rating_slot_layouts;
DROP TABLE rating_slot_layouts;
ALTER TABLE rating_slot_layouts_next RENAME TO rating_slot_layouts;
CREATE UNIQUE INDEX uq_rating_slot_layouts_sync_uid ON rating_slot_layouts(sync_uid);
CREATE UNIQUE INDEX uq_rating_slot_layouts_partition ON rating_slot_layouts(subject_kind, entry_type);

-- An Author's home Gallery, stored rather than re-derived on every read.
--
-- It was derived from the works (the type with the most of them), which meant a single new work in
-- another Gallery could silently move an Author to a different rating partition and take every
-- dimension they had been rated on out of sight. The derived value is what this backfills, so
-- nothing moves today; from here on it is a stored fact a person can see, and `galleryTypeForProducer`
-- falls back to the derivation only for an Author that has no anchor yet.
ALTER TABLE producers ADD COLUMN gallery_anchor TEXT;
UPDATE producers SET gallery_anchor = (
  SELECT entry.type
  FROM entry_producers AS relation
  JOIN entries AS entry ON entry.id = relation.entry_id
  WHERE relation.producer_id = producers.id
  GROUP BY entry.type
  ORDER BY COUNT(*) DESC, entry.type COLLATE NOCASE
  LIMIT 1
);

CREATE TRIGGER rating_slots_sync_uid_required_insert
BEFORE INSERT ON rating_slots
WHEN NEW.sync_uid IS NULL OR trim(NEW.sync_uid) = ''
BEGIN
    SELECT RAISE(ABORT, 'rating slot sync_uid is required');
END;
CREATE TRIGGER rating_slots_sync_uid_immutable
BEFORE UPDATE OF sync_uid ON rating_slots
WHEN NEW.sync_uid IS NOT OLD.sync_uid
BEGIN
    SELECT RAISE(ABORT, 'rating slot sync_uid is immutable');
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
CREATE TRIGGER producer_rating_values_sync_insert
AFTER INSERT ON producer_rating_values
BEGIN
  UPDATE producers SET updated_at = updated_at WHERE id = NEW.producer_id;
END;
CREATE TRIGGER producer_rating_values_sync_update
AFTER UPDATE OF stars ON producer_rating_values
WHEN OLD.stars IS NOT NEW.stars
BEGIN
  UPDATE producers SET updated_at = updated_at WHERE id = NEW.producer_id;
END;
CREATE TRIGGER producer_rating_values_sync_delete
AFTER DELETE ON producer_rating_values
BEGIN
  UPDATE producers SET updated_at = updated_at WHERE id = OLD.producer_id;
END;
