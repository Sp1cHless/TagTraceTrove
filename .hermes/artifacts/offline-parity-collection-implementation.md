# Collection03 recovery — scoped count repair; offline BLOCKED

## Disposition

**Collection03 is NOT DONE. Source/test writer stopped at the excluded client/HTTP identity boundary. No04, protocol half-implementation, migration, deployment, APK, native change, or formal DB/assets/service access.**

Only production change: `apps/server/src/repositories/collection-repository.ts:429`, add `DISTINCT` to the existing common-tag member query. A Work linked to both parent and child is processed once, including already-present/skipped accounting. Transaction, scope (current folder + permitted direct children), Facet placement, deletion/cascade and Entry/Author behavior are unchanged. This repository permits one child-folder level; no speculative recursive traversal was introduced. `listCollectionEntryIds` is not present in current server source; no imagined helper was modified.

Existing test `apps/web/tests/offline-collection-parity.integration.test.ts` was backed up byte-for-byte at continuation start (7,911 bytes, SHA256 `141535cdd034c9e84b070916480c530df7b327b12e9a8d75f110e74343040c66`). Its two `it.fails.each` cases were converted to ordinary `it.each` assertions: offline obligations now produce **real RED**, not inverted expected-failure PASS. Online unique-Work expectations were not weakened. Both edits were preflighted together against full original bytes, exact SHA and unique anchors; original line endings preserved.

## Executed evidence

All new evidence is under `.hermes/tmp/offline-parity-collection/freshresume/`; old `before/`, sourceFreshBefore and parent recovery evidence were not overwritten. Vitest used the specified Node, maxWorkers2, testTimeout30000, Python subprocess timeout120 per gate, with raw JSON/log persisted immediately.

| Gate | Actual outcome | Meaning |
|---|---|---|
| Fresh pre-fix parity | exit1, 3 reported passed / 1 failed | Actual count RED; two reported passes are old inverted expected-failure cases, NOT offline implementation |
| Post-fix ordinary callers (`-t ordinary`, integration config) | exit0, 2 passed / 2 skipped | Actual CollectionsPage → facade → application HTTP → migrated memory SQL; first tag reports 2 affected / 0 already / 1 skipped; repeat and case-equivalent calls report 0 / 2 / 1 |
| Offline obligations (`-t BLOCKED`, integration config) | exit1, 2 failed / 2 skipped | Real facade still attempts `DELETE /api/collections/1` and `POST /api/collections/1/tags` in known-offline mode |
| Nearest collection repository + Gallery scope migration tests | exit0, 9 passed | No new migration written |
| CollectionsPage default-config tests | exit0, 26 passed | Existing caller regressions |
| Collection tree default-config tests | exit0, 2 passed | Existing tree regression |
| Final complete new parity file | exit1, 2 passed / 2 failed | Deliberately honest unresolved RED; not a green feature gate |
| Server typecheck | corrected command exit0 | First command targeted absent package-local TypeScript and failed MODULE_NOT_FOUND (harness failure); root `node_modules/typescript/bin/tsc -p apps/server/tsconfig.json --noEmit` passes |
| Web vue-tsc | exit0 | Earlier externally reported timer error is not reproduced now; no external repair performed |
| Scoped ESLint / git diff --check | exit0 / exit0 | Git emitted LF→CRLF checkout warning, not a diff error |

Online deletion caller continues to pass: two-step confirmation, folder/member cascade only, three Entries and Author/tag/link rows survive, peer membership survives. This is online proof only. No TCP, native Worker, physical phone or OS-lifecycle proof is claimed. Global suites/build/package intentionally not run. The new parity integration file is now RED when run unfiltered; do not conceal or promote its result.

## Exact cross-domain prerequisite

### Connected delete without an installed snapshot / object newer than the snapshot

* `packages/shared/src/schemas/api.ts:429–458`: strict `CollectionRecordDto`/`collectionRecordSchema` contain numeric id, kind, metadata, children and compact members/counts; **no syncUid/syncVersion**. Compact folder reads cannot authorize destructive replay. Adding identity fields to server output alone fails the current strict parser.
* `packages/shared/src/schemas/sync.ts:1216–1229`: snapshot Collection rows already carry optional syncUid/syncVersion. Absence in older saved copies is unknown, not guessed identity. Fetching the entire snapshot to obtain identity would violate the bounded/no-copy requirement.
* `apps/web/src/api/gallery.ts:438–439,1018–1023`: bounded identity methods exist for Entries and Authors only; **getCollectionSyncIdentity does not exist**. The facade spreads `...online` at `offline-api.ts:4471`, and has no deleteCollection/addCollectionTag overrides.
* `apps/server/src/http/app.ts:2026–2039`: `/api/producers/:producerId/sync-identity` and `/api/entries/:entryId/sync-identity` exist; there is **no Collection identity route**. Existing Collection DELETE at1074–1079 takes numeric ID and returns `{ok:true}`; it is not receipt-authorized exact replay.

