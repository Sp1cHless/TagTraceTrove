-- Rating slots are the shared, fully templated name set for one Gallery
-- (entries.type). 'entry' slots belong to one Gallery. 'producer' slots are
-- partitioned by the Author's dominant Gallery type, which is derived from
-- their works and never stored, so creating a slot automatically applies it
-- to every Author of the same dominant Gallery.
CREATE TABLE rating_slots (
    id INTEGER PRIMARY KEY,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('entry', 'producer')),
    entry_type TEXT NOT NULL CHECK (trim(entry_type) <> ''),
    name TEXT NOT NULL CHECK (trim(name) <> ''),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (subject_kind, entry_type, name)
);

CREATE INDEX idx_rating_slots_lookup
ON rating_slots(subject_kind, entry_type, sort_order, id);

-- One value per (slot, subject). stars NULL means the slot exists on the card
-- but is unrated (never treated as zero); otherwise 0.5..5 in half-star steps.
CREATE TABLE entry_rating_values (
    slot_id INTEGER NOT NULL,
    entry_id INTEGER NOT NULL,
    stars REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (slot_id, entry_id),
    CHECK (
        stars IS NULL
        OR (stars >= 0.5 AND stars <= 5 AND stars * 2 = CAST(stars * 2 AS INTEGER))
    ),
    FOREIGN KEY (slot_id) REFERENCES rating_slots(id) ON DELETE CASCADE,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_entry_rating_values_entry
ON entry_rating_values(entry_id);

CREATE TABLE producer_rating_values (
    slot_id INTEGER NOT NULL,
    producer_id INTEGER NOT NULL,
    stars REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (slot_id, producer_id),
    CHECK (
        stars IS NULL
        OR (stars >= 0.5 AND stars <= 5 AND stars * 2 = CAST(stars * 2 AS INTEGER))
    ),
    FOREIGN KEY (slot_id) REFERENCES rating_slots(id) ON DELETE CASCADE,
    FOREIGN KEY (producer_id) REFERENCES producers(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_producer_rating_values_producer
ON producer_rating_values(producer_id);
