-- Collections gain an explicit Gallery scope on the Entries side, so the
-- Collections page can partition itself exactly the way Galleries do: the
-- folder lives on one Gallery page, and an NSFW Gallery page disappears in SFW
-- mode together with its folders. Folder-level `nsfw` keeps its own meaning and
-- is unchanged. Producer (Author) folders stay Gallery-less: an Author has no
-- Gallery of its own, only a derived dominant type that moves as works change.
ALTER TABLE collections ADD COLUMN gallery_type TEXT
  CHECK (gallery_type IS NULL OR (kind = 'entry' AND length(trim(gallery_type)) > 0));

-- Existing folders keep their curation: a folder whose members all belong to one
-- Gallery is filed there. Mixed or empty folders stay unassigned (NULL) rather
-- than being guessed into a Gallery.
UPDATE collections
SET gallery_type = (
  SELECT MIN(entry.type)
  FROM collection_entries AS member
  JOIN entries AS entry ON entry.id = member.entry_id
  WHERE member.collection_id = collections.id
)
WHERE kind = 'entry'
  AND (
    SELECT COUNT(DISTINCT entry.type)
    FROM collection_entries AS member
    JOIN entries AS entry ON entry.id = member.entry_id
    WHERE member.collection_id = collections.id
  ) = 1;

-- A nested folder is part of its parent's page, so it inherits the Gallery the
-- parent was just filed under.
UPDATE collections
SET gallery_type = (
  SELECT parent.gallery_type FROM collections AS parent WHERE parent.id = collections.parent_id
)
WHERE kind = 'entry' AND parent_id IS NOT NULL;
