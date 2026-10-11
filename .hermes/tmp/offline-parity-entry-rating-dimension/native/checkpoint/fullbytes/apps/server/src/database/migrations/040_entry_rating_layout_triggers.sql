-- Correction to 039: put the two `entries` triggers back.
--
-- 039 rebuilds `rating_slot_layouts`, and `ALTER TABLE ... RENAME` makes SQLite re-parse every
-- trigger — so a trigger left pointing at a table that is momentarily gone aborts the migration.
-- The triggers that needed to go were therefore dropped at the top of 039, including
-- `entries_rating_layout_insert` and `entries_rating_layout_type_update`, which are ON `entries`
-- and reference `rating_slot_layouts`. Their bodies were not written back at the bottom.
--
-- The result was a database that had lost the two triggers which give a newly created Gallery its
-- baseline rating-layout rows: a new Entry type would still get its slots, but the sync partition
-- identity would only be born when the first slot appeared, and any client tracking partitions
-- would see a partition appear late. Nothing else was affected, and no rating value was touched.
--
-- A migration is immutable once applied, and 039 was applied to a real library the moment it
-- appeared on disk (the server's own `buildSyncCapabilities` calls `applyAllMigrations`, so a
-- capabilities poll is enough — see the execution log). So this is a new migration rather than an
-- edit: 039 stays exactly as applied, and this file restores the two bodies verbatim.

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
