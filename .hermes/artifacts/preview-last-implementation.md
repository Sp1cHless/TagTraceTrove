# Last two named acceptance items — both PASS

## Outcome / stop
A deletion-only incomplete/wrong survivor-byte snapshot defense: **real RED → GREEN**.
B production Android fetch bootstrap → paired byte transport → real authenticated isolated HTTP(S) original-byte caller: **PASS / first-GREEN existing production route**, no native/auth production change.
Stop here; no new audit, root suite, APK, build, deployment or commit. Parent owns grouped release gates and CURRENT/board.

## A: real caller defect and narrow repair
Permanent two cases in `apps/web/tests/existing-entry-media-vertical.test.ts`: three distinct-color real images, original cached bytes, actual temporary-file migrated SQLite, temp assets, ephemeral TCP server, production offline facade and cold IndexedDB. Queue deletion retaining the later preview so server positional rename is exercised.
- Incomplete valid checksummed newer delta and correct-ref/version but wrong 200 survivor bytes both **failed before repair**: operation incorrectly disappeared (`expected [] to deeply equal [ObjectContaining...]`). `.hermes/tmp/preview-last-deletion-red.log`: 2 FAIL, 23 skipped; behavioral RED, not fixture error.
- Fix only in `apps/web/src/offline/offline-api.ts`: capture cached original-byte SHA/source ref before replay, persist fingerprint-bound provenance separately from immutable envelope, fold positional renames in original queue order, retain null when no trustworthy cached bytes. Final deletion-only receipt owner/version/complete refs and each available original-byte SHA are checked before verifiedReplayProjection, snapshot activation, ACK, cleanup. No staged-media owner extrapolation: prior mixed/upload verification untouched.
- Both cases now assert original op UUID/payload/base retained, unchanged active snapshot, no verified projection/ACK, unchanged surviving cached bytes. After corrected snapshot/bytes, ACK response loss retains original op/cache plus pending durable ACK; cold exact-body retry and durable ACK permit operation cleanup. Receipt count remains one and final survivor file bytes match original independently.
- Unknown/missing cached bytes are NOT claimed as byte proof (null provenance); complete owner/version/ref defense still applies. No retry envelope changes or speculative digest from renamed URL.

## B: actual bootstrap + real JVM transport (not a fake binary response)
New `apps/server/tests/fixtures/paired-bootstrap-bytes.mts` and `spikes/001-android-webview-shell/android/app/src/test/java/com/speechless666/t3/spike/PairedBootstrapBytesTest.java`.
- Fixture extracts the actual String.raw bootstrap `<script>` from prepare-web.mjs and executes it in a sandbox, without importing/running prepare-web build side effects. Global fetch used by the actual production offline verifier is that exact window.fetch implementation.
- Typed nativePromise adapter forwards every request over IPC to JVM. JVM claims a genuinely issued pairing QR, verifies, cold-parses native PairingState, re-verifies on every request and invokes actual production PinnedLanTransport with private native token. Returned base64 is the real response bytes from existing secure pairing listener and production API with disposable file DB/assets; no global TLS trust bypass or manufactured byte reply.
- Actual binary 95-byte PNG (includes zero/high bytes), multipart request encoding and raw response decode preserved. Wrong 200 and missing 404 assets keep cold IDB original UUID/hash/preconditions/Blob, no projection/activation/ACK; correct bytes reconcile/clean.
- Canonical `/api/assets/...?...` path/query preserved (`version=a%2Fb&raw=1`). Native adds Authorization; JS bridge args/results have no token/auth. All reached application requests had Authorization. Three unapproved URL classes use original-fetch sentinel and **never** paired server/bridge.
- Result: `{"wrongMissingRetained":true,"pass":true,"canonicalQuery":true,"authenticatedRequests":42,"unapprovedNotPaired":3,"done":true,"bridgeCalls":20,"rawBytes":95}`.
- First execution already passed JS/native behavior, but final child-exit wait failed because fixture readline held stdin open. Fixed test-only finally to close readline/pause stdin. This was a harness shutdown issue, NOT production RED; route is first-GREEN defense evidence.
- **Evidence boundary:** JS production bootstrap + typed adapter + real JVM PairingState/PinnedLanTransport/TLS/authenticated HTTP PASS. Actual Capacitor PluginCall/Android Base64/PairingVault Keystore/WebView/phone remain device-unverified, not falsely marked PASS. Existing SecurePairingTest separately passed five actual TLS/pin/revocation/redirect cases.

