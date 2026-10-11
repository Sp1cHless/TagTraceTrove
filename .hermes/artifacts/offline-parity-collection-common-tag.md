# Collection ordinary common-tag — prerequisite/actual-caller RED handoff

## Honest status

**NOT IMPLEMENTED / NOT COMPLETE. This is a prerequisite checkpoint, not the requested eight-class GREEN vertical. Production source was not changed. No first-GREEN common-tag implementation exists.** The real ordinary caller still sends `POST /api/collections/1/tags` while known offline. Do not mark Collection03 DONE or promote this archive to completed common-tag coverage.

The run completed prerequisite inspection, retained the existing genuine RED, added a dedicated actual CollectionsPage RED tracer, and executed an actual SQL counterexample showing that a loop of existing Entry envelopes is not atomic bulk replay. It stopped before writing a partial shared/client/server protocol. This does not claim an external authorization/tool blocker: implementation remains work to do.

## Actual execution

Evidence: `.hermes/tmp/offline-parity-collection/common-tag/`.

| Gate | Actual result | Meaning |
|---|---|---|
| `fresh-caller-red.json` | success false; 2 passed / 1 failed / 0 pending | Existing parity file unchanged; failure is attempted ordinary POST in known-offline mode |
| `actual-caller-red.json` | success false; 0 passed / 1 failed / 0 pending | New ordinary CollectionsPage form → real facade failure, not an inverted `it.fails` or helper-only test |
| `caller-and-prerequisite-sealed-red.json` | success false; 1 passed / 1 failed / 0 pending | Caller still RED. PASS is prerequisite counterexample, NOT common-tag first-GREEN |
| `protected-delete-25.json` | success true; 25 passed / 0 failed / 0 pending | Existing delete21 + origin4 preserved and exercised |
| `web-types-final-execution.json` | exit0 | Final new test compiles with actual GalleryApi signatures |
| `new-test-lint-final-execution.json` | exit0 | Exclusive new test lint |
| `owned-diff-check.json` | exit0 | Scoped tracked diff check; new untracked test also compiled/linted |

All Node/gates used the specified absolute Node exe with Python stdlib `subprocess.run`, stdout/stderr captured, explicit argv/cwd and 120/180-second timeouts; no terminal, shell, TCP or formal service was used. The tests use fake-IDB and application `app.request` over migrated in-memory SQLite with explicit temporary data/assets directories. No Native/phone/OS durability claim.

## Prerequisite decision grounded in existing production

1. `OutboxStore` offers single-row `enqueue`, not `enqueueMany`. Production IDB enqueue commits one OUTBOX transaction. `enqueueEntryTags` can first call `ensureOfflineEntryTag`, durably queuing a separate vocabulary create, then enqueue the assignment. Reusing that helper per Work can leave committed vocabulary/earlier rows if later staging fails. It does not provide Collection bulk atomic staging.
2. `replaySyncOperation` looks up/stores one operation receipt inside one SQLite transaction per request. The new real-SQL prerequisite test sends two existing `entry.tags.set` envelopes through real typed application HTTP: first applies; second has a future baseVersion and conflicts; the first Entry assignment remains committed and both receipts exist. Exact first UUID retry is still applied without duplication. Therefore a simple per-Entry replay loop is demonstrably not equivalent to the existing atomic `addCommonTagToCollection` transaction.
3. Existing online common-tag repository selects DISTINCT current-folder/direct-child Works, uses `majorityFacetForTag` (aggregate count, tie lowest Facet id), default unnamed Facet fallback, counts existing before unsupported structure, and calls real `assignEntryTag`. Assignment cleaning includes NFKC, collapsed whitespace and simplified display spelling. Offline handling must preserve production semantics instead of guessing name→UID or layout placement.
4. Existing bounded `getCollectionSyncIdentity`/route proves only root/child identity/version/delete scope. It does not return unique Works, Entry revisions/assignments, tag vocabulary identity, validated Section/Facet metadata or global per-type majority placement. It alone cannot authorize common-tag connected no-copy writes. A bounded consistent folder/member/context preflight is needed, not whole-library snapshot/media loading.
5. Existing `sync-mutation-plan.ts` orders same-owner rows and selected cross-owner references. A dedicated bulk must reference every frozen Collection and Entry owner, plus actual vocabulary/context predecessors. Later Entry writes must also depend on that bulk even though its primary owner is a Collection. Frozen Entry revisions must be forecast/checked on their own chains, never substituted with Collection revision.
6. Existing applied receipt schema has only generic identity/version/sequence plus Collection-delete-specific journal extension. It has no ordinary common-tag result/count/unique affected Entry authority. Existing cleanup only settles known operation kinds. A new bulk cannot rely on cursor coverage alone or abuse the delete receipt as bulk proof.

