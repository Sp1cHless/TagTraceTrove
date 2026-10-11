# Preview implementation checkpoint (active writer)

Recovery preserved; no source whole-file writes. Start full-byte backups `.hermes/tmp/preview-safe/start/`. GREEN full-byte checkpoint `.hermes/tmp/preview-safe/slice1-green/`.

## Slice 0 inherited transport/export tracer verification
`existing-entry-media-vertical.test.ts` / `transports a cold restored...` executed first-GREEN (1 pass). Existing preparePendingWork uses syncReplayRequestSchema already; no invented legacy-schema failure. Test covers facade → durable IDB cold reopen → exact replay body after real committed TCP response loss → ACK-loss retention → ACK success. Atomic restore not yet exercised by this tracer.

## Slice 1 consecutive deletion RED → GREEN
New `keeps byte identity through consecutive cold deletions and unchanged response-loss retries` failed because second operation retained pre-rename positional refs, persisted conflict. Minimal fix creates NEW successor base/payload against predicted predecessor positional rename; local overlay resolves explicit retained base ordinal to original cached refs, rather than conflating renamed URL with original bytes. Never rewrites existing UUID/envelope/attempted bodies. Four different PNG colors; cold reopen between gestures, export parsing unchanged, committed response loss, byte-for-byte final survivor, exact first request retry and 2 SQL receipts.

Production: `apps/web/src/offline/offline-api.ts`; updated existing shallow test's obsolete second wire expectation while separately retaining actual displayed original ref assertion. Tests: `apps/web/tests/existing-entry-media-vertical.test.ts`, `apps/web/tests/existing-entry-media.test.ts`.

Actual GREEN gates: 121 tests across these two + offline-api.test.ts; web vue-tsc PASS. Log `.hermes/tmp/preview-safe/slice1-tests.log`. offline-api checkpoint SHA256 eaf0d456cfc153cb1d171b33a2466934280c8ddfab67050652371b16e2d30064.

## Slice 2 peer same-ref false success RED → GREEN
New actual TCP/SQL/assets tracer `retains a conflict when a peer changes bytes behind the same desired positional refs` failed with an empty queue: server checked current refs==desired before checking reviewed owner revision, falsely returning applied for the peer's other picture. Targeted `apps/server/src/sync/replay-service.ts` fix moves version/base validation before no-op success. Stored receipt lookup remains first and unchanged exact retries still succeed. Actual final peer PNG bytes verified unchanged; original local envelope retained as conflict.

## Actual atomic restore defense
The original deletion response-loss tracer now exports, removes its operation from durable IDB, calls the real facade `restorePendingWork`, verifies exact restored operation, then cold-reopens and executes real response-loss/ACK-loss retries. This was first-GREEN defense, not a claimed new defect RED. `preparePendingWork` already accepts the request union: no legacy-schema fix was needed.

## Final focused gates and checkpoint
- 185 tests PASS across existing-entry-media-vertical, existing-entry-media, offline-api, pending-work-restore, pending-work-restore-atomic (log `.hermes/tmp/preview-safe/slice2-tests.log`).
- 4 isolated integration tests PASS across entry-media-order + existing-entry-media.
- After atomic restore tracer extension: focused `transports a cold restored...` 1 PASS; web vue-tsc PASS; affected ESLint PASS.
- Server tsc + web vue-tsc PASS; git diff --check PASS (inherited Windows CRLF warnings only).
- Full-byte checkpoint `.hermes/tmp/preview-safe/slice2-green/`; `manifest.json` holds hashes/line counts. offline-api 5406 lines, SHA256 eaf0d456cfc153cb1d171b33a2466934280c8ddfab67050652371b16e2d30064. Server replay-service 2176 lines, SHA256 ecbfd3d2c31ec1c77e68f95da4970943ccd83c2404c5e5d7459a02e12690d0fd. Final atomic-restore tracer is additionally checkpointed as `slice3-defense-green`.

## Remaining (NOT COMPLETE; quota handoff)
**Missing implementation / next vertical priorities:** delete→append / append→delete and mixed operation/media causal ordering; staged cancellation with surviving dependent/native lease; exact media identity/order/bytes snapshot verification before ACK/cleanup. Current replay still executes operation queue then media queue; do NOT call that complete causal scheduling. Current deletion cleanup has not gained specific media-order/byte coverage verification. No new guarantee of staged cancellation or native preview support.

