-- Give the shared Producer-tag vocabulary stable offline identities.
ALTER TABLE producer_tags ADD COLUMN sync_uid TEXT
  CHECK (
    sync_uid IS NULL OR (
      length(sync_uid) = 36 AND
      substr(sync_uid, 9, 1) = '-' AND
      substr(sync_uid, 14, 1) = '-' AND
      substr(sync_uid, 19, 1) = '-' AND
      substr(sync_uid, 24, 1) = '-'
    )
  );

UPDATE producer_tags
SET sync_uid =
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + abs(random()) % 4, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE sync_uid IS NULL;

CREATE UNIQUE INDEX uq_producer_tags_sync_uid ON producer_tags(sync_uid);

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

-- Tag assignments are part of each Producer's version/conflict boundary.
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

-- A global vocabulary rename changes the visible tag values of every assigned Producer.
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
