-- New standalone creates may pre-supply an independent Directory-set identity.
ALTER TABLE producers ADD COLUMN directory_set_seed_uid TEXT;
CREATE TRIGGER producers_directory_seed_immutable
BEFORE UPDATE OF directory_set_seed_uid ON producers
WHEN NEW.directory_set_seed_uid IS NOT OLD.directory_set_seed_uid
BEGIN SELECT RAISE(ABORT, 'Directory seed is immutable'); END;
DROP TRIGGER producers_directory_set_insert;
CREATE TRIGGER producers_directory_set_insert
AFTER INSERT ON producers
BEGIN
 INSERT INTO author_directory_sets (producer_id, sync_uid, sync_version)
 VALUES (NEW.id, COALESCE(NEW.directory_set_seed_uid,
 lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
 substr(lower(hex(randomblob(2))), 2) || '-' ||
 substr('89ab', 1 + abs(random()) % 4, 1) ||
 substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 1);
END;
CREATE TRIGGER author_directory_sets_sync_insert
AFTER INSERT ON author_directory_sets
BEGIN
 INSERT INTO sync_changes (entity_kind,entity_uid,change_kind,resource_version,record_json)
 VALUES ('author_directory_set',NEW.sync_uid,'create',NEW.sync_version,
 json_object('id',NEW.id,'producerId',NEW.producer_id,'syncUid',NEW.sync_uid,'syncVersion',NEW.sync_version));
END;
