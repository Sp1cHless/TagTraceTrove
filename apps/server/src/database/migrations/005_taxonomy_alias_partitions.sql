-- 005_taxonomy_alias_partitions.sql
-- taxonomy_aliases gains a `partition` label (dictionary category such as
-- series / characters / types / tags / authors) and may hold placeholder rows
-- whose canonical name is empty: dictionary imports record every name they
-- contain, filled (bob -> 鲍勃) and still-unfilled (alice -> '') alike, so the
-- user can complete the blanks later in the UI. Resolution ignores
-- placeholder rows until a canonical name is filled in.

CREATE TABLE taxonomy_aliases_v005 (
    id INTEGER PRIMARY KEY,
    vocabulary TEXT NOT NULL CHECK (vocabulary IN ('entry', 'producer')),
    partition TEXT NOT NULL DEFAULT '',
    alias_name TEXT NOT NULL CHECK (trim(alias_name) <> ''),
    normalized_alias TEXT NOT NULL CHECK (trim(normalized_alias) <> ''),
    canonical_name TEXT NOT NULL DEFAULT '',
    normalized_canonical TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (vocabulary, normalized_alias)
);

INSERT INTO taxonomy_aliases_v005 (
    id, vocabulary, partition, alias_name, normalized_alias,
    canonical_name, normalized_canonical, created_at, updated_at
)
SELECT
    id, vocabulary, '', alias_name, normalized_alias,
    canonical_name, normalized_canonical, created_at, updated_at
FROM taxonomy_aliases;

DROP TABLE taxonomy_aliases;
ALTER TABLE taxonomy_aliases_v005 RENAME TO taxonomy_aliases;

CREATE INDEX idx_taxonomy_aliases_canonical
ON taxonomy_aliases(vocabulary, normalized_canonical);

CREATE INDEX idx_taxonomy_aliases_partition
ON taxonomy_aliases(vocabulary, partition, normalized_alias);
