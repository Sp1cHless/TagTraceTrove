# Architecture Decision Records

Create one reviewed ADR per durable architectural decision. Initial ADRs should cover SQLite, the TypeScript monorepo, no full ORM, **dropping the old typed Collection entity in favour of a read-time Gallery projection (note: `collections` today are the separate user-curated folders of Entries/Producers, §11 of `architecture.md`)**, Entry-type Section/Facet layouts, separate Entry/Producer tag vocabularies, Gallery-first UX, and archive-before-delete.