**Not yet verified:** consecutive-delete projection after ACK-loss installs a newer snapshot but retains original operations (add explicit cold getEntry byte/order assertion before retry); independent Entry advancing past peer conflict; capability absent/false matrix + native foreground-only Settings caller; actual export restore that combines deletion envelope AND staged Blob; pending-create actual UI gating. Generic existing restore tests passing is not evidence for these new compositions. Next owner must distinguish discovered failures from source-review hypotheses.

Recommended next RED tracer: seed distinct cover/previews, queue deletion, append through real facade, export+atomic restore into empty durable queue, cold foreground replay; verify final list AND disk bytes; trace both operation and multipart chronological bodies. Then reverse append→delete with stable #t3-upload UUID cancellation. Keep original attempted envelopes immutable. Also add ACK-loss cold projection check before broad cleanup work.

Commands (Node22 PATH prefix required): `node node_modules/vitest/vitest.mjs run apps/web/tests/existing-entry-media-vertical.test.ts apps/web/tests/existing-entry-media.test.ts apps/web/tests/offline-api.test.ts apps/web/tests/pending-work-restore.test.ts apps/web/tests/pending-work-restore-atomic.test.ts`; `node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts apps/server/tests/integration/entry-media-order.integration.test.ts apps/server/tests/integration/existing-entry-media.integration.test.ts`; `npm exec --yes --package=pnpm@10.15.0 -- pnpm --filter @t3/web typecheck` and server filter equivalent.

No full-root gates/build/APK/device/deploy/formal DB edits; inherited dirty work preserved. No unresolved test RED left by this writer. Two genuine defect RED→GREEN slices are complete, NOT the finite acceptance board.

## Next writer continuation (2026-10-08; latest GREEN)
Preserved full bytes at `.hermes/tmp/preview-next-safe/start/` before touching each source/test. Latest complete checkpoint `.hermes/tmp/preview-next-safe/slice2-green/manifest.json` (five files including inherited replay-service and shallow test). Older recovery and preview-safe checkpoints untouched.

### Mixed slice A: deletion → append RED→GREEN
New real test `restores deletion and appended Blob atomically and replays their causal byte order` failed with only one final preview (upload held against stale pre-delete refs). NEW uploads now capture predecessor-predicted canonical refs/ordinal rather than unprojected active snapshot. Actual deletion envelope + Blob exported, both removed, facade atomic restore invoked, cold IDB reopen, operation POST before multipart, distinct surviving blue/yellow disk bytes, both queues empty. RED log `preview-next-safe/red1.log`; initial 186 tests + web typecheck GREEN checkpoint slice1-green.

### Mixed slice B: append → deletion RED→GREEN
New real test `keeps an appended Blob after deleting an older preview across cold replay` initially failed at facade staged identity lookup (`red2.log`). New media-order envelopes resolve stable upload UUID refs from reviewed Blob URLs, count upload revisions, preserve unchanged existing envelopes. Cold projection resolves retained staged UUID to its own Blob instead of appending twice. Replay flushes media explicitly referenced in a media-order base before sending that order; deletion→append remains operation-first. This is **media-order-specific scheduling**, NOT yet general same-Entry metadata/other-edit causal scheduling.

Actual server failure then exposed that `applyEntryMediaOrder`/asset GET rejected UUID-named media from the existing upload endpoint as unknown. `apps/server/src/import/media.ts` now recognizes narrowly UUID-qualified source filenames (noncapturing UUID; extension group preserved), allowing reorder/removal and original byte reads. Snapshot verification for existing uploads follows later applied media-order positional renames, verifies owner/resource version and final ordinal/ref, and fetches actual original bytes to compare SHA before ACK/cleanup. Harness now supplies its actual ephemeral asset origin; no fabricated assets/responses. Trace proves multipart before operation; survivor bytes blue and both queues empty.

### Latest executed focused gates
- 187 tests PASS / five web files (10 actual vertical cases): `.hermes/tmp/preview-next-safe/final-tests.log`.
- 4 isolated SQL integration tests PASS / two files: `.hermes/tmp/preview-next-safe/integration.log`.
- web vue-tsc, server tsc, three changed-file ESLint and git diff --check PASS (inherited CRLF warnings).
- offline-api 5444 lines / 307439 bytes, SHA256 `83967623be3a3f30e98be656a4a021e54c6c7908947c8033a8615693625857a1`.
- server import/media.ts SHA256 `40986bc12b86b75a8505a6ce8985a114cfef3018dd116a1de9da1598cbb9b0a8`; vertical test SHA256 `a21a386927ea5debe5f314dbf4f535c2717fd660af18b1479421deb864926585`.

