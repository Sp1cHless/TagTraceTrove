# 001 — Android WebView shell

## Question

Can T3 reuse its existing Vue production build inside a minimal Android WebView shell, retain its offline IndexedDB/Outbox implementation, and connect to a paired private-LAN desktop server without adding native screens or broad Android permissions?

## Approach

- Capacitor 8.5.2 Android shell; no native UI rewrite.
- `web-dist/` is generated from the existing `apps/web/dist` by `prepare-web.mjs`.
- The shell injects a private-LAN server origin into `<meta name="t3-api-base-url">` before the unchanged Vue bundle starts.
- Pairing is a disposable manual URL form stored in WebView `localStorage`; this validates the runtime-origin and persistence boundary before camera/QR work.
- Capacitor native HTTP patches `fetch`/XHR so the HTTPS localhost WebView can reach the explicitly paired cleartext private-LAN endpoint during this trusted-home-LAN spike.
- Android SDK packages are isolated under `.android-sdk/`; the system Android environment is not modified.

## Build

Requirements:

- Node 22+
- JDK 21 (`C:\Program Files\Eclipse Adoptium\jdk-21.0.7.6-hotspot` on the spike machine)
- Android platform 36 and build tools (the spike keeps an ignored local SDK)

Commands:

```text
# repository root
npm exec --yes --package=pnpm@10.15.0 -- pnpm build

# this directory
npm install --ignore-scripts
npm run prepare:web
npm run cap:copy
set JAVA_HOME=<JDK 21>
android\gradlew.bat --no-daemon -p android assembleDebug
```

Output for the real-device validated build:

- `T3-C0-v4-offline-fix.apk`
- version: `0.0.4-c0-offline-fix` (`versionCode 4`)
- size: 4,343,105 bytes
- SHA-256: `66d6c35d7bec4c82e56aec87e925a3cd229d46ac7a21fba20df6a19efdc25f7d`

## Automated evidence

- Capacitor `add`, `copy`, and `doctor` passed.
- Gradle `assembleDebug` passed with compile/target SDK 36 and JDK 21.
- Every source `apps/web/dist` file was copied byte-identically into Android assets; Capacitor added only its two Cordova compatibility files.
- APK inspection found the current T3 JS bundle, pairing bootstrap, and enabled Capacitor native HTTP config.
- Manifest inspection found only `android.permission.INTERNET` plus AndroidX's app-scoped dynamic-receiver permission. No camera, notifications, storage, location, background service, VPN, accessibility, or boot permission is present.
- Desktop browser smoke proved:
  - pairing overlay appears when no server is stored;
  - HTTPS/public endpoints are rejected;
  - a private HTTP endpoint is persisted;
  - reload injects the expected `<server>/api/` base before the Vue bundle;
  - Change server clears pairing.
- The normal Web build remains unchanged when no runtime meta override exists; focused API tests and workspace typecheck/build passed.

## Verdict: VALIDATED

### Real-device acceptance (2026-09-20)

- The existing T3 Vue build can be packaged as a real debug APK without copying or rewriting its screens.
- A shell-supplied runtime API origin cleanly solves the `https://localhost/api` origin mismatch while preserving normal desktop behavior.
- The shell can remain minimal-permission and has a concrete APK artifact ready for device testing.
- Paired private-LAN JSON APIs and proxied Entry/Author/Collection media load in the WebView.
- A roughly 13,000-record snapshot persists in IndexedDB and becomes the active offline library about 30 seconds after the desktop server exits.
- Offline browse/search and seeded Work/Author Random operate from that snapshot.
- Source URLs open the system browser immediately without waiting for online usage tracking.
- Offline manual Entry creation enters the durable Outbox and replays successfully after the server returns.
- While Wi-Fi remains connected, a restarted desktop server is detected by the foreground capability probe and the app returns online automatically.

### Deferred beyond the C0 feasibility verdict

- explicit airplane-mode plus force-stop/cold-launch persistence acceptance;
- complete C2 mutation coverage: offline ratings, Content, Author View later, and later relationship operations;
- protocol-mismatch and library/epoch-change UX;
- QR camera scan (the spike intentionally uses a pasted private-LAN URL);
- release signing with a stable user-controlled key;
- app-specific TLS identity/pinning instead of trusted-LAN cleartext HTTP.

### Security boundary

