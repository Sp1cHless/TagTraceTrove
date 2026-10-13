# Mobile / responsive / device-acceptance board

Authoritative consolidation of the T³ mobile workstream: the product boundary,
the WebView shell architecture, the responsive shell and touch model, image and
native-transport performance, pairing/TLS/security, the device-acceptance
history, and the build/packaging facts. The offline/sync side has its own board
in `docs/offline-sync.md`; the two overlap on the Android WebView shell.

It absorbs the narrative of `mobile-handoff.md`, `mobile-prep-brief.md`,
`app-online-ui-latency-study.md`, `offline-device-test-guide.md`,
`v49-device-acceptance-checklist.md` and the APK notes in `spikes/001-android-webview-shell/README.md`;
durable facts from those files are folded in below. The retired source documents are archived
byte-identically under `.hermes/archive/docs-pre-consolidation/docs/`.

---

## 1. Product boundary

### What mobile is

- The mobile client is the **same web UI**, same Hono server, same SQLite
  library, UI/API/assets from one origin. It is **not** a port written per phone
  model.
- The delivered mobile client is the **Android WebView shell** (the
  `spikes/001-android-webview-shell` Capacitor app). The earlier phase ran the
  same web UI in phone Chrome over home Wi-Fi; that responsive/browser layer is
  still the foundation.
- Chrome is the primary real-device browser, but the implementation uses
  standard Web capabilities, feature detection and progressive enhancement — no
  UA sniffing and no Chrome-only branches. iOS Chrome is still WebKit; “tested
  on Chrome” is not cross-engine proof.
- The final goal (outside import) is **full read/write parity**: Home, Gallery,
  Entry, Author, Search; Recently viewed / View later / Random / Collections;
  all filtering/sorting/paging/rating/Like/source-open and SFW-NSFW behaviour;
  manual Entry/Author creation; Entry/Author editing, Tag/Facet/Content/Rating
  editing; Author Directory and Collection sub-folder create/move/sort/remove;
  all existing Advanced-editing non-import abilities; all existing delete
  operations; Settings/theme/six accents/language/display preferences.

### What is desktop-only

- site-probe folder import.
- Batch import.
- Import flows that depend on desktop drag-and-drop / folder selection / preview
  / one-time import-collection checks.
- The “import rule creation” page is unusable on a phone by design: its
  annotation page is opened by the tool on the server machine itself over
  loopback `127.0.0.1:<port>`, which the phone cannot reach. This is **not a
  defect** to fix; it should be greyed out with a “not available” note (the spec
  did not say so and the phone behaviour was deliberately left unchanged).

“Import is not supported on mobile” does **not** mean mobile is read-only: apart
from the import flows above, the goal is full read/write.

### Explicitly out of scope

- save/share archive export.
- Public-internet access, automatic port mapping, device discovery,
  unauthenticated exposure outside trusted home Wi-Fi.
- (Originally) PWA/Service Worker/offline sync and native app packaging — these
  were later delivered as the WebView shell + offline subsystem; the optional
  pure-browser PWA remains an optional path, not a second required client.
- Boot auto-start, resident foreground service, infinite background survival,
  post-force-stop execution.

### Not-to-be-overridden constraints carried from the product board

- Gallery is a read-time projection of `Entry.type`, never a table; Collection is
  the only persisted curation grouping (Entry one nested level, Producer flat).
- Entry/Producer Tag vocabularies are strictly separate; Entry Tags must live in
  a Facet under a Section of the same Entry type.
- New schema requires a new immutable migration, in the order
  migration → probe → real-SQL integration → doctor → API → UI.
- Tests never write `.data/library.db`; write tests use in-memory or isolated
  temporary file DBs.
- `components/EntryCard.vue` is the only work-card implementation; pages must not
  copy card layout.
- All visible copy goes through `i18n.ts` en/zh-CN dictionaries; colors go
  through `theme.css` tokens (light/dark + six accents).
- Media keep their natural aspect ratio; do not use `object-fit: cover` to crop
  an Entry page for phone cards.
- Sidebar navigation always has top priority; Back must restore the true source.
- Destructive actions keep two-stage confirmation; never restore
  `window.confirm`.

---

## 2. Architecture facts (WebView shell, LAN pairing, native plugins)

### Stack

