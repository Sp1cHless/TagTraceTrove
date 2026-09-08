-- Authors use the same shared View later semantics as Entries, while keeping
-- an independent ordered list for the Authors page.
CREATE TABLE view_later_producers (
    producer_id INTEGER PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (producer_id) REFERENCES producers(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_view_later_producers_position
ON view_later_producers(position, producer_id);
