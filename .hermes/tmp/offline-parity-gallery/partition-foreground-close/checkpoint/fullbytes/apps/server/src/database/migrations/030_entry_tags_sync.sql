-- Entry-owned tag assignments: each row change advances its Entry revision and journal.
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
