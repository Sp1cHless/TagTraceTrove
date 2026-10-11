# Current project boundary

## Active instruction / stop point

Latest closed Preview checkpoint: `.hermes/tmp/preview-final-safe/green/manifest.json`; parent verified all seven source/test hashes and independently reran 29 media/vertical tests PASS. Atomic upload staging now revalidates operation identity in IDB same transaction / Memory same tick; stale captures are rejected without orphan Blob. Native cancellation/UI/Settings and UUID thumbnails remain closed. New sole writer owns exactly deletion-only incomplete/wrong-survivor snapshot cleanup and actual Android paired raw-byte/auth caller evidence. Parent owns one bounded review and final grouped gates/APK after these two are closed. No release/device/deploy PASS yet.

Remaining acceptance: deletion-only survivor byte proof before snapshot activation/ACK/cleanup, and actual canonical Android fetch bootstrap→paired authenticated byte transport. Uploaded-media wrong-byte/404/503 and valid media-omitting snapshot defenses passed first-GREEN; they do not substitute for deletion-only or native authenticated evidence. Exact latest handoff: `.hermes/artifacts/preview-final-implementation.md`. Previous atomic-stage race is repaired, not an outstanding source blocker; historical recovery evidence below is not current state.

Historical source recovery is CLOSED. Preserve `.hermes/tmp/offline-api-restored-validated.ts` and `.hermes/artifacts/source-recovery-status.json`; never restore HEAD or old 5,384-line recovery baseline over later Preview work. Recovery-only 1,793-test PASS is historical, not the latest feature release gate. Detailed incident/review evidence is archived; current work and checkpoints are described above. All production edits remain targeted patches after complete-byte backups. Formal DB/assets/default services remain protected.

2026-10-08 用户确认：此前遗留 App 测试已完成，对应问题已修复；旧清单的 UNVERIFIED 不再作为重复验收待办（未补造逐项设备证据）。本轮授权按顺序实现：① Gallery 排序的完整离线适配；② Entry 内 preview 添加／删除的离线适配。①源码实现与专项 UI/IDB/HTTP/native/typecheck 已完成；当前推进②，最后两项集中整树验证与 APK 包装。详细证据见 `docs/offline-gallery-preview-progress.md`。工作区保持不 merge/commit/reset/stash；不触碰正式 `apps/server/.data/library.db` 或 assets；不启动或重启默认 server。

## Canonical status documents

- `docs/offline-validation-checklist.md`：历史集中验收清单；用户已确认完成，旧 UNVERIFIED 仅保留未回填的逐项证据边界，不作为重跑要求。v40 为上一已交付版本。
- `docs/offline-gallery-preview-progress.md`：本轮新功能的有限验收板与源码／自动化／包装证据。
- `docs/offline-completion-status.md`：源码／自动化／review／包装／真机分层状态，以及与原计划的实际差距（已按 v38 更新）。
- `docs/relation-source-maintenance-offline-plan.md` §§23–31：原设计与 C0–C3 allowlist；§27.2 已于 v38 落地。
- `spikes/001-android-webview-shell/README.md` v40 节：当前候选 APK 的证据记录与验证结果（含真机实测值）。

## Current implementation boundary

离线只读、现有对象编辑、create/media、pending Entry metadata/Content/Tag/Author、新 Author 与跨 Entry 复用、新 Tag/Facet、atomic pending-work restore、完整 snapshot delta/durable ACK、QR/auth/TLS pinning、native ledger v6/有限 WorkManager，以及 **§27.2 在线可重试原子 create command**（metadata/ratings/View later/初始 Content 一条 command；media 独立；uncertain 失败以完全相同的操作落离线 Outbox，由 receipt 解决歧义）均已有实际源码与自动化证明。

