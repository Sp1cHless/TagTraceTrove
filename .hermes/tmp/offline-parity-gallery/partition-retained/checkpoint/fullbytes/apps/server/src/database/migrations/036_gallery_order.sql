-- A Gallery is a read-time projection of `entries.type` — it is not a table — so the order the sidebar
-- lists them in had nowhere to live, and the list fell back to the alphabet. Measured on a real
-- library with seven galleries: the two used every day (Comic, Hentai) sat wherever their spelling put
-- them, and there was no way to move one.
--
-- Sparse, and per type: a Gallery nobody has moved costs no row, and a type that no longer exists
-- leaves an orphan row that the sidebar simply never asks about. The order is written as a whole list
-- when a person moves one Gallery (`setGalleryOrder`), which is what keeps it total — a handful of
-- numbers mixed with names would be an order nobody could predict.
CREATE TABLE gallery_order (
  entry_type TEXT PRIMARY KEY CHECK (trim(entry_type) <> ''),
  sort_order INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
