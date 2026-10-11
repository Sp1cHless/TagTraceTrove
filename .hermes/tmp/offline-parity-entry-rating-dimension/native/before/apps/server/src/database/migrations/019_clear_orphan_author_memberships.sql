-- Rows that still point at an Author which no longer exists. They predate the
-- Author-merge cleanup that now moves a merged Author's Collection and View later
-- memberships to the keeper: the absorbed row was deleted while these membership
-- rows stayed behind, so the folder and the saved list kept a slot with no Author
-- to show. Nothing can render them, and the Doctor reports them as violations.
DELETE FROM collection_producers
WHERE producer_id NOT IN (SELECT id FROM producers);

DELETE FROM view_later_producers
WHERE producer_id NOT IN (SELECT id FROM producers);
