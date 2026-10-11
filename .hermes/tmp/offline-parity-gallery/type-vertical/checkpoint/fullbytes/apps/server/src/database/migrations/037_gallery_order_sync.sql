-- Independent library-wide Gallery order revision; preserve the journal high-water mark.
DROP TRIGGER "tag_groups_facet_parent_insert";
DROP TRIGGER "tag_groups_facet_parent_update";
DROP TRIGGER "tag_groups_section_with_facets_update";
DROP TRIGGER "entry_tags_facet_insert";
DROP TRIGGER "entry_tags_facet_update";
DROP TRIGGER "entries_type_with_tags_update";
DROP TRIGGER "assigned_facet_update";
DROP TRIGGER "entries_sync_uid_immutable";
DROP TRIGGER "entry_contents_sync_uid_immutable";
DROP TRIGGER "rating_slots_sync_uid_required_insert";
DROP TRIGGER "rating_slots_sync_uid_immutable";
DROP TRIGGER "producers_sync_uid_immutable";
DROP TRIGGER "view_later_producers_sync_insert";
DROP TRIGGER "view_later_producers_sync_delete";
DROP TRIGGER "producer_rating_values_sync_insert";
DROP TRIGGER "producer_rating_values_sync_update";
DROP TRIGGER "producer_rating_values_sync_delete";
DROP TRIGGER "producer_tags_sync_identity_insert";
DROP TRIGGER "producer_tags_sync_uid_immutable";
DROP TRIGGER "producer_tag_assignments_sync_insert";
DROP TRIGGER "producer_tag_assignments_sync_update";
DROP TRIGGER "producer_tag_assignments_sync_delete";
DROP TRIGGER "producer_tags_sync_update";
DROP TRIGGER "entries_sync_insert";
DROP TRIGGER "entries_sync_update";
DROP TRIGGER "entries_sync_delete";
DROP TRIGGER "entry_contents_sync_insert";
DROP TRIGGER "entry_contents_sync_update";
DROP TRIGGER "entry_contents_sync_delete";
DROP TRIGGER "producers_sync_insert";
DROP TRIGGER "producers_sync_update";
DROP TRIGGER "producers_sync_delete";
DROP TRIGGER "collections_sync_insert";
DROP TRIGGER "collections_sync_revision";
DROP TRIGGER "collections_sync_update";
DROP TRIGGER "collections_sync_delete";
DROP TRIGGER "collections_sync_uid_immutable";
DROP TRIGGER "collection_entries_sync_insert";
DROP TRIGGER "collection_entries_sync_delete";
DROP TRIGGER "collection_producers_sync_insert";
DROP TRIGGER "collection_producers_sync_delete";
DROP TRIGGER "author_directory_sets_sync_update";
DROP TRIGGER "author_directory_sets_sync_delete";
DROP TRIGGER "author_directory_sets_sync_uid_immutable";
DROP TRIGGER "producers_directory_set_insert";
DROP TRIGGER "author_directories_sync_insert";
DROP TRIGGER "author_directories_sync_update";
DROP TRIGGER "author_directories_sync_delete";
DROP TRIGGER "author_directories_sync_uid_immutable";
DROP TRIGGER "author_directory_entries_sync_insert";
DROP TRIGGER "author_directory_entries_sync_delete";
DROP TRIGGER "author_directory_entries_sync_update";
DROP TRIGGER "rating_slot_layouts_sync_update";
DROP TRIGGER "rating_slot_layouts_sync_delete";
DROP TRIGGER "rating_slot_layouts_sync_identity_immutable";
DROP TRIGGER "rating_slots_ensure_layout_before_insert";
DROP TRIGGER "rating_slots_layout_insert";
DROP TRIGGER "rating_slots_layout_update";
DROP TRIGGER "rating_slots_layout_delete";
DROP TRIGGER "entries_rating_layout_insert";
DROP TRIGGER "entries_rating_layout_type_update";
DROP TRIGGER "entry_producers_sync_insert";
DROP TRIGGER "entry_producers_sync_delete";
DROP TRIGGER "entry_tags_sync_insert";
DROP TRIGGER "entry_tags_sync_delete";
DROP TRIGGER "entry_tags_sync_update";
DROP TRIGGER "tags_sync_identity_insert";
DROP TRIGGER "tags_sync_uid_immutable";
DROP TRIGGER "tags_sync_update";
DROP TRIGGER "tags_sync_delete";
DROP TRIGGER "tag_groups_sync_identity_layout_insert";
DROP TRIGGER "tag_groups_sync_uid_immutable";
DROP TRIGGER "tag_groups_sync_layout_update";
DROP TRIGGER "tag_groups_sync_layout_delete";
CREATE TEMP TABLE gallery_sync_sequence AS SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='sync_changes'),0) AS seq;
CREATE TABLE sync_changes_v37 (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN (
    'entry', 'entry_content', 'producer', 'collection', 'rating_layout', 'author_directory_set', 'gallery_order'
  )),
  entity_uid TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('create', 'update', 'delete')),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json)),
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO sync_changes_v37 SELECT * FROM sync_changes;
CREATE TABLE sync_tombstones_v37 (
  entity_kind TEXT NOT NULL CHECK (entity_kind IN (
    'entry', 'entry_content', 'producer', 'collection', 'rating_layout', 'author_directory_set', 'gallery_order'
  )),
  entity_uid TEXT NOT NULL,
  deleted_version INTEGER NOT NULL CHECK (deleted_version >= 1),
  change_seq INTEGER NOT NULL UNIQUE,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_kind, entity_uid),
  FOREIGN KEY (change_seq) REFERENCES sync_changes_v37(seq) ON DELETE RESTRICT
) WITHOUT ROWID;
INSERT INTO sync_tombstones_v37 SELECT * FROM sync_tombstones;
DROP TABLE sync_tombstones;
DROP TABLE sync_changes;
ALTER TABLE sync_changes_v37 RENAME TO sync_changes;
ALTER TABLE sync_tombstones_v37 RENAME TO sync_tombstones;
UPDATE sqlite_sequence SET seq=MAX(seq,(SELECT seq FROM gallery_sync_sequence)) WHERE name='sync_changes';
DROP TABLE gallery_sync_sequence;
CREATE INDEX idx_sync_changes_entity ON sync_changes(entity_kind, entity_uid, seq);
CREATE TRIGGER tag_groups_facet_parent_insert
BEFORE INSERT ON tag_groups
WHEN NEW.group_kind = 'facet'
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM tag_groups AS parent
        WHERE parent.id = NEW.parent_id
          AND parent.group_kind = 'section'
          AND parent.entry_type = NEW.entry_type
    ) THEN RAISE(ABORT, 'facet parent must be a section of the same entry type') END;