v40 候选（`0.0.40-c3-offline-read-latency`，SHA-256 `ceda01d1e2d98b3104b61d92c807b16424b0ba1ffbebb331c93cee4ac341aeb0`）在 v39 之上再做两处修复：离线读不再排在卡住的能力探针之后（`PairedTransportPlugin.status` 改用独立单线程执行器；真机 A/B 由 7674ms 降至 253ms，探针自身请求实测 8069ms 才失败，读与请求同时结束），以及离线 tag 编辑器按 Enter 不再被残留的组字标记吞掉（改以事件自身的 `isComposing` 为准；真机输入 `zztmp2` 后回车 2129ms 内出现 chip，无需失焦）；tag 写入不再等整条条目重读（写入返回 tag 身份、界面立即落上，真机由 1169ms 降到 799ms，三个重读请求转到后台）；创建后重载当前 Gallery 卡片列表、Settings 的 Update/Clear/Restore 触发可见数据重读（两条都是你记录的“派生界面在返回路径上变旧”）；服务端新增 `/api/pairing/forget` 清理已撤销设备记录（活设备拒绝，桌面设置页有 Remove record）；**发布级**：托盘启动器（T3.exe/T3.bat）自己广告私有地址，使加密配对在打包后的普通启动中即可用；属主锁改为“持有 loopback 端口”作为存活凭证（PID 会被复用），主人已死则下次启动静默接管、主人仍在则拒绝；锁出现任何问题都不再打断桌面服务（恢复表单始终可达）；合集下拉在手机端改为按触发按钮实测定位（真机实测 x93–285 完全在屏幕内，原来右边缘被切）；离线创建那条**提前 return** 的分支也补上了刷新（真机：离线创建的作品立刻出现在网格并带 staged 封面）；探针（`/api/sync/capabilities`）连接超时 8s→2s；离线读不再每次向原生取 libraryId（新增 `createShellLibraryIdSource` 缓存，focus/online/回到可见时失效）；服务端把“缩略图渲染失败”归为 400；客户端也不再因为一条被服务端拒绝的媒体上传而中断整次重放（真机实测：pending 8、failed 0、好的封面连尝试都没有——媒体按 entryUid 排序，被拒的那条挡在前面），改为把该行标成 failed 并继续排空，只有传输类错误才留待重试；手机端设置面板改为**实测**背后 `.content-panel` 的框并对齐它（左/宽/顶一致，底边自由），不再重复内边距表达式（那正是它偏窄偏左、右边漏出背景框的原因）；因面板是 header 子元素而 header 的 `backdrop-filter` 会使其成为 fixed 的包含块，测量再按实际渲染校正一次（真机实测两框均为 left 12 / right 348 / top 72 / width 336）。v39 在 v38 之上只改 web 层三处：composer 作者框复用字段样式；候选列表在键盘下方无空间时上翻并按可用空间限高、随视口与滚动重算；输入框文本改由普通 `@input` 读取（Vue 的 `v-model` 在 IME 组字期间丢弃 input 事件，组字未结束前查询不前进、搜索从不派发——这正是用户手机上“输入后不弹候选、点开别处才出现”的成因）。整树门槛：1158 standard / 621 isolated SQL / typecheck / lint / build 全通过；APK versionCode 40 + marker 一致，九个 Web 资源与 APK 逐字节一致。真机（WGM77LVKD6RW9XZX）实测：作者框 44px 与其他字段一致；键盘开启时字段 y363–407／视口 430，真 IME 输入 `a` 后候选 A1/A2 上翻至 y273–359 完整可见；同一 Entry 打开在“探针在飞”下由 7674ms 降到 253ms；tag 写入到 chip 由 1169ms 降到 799ms（写入 713ms，三个重读转后台）。

## Remaining implementation / release work

- 本轮 Gallery／preview 新功能集中自动化、APK 核验与新功能验收；旧 App 整套测试用户已完成，不重复派发。OS kill/force-stop/plugin/scanner/WebView/Keystore 和真实多 tab 的新覆盖仍须与 JVM/IDB 自动化分开记录。
- 稳定 release 签名决策：v40 仍为 debug keystore；正式发布前需确定 release key 与换签/升级路径。
- 正式部署需单独授权与安全备份／迁移／assets整合；不默认操作正式库。

## Not a core-plan gap

原计划 §25.5 排除已有媒体 replacement，包括占用 cover 的离线替换；它仍 online-only，不算 C0–C3缺失。新 Gallery/type、破坏性主体删除／merge、taxonomy/templates、Import/Source batch同样不因“全部离线”自动纳入。细粒度保留本地冲突编辑器、可选纯浏览器 PWA、常驻／开机自启／force-stop 后继续任务不是本轮已交付或必需的默认承诺。