**Chosen continuation direction:** one dedicated strict Collection common-tag envelope and one durable enqueue, with frozen unique member/context scope and one real SQLite receipt/result transaction. The shared union/capability/server dispatch/projection/restore/planner/cleanup must land coherently, not as two competing half-protocols. No production schema shape or new capability was written in this checkpoint. No new migration requirement has yet been established; immutable028/037/042 are untouched.

## Finite eight-class ledger — remaining, not fabricated PASS

| Class | Current evidence/status |
|---|---|
|1 Actual caller / unique members / normalized existing/new/skipped / cold projection | Actual ordinary caller RED archived. Online reference remains 2 affected / 0 existing / 1 skipped. Local/cold success not implemented |
|2 Atomic durable staging and atomic bulk SQL | Existing per-Entry non-atomic counterexample PASS as prerequisite only. New transaction failure/rollback cells not implemented |
|3 Actual export / cold atomic restore / SQL response loss / ACK loss / immutable retry | Not implemented for bulk; existing delete proof must remain intact |
|4 False/absent capabilities / old sealed retry retention | Not implemented; new bulk must require explicit global+Collection+bulk flags, no legacy absent-default inheritance |
|5 Connected no-copy and newer-than-copy bounded trusted context | Missing member/context preflight; not implemented |
|6 Held Collection/member/Entry-tag predecessors / independent owner / bulk→delete / later Entry writes / local origins | Not implemented for bulk; existing local-origin delete4 remains PASS and must be reused/protected |
|7 Frozen member/context concurrency / independent Entry version / semantic prevalidation rollback | Not implemented |
|8 Receipt count/tag identity / journal/cursor/snapshot / foreign or corrupt proof rejection | Not implemented; may be compacted with class3 authority-negative proof, never skipped |

No second batch of speculative tests was added. The new test file has one failing product tracer and one passing prerequisite counterexample. Complete the first product vertical before expanding to the next bounded cell (TDD).

## Byte provenance and concurrency

`fresh-before-manifest.json` captures 22 full fresh source/test/dependency files, including protected migrations, before any write. Four supplied latest source/test SHAs matched exactly. Existing before evidence was not overwritten. The only new repository test is `apps/web/tests/offline-collection-common-tag.integration.test.ts`; prior parity/delete files are unchanged.

`protected-source-byte-guards.json` found 21/22 full files unchanged. `CollectionsPage.vue` independently gained `t3-library-text` classes on folder/Author display text while gates ran; `external-drift.diff` records that exact external change. The complete script-setup region, including ordinary common-tag business caller, remains byte-identical (`business-region-provenance.json`). No stale buffers were written over that external display change; this was not an actual owned-business overlap or a reason to stop the entire file. The checkpoint does not claim to own those display edits.

A test-only harness correction replaced nonexistent `getEntryDetail` with actual `getEntry`; the feature RED had already occurred before those unreachable assertions. Web types then identified optional `replaySyncOperation` test calls; three non-null assertions on the concrete factory-provided method resolved it. No production API contract was altered. Raw failed type output and both exact hashguard edits remain archived.

`fullbytes-manifest.json` binds freshbefore, latest source/test, report, genuine RED/raw logs, guards and executed gate JSON to byte-identical saved copies with size/SHA/live-saved verification. Do not reuse these freshbefore bytes to overwrite future live changes. Subsequent work must capture its own fresh originals.

## Native and stop boundary

No new JS/native operation kind was introduced, generated, or executed. When the dedicated kind is implemented, extend strict native-contract metadata and all-kind fixtures, regenerate the Java contract in the authorized Native lane, and exercise original-body retention, explicit false/absent required flags, owner/context predecessor ordering and Worker scheduling. Native raw replay receipt must not become foreground cleanup authority. Actual Native Worker/device/OS acceptance remains a later lane; do not label JS planning tests Native PASS.

No04, APK, build/dist/release, migration, commit, formal database/assets, env credential, default8765/8766 request/restart, System/Settings/navigation/launcher/backup or media/auth/pinning edits. Source/test writer relinquishes this incomplete prerequisite checkpoint without leaving any production half-protocol.