This APK intentionally keeps the existing trusted-home-LAN HTTP model. It accepts only localhost or RFC1918 IPv4 HTTP endpoints and has no authentication or certificate pinning. It is a disposable spike, not a production APK and not suitable for untrusted networks.

## Completed C0 gate and promotion boundary

The feasibility verdict is now `VALIDATED`. Promotion into a maintained mobile project remains a separate productization step: preserve one Vue codebase and one sync protocol, then add QR pairing, stable signing, protocol mismatch UI, explicit external-link handling, and a stronger transport identity without broad Android permissions.

## Current C2 device candidate

- version code: `5`
- version name: `0.0.5-c2-offline-actions`
- artifact: `T3-C2-v5-offline-actions.apk`
- SHA-256: `11c4fa56ee47d9f94c4603b3fa55c2ccc07591371f54e5a2c9050b0a97da809b`
- scope: idempotent offline View/Like events and Entry View later desired-state add/remove, including optimistic snapshot projection and automatic replay
- status: automated gates passed; concentrated real-device acceptance pending
- intentionally still online-only: ratings, Entry Content, and Author View later

## C2 runtime diagnostic candidate

- version code: `6`
- version name: `0.0.6-c2-diagnostics`
- artifact: `T3-C2-v6-diagnostics.apk`
- SHA-256: `f8bf5343637eee21410c7221edbeddf330e16f68c62909592f60e5711e565de5`
- purpose: collect the actual device capability probe, cached capability metadata, facade mode, recent mutation outcomes, transport classification, and Outbox operation kinds after the v5 View/Like/Entry-View-later failure
- behavior boundary: diagnostic instrumentation only; it does not change capability gates, transport classification, enqueue rules, replay, or conflict behavior
- device report path: after the app enters Offline and the three actions are attempted, expand `Diagnostics` in the offline banner, tap `Refresh`, then `Copy`

## C2 native shell cache-reset candidate

- version code: `7`
- version name: `0.0.7-c2-cache-reset`
- artifact: `T3-C2-v7-cache-reset.apk`
- SHA-256: `21e0ae4855b4cca6b2a26846e9cf5cec8cab853c2e1e316e25e88de3f345da69`
- diagnosis: the v6 APK contained the diagnostic UI, but the real-device screenshot showed the old Offline banner with no Diagnostics button; an old PWA Service Worker/app-shell document was therefore still controlling the Capacitor WebView after the APK upgrade
- upgrade behavior: the Android-only SW update claims and navigates any old document once; the new bundle then unregisters Service Workers and deletes only `t3-shell-*` caches
- preserved state: IndexedDB snapshot, Outbox, staged media, pairing URL, and `t3-offline-media-v1` are not cleared
- real-device result (2026-09-21): `VALIDATED`; the new bundle loaded, offline View/Like/Entry View Later all applied optimistically, and reconnect replay synchronized them successfully
- diagnostics remain available for future device evidence but are not part of the normal acceptance flow

## C2 offline Entry rating candidate

- version code: `8`
- version name: `0.0.8-c2-offline-rating`
- artifact: `T3-C2-v8-offline-rating.apk`
- SHA-256: `08814edb3a8ac6588c564a6b040b9f4fd9c09455ddc4006239d2dca3bd9f3643`
- scope: existing Entry rating slots only; queues final nullable half-step values against the slot's permanent sync UID with `entry.rating.set`, never a delta or slot/layout edit
- consistency: optimistic snapshot overlay plus the shared Entry revision chain; same-value replay converges, any base-rating mismatch becomes a visible conflict, a missing/wrong-Gallery slot becomes an explicit failed operation, and one atomic Outbox transaction discards a blocker together with its later same-Entry dependent intents
- durability: migration 024 backfills immutable rating-slot sync UIDs; rating value, Entry revision/journal, and idempotent receipt commit in one SQLite transaction
- compatibility: capability-gated by `offlineEntryRating`; diagnostics remain available and include this capability
- automated evidence: 447 unit/web tests, 304 server integration tests, typecheck, lint, production build, `git diff --check`, APK content checks, Android build-tools 36 badging/permission checks, and a migration-024 dry run against a consistent read-only copy of the schema-23 production database passed
- real-device acceptance: install over v7, download/update the offline copy while online, disconnect the server, change one existing Entry rating, confirm the value updates immediately, reconnect, then confirm the value remains after sync/refresh
