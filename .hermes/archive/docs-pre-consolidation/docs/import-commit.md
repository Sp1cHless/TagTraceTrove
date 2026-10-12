# Transactional Import commit

`commitImportBatch(database, batch, mapping)` is the persistence boundary between canonical website exports and the Entry/Producer model. Website adapters remain database-free.

## Safety model

- The new portion of a batch commits in one SQLite transaction. Any invalid mapping, missing reviewed Producer match, constraint failure, duplicate Source URL, or repeated site work id inside the incoming manifest rolls back all new writes.
- Candidate `fields` are never guessed. Every field present in the batch must appear in `fieldMappings` or `ignoredFields`.
- Existing Producers are linked only through explicit `existingProducerIds` entries supplied by the user.
- `createUnmatched: true` explicitly permits new Producers for source values that have no reviewed match. The service never automatically matches an existing Producer by name.
- Canonical Tags and mapped Tag fields require explicit Facet IDs belonging to the selected Entry type.
- Re-imports are idempotent by clean Source URL and by the retained site work id behind it: an Entry whose Source URL already exists is skipped, and a work the library already holds under the same site id is skipped even when the site has re-spelled its URL. New Entries in the same author manifest still commit.
- Each new Entry retains provenance as exactly one clean Source URL Content row. Raw source/body payloads stay out of Content, but a `site:workId` external key is no longer purely transient: its site id is filed into `site_works` (see *Sites, work ids, and update cursors*) as the work's durable identity.

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

## Sites, work ids, and update cursors

A site_probe export folder is deleted once its works are in, so nothing on disk remembers what a folder or author already contained. The library remembers instead, in two tables added by `021_site_crawl_state.sql`:

- `site_works` — one row per `(site, workId)`, pointing at the Entry the work became. This is the "have we already ingested hitomi work 3220586?" map. It is what lets a later run skip works whose export file no longer exists, and it survives the source re-spelling its own URLs.
- `site_crawl_sources` — one row per crawled listing (`artist`, `folder`, `work`, or `search`), carrying `last_seen_source_id` / `last_seen_work_date` / `last_seen_order_key`: the newest work already held for that listing. The next run reads the cursor and re-lists only what sorts after it, instead of walking the whole folder again.

Work identity is global per site while the cursor is per listing, because one work legitimately arrives from several listings (an artist folder and a collection folder both list it). Neither table joins the sync allowlist: they describe the local crawl, not the curated library.

A batch declares which listing it came from through an optional `origin`, and the export declares it in snake_case beside `source_site`:

```json
{
  "source_site": "hitomi.la",
  "origin": { "kind": "folder", "ref": "folder-42", "display_name": "Folder 42" },
  "items": ["3220586", "3220587"]
}
```

The site itself is `batch.source`, so an origin only names the listing. It is optional: a hand-made manifest belongs to no tracked listing, so it leaves work ids but records no cursor. When an origin is present the commit files every work it carried — newly created **and** already held — under its site id, and advances that listing's cursor. Filing the skip path too means re-running one export over an existing library backfills ids for works imported before this table existed.

Cursor order is a single comparable string built from `(workDate, workId)`: the date when the source published one, padded numeric ids so `9` sorts before `10`. It only ever moves forward, so a re-crawl that returns nothing new, or an older page fetched out of order, cannot pull it back. A work the site published without a date sorts before every dated work, so an undated row can never advance a cursor past real dated works; a listing that mixes the two falls back to the exact membership check below.

The crawler reads and reports this through one command, which prints JSON on stdout and applies outstanding migrations first:

```text
pnpm import:cursor status --site hitomi.la --kind folder --ref folder-42 [--db <path>]
pnpm import:cursor filter --site hitomi.la (--ids 100,120 | --ids-file folder.json) [--db <path>]
pnpm import:cursor list   [--site hitomi.la] [--db <path>]
pnpm import:cursor set    --site hitomi.la --kind artist --ref some-artist \
                          [--source-id 3220586] [--work-date 2026-08-01] --commit
```

`filter` is the exact answer for a site whose ids carry no usable order: list the folder, ask, and fetch only the ids it reports as `unknown`. Its `--ids-file` accepts a bare JSON array, a hitomi-shaped `{"items": [...]}` manifest, or one id per line. Only `set` writes, and it requires `--commit`; the others never modify the library. `--db` defaults to `apps/server/.data/library.db` under the repo root.

## Web workflow

The Add Entry page accepts either a complete `site_probe` manifest root or a directly selected single-item folder from any supported adapter (`hitomi.la`, `18comic.vip`, or `hanime1.me`). For direct item folders, canonical media paths such as `items/<id>/cover/...` and `items/<id>/previews/...` are relativized to `cover/...` and `previews/...`; unrelated files such as `raw.html`, diagnostics, and source-specific auxiliary metadata do not participate in parsing. The folder is read recursively and its relative paths (`webkitRelativePath`) are preserved; local cover and preview image files are uploaded to the created Entries after the database transaction succeeds.

A Hitomi author manifest is a list of work ids, and one unusable entry must not block the folder. A work whose `items/<id>/metadata.json` is absent (an interrupted extraction leaves the id behind) is skipped and reported in the batch's `warnings`, which the review section lists as skipped items; the remaining works still preview and commit. A work that is present but does not match the export schema is still refused, and the error names both the work id and the offending field instead of collapsing into a generic validation failure. Source metadata is read tolerantly where a site simply has no value: an unknown `language` (`null` code and/or name, or the key omitted) imports as a work without a Language Facet value rather than as a malformed export.

The mapping is prefilled automatically from the selected Entry type's shared layout (the layout created by template Entries of that type). Import type input is resolved against existing Gallery types with NFKC, trimming, and case-insensitive comparison, so selecting or typing `hentai` reuses the persisted `Hentai` type and its Hentai template layout instead of creating/querying a separate lowercase type. The `分类标签` tags land in the Tags Section's canonical Facet, while `作品`→Series, `登场人物`→Characters, `作品类型`→Type, and `language`→Language Facets are matched by normalized Facet name, and `作者` becomes a Producer. Fields whose selected template has no matching Facet remain explicitly ignored. Comic remains the initial default when present, but changing the import type immediately reloads and remaps against that type's layout; batch import uses the same type resolution.

The review never rates individual works. Bulk imports cannot judge every work, and a uniform score across a batch is wrong because works by one Author differ, so the review instead offers per-Author ratings: each Author row in the review's Author section carries an `implement rating` checkbox, and only ticking it reveals that Author's rating dimensions. Values are keyed by Author name and re-sent by every commit in a batch run, so one reviewed decision covers the whole run. Choosing a batch folder previews its first work so those Author rows exist before the run starts; while the batch dialog is open the review shows a hint instead of its own single-work commit button, because the batch button commits the run.

When an imported Entry's meta carries no series information (and nothing was entered), the commit auto-assigns an `Original` tag under the Gallery's `Series` facet (matched by normalized facet name); Entries that do carry a series tag are untouched, and Galleries without a Series facet are skipped.

Every imported Entry stores exactly one Content row, a clean `Source URL` equal to the source `detail_url`. Raw source objects, bodies, and mapped field Content are no longer written as Content. Re-import detection is keyed by that clean Source URL first and by the retained site work id in `site_works` second: existing Entries are left untouched and reported through `skippedExistingEntryCount`; normalized titles are not identities. Because skipped records make response indexes diverge from manifest indexes, post-commit media matching uses `externalKey`, never array position.
