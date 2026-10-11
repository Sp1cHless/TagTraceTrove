-- A Tag exists to index works: it is a label the user typed onto something. A row
-- that no work (and, for the Producer vocabulary, no Author) carries is residue —
-- a mistyped name, or the last assignment of a name that was removed — and it
-- would otherwise keep coming back from the autocomplete for ever while the
-- vocabulary grew without bound.
--
-- One-time: remove the rows already in that state. Tag aliases are name mappings
-- with no foreign key here, so the alias dictionary is untouched and re-creates
-- the row from a later import.
DELETE FROM tags
WHERE NOT EXISTS (SELECT 1 FROM entry_tags WHERE entry_tags.tag_id = tags.id);

DELETE FROM producer_tags
WHERE NOT EXISTS (
  SELECT 1 FROM producer_tag_assignments WHERE producer_tag_assignments.tag_id = producer_tags.id
);
