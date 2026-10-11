# Gallery order / Entry preview offline extension

## Frozen artifact / concurrent-source boundary

The v41 APK and its build-time tests/review remain the delivered Gallery/Preview artifact, not a claim that the currently changing repository is globally GREEN. After the APK was built, another workstream changed Author rating code in offline-api.ts, api/gallery.ts and GalleryApp.vue. Those later edits were not rolled back, silently repackaged or covered by this APK's gates. In particular the later author_self slot-layout change is absent from this delivery. Raw live-source SHA must not be substituted for the build-time checkpoint. Verified APK/public Web bytes are frozen under `.hermes/tmp/release-v41-final/packaged-web-manifest.json`; observed later API drift is recorded alongside it. No additional feature review or production edits were opened to absorb that separate workstream. “No writer remains” in earlier completion wording means this Gallery/Preview workstream only.



## v41 delivery — authoritative current status

Gallery order and Entry preview add/delete implementation, the two final byte/snapshot defenses and bounded review are closed. No feature writer remains. Latest implementation: `.hermes/artifacts/preview-last-implementation.md`; bounded parent review: `.hermes/artifacts/offline-extension-bounded-review.md`.

Fresh default tests 1204/1204 and isolated integration 635/635 PASS; shared/server/web typechecks, root lint, diff-check and production build PASS. Full native JVM 57/57 across 12 per-class isolated forks PASS (initial shared-process Robolectric SQLite crash retained in logs). APK `spikes/001-android-webview-shell/T3-v41-offline-gallery-preview.apk`, versionCode 41 / `0.0.41-c3-gallery-preview-offline`, SHA-256 `9bb20c3dba94862db47837886597c9ff24d48a2d720b21b14f409c398649c7c7`; packaged Web bytes/marker match and signer equals v40. Machine-readable proof: `.hermes/artifacts/offline-extension-apk-verification.json`.

Only this extension's device checks remain: `.hermes/artifacts/offline-extension-device-check.md`. Script/JVM pairing bytes do not establish actual WebView/PluginCall/Keystore or force-stop behavior. Deletion survivor byte identity is checked when trustworthy original cache bytes exist; null provenance never claims byte proof. Unknown/attempted native cancellation stays refused; released survivors are foreground-only. Occupied-cover replacement and excluded Import/Source/PWA/conflict work stay out of scope.

No formal DB/assets/default service restart, deployment, device install, commit or release-key change. Current backend code must be reloaded by the user through the normal T3 tray Exit/relaunch workflow; packaging alone does not reload the existing server. Old C0–C3/v38–v40 device register is not reopened.

## Earlier slice/version evidence (historical; superseded status wording)

## Scope (2026-10-08)

User-authorized order: (1) Gallery order, then (2) Entry preview add/delete. Existing App acceptance was completed by the user and its reported issues repaired; this extension does not reopen the historical acceptance register. Preserve unrelated worktree edits; no formal DB/assets, default server restart, commit/reset/stash, or release-key migration.

## Finite acceptance board

### Gallery order

- Download / Update / delta preserve the server's custom complete Gallery order; older snapshots without order remain readable.
- Exchange edits queue durably and project immediately; cold reopen retains order; replay converges and exact retry does not apply twice.
- Reordering the visible SFW subset preserves hidden Gallery membership and authoritative scope.
- Desktop peer changes produce a visible conflict rather than silent overwrite. Same owner successors are held; unrelated owners can progress.
- General and operation capability downgrade block incompatible writes without deleting original work.
- Export / atomic restore retain original envelopes. Native scheduling either supports the operation with actual gates or explicitly reports foreground-only; no false scheduled state.
- Applied work is removed only after verified covering snapshot / durable ACK, retaining concurrent newly enqueued work.

### Entry previews

- Existing Entry add and delete use the actual Entry media UI / facade; unchanged cover and surviving preview bytes remain correct offline and after reconnection.
- Consecutive deletes, delete then append, append then delete, and cold retry preserve the intended media list without positional-ref mismatch or orphaned blobs.
- Staged previews are handled explicitly: cancelling one cannot lose surviving work or silently bypass native ownership / lease / predecessor constraints.
- Pending creates are either supported on their actual staged-media path or clearly gated; a click must not silently succeed with no mutation.
- Offline editing does not evict the only cached bytes needed to render surviving media. Online reconciliation invalidates changed images correctly.
- Real isolated HTTP + SQLite / temporary assets exercise response-loss retry, peer conflict, capabilities, snapshot coverage and cleanup. Native unsupported cases remain explicit.

## Execution record

Before extension implementation, baseline existing tests passed:

- `existing-entry-media.test.ts`: 6 tests.
- `entry-media-order.integration.test.ts`: 2 isolated SQL/filesystem tests.
- `existing-entry-media-vertical.test.ts`, `offline-media.test.ts`, `cached-media-response.test.ts`: 16 tests. Real isolated HTTP vertical confirmed existing append retries and ACK retention, not new add/delete composition.

## Gallery migration check (isolated only)

`.hermes/tmp/probe-gallery-migration.mts` upgraded a disposable v36 in-memory database to v37 after creating a tombstone and raising the journal high-water mark to 100000. All pre-existing triggers remained present with unchanged canonical SQL; tombstones and the high-water mark were preserved; `foreign_key_check` was empty. This review does not apply the migration to the formal database.

## Gallery implementation closed (2026-10-08)

Gallery extension is implemented; full-tree release gates remain grouped with previews.

- Immutable migration 037 adds a versioned library-wide order scope. Online writes and offline receipt replay share it; peer changes conflict and exact retries deduplicate.
- Snapshot/delta carry optional `galleryOrder`, with legacy snapshot compatibility. Durable facade/outbox projection survives IDB reopen; export/atomic restore and shared/native scheduling know the new operation.
- Actual mounted Exchange initially failed the new hidden-Gallery regression (visible order did not move when an NSFW neighbour intervened). After the narrow UI fix, arrows swap visible neighbours while hidden Gallery slots remain in the complete authoritative order. This is genuine RED→GREEN.
- Capability absent/false cases for both general mutations and Gallery ordering passed as first-green defensive coverage.
- The duplicate state-only capability write was removed; capabilities are persisted on the main probe path even without an optional UI state object.

Observed final targeted results before starting preview implementation:

- Workspace shared/server/web typecheck PASS.
- Gallery UI Exchange + existing online Exchange: 2 passed.
- `offline-gallery-order.test.ts`: 6 passed (IDB cold reopen, export/restore, native causal plan, legacy snapshot, capabilities).
- `native-worker-authority-contract.test.ts`: 4 passed.
- `gallery-order-flow.integration.test.ts`: 1 passed, actual Hono route + migrated SQLite + IDB; committed-response loss, unchanged retry, verified delta, ACK loss retention and ACK success cleanup. Transport here uses Hono `app.request`, not a listening TCP socket.
- Gallery repository + sync integration files: 6 passed.
- NativeWorkerAuthorityAcceptance JVM XML: 12 tests, zero failures/errors, 201.164s, 24 contract kinds. Real TLS authority is exercised; all-kind receipts are contract mocks, not Gallery SQL business execution. The first foreground command timed out at 180s, but its Gradle daemon completed; a subsequent command succeeded up-to-date and the fresh JUnit XML was inspected. No new device acceptance claimed.

## Confirmed preview diagnosis (isolated only)

`.hermes/tmp/probe-preview-order.mts` exercised production code with migrated in-memory SQLite and disposable images/assets:

- Two offline-style sequential preview deletions: first operation applied; second falsely conflicted because server renumbered surviving positional refs but the local second base still used old refs.
- Actual offline facade queued `entry.media.set`, then `replayOfflineOperations()` marked it failed before any HTTP call: `Invalid offline operation: this version cannot send it`. The request union accepts it but the ordinary transport / mutation plan union excludes it.
- Actual existing-Entry preview upload facade persisted a Blob row but `getEntry()` still returned only the original previews. `loadOfflineLibrary()` projects staged covers for negative pending-create IDs only; existing Entry staged previews are not exposed. Removing the apparently absent addition by submitting the original refs is a no-op and leaves the upload queued.

These are diagnosis results, not implementation completion or replacement for focused TDD regressions. The temporary DB/assets were removed in `finally`.

## Recovery incident / current blocker

