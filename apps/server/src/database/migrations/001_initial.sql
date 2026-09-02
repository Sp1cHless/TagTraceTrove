CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK (trim(type) <> ''),
    cover_ref TEXT,
    preview_ref TEXT,
    upload_date TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_entries_type_title
ON entries(type, title);

CREATE TABLE producers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    occupation TEXT,
    artwork_ref TEXT,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_producers_name
ON producers(name);

CREATE TABLE entry_producers (
    entry_id INTEGER NOT NULL,
    producer_id INTEGER NOT NULL,
    PRIMARY KEY (entry_id, producer_id),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY (producer_id) REFERENCES producers(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_entry_producers_producer
ON entry_producers(producer_id, entry_id);

-- Entry tags and producer tags intentionally use separate vocabularies.
CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE producer_tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Sections are visual dividers. Tag assignments always target a facet.
-- A facet with an empty name is the invisible/default facet for its section.
CREATE TABLE tag_groups (
    id INTEGER PRIMARY KEY,
    entry_type TEXT NOT NULL CHECK (trim(entry_type) <> ''),
    name TEXT NOT NULL DEFAULT '',
    group_kind TEXT NOT NULL CHECK (group_kind IN ('section', 'facet')),
    parent_id INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES tag_groups(id) ON DELETE CASCADE,
    CHECK (
        (group_kind = 'section' AND parent_id IS NULL AND trim(name) <> '') OR
        (group_kind = 'facet' AND parent_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_tag_groups_section_name
ON tag_groups(entry_type, name)
WHERE group_kind = 'section';

CREATE UNIQUE INDEX uq_tag_groups_facet_name
ON tag_groups(parent_id, name)
WHERE group_kind = 'facet';

CREATE INDEX idx_tag_groups_layout
ON tag_groups(entry_type, group_kind, parent_id, sort_order);

CREATE TRIGGER tag_groups_facet_parent_insert
BEFORE INSERT ON tag_groups
WHEN NEW.group_kind = 'facet'
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM tag_groups AS parent
        WHERE parent.id = NEW.parent_id
          AND parent.group_kind = 'section'
          AND parent.entry_type = NEW.entry_type
    ) THEN RAISE(ABORT, 'facet parent must be a section of the same entry type') END;
END;

CREATE TRIGGER tag_groups_facet_parent_update
BEFORE UPDATE OF parent_id, group_kind, entry_type ON tag_groups
WHEN NEW.group_kind = 'facet'
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM tag_groups AS parent
        WHERE parent.id = NEW.parent_id
          AND parent.group_kind = 'section'
          AND parent.entry_type = NEW.entry_type
    ) THEN RAISE(ABORT, 'facet parent must be a section of the same entry type') END;
END;

CREATE TRIGGER tag_groups_section_with_facets_update
BEFORE UPDATE OF group_kind, entry_type ON tag_groups
WHEN OLD.group_kind = 'section'
 AND (NEW.group_kind <> 'section' OR NEW.entry_type <> OLD.entry_type)
 AND EXISTS (SELECT 1 FROM tag_groups WHERE parent_id = OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'move or remove section facets before changing the section kind or entry type');
END;

CREATE TABLE entry_tags (
    entry_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    facet_id INTEGER NOT NULL,
    PRIMARY KEY (entry_id, tag_id),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
    FOREIGN KEY (facet_id) REFERENCES tag_groups(id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_entry_tags_tag
ON entry_tags(tag_id, entry_id);

CREATE INDEX idx_entry_tags_facet
ON entry_tags(facet_id, entry_id);

CREATE TRIGGER entry_tags_facet_insert
BEFORE INSERT ON entry_tags
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM entries AS entry
        JOIN tag_groups AS facet
          ON facet.id = NEW.facet_id
         AND facet.group_kind = 'facet'
         AND facet.entry_type = entry.type
        WHERE entry.id = NEW.entry_id
    ) THEN RAISE(ABORT, 'entry tag must target a facet of the entry type') END;
END;

CREATE TRIGGER entry_tags_facet_update
BEFORE UPDATE OF entry_id, facet_id ON entry_tags
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM entries AS entry
        JOIN tag_groups AS facet
          ON facet.id = NEW.facet_id
         AND facet.group_kind = 'facet'
         AND facet.entry_type = entry.type
        WHERE entry.id = NEW.entry_id
    ) THEN RAISE(ABORT, 'entry tag must target a facet of the entry type') END;
END;

CREATE TRIGGER entries_type_with_tags_update
BEFORE UPDATE OF type ON entries
WHEN EXISTS (
    SELECT 1
    FROM entry_tags AS assignment
    JOIN tag_groups AS facet ON facet.id = assignment.facet_id
    WHERE assignment.entry_id = OLD.id
      AND facet.entry_type <> NEW.type
)
BEGIN
    SELECT RAISE(ABORT, 'move entry tags before changing the entry type');
END;

CREATE TRIGGER assigned_facet_update
BEFORE UPDATE OF group_kind, entry_type ON tag_groups
WHEN EXISTS (
    SELECT 1
    FROM entry_tags AS assignment
    JOIN entries AS entry ON entry.id = assignment.entry_id
    WHERE assignment.facet_id = OLD.id
      AND (NEW.group_kind <> 'facet' OR NEW.entry_type <> entry.type)
)
BEGIN
    SELECT RAISE(ABORT, 'assigned tag group must remain a facet of the entry type');
END;

CREATE TABLE producer_tag_assignments (
    producer_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (producer_id, tag_id),
    FOREIGN KEY (producer_id) REFERENCES producers(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES producer_tags(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_producer_tag_assignments_tag
ON producer_tag_assignments(tag_id, producer_id);

CREATE TABLE entry_contents (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
);

CREATE INDEX idx_entry_contents_entry
ON entry_contents(entry_id, sort_order, id);