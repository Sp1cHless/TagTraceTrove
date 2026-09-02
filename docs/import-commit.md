# Transactional Import commit

`commitImportBatch(database, batch, mapping)` is the persistence boundary between canonical website exports and the Entry/Producer model. Website adapters remain database-free.

## Safety model

- The entire batch commits in one SQLite transaction. Any invalid mapping, missing reviewed Producer match, constraint failure, or duplicate rolls back all writes.
- Candidate `fields` are never guessed. Every field present in the batch must appear in `fieldMappings` or `ignoredFields`.
- Existing Producers are linked only through explicit `existingProducerIds` entries supplied by the user.
- `createUnmatched: true` explicitly permits new Producers for source values that have no reviewed match. The service never automatically matches an existing Producer by name.
- Canonical Tags and mapped Tag fields require explicit Facet IDs belonging to the selected Entry type.
- Duplicate normalized titles within an Entry type and duplicate stored external keys are rejected.
- The canonical external key, source objects, body, and mapped field Content are retained as ordered Entry Content. Structured values are stored as JSON text.

## Mapping shape

```json
{
  "entryType": "comic",
  "canonicalTagFacetId": 7,
  "sourceContentType": "source url",
  "externalKeyContentType": "external key",
  "bodyContentType": "body",
  "fieldMappings": {
    "authors": {
      "kind": "producer",
      "createUnmatched": false,
      "existingProducerIds": {
        "Source Author": 12
      }
    },
    "characters": {
      "kind": "tag",
      "facetId": 8
    },
    "language": {
      "kind": "content",
      "contentType": "language"
    }
  },
  "ignoredFields": ["works"]
}
```

Producer mapping choices are per candidate field:

- `existingProducerIds` maps a source string to a reviewed Producer ID.
- `createUnmatched: false` stops the import if an encountered string has no reviewed ID.
- `createUnmatched: true` creates new Producers for unmatched strings and reuses those newly created records within the same batch.

Producer names additionally resolve through the `producer` taxonomy vocabulary, exactly like Entry tags resolve through `entry`: an imported alias spelling (`bob`) links to or creates the canonical author (`鲍勃`). Both the reviewed map keys and the created Producer names use the resolved canonical spelling, so dictionary-driven author merges survive future imports of any spelling. See `merge:authors` below.

## Merging duplicate / dictionary-equivalent authors

`pnpm merge:authors [<library.db path>] [--dry-run|--commit]` (default path `apps/server/.data/library.db`) merges Producers in two passes:

1. Identical normalized names (NFKC, trimmed, collapsed whitespace, lowercased) collapse to the row with the most linked works (lowest id wins ties).
2. Names that resolve through the `producer` taxonomy vocabulary to a different canonical name (`bob` -> `鲍勃`) merge under that canonical name; a lone alias-spelled Producer is renamed to its dictionary canonical.

Works (`entry_producers`), Producer tags, and directories transfer to the survivor; same-title directories absorb each other's works and colliding directory memberships deduplicate in the keeper's favour. The run first writes a `<db>.merge-backup-<timestamp>` snapshot, executes inside one transaction with foreign keys temporarily disabled (composite-FK re-pointing order), then re-enables them and verifies `PRAGMA foreign_key_check` plus the doctor invariants. Dry-run (default) writes nothing. The alternates sub-label shown under author names in the UI is derived from the same taxonomy rows at render time — no schema change. The same plan/execute logic is exposed in the UI (Settings → Advanced editing → Author merge) via `POST /api/producers/merge/plan` and `POST /api/producers/merge`.

## Commit command

First produce and review a canonical artifact:

```text
pnpm import:site-probe <export-root>/metadata.json --output <canonical.json>
```

Then prepare the mapping JSON against the target database's Entry type, Facets, and reviewed Producer IDs. Commit requires both an explicit database path and the final `--commit` acknowledgement:

```text
pnpm import:commit <canonical.json> <mapping.json> <database-path> --commit
```

The command applies outstanding immutable migrations, validates both JSON documents, commits once, and prints only the created IDs and aggregate counts. Omitting `--commit` performs no database write.

## Web workflow

The Add Entry page accepts either a complete `site_probe` manifest root or a directly selected single-item folder from any supported adapter (`hitomi.la`, `18comic.vip`, or `hanime1.me`). For direct item folders, canonical media paths such as `items/<id>/cover/...` and `items/<id>/previews/...` are relativized to `cover/...` and `previews/...`; unrelated files such as `raw.html`, diagnostics, and source-specific auxiliary metadata do not participate in parsing. The folder is read recursively and its relative paths (`webkitRelativePath`) are preserved; local cover and preview image files are uploaded to the created Entries after the database transaction succeeds.

The mapping is prefilled automatically from the selected Entry type's shared layout (the layout created by template Entries of that type). Import type input is resolved against existing Gallery types with NFKC, trimming, and case-insensitive comparison, so selecting or typing `hentai` reuses the persisted `Hentai` type and its Hentai template layout instead of creating/querying a separate lowercase type. The `分类标签` tags land in the Tags Section's canonical Facet, while `作品`→Series, `登场人物`→Characters, `作品类型`→Type, and `language`→Language Facets are matched by normalized Facet name, and `作者` becomes a Producer. Fields whose selected template has no matching Facet remain explicitly ignored. Comic remains the initial default when present, but changing the import type immediately reloads and remaps against that type's layout; batch import uses the same type resolution.

Every imported Entry stores exactly one Content row, a clean `Source URL` equal to the source `detail_url`. External keys, raw source objects, bodies, and mapped field Content are no longer written as Content; duplicate detection and cross-batch re-import rejection are keyed by that same clean Source URL (plus the normalized title).