## Actual commands / gates
Node22 PATH `/c/Users/hzy/AppData/Local/hermes/node`; root `D:/Project/TagTraceTrove`.
- RED: `node node_modules/vitest/vitest.mjs run apps/web/tests/existing-entry-media-vertical.test.ts -t 'deletion-only refuses'` → 2 real FAIL.
- A nearest: `node node_modules/vitest/vitest.mjs run apps/web/tests/existing-entry-media-vertical.test.ts apps/web/tests/existing-entry-media.test.ts` → **31/31 PASS**, `.hermes/tmp/preview-last-deletion-green.log`.
- Final focused: same two plus `apps/web/tests/offline-api.test.ts apps/web/tests/indexeddb-snapshot-store.test.ts` → **148/148, 4 files PASS**, `.hermes/tmp/preview-last-focused.log`.
- `node apps/web/node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/web/tsconfig.json` → **PASS**, `.hermes/tmp/preview-last-web-typecheck.log` empty.
- `node node_modules/eslint/bin/eslint.js apps/web/src/offline/offline-api.ts apps/web/tests/existing-entry-media-vertical.test.ts apps/server/tests/fixtures/paired-bootstrap-bytes.mts` → **PASS**, `.hermes/tmp/preview-last-lint.log` empty.
- `git diff --check` → no diff errors (existing LF/CRLF notices only), `.hermes/tmp/preview-last-diffcheck.log`.
- B from spike/android: `./gradlew.bat :app:testDebugUnitTest --tests com.speechless666.t3.spike.PairedBootstrapBytesTest --tests com.speechless666.t3.spike.SecurePairingTest --console=plain`, JAVA_HOME `C:/Program Files/Eclipse Adoptium/jdk-21.0.7.6-hotspot`, ANDROID_HOME spike `.android-sdk`, T3_TEST_REPO `D:/Project/TagTraceTrove` → **BUILD SUCCESSFUL, 6/6 JVM tests PASS**. `.hermes/tmp/preview-last-bootstrap-jvm-green.log`; XML preserved in `.hermes/tmp/preview-last-jvm-results/`.
- **Remaining unrelated grouped-gate issue:** `node node_modules/typescript/bin/tsc --noEmit -p apps/server/tsconfig.json` currently FAILS at untouched `apps/server/tests/integration/secure-pairing-recovery-ui.integration.test.ts(31,114)`: `Property 'csrf' does not exist on type '{ devices: unknown[]; recovery: { libraryId: string; message: string; }; }'`. `.hermes/tmp/preview-last-server-typecheck.log`. No claim of all-tree GREEN; no unrelated edit/audit to fix it. Parent should account for this during owned grouped gates.
Patch tool automatic TS6053 MSYS per-file lint is invalid here; actual project checks above are authoritative.

## Preservation / modified scope
Complete read_bytes backups before existing edits: `.hermes/tmp/preview-last-safe/start/manifest.json`; additionally backed up existing secure-pairing fixture/test before investigation, neither modified.
Final full bytes of **four owned files** plus SHA256/byte sizes/start hashes: `.hermes/tmp/preview-last-safe/green/manifest.json`.
Own actual-byte diff `.hermes/tmp/preview-last-own.diff` inspected: only one import + deletion provenance/receipt/verification blocks, permanent two-case test/harness recovery knobs, two new isolated fixtures; no unrelated production deletion/rewrite.
Current offline-api SHA256 `5a6b0295a98a6ff6b4b0ce851f81a9cf6a6e3ac269c6ec8e07140f9957403c87`, 318809 bytes; preserved start equals supplied `66d87078e721fe3299f3d479f24c2b7f8de1f80b4ea67ed1233c771180f7b95f`.
Existing atomic-stage/native-cancel/thumbnail source intact; no native/auth production edits. CURRENT/shared handoff/board untouched. Formal DB/assets/default server protected. No HEAD/recovery/checkpoint rollback, git reset/stash/checkout/commit. Temporary listener/data cleaned in finally. Existing T3 skill reference updated with proven recipe and correct layered evidence.
