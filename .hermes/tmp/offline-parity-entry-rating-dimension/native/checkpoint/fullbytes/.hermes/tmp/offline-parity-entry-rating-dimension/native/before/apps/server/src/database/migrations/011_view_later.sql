-- One shared View later list for every browser connected to this library.
-- Position preserves insertion order; membership is idempotent and deleting
-- an Entry removes its View later membership automatically.
CREATE TABLE view_later_entries (
    entry_id INTEGER PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_view_later_position
ON view_later_entries(position, entry_id);
