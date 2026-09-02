CREATE TABLE author_directories (
    id INTEGER PRIMARY KEY,
    producer_id INTEGER NOT NULL,
    title TEXT NOT NULL CHECK (trim(title) <> ''),
    description TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (producer_id) REFERENCES producers(id) ON DELETE CASCADE,
    UNIQUE (id, producer_id)
);

CREATE INDEX idx_author_directories_producer
ON author_directories(producer_id, sort_order, id);

CREATE TABLE author_directory_entries (
    directory_id INTEGER NOT NULL,
    producer_id INTEGER NOT NULL,
    entry_id INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (directory_id, entry_id),
    UNIQUE (producer_id, entry_id),
    FOREIGN KEY (directory_id, producer_id)
        REFERENCES author_directories(id, producer_id) ON DELETE CASCADE,
    FOREIGN KEY (entry_id, producer_id)
        REFERENCES entry_producers(entry_id, producer_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_author_directory_entries_directory
ON author_directory_entries(directory_id, sort_order, entry_id);