END;
CREATE TRIGGER tag_groups_facet_parent_update
BEFORE UPDATE OF parent_id, group_kind, entry_type ON tag_groups
WHEN NEW.group_kind = 'facet'
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM tag_groups AS parent
        WHERE parent.id = NEW.parent_id
          AND parent.group_kind = 'section'
          AND parent.entry_type = NEW.entry_type
    ) THEN RAISE(ABORT, 'facet parent must be a section of the same entry type') END;
END;
CREATE TRIGGER tag_groups_section_with_facets_update
BEFORE UPDATE OF group_kind, entry_type ON tag_groups
WHEN OLD.group_kind = 'section'
 AND (NEW.group_kind <> 'section' OR NEW.entry_type <> OLD.entry_type)
 AND EXISTS (SELECT 1 FROM tag_groups WHERE parent_id = OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'move or remove section facets before changing the section kind or entry type');
END;
CREATE TRIGGER entry_tags_facet_insert
BEFORE INSERT ON entry_tags
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM entries AS entry
        JOIN tag_groups AS facet
          ON facet.id = NEW.facet_id
         AND facet.group_kind = 'facet'
         AND facet.entry_type = entry.type
        WHERE entry.id = NEW.entry_id
    ) THEN RAISE(ABORT, 'entry tag must target a facet of the entry type') END;
END;
CREATE TRIGGER entry_tags_facet_update
BEFORE UPDATE OF entry_id, facet_id ON entry_tags
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM entries AS entry
        JOIN tag_groups AS facet
          ON facet.id = NEW.facet_id
         AND facet.group_kind = 'facet'
         AND facet.entry_type = entry.type
        WHERE entry.id = NEW.entry_id
    ) THEN RAISE(ABORT, 'entry tag must target a facet of the entry type') END;
