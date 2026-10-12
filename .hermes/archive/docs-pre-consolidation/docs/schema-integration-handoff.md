# Schema integration handoff

Website adapters intentionally do not persist anything. The reviewed mapping and transactional persistence boundary are implemented in `apps/server/src/import/commit.ts`; adapters still emit canonical data rather than database rows.

## Ready boundaries

- `packages/shared/src/schemas/import.ts` is the runtime-validated canonical import boundary. Website adapters emit `ImportBatch`; persistence must consume that type rather than website JSON.
- `apps/server/src/import/site-probe.ts` loads current 18comic, Hanime1, and Hitomi exports. It validates source documents, confines local media paths to the export root, and returns canonical entries.
- `apps/server/src/import/preview.ts` provides a database-free structural preview. Commit rejects duplicate normalized titles, duplicate external keys, and unreviewed fields or Producer matches.
- `packages/shared/src/schemas/import.ts` defines the reviewed Import mapping contract, and `apps/server/src/import/commit.ts` commits the complete batch in one transaction. See `docs/import-commit.md`.
- `apps/web/src/api/client.ts` is a generic JSON HTTP transport. Bind typed endpoint methods after API response schemas are finalized.
- `apps/web/src/stores/collection-filter.ts` is a legacy-named, schema-independent UI state core. Before product wiring, rename its Collection/Field vocabulary to Entry Type/Facet and translate public identifiers at the API boundary.

## Current site mapping

- 18comic: only `分类信息.分类标签` becomes canonical tags; works, characters, and authors remain candidate fields.
- Hanime1: accepted `tags` become canonical tags; raw tags remain a candidate field. The watch page is stored only as a source—no playback or download behavior is introduced.
- Hitomi: an author manifest is resolved through its explicit `items/<source_id>/metadata.json` references; type, language, date, and page count remain candidate fields.
- Baozimh has no export data yet, so no selectors or format were invented.

## Implemented persistence boundary

1. Candidate keys map only through an explicit reviewed mapping to Producers, Facets/Tags, Content labels, or `ignoredFields`.
2. Existing Producer links require explicit source-name → Producer-ID decisions; there is no automatic name matching.
3. External keys and source data are retained as Entry Content for provenance and duplicate detection.
4. A failed item rolls back the whole batch.
5. Real-SQL integration tests and `db:probe` cover commit and rollback behavior before product-page wiring.

## Commands

Dry-run without writing user data:

```text
pnpm import:site-probe <export-root>/metadata.json
```

Write a canonical, schema-neutral JSON artifact for review:

```text
pnpm import:site-probe <export-root>/metadata.json --output <canonical.json>
```

Commit a reviewed artifact:

```text
pnpm import:commit <canonical.json> <mapping.json> <database-path> --commit
```