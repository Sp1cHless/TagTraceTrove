# Transactional Import commit

`commitImportBatch(database, batch, mapping)` is the persistence boundary between canonical website exports and the Entry/Producer model. Website adapters remain database-free.

## Safety model

- The new portion of a batch commits in one SQLite transaction. Any invalid mapping, missing reviewed Producer match, constraint failure, or duplicate Source URL inside the incoming manifest rolls back all new writes.
- Candidate `fields` are never guessed. Every field present in the batch must appear in `fieldMappings` or `ignoredFields`.
- Existing Producers are linked only through explicit `existingProducerIds` entries supplied by the user.
- `createUnmatched: true` explicitly permits new Producers for source values that have no reviewed match. The service never automatically matches an existing Producer by name.
- Canonical Tags and mapped Tag fields require explicit Facet IDs belonging to the selected Entry type.
- Re-imports are idempotent by clean Source URL: Entries whose Source URL already exists are skipped, while new Entries in the same author manifest still commit. Duplicate Source URLs inside one incoming manifest are rejected as malformed input.
- Each new Entry retains provenance as exactly one clean Source URL Content row; external keys and raw source/body payloads remain transient import metadata.

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
  "ignoredFields": ["works"],
  "authorRatings": [
    { "name": "Source Author", "slotName": "画风精美", "stars": 4 }
  ]
}
```

A source can name one thing as both a series and a character: a multi-series art collection lists `Goblin Slayer` under `作品` and `登场人物` at once. The same tag cannot sit in two Facets of one Entry, so the commit keeps the first placement (the Entry's own tags first, then the mapped fields in order, with the tag's established gallery placement winning for both) and reports the skipped placement in `importCommitResultSchema.warnings` instead of failing the whole import. The batch review view lists those notes under its notice; the Add Entry page is already gone by then, which is why the review — not the page that ran the import — is where they are shown.

`authorRatings` records what the review decided about the imported Authors rather than about each work, because a bulk import cannot judge thousands of works while an Author score is one decision per name. Each entry names an Author from an entry's `authors` field plus one rating dimension; the dimension must already exist as an Entry rating slot of the import Gallery, and the server mirrors it onto the Author's own rating partition by name. These ratings are written inside the same transaction as the Entries, Producers, and links the import creates, so a failed import leaves no Author rating behind, and re-committing a batch (where every work is skipped as already imported) upserts the same values instead of duplicating them. `importCommitResultSchema.authorRatingCount` reports how many were written.

Producer mapping choices are per candidate field:

- `existingProducerIds` maps a source string to a reviewed Producer ID.
- `createUnmatched: false` stops the import if an encountered string has no reviewed ID.
- `createUnmatched: true` creates new Producers for unmatched strings and reuses those newly created records within the same batch.

Producer names additionally resolve through the `producer` taxonomy vocabulary, exactly like Entry tags resolve through `entry`: an imported alias spelling (`bob`) links to or creates the canonical author (`鲍勃`). Both the reviewed map keys and the created Producer names use the resolved canonical spelling, so dictionary-driven author merges survive future imports of any spelling. The link side of that promise is also enforced server-side: when the resolved canonical name already exists as a Producer, the import links to that row instead of creating a second one, whether or not the review preselected it (a work credited to `冷泉` lands on the existing `和泉`). A Producer named after the canonical is created only when no such row exists yet. See `merge:authors` below.

## Merging duplicate / dictionary-equivalent authors

`pnpm merge:authors [<library.db path>] [--dry-run|--commit]` (default path `apps/server/.data/library.db`) merges Producers in three passes:

1. Identical normalized names (NFKC, trimmed, collapsed whitespace, lowercased).
2. Spelling variants, where `_`, `-`, and `.` count as whitespace, so `arai_kazuki` and `Arai Kazuki` are one Author. This looser key is local to merge detection: `normalizeTag` itself keeps its stricter meaning for tag dedupe, import field keys, and dictionary lookups, so imports still match names exactly as before.
3. Names that resolve through the `producer` taxonomy vocabulary to a different canonical name (`bob` -> `鲍勃`) merge under that canonical name; a lone alias-spelled Producer is renamed to its dictionary canonical.

Each group collapses to the row with the most linked works; on equal work counts the separator-free spelling becomes the display name, and the lowest id breaks any remaining tie.

Works (`entry_producers`), Producer tags, Author rating values, and directories transfer to the survivor (an absorbed rating value fills only a slot the survivor never rated); values left dangling by an earlier run that deleted their producer are dropped, because they can no longer be read or edited and only trip the integrity checks; same-title directories absorb each other's works and colliding directory memberships deduplicate in the keeper's favour. The run first writes a `<db>.merge-backup-<timestamp>` snapshot, executes inside one transaction with foreign keys temporarily disabled (composite-FK re-pointing order), then re-enables them and verifies `PRAGMA foreign_key_check` plus the doctor invariants. Dry-run (default) writes nothing. The alternates sub-label shown under author names in the UI is derived from the same taxonomy rows at render time — no schema change. The same plan/execute logic is exposed in the UI (Settings → Advanced editing → Author merge) via `POST /api/producers/merge/plan` and `POST /api/producers/merge`.

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

A Hitomi author manifest is a list of work ids, and one unusable entry must not block the folder. A work whose `items/<id>/metadata.json` is absent (an interrupted extraction leaves the id behind) is skipped and reported in the batch's `warnings`, which the review section lists as skipped items; the remaining works still preview and commit. A work that is present but does not match the export schema is still refused, and the error names both the work id and the offending field instead of collapsing into a generic validation failure. Source metadata is read tolerantly where a site simply has no value: an unknown `language` (`null` code and/or name, or the key omitted) imports as a work without a Language Facet value rather than as a malformed export.

The mapping is prefilled automatically from the selected Entry type's shared layout (the layout created by template Entries of that type). Import type input is resolved against existing Gallery types with NFKC, trimming, and case-insensitive comparison, so selecting or typing `hentai` reuses the persisted `Hentai` type and its Hentai template layout instead of creating/querying a separate lowercase type. The `分类标签` tags land in the Tags Section's canonical Facet, while `作品`→Series, `登场人物`→Characters, `作品类型`→Type, and `language`→Language Facets are matched by normalized Facet name, and `作者` becomes a Producer. Fields whose selected template has no matching Facet remain explicitly ignored. Comic remains the initial default when present, but changing the import type immediately reloads and remaps against that type's layout; batch import uses the same type resolution.

The review never rates individual works. Bulk imports cannot judge every work, and a uniform score across a batch is wrong because works by one Author differ, so the review instead offers per-Author ratings: each Author row in the review's Author section carries an `implement rating` checkbox, and only ticking it reveals that Author's rating dimensions. Values are keyed by Author name and re-sent by every commit in a batch run, so one reviewed decision covers the whole run. Choosing a batch folder previews its first work so those Author rows exist before the run starts; while the batch dialog is open the review shows a hint instead of its own single-work commit button, because the batch button commits the run.

When an imported Entry's meta carries no series information (and nothing was entered), the commit auto-assigns an `Original` tag under the Gallery's `Series` facet (matched by normalized facet name); Entries that do carry a series tag are untouched, and Galleries without a Series facet are skipped.

Every imported Entry stores exactly one Content row, a clean `Source URL` equal to the source `detail_url`. External keys, raw source objects, bodies, and mapped field Content are no longer written as Content. Re-import detection is keyed only by that clean Source URL: existing Entries are left untouched and reported through `skippedExistingEntryCount`; normalized titles are not identities. Because skipped records make response indexes diverge from manifest indexes, post-commit media matching uses `externalKey`, never array position.
