-- An Author exists to hold works, and every import carries its Author information
-- with the work it belongs to. An Author left holding none is therefore residue:
-- deleting or merging an Entry never deletes its Author, so a work that goes away
-- leaves a named, completely unreferenced row behind — and Author alias groups,
-- which are name mappings with no foreign key to this table, are the most common
-- source of those spellings.
--
-- One-time: remove the rows already in that state. Their dependents (tags,
-- ratings, directories, Collections, View later) cascade with them; every row this
-- matched in the reference library had none.
DELETE FROM producers
WHERE NOT EXISTS (
  SELECT 1 FROM entry_producers WHERE entry_producers.producer_id = producers.id
);