- Web: Vue 3 `<script setup>` + TypeScript + Vite; no UI/CSS framework.
- Server: Node + Hono + better-sqlite3; the production server serves
  `apps/web/dist` from the API origin.
- Default address `127.0.0.1:8765`.
- The production API base is derived from the page origin, so the phone's LAN
  address needs no separate API base.

### Capacitor WebView shell

`spikes/001-android-webview-shell/capacitor.config.json`:

- `appId: com.speechless666.t3.spike`, `appName: T3`
- `webDir: web-dist`, `server.androidScheme: https`, `server.cleartext: true`
- `CapacitorHttp.enabled: true`

The shell bundles the built web UI inside the APK (`web-dist`), so a phone can
cold-launch the UI without a remote page load. `prepare-web.mjs` prepares
`web-dist`. Native Java (`android/app/src/main/java/com/speechless666/t3/spike/`):

- `MainActivity` — WebView host + sub-resource interception
- `PinnedLanTransport` — pinned-TLS HTTP transport to the desktop
- `PairedTransportPlugin` — the JS↔native bridge for paired requests
- `PairingState` — pairing/capability identity (`verify()` is itself a
  `GET /api/sync/capabilities`)
- `PairingVault` — Android Keystore-backed credential storage
- `TrustedLanPairing` / `SecurePairing*` — pairing handshake
- `NativeMutationPlan`, `AppliedReceipt`, `TransferLedger` — durable mutation
  planning/ledger
- `BackgroundTransferPlugin` / `BackgroundTransferWorker` — finite WorkManager
  background transfer

`offline/native-shell-service-worker.ts` retires a stale PWA Service Worker
inside the Capacitor shell (unregisters registrations, deletes only `t3-shell-*`
caches, one guarded reload per WebView lifecycle) so an APK upgrade cannot keep
running an old bundle; IndexedDB, Outbox, staged media and the offline media
cache are untouched.

### LAN pairing (desktop side)

- LAN binding needs **both** `T3_ENABLE_LAN=true` **and** `T3_HOST=0.0.0.0`.
  `T3_ENABLE_LAN` is the explicit permission to cross the non-localhost bind
  guard; `T3_HOST` decides the actual listen address.
- `T3.exe` (tray launcher, `tools/t3-launcher/`) defaults to `127.0.0.1`. The
  tray’s `Allow phone access (LAN)` confirms trusted-network intent, restarts the
  owned server with the two LAN variables; health checks and `Open T3` stay on
  localhost. `Mobile addresses` lists every active RFC1918 IPv4 URL and copies
  the selected one; it never assumes a single NIC. Disabling LAN restarts
  localhost-only; Exit kills the server process tree.
- Windows Firewall is never changed automatically; help is manual and
  Private-network-only (allow Node.js on Private, never Public).
- `/api/pairing/status`, `/offer`, `/revoke`, `/forget`, `/recover` live in
  `apps/server/src/http/paired-server.ts`; the loopback-only desktop
  diagnostics/revoke/identity-reset path is deliberate (LAN cannot call it).

### Shared state

- `View later` is shared library data, not device-local: migrations `011`
  (Entry) and `012` (Producer) create library-wide ordered lists; SQLite is the
  sole authority; GET plus idempotent membership add/remove; legacy
  `localStorage` `t3.view-later` is merged (union, not overwrite) on first
  successful start and then removed. No WebSocket/SSE: another device may be
  briefly stale but converges on refresh/re-enter/focus, and requests are
  serialized so a slow stale response cannot overwrite a newer one.
- `locale`, `accent`, Show NSFW, rows-per-page and tab order remain **device-
  local** preferences.

---

## 3. Responsive shell & breakpoints

- Below **44rem** the shell uses a left **drawer**; the header keeps Menu,
  theme and Settings; the drawer contains search, all destinations and the
  create entry point.
- The drawer supports a close button, a mask, Escape and Browser Back;
  selecting a destination auto-closes the drawer and keeps the target page.
- The drawer must not merely stack the 18rem sidebar above the content.
- Facet filters (Gallery/Author) collapse by default on mobile and open the full
  filter surface via a 44px `Show/Hide filters` control; filter combination
  semantics are unchanged.
- Connected tabs and pagination scroll horizontally **within their own region**
  and never widen the page; the active tab must be auto-visible.