### Still OPEN — do not report Preview complete
1. Staged cancellation with surviving later Blob dependencies/native lease (no implementation in this continuation); pending negative Entry UI gating.
2. General crossqueue causal version/dependency planning for metadata/other edits, not only entry.media.set. Current referenced-media flush also needs explicit hold-before-operation proof when a required upload is pending due to missing capability (it currently attempts the order after a held media flush); add real cap RED before repair.
3. Mixed/consecutive deletion response-loss + ACK-loss **cold displayed byte/order** assertion; queues remain unchanged but double projection on advanced snapshot has not been closed.
4. Independent Entry past conflict + native foreground-only honest Settings/status + absent/false capability matrix.
5. Renamed media byte proof introduced here is exercised by the mixed vertical but tampered well-formed snapshot/bytes proof and all deletion-only survivor byte identity are not yet a complete cleanup matrix. Byte fetch goes through fetch(assetUrl): native HTTP interceptor/auth behavior is NOT separately validated.
6. Joint restore traced deletion→append; reverse joint restore and mixed exact-retry transport-loss not yet covered. Atomic upload stage guard still snapshots+media only, no operation-queue concurrent-write fingerprint; source-reviewed risk, not reproduced RED.

Next first RED should cover staged cancellation or held upload dependency (cap absent/false), then crossqueue metadata. Use the same finite isolated test harness; no formal DB/default services/build/APK. Original commands above remain valid. This continuation passed focused GREEN but did not finish the finite acceptance board.

## Third continuation + parent GREEN repair (latest owner boundary)

The third writer completed real RED→GREEN capability absent/false upload dependency holds (dependent order not sent, independent Entry advances), checksum-bound receipt-verified projection after an installed snapshot with ACK loss, fresh staged preview cancellation via durable IDB transaction/rebased later Blob metadata, immutable attempted cancellation rejection, and real joint restored metadata→upload→metadata→delete HTTP revision order with response-loss/ACK-loss cold bytes. Conflict owners no longer flush predecessors; independent owners advance. The actual `createNativeTransfers` pause/reconcile caller is exercised, but native staged cancellation is currently **rejected** because durable per-upload never-attempted proof is unavailable. Browser cancel PASS must not be reported as APK cancel support.

Writer reached 50 calls without updating this handoff or final checkpoint. Full report: `C:/Users/hzy/AppData/Local/hermes/cache/delegation/subagent-summary-0-20261008_172448_946667.txt`. Initial backups `preview-third-safe/start`, RED logs `red-held/ack/cancel/causal/conflicted/native.log`, writer `final-tests.log` (203 tests/6 files, 17 vertical cases).

Parent preserved complete bytes before fixing the sole explicit compiler blocker, removed unreachable `nativeTransfers?.handoff()` after the branch had already rejected nativeTransfers, and actually reran **203/203 PASS + web vue-tsc + affected ESLint + diff-check PASS**. Complete six-file checkpoint `.hermes/tmp/preview-third-safe/parent-green/manifest.json`; offline-api 5,506 lines, SHA256 `c17834d861d3427ade0e4c2e4d6ab34cad1895efe9311c66f7528b4cfd2ee9a1`; parent log `parent-green-tests.log`. Do not return to earlier checkpoints or regress the new tests.

### Remaining finite closure priorities
1. UUID-qualified uploaded source thumbnail generation/resolve currently succeeds but actual derivative reader rejects it. Parent isolated real-image probe is RED (`.hermes/tmp/preview-parent-thumbnail-probe.mts`, `preview-parent-thumbnail-red.json`), no formal DB/assets. Add permanent original+generated-thumbnail serving regression and tightly bounded derivative regex fix.
2. Native staged cancellation: implement actual durable quiesced authority/never-attempted proof or explicitly gate real UI/status without claiming supported cancellation; avoid silently reducing APK behavior to browser-only support. Always preserve attempted/uncertain UUID/body/hash. Native Settings foreground-only reporting/capability matrix and negative pending-create UI gating still open.
3. Atomic upload staging operation-queue fingerprint guard must be reproduced RED then fixed in real IDB+Memory parity; snapshot+media guard alone misses concurrent operation changes.
4. Well-formed checksum-valid incomplete/wrong-byte snapshots must retain queue before ACK/cleanup; close deletion-only survivor byte proof and actual authenticated/native fetch seam without conflating device acceptance with JVM proof.
5. Bounded independent review of mixed scheduler compositions after these gates (not unlimited scope audit), followed by parent-only grouped root/native/build/APK gate. No new APK or formal deployment yet.