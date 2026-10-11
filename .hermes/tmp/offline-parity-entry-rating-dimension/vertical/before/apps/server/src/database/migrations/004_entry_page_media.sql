-- Multi-page preview images and page count on Entries.
-- page_count: integer page/panel count from the source export (e.g. hitomi page_count).
-- preview_refs: JSON array of preview image asset references, ordered. Keeps the legacy
-- single preview_ref column in sync (preview_ref remains the first entry for compatibility).
ALTER TABLE entries ADD COLUMN page_count INTEGER;
ALTER TABLE entries ADD COLUMN preview_refs TEXT NOT NULL DEFAULT '[]';
