# Same-Entry asynchronous upload staging consistency — observed RED

Status: real production-facade/IDB behavioral RED; not repaired while the native writer owns shared production files.

The delegated diagnostic was provider-blocked before executing the target; its transcript confirms no production edits. The parent performed this ordinary local data-consistency test directly in new temporary files.

## Observed behavior

Fixture: migrated disposable SQLite, temporary assets, ephemeral HTTP server, real positive Entry and distinct red/blue PNGs, real fake-indexeddb-backed production store + offline facade. Cleanup runs in finally; no formal DB/assets/default service touched.

1. Seed two stored previews through actual HTTP upload, install the actual snapshot with `expectedBase` as the full active snapshot object.
2. Start an offline third preview upload, defer the File's `arrayBuffer` until after capture.
3. While deferred, queue deletion of preview 2 through the production `setEntryMediaOrder` facade. Operation outbox has one durable command; active snapshot and media queue are otherwise unchanged.
4. Release the read. The upload resolves successfully, but its durable metadata still reviews **both** previews, including the deleted second one; ordinal remains **2** instead of the refreshed **1**.

Exact logged observation: `error:null`, original refs `/api/assets/entries/1/preview.png` and `preview-2.png`, persisted `existingEntry.expectedPreviewRefs` contains both, ordinal 2. This is not a collection/type/fixture error. The focused test fails because the stale second ref remains. Desired atomic behavior: refuse stale reviewed work with a clear conflict/review-change error and do not stage its Blob, or rebuild a new never-attempted envelope against the current causal projection atomically. Never mutate already-attempted/uncertain envelopes.

## Reproduction

Artifacts:
- `.hermes/tmp/preview-atomic-probe-generate.py`: reads complete real fixture source; writes a NEW temporary test only, not production/tests.
- `.hermes/tmp/preview-atomic-probe.test.ts`: restricted case.
- `.hermes/tmp/preview-atomic-probe.config.ts`: standalone narrowed include with explicit fake-indexeddb resolution through web package.
- `.hermes/tmp/preview-atomic-probe-red.log`: actual **1 test / 1 file FAIL**, expected refs length/content mismatch, ~658 ms case execution.

Command from repository root (Node22 PATH):
`python .hermes/tmp/preview-atomic-probe-generate.py && node node_modules/vitest/vitest.mjs run .hermes/tmp/preview-atomic-probe.test.ts --config .hermes/tmp/preview-atomic-probe.config.ts --reporter=verbose`

## Fixture errors excluded from defect evidence

Initial helper setup passed a generationId instead of the actual active snapshot object to applySnapshot; this did not install the new source refs and was corrected before observing RED. Temporary imports needed fake-indexeddb resolution from apps/web. Also, Vite `mergeConfig` concatenates `test.include`: it accidentally selected the root suite. That unplanned run occurred while native source was being edited; it is **not** a release gate or accepted baseline. Final config uses object spread to replace include and explicit test filepath in CLI. Only `preview-atomic-probe-red.log` is this named production defect's evidence.

## Next safe-owner action

After current web/native writer ends, promote this case into permanent durable-IDB coverage and implement transactional operation-queue identity revalidation in addition to snapshot/media guards; keep Memory/store contract parity. Then test concurrent operation change, unchanged success, no orphan Blob/metadata on rejection, and original uncertain retry identity preservation. Do not edit the active owner's offline-api/indexeddb files concurrently.
