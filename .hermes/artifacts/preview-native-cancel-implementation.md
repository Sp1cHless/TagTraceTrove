# Native staged-preview cancel — bounded GREEN handoff

## Delivered boundary
Actual `GalleryApp → offline-api → createNativeTransfers → BackgroundTransferPlugin` caller now permits cancellation of **fresh, positive-existing-Entry, never-claimed previews**. It no longer unconditionally rejects every native cancellation. The entire affected staged-preview owner chain needs native authority because later survivors' ordinal/base metadata may change. Existing durable IDB cancellation is reused, retaining survivor UUID/SHA/Blob while rebuilding ordinal/base.

Native survivors of a canceled chain are deliberately **foreground-only**: durable release IDs/tombstones forbid old captures, resume and restaging. Foreground Update uploads only the survivor and verifies snapshot/bytes/ACK before removing canonical work. This is not a promise of rebased survivor native scheduling.

### Durable authority (native ledger v7)
- Fresh UUIDs are minted and registered by native `allocateUploadId` **at the real positive-existing-Entry enqueue caller**. Restore/handoff never mints authority for an old ID. Unsupported allocation falls back to normal JS UUID enqueue, but native cancel remains uncertain/refused.
- `claimStandalone` writes a permanent upload attempt seal in the same SQLite write transaction as lease acquisition, before transport. Held/error/expired-owner states cannot erase attempt history.
- A preview is eligible only with durable fresh issuance, no attempt seal, no attached-create upload, matching mirrored metadata, no lease owner and no result. Native absence or `paused` alone is not authority.
- v6→v7 migration seals existing mirrors/media/tombstones as uncertain. Missing historical IDs still fail fresh issuance. Legacy originals remain replayable, not silently made cancelable.
- Actual plugin authorization waits for the JS handoff promise, then performs native eligibility recheck, capture quiescence and durable release in a SQLite write transaction. Its production static helper is exercised by JVM tests with actual partial capture files. A competing claim serializes against this write transaction; selected uploads are tombstoned before returning to JS/IDB.
- Completed phases/results are preserved by pause. Canonical-absence pruning can subsequently clean completed mirrors; later cancellation cannot convert confirmed completion into a fresh/cancelable upload.
- An IDB guard failure after native release leaves the original canonical chain foreground-replayable; release/tombstones still prevent native resurrection. No cross-engine atomic-commit claim.

## Actual UI / Settings
`GalleryApi.getEntryMediaRemovalBlockReason` is implemented by the real offline facade. Gallery checks before exposing usable deletion/move controls, disables while inspecting or uncertain, and displays an actionable reason. Negative pending Entry IDs are disabled with “no server row yet”; commit cannot silently optional-call/no-op. Existing create/add controls remain usable.

Native reconcile returns actual mirrored/released upload IDs. Settings receives counts based on those mirrors rather than merely capability eligibility: released/missing mirrors count as foreground-only images, with “Canceled preview chain survivors require foreground Update; original UUID and bytes retained”. Existing Settings component text did not need rewriting. Scheduled remains the actual native active count, not eligible count.

## Observed RED → GREEN
- Real HTTP/IDB tracer parameterized with the real `createNativeTransfers` caller: native=true initially failed at the blanket native rejection; now queues/mirrors two previews, cancels first, cold-reopens, preserves later UUID/hash/Blob, and sends exactly one survivor multipart at ordinal 0. Final actual disk bytes match the distinct later yellow PNG. JS bridge replies are a typed test adapter, **not claimed as native durable proof**; native persistence is separately exercised below.
- JVM missing-authority RED, then actual fresh registration + real plugin helper/capture cleanup + SQLite close/reopen GREEN. Unknown/absent history RED→GREEN. A minted upload is eligible before claim, ineligible while leased and after finishing held/reopening; original bytes remain unchanged and durable seals reject release. Completed-phase preservation RED→GREEN.
- Mounted Gallery uncertain/pending deletion disable + reason RED→GREEN, preserving add controls.
- Mounted Settings through the actual durable facade/native caller released-survivor count/reason RED→GREEN; no activateStandaloneMedia for the released survivor, canonical Blob stays queued.
- Inherited attempted/uncertain exact retry guards remain GREEN.

## Exercised gates
Node22 PATH: `/c/Users/hzy/AppData/Local/hermes/node`.

1. `node node_modules/vitest/vitest.mjs run apps/web/tests/existing-entry-media-vertical.test.ts apps/web/tests/existing-entry-media.test.ts apps/web/tests/offline-api.test.ts apps/web/tests/pending-work-restore.test.ts apps/web/tests/pending-work-restore-atomic.test.ts apps/web/tests/offline-new-entry-tags.test.ts apps/web/tests/gallery-app.test.ts apps/web/tests/native-background-handoff.test.ts apps/web/tests/native-background-settings.test.ts apps/web/tests/native-settings-facade.test.ts apps/web/tests/native-protocol-resume.test.ts`
   - **443/443 PASS, 11 files**, `preview-native-safe/final-tests.log`. Inherited noisy Vue warnings/HTTP diagnostic output remain; not a warning-free run claim.
