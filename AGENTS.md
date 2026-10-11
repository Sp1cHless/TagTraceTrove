# T³ Agent Guardrails

T³ is a lightweight personal collection index.

For the live implementation boundary read `CURRENT.md`; unfinished offline features and grouped App acceptance are tracked in `docs/offline-completion-status.md`. These are operational status, not replacements for the guardrails below.

Current data model: Entry and Producer are the core subjects. `Entry.type` supplies classification. Collections (migration `010_collections.sql`) are lightweight user-curated folders of Entries or Producers — the only stored grouping subject; Gallery itself remains a read-time projection of `Entry.type`, never a table. Entry and Producer tags use separate vocabularies. Entry tags always belong to Facets, and Facets always belong to Sections of the same Entry type. See `docs/current-architecture.md`.

Product priorities:
1. fast daily use
2. tag-first navigation
3. local ownership
4. source independence
5. progressive complexity

Never introduce database-platform features without explicit request. Do not expose database terminology in normal UI. Do not add formula systems, generic tables, project management, PKM features, media playback, downloads, or web-wide crawling.

All schema changes require a new immutable migration. Never change the schema merely to simplify frontend code.

Existing source files must be edited with targeted patches. Never feed paginated, summarized or character-truncated `read_file` output into a full-file overwrite. For any justified whole-file transformation, read complete bytes directly from disk, save a byte-identical recovery copy first, assert the expected original anchors, and reject unexpected shrinkage before writing. Large dirty files must never be restored from HEAD without proving that no uncommitted work would be lost.

Before UI work that depends on new database behavior:
1. add/review the migration;
2. update `db:probe`;
3. add real-SQL integration tests;
4. run `db:doctor`;
5. only then implement UI.

Tests must never touch `.data/library.db`. Use isolated in-memory databases for repository behavior and temporary file databases for WAL, backups, migration fixtures, and corruption/doctor tests.

Provider matching must always be user-directed. Common actions should avoid dialogs.