END;
CREATE TRIGGER entries_type_with_tags_update
BEFORE UPDATE OF type ON entries
WHEN EXISTS (
    SELECT 1
    FROM entry_tags AS assignment
    JOIN tag_groups AS facet ON facet.id = assignment.facet_id
    WHERE assignment.entry_id = OLD.id
      AND facet.entry_type <> NEW.type
)
BEGIN
    SELECT RAISE(ABORT, 'move entry tags before changing the entry type');
END;
CREATE TRIGGER assigned_facet_update
BEFORE UPDATE OF group_kind, entry_type ON tag_groups
WHEN EXISTS (
    SELECT 1
    FROM entry_tags AS assignment
    JOIN entries AS entry ON entry.id = assignment.entry_id
    WHERE assignment.facet_id = OLD.id
      AND (NEW.group_kind <> 'facet' OR NEW.entry_type <> entry.type)
)
BEGIN
    SELECT RAISE(ABORT, 'assigned tag group must remain a facet of the entry type');
END;
CREATE TRIGGER entries_sync_uid_immutable
BEFORE UPDATE OF sync_uid ON entries
WHEN OLD.sync_uid IS NOT NULL AND NEW.sync_uid IS NOT OLD.sync_uid
BEGIN
  SELECT RAISE(ABORT, 'entry sync_uid is immutable');
END;
CREATE TRIGGER entry_contents_sync_uid_immutable
BEFORE UPDATE OF sync_uid ON entry_contents
WHEN OLD.sync_uid IS NOT NULL AND NEW.sync_uid IS NOT OLD.sync_uid
BEGIN
  SELECT RAISE(ABORT, 'entry content sync_uid is immutable');
END;
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
CREATE TRIGGER producers_sync_uid_immutable
BEFORE UPDATE OF sync_uid ON producers
WHEN OLD.sync_uid IS NOT NULL AND NEW.sync_uid IS NOT OLD.sync_uid
BEGIN
  SELECT RAISE(ABORT, 'producer sync_uid is immutable');
END;
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
CREATE TRIGGER producer_tags_sync_identity_insert
AFTER INSERT ON producer_tags
WHEN NEW.sync_uid IS NULL
BEGIN
  UPDATE producer_tags
  SET sync_uid =
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  WHERE id = NEW.id;
END;
CREATE TRIGGER producer_tags_sync_uid_immutable
BEFORE UPDATE OF sync_uid ON producer_tags
WHEN OLD.sync_uid IS NOT NULL AND NEW.sync_uid IS NOT OLD.sync_uid
BEGIN
  SELECT RAISE(ABORT, 'producer tag sync_uid is immutable');
END;
CREATE TRIGGER producer_tag_assignments_sync_insert
AFTER INSERT ON producer_tag_assignments
BEGIN
  UPDATE producers SET updated_at = updated_at WHERE id = NEW.producer_id;
END;
CREATE TRIGGER producer_tag_assignments_sync_update
AFTER UPDATE OF producer_id, tag_id ON producer_tag_assignments
WHEN OLD.producer_id IS NOT NEW.producer_id OR OLD.tag_id IS NOT NEW.tag_id
BEGIN
  UPDATE producers SET updated_at = updated_at WHERE id IN (OLD.producer_id, NEW.producer_id);
END;
CREATE TRIGGER producer_tag_assignments_sync_delete
AFTER DELETE ON producer_tag_assignments
BEGIN
  UPDATE producers SET updated_at = updated_at WHERE id = OLD.producer_id;
END;
CREATE TRIGGER producer_tags_sync_update
AFTER UPDATE OF name, normalized_name ON producer_tags
WHEN OLD.name IS NOT NEW.name OR OLD.normalized_name IS NOT NEW.normalized_name
BEGIN
  UPDATE producers SET updated_at = updated_at
  WHERE id IN (
    SELECT DISTINCT producer_id
    FROM producer_tag_assignments
    WHERE tag_id = NEW.id
  );
