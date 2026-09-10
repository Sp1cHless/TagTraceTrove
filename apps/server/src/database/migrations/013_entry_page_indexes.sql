-- Cover the stable Gallery page orderings without scanning/sorting every Entry.
-- The legacy (type, title) index uses BINARY collation and cannot satisfy the
-- product's case-insensitive title order, so keep this explicit NOCASE index.
CREATE INDEX idx_entries_page_title
ON entries(type, title COLLATE NOCASE, id);

CREATE INDEX idx_entries_page_date
ON entries(type, upload_date, id);
