# T³ architecture and implementation plan

> Current execution architecture. This document supersedes the earlier Collection/Field Definition/Typed Value plan.

## Goals and non-goals

T³ must keep daily use fast, tag-first, local-first, and source-independent. Core database behavior must be proven before product UI work. Do not introduce a generic schema builder, formula system, tables-as-product, project management, PKM, playback, downloads, or crawling.

## Runtime stack

```text
Frontend         Vue 3 + Vite + TypeScript
Backend          Node.js + TypeScript
Database         SQLite + better-sqlite3
Validation       Zod
Tests            Vitest
Package manager  pnpm 10.15.0
```

Only the backend accesses SQLite. Every normal writable connection enables foreign keys, WAL, normal synchronous mode, and a 5000 ms busy timeout.

## Core data model

There is no Collection table. `entries.type` supplies Entry classification.

```text
entries
producers
entry_producers                 Entry ↔ Producer

tags                           Entry-only vocabulary
tag_groups                     Section/Facet layout by Entry type
entry_tags                     Entry ↔ Tag, always assigned to a Facet

producer_tags                  Producer-only vocabulary
producer_tag_assignments       Producer ↔ Producer Tag

entry_contents                 ordered, layout-independent Entry content
producers.content              one Producer short review/note
```

Entry and Producer tag vocabularies must remain independent. Searching Producers by an Entry tag joins `tags → entry_tags → entry_producers → producers`; it does not copy the Entry tag into `producer_tags`.

## Section and Facet contract

`tag_groups` stores two kinds:

- Section: visible divider, no parent, non-empty name.
- Facet: child of a Section of the same `entry_type`.

Every `entry_tags.facet_id` is non-null and points to a matching Facet, never a Section. An empty Facet name represents the invisible/default Facet underneath a Section. In the product UI it still occupies the Facet label column but leaves that label blank, making its Tags appear directly under the Section without weakening the persistence invariant. A Tag has one assignment per Entry, so drag-and-drop placement is an update of `facet_id`.

SQLite triggers enforce the cross-row and cross-table invariants that CHECK and foreign-key constraints cannot express alone. `db:doctor` repeats those checks read-only for existing databases.

## Content contract

`entry_contents.content_type` is unrestricted text. The corresponding comment, URL, or other payload is in `content`; content rows do not belong to Sections or Facets. Producer layout is deliberately simpler and uses a scalar `producers.content` note.

## Migration system

- Migration files live under `apps/server/src/database/migrations/`.
- Applied versions, names, and SHA-256 checksums are stored in `schema_migrations`.
- A changed applied migration is rejected.
- Migrations become immutable after merge.
- Tests apply migrations only to memory or temporary databases.

## Required verification

```text
pnpm test
pnpm test:integration
pnpm db:probe
pnpm db:doctor
pnpm lint
pnpm typecheck
pnpm build
```

`db:probe` proves:

1. the schema migrates on real SQLite;
2. Entry/Producer many-to-many relations work;
3. unnamed and named Facets work;
4. Entry Tags can move only between matching Facets;
5. Producer Tags use a separate vocabulary;
6. Producers can be found through related Entry Tags;
7. arbitrary Entry content labels work;
8. canonical Import commit and the type-derived Gallery projection work;
9. per-Gallery Entry Tag usage aggregation works;
10. doctor invariants are clean.

No database-backed product UI is valid until these gates pass.

## Implementation order

1. Keep `001_initial.sql`, repositories, probe, doctor, and integration tests aligned.
2. Keep Entry/Producer writes, both Tag vocabularies, Content mutation, and complete Entry reads behind repositories.
3. Keep the finalized shared API schemas and implemented HTTP routes aligned with repositories.
4. Keep canonical Import mapping and transactional commit aligned with repositories.
5. Extend the implemented type-derived Gallery and Entry pages with tag-first editing and filtering.
6. Add backup, restore, and corruption fixtures before handling durable user data.

The authoritative product model is also summarized in `docs/current-architecture.md`.
