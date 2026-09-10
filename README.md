# T³ — Tag · Trace · Trove

A lightweight, local-first, tag-first personal collection index.

## Current milestone

The desktop and mobile baseline is complete (2026-09), and the server-scaling phase now uses bounded Entry and Author-summary queries across the primary long-list views plus source-hash-addressed 512px WebP card thumbnails. Implemented beyond the original foundation: ratings (shared per-Gallery slots, filtering and sorting), usage tracking (views/likes with derived author aggregates and Recently viewed), SFW/NSFW Gallery partitions with the Show-NSFW preference, global search, View later, Collections (entry/producer folders with one-level nesting), formal Gallery template files consumed by import, author alias groups, author tag filters, random picks, and backup/restore tooling (`db:backup` / `db:restore`). Gallery is derived from `Entry.type`; there is no Gallery table. Entry Tag results and Producer Tag results remain separate. See `docs/current-architecture.md`, `docs/api-contracts.md`, `docs/http-api.md`, and `docs/import-commit.md`; pending work lives in `docs/roadmap.md`.

Schema-independent import and HTTP-client foundations are available in parallel. See `docs/schema-integration-handoff.md` for their connection points.

Run the product UI with `pnpm --filter @t3/web dev` after starting the local API. The earlier persistence-free visual components remain isolated test/sandbox building blocks; see `docs/ui-sandbox.md`.

## Prerequisites

- Node.js 22
- pnpm 10.15.0

## Quality gates

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
```

Database integration tests use real SQLite, never mocks and never `.data/library.db`:

- in-memory databases for fast schema/repository behavior;
- temporary file databases for WAL, backup, migration fixtures, and doctor tests.

## Database model and commands

- Entries are classified by `type` and relate many-to-many with Producers.
- Entry Tags and Producer Tags use separate vocabularies.
- Every Entry Tag points to a Facet; every Facet belongs to a Section of the same Entry type.
- Entry Content is outside the Section/Facet layout; Producer Content is a single short note.

```bash
pnpm db:probe
pnpm db:doctor [optional-database-path]
pnpm media:thumbnails
```

Run the localhost API with `pnpm start:server`, or `pnpm dev:server` in watch mode. The server applies migrations before listening and defaults to `127.0.0.1:8765` with `.data/library.db`.

The repositories cover Entries and Producers, their many-to-many relation, Section/Facet layouts, both independent Tag vocabularies, Producer search through own or related Entries' Tags, ordered Entry Content, ratings, usage, gallery partitions, collections, and complete Entry/Author details. The product UI derives Gallery navigation from existing Entry types — creating an Entry with a new type is the only way a Gallery appears — and composes Entry details with inline Section/Facet/Tag editing, drag-and-drop placement, and assignment-scoped Tag rename. No database-backed product page should bypass the migration → probe → integration test → doctor gate.
