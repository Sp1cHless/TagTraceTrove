# T³ Agent Guardrails

T³ is a lightweight personal collection index.

Current data model: Entry and Producer are the core subjects. `Entry.type` supplies classification. Collections (migration `010_collections.sql`) are lightweight user-curated folders of Entries or Producers — the only stored grouping subject; Gallery itself remains a read-time projection of `Entry.type`, never a table. Entry and Producer tags use separate vocabularies. Entry tags always belong to Facets, and Facets always belong to Sections of the same Entry type. See `docs/current-architecture.md`.

Product priorities:
1. fast daily use
2. tag-first navigation
3. local ownership
4. source independence
5. progressive complexity

Never introduce database-platform features without explicit request. Do not expose database terminology in normal UI. Do not add formula systems, generic tables, project management, PKM features, media playback, downloads, or web-wide crawling.

All schema changes require a new immutable migration. Never change the schema merely to simplify frontend code.

Before UI work that depends on new database behavior:
1. add/review the migration;
2. update `db:probe`;
3. add real-SQL integration tests;
4. run `db:doctor`;
5. only then implement UI.

Tests must never touch `.data/library.db`. Use isolated in-memory databases for repository behavior and temporary file databases for WAL, backups, migration fixtures, and corruption/doctor tests.

Provider matching must always be user-directed. Common actions should avoid dialogs.