- Shell uses `safe-area-inset-*` and `100dvh`.
- Below 44rem, rows per page are **twice** the Settings rows value; desktop keeps
  its original value. This two-times multiplier is preserved by the controlled
  `PagedCardGrid`.
- Checked viewports: **360 / 390 / 430 / 768 / 1280px**, landscape **844×390**,
  and a soft-keyboard approximation **390×420**; `document` width never exceeded
  `viewport`/`client` width in those checks.
- Responsive CSS must be re-checked on desktop; no whole-page rewrites, no
  desktop regressions.

---

## 4. Touch interaction rules

- **Do not treat HTML5 drag-and-drop as the mobile plan.** The unified model is
  tap: enter an explicit “arrange/move” selection mode → select the object →
  show valid targets or a bottom action area → show the selected object, target
  and cancel → execute via the existing API. Long-press may be a **shortcut**
  into that mode, but every key action needs a discoverable tap path and there
  must be cancel and current-selection feedback.
- Must be mapped: Tag → Facet; Work + Work → new Directory; Work → Directory and
  Directory member → loose works; Collection member → child folder and child →
  parent; Recent/View later tab reorder; Collection reorder.
- Touch targets are at least **44×44px** in principle.
- Hover may only enhance; it must never carry the sole hint or action.
- Entry/Author toolbars wrap, collapse, or become a mobile action area on narrow
  screens.
- Entry read mode: Author and Tag chips are standard **single-click** buttons
  (not double-click). Entry Tag tap-select → move to a target Facet.
- Entry inline pages/date editing: desktop double-click, **touch single-click**
  (`(hover: none)` branch; phones have no double-click); Enter saves, Esc cancels,
  blur saves. Empty values show `+ pages` / `+ date` chips (same style as
  `+ Tag`) which eat the 44px minimum height, and the date accepts
  `yyyy` / `yyyy-mm` / `yyyy-mm-dd`.
- Narrow Rating uses a **compact grid** so the five stars are not pushed out by
  the title and sort buttons. (The `360` rating-row overflow was found in the
  real GalleryApp and repaired with a rating-only responsive grid.)
- Collection “add to” dropdown: on mobile it is positioned from the **measured**
  trigger button (left-align, width-limited to available space) instead of the
  old “button is at top-left” rule — measured on a 360 viewport the button was
  x241–285 and the menu rendered x93–285, fully inside the screen.
- Mobile Settings panel: when opened, it **measures** the backing
  `.content-panel` and aligns left/width/top to it (bottom free); desktop keeps
  the button dropdown. (The panel is a child of the header, whose
  `backdrop-filter` makes it a containing block for `position: fixed`, so the
  measurement is corrected against actual rendering once — phone measured both
  frames at left 12 / right 348 / top 72 / width 336.)
- Delete: first tap arms, second tap executes; armed state and cancel/timeout are
  clear; no native confirm; after delete the context returns correctly.
- Every touch write action’s success, cancel and API-failure states must be
  checked.

---

## 5. Image / media performance

- Shared card images are approved by `IntersectionObserver` and only then
  assigned their real URL; once approved they request immediately with **no
  second native `loading="lazy"` gate**, retain `decoding="async"`, and stay
  visually hidden over the reserved card geometry until load completes. Browsers
  without `IntersectionObserver` receive the URL immediately (avoids blank images
  on old browsers).
- The asset route uses content **ETag** revalidation with
  `private, max-age=0, must-revalidate`. Desktop CDP measured a return to a
  Gallery creating ~20 `200` requests (~108ms) because Vue branch rebuilds image
  nodes and the old `no-store`; after the ETag change a warmed cache returns with
  zero image requests, while replacing media at the same URL still yields the new
  content via the changed ETag. The first-visit transfer/decode cost remains.
- Card-sized managed media goes through `entryCardMediaRef`:
  `/api/thumbnails/...` → source-hash-addressed **512px WebP**, immutable
  caching; not-yet-backfilled sources redirect to the original. Entry detail
  keeps the original asset.
- **Derived-thumbnail generation/backfill/delete/backup/asset-route was
  deliberately deferred** to the “ten-thousand-scale / DB-architecture” boundary.
  Shrinking the display size in CSS does **not** reduce transferred bytes and
  must not be passed off as an optimization.
- The media-pipeline mechanics (cache sharding, application-level cache path,
  resumable preload) are on the offline board (`docs/offline-sync.md` §5).

