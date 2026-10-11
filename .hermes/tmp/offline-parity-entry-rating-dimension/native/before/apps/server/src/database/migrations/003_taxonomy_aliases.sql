CREATE TABLE taxonomy_aliases (
    id INTEGER PRIMARY KEY,
    vocabulary TEXT NOT NULL CHECK (vocabulary IN ('entry', 'producer')),
    alias_name TEXT NOT NULL CHECK (trim(alias_name) <> ''),
    normalized_alias TEXT NOT NULL CHECK (trim(normalized_alias) <> ''),
    canonical_name TEXT NOT NULL CHECK (trim(canonical_name) <> ''),
    normalized_canonical TEXT NOT NULL CHECK (trim(normalized_canonical) <> ''),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (vocabulary, normalized_alias)
);

CREATE INDEX idx_taxonomy_aliases_canonical
ON taxonomy_aliases(vocabulary, normalized_canonical);
