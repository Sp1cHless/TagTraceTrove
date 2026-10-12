# Offline completion status — 当前源码与计划差距

## r25 实机同步循环修复（2026-10-12）

实机定位并修复：完整快照回退遗漏 ACK 重新获取；连续已交付封面上传被要求同时存在于最终快照；服务器缓存旧会话挤掉新恢复基线。三个复现各自聚焦回归通过，桌面服务已重载，手机已覆盖安装 r25。原有待同步 **12 → 0**，操作／媒体／本地媒体与删除意图均清空，无 failed/conflict。实机断网重连自动同步及更新，成功横幅消失；随后 12 秒空闲观察无继续循环。底部诊断复制实际成功。Wi-Fi 已恢复，未清用户数据。完整手势矩阵及原生后台生命周期仍待验收。

## r22 自动离线维护（2026-10-12）

重连自动同步本地改动，再更新已有离线库；首次下载及手动更新保留。失败保留数据，后续连接检查成功时重试，空闲心跳不重复更新。横幅只显示信息，成功后消失。Sync now、pending 导出／恢复、手动支持检查／持久存储授权／原生恢复入口已移除；底部集中支持、存储与诊断复制信息。聚焦回归 **5/5**，已打包 r22，因 USB 无设备未安装；手机仍是 r21。实机验收待执行。

## r21 画廊卡片封面刷新（2026-10-12）

实机反馈确认详情已显示本地新封面，而返回画廊沿用旧卡片数据。详情读取现在同步更新保留的画廊、标签返回与导入结果卡片；聚焦页面回归通过“删除 → 返回 → 上传 → 返回”流程。r21 已 USB 覆盖安装，未清数据。实际手机操作验收仍待用户进行。

## 本地最终结果与提交边界（2026-10-12，源码已实现）

未交付的本地编辑现在可以合并、撤销和取消，保留最早基线与当前结果；有依赖的顺序边界仍保留。已交付／不确定／旧版命令保留原件，后续编辑另存本地结果，待回执及确认后的基线就绪再生成后继请求。普通状态和标签编辑共用此存储入口，作者身份来自完整投影。

已解除新旧作品的本地封面删除、重复替换、补图片、图片排序及新作品普通删除栅栏。未交付且没有外部引用的新作品／图片可直接取消；已交付的创建／上传继续原样核对，页面即时显示最终选择，后台在确认后补做删除／排序。导出恢复包含本地选择和删除意图，Clear 不会丢弃它们。

唯一聚焦回归 `offline-local-final-state.integration.test.ts` **20/20**；覆盖隔离 SQL、冷重开、响应丢失、后台交付边界的桥接模拟、原件不变及导出恢复。已按用户要求打包为 `T3-v49-offline-final-state-r20.apk`，通过 USB 覆盖安装；装机 APK 哈希与本地一致，手机已加载新 Web bundle，诊断版本 r20。全套、typecheck、native JVM、实机离线操作验收与完整共享原子操作矩阵未验证。下方旧限制与旧交付记录为历史状态，不覆盖这一源码实现。

## v49 后连续离线标签／布局操作修复（2026-10-11）

源码已修复 B10 的旧 Facet 引用，以及既有作品的新 Facet 依赖、UID 移动版本遗漏、布局／模板混合结算和模板后 Facet 修改结算。B6/B7/B9/B10 可以在同一次断网期间连续执行；后续标签、资料、内容、评分、稍后看操作不需要先同步布局。归类提示使用本地实际影响数量。真正并发冲突仍保留原始操作，不以放松校验代替修复。

唯一聚焦回归 `apps/web/tests/offline-compound-tag-layout.integration.test.ts` 11/11，通过连续离线、冷启动、重连隔离 SQL、原样响应丢失重试和冲突保留验证。源码修复尚未重新打包／安装；手机 r16 不包含本轮改动。完整测试、native 执行及本轮实机验收未验证。离线新建作品的后续媒体添加／排序、普通删除等既有独立限制仍在，不能据此宣称所有普通页面手势已无条件离线可用。

## Project icon, boot screen, and the starting language — current status

Asked to make the two supplied drawings (`apps/web/icon/icon_white_background.png`, `icon_transparent_background.png`) the official icon everywhere, and to add a loading screen — the icon centred on white — for both the desktop and the phone, including the desktop's own startup step of preferring the saved offline copy.