---

## 6. Native transport costs

The online “UI jumps / latency / looks like a reload when returning” symptom was
root-caused to the **native transport**, not the network or server. Desktop
measured the paired TLS listener at **7–11 ms for a fresh connection + TLS
handshake + response, 0.24 ms reused**, while the same read on the phone measured
**143–413 ms**. Four costs sat on **every** request:

1. **A duplicate identity round-trip per request.** `PairingState.verify()` is
   itself a `GET /api/sync/capabilities` and was called before *every* request —
   once in the plugin (`request`) and again in the WebView sub-resource
   interceptor (`MainActivity.shouldInterceptRequest`, i.e. **per image**), so
   “fetch one image” = 2 server round-trips.
2. **A fresh Keystore decryption per request.** `PairingVault.load()` ran
   `AndroidKeyStore.load(null)` → `getKey` → AES-GCM decrypt (a hardware/bound
   round-trip) in both the plugin and the interceptor.
3. **A fresh HTTP client and SSLContext per request.** `PinnedLanTransport.request()`
   built `new OkHttpClient.Builder()...build()` and a new `SSLContext` in the
   method body — no connection reuse, so every image redid the TCP+TLS handshake
   and built its own dispatcher/connection-pool threads.
4. **One single thread shared by all requests.** `PairedTransportPlugin` had one
   `Executors.newSingleThreadExecutor()`. Media preload (after v45, ~90× faster)
   occupied it continuously, so the UI’s own requests queued behind it.

UI amplifiers: `openEntry()` awaited three requests before setting
`activeEntry`, and `isHomeView` is literally “no active entry”, so before data
arrived the UI was semantically Home — hence “first Home, then entry”, with
secondary detail requests arriving one by one.

**v46 fix (native-only; no server/schema/web change):**

1. Cache the decrypted pairing state keyed by the stored ciphertext (invalidated
   by re-pair/clear, cross-process), instead of decrypting per request.
2. Reads carry only the token (the server is authoritative; a revoked device
   gets a 401 on that request); **writes still strictly confirm first**.
   `verify()` uses an **exclusive new connection** (a pooled connection would let
   a changed server certificate escape the handshake pin check).
3. Reads use a pooled client (with one transparent retry on a
   server-closed idle connection); writes stay unpooled and non-retrying (every
   write re-verifies the current certificate).
4. Reads run on a 4-thread pool; writes keep the original serial channel.

**Measured after v46 (device, production library):** open entry **581ms →
129/213/132ms** (574ms → 100/140ms with media fetching in the background);
`openEntry`’s three requests went from “third sent at 301.9 ms” to **all sent
within 6.7 ms**; warm steady-state per request **11–16 ms** (first new connection
pays one ~100 ms handshake).

The **dominant** remaining cost was the client, not the transport: every read
re-ran a full zod projection of the whole 8.85 MB snapshot (~200–300 ms, called
in **65** places; `getEntry` projected before sending). Caching the projection by
`(revision + activeGeneration)` removed it, leaving 100–200 ms (mostly Vue
rendering the detail).

Symptom 2 (“switch out and back looks like a reload”) was **not reproduced** in
three scenarios (HOME background 25 s; real switch to a browser 45 s; background
30 s under 240-image media pressure): same process, same `timeOrigin`, same
entry, no reload, no lost view. The best remaining explanation was Android
reclaiming the WebView render process under the earlier memory pressure. Probes
(`performance.timeOrigin` marker + `dumpsys meminfo`) are frozen under
`spikes/001-android-webview-shell/device-probes/` (`entry-open.mjs`, `rate.mjs`,
`cdp.mjs`; README notes the required `adb forward` after reinstall), so a
recurrence can be captured immediately. No “restore last view” logic was added.

---

## 7. Pairing / TLS / security

- Desktop settings expose a **Secure pairing** area: `Create pairing QR
  (expires in 2 minutes)`; the phone shows a `Scan desktop QR / re-pair` button.
  The code is **single-use**: a claimed code is refused on re-scan; an expired
  code is refused; two concurrent clients only let one win; the QR carries no
  long-lived session token. A paste fallback exists and is tested separately
  (pasting JSON is never counted as a scan pass).
- API create/PATCH, capabilities, snapshot, replay **and WebView cover/preview/
  Author artwork** must all use the pinned TLS transport; JSON success is not
  image-path success.
- Credentials are stored Keystore-encrypted; after a real process kill,
  force-stop or device restart the app still connects, and a corrupt private
  credential fails closed without clearing snapshot/Outbox.
- Pinned TLS: replacing the server certificate at the same endpoint rejects the
  old pin (no auto-trust of a new certificate); after replacement, a new QR is
  required and old tokens/codes do not revive. HTTPS↔HTTP cross-origin redirects
  are refused and `Authorization` is not forwarded; Source external links stay on
  the system browser and are outside that authorization path.
- Session revocation is explicit and reversible: revoking a device refuses its
  API/media/background writes while retaining its work and Blobs; re-pairing is
  an explicit action. Revoked records can be removed from the desktop
  (`/api/pairing/forget`; live devices refuse deletion, so cleanup cannot bypass
  revocation).
- Desktop loopback-only distribution/revoke/identity-reset/residual-lock
  recovery: LAN cannot call them; wrong Origin/CSRF is refused; recovery requires
  an explicit library/PID and refuses a live owner, a wrong PID and dangerous
  paths. A crashed owner lock is recovered explicitly without touching the
  business DB/assets or the phone’s work, and never silently clears the lock or
  changes the certificate.
- With the secure listener enabled there is **no coexisting unauthenticated LAN
  HTTP write bypass**; no global CA install, third-party account, VPN or public
  exposure is needed.
- `autoAllowMobileConnection` (default on) lets the launcher skip advertising the
  pairing address and `server-cli.ts` refuse the secure listener; see
  `docs/offline-sync.md` §8.
- Android’s private WebView library is excluded from automatic OS backup/device
  transfer (v24 shell), trading device-replacement recovery of unsynced
  phone-only work for reduced silent backup exposure.

---

## 8. Device acceptance history & checklist pointers

Primary test device: **WGM77LVKD6RW9XZX**. Device acceptance is a separate gate
from automated/JVM evidence; JVM/script pairing bytes do not establish actual
WebView/PluginCall/Keystore or force-stop behaviour.

### Recorded device passes

- **2026-09-21** — the v7 candidate: offline View, Like and Entry View later
  optimistic behaviour plus successful reconnect replay (together with the
  earlier accepted offline manual Entry/media flow, C0 was marked `VALIDATED`).
- **v39** — composer Author field at 44px matches the other fields; with the
  keyboard open, real IME typing `a` shows candidates A1/A2 above the field,
  fully visible (offline, candidates from the local snapshot).
- **v40** — same Entry opened with the capability probe in flight dropped from
  **7674 ms → 253 ms**; offline tag editor Enter commits a chip within 2129 ms
  without blur; tag write → chip 1169 ms → 799 ms; Author field 44px; IME
  candidates visible.
- **v45** — media cache sharding: legacy migration moved 11,056 entries in
  ~2.5 min with zero re-downloads; rate 1.6 → 35 → **147 images/minute**.
- **v46** — open entry 581ms → 129/213/132ms; three requests within 6.7 ms;
  steady-state 11–16 ms; symptom 2 not reproduced (three scenarios).
- **v47/v48** — icon + boot screen on the phone (launch screen is the
  white-and-centred-icon picture, web boot screen dismisses itself); LXGW WenKai
  font stack active, data rows `Inter`, UI renders in Chinese (the phone’s stored
  locale was switched `en` → `zh-CN` so the change was visible; Settings →
  语言 switches it back).
- **v49 r8–r25 (2026-10-11/12)** — device-verified fixes through the r-chain:
  r8 Author-editor Save; r9 deleting a Tag on the kept work of a queued merge;
  r10/r16 queued-Facet/Zod fixes and the layout-projection latency cut
  (`structuredClone` of the whole saved copy per queued layout original →
  projection 1098 ms → 332 ms, whole gesture 1414–2212 ms → 349–855 ms);
  r19 media-editor refusal wording; r20–r25 the local-final-state model and the
  three r25 settlement fixes. **r25**: existing phone work settled **12 → 0**,
  operations/media/local media and deletion intents all zero, no
  conflicts/failures/errors; real Wi-Fi disconnect/reconnect drove
  offline → syncing → updating → online, advanced saved generations 29 → 31,
  banner removed; a 12-second idle observation kept generation/update time
  unchanged; bottom diagnostic and real clipboard write verified through the
  app’s own WebView.
- **1.0.2 (2026-10-13)** — the Gallery filter bar on the phone, verified on
  `com.speechless666.t3.spike` 1.0.2 (versionCode 102) cover-installed over 1.0.1
  with pairing, offline copy and pending work preserved: a filter row never wraps,
  so its × stays on the row’s first line and a long Facet or tag name is
  ellipsised instead of pushing the button down; the Authors row reads as one line
  (`作者` / picker / ×, left to right); and the bar’s head puts the small label on
  the toggle’s own line with the toggle compact at the right edge. Same build: a
  Like now writes its counts to the grid card as well as the open work, so the
  card’s badge appears without a reload. APK SHA256
  `0f8dc3c04d700b2d78ca0e82826a657bfd14cc4c30d5d6445bf37d248c72fb3d`.
- **1.0.3 (2026-10-13)** — the same bar with **one line per row**, verified on
  `com.speechless666.t3.spike` 1.0.3 (versionCode 103) cover-installed over 1.0.2 with
  pairing, offline copy and pending work preserved: a rating row’s three selects now
  divide the line between them (`评分项` / `大于` / `3 星` / ×, left to right — a native
  select sizes itself to its longest option, which is what pushed the star picker onto a
  second line), a chosen Facet shares its line with the tag input (`Series` / input / ×),
  and a row that does wrap keeps its × on the first line instead of centring it between
  the two. APK SHA256
  `0dad307638715bd521d0123f3d610a0190f00cfd1847e5d2ca28e6831338104a`.

### Formal 1.0 mobile acceptance (2026-10-13)

The user confirmed that mobile acceptance for the formal 1.0 release is complete. Current packaged release identity
is **1.0.5 / versionCode 105**, application ID `com.speechless666.t3.spike`; APK SHA256
`2bf0d8a18baa8846aba726f9d5e96075f811749623caa1ffa299ba54ac0dde16`. The publication check verified its expected
Release signer, non-debuggable flag and checksum. User acceptance is recorded separately from the earlier automated
installation logs and screenshots; it does not add new command measurements or an Android instrumentation run.

### Checklist pointers

The four acceptance documents this board consolidated are retired; they are archived
byte-identically under `.hermes/archive/docs-pre-consolidation/docs/`:

- `offline-device-test-guide.md` — plain-language operator manual (click / expected / what counts
  as broken).
- `offline-validation-checklist.md` — the formal C0–C3 case register (`SHELL`, `PAIR`, `READ`,
  `EDIT`, `CREATE`, `MEDIA`, `DELTA`, `RESTORE`, `BG`, `SAFE`, `PRIV`).
- `v49-device-acceptance-checklist.md` — the v49 board (P/A/B/C cells; B6–B23 map to the r-chain
  fixes).
- `app-online-ui-latency-study.md` — the v46 transport study.

Still live: `spikes/001-android-webview-shell/README.md` — per-APK automated/packaging evidence and
the frozen device results; `spikes/001-android-webview-shell/RELEASE.md` — release key/build
instructions.

Result-record rule: source/automation completion, narrow source review, APK
integrity and real-device acceptance are **different statuses**; only current-
build device evidence ticks a case.

---

## 9. Build / packaging facts relevant to mobile

### Release configuration

`spikes/001-android-webview-shell/RELEASE.md`:

- Display name **T3**; versionName and versionCode come from root `release.json`, currently **1.0.5 / 105**;
  package name stays `com.speechless666.t3.spike` (an existing
  app identity, not the display name). Later updates must bump `versionCode` and
  use the same release private key.
- Release is non-debuggable; WebView debugging follows Capacitor’s debuggable
  decision; no code obfuscation (avoids extra reflection-compat risk).
- Release key material lives outside the source tree in `~/.t3/signing/`
  (`android-release.p12`, `android-release.properties`); `T3_ANDROID_*` env vars
  or `T3_ANDROID_SIGNING_PROPERTIES` can point at it for CI. A missing credential
  makes the release build **fail explicitly** — it never falls back to a debug
  key or an unsigned package.