To close no-copy deletion, a bounded authenticated Collection identity method/route must be added (proposed seam: `GalleryApi.getCollectionSyncIdentity(collectionId)` and `GET /api/collections/:collectionId/sync-identity`). Minimum trusted fields: libraryId, syncEpoch, numeric id, immutable syncUid, positive syncVersion; folder kind and owned child identities/scope are needed where cascade/base and predecessor authorization require them. The existing generic `syncEntryIdentitySchema` at shared sync58–63 already models the minimum identity fields; **a new migration or change to shared API DTO is not intrinsically required** if a dedicated method uses it. Alternatively extending the strict ordinary DTO still requires sharedapi + server response + client parser coordination.

Either route registers in excluded `http/app.ts` and requires a concrete method in excluded `api/gallery.ts`. A dedicated sync-server module cannot become reachable through the existing app/client contract by itself. Those are actual Collection business seams, not unrelated System drift. Therefore stop before writing replay protocol or local overrides. Numeric destructive fallback, guessed IDs/versions and whole-library prefetch are not alternatives.

### Common-tag closure: protocol choices remain explicit, not half-written

Current online method `api/gallery.ts:1294–1298` POSTs `{name}` to `/api/collections/:collectionId/tags`; handler `http/app.ts:1092–1099` invokes the repository in one SQL transaction and returns `{tagId, entriesAffected, alreadyPresent, skipped}`. It does not return stable Collection/member identities or a receipt. The whole-folder operation touches **Entry tag owners/vocabulary**, not only the Collection revision chain.

Two viable designs require explicit ownership/contract decisions:

1. Reuse `entry.tag.create` + `entry.tags.set` envelopes for snapshot-backed bulk staging. Resolve the unique projected current-folder/child Work set, Gallery placement, existing-name/case normalization, each Entry UID/version and complete base tag assignment. Stage ALL vocabulary/dependent member operations atomically; serial calls to `enqueueEntryTags` are unsafe: offline-api2629–2671 can enqueue vocabulary before the individual tag assignment and store only one operation at a time. OutboxStore29 exposes `enqueue(operation)`; IDB295–330 implements a single-row transaction. Existing atomic restore is not automatically a safe bulk mutation API. This design can reuse current kinds but does not by itself preserve one atomic online SQL command or close no-copy member/context acquisition.
2. Add a dedicated canonical bulk replay command. Specify target Collection UID/revision and frozen/validated descendant/member scope; include each Entry's own identity/version/base tags and vocabulary/Facet dependencies or define equally strict server derivation/conflict semantics. Bind the exact result/counters in durable receipt, including empty folders and skipped Galleries. Collection revision must never substitute for each distinct Entry version. Resolve connected no-copy scope through a bounded identity/member/context API (pages with a consistency token if needed), rather than compact covers or whole snapshot fetch. This also needs excluded concrete client/HTTP integration unless the ordinary DTO/queries are coherently extended.

**A new common-tag operation kind is not proven mandatory**: reuse is possible for a deliberately defined snapshot-backed slice. But implementing only that subset here would leave the shared no-copy boundary unresolved and atomic staging/response semantics unproven. No protocol design was silently chosen or partially written.

## Required remaining vertical cells (unimplemented/unverified)

* Strict `collection.delete` request union/server dispatch and capability: shared sync937–965 currently contains create/update/order/Entry/Producer membership only. Existing general offlineCollectionManagement flag (sync-service165) is not a destructive-delete or bulk-tag capability.
* Delete SQL mutation + receipt in one transaction, exact UUID/body retry even after owner absent, root/child tombstones and durable causal scope; retain Entries/Authors/tags/peer memberships. Existing migration028 and replacement037 already supply Collection UID/version, membership revision triggers, delete journal and tombstones (037432–438). **No new migration need demonstrated; do not edit028/037/042.**
* Projection/cold restart, pending/attempted predecessors, held child/membership dependencies and independent owner progress. Compare revisions only within one entity-kind/UID chain.
* Verified applied receipt + matching delete journal/scope + snapshot library/epoch/cursor coverage + durable ACK before cleanup; retain bound proof for ACK-loss cold exact retry, reject corrupted/foreign/noncausal proof. Snapshot absence alone is insufficient.
* Common-tag unique counts across duplicate membership, empty folder, blank rejection, case-existing/new vocabulary, per-Gallery majority/default placement, skipped structure, atomic durable failure with zero halfqueue, exact SQL result/counters and response-loss retry.
* Operation-specific capabilities independently false and absent, cold facade, zero business HTTP, original queued bytes retained. Current two negative tests prove the HTTP defect only; they do not prove positive enqueue/projection/replay.
* Export/atomic restore, reference reconciliation, planner/native generated contract and real Worker obligations if new kinds introduced. Native policies must retain originals and pending media/foreground causal predecessors. No native evidence was run in this recovery.

## Provenance / final handoff

Continuation-start hashes match all seven parent-provided production baselines. Before/after every focused test gate, all eight registered source/test files were hashed; no drift observed. Six registered production read-dependencies remain byte-identical: offline-api, CollectionsPage, api/gallery, http/app, sharedapi and sharedsync. Only repository query and expected-failure modifier changed. No whole-tree freeze or rollback occurred; externally dirty files were neither adopted nor edited.

Final full-byte manifest separates **owned working bytes** (repo/test/report) from **observed unchanged dependencies**. A source checkpoint is not a globally GREEN checkpoint: unresolved offline tests remain RED. Parent owns CURRENT/board reconciliation. Writer stopped after archive verification; no further feature expansion authorized by this report.
