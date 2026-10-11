# Gallery / Preview release gate plan

Status: IMPLEMENTED, BUILD-TIME GROUPED GATES PASS, FROZEN v41 APK BUILT AND VERIFIED. Later concurrent Author-rating edits are not part of this artifact and are not implicitly current-tree GREEN. Device/deployment remain UNVERIFIED. See `offline-extension-apk-verification.json`, `offline-extension-bounded-review.md` and the authoritative v41 section of `docs/offline-gallery-preview-progress.md`. The preparation checklist below is historical, not an active pending plan.

## Preconditions

- Close the finite acceptance board in `docs/offline-gallery-preview-progress.md` with real per-slice evidence, including two-queue causality, staged cancellation, media identity/order/bytes and verified snapshot/ACK cleanup.
- Read `.hermes/artifacts/preview-offline-implementation.md` and inspect actual code/tests; worker self-report is not a release pass.
- Preserve `.hermes/tmp/offline-api-restored-validated.ts` and the actual original v40 bundle copy. Do not overwrite forensic evidence with a new build. Parent has now actually preserved/byte-verified the v40 marked JS under `.hermes/tmp/release-preserved-v40/manifest.json`.
- Backend compatibility is part of delivery: the new APK's capabilities/media readers require the current server code. Packaging does not reload an already-running server; do not restart/deploy it automatically. State any necessary user-controlled T3 server restart separately at final delivery.
- Reconcile shared/native contract kinds, generated Java contract and fixture matrices. Foreground-only media work must be truthful and not block independent owners.
- No default DB/service/probe/deployment or release-key migration. No commit/reset/stash.

## Grouped code gates

Use Node 22 on `C:/Users/hzy/AppData/Local/hermes/node` and pnpm through `npm exec --yes --package=pnpm@10.15.0 -- pnpm`.

1. Actual root Vitest run and explicit integration config; retain structured JSON/logs and distinguish them from previous recovery passes or virtual-host checks.
2. Workspace typecheck, root lint, root build and `git -c core.safecrlf=false diff --check`.
3. Affected native JVM suites and current-kind matrix. Authority test class may require a 600-second foreground budget; do not count a timeout as PASS or terminate unrelated processes.
4. Verify no test/probe touched formal DB/assets. Device-only behavior remains a separate evidence lane.

## New APK identity and build

Intended next identity, not yet applied: versionCode 41, versionName/build marker `0.0.41-c3-gallery-preview-offline`.

After the feature writer returns and grouped gates close, the parent changes:
- `spikes/001-android-webview-shell/android/app/build.gradle` versionCode/versionName.
- `apps/web/src/GalleryApp.vue` `DIAGNOSTIC_BUILD` (current marker is still v40).

Re-run affected gates after identity changes; prepare Web from the final built root UI, run local Capacitor copy, then Gradle `:app:assembleDebug` using JDK21. Keep the existing debug signer to allow upgrade from the actual v40 APK. Do not install on a device or switch keys without separate authority.

Confirmed prerequisites at preparation time: JDK21 executable, shell `gradlew`, SDK build-tools 36.0.0 `aapt.exe` and `apksigner.bat` exist.

## Artifact verification

Final proposed path: `spikes/001-android-webview-shell/T3-v41-offline-gallery-preview.apk`.
Previous actual APK: `spikes/001-android-webview-shell/T3-v40-offline-read-latency.apk`.

Use `.hermes/artifacts/verify-offline-extension-apk.py` with the final APK, previous v40 APK, versionCode/name and marker. It checks:
- Exact APK Web asset set and byte equality against shell `web-dist`.
- Hashed asset bytes equal final `apps/web/dist`.
- Only expected native-generated Cordova extras, with exact copied bytes.
- Real package version from aapt.
- apksigner verification and certificate equality with v40.
- Final SHA-256 and artifact size.

Do not substitute the old v40 prebuild report for these checks. Update CURRENT/progress/completion/Android README only with actually executed results. Deliver the verified APK and one compact optional compound device sequence for the new Gallery/Preview flows; do not reopen the user-closed old acceptance register.
