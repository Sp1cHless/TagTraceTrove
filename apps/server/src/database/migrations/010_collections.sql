-- Collections: user-curated folders grouping Entries or Producers.
-- Two kinds exist ('entry' and 'producer'); an entry collection may nest
-- child folders exactly one level deep, producer collections stay flat.
-- NSFW is a folder-level switch that hides the whole folder regardless of
-- the works inside it.
CREATE TABLE collections (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('entry', 'producer')),
    title TEXT NOT NULL CHECK (trim(title) <> ''),
    description TEXT NOT NULL DEFAULT '',
    nsfw INTEGER NOT NULL DEFAULT 0 CHECK (nsfw IN (0, 1)),
    parent_id INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES collections(id) ON DELETE CASCADE,
    CHECK (parent_id IS NULL OR kind = 'entry')
);

CREATE INDEX idx_collections_kind
ON collections(kind, parent_id, sort_order, id);

CREATE TABLE collection_entries (
    collection_id INTEGER NOT NULL,
    entry_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (collection_id, entry_id),
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_collection_entries_entry
ON collection_entries(entry_id);

CREATE TABLE collection_producers (
    collection_id INTEGER NOT NULL,
    producer_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (collection_id, producer_id),
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
    FOREIGN KEY (producer_id) REFERENCES producers(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_collection_producers_producer
ON collection_producers(producer_id);
