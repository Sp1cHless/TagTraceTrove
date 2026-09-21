-- Give every rating slot a permanent sync identity. Numeric SQLite rowids can be
-- reused after deletion and therefore are unsafe as offline operation identities.
ALTER TABLE rating_slots ADD COLUMN sync_uid TEXT;

UPDATE rating_slots
SET sync_uid = '00000000-0000-4000-8000-' || printf('%012x', id);

CREATE UNIQUE INDEX idx_rating_slots_sync_uid
ON rating_slots(sync_uid);

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
