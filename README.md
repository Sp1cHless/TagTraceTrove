# T³ — Tag · Trace · Trove

A lightweight, local-first, tag-first personal collection index.

## Current milestone

The SQLite schema, checksum-aware migration runner, database probe, read-only doctor, core repository layer, shared Zod API contracts, local HTTP routes, transactional canonical Import commit, and the Gallery/Entry/Author/Directory navigation foundation are implemented. Gallery is derived from `Entry.type`; there is no Gallery table. Entry Tag results and Producer Tag results remain separate. See `docs/current-architecture.md`, `docs/api-contracts.md`, `docs/http-api.md`, and `docs/import-commit.md`.

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
```

Run the localhost API with `pnpm start:server`, or `pnpm dev:server` in watch mode. The server applies migrations before listening and defaults to `127.0.0.1:8765` with `.data/library.db`.

The current repositories create and edit Entries and Producers, manage their many-to-many relation, manage Section/Facet layouts, assign both independent Tag vocabularies, search Producers through their own or related Entries' Tags, mutate ordered Entry Content, and compose complete Entry details. The product UI derives Gallery navigation from existing Entry types, creates new Galleries only by creating Entries with new types, and reads complete Entry details. Detail edit mode supports compact inline Section, Facet, and Tag addition, Tag removal, drag-and-drop, and assignment-scoped Tag rename by double-click. Entry Content can be added, edited, deleted, and reordered inline with move controls. Sections use dashed vertical stacking; Facets occupy a left label column beside their Tags, and only populated unnamed Facets visually expose direct Section Tags. Gallery filtering is deferred rather than listing the complete Tag vocabulary. No database-backed product page should bypass the migration → probe → integration test → doctor gate.
