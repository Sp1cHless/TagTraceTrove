-- Entry-owned Author links participate in the same optimistic revision chain as
-- all other offline Entry edits. These triggers cover online routes, imports,
-- cascades, and replay mutations without relying on one repository call path.

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
