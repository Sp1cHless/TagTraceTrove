# 001 — Android WebView shell

## Android 1.0.0 Release — current configuration

Formal label T3, versionName 1.0.0 / versionCode 100, dedicated Release certificate, non-debuggable. Signed APK `T3-1.0.0.apk` and verified public manifest `.hermes/artifacts/android-release-1.0.0.json`. Signing key/credentials live outside this checkout; backup/build instructions are in [RELEASE.md](RELEASE.md). The new signature does not directly cover-install over debug-signed r25; this artifact has not replaced the phone's existing data or been published. Earlier release records below are historical.

## v48 Chinese UI font and copy — authoritative current status

T³'s own voice is now 霞鹜文楷 (LXGW WenKai Lite, SIL OFL 1.1), applied app-wide on `body` and limited by `unicode-range` to Han, so Latin and the Arabic numerals stay in Inter; every library value (work titles, tags, author names, Section/Facet names, contents) carries `.t3-library-text` and goes back to the platform stack. The split is deliberate rather than decorative: scraped content is multi-language with rare glyphs, which a bundled subset cannot cover by construction, while the app's own copy is a closed set it covers exactly (measured: 0.2880% of the library's 628575 characters missing, all of it Korean or emoji the full 13.2 MB font cannot draw either). Also in this batch: the Chinese dictionary pass (`section` → 板块, `facet` → 维度), the shipped `common-template.json` renamed to Chinese, and `SuggestionInput` sized by `field-sizing: content` so a Chinese placeholder is no longer cut off. Full description and the two by-design residuals in `CURRENT.md`.

APK `spikes/001-android-webview-shell/T3-v48-cjk-ui-text.apk`，versionCode 48，`0.0.48-c3-cjk-ui-text`，SHA256 `38f8b66af9f34459eeb001e955215b623f07b0063d6517457254a5699b8e664e`。包内 Web 字节／marker 一致，签名者与 v43–v47 相同；装机后 `adb pull` 的 base.apk 与本地文件 SHA256 一致（覆盖安装，离线副本／Outbox／媒体缓存保留）。真机（WGM77LVKD6RW9XZX）实测：文楷字体栈生效且字体文件已加载、数据行报 `Inter`、标签合并／删除的三个输入框 75 = 75 放得下、`field-sizing` 在它的 Chrome 154 WebView 上受支持、界面渲染为中文。**手机上存的语言原是 `en`，本次已切成 `zh-CN`**，否则这批改动看不见（设置 → 语言 可切回）。**构建时工作树含另一条工作流未完成的 offline/native 代码**（其未跟踪测试 30 red、lint 5 red 均非本批引入），本 APK 因此包含它。

## v47 Icons and boot screen — previous candidate

`T3-v47-icons-and-boot.apk`，versionCode 47，`0.0.47-c3-icons-and-boot`，SHA256 `629a896592bd4ab59d88faa92bfccdea9ba76446c1a03a75f839318391ea0b33`（已装机）。图标／启动屏／起始语言见 `CURRENT.md`。

## v46 Transport latency — historical frozen artifact

研究全文见 `docs/app-online-ui-latency-study.md`。在线模式的卡顿与「先显示 Home 再跳进 entry / 字段一个个出现」不在网络或服务端：桌面实测配对监听器**全新连接 + TLS 握手 + 取响应 7–11 ms、复用连接 0.24 ms**，而同一读在手机上实测 143–413 ms。四个成本压在**每一个**请求上：`PairingState.verify()` 自己就是一次 `GET /api/sync/capabilities`（每个请求前都调，WebView 子资源拦截器里每张图再调一次）、`PairingVault.load()` 每次都走 Android Keystore 解密、`PinnedLanTransport` 每个请求都新建 OkHttpClient + SSLContext（无连接复用）、所有请求共用一条单线程而媒体预载（v45 后快 90 倍）一直占着它。`openEntry` 先 await 三个请求才设置 Entry，而 `isHomeView` 的定义就是「没有 Entry」，所以延迟表现为「先 Home」。

仅原生改动，无服务端/schema/web 改动：①已解密配对状态按存储密文缓存（重配对/清除即失效，跨进程成立）；②读请求不再自付一次身份往返（请求本身带 token，服务端才是权威，被撤销的设备在该请求上直接 401），写请求仍先严格确认，且 `verify()` 改为**独占新连接**（换证书会在握手时被拒）；③读客户端池化连接并对「服务端已关闭的空闲连接」重试一次，写客户端保持不池化、不重试（每次写重新校验证书）；④读走 4 线程池，写保持原串行通道不变。预期：单次读 250–700ms → 10–30ms。

门槛：typecheck（server 包当前带另一路在改的错误，web 干净）、lint、web build、1239/1239 web 单测，以及原生 13 个 JVM 测试类逐类 fork 全过（含新增的 `repeatedReadsShareOnePinnedConnectionPerPool`）。症状 2（切出再回来像重载）**尚未证实**：原生与 web 都没有「恢复时重载已渲染页面」的路径（web 只在退役旧 PWA worker 时重载一次且带 session 守卫；原生 `onResume` 的 8 秒看门狗只在 URL 为空白时补载），剩下最可能的解释是 Android 在后台回收 WebView 渲染进程 —— 待设备用 `performance.timeOrigin` 记号 + `dumpsys meminfo` 复测。

**真机实测（v46 装机后，正式库）**：打开 entry 由 **581ms 降到 129/213/132ms**（后台有媒体抓取时 574ms → 100/140ms），`openEntry` 的三个请求由「第 3 个 301.9ms 才发出」变成 **6.7ms 内并发发出**，单次请求稳态 11–16ms（首个新建连接付一次 ~100ms 握手）。主因是每次读都重做整份 8.85MB 快照的 zod 投影（约 200–300ms、被 65 处调用，且 `getEntry` 先投影再发请求）；按 revision + activeGeneration 指针缓存投影后消失。**症状 2（切出再回来像重载）在三种场景下都没有复现**（HOME 后台 25s、真切浏览器 45s、240 张图压力下后台 30s：进程/`timeOrigin`/视图全部保持），故未加「恢复上次视图」；探针固化在 `spikes/001-android-webview-shell/device-probes/`。

APK `spikes/001-android-webview-shell/T3-v46-transport-latency.apk`，versionCode46，`0.0.46-c3-transport-latency`，SHA256 `1e3360cc60d9979f1296909dfe520da0ae1097f67b95718f3e34eff8266a7c7c`（同 versionCode 就地重建：`edf04bfc3e98a87fffca1cf0f894cd1561cc7e11f1d1f0d78754e79d8d9ad347` → `8cbacd1046f7744f873c2759ca26a90d039336c11330fe28e40561ae3b4bf7b9` → 本次）。包内 Web 字节／marker 一致，签名者与 v43–v45 相同；装机后 `adb pull` 的 base.apk 与本地文件 SHA256 一致。

## v45 Media cache sharding — historical frozen artifact

根因是在**真机上**（装入的 App 自己的 WebView，经 adb/CDP）量出来的：CacheStorage 的每一次**写入**都要为桶里已有的内容付代价 —— 桶里 4,000 条以内（105 MB）时 `put` 只要 4–15 ms，而 11,007 条（195 MB）时要 **10.2–12.7 秒**，按条 delete 同样要 12.0–12.3 秒；而按地址 `match` 读在任何规模下都是 1 ms。媒体预载把每个地址都写进这**同一个桶**，于是整库下载爬行：实测 4.9 条缓存/分钟 ≈ **1.6 张图/分钟**。

三处客户端改动，无服务端／schema／原生改动：
1. `offline/cache-names.ts`：媒体地址按 FNV-1a 散列到 **256** 个桶（`t3-offline-media-v1-s<n>`），未分片前的旧桶保持可读。
2. `offline/offline-media.ts`：一次性 `reshardLegacyMediaCache` 把旧桶的条目**拷贝**进各自地址的桶（拷贝字节，绝不重下），随后整桶删除；在此之前读路径仍回退到旧桶。它挂在 `startMediaPreload` 每次启动的开头，所以已安装的副本下次启动即自行升级。
3. `offline/offline-media-task.ts`：行走的 `isCurrent` 守卫改为比较极小的 `activeGeneration` 指针，不再重建快照 —— `readActiveSnapshot` → `captureSnapshot` 会为**每一个媒体引用**重新解析整份（9.9 MB）库，这正是每次运行开头几分钟空转的原因。

真机（WGM77LVKD6RW9XZX，正式库 `0f4ab6e4`，schema 41）：搬迁在 ~2.5 分钟内搬完 11,056 条、零重下，之后分片桶恰好 11,056 条、旧桶消失。下载速率 1.6 →（1+2）**35 张/分钟** →（3）**147 张/分钟**（293 秒内 2,160 条缓存条目 ≈ 0.4 秒/张，等于实测的取图下限 ~0.4 秒）。读写成本、搬迁与旧桶回退由 `apps/web/tests/offline-media-cache-shards.test.ts` 的 15 条测试钉住。门槛：1237/1237 standard、686/686 isolated SQL、typecheck/lint/build 全过（另有 `offline-entry-delete.integration.test.ts` 2 例失败，属另一路正在进行的 Entry-delete 改写，非本批）。

APK `spikes/001-android-webview-shell/T3-v45-media-cache-shards.apk`，versionCode45，`0.0.45-c3-media-cache-shards`，SHA256 `57de1984884dc82d53dc58487a70cfa812c4d728c717ac457f5ce5b6acb4b45b`（首个构建 `98e74e4d94b74680577d414a73af2e1d979efc800c33658a1e6f70a837d7ef60` 只含第 1+2 项，已装机并实测；第 3 项以同 versionCode 就地重建）。包内 Web 字节／marker 一致，签名者与 v43/v44 相同；覆盖安装保留数据（IndexedDB、Outbox 与 195 MB 媒体缓存），`adb pull` 出来的 base.apk SHA-256 与本地文件一致。除上述 CDP 数字外，触摸／IME 等真机行为仍为 UNVERIFIED；不触碰正式 DB／assets／迁移，未重启服务，无 git 副作用。

## v44 Advanced functions layout — historical frozen artifact

Tags, Source maintenance, Offline library right overflow repaired in three scoped CSS sections only. No script/template/function/data/native change. Nested min-content and intrinsic file/input widths fixed, long tokens wrap; container-relative breakpoints preserve wide desktop forms. Actual GalleryApp Settings/Advanced functions, populated/expanded/editing states: parent independently repeated30/30 en/zh360/390/430/768/1440 cases, measured visible text Range and controls against card inner bounds, card against viewport. Parent visually inspected all three360 screenshots. Native/restore/API fixture data are simulation, not sync/plugin proof.

497 source/test/config bytes verified; only deliberate release identity changed afterward. Final1219/1219 default,672/672 integration,60/60 native JVM, all typechecks/full lint/diff/Web build/prepare/copy/assemble/identity tests PASS. First integration671/672 snapshot delta-payload test failure retained; unchanged focused/full retry PASS, no unrelated source repair or guessed cause.

APK `spikes/001-android-webview-shell/T3-v44-advanced-layout.apk`, versionCode44, `0.0.44-c3-advanced-layout`, SHA256 `aaafd34f2b31d922852b1a0143bc2c80719555b7fb3ef5a548c631d8a7468bcc`. Exact packaged Web bytes/marker/version and same signer asv43 verified. Freeze `.hermes/tmp/advanced-layout/release-final/manifest.json`; report `.hermes/artifacts/advanced-layout-implementation.md` and `advanced-layout-release.md`.

Phone/WebView/touch/IME UNVERIFIED. Cover-install, not uninstall/Clear/re-download. No formal DB/assets/default services/migrations/git side effects. CSS-only change requires no backend restart. Previous v43 functionality retained.

## Earlier releases — historical below

## v43 delivery — historical frozen artifact

Latest two requested callers completed: Quick import manual duration actual form/facade/cold IDB/application HTTP/isolated SQL, invalid refusal,805/0/blank/presets, uncertain original-body retry, snapshot/ACK response-loss cold settlement. Author LIST self-rating options include unscored dimensions; filter/query matches current anchor partitions/visibility/class refusal/AND/sort/total/pages; own/work tag combinations, navigation leave/remount and first-row primary order are tested. Author navigation memory unmount save fixed. Actual GalleryApp360 rating row overflow found and repaired with rating-only responsive grid; actual-shell360/430/768 rated+unrated/two-row browser bounds passed. Bare AuthorPage evidence was not substituted for shell proof.

Parent independently checked11-entry implementation checkpoint, scoped deltas and own targeted layout patch. Final gates:1219/1219 default,672/672 isolated integration,60/60 native JVM; shared/server/web typecheck,full ESLint,diff,production build,prepare/copy/assemble all PASS. Identity-dependent254 tests/typecheck/lint rerun after bump. Initial parent standard-test command omitted project integration exclusion and build command used unsupported --root: both harness errors corrected, not application defects.

APK `spikes/001-android-webview-shell/T3-v43-offline-quick-duration-author-filter.apk`, versionCode43, `0.0.43-c3-quick-duration-author-filter`, SHA256 `4faf8f23383b43ca65c3b45008e75159658192653c8fe3fc8f1407c999c4f2f1`. Packaged Web bytes/marker exact, same signer as v42. Evidence `.hermes/artifacts/quick-author-entrypoints-implementation.md`, `quick-author-bounded-review.md`, `quick-author-apk-verification.json`, frozen `.hermes/tmp/quick-author-release-final/manifest.json`. Source/test writers stopped.

Phone hardware/touch/IME/WebView/Keystore/PluginCall/force-stop still UNVERIFIED. Finite new checks `quick-author-device-check.md` deferred; no old register reopened and no required re-download/testing now. Upgrade over the installed app, not uninstall/Clear. Update old snapshot metadata against the new backend before new-field writes; existing media cache reuse retains prior automation proof, not phone quota proof. User-controlled backend reload remains tray Exit/relaunch when convenient. No official DB/assets read/touch/migration/service restart/deployment/device install/commit/reset/stash or signing-key change in this workstream.

## Earlier v42 and follow-up evidence — historical below

## v42 delivery — historical frozen artifact

Entry duration and the current Author rating system are implemented for offline/mobile callers, including duration add/edit/clear/0, optional legacy-field compatibility, create/preset/pending propagation, both Author rating classes, shared dimension create/reorder/delete, per-author half-star/clear, stored Gallery anchor, and latest rating filter/sort inheritance semantics. Field-aware foreground/native capabilities fail closed; original uncertain operations remain immutable; snapshot final field/class/value checks and durable ACK precede cleanup. Export/atomic restore and existing cache reuse have automatic proof.

Parent independently verified the full-byte implementation checkpoint and completed bounded review. Final default tests 1212/1212, integration 655/655, native JVM 60/60 across 13 isolated suites PASS. Shared/server/web typechecks, full ESLint, diff check, Web build, prepare/copy and debug APK build PASS. Identity-dependent default tests and web typecheck/lint were rerun after version updates.

APK: `spikes/001-android-webview-shell/T3-v42-offline-duration-author.apk`, versionCode 42, `0.0.42-c3-duration-author-offline`. SHA-256 `0c7638a39384577227d854f5165996f89b6abf475428012ce66083bfa089fc0b`. Actual packaged Web bytes and marker match; signer matches v41/v40. Evidence: `.hermes/artifacts/duration-author-offline-implementation.md`, `duration-author-bounded-review.md`, `duration-author-apk-verification.json`; frozen final source/Web hashes `.hermes/tmp/duration-author-release-final/manifest.json`. No feature writer remains.

DEVICE UNVERIFIED: physical touch, actual wide/narrow rendering, WebView/Keystore/PluginCall and OS behavior. New grouped checks: `.hermes/artifacts/duration-author-device-check.md`; user cannot test now and is not asked to re-download or reopen the historical register. Existing v41 Gallery/Preview device checks remain distinct and deferred.

Upgrade by installing over the existing app, not uninstalling or clearing its data. Old copies without the new trustworthy fields/capabilities remain readable but refuse new writes until metadata is refreshed against the updated backend. Automated production snapshot/cache selectors retained user metadata/capabilities and reused unchanged Entry bytes without media fetches/puts; this is not a guarantee that phone-specific cache/quota behavior has been tested. Restart the backend only through the user-controlled T3 tray Exit/relaunch workflow when ready; this session did not restart/deploy/install or touch formal DB/assets, edit migrations, commit/reset/stash or change the signing key.

## Historical v41 evidence below (superseded current-status wording)

## Frozen artifact / concurrent-source boundary

The v41 APK and its build-time tests/review remain the delivered Gallery/Preview artifact, not a claim that the currently changing repository is globally GREEN. After the APK was built, another workstream changed Author rating code in offline-api.ts, api/gallery.ts and GalleryApp.vue. Those later edits were not rolled back, silently repackaged or covered by this APK's gates. In particular the later author_self slot-layout change is absent from this delivery. Raw live-source SHA must not be substituted for the build-time checkpoint. Verified APK/public Web bytes are frozen under `.hermes/tmp/release-v41-final/packaged-web-manifest.json`; observed later API drift is recorded alongside it. No additional feature review or production edits were opened to absorb that separate workstream. “No writer remains” in earlier completion wording means this Gallery/Preview workstream only.



## v41 delivery — historical build evidence

Gallery order and Entry preview add/delete implementation, the two final byte/snapshot defenses and bounded review are closed. No feature writer remains. Latest implementation: `.hermes/artifacts/preview-last-implementation.md`; bounded parent review: `.hermes/artifacts/offline-extension-bounded-review.md`.

Fresh default tests 1204/1204 and isolated integration 635/635 PASS; shared/server/web typechecks, root lint, diff-check and production build PASS. Full native JVM 57/57 across 12 per-class isolated forks PASS (initial shared-process Robolectric SQLite crash retained in logs). APK `spikes/001-android-webview-shell/T3-v41-offline-gallery-preview.apk`, versionCode 41 / `0.0.41-c3-gallery-preview-offline`, SHA-256 `9bb20c3dba94862db47837886597c9ff24d48a2d720b21b14f409c398649c7c7`; packaged Web bytes/marker match and signer equals v40. Machine-readable proof: `.hermes/artifacts/offline-extension-apk-verification.json`.

Only this extension's device checks remain: `.hermes/artifacts/offline-extension-device-check.md`. Script/JVM pairing bytes do not establish actual WebView/PluginCall/Keystore or force-stop behavior. Deletion survivor byte identity is checked when trustworthy original cache bytes exist; null provenance never claims byte proof. Unknown/attempted native cancellation stays refused; released survivors are foreground-only. Occupied-cover replacement and excluded Import/Source/PWA/conflict work stay out of scope.

No formal DB/assets/default service restart, deployment, device install, commit or release-key change. Current backend code must be reloaded by the user through the normal T3 tray Exit/relaunch workflow; packaging alone does not reload the existing server. Old C0–C3/v38–v40 device register is not reopened.

## Earlier slice/version evidence (historical; superseded status wording)

## v40 unified candidate (offline read latency; Enter commits a tag)

`T3-v40-offline-read-latency.apk` (`0.0.40-c3-offline-read-latency`, versionCode 40, SHA-256 `ceda01d1e2d98b3104b61d92c807b16424b0ba1ffbebb331c93cee4ac341aeb0`) carries v39 plus the defects the user reproduced by simply using the offline app on the phone. Every one of them was found by measuring on the device (`adb forward` + DevTools Protocol, real taps, real IME input) rather than by reading code.

**An offline read waited for a stalled capability probe.** Opening an Entry took 5.2–7.7 s intermittently (measured 5173 / 5847 / 7655 ms) with no long task, no JavaScript on the stack and no HTTP request issued by the open itself — the page was idle awaiting an external operation. A controlled A/B isolated it: the same tap took **313 ms with no probe in flight and 7674 ms 150 ms after triggering one**, and the probe's own `GET /api/sync/capabilities` was measured failing after **8069 ms** ("Native network unavailable") — the read ended when that request ended. Mechanism, confirmed in source: every offline read goes `withFallback` → `localSnapshotLibraryMismatch()` → `nativeShellLibraryId()` → `bridge.nativePromise('T3PairedTransport','status')`, while `PairedTransportPlugin` runs `status` and `request` on **one** `Executors.newSingleThreadExecutor()` and the pinned client sets `connectTimeout(8s)`. The recovery probe fires at startup, on `focus`, on `visibilitychange` and every 15 s while offline and visible, so the stall overlapped ordinary use constantly. `status` now has its own single-thread executor. Device-verified on the installed build: baseline 543 ms, **probe in flight 253 ms** (was 7674 ms).

**A tag write no longer waits for the Entry to be re-read.** `POST /api/entries/{id}/tags` answered in 230 ms, but the row only showed the tag after the whole Entry had been re-read over the network — measured **1169 ms to first paint** with a live server, and up to the read timeout whenever the connection was bad (the user's "sometimes it does not refresh and you have to wait"). The write now returns the tag it linked (`entryTagAssignmentSchema` was already parsed and thrown away; the offline facade names it back from the copy it just changed) and the row shows it immediately — measured **799 ms** with the same server, with the three Entry reads starting *after* the chip was on screen, in the background.

**The Add-to-collection menu ran off the right edge on the phone.** The stylesheet anchored the menu's *left* edge to its trigger on phones, on the assumption that the action row sits top-left; in view mode the row is top-right, so a 12rem menu starting at the trigger ran past the screen (the user's screenshot). The anchor is now measured from the trigger when the menu opens — right edge when there is room to the left, left edge otherwise, with the width capped to the room on that side — and the static phone rule is gone. Device-verified: trigger at x241–285 in a 360px viewport, menu `right: 0; max-width: 192px`, rendered at x93–285, fully on screen (was clipped at the right edge).

**A work created offline only appeared after switching galleries.** The committed path was fixed first; the *queued* path returns early (`mode === 'offline'`, the enqueued-offline outcomes) and skipped the refresh entirely, so the row and the sidebar count stayed stale. Every create exit now goes through one `refreshAfterEntryCreate()`. Found on the device by creating offline and watching the grid: missing until another gallery was entered, present afterwards.

**Two surfaces went stale on the return path.** Both were recorded on the phone and both are the same class: a work created from the composer did not appear in the Gallery it belonged to until the page was left and entered again (the card list stays mounted behind the detail and was never reloaded — the delete path already reloaded it, the create path did not), and the sidebar's per-Gallery count lagged behind the offline copy after Settings changed it (download / clear / restore had no way to tell the app). The create path now reloads the mounted list, and the Settings panel emits `updated` — which re-reads every visible surface (galleries, the open Gallery, the open Entry, Home) through the same function the connection transition uses.

**A revoked device can be removed from the list.** The pairing state kept every revoked session forever (`revoke` only marks). A new admin action (`/api/pairing/forget`) drops an already-revoked record and refuses a live one, so the cleanup can never be a way around revoking; the desktop settings panel offers it as "Remove record" on revoked rows. Covered by the pinned-TLS pairing integration test (a revoked record disappears, its token stays unauthorized, a live device is refused).

**Enter never committed a tag.** In the offline tag editor, typing a tag and pressing Enter created nothing — no chip, no queued operation, no error — and the tag appeared only once the field lost focus ("it shows up after I press Done"); the user also saw that appearance take seconds, which is the stall above. Cause, measured on the device: `onEnter` returned early on the component's own `composing` flag, and a phone keyboard can hold a composition open for a whole typing session without ever announcing its end, so the flag stayed set and swallowed every Enter. The key event's own `isComposing` is authoritative and is now used; a composition that really is in progress still keeps the key for the IME. Two regression tests pin both halves (a stale flag commits, a genuine composition does not; the older test's stimulus now models the latter explicitly). Device-verified after the fix: typing `zztmp2` and pressing Enter produced the chip in 2129 ms with no blur and no Done; the tag was then removed through its own row control (`T` / `TTT` left as they were).

**Verified end to end on the device:** an Entry created while offline (Wi-Fi off, the copy's own Gallery `G1`, a 16×16 cover attached through the composer) appeared in the Gallery grid **immediately** — no gallery switching — carrying its staged cover (measured `naturalWidth` 16 from the staged blob, not the letter placeholder). Both test Entries' metadata then reached the server (ids 12/13) when the phone came back; their covers stayed queued (see below).

**Three follow-ups closed in the same candidate.**

*A stalled probe no longer costs eight seconds.* `PinnedLanTransport` built its client with a `connectTimeout(8s)` for every request, and the capability endpoint doubles as the connection health probe — so a server that had gone away was only noticed after the full timeout (measured: 8069 ms). That endpoint now fails in 2 s, which shortens both the offline transition and reconnection detection.

*Offline reads no longer ask the native bridge at all.* `localSnapshotLibraryMismatch()` awaited `T3PairedTransport.status` on **every** offline read (six calls in ~150 ms were measured in one pass). A new `createShellLibraryIdSource` remembers the paired library identity, shares one in-flight read between callers, never remembers a failed read (so the mismatch guard cannot silently pass on an unknown identity), and is invalidated on `focus`, `online` and a return to visibility, since pairing can change while the page is hidden.

*A rejected image can no longer be retried forever.* The test covers staged for an offline create were stuck pending across reconnects with no error shown; the server's error log had the reason — `pngload_buffer: libspng read error` from the thumbnail renderer. The bytes were a malformed PNG that sharp's `metadata()` reads (16×16) but whose decoder refuses, and the render threw outside the validation's own try/catch, so it reached the client as a transient failure that every probe retried. That path now answers 400 `VALIDATION_ERROR` like the other unusable-payload cases, and — the half that actually unblocked the device — the **client** no longer aborts the whole replay when the server answers with a refusal. It marked only 400/404/409 as failed and rethrew everything else, so a 500 for one image stopped the replay before the media loop reached any other upload: measured on the device with `pendingCount: 8`, `failedCount: 0` and the *good* cover never even attempted (`lastAttemptAt: null`), because the media list is ordered by Entry UID and the refused one sat in front. A server-answered failure now marks that row failed (visible, discardable) and the rest of the queue proceeds; only a transport failure — where the server never answered — stays queued. Both halves have measured fixtures in the tests.

**The phone's Settings sheet now takes the page card's own box.** The user reported it again after an earlier attempt: the sheet sat a few pixels narrower than the card behind it and shifted left, with a sliver of that card showing along the right edge. The cause was the shape of the earlier fix — the phone rule repeated the card's inset expressions (`max(0.75rem, env(safe-area-inset-*))`) instead of matching the card, so any difference in the layout's own insets showed up as a gap. The sheet now measures the `.content-panel` when it opens (inside the app's own tree, so it works in a detached test tree too) and sets `left`/`width`/`top` inline from that measurement, leaving the bottom free — the card behind may be shorter or taller. Phone-only: the desktop dropdown under the button is unchanged. Boundary shared with the stylesheet by deriving it from the root font size, since jsdom has no `matchMedia`. A first pass set the sheet's viewport coordinates and still rendered 8px off on both axes: the sheet is a child of the header, and the header's `backdrop-filter` makes it — not the viewport — the containing block for `position: fixed`. The measurement therefore corrects itself against what actually rendered (one extra frame), which holds whatever the layout does. Device-verified: card and sheet both at left 12 / right 348 / top 72 / width 336 in a 360px viewport.

**A packaged launch brings the phone connection up on its own.** Two release-level defects were found while the user tried to open their formal library from the tray launcher: `Settings → Connect to APP` answered "Encrypted pairing is not enabled here. Start desktop with a private T3_PAIRED_HOST" (the launcher never passed one, so the release could never pair), and the ownership lock left behind by any hard exit — which is exactly how the tray stops its server — could abort startup instead of degrading. Now: `LauncherPolicy.ApplyServerEnvironment` advertises the first private IPv4 unless the operator pinned one (so a plain launch, and `T3.bat` with the same rule, starts the encrypted listener); a lock problem never kills the desktop service (the recovery form stays reachable, which is what the operator needs); and ownership is proven by a **held loopback port**, not a PID — a PID is reused (a dead owner then looked alive and refused recovery forever), while a released socket cannot lie. A crash therefore self-heals on the next launch with no operator step, and a running owner still blocks a second one. Verified on the machine with the rebuilt exe: after a hard kill, relaunching brought up 8765 + 8766, took the stale lock over silently, and kept the paired phone session. The machine-level `T3_PAIRED_HOST` variable used as a stop-gap was removed again; nothing depends on it.

Executed gates: 1191 standard tests, 631 isolated SQL integration tests, workspace typecheck, lint, production build; the Android JVM classes all pass as per-class forks with `T3_TEST_REPO` set and the repo's Node 22 on `PATH` (without that PATH four classes fail on `ERR_DLOPEN_FAILED` — an environment matter, not a code one); `assembleDebug` with JDK 21 and `aapt` confirms versionCode 40 / `0.0.40-c3-offline-read-latency`. The installed APK was pulled back and matches the built file byte-for-byte. Device checks were performed against the user's isolated offline library; the only writes they caused were removed again (one test tag and one test Author link), leaving one unused tag name `zztmp` queued to be created on the next sync.

**Known, not fixed here:** the two covers staged by the offline create (Entries 12/13) are still pending on the device — they are the malformed test image described above, and the *server* must be restarted for the new 400 to take effect before the client will mark them failed and let them be discarded. Also: while offline, the recovery probe still runs every 15 s (deliberate: no hammering), so noticing a server that comes back can take that long; the web layer still asks the native shell for its library id on every offline read (the native executor fix removes the stall, but the dependency remains); a read that coincides with an unreachable host still pays the transport's 8-second connect timeout somewhere. The offline tag write that follows Enter plus its entry refresh took 2129 ms on this device — no longer the probe stall, but not instant either. Both are recorded for the offline owner rather than changed here.

## v39 unified candidate (composer Author field; candidate list under the keyboard)

`T3-v39-author-field-candidates.apk` (`0.0.39-c3-author-field-candidates`, versionCode 39, SHA-256 `1ed24689fb4ee2df3caf147850d4fe15c9744ec82dd936625cd781d38e4a8c72`) carries the complete v38 offline mainline plus the two defects the user found while testing the quick-import composer on the phone, each traced to a measured cause rather than a guess.

**The Author field did not look like its neighbours.** Every field in the composer form is 44px tall with the same border, radius and white surface; the Author field is a `SuggestionInput`, whose own compact input style (31px, muted background, 0.85rem) reached the DOM because the page's scoped field rule cannot select a child component's internals. The page now reuses its own field rule through `:deep()`, including the phone's 44px height — measured on the device afterwards: Author 44px / border-radius 10px / border and background byte-identical to the neighbouring Title field.

**The candidate list never showed while typing on the phone — one cause, two layers.**

1. *Placement.* The list opened downward from the field (`top: calc(100% + 0.25rem)`). With the soft keyboard open the layout viewport shrinks to 430px while the field's bottom sits at 407px, so an 87px list landed at 411–498px: 19px of it above the keyboard line, the rest behind it. It became visible exactly when the keyboard retracted, which the user reported as "the candidates only appear once I tap away". The list now flips above the field when the room below cannot hold a usable list (and when the other side is roomier), is bounded to the room on whichever side it lands, and re-measures on viewport resize and on scroll — the shell's own scroll-into-view moves the field from y377 to y30 without a resize event, so a placement measured once went stale. Device-verified with the real keyboard and real IME input: field y363–407 in a 430px viewport, list rendered at y273–359, fully on screen.
   *A first attempt at this fix was itself defective and was caught by measuring the built CSS: the state class and the base rule had equal specificity, so the base rule's `top` won by source order and the flipped list collapsed to its 12px padding. The flip rule is now written `.suggestion-input .suggestion-input__list--up`, verified in the built stylesheet.*
2. *The query never moved.* Vue's own `v-model` listener drops `input` events while an IME composition is open (`e.target.composing`), and a phone keyboard holds the composition open for as long as plain letters are being typed. The component's query therefore stayed at its previous value for the whole composition: no search was dispatched, the list only ever showed its "No matches" default, and the candidates appeared when the composition committed — the user's "I type a and nothing comes up; it appears after I click elsewhere". The field's text is now read from the element in a plain `@input` handler, which fires during composition; dropping `v-model` is the fix, not a workaround. Device-verified: the element was measured carrying `composing === true` with the query frozen (and clearing the flag let the identical event through), and after the fix real IME typing of `a` in the quick-import composer immediately offers the existing authors A1/A2 — offline, from the local snapshot, with no server reachable.

A third, unrelated flake was fixed in the same pass: the debounce contract test asserted "no request before the debounce elapses" using a real-timer sleep, which is a lower bound and overshoots on a loaded machine; that assertion now drives the clock with fake timers, and the rendering half moved to its own real-timer test. A regression test pins the IME behaviour: a composition is opened, the field's value is set and an `input` event dispatched, and the component must follow the text (`size` attribute) and dispatch the search — it fails against the pre-fix component.

Executed gates: 1140 standard tests, 621 isolated SQL integration tests, workspace typecheck, lint, production build. Android `assembleDebug` with JDK 21; `aapt` confirms versionCode 39 / `0.0.39-c3-author-field-candidates`, minSdk 24, targetSdk 36; the nine prepared Web assets match the APK byte-for-byte and the embedded bundle carries the marker, the flipped-list rule and the three `:deep()` field rules. Real-device checks used the running app through `adb forward` + Chrome DevTools Protocol (element measurement, screenshots, real taps via `adb shell input tap`, real IME input via `adb shell input text`). The remaining checklist items (offline tag candidates, intermittent entry-open delay, revoked-pairing cleanup, the newly shipped media and author surfaces) are unchanged and stay UNVERIFIED until the user's pass; formal-library deployment was not performed and the signing key is still the debug keystore.

## v38 unified candidate (§27.2 atomic online create command; device checks pending)

`T3-v38-delta-command.apk` (`0.0.38-c3-delta-command`, SHA-256 `876f4c49dcf11203e49b869de3b9a03e53eacb68f5ad7dad1a26846e17f64fb7`, rebuilt in place after three on-device fixes below; the first cut `76b45dc4…e742` was never installed) is the first unified candidate carrying the complete offline mainline (C0–C3, pending relations, atomic pending-work restore, full snapshot delta/durable ACK, native ledger v6/WorkManager) together with the current web UI, closing the last plan §27.2 gap: the online multi-request create chain now converges into one retryable `entry.create` server command via `/api/sync/replay` (metadata/ratings/View later/initial Content atomic; media stays on its independent idempotent channel). An uncertain transport failure enqueues the *identical* operation (same opId/clientCreatedAt/Content UIDs) into the offline Outbox so the server receipt resolves the ambiguity instead of colliding; receipt failures and epoch mismatches clear the attempt identity. Legacy pre-command servers keep the multi-request shape via the new `onlineEntryCreateCommand` capability flag. Runtime diagnostics now serialize `completeSnapshotDelta`, the media capability set and global mutation flags, and carry the 0.0.38 build marker.

First-cut defect found during the user's isolated-server rehearsal and fixed before any install: the command path reused the offline replay's existing-Gallery validation, so creating an Entry under a *newly typed* Gallery name failed server-side (`invalid-create`) and the failure rendered off-screen. The client now falls back to the legacy request shape under the same attempt identity (the failed receipt proves nothing was created), and the create form shows the submit error directly above the submit button. Verified end-to-end on the running isolated server: a new-Gallery create lands once, complete with its Source URL.

Second round, found on the real device with adb logs, all latent and mutually masked — the shell could never have rendered on any device in this state: (1) `resolveDefaultApiBaseUrl` threw at **module scope** for the shell's own virtual origin `https://localhost/api/` (the only base prepare-web ever ships, and the one the injected fetch routes through the native pinned transport), killing the whole bundle before Vue mounted — the white board; the virtual origin is now the standing base with or without pairing, and an unpaired shell answers 401 to the in-app pairing screen instead. (2) With the module booting, two plugins (`PairedTransportPlugin.request`, `BackgroundTransferPlugin.action`) read `WebView.getUrl()` on the CapacitorPlugins thread — a fatal wrong-thread crash at first real use (confirmed twice in adb crash logs); both now read the bridge's thread-safe `getAppUrl()` field, which equals the served document because the bundled SPA never navigates inside the WebView. (3) The pairing failure dialog names the actual cause, the web app probes the shell and shows an explicit always-available pairing screen when unpaired, `MainActivity.onResume` runs an 8-second blank-page watchdog (reload once; surface the native pairing dialog while unpaired), and a foreign-library re-pair refusal now offers an explicit "Forget pairing; pair the new library" action (the old stored offline copy stays but can never synchronize again). Device-verified via adb: cold start, zero crashes, zero uncaught JS errors, live API round trips, rendered UI.

Third round, found during the user's real-library rehearsal: `resolveAssetUrl` wrapped *every* absolute media URL in the Capacitor HTTP interceptor, including the shell's own virtual origin — those requests bypass the WebView's pinned-transport interception and hit Capacitor's local asset server, which has no `/api` route, so every cover rendered blank. Same-origin (virtual origin) media URLs now stay unwrapped and ride the pinned transport; genuinely remote LAN media keeps the interceptor. The blocked-set discard also treats operations from a foreign library epoch as blocked (they can never replay), so a library switch leaves self-service cleanup: Discard blocked edits takes the stale-epoch queue.

Executed gates: 1116 standard tests, 617 isolated SQL tests, typecheck/lint/production build/diff-check. Android JVM 54 tests (0 failures/errors/skipped) ran as per-class separate forks (the known Robolectric native-DLL crash aborts one combined run; each class passes in its own fork) with `T3_TEST_REPO` set, then `assembleDebug`. Nine prepared Web assets byte-match the APK; `aapt` confirms versionCode 38/`0.0.38-c3-delta-command`, minSdk 24, targetSdk 36, and the expected permission set; `apksigner` verifies the v2 debug signature with the same signer certificate as v36. Real-device acceptance (`docs/offline-validation-checklist.md`) and formal-library deployment remain UNVERIFIED/unperformed; the signing key is still the debug keystore, not a stable release key.

## v36 automated candidate (independent narrow review PASS; device checks recorded)

`T3-C1-v36-pending-authors.apk` (`0.0.36-c1-pending-authors`, SHA-256 `0f516f9984c15be991e44d737e1d70de5eb4a61a336af0ddec4ebfb5cd03ecf6`) adds linking/removing existing cached Authors on pending offline Entry Search cards. Selection searches cached canonical names; it does not create Authors or link local-only Producers. Each immutable `entry.authors.set` child carries `baseVersion: 0` and `parentCreateOpId`; create/initial Content and later Tag/Content operations remain unchanged. Require `offlinePendingEntryAuthors` plus global mutations and existing Entry Author support. Unknown/deleted identities reject the whole desired set; complete-base divergence conflicts without destructive overwrite. Child blocked state and reasons show independently and lock all related editors.

Executed gates: 756 standard tests, 450 isolated SQL tests, lint/typecheck/production build/diff-check, Android JVM task/debug assembly. UI includes retryable rejected drafts, postcommit refresh warnings and page-owned in-flight locks. A real Web-facade/disposable-SQL bridge covers add/remove with interleaved Tag/Content, response loss after committed Author replay, facade restart, same-operation retries and verified snapshot cleanup. Seven prepared Web files match the APK byte-for-byte; JS/CSS match the production build. versionCode 36 and v2 signature verified with the same signer as v35. Independent read-only narrow review passed with no evidenced in-scope defects. This is automated/reviewed acceptance, not device acceptance. Device checks remain UNVERIFIED in `docs/offline-validation-checklist.md`; no formal-library deployment. v35 stays archived.

## v35 automated candidate (device checks recorded, not blocking)

`T3-C1-v35-pending-tags.apk` (`0.0.35-c1-pending-tags`, SHA-256 `ea1dc92b9972307051281b9c64dc7b11506a0ad20098dedd5f1f34ba1a9d4500`) adds cached existing-Tag add/move/remove on pending offline Entry Search cards. Each immutable `entry.tags.set` child carries its parent create op ID; the parent payload and initial Content stay unchanged. The matching server must advertise `offlinePendingEntryTags` together with global mutations and Entry Tag support. Same-Gallery Facets only; new Tag vocabulary, pending Author links, Content replacement/deletion and automatic conflict resolution remain excluded.

The release follow-up fixes a review-confirmed cleanup race: covered-snapshot cleanup reads current Outbox rows and retains a create with an uncovered child in one write transaction; dependent enqueue validates the parent in that same storage boundary. Deferred replay and cross-instance IndexedDB regressions cover both scheduling orders. Final executed gates: 716 standard tests, 440 isolated SQL tests, lint/typecheck/production build/diff-check, Android JVM task/debug assembly. All seven prepared Web files byte-match the APK; production JS/CSS match the prepared files. APK versionCode 35 and v2 signature verified, same signer as v34. Device acceptance remains UNVERIFIED and concentrated in `docs/offline-validation-checklist.md`. No formal-library deployment was performed; v34 remains archived.

## v34 automated candidate (device checks recorded, not blocking)

`T3-C1-v34-content-status.apk` (`0.0.34-c1-content-status`, SHA-256 `52ed33e14e9c54c507a58b067a187819fc4b1538f143ac02af5814ced15b0e67`) distinguishes later Content append states from the pending parent create. Each later row shows its persisted pending/failed/conflict status and blocked reason; initial rows and the parent operation remain unchanged. Existing capability/blocked-sibling controls still apply. No new SQL, replay or automatic conflict resolution.

Actual GalleryApp UI and restarted-facade three-state RED→GREEN; complete gates passed 686 standard tests and 426 isolated SQL tests (two workers), lint/typecheck/build/diff-check, Android tasks/debug assembly, seven matched Web resources and version/signature verification matching v33. Unverified phone cases remain in the central validation register and do not block further implementation. Formal library was not touched. v33 stays archived.

## v33 automated candidate (device checks recorded, not blocking)

`T3-C1-v33-create-status.apk` (`0.0.33-c1-create-status`, SHA-256 `2f7cc527d792e74d536c709f4eb0e70bd32e18bd647db9a5d2127ece77c4ec0f`) fixes blocked offline create cards reporting only Pending sync. Failed/conflict cards now show their state and persisted reason; blocked cards still disallow Content append. Normal pending DTOs remain compatible and no queue/replay/SQL behavior changed.

Actual-form and facade-restart RED→GREEN; complete final gates passed 680 standard tests and 426 isolated SQL tests (two workers), lint/typecheck/build/diff-check, Android task/debug assembly, seven matched Web resources, manifest version and signature matching v32. Device scenarios remain unchecked in the central register, not blockers to further implementation. Formal-library deployment was not performed. v32 stays archived.

## v32 automated candidate (device checks recorded, not blocking)

`T3-C1-v32-source-create.apk` (`0.0.32-c1-source-create`, SHA-256 `9658fc3df4f4e9b021368f6bb55613448171d178f365d3e98ce0e4e622af793e`) saves the manual composer's address as initial `Source URL` Content, before the user's other initial Content. It uses the existing stable UUID, capability, transaction, receipt and covering-snapshot path; no new schema, migration, Source field or scraping behavior. The same conversion covers claimed online-response-loss fallback. An older server lacking initial-Content support refuses saving and retains the full draft/address instead of dropping the Source.

Validation: actual-form RED→GREEN, IndexedDB Source/Note cold-reopen, capability refusal, and real Web-facade + disposable SQLite replay with a committed-but-lost response, facade restart and verified snapshot cleanup. Full gates: 676 standard tests (SQL integration excluded), 423 isolated SQL tests, lint/typecheck/build/diff-check, Android JVM task/debug assembly, seven byte-identical bundled Web resources, APK version and signature matching v31. Unverified device scenarios remain in `docs/offline-validation-checklist.md`; formal-library deployment was not performed. Pre-send online intent and pending-Entry Tag/Author editing remain unresolved. v31 stays archived.

## v31 automated candidate (device acceptance pending)

`T3-C1-v31-multi-preview.apk` (`0.0.31-c1-multi-preview`, SHA-256 `27cb2dbe543979c4dddd6e17a27178db9b7d4c734f268ca8b3b1ed711705d1b2`) adds complete offline Preview staging and ordered, receipt-idempotent replay. The form's full Preview selection survives an IndexedDB close/reopen; no later image is silently dropped. The matching desktop server advertises `offlineMediaMultiplePreviews`; an older/downgraded server leaves multi-Preview creation and Blobs pending. A permanently failed early Preview blocks later ordinals, and explicit discard removes its dependent later Previews. Source URL attachment remains unsupported offline.

Automated gates: 671 standard tests (`pnpm test`, SQL integration excluded), 422 isolated SQL integration tests, lint/typecheck/production build/diff-check, Android JVM unit-test task and debug assembly. Seven bundled Web resources match byte-for-byte; APK version and v2 signature verified with the same signer as v30. This is an automated candidate only: device acceptance and formal-library deployment were not performed. v30 remains archived.

## v30 automated candidate (device acceptance pending)

`T3-C1-v30-outbox-commit.apk` (`0.0.30-c1-outbox-commit`, SHA-256 `18cebda739bd5311097713a73f02e358a400757439b9cc5912d0c657e2c7a41c`) in this directory adds an offline create commit-boundary safeguard on top of v29. Once an Outbox+media transaction commits, a subsequent failed pending-status read no longer reports the create as unsaved; the offline state retains a visible refresh warning. IndexedDB also rejects a second concurrent `entry.create` for the same library/epoch/Entry UID inside its write transaction, so two local requests cannot persist sibling creates with that identity. This does not persist an online attempt *before* its POST or recover an app killed before fallback enqueue.

Automated validation: 1,085 regular tests, 421 isolated SQL tests, lint/typecheck/build/diff, and Android `testDebugUnitTest assembleDebug` passed. Verified 7 prepared Web assets byte-for-byte inside the APK, embedded diagnostic build and capability flag, Android versionCode 30, and the same signer as v29. **No device acceptance, formal-library migration, or formal-server deployment was performed.** A matching schema-32 desktop server remains required for claim adoption.

## v29 automated candidate (device acceptance pending)

`T3-C1-v29-retry-identity.apk` (`0.0.29-c1-retry-identity`, SHA-256 `32a8ca5ddc01405b158887afab535363fe06305d83da8c65c53d378a64e3d8f2`) in this directory adds same-composer retry protection on top of v28. If a claim-capable online POST has an uncertain response **and** the offline Outbox write fails, a retry in the still-open form reuses the original Entry UID—whether the next attempt is online or directly offline. If the server has since stopped advertising the claim, the client refuses a legacy no-UID POST rather than risking a twin. Opening a new composer is a new draft/UID; process death before durable Outbox persistence is still outside this guarantee.

Automated validation: 1,083 regular tests, 421 isolated SQL tests, lint/typecheck/build/diff and Android `testDebugUnitTest assembleDebug` passed. Verified 7 prepared Web assets byte-for-byte inside the APK, embedded diagnostic build and capability flag, Android versionCode 29, and the same signer as v28. **No device acceptance, formal-library migration, or formal-server deployment was performed.** A schema-32 desktop server is still required for online claim adoption.

## v28 automated candidate (device acceptance pending)

`T3-C1-v28-claim-negotiation.apk` (`0.0.28-c1-claim-negotiation`, SHA-256 `3af483c649938ae2775ffa5ae750cdd3ffb23206103da569ae8e59413206329d`) includes v27's matched online/offline Entry claim. Before any online Entry POST, the client probes the new `onlineEntryCreateClaim` capability. A current schema-32 server receives the same client UID for online/fallback; an older server receives the legacy no-UID request and remains usable online. If the older POST's response is uncertain, the draft stays open with an explicit check-the-library warning and is **not** queued as a possible duplicate. If the probe fails before a POST was sent, the existing offline capability rules may safely queue the draft. The matching server advertises the flag on schema 32; this server change is not inside the APK. Automated verification: 659 default tests, 421 disposable-SQL integration tests, lint, typecheck, Web/server build, Android JVM tests, debug build, byte comparison of all 7 Web assets, versionCode 28, and signature matching v27. No formal database migration or physical-device acceptance was performed. A process killed after an online POST but before fallback persistence still has no durable recovery intent.

## v27 automated candidate (device acceptance pending)

`T3-C1-v27-entry-claim.apk` (`0.0.27-c1-entry-claim`, SHA-256 `0d4f4ae63ea08f30eb4088861f2d4f4fec1f4e50e54d3e80218ce75bfa3ea9c6`) includes v26 plus a stable online Entry UUID shared with a transport-failure offline fallback. The *matching desktop server source* introduces migration 032: atomic online create claim/fingerprint, exact POST retry, and transactional adoption of an unchanged matching Entry by offline replay (initial Content, ratings/View Later and receipt); collisions/peer edits fail closed. No new server binary or formal-library deployment is bundled in the APK. Automated gates: 656 regular tests, 421 isolated SQL integration tests, lint, typecheck, Web/server build, Android JVM/Gradle debug build; all 7 prepared Web assets byte-match the APK, `aapt` confirms versionCode 27 and diagnostic marker, `apksigner` verifies the same signer as v26. *No formal DB migration or real-device acceptance was performed.* The formal library's schema provenance remains unknown: use only a disposable migrated server for grouped testing. Pairing remains unauthenticated private-LAN HTTP and the feed is not yet installed incrementally.

## v26 automated candidate (device acceptance pending)

`T3-C1-v26-pending-content-append.apk` (`0.0.26-c1-pending-content-append`, SHA-256 `b803782d6e21be11f909209f6b386cfa44da1aba9ea7ac0c21cafd8262fdd6e4`) includes v25 plus an immutable, capability-gated post-create Content append on a still-pending offline Entry. Search pending cards offer append-only editing; parent create and initial Content are not rewritten. A successful append is held until the authoritative snapshot contains its stable Content UID. The native unpaired API route also fails closed. Automated gates: 654 default tests, 412 isolated SQL integration tests, lint, typecheck, production Web/server build, Android JVM/Gradle debug build, packaged Web-asset byte comparison, version/signature verification (same v25 signer). No formal DB migration/application or device acceptance was performed. Do not expose the unauthenticated HTTP prototype outside a trusted private LAN; see `docs/offline-validation-checklist.md` for the grouped disposable-device sequence and remaining boundaries.

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
- offline Author-owned Producer edits are now covered: profile, Author-tag assignments, existing rating values, and View Later; Collections, Directories, Entry relationships, deletion/merge, and rating-slot layout remain separate owners/designs;
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

## C2 offline Entry Content candidate

- version code: `9`
- version name: `0.0.9-c2-offline-content`
- artifact: `T3-C2-v9-offline-content.apk`
- SHA-256: `4c9d3b20bc3ca74cca47328e3b8aa6c2f48e15b97220020b1c77882b11ae583e`
- size: `4,562,733` bytes
- scope: on existing Entries, add/edit/delete Content and reorder the complete list offline; each operation stores the ordered desired list using Entry and Content sync UUIDs, and projects additions optimistically with local-only IDs
- consistency: complete-base-list conflict check catches concurrent online Content changes even when the Entry version did not move; exact retries converge, dependent operations preserve the Entry revision chain, and Content rows, Entry revision, journal and receipt are atomic
- compatibility: gated by `offlineEntryContents`; legacy snapshots without stable Content UUIDs must be refreshed before editing
- automated evidence: 435 unit/web/import tests, 328 server integration tests, typecheck, lint, production build, `git diff --check`, byte-identical prepared web bundle in the APK, and Android build-tools 36 badging/permission checks passed
- real-device acceptance: not yet performed. Install over v8, refresh the offline copy while online, open a test Entry, disconnect the server, add a Content row, edit another, reorder, and delete one; reconnect and confirm the final list survives sync/refresh. Do not use a valuable Entry for the first pass.

## C2 offline lifecycle + Entry editing acceptance candidate

- version code: `10`
- version name: `0.0.10-c2-offline-lifecycle`
- artifact: `T3-C2-v10-offline-lifecycle.apk`
- size: `4,584,762` bytes
- SHA-256: `aea962bd93c1d1c219b97e7b462bd30b8051e5297813cd4b3d01661cc24983a6`
- scope: one combined device acceptance for cold-start offline browsing, fast disconnect indication and fallback, persistent edits across force-stop, reconnection/replay, and all four existing Entry Content actions (add/edit/delete/reorder) alongside supported Entry title/date/page-count, existing rating, View/Like and Entry View later actions
- startup: read the IndexedDB active-generation pointer before issuing Home reads; prefer a saved local copy immediately even when Wi-Fi stays connected to a stopped server. A successful later capability probe returns the UI online and starts Outbox replay separately.
- foreground detection: a short bounded read deadline (3 seconds by default) and a lightweight capability heartbeat every 4 seconds (2.5-second probe deadline). Explicit checking/switching/opening-copy/unavailable states replace the misleading empty-library screen; concurrent Home reads share one snapshot load. Timed-out reads are safe to retry locally; writes are **never** timed out into the Outbox because an online write may already have committed.
- Content readiness: the paired desktop's `offlineEntryContents` flag is cached on successful capability probes; Settings shows whether Content editing is enabled and offers a lightweight check without redownloading the snapshot. A legacy snapshot without stable Content UIDs still requires a new offline copy. The local desktop API currently advertises the flag, but the prior APK's device-side cached flag has not been inspected.
- local-state preservation: no IndexedDB, Outbox, staged-media, pairing, or offline-media cache reset; old shell-worker retirement remains in place. HTTP/business failures still do not create offline mutations.
- automated evidence: 524 unit/web/shared/import tests and 328 server integration tests passed; typecheck, lint, production build, `git diff --check`, Gradle debug build, byte-identical prepared web assets in the APK, versionCode/name and minimal permissions were checked. These are automated checks, not a measured real-device startup time. Real-device acceptance: **pending**; ADB was not available here, so no device installation or on-device timing was performed.

### One-pass real-device acceptance (after installing v10 over v9)

1. While online, open Settings → Advanced function → Offline library (the offline block moved there from the quick Settings sheet in this round). Confirm `Entry Content editing ready`; if it says `not enabled`, tap **Check offline editing support**. If it requests stable identities, update the offline library once; do not clear it. Confirm the desktop server is the updated build.
2. Open a disposable existing Entry, then stop the desktop server while leaving Wi-Fi connected. In the foreground, the app should show a switching/opening state rather than an empty library and then browse/search the saved copy. Refresh the app while the server is still stopped: it should open the same local Entry promptly, not wait for the native network timeout.
3. On that Entry, edit title/date/page count and perform **all four Content actions**: add a row, edit one, reorder, delete one. Change an existing rating slot, record View/Like and toggle Entry View later if desired. Check the local results and pending-edit count, then force-stop and reopen the app with the server still stopped; the copy and pending edits must remain usable without an empty-library interlude.
4. Restart the desktop server without toggling Wi-Fi. Wait for automatic reconnection and replay, then refresh and compare the final Entry details and Content order with the desktop. Review any visible conflict/failed counts; no queued edit should silently disappear. Use a disposable Entry for the first pass.

### v10 device outcome and v11 cold-start follow-up

- v10 device feedback: Entry Content editing passed and server-disconnect switching became fast, but force-stop/reopen while the server remained stopped still showed an empty-looking library for roughly 30 seconds before the full offline inventory appeared. Do not mark v10 cold-start acceptance as passed.
- version code: `11`; version name: `0.0.11-c2-cold-start`
- artifact: `T3-C2-v11-cold-start.apk` (4,367,157 bytes)
- SHA-256: `7047eacef128bde2c229a2ce50ef14b964376c63aed5007fadf2768262da4f4a`
- scope: the unwrapped online navigation-count request is skipped while offline and never gates the first Gallery paint; Author and View-later startup reads also populate reactively without delaying Gallery doors. No snapshot schema, SFW/NSFW visibility, Outbox, Content capability, or replay semantics changed. No speculative SFW-only partial cache was added without phone-side timing evidence.
- diagnostic: `startupMilestones.snapshotReadyAtMs` and `.galleriesReadyAtMs` are milliseconds since WebView navigation; `lastLocalLoadMs` is the first full IndexedDB read/validate/projection duration. These are not direct frame-paint measurements.
- automated evidence: 527 default tests and 328 integration tests passed; lint, typecheck, production build, `git diff --check`, Gradle debug build and signing verification passed. Every prepared Web file was byte-identical in the APK, the version and four Web markers were inspected, only the existing Internet and app-scoped AndroidX permissions appeared, and the debug signing certificate matches v10. ADB reported no attached devices; real-phone startup time remains unmeasured here.

One-pass v11 acceptance: install over v10 **without clearing app data**. With the saved offline library still installed, stop only the desktop server and leave Wi-Fi connected; force-stop and reopen the app. Note the approximate time until the first usable SFW Gallery door, then open it; Authors and View later may finish loading afterwards. Verify the offline banner and full library (including NSFW after enabling the existing visibility setting) are still accessible, not permanently replaced by a partial copy. If the initial empty-looking wait persists, copy the Offline Diagnostics report **before** reconnecting so its three timings help narrow down the remaining bottleneck. Finally restart the server and confirm normal online recovery and any previously pending edits converge; the already-passed Content action sequence need not be repeated.

### v11 user feedback

- User later reported the latest cold-start pass was “all seconds” with no problems. The exact APK version for that report was not recorded, so do not attribute measured startup timing to a specific build. No Android device was attached to the build machine.

## C2 offline Author View Later candidate

- version code: `12`
- version name: `0.0.12-c2-producer-view-later`
- artifact: `T3-C2-v12-producer-view-later.apk` (4,394,853 bytes)
- SHA-256: `c8280817ce98d8cfbf04f8f21c968e6fa1c2c355d7fe85a452de1eb9bcb13509`
- scope: offline Author View Later desired-state add/remove only; capability-gated Producer UID/version envelopes, ordered local projection, atomic server replay and receipt, and conflict-aware snapshot reconciliation
- local semantics: an absent/false server capability prevents new offline queueing and prevents replay to an older server; transport errors may queue, while HTTP/business errors remain visible. The paired offline copy must be refreshed online if its Producer rows lack stable sync identity/version.
- automated evidence: 534 unit tests and 333 integration tests passed; lint, typecheck, workspace production build, Capacitor doctor, Gradle debug build, diff check, APK version/signature/permission inspection, and byte-for-byte prepared-web asset verification passed. The APK contains the two expected Capacitor compatibility files in addition to the seven prepared web assets.
- live database: no migration was applied to `apps/server/.data/library.db`; the local library must be backed up and the updated server/migration started before this feature can be tested against it.
- device acceptance: pending; no ADB device is currently attached.

### One-pass v12 device acceptance

1. Back up the desktop library, start the updated desktop build so migration 025 and the new capability are active, then refresh/update the phone's offline library while online. Confirm Offline settings reports Producer View Later as enabled; do not clear app data.
2. Install v12 over the existing app without clearing data. Open an Author not already in View Later. Stop the desktop server while Wi-Fi remains on, tap the existing View Later control, and confirm it updates immediately and appears in View Later with a pending operation. Toggle it back off before reconnecting and confirm the visible state returns immediately; the queued add/remove must retain causal order.
3. Force-stop/reopen once with the server still stopped if convenient, then restart the server. Confirm both operations replay, the pending/conflict counts settle, and the Author is absent from View Later on both phone and desktop. No Content or cold-start acceptance steps need repeating.

## Previous C2 v14 — offline Author-owned data

- version code: `14`
- version name: `0.0.14-c2-author-profile-tags`
- artifact: `T3-C2-v14-author-content.apk` (4,591,582 bytes)
- SHA-256: `f1eb97d6acdc3ddc852ba48bcffaac008c4dfc4511aed0a9b9c7fa004a12efe8`
- scope: offline Producer profile fields (name, occupation, artwork-ref string, content; no binary media upload), Author-tag assignment add/rename/remove, existing Author rating values, and Author View Later; all share one Producer identity/version chain
- consistency: migration 027 adds immutable Producer-tag UUIDs and SQLite triggers for assignment/tag-label owner revisions; the full desired tag set predicts one version step per added/removed assignment, while profile is a field-level patch; replay checks bases and commits domain rows, revision/journal, and receipt atomically
- compatibility: `offlineProducerProfile` and `offlineProducerTags` separately gate enqueue and replay; absent/false flags hold existing operations pending, and HTTP/business errors never queue
- automated evidence: 548 unit tests and 343 integration tests passed; lint, typecheck, workspace production build, Capacitor doctor, Gradle debug build, `git diff --check`, version/signature/permission inspection, and byte-for-byte prepared-web asset verification passed
- artifact checks: package `com.speechless666.t3.spike`, version 14; minimal INTERNET plus package-scoped dynamic receiver permission; both packaged web assets byte-identical to `web-dist`
- online-only boundary: Producer deletion (destructive/cascade-sensitive), shared rating-slot creation/reordering, Collection membership, Directory/Entry membership, and Entry merge/deletion stay outside this Producer-owned replay slice
- database/device boundary: migration 027 was not applied to the formal `apps/server/.data/library.db`; no ADB device was available, so no device acceptance was performed. One grouped Author smoke check is documented below; no per-control device pass is required.

### One grouped Author acceptance (optional)

1. Use a disposable copy of the library for this smoke check (or get explicit authorization before migrating the formal library). Back it up, start the updated server so migrations 025–027 apply to that test copy, and refresh the phone's offline snapshot while online. Confirm the four Author capabilities are enabled. Install v14 over the existing app without clearing app data.
2. With Wi-Fi left on, stop only the desktop server. On one existing Author, edit a profile field, add a new tag, rename a tag (to an existing/new vocabulary name), remove a tag, change/clear one existing rating, and toggle View Later. Confirm the Author view updates immediately and pending count rises.
3. Restart the server. Verify the profile/tags/rating/View Later state on desktop and phone, then confirm pending/conflict/failed counts settle to zero after snapshot refresh.

## Previous C2 v15 — shared rating layouts and Author organization (superseded by v16)

- version code: `15`
- version name: `0.0.15-c2-author-resources`
- artifact: `T3-C2-v15-author-resources.apk` (4,601,869 bytes)
- SHA-256: `fea40e8a465696c46e1fdd9912334819e3b95e1e89e49866998f0251d3dc7aab`
- scope: Entry- and Author-owned shared rating-slot create/reorder; add/remove an Author from a Producer Collection; create/update Author Directories and add/move/remove the Author's Entry memberships. New Entry ratings may reference a stable slot UID created earlier in the same offline session.
- ownership/conflicts: migration 028 gives rating layouts their own `(subjectKind, entryType)` UUID/version, Collections their own UID/version, and each Author's Directory set its own UID/version, independent from the Producer profile chain. Directory and Entry rows also have stable UIDs. Collection Entry membership, Collection CRUD, Directory deletion, Producer/Author deletion, Entry deletion, and Entry merge remain online-only.
- safety: capability flags gate enqueue and replay. A layout conflict blocks dependent ratings/Entry-create intents; discarding the blocked layout chain also discards those dependent operations. Migration 028 has not been applied to `apps/server/.data/library.db`; no formal database was used for implementation or tests.
- automated evidence: 558 unit tests, 351 integration tests, lint, typecheck, workspace build and `db:probe` passed. Capacitor copy/doctor and Gradle debug build passed. APK signature/badging/permissions were checked; all seven prepared Web assets match byte-for-byte, with only the two Capacitor compatibility assets extra.
- device acceptance: not completed. User reported that the installed candidate did not expose/work for Author Collection/Directory editing or Entry rating. Since distinct v15 APKs reused versionCode 15, the installed binary could not be identified with confidence; v16 uses a higher version and an in-app build marker.

### v15 grouped acceptance (superseded)

Do not use the v15 file for a new install: it shares versionCode 15 with an earlier candidate. Install the uniquely named v16 APK below and confirm its diagnosticBuild before testing behavior.

## Current C2 v16 — verified upgrade candidate

- version code: `16` (higher than the v15 candidates; same package ID and debug signing key for an in-place upgrade)
- version name: `0.0.16-c2-author-resources`
- artifact: `T3-C2-v16-author-resources.apk` (4,375,653 bytes)
- SHA-256: `70d2ff01437b6ee54cf6e250c9746bf9ade776a9eac533fb4d85c324d8535f24`
- scope: shared rating-slot creation/reordering; Author membership in Producer Collections; Author Directory editing and Entry membership; rejects Entry-create requests that name the same rating slot once by numeric ID and once by stable UID
- automated evidence: 558 unit tests and 352 integration tests passed; lint, typecheck, `db:probe`, workspace build, Capacitor copy/doctor and Gradle debug build passed. APK inspection confirmed package `com.speechless666.t3.spike`, versionCode 16/name, v2 signature matching v15, minimal permissions, byte-identical seven prepared Web assets plus only the two Capacitor compatibility files, and embedded v16/capability/replay markers.
- database/device boundary: migration 028 is not applied to the formal database. The user confirmed the v16 candidate passed device acceptance on 2026-09-24; the build environment itself had no attached Android device.

### Grouped v16 device check (accepted by user on 2026-09-24)

1. Install `T3-C2-v16-author-resources.apk` over the existing app without clearing app data. In Offline Diagnostics confirm `diagnosticBuild` is exactly `0.0.16-c2-author-resources`. If it shows an earlier value, stop: the new bundle is not active yet.
2. Use a disposable desktop DB copy with migrations 025–028 and the three offline capabilities enabled. Refresh the phone's offline library while online. Stop only the desktop server; confirm the offline banner appears.
3. Verify the UI controls are present first. Then create/reorder Entry and Author rating slots, rate an Entry with a newly created slot, toggle the Author's Producer Collection membership, create/edit Directories, and move/remove Directory Entry memberships. Confirm optimistic state and pending count.
4. Restart the server; verify the same state on desktop and phone, then confirm Outbox counts settle after snapshot refresh. This v16 build did not include Collection CRUD/Entry membership, so those behaviors belong to the later grouped candidate.

## Superseded C2 v17 — grouped Collection management candidate

Do not install the v17 APK for acceptance: independent review found Gallery-scope loss, stale temporary Collection IDs after replay, and SFW-mode reorder failures. Its hash below documents the superseded build, not a test recommendation.

- version code: `17` (higher than the accepted v16 build; same package ID and matching debug signing certificate for an in-place upgrade)
- version name and diagnostic build: `0.0.17-c2-collection-management`
- artifact: `T3-C2-v17-collection-management.apk` (4,378,561 bytes)
- SHA-256: `eeaa68e57b23a8aa9a3ebb4c3f877f07c439befeab418a1df4df6e08bf97a827`
- grouped scope: create Entry and Author Collections offline, including one nested Entry-folder level; edit title, description and NSFW metadata; add/remove Entry and Author memberships; reorder the complete top-level Entry or Author Collection list; move a Collection member by queueing destination-add before source-remove
- consistency: Collections own their UUID/version chain. Metadata uses field-level captured patches so unrelated concurrent edits can merge; membership uses desired presence by stable subject UID; whole-list reorder compare-and-swaps every top-level sibling UID/order/version. Exact retries reuse receipts, dependent same-Collection edits preserve causal order, and a failed destination add blocks the corresponding source removal.
- compatibility: the grouped operation set is gated by `offlineCollectionManagement`; existing Author membership retains its separate compatibility flag. Migration 028 is reused with no new schema migration. Collection deletion, temporary import/bulk Collections, Directory deletion, Author/Entry deletion, and Entry merge remain online-only.
- automated evidence: 566 default tests and 357 integration tests passed; lint, typecheck, `db:probe`, workspace production build, `git diff --check`, Capacitor copy/doctor and Gradle debug build passed. APK inspection confirmed package `com.speechless666.t3.spike`, versionCode 17/name, v2 signature matching v16, only the existing Internet plus package-scoped AndroidX receiver permissions, byte-identical seven prepared Web files plus only the two Capacitor compatibility files, and embedded v17/capability/Collection-operation markers.
- database/device boundary: migration 028 remains unapplied to the formal `apps/server/.data/library.db`. No Android device was attached to the build environment, so the grouped device pass below is pending.

## Superseded C2 v18 — grouped Collection management

The user accepted the v18 feature set; v19 below supersedes it only as the new install candidate containing the secondary-folder display fix.

- version code: `18`; version name and in-app diagnostic build: `0.0.18-c2-collection-management`
- artifact: `T3-C2-v18-collection-management.apk` (4,380,049 bytes)
- SHA-256: `d9c34c823699789d4e315bf7b7f32342eea8cc299ebabc4e1c674fe1229cd2c5`
- grouped scope: the v17 Collection create/edit/membership/move/reorder set, plus review fixes: Gallery-scoped offline creation preserves its Entry type; negative local IDs remain stable across partial replay and resolve to server IDs on reconnection; SFW reorder retains hidden top-level siblings; Collection management requires both global and operation-specific capability flags.
- automated evidence: 571 default tests and 357 real-SQL integration tests passed; typecheck, lint, `db:probe`, workspace production build and `git diff --check` passed. Capacitor copy preceded the successful Gradle build. APK manifest confirms package `com.speechless666.t3.spike`, versionCode 18/name, minSdk 24, the existing two permissions, and an APK v2 signature with the same debug certificate as v16. All seven prepared Web files are byte-identical in the APK; the only extra Web asset files are `cordova.js` and `cordova_plugins.js`. The embedded JS contains v18, the Collection capability and all four new Collection operation markers.
- database/device boundary: the formal `apps/server/.data/library.db` was not migrated or used for tests. No Android device is attached to this build environment; real-device acceptance remains to be done.

### One grouped v18 device pass

1. Install `T3-C2-v18-collection-management.apk` over the existing v16 app without clearing data. In Offline Diagnostics confirm `diagnosticBuild` is exactly `0.0.18-c2-collection-management`; stop if an older value appears. Do not install the superseded v17 file.
2. Use a disposable migrated desktop database copy and the updated server. While online, update the phone's offline library and confirm Collection management is enabled; keep the formal library untouched for this first pass.
3. Stop only the server. In one pass, create an Entry Collection under a Gallery (and an Unfiled one if that tab already exists), create a nested Entry folder and an Author Collection, edit title/description/NSFW, change Entry/Author memberships, move a member between Collections, and reorder top-level folders with Show NSFW off while a hidden NSFW sibling exists. Confirm immediate projection and pending count; force-stop/reopen once to check persistence.
4. Restart the server. Verify the final Gallery scope, folders, metadata, member locations and order on desktop and phone. In an open locally-created folder, make one further edit after sync to verify ID reconciliation; then confirm pending/conflict/failed counts settle after snapshot refresh. Use only disposable Collections and members. Deletion remains online-only.

## Current C2 v19 — nested Collection folder fix

- version code: `19`; version name and in-app diagnostic build: `0.0.19-c2-nested-collection-folder`
- artifact: `T3-C2-v19-nested-collection-folder.apk` (4,611,138 bytes)
- SHA-256: `d0700ab1a2d51d418e41a59671b08718add008929fc20ee4349321115100a0f8`
- scope: nested Entry folder cards prefer the primary cover, fall back to the first preview, and reconcile empty/stale child counts/previews from the canonical paged query on parent open; refresh honors current visibility; an SFW transition clears inclusive previews immediately and ignores late responses. This works through online and snapshot APIs.
- next grouped content: SiteProbe C2 review Export returns the selected subset to its owning T³ import run over the same-origin API, with standalone save/download fallback. Export-file, nested manifest, preview metadata and media reads verify real-path containment and use a checked open handle to reject symlink escapes. Desktop SiteProbe workflow, not APK-only.
- automated evidence: 577 default tests, 362 SQL integration tests, 337 SiteProbe Python tests, workspace typecheck/lint/production build and `git diff --check` passed. APK assembled with JDK 21; build-tools 36 confirmed versionCode/name, v2 debug signature matching v18, only Internet and existing package-scoped AndroidX receiver permission; all seven prepared Web files byte-identical in APK plus only `cordova.js` and `cordova_plugins.js`. Embedded JS contains v19 marker and nested folder reconciliation.
- database/device boundary: no formal DB access or migration; ADB is installed but no Android device is connected, so this remains an automated candidate pending real-device acceptance.

### Grouped v19 acceptance

1. Install v19 over v18 without clearing app data. In Offline Diagnostics confirm `diagnosticBuild` is exactly `0.0.19-c2-nested-collection-folder`.
2. Online, open a parent Collection with a nested folder that has works. The child card should show a non-zero count and covers; include at least one member with no primary cover but a preview. Open the child and confirm the displayed count/card contents match the works inside.
3. Refresh/update the offline copy while online, stop the desktop server, and repeat the same parent → child check in snapshot mode. Do not repeat the already-accepted v18 Collection create/edit/reorder sequence.
4. Separately on desktop, open a SiteProbe search review from T³ and click Export: it should return the chosen items without a save dialog, then advance the import panel automatically. Opening a saved review page outside T³ should still offer the existing file save/download flow.

## Pending device acceptance

All outstanding C0–C3 real-device, private-LAN, restart, conflict and disposable-library checks are tracked in [`../../docs/offline-validation-checklist.md`](../../docs/offline-validation-checklist.md). Automated tests and an APK build do not mark those checkboxes complete. Do not run a new test against the formal `apps/server/.data/library.db` (its unexplained schema 030 is under separate investigation).

## Superseded C2 v20 — offline Entry–Author relationships

- version code: `20`; version name and in-app diagnostic build: `0.0.20-c2-offline-entry-author-links`
- artifact: `T3-C2-v20-entry-author-links.apk` (4,381,237 bytes)
- SHA-256: `0e89bfcee6bb44f36dcb89df2c340cd02b92596cf6fd0a57f34953483571ca46`
- scope: add/remove Authors for an existing Entry while offline. The complete desired Author set is capability-gated, captured by stable Producer UID, optimistically projected in the offline snapshot, and replayed in causal Entry-version order with idempotent receipts and stale-link conflict detection.
- migration: 029 adds Entry-owned journal revisions for relationship insert/delete; database doctor checks both required triggers. No formal `apps/server/.data/library.db` was opened or migrated during this work.
- automated evidence: 582 default tests and 367 SQL integration tests passed; workspace typecheck, lint, production build, `db:probe`, `git diff --check`, Capacitor copy/doctor and Gradle debug build passed. APK inspection confirmed package `com.speechless666.t3.spike`, versionCode 20/name, v2 debug signature, and only Internet plus the existing package-scoped AndroidX receiver permission. All seven prepared Web assets match byte-for-byte; the only additional public assets are `cordova.js` and `cordova_plugins.js`. The APK embeds the v20 marker and `offlineEntryAuthors` capability.
- device boundary: build/test environment has no attached Android device. This is an automated upgrade candidate; install over the existing v19 app without clearing data and confirm the exact v20 diagnostic marker before behavior checks.

### Grouped v20 device acceptance

1. Back up a disposable desktop DB copy and start the updated server so migration 029 is active. Refresh the phone's offline library online and confirm offline Entry Authors is enabled. Install `T3-C2-v20-entry-author-links.apk` over the existing app without clearing data; stop if Offline Diagnostics does not show `0.0.20-c2-offline-entry-author-links`.
2. Stop only the desktop server. On an existing Entry with multiple Authors, add one Author and remove another. Confirm the Entry immediately shows the intended complete Author set and the pending count rises. Force-stop/reopen once if convenient to verify the queued desired state persists.
3. Restart the server. Confirm the Entry's Author set matches on desktop and phone, then confirm pending/conflict/failed counts settle after replay and snapshot refresh. Keep the formal library untouched for this first pass.

The v20 device pass failed at the actual “新增作者” control: it still called the online resolve-or-create route, and existing-Author/Tag Relation suggestions still needed the server. The v20 scope and automated tests did not prove that editor path. Use v21 below for the grouped device acceptance; do not repeat the v20 instructions as proof of success.

## Superseded C2 v21 — grouped offline Relations and Author creation

- version code: `21`; version name / diagnostic build: `0.0.21-c2-offline-relations`
- artifact: `T3-C2-v21-offline-relations.apk` (4,385,025 bytes)
- SHA-256: `def5319146a51e66bc1961116ce791d5f347040ca944b683b4669910da896f43`
- grouped scope: snapshot-backed keyword/alias Relation suggestions for Author identity, Entry Tags and Author Tags; Entry Tag add/move/remove and existing Author Tag edits; Entry linking to a cached Author; **new Author creation and Entry linking as one atomic queued operation**. Name collisions and stale relationship bases conflict rather than silently selecting an Author. Tag assignment resolves names in a valid cached Facet. Locally-created Entries still cannot have Authors or Tags added offline; taxonomy rename/layout creation and deletion/merge remain online-only.
- migration / capability: 029 provides Entry–Author journals; 030 adds Entry Tag insert/update/delete owner revisions. `offlineEntryAuthors`, `offlineAuthorCreate` and `offlineEntryTags` are separate compatibility gates. Read-only inspection of `apps/server/.data/library.db` found schema 030 already present (`schema_migrations.applied_at = 2026-09-25 13:08:49` UTC); the initiating process was not established. Do not infer that the formal database was untouched, and do not run unscoped `db:doctor`, `db:probe` or migration commands against it for this release. No rollback was attempted.
- automated evidence: 592 default tests and 374 SQL integration tests passed, plus workspace typecheck, lint, production build and `git diff --check`; the runtime-diagnostics test passed with the v21 marker. Gradle `assembleDebug` completed with JDK 21. All seven prepared Web files match the APK's `assets/public` byte-for-byte, with only the two Capacitor Cordova compatibility files added; embedded JS contains the v21 marker, `entry.tags.set`, `entry.author.create-and-link` and both new capability names. `aapt` confirmed package `com.speechless666.t3.spike`, minSdk 24, targetSdk 36, versionCode/name and only Internet plus the existing package-scoped receiver permission. APK v2 signature verifies and its debug signing certificate SHA-256 matches v20. ADB listed no attached device: **real-device behavior remains unverified**.

### One grouped v21 device pass (disposable library only)

1. Install v21 over v20 without clearing app data. After refresh, Offline Diagnostics must show exactly `0.0.21-c2-offline-relations`. Stop if it does not.
2. Point the updated desktop server at a disposable database with schema 030 (not the formal library), and update the phone's offline library while online. After stopping the server, Diagnostics should show the most recent successful probe with `offlineEntryAuthors`, `offlineAuthorCreate`, `offlineEntryTags` enabled, and their three persisted metadata keys set to `"1"`.
3. While truly offline, use one disposable existing Entry: search Author Relation by partial name or identity alias and link one cached Author; use **“新增作者”** for a genuinely new name; search and attach an existing Entry Tag in an existing Facet (optionally try a new Tag name), then edit an existing Author's Tags. Verify each selected relation immediately appears, and that Outbox contains the corresponding Entry/Producer operations. Force-stop and reopen to verify the pending projections survive.
4. Restart only the disposable server. Verify on desktop and phone that the new Author exists only once, both Author links and Tag assignments match, temporary Author IDs reconcile, and pending/conflict/failed counts settle after the refreshed snapshot. If a conflict appears, keep the Outbox and capture Diagnostics instead of retrying blindly. Do not use a valuable Entry or the formal library for this first pass.

## Superseded C2/C3 candidate v22 — safety, explicit sync and recovery controls

- version code: `22`; version name / diagnostic build: `0.0.22-c2-safety-and-sync`.
- artifact: `T3-C2-v22-safety-and-sync.apk` (4,386,705 bytes); SHA-256: `39ff8fdb30cbe163255fa090f2576908bdf0e128519e9129a385ab7459b34a8a`.
- extends v21's offline Relation and Author functionality. Settings adds **Sync now** (probe/replay/full snapshot even with an empty Outbox), used/quota estimate with optional persistent-storage request, and a private JSON forensic export of queued operations and binary media (64 MiB cap; **no automatic import**). Clearing the local snapshot refuses while queued edits/media exist; a changed server epoch cannot replace it with work pending. Restore now migrates/validates in staging and rolls a failed promotion back across database, WAL sidecars and assets.
- automated evidence: 599 default tests and 376 isolated real-SQL integration tests passed; workspace typecheck, lint, production build and `git diff --check` passed. Gradle debug build succeeded; all 7 prepared Web files matched APK `assets/public` byte-for-byte. `aapt` verified package/version/minSdk 24/targetSdk 36; APK v2 signature verified. No real-device acceptance was performed.
- Follow the single [offline validation register](../../docs/offline-validation-checklist.md) for the grouped disposable-library/device test. Install v22 over v21 without clearing data, verify the diagnostic build before doing anything else. Do not run diagnostics, migrations or restores against the formal DB; schema 030's original trigger remains unknown. The prototype uses trusted private LAN without TLS or authenticated pairing and is not release-ready for untrusted networks.

## Superseded automated candidate v23 — media choices and change-feed server groundwork

- version code: `23`; version name / diagnostic build: `0.0.23-c1-feed-media-resume`.
- artifact: `T3-C1-v23-feed-media-resume.apk`; SHA-256: `db4401ba4669ee1c1316c2f6dfeca90ce1a72fb5b8a8b19cc55e3b18004c4bfa`.
- foreground media preloading now persists a metadata-only/thumbnail/explicitly selected-original choice and retries missing bytes after the app next starts. The original-image cache distinguishes a thumbnail alias from verified full-resolution bytes. Clear and epoch changes invalidate the foreground task; a WebView killed mid-download does **not** continue transferring in the OS background, and concurrent tabs are not transactionally fenced.
- server/shared now expose a paged, ordered change-feed with tombstones and a bounded durable served/ack cursor using immutable migration 031. The phone client does **not** consume or acknowledge deltas yet and still performs full snapshot updates. Isolated server startup cleans stale temporary upload files, and a failed second staging write cleans the first. A direct snapshot-clear call rejects unsynced operations/media, not just the Settings button.
- `TrustedLanPairing` has JVM-verified syntactic validation of literal RFC1918 IPv4 origins only, but is **not wired** into the existing WebView manual-pairing control. No QR, authentication, TLS, pinned identity, or trusted-network assurance is delivered. Do not mistake this candidate for secure pairing or a release build.
- automated evidence: 606 default and 382 isolated SQL integration tests passed; workspace typecheck, lint and production build passed; Android `testDebugUnitTest` and `assembleDebug` passed with JDK 21. `aapt` reports package `com.speechless666.t3.spike`, versionCode 23/name above; `apksigner` verified the debug v2 signature. No formal DB was deliberately opened or migrated for this candidate. **No v23 real-device acceptance has been performed**; follow the separate checklist using only a disposable server database. Migration 031 has not been established as safe for the unexplained formal DB schema 030.

## Superseded automated candidate v24 — offline safety and read-only feed transport

- version code: `24`; version name / diagnostic build: `0.0.24-c1-offline-safety`.
- artifact: `T3-C1-v24-offline-safety.apk`; SHA-256: `f02e0c8560e1ca6084036c7cef929dde518a49a1afe8ea27f67ce3a674655cdf`.
- the WebView manual pairing bootstrap now accepts only a literal RFC1918 IPv4 HTTP origin. It rejects userinfo, paths, query/fragment, alternative numeric host syntax, localhost/loopback and public addresses; already-saved invalid origins are re-prompted. This is syntax gating, **not** QR pairing, authentication, TLS, pinning or trusted-network assurance. The standalone Java validator remains unwired. Use only a trusted private LAN and disposable library.
- foreground media caching checks the snapshot generation again after storing the immutable response, before it publishes source/resolver aliases. This reduces stale publications but is not an atomic cross-tab Clear fence. The Android shell disables future automatic OS backup and device transfer for private WebView data; old cloud copies are not revoked, and unsynced phone-only data cannot be recovered by OS backup after a device replacement.
- the Web API can fetch and schema-validate a bounded server feed page. Because snapshot/journal coverage is incomplete, it deliberately does **not** apply deltas or acknowledge a cursor; Offline Update still installs a verified full snapshot. Post-create edits to a still-unsynced new Entry's Content/Tag/Author remain unimplemented: `entry.create` lacks Content rows and the pending Entry UI/editor lacks a safe causal path. No placeholder editing control was shipped.
- automated evidence: 625 default tests and 382 isolated real-SQL integration tests passed; workspace typecheck, lint, production build and `git diff --check` passed. Android JDK 21 unit tests/debug build passed. All 7 prepared Web assets matched the APK copy byte-for-byte; APK embeds v24 marker and strict pairing bootstrap. `aapt` confirms package, versionCode 24, minSdk 24, targetSdk 36, `allowBackup=false`, backup exclusion resources, Internet and the existing receiver permission only. `apksigner` verifies debug v2 signature and the signer matches v23. **No real-device acceptance was performed** and no test migrated the unexplained formal database schema. Install over v23 without clearing data only for a grouped disposable-library device pass when a device is available.

## Current automated candidate v25 — initial Entry Content and foreground media resume

- version code: `25`; version name / diagnostic build: `0.0.25-c1-offline-progress`.
- artifact: `T3-C1-v25-offline-progress.apk`; SHA-256: `c301a2b422eb6a734ba680fbfb8db21a9a704ba060f22320cd0e7f5cd5101588`.
- manual Add Entry can include an optional initial Content type + text/URL. It is included in the **original immutable** `entry.create` outbox operation with a stable UUID, persisted transactionally before the server receipt, displayed read-only on the pending Search card, and reconciled by the authoritative snapshot. A new `offlineEntryInitialContents` feature flag gates both local queueing and replay toward an older server; legacy create operations without Content remain accepted. No post-create edits to a still-pending Entry's Content/Tag/Author are provided.
- media preload now retries saved selections after a verified foreground reconnect as well as app startup. If the user changes the choice while the previous download is in flight, the new choice runs after the old one settles; malformed saved choices fail closed. This is not OS-background transfer and does not solve atomic cross-tab cache cancellation. The v24 private-LAN syntax guard remains only a syntax check, not authenticated/TLS pairing; the Web client still does not apply or acknowledge the incomplete change feed.
- automated evidence: 635 regular tests and 386 isolated real-SQL integration tests passed; workspace typecheck, lint, production build and `git -c core.safecrlf=false diff --check` passed. JDK 21 Gradle `testDebugUnitTest assembleDebug` succeeded. All 7 Web assets in the APK match the prepared assets byte-for-byte; the embedded JS has the v25 marker. `aapt` reports the expected package, versionCode 25/name, minSdk 24 and targetSdk 36. `apksigner` verifies v2 signature and the signer certificate matches v24. Only disposable/memory SQL tests ran; **no real-device acceptance or formal-library migration was performed**. Use the separate checklist with a disposable server and check its new capability before entering initial Content.
