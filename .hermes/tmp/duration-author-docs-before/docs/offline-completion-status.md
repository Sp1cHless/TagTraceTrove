# Offline completion status — 当前源码与计划差距

## Frozen artifact / concurrent-source boundary

The v41 APK and its build-time tests/review remain the delivered Gallery/Preview artifact, not a claim that the currently changing repository is globally GREEN. After the APK was built, another workstream changed Author rating code in offline-api.ts, api/gallery.ts and GalleryApp.vue. Those later edits were not rolled back, silently repackaged or covered by this APK's gates. In particular the later author_self slot-layout change is absent from this delivery. Raw live-source SHA must not be substituted for the build-time checkpoint. Verified APK/public Web bytes are frozen under `.hermes/tmp/release-v41-final/packaged-web-manifest.json`; observed later API drift is recorded alongside it. No additional feature review or production edits were opened to absorb that separate workstream. “No writer remains” in earlier completion wording means this Gallery/Preview workstream only.



## v41 delivery — authoritative current status

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