Preview implementation is NOT complete. The worker used truncated `read_file` content in a whole-file rewrite of `offline-api.ts`, reducing it to 1,929 lines. Recovery has now restored a 5,384-line production file from complete historical logs/patches, preserved recent bytes, and actual delivered v40 compiled behavior. Missing Tag-return, immutable uncertain-create identity/body, and foreign-library/epoch discard behavior were found in that real bundle and reconstructed; exact original suffix-byte equality is not claimed. The original damaged source and complete validated checkpoint remain preserved. The parent's **actual worktree** run (not the earlier virtual candidate override) passed 1,793/1,793 root tests; shared/server/web typecheck and affected lint passed. Six stale latest-schema assertions were advanced to the real migration 037, and Blob-URL tests now assert the actual stable upload identity with browser URL APIs stubbed in jsdom. Independent recovery comparison is complete: its create/discard findings were already resolved in the current tested version, and tool-call message 130141 proves the cache-retention difference is intentional. Recovery is closed; disposition: `.hermes/artifacts/recovery-review-disposition.md`. These recovery gates do not close preview deletion/composition/cancellation/native/cleanup acceptance. Report: `.hermes/artifacts/source-recovery-status.json`. No formal DB/assets or default service was changed.

## Preview continuation checkpoints

Latest accepted boundaries: native fresh staged cancellation with durable fresh issuance/attempt seals/release authority, Gallery actionable gating and Settings truthful mirrors/foreground-only reporting; UUID original+generated-thumbnail real HTTP serving. Parent verified their source hashes and reran all 18 real HTTP/SQL/IDB verticals and 7 nearest thumbnail/media integrations PASS. Native worker also recorded 443 web tests and focused JVM gates PASS, explicitly not device proof. Complete checkpoints: `preview-native-safe/green/manifest.json` and `preview-thumbnail-safe/green/manifest.json`; exact reports under `.hermes/artifacts/preview-native-cancel-implementation.md` / `preview-thumbnail-implementation.md`. Current sole writer addresses the already-observed atomic-stage operation-queue race and finite valid-snapshot/wrong-byte cleanup plus authenticated/native byte-fetch seam. Root/native final release gates, v41 build and device acceptance still pending; do not treat earlier browser-only cancellation limits as current state.


The first continuation writer closed two actual defect RED→GREEN slices: successor deletion envelopes predict predecessor server positional renames while local projection preserves original cached picture identity; server media replay checks reviewed version/base before treating equal desired refs as applied, protecting peer picture changes. A real export/remove/atomic IDB restore tracer is first-GREEN defense, not a claimed schema defect fix. The parent independently reran the three real HTTP/SQL/cold-IDB tracers: **3 PASS**. The saved five-file focused log confirms **185 PASS**; no full-root/build/APK gate is claimed for this feature revision. Full byte checkpoint: `.hermes/tmp/preview-safe/slice3-defense-green/`; `offline-api.ts` at that boundary has 5,406 lines and SHA256 `eaf0d456cfc153cb1d171b33a2466934280c8ddfab67050652371b16e2d30064`.

Mixed delete→append and append→delete old preview are now closed real RED→GREEN verticals, including joint envelope+Blob restore, operation/multipart chronological ordering, final original PNG bytes and cleanup. Parent independent rerun: 2 PASS. Latest complete byte checkpoint `.hermes/tmp/preview-next-safe/slice2-green/manifest.json`; worker focused report: 187 web + 4 isolated integration PASS. A single continuation writer is active on staged cancellation, held upload dependencies, general same-Entry crossqueue causality, ACK-loss cold projection and the finite safety/status matrix. The parent also reproduced a derivative-asset gap after UUID source-file support: `ensureEntryThumbnail` and `resolveEntryThumbnail` succeed, but `readEntryThumbnail` rejects that generated UUID-qualified thumbnail. Isolated fixture probe exit 1 (`.hermes/tmp/preview-parent-thumbnail-red.json`), no formal assets/DB and no production edits. This remains an explicit release blocker until a safe-owner regression/fix. Existing source is patched only, backed up completely before edits. See `.hermes/artifacts/preview-offline-implementation.md` for evidence and remaining implemented-versus-unverified boundaries. In particular, operation-queue-first/media-queue-second is not yet correct mixed causality, and current passes do not prove ACK-loss cold projection or media-byte cleanup coverage.

New functionality is IN PROGRESS; baseline passes are not completion evidence. Final consolidated gates and delivered build are recorded here after both slices complete. Device-only checks for this new extension remain distinct from automated evidence.