2. JDK21 `JAVA_HOME='C:/Program Files/Eclipse Adoptium/jdk-21.0.7.6-hotspot'`, PATH its MSYS bin; `T3_TEST_REPO=D:/Project/TagTraceTrove`. From `spikes/001-android-webview-shell/android`:
   `./gradlew.bat :app:testDebugUnitTest --tests '*TransferLedgerJvmTest' --tests '*NativeStagingInterleavingsJvmTest' --tests '*BackgroundTransferJvmTest' --console=plain`
   - **19/19 PASS (6+3+10)**, `preview-native-safe/final-jvm.log`. Intentional committed response-loss error logs are expected fixture behavior. After strengthening the authority test to use a genuinely native-minted attempted UUID, `--tests '*TransferLedgerJvmTest'` rerun **6/6 PASS**, `final-authority-jvm.log`.
3. `npm exec --yes --package=pnpm@10.15.0 -- pnpm --filter @t3/web typecheck` and server equivalent: **PASS** after final production/fixture edits. Logs `final-typecheck.log`, `final-server-typecheck.log`.
4. Affected eight TS/MTS files ESLint **PASS, empty log** `final-lint.log`. Vue file is ignored by existing ESLint configuration; its compilation is covered by vue-tsc, not a fabricated Vue lint claim. `git diff --check` **PASS**, inherited CRLF warnings only (`final-diff.log`). Last change after static gates was Java-test assertion strengthening, followed by its JVM compile/execution PASS.

### Native gate harness issue actually repaired
The existing standalone JVM foreground tracer failed its snapshot/byte verification: its JSON-client injected `http://fixture` origin was non-network and lacked the required asset-base trailing slash. `apps/server/tests/fixtures/native-background-vertical.mts` now supplies an isolated real HTTP asset server and a correct trailing-slash origin; close shuts connections/listener. Temporary debug fields were removed. This is genuine app endpoint/original-byte serving, not fabricated responses. Existing JVM real pinned-TLS native upload/cold exact retry → foreground ACK tracer now passes again. It does **not** prove Android authenticated global-fetch interception; that separately listed parent seam remains open.

## Exact files / checkpoints
All existing files backed up via complete `read_bytes` before their first edit under `.hermes/tmp/preview-native-safe/start/`. Full current bytes checkpoint: `.hermes/tmp/preview-native-safe/green/manifest.json` (SHA256, byte length, line count, modified flag). Earlier recovery/preview checkpoints untouched.

Modified production:
- `apps/web/src/offline/offline-api.ts` — 5,521 lines; SHA256 `db32644ae53fa3b6210944dc81f7c4d5293e649e217926dcadb148c9cb25ea30`
- `apps/web/src/offline/native-background-transfer.ts` — SHA256 `8ca0dd5d49b08d027ffdf425ca2795b15e011a326b521dc7170ca15ca8707e73`
- `apps/web/src/api/gallery.ts`
- `apps/web/src/GalleryApp.vue`
- native `BackgroundTransferPlugin.java` — SHA256 `c14a201e9c1e3bcb0c410ea3253fdac29e5d29a58acc48ebd9592e8f04cee5e0`
- native `TransferLedger.java` — SHA256 `494f132632e59a782c6e4965a4e35ba088bbb947c8278d6d2cf6683075bb8579`

Modified tests/fixture:
- `apps/web/tests/existing-entry-media-vertical.test.ts`
- `apps/web/tests/gallery-app.test.ts`
- `apps/web/tests/native-background-handoff.test.ts`
- `apps/web/tests/native-settings-facade.test.ts`
- native `TransferLedgerJvmTest.java` — latest SHA256 `60236a2d38268f60c8c3b71384529d941b27db6d7dd4aa2daaf233431ba7ad0b`
- `apps/server/tests/fixtures/native-background-vertical.mts`

No edit to parallel server owner `apps/server/src/import/media.ts` or its thumbnail test/artifact. No CURRENT/progress/shared handoff edits. No formal DB/assets, default service/probe/deploy/restart, commit/reset/stash/build/APK/device action. Existing dirty work preserved.

## Stop / next
Bounded slice automatic gates are GREEN; stop here. Parent owns grouped root/native/build/APK gates and packaging. Device WebView/plugin execution, OS process-survival and authenticated/native byte-fetch seam are not claimed by these JS-adapter + JVM/SQLite tests. Other parent acceptance priorities (atomic stage operation fingerprint, broader cleanup tamper matrix, thumbnail owner) remain outside this slice. Unknown/legacy/attempted previews explicitly require foreground Update; fresh native cancellation is supported instead of blanket-disabled.
