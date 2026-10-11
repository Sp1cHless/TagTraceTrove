-- Local usage tracking: one row per Entry, created lazily on first view and
-- incremented when the user opens the Entry's source URL (a real navigation
-- counts as one view; opening the card itself does not). Author-side numbers
-- are derived by aggregating their works' rows, never stored separately.
-- A missing row means the Entry has never been viewed (count 0, no date).
CREATE TABLE entry_usage (
    entry_id INTEGER NOT NULL PRIMARY KEY,
    view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
    last_viewed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) WITHOUT ROWID;