- **The debug test chain (v36–v49) uses the Android debug certificate** (signer
  `1035333c…fdf41` across v43–v49). The release certificate differs, so a release build cannot
  upgrade a debug install in place (nor the reverse). The migration is explicit: connect to the
  original desktop library and confirm pending work is **zero**, then uninstall the old test build
  and install the release build, then re-pair and re-download the offline copy — never uninstall
  while unsynced work remains. See `docs/release-installation.md`.

### Build steps

Formal distribution uses root `Release.bat` / `tools/release/release.ps1`, which takes its version from `release.json`
and produces Windows and Android artifacts from one frozen Web build. The underlying Android build steps are:

1. Build `apps/web` with the project-compatible Node
   (`VITE_T3_BUILD_ID` matches the version in `release.json`).
2. Run `prepare-web.mjs`, then Capacitor `copy android`.
3. In `android/`: `./gradlew.bat assembleRelease --console=plain`
   (output `android/app/build/outputs/apk/release/app-release.apk`).

Packaged-asset verification: **15 packaged Web files** must be byte-identical to
the prepared `web-dist`, with the expected build marker present and the previous
one absent; `aapt` confirms package/version/minSdk 24/targetSdk 36 and the
permission set (`INTERNET`, `CAMERA`, `WAKE_LOCK`, `ACCESS_NETWORK_STATE` +
package receiver); `apksigner` confirms v2 signing and a signer identical to the
prior release.

### Toolchain caveats

- Test/lint/typecheck/build must run on the same **project-local Node (currently
  Node 22)** the launcher selects. A newer system Node (26+) defines its own
  `localStorage` getter that vitest’s jsdom does not override, so jsdom tests
  touching `window.localStorage` fail with `Cannot read properties of undefined
  (reading 'clear')` — a runtime mismatch, not a code fault.
- Root runs may need the bundled Adoptium **JDK 21 first on PATH** (Oracle JDK 25
  class files are unreadable to Robolectric 4.14.1).
- Native JVM tests need the repo Node 22 on `PATH` (otherwise four classes fail
  with `ERR_DLOPEN_FAILED`), must run with `T3_TEST_REPO` pointing at the repo
  root, and are run **per test class in separate forks** — the Robolectric native
  DLL crashes in a single combined run.
- Web-quality gates (all must pass): `pnpm test`, `pnpm test:integration`,
  `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm db:probe`, `pnpm db:doctor`.
  Browser write verification only ever uses an isolated backup of the formal
  database.

### Icons, boot screen and font

- `apps/server/scripts/generate-icons.mjs` derives everything from
  `apps/web/icon/icon_white_background.png` and `icon_transparent_background.png`
  (it lives beside the server because it needs `sharp`, and writes the `.ico`
  itself): web `favicon.ico` (16/24/32/48/64), `icons/icon-192.png`,
  `icon-512.png`, `icon-maskable-512.png` (scaled to 0.56 so the drawing survives
  a circular mask), `apple-touch-icon.png`, `boot.png`; Android
  `mipmap-*/ic_launcher.png`, `ic_launcher_round.png`,
  `ic_launcher_foreground.png` (transparent drawing inside the 108dp safe zone)
  and every `drawable*/splash.png` (white, icon centred at 42% of the short
  side). Plain square icons carry a 0.86 margin so a launcher corner mask cannot
  clip them.
- `index.html` carries the **boot screen** inline (markup + style, so the icon is
  on screen from the first frame); `src/boot-overlay.ts` dismisses it only once
  the connection phase settles (`null`/`no-copy`) with a 4 s give-up deadline.
  The Android launch window shows the same `@drawable/splash`, so the first paint
  is identical. The tray launcher carries the same `t3.ico`.
- The app font is **霞鹜文楷 (LXGW WenKai Lite, SIL OFL 1.1)**, applied app-wide on
  `body` and restricted by `unicode-range` to Han (Latin/numbers stay Inter);
  library values carry `.t3-library-text` and return to the platform stack. The
  shipped subset is 18,109 glyphs / 3,890 KB (`tools/fonts/subset-wenkai.py`:
  GB/T 2312 + Big5 + JIS X 0208 + kana + punctuation); it misses 0.2880% of the
  library’s own 628,575 characters, all Korean/emoji the full 13.2 MB font cannot
  draw either. Starting locale follows `navigator.languages` (any `zh*` ⇒
  `zh-CN`) when no stored choice exists; a stored choice wins.