END;
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
CREATE TRIGGER entry_producers_sync_insert
AFTER INSERT ON entry_producers
WHEN EXISTS (SELECT 1 FROM entries WHERE id = NEW.entry_id)
BEGIN
  UPDATE entries SET sync_version = sync_version + 1 WHERE id = NEW.entry_id;

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
  FROM entries WHERE id = NEW.entry_id;
END;
CREATE TRIGGER entry_producers_sync_delete
AFTER DELETE ON entry_producers
WHEN EXISTS (SELECT 1 FROM entries WHERE id = OLD.entry_id)
BEGIN
  UPDATE entries SET sync_version = sync_version + 1 WHERE id = OLD.entry_id;

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
  FROM entries WHERE id = OLD.entry_id;
END;
CREATE TRIGGER entry_tags_sync_insert AFTER INSERT ON entry_tags
WHEN EXISTS (SELECT 1 FROM entries WHERE id = NEW.entry_id)
BEGIN
  UPDATE entries SET sync_version = sync_version + 1 WHERE id = NEW.entry_id;
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'entry', sync_uid, 'update', sync_version,
    json_object('id', id, 'syncUid', sync_uid, 'syncVersion', sync_version,
      'title', title, 'type', type, 'coverRef', cover_ref, 'previewRef', preview_ref,
      'previewRefsJson', preview_refs, 'pageCount', page_count, 'uploadDate', upload_date,
      'createdAt', created_at, 'updatedAt', updated_at)
  FROM entries WHERE id = NEW.entry_id;
END;
CREATE TRIGGER entry_tags_sync_delete AFTER DELETE ON entry_tags
WHEN EXISTS (SELECT 1 FROM entries WHERE id = OLD.entry_id)
BEGIN
  UPDATE entries SET sync_version = sync_version + 1 WHERE id = OLD.entry_id;
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'entry', sync_uid, 'update', sync_version,
    json_object('id', id, 'syncUid', sync_uid, 'syncVersion', sync_version,
      'title', title, 'type', type, 'coverRef', cover_ref, 'previewRef', preview_ref,
      'previewRefsJson', preview_refs, 'pageCount', page_count, 'uploadDate', upload_date,
      'createdAt', created_at, 'updatedAt', updated_at)
  FROM entries WHERE id = OLD.entry_id;
END;
CREATE TRIGGER entry_tags_sync_update AFTER UPDATE ON entry_tags
WHEN EXISTS (SELECT 1 FROM entries WHERE id = NEW.entry_id)
BEGIN
  UPDATE entries SET sync_version = sync_version + 1 WHERE id = NEW.entry_id;
  INSERT INTO sync_changes (entity_kind, entity_uid, change_kind, resource_version, record_json)
  SELECT 'entry', sync_uid, 'update', sync_version,
    json_object('id', id, 'syncUid', sync_uid, 'syncVersion', sync_version,
      'title', title, 'type', type, 'coverRef', cover_ref, 'previewRef', preview_ref,
      'previewRefsJson', preview_refs, 'pageCount', page_count, 'uploadDate', upload_date,
      'createdAt', created_at, 'updatedAt', updated_at)
  FROM entries WHERE id = NEW.entry_id;
END;
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

CREATE TABLE gallery_order_scope (
 id INTEGER PRIMARY KEY CHECK(id=1),
 sync_uid TEXT NOT NULL UNIQUE,
 sync_version INTEGER NOT NULL DEFAULT 1 CHECK(sync_version>=1)
);
INSERT INTO gallery_order_scope(id,sync_uid) VALUES(1,'00000000-0000-4000-8000-000000000037');
CREATE TRIGGER gallery_order_scope_journal AFTER UPDATE OF sync_version ON gallery_order_scope
WHEN NEW.sync_version <> OLD.sync_version
BEGIN
 INSERT INTO sync_changes(entity_kind,entity_uid,change_kind,resource_version,record_json)
 VALUES('gallery_order',NEW.sync_uid,'update',NEW.sync_version,
 json_object('syncUid',NEW.sync_uid,'syncVersion',NEW.sync_version,'orderedTypes',json((SELECT json_group_array(entry_type) FROM (SELECT entry_type FROM gallery_order ORDER BY sort_order,entry_type COLLATE NOCASE)))));
END;