`apps/server/scripts/generate-icons.mjs` derives everything from those two files (it lives beside the server because it needs `sharp`, and writes the .ico itself rather than adding a dependency): web `favicon.ico` (16/24/32/48/64), `icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (scaled to 0.56 so the drawing survives a circular mask), `apple-touch-icon.png` and `boot.png`; Android `mipmap-*/ic_launcher.png`, `ic_launcher_round.png` (circle-masked), `ic_launcher_foreground.png` (the transparent drawing inside the 108dp safe zone) and every `drawable*/splash.png` (white, icon centred at 42% of the short side); and `tools/t3-launcher/t3.ico` (16–256) for the exe, the window and the tray. The plain square icons carry a 0.86 margin so a launcher's corner mask cannot clip them.

`index.html` now points at those files (the two scaffold SVGs are gone) and carries the **boot screen** inline — markup and style, so the icon is on screen from the first frame, before the bundle and before any stylesheet. `src/boot-overlay.ts` decides when it goes: the connection phase must settle (`null`/`no-copy`), so the startup's own offline-copy step is never what a person sees, with a 4 s give-up deadline that guarantees it can never hide a working app. The Android launch window shows the same thing natively (`@drawable/splash`), so the phone's first paint and the web's first paint are the same picture.

`T3Launcher` carries `t3.ico` as its application icon and reads its own executable's icon for the tray, so the tray and the taskbar cannot drift apart.

Also fixed while verifying: the starting locale was hard-coded to `en`, so a device asking for Chinese still opened in English. With no stored choice the app now follows `navigator.languages` (any `zh*` ⇒ `zh-CN`); a stored choice still wins, and the switcher still persists.

Verified: 1259/1259 web tests, typecheck/lint/build clean; the exe's icon extracted back out of the built `T3Launcher.exe` (32×32, the onion); the desktop boot screen rendered white with the icon centred at 140×140; and on the phone (WGM77LVKD6RW9XZX, `T3-v47-icons-and-boot.apk`, versionCode 47, SHA256 `629a896592bd4ab59d88faa92bfccdea9ba76446c1a03a75f839318391ea0b33`, installed) the launch screen is the same white-and-centred-icon picture and the web boot screen dismisses itself. The phone's UI stays English because `t3.locale` is stored as `en` there — a saved choice, not a gap; its WebView reports `zh-SG`, so a fresh install would open in Chinese.

## App font and Chinese copy (v48) — current status

The user's own two requests in one batch: the Chinese UI "looked stiff" so T³'s own voice is now **霞鹜文楷** (LXGW WenKai, lightweight build, SIL OFL 1.1), and the split that makes a bundled font safe here — the face is applied app-wide on `body`, restricted by `unicode-range` to Han (Latin and the Arabic numerals stay in Inter), and every value that came out of the library wears `.t3-library-text` and returns to the platform stack. The library is scraped from many sites (rare kanji, traditional forms, Korean, emoji) so a subset cannot cover it by construction, while the app's own copy is a closed set a subset covers exactly; measured over the library's own 628575 characters the shipped subset misses 0.2880%, all of it Korean or emoji the full 13.2 MB font cannot draw either (`tools/fonts/subset-wenkai.py`: GB/T 2312 + Big5 + JIS X 0208 + kana + punctuation = 18109 glyphs / 3890 KB). The ~106 tags came from an in-page probe over the real titles/tags/author names, which is what caught the misses (a chip lost its face to `font: inherit` under Vue's scoped two-component selectors — hence `!important`).

Same batch: the user's hand pass over every `zhCN` value; `section` → 板块 / `facet` → 维度 finished across 28 more values; the shipped `common-template.json` renamed to Chinese (基本信息 / 类型 / 角色 / 语言 / 标签 / 所有标签 / 综合评分 — no code matches those names; the import's one name-based lookup is a facet literally called `series`); `SuggestionInput` sized by `field-sizing: content` so a Chinese placeholder is no longer cut off at 47px of the 65px it needs.

Verified: web suite at its known baseline (13 files / 30 failures, all of them the other workstream's untracked offline/native files) with `gallery-app` 228/228, typecheck clean, lint's 5 errors confined to another workstream's fixture, `template-export.integration` 7/7, build clean. APK `spikes/001-android-webview-shell/T3-v48-cjk-ui-text.apk`, versionCode 48, `0.0.48-c3-cjk-ui-text`, SHA256 `38f8b66af9f34459eeb001e955215b623f07b0063d6517457254a5699b8e664e`; packaged Web bytes/marker match, signer identical to v43–v47, `adb pull`ed base.apk SHA equals the local file (cover-install, data preserved). On the phone (WGM77LVKD6RW9XZX): the WenKai stack is active and loaded, data rows report `Inter`, the three 标签合并/删除 inputs measure 75 = 75, `CSS.supports('field-sizing','content')` is true on its Chrome 154 WebView, and the UI renders in Chinese. **The phone's stored locale was `en`; this delivery switched it to `zh-CN`** so the change is visible at all (Settings → 语言 switches it back). The renamed template shows after a server restart — `/api/templates/common` returns the Chinese names as of 19:44, the process having been restarted (not by me) after the file changed. Residual by design: the `内容种类` row keeps `Source URL / description` (a code vocabulary compared by value on export), and a Gallery that already applied the template keeps its own English names — the file is a copy, not a link.

## i18n sweep — current status

Asked to check every dictionary entry and make sure everything T³ can show — apart from code-level error messages — can be translated.

**Dictionary parity was already enforced by the compiler**: `zh-CN` is declared `satisfies Record<MessageKey, string>` over `keyof typeof en`, so a missing or extra key is a type error in either direction. The real gap was copy that never reaches `t()`. A scanner over `apps/web/src` (template text nodes, `placeholder`/`title`/`aria-label`/`alt`, and display-shaped literals in script blocks) plus a **walkthrough of the app in Chinese** found and fixed:

- `SecurePairingSettings.vue` — the whole pairing panel was English (19 strings: the panel title, both buttons, the recovery legend and its warning, the two PID/identity fields, both confirmation buttons, the QR `alt`, the paste fallback, the device rows' `revoked`/`authorized`, revoke/remove, and three status messages).
- `OfflineLibrarySettings.vue` — the media-mode options, the originals-refs label, the preload note, the native-transfer resume button and its long Android note, the native status summary, and the whole restore section (title, hint, file label, preview counts/adds, confirm, too-large, preview-failed, done, refresh-failed, failed).
- `GalleryApp.vue` — the diagnostics block (title, toggle, Refresh, Copy), the three media-block reasons, `Entry creation command is unavailable`, and the retry-media label.
- Small ones: the Advanced tab row's `aria-label`, the tag board's `aria-label`, a tag chip's `Remove {name}`, the content/date/duration/URL placeholders on Add Entry and the stats row, the `main.ts` library-mismatch banner, the two report titles in the Import and Rule-builder panels, and the System report's prose lines.

41 keys were added to **both** locales; the English values are byte-identical to the text they replaced, so every existing assertion still holds. 1250/1250 web tests, 725/725 isolated integration, typecheck/lint/build clean.

Verified by walking the running app in `zh-CN` (Home, a Gallery, an Entry, Authors, Collections, Search, View later, Recent, Random, Add Entry, Settings, and every Advanced tab): the only Latin text left is **data** — work titles, author names, site hostnames, `Source URL` / `description` (built-in Content kinds stored as values), and the `yyyy-mm-dd` format examples.

**Deliberate exceptions, for the record:** built-in Content kinds and rating/Section names are *data* copied into a Gallery, so localizing them needs a display-name mapping, not a dictionary entry (the shipped `common-template.json` typo `Basic Infomation` → `Basic Information` was fixed, but Galleries that already applied it keep their copy); `Source`/`Commit` stay English in Chinese prose as this app's terminology; `TagSandbox.vue` is a dev page that nothing imports; the Android shell's dialogs and the tray launcher's own copy are English and would need per-platform string resources.

## Offline recovery after a desktop restart — current status

Reported: after restarting the desktop from the tray, the app opened and then sat on the offline copy for several seconds before coming back online.

Measured on a scratch instance with an installed offline copy, with an in-page recorder: the page went offline **5.3 s** after the server was killed (the 4 s online heartbeat plus one failed request), showed the literal banner "Viewing the saved offline copy…", and — before this change — could only look again on the **15 s** offline poll (the online heartbeat stops firing while offline, and the focus/visibility events had already fired before the server was up). Recovery therefore took up to fifteen seconds.

`offline/connection-recovery.ts` now retries a **failed** probe with a short backoff (500 ms → 1 s → 2 s → 4 s, then it stays at the cap and the slow poll remains as a safety net); a success resets the backoff, and a retry that fires while the previous request is still settling reschedules itself. Measured after the change, same scenario: the page recovered **771 ms** after the server answered.

Two new tests pin it (fast retry after a failure; backoff capped rather than hammering), alongside the five existing ones. Web 1250/1250, typecheck/lint clean. Note the app is served by the same server, so a page can only be *showing* while the server is down when it came from the service-worker cache — which is exactly the tray-restart window.

## Desktop System page, tab row and settings — authoritative current status

Requested: a lowest-level page under Advanced function that shows and copies T³'s errors, backs the library up / exports / restores it, and carries an "automatically allow phone access" setting (default on); the Advanced tab row had to stop pushing tabs off a narrow screen; and title shortening moved under Templates.

Added `apps/server/src/http/system-routes.ts` (registered from `app.ts`; option `systemLogPath`): `GET /api/system/diagnostics` (the tail of the launcher's own log file, plus paths, backup count, settings and any staged restore), `GET/PUT /api/system/settings`, `GET/POST /api/system/backups`, `GET/DELETE /api/system/backups/:name` (a backup downloads as the database file itself), `POST /api/system/restore`. Backups use better-sqlite3's online `backup()`, so the app keeps serving while one is taken.

A restore is **staged, not swapped**: the live database is open, and replacing its file underneath — with a stale write-ahead log beside it — is how a library gets corrupted. The upload is validated read-only as a real T³ library, kept in `<dataDir>/restore-staged/`, and applied by `applyStagedRestore` at the next start *before* the database is opened, which first copies the library it replaces into `backups/`. The page therefore says "close the desktop from the tray and open it again" and never claims the library is already restored.

`autoAllowMobileConnection` lives in `<dataDir>/t3-settings.json` (default on, written atomically, an unreadable file falling back to the default) because the **launcher** must read it before the server exists: `LauncherPolicy.AutoAllowMobileConnection` / `SystemSettingsPath` and `ApplyServerEnvironment(..., autoAllowMobileConnection)` skip the pairing advertisement when it is off, and `server-cli.ts` refuses the secure listener for the same setting. This makes explicit what v45 already did implicitly (a plain launch advertised the private address).

Web: the System tab is last in `AdvancedEditingPage.vue` and talks to `/api/system/*` directly through `system-api.ts` rather than through `GalleryApi`, so the library interface and its offline facade stay untouched. `client-errors.ts` (installed from `main.ts`) keeps the last 40 uncaught errors, rejections and `console.error`s, and the page shows the server log, those client errors and the page's own facts as one copyable report. The tab row is `overflow-x: auto` with `min-width: 0` and non-shrinking buttons; title shortening is now a `.advanced-subcard` inside the Templates card (its `data-testid="advanced-titles"` kept, its tab removed).

Verified: 1248/1248 web tests, 715/715 isolated integration (6 new), typecheck/lint/build clean, and the launcher contract tests pass with four new settings cases. Desktop-verified against a **scratch instance** (a read-only copy of the real library in a temporary data dir on port 8899 — never the live server): the page rendered the real 44,892-character log tail, listed both backups, showed the phone-access switch reflecting the server, and a full restore round trip ran (create → export as a real SQLite file → stage → apply → the replaced library appeared as a backup). At a 360 px viewport the tab row measured `scrollWidth` 792 against `clientWidth` 296, with the last tab fully visible after scrolling.

Desktop-only: no APK. The running desktop server has to be restarted from the tray (Exit → open) before the System page can answer; until then it reports that the desktop did not answer, which the page shows rather than an empty screen.

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

本文件已根据 v40 候选更新（v39 → v40：离线读不再排在卡住的能力探针之后；离线 tag 编辑器回车提交。离线主干与能力集不变）。原方案：`relation-source-maintenance-offline-plan.md` §§23–31；统一实机清单：`offline-validation-checklist.md`。实现、自动化、窄审、打包、正式部署与真机为独立状态。

## 2026-10-08 续接状态（优先于下方历史 v40 待验措辞）

用户已确认此前遗留 App 测试完成、对应问题修复。本轮不重新派发旧清单；下方尚未逐项回填的 UNVERIFIED 保留为历史证据记录，不是当前未完成功能的证明。新授权按顺序完成 Gallery 排序离线适配、Entry preview 添加／删除离线适配，两项完成后集中验证；具体新功能尚未标记完成。稳定签名与正式部署仍独立处理。

## 1. 当前已实现的源码板块

| 板块 | 当前状态 | 尚缺的交付证据 |
|---|---|---|
| C0 native bundled shell、版本协商、持久 snapshot/Outbox/媒体、外链 | 已实现，历史壳曾真机验证；v38 候选待真机 | 真机升级安装、冷启动、实际 plugin/WebView |
| C1 read-only parity、snapshot 原子安装、媒体模式／缓存／Clear | 已实现；自动化及历史缓存性能证据 | 真机全页面离线／quota／cold launch／多 tab |
| C2 允许列表内 Entry/Author/Rating/Directory/Collection 修改与 conflicts | 已实现、durable queue／typed replay／optimistic overlay | 真机 compound edits、同字段冲突、并发与重启 |
| C3 create、初始 Content／媒体及 pending metadata/Content/Tag/Author 编辑 | 已实现，immutable create + independent children | 真机 Search/edit UI、升级后 Blobs、最终 numeric mapping |
| 新 Author、跨 Entry pending Author 复用；新 Tag/Facet 创建与放置 | 已实现，canonical multi-origin 与 scope／依赖验证 | 真机中文/IME/关系选择和实际布局／重连 |
| pending-work export/preview/atomic restore | 已实现；Settings→Memory/单 IDB TX；restore 专项 63 通过 | 真机 Android picker/文件落盘/边界内存／真实 peer race |
| 完整 snapshot delta 与 durable install-bound ACK | 已实现、服务端真实广告；actual Settings/HTTP 路径验证 | 真机实际 delta 请求、冷 pending ACK／多 tab／网络故障 |
| existing Entry parent-free 媒体追加／空 cover 填入 | 已实现，稳定 upload UUID／媒体状态 precondition／原样 retry | 真机上传编辑路径及实际 storage/断网恢复 |
| QR、独立 TLS 身份、native pinning、Keystore、单用码、可撤销 session、显式恢复 | 已实现，真实 TLS/JVM／隔离 SQL 执行，限定窄审 PASS | 真机扫码相机、成功 WebView 媒体、真实 Keystore 重启／换证 |
| native durable WorkManager operations + create/standalone media | 已实现，全部当前 23 operation kinds 计划／flags／deps／owner ordering；ledger v6 | 真实 Capacitor 插件／OS 调度／电池策略／kill/force-stop |
| §27.2 在线 create 原子 command（v38 新收口） | 已实现：在线创建收敛为单条可重试 `entry.create` command，media 独立；uncertain 失败以同一 opId/payload 落离线 Outbox，receipt 解决歧义 | 真机在线创建、断网中途失败→重连 replay 恢复 |

### 已知偶发（打包门槛相关，尚未定位）

`apps/web/tests/pending-work-restore-atomic.test.ts` 的 “defensive acceptance: refuses orphan and out-of-order creation dependencies across the whole union” 在全量 `pnpm test` 中偶发失败：观察到的窗口约 17 次全量中失败 2 次（两次都在同一条），而该文件单独跑、以及随后的 12 次全量（含一次 8 连跑）全部通过，从未复现。失败时输出的是断言差异（非超时）。因为无法按需复现，未做任何"让测试更宽容"的改动；复现时需要的证据是那条断言实际收到值与期望值的差异（三个断言分别指向"拒绝顺序错乱的 child"、"拒绝孤立 child"、"正序恢复后 `store.list()` 的顺序"），届时据此定位。

以上都不能标成“已发布并实机通过”。当前统一候选是 v40（`T3-v40-offline-read-latency.apk`，0.0.40-c3-offline-read-latency，SHA-256 `ceda01d1…aeb0`），包含全部上述板块与当前 web UI；签名仍为 debug keystore（与 v36 同证书），非稳定 release key。

## 2. 最新执行与窄审边界

v40 候选整树门槛：1191 standard、631 isolated SQL、typecheck/lint/build 全通过，Android JVM 各类独立 fork 全过（需仓库 Node 22 在 PATH，否则四个类因 `ERR_DLOPEN_FAILED` 报错）。整树包含双方（离线实现与 site-probe UI）改动，为合并后共同结果。真机已核（WGM77LVKD6RW9XZX）：作者框 44px 与相邻字段一致；键盘开启下真 IME 输入 `a` 时候选 A1/A2 上翻并完整可见；离线创建的作者候选来自本地快照。

Android JVM：54 tests、零失败／错误／跳过（按类独立 fork 运行——Robolectric native DLL 在单次合并运行中崩溃，每类单独 fork 全过；`T3_TEST_REPO` 必须指向仓库根）；instrumentation Java 编译完成但未执行。assembleDebug 通过；9 个打包 Web 资源与准备目录逐字节一致；aapt 确认 versionCode 38 与权限集；apksigner 确认 v2 签名与 v36 同证书。

- Restore：限定只读 review PASS，停止扩审。Same client/library/epoch，decoded media 64 MiB、serialized file 96 MiB；不靠导出 receipt／数字 ID 补缺失 creation parent。
- Delta：限定 review PASS，随后实际广告路径验证；cache unavailable 才 verified full fallback，corruption 不静默兜底，ACK丢响应冷重试与 ABA/Clear/epoch/quotas 原子保护。
- Pairing：限定 source review PASS；未覆盖的 plugin/client bootstrap/server binding 独立审查预算边界保留，不能扩大成全安全认证。
- Background：限定 source review原 FAIL 的唯一多图 create loop 缺 deadline finding，真实 RED→GREEN 加预算 pre-PUT check；父任务读修复及完整门槛后精确关闭，没有外部第二次 PASS。记录进度／释放 retry lease，冷恢复剩余原图。
- 23-kind native矩阵部分是严格 contract-response execution；不是 23 类业务都以真实 SQL 应用的宣称。主要多类型与媒体链路有真实 pinned TLS／临时文件 SQLite 证据。

## 3. 距原计划全部离线内容还有什么

### 已有证据：主要离线功能源码板块已补齐

按原方案 C0–C3 的功能主干，以及后来授权的 pending 关系／restore／delta／native 背景扩展，当前不是还缺一个新的大型离线实现板块。原 §27.2 在线 create 前置契约已在 v38 实现（服务端既有原子 `entry.create` replay/receipt 通道 + 在线单命令提交 + uncertain 同操作离线兜底）。未实机验证不等于未实现；模拟测试通过也不等于可发布。

### 实际尚未完成的交付工作

1. **真机集中验收**：唯一完整待验表是 `offline-validation-checklist.md`，全部 UNVERIFIED，v40 为当前候选。重点：Android扫码／成功WebView媒体／Keystore、后台OS行为、cold launch／compound edits／真实多tab。失败后只修对应具体问题。
2. **稳定 release 签名**：v38 仍用 debug keystore；覆盖升级依赖与历史同证书。正式发布前需明确 release key 策略。
3. **正式部署单独授权**：隔离候选通过后，正式库／assets／迁移／备份与切换需明确授权；当前未部署。部署不是用正式库跑 chaos tests。
4. **可选后续**：纯浏览器 PWA、离线媒体 replacement（§25.5 明确 online-only）、逐字段冲突 merge 编辑器均为非本轮承诺项（见 §4）。

因此不提供虚构完成百分比。源码功能主干与 §27.2 前置契约已完成并有整树门槛证据；剩余为真机平台证据、签名决策与部署授权。

## 4. 不算原计划缺口的项目

- **已有媒体 replacement／覆盖已占用 cover**：原方案 §25.5 明确 online-only，原清单 Completion rule 也排除。当前空 cover填入／preview追加不等于 replacement；如需离线 replacement，应另行授权扩展，不能因为尚未做就误报 C0–C3 未完成。
- destructive Entry/Author/Collection delete、merge、taxonomy、复杂 templates/layout、新 Gallery/type、Import/Source-maintenance batch 保持 online-only；后来明确扩展的具体 Tag/Facet/rating/Collection 安全操作不等于全面开放 Advanced。
- 逐字段“保留本地／重新基线”冲突编辑器不是已完成能力；已有 visible conflict／保存原工作／显式 discard。§31要求 conflict 可见，不能自动把完整 merge UI 算成核心计划承诺。
- 纯浏览器可信 HTTPS PWA 为可选路径，不是 native APK 必须补交的第二个客户端；若选交付，需单独 Chrome/SW/证书验收。
- 开机自启、常驻服务、无限后台存活、force-stop 后继续执行，不在方案承诺中。有限 WorkManager 扩展不引入这些保证；部分下载预加载仍前台／重开后恢复。
- 整库 DB+assets power-loss/crash恢复保证是另一个平台验收边界，不是 pending-work单 IDB事务 restore。

## 5. 当前行动边界

v38 打包为本轮明确授权的工作（用户批准“更新 UI → 冻结 → 打包 → 一起真机验收”顺序）。不自动 merge/commit/reset/stash；不触碰正式 `apps/server/.data/library.db` 或 assets；不启动默认 server。下一步是用户按唯一清单执行真机验收；失败只修对应具体问题。
