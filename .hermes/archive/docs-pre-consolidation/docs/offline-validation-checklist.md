# Offline C0–C3 集中验收清单

状态：当前源码的待验总表；所有未取得本轮真实设备证据的项目均为 UNVERIFIED。整理基准为本次会话安全停点，不代表已部署或已发布。原方案：`relation-source-maintenance-offline-plan.md` §§23–31；实施／剩余边界：`offline-completion-status.md`。**人工执行步骤见 `offline-device-test-guide.md`**（按场景组织的大白话操作手册，结果回填本清单对应编号）。

## 2026-10-08 状态归并

用户确认此前遗留 App 测试已完成、对应问题已修复。本表未补造逐项 Case ID／设备证据，以下历史未勾状态不再作为要求用户重跑整套验收的待办。本轮 Gallery 排序与 Entry preview 添加／删除离线扩展单独记录新增自动化及交付结果。

## 0. 当前候选与证据边界

- 当前源码已包含 pending Entry metadata/Content/Tag/Author、跨 Entry 新 Author、Tag/Facet 创建、工作文件原子恢复、完整 snapshot delta、QR/TLS/授权、原生 WorkManager 全操作族与独立媒体传输，以及 §27.2 在线原子 create command。
- v40 候选整树门槛：1191 标准测试、631 隔离 SQL、typecheck/lint/build 全通过，Android JVM 各类独立 fork 全过（需仓库 Node 22 在 `PATH`，否则四个类因 `ERR_DLOPEN_FAILED` 报错）。整树包含离线实现与 site-probe UI 双方改动。（v38 时的基线为 1116 标准 + 617 隔离 SQL。）
- 核对 JVM XML：54 tests，零 failures/errors/skipped（按类独立 fork 运行——Robolectric native DLL 在单次合并运行中崩溃）。Android instrumentation 编译通过，但未执行。这不是 Android 设备证明。
- 23-kind native 矩阵部分使用契约响应 mock；不是 23 类业务全部真实 SQL 应用的声明。主要多类型、创建／多媒体／独立媒体链路有真实 pinned TLS + 临时文件 SQLite + 冷恢复执行证据。
- Native 窄审原 verdict 为 FAIL，唯一多图 create 内循环预算 finding 已实际 RED→GREEN 修复，并由父任务读代码精准关闭；没有第二次外部 PASS，也不是穷尽安全认证。
- 当前统一候选 APK 是 v40：`spikes/001-android-webview-shell/T3-v40-offline-read-latency.apk`（versionCode 40，`0.0.40-c3-offline-read-latency`，SHA-256 `ceda01d1e2d98b3104b61d92c807b16424b0ba1ffbebb331c93cee4ac341aeb0`，仍为 debug 证书）。在 v38 基线上累计的修复：§27.2 原子创建命令、新 Gallery 回退、白屏根因、配对恢复、跨纪元队列清除、封面通道路由；v39 的 composer 作者框样式、候选列表键盘避让、IME 组字期间的查询跟踪；v40 的离线读不再排在卡住的能力探针之后、离线 tag 编辑器回车提交、tag 写入不等整条条目重读、创建后重载 Gallery 列表、Settings 变更触发可见数据重读、已撤销配对记录可清理、合集下拉按触发位置实测定位、离线创建（含提前 return 的队列分支）也会刷新网格；探针连接超时改为 2s；离线读不再每次向原生取 libraryId；服务端把无法解码的图片归为 400；客户端也不再让一条被拒的媒体上传中断整次重放（改为标 failed 并继续排空）；手机端设置面板实测并对齐背后主框的宽度与顶边。真机（v40）已验证：作者框与相邻字段同高、键盘开启时候选上翻完整可见、真 IME 输入出候选、同一 Entry 打开在“探针在飞”下由 7674ms 降到 253ms、离线 tag 回车 2129ms 内出现。v36/v38/v39 均不包含后续功能，不可用于验收。
- 历史 Android／浏览器验收只证明当时版本。新证书／扫码／Keystore／后台协议必须按本表重新验收。

## 1. 使用方法与安全前置

每项完成后在行尾记录结果与证据编号，不能根据 build、JVM、模拟 IndexedDB 或 flag 自动勾选。无法制造的故障记 BLOCKED，写明原因，不当作 PASS。

- [ ] ENV-01 准备隔离 SQLite 和独立 assets；不使用 `apps/server/.data/library.db` 或正式 assets。克隆／部署正式库需另行授权。
- [ ] ENV-02 新版测试 APK 先完成 versionCode/versionName、bundled Web bytes、签名兼容、manifest 权限核验；记录 APK SHA-256 和对应源码版本／工作树基准，确认其他 session 改动如何整合。
- [ ] ENV-03 同一测试构建使用匹配服务端；记录 libraryId、syncEpoch、SQLite schema、snapshot/protocol、native plugin/plan version 和实际 capability。只记录标识，不记录 token、配对码或私钥。
- [ ] ENV-04 备份隔离库及 assets，确认可在第二隔离目录恢复；故障注入仅针对这些副本。
- [ ] ENV-05 全量待同步工作保留期间不得清 App 数据、卸载、换库或强行 Clear。导出文件含私人明文数据，妥善保管；导出不是允许删除源工作的凭据。
- [ ] ENV-06 记录手机型号、Android、WebView、可用空间、应用电池策略与网络；严格区别普通划掉任务、OS kill、force-stop 和重启设备。

## 2. Shell、升级、冷启动与基础 UX

- [ ] SHELL-01 同签名覆盖安装，不清存储：snapshot、Outbox、Blobs、pair state 均保留；旧 native plugin 的协议不支持新操作时明确回退／暂停，不假报已后台排队。
- [ ] SHELL-02 关闭 Wi-Fi 和服务端，force-stop 后冷启动：bundled UI、缓存 snapshot、待同步卡片可用；不能依赖一次远程页面加载。
- [ ] SHELL-03 服务端不可达与互联网断开分别测试；不以 navigator.onLine 代替可达性，首屏不卡在无限 probe，出现可理解的本地状态。
- [ ] SHELL-04 Source 外链交系统浏览器且不阻塞 App，不附带 native 授权。回 App 的页码／筛选／滚动正常。
- [ ] SHELL-05 壳升级不再被旧 PWA shell cache 接管，不误删 IDB／Outbox。native shell 与可选浏览器 PWA 的 worker 行为分开验证。
- [ ] SHELL-06 阻止不支持的 protocol／snapshot format／plugin version；保留原工作，显示明确下一步。

## 3. 安全配对、扫码、TLS 与恢复

- [ ] PAIR-01 桌面隔离服务生成并显示 QR；真实相机扫描／权限拒绝与重新授权／取消扫描均可用。粘贴 fallback 单独测试，不能将粘贴 JSON 记为扫码通过。
- [ ] PAIR-02 expiring single-use code：成功 claim 后重扫失效；过期拒绝；两个客户端并发只有一位成功。QR 不含长期 session token。
- [ ] PAIR-03 API create/PATCH、capabilities、snapshot、replay 和 WebView cover／preview／Author artwork 使用已配对 pinned TLS；JSON 成功不等于图片通路成功。
- [ ] PAIR-04 Keystore 加密保存凭据；实际 App 进程终止、force-stop、设备重启后重新打开仍能连接，损坏私有凭据 fail closed。不清 snapshot／Outbox。
- [ ] PAIR-05 服务端重启后的授权持久性；撤销手机授权后 API／媒体／后台写入拒绝，原操作和 Blob 留存。重新配对需明确动作。
- [ ] PAIR-06 在隔离服务替换证书，同 endpoint 的旧 pin 拒绝；不能自动信任新证书。确认 replacement 后使用新 QR；旧 token／旧 code 不复活。
- [ ] PAIR-07 foreign library／epoch 变化、非私网或含歧义的 endpoint、scheme downgrade 均 fail closed；不以 numeric ID 相同猜测同一 Entry。
- [ ] PAIR-08 HTTPS 与 HTTP 跨 origin redirect 拒绝，不向目标转发 Authorization；Source 外链不进入该授权通路。
- [ ] PAIR-09 loopback-only 桌面发行／撤销／身份重置／残留锁恢复：LAN 不能调用、错误 Origin／CSRF 拒绝；恢复需明确 library/PID，活 owner、错 PID、危险路径拒绝。
- [ ] PAIR-10 崩溃残留 owner lock 的显式恢复与证书重置不触碰业务 DB/assets，手机工作保持；不能自动清锁或无提示换证。确认桌面 OpenSSL 依赖和本地配置权限。
- [ ] PAIR-11 secure listener 启用后，不并存未授权的 LAN HTTP 写入旁路；不需要全局安装 CA、第三方账户、VPN 或 public exposure。

## 4. Snapshot、媒体缓存与只读 parity

- [ ] READ-01 Download 后核对 Entry／Author／Tag／Facet／Content／Collection／Directory／Rating／usage／View later 数量和典型详情。
- [ ] READ-02 离线浏览 Gallery、Entry、Author works／Directory、Tag result、Search（中文／别名）、Recent、View later、Random、Collection／一层子目录。
- [ ] READ-03 筛选、全局排序、多页分页／Random seed、Back／滚动／页面恢复；不能只重排当前页而伪装全局排序。
- [ ] READ-04 SFW／NSFW 跨 Gallery 边界、隐藏内容提示和空库区别，筛选后的 Entry／Author／Collection 不泄漏隐藏卡片。确认首次含敏感内容下载的隐私提示。
- [ ] READ-05 metadata-only 无媒体请求；thumbnails 只取相应缩略图；selected originals 仅显式所选原图，选择跨重启保存。
- [ ] READ-06 缓存媒体冷启动和重复返回：正确新封面、完整原图、叠层／Author／Collection 卡片，无旧 id 复用串图；Update 后新 resolver 版本生效。
- [ ] READ-07 预加载中断／quota 满／kill 后再次进入能继续缺失字节；区分 snapshot ready 与 media ready。未承诺下载在死进程或 force-stop 后继续。
- [ ] READ-08 Download／Update checksum／quota／中断失败旧 generation 可用，Outbox／Blobs 不变；正常保留 active/previous，Clear 与 epoch rotation 不复活旧任务。
- [ ] READ-09 有 pending operation 或独立 staged media 时 Clear 拒绝；空库 Clear 也使旧 capture 失效。多实例／多 tab 的旧任务不能 publish 覆盖新状态。

## 5. C2 现有对象离线修改

- [ ] EDIT-01 既有 Entry title／uploadDate／pageCount（不改 Entry.type）、rating、View later、View/Like：即时投影并在 force-stop／重启后保持。
- [ ] EDIT-02 Content append／modify／replace-set／reorder／delete，包括删除全部行；Content stable UID、次序和文本／URL 原样收敛。
- [ ] EDIT-03 Entry 已有 Author link／unlink，以及新增 Author 后关联；同名／别名／canonical collision 由产品规则显式处理，不静默创建重复 Author。
- [ ] EDIT-04 Entry 已有 Tags 在 default／named Facets 增删移动；Author Tags 独立词表，中文短 query、别名 partition、重复排除／IME 真键盘输入无误。
- [ ] EDIT-05 新 Entry Tag vocabulary／同 type 新 Facet 的创建与放置；同 type shared layout 正确，跨 Gallery 不误写；合法多 origin canonical reuse 不产生冲突或重复词条。
- [ ] EDIT-06 Author profile／tags／rating／View later 和 rating slot／layout 可允许操作，各自实际能力 flag 与 scope 生效。
- [ ] EDIT-07 Author Directory 创建／更名／次序／成员；Entry 与 Author Collection 创建、更名／NSFW、membership、顶层 reorder、一层子目录，触屏操作不超 scope。
- [ ] EDIT-08 成员 move 先 destination-add 再 source-remove；destination 失败不丢成员。同 owner 后继暂停，独立 owner 能继续。

## 6. C3 未同步 Entry 与本地关系

- [ ] CREATE-01 已有 Gallery 内离线创建 metadata、Source URL／初始 Note、可选 rating／View later，无媒体／cover／多 previews 均可；双击提交／重启不重复创建。
- [ ] CREATE-02 pending Search 卡片 metadata 修改；独立 Content append／修改／重排／删除全部，原 create envelope 不改写。
- [ ] CREATE-03 pending cached Tag add/move/remove，已有 cached Author link/remove，新增同 Entry Author；父或兄弟 failed/conflict 时编辑禁写但原工作保持。
- [ ] CREATE-04 Entry A 创建的新 Author 被 pending B 与 existing C 复用；unlink/relink、online 恢复后负 local ID 仍走安全 UUID 路径。
- [ ] CREATE-05 pending 新 Tag／Facet 及在既有同-type布局放置：依赖 creation receipts 和 origin proof，canonical 相同但 local origin 不同不误拒绝。
- [ ] CREATE-06 Force-stop／App 升级后 create、children 与每张 Blob 保持；Sync 后准确 numeric route mapping，旧卡片链接不能跳到另一条记录。
- [ ] CREATE-07 正常／failed／conflict 与子 Content／关系各自原因可见；计数类别互斥，不将 failed 当 pending，不伪装自动解决冲突。
- [ ] CREATE-08 冷恢复 sync 后 one Entry／正确 Authors／Tags／Contents／ratings／View later／cover＋多 previews；所有最终 owner timeline 被 snapshot 覆盖后才清原 queue。
- [ ] CREATE-09 支持 onlineEntryCreateClaim 的隔离 server：在线 create 已提交但响应被截断，offline fallback 使用同 Entry UID；回连只 adopt 一个 matching unchanged Entry，初始 Content／rating／View later 与媒体各只应用一次。peer 改动或 UID/body 碰撞明确阻断，不猜测归并。
- [ ] CREATE-10 无 claim flag 的旧 server：legacy create 响应丢失时保留 draft／检查库提示，不 enqueue 可能重复的 create；probe 在 POST 前失败才允许合法离线草稿直接保存。
- [ ] CREATE-11 同一未关闭 composer 的 create command 响应丢失：重试保持首个 opId/UID（同操作重放由 receipt 应答）；有离线副本时 fallback queue 收到的是完全相同的操作（同 opId/payload），回连后初始 Content/rating/View later/媒体各只应用一次。进程在持久写入之前死亡／重开新 composer 没有 durable intent 保证；不标为已覆盖。失败仍显示“已创建但不完整”，不能再次创建双胞胎。

## 7. 已有 Entry 的独立媒体

- [ ] MEDIA-01 正 numeric ID 的实际上传编辑路径断网后持久 enqueue，无 synthetic create/opId；snapshot UID/library/epoch/preconditions、upload UUID／hash／MIME／Blob 原样保留。
- [ ] MEDIA-02 空 cover 填入与追加多 previews：预条件／ordinal 链正确，重启后上传依赖／次序保持；此项不是现有 cover replacement。
- [ ] MEDIA-03 Multipart 已提交但响应中断，native 与前台 cold retry 原 UUID：一个 existing Entry、无 creation-registry 行、每张媒体只一份 receipt／append。
- [ ] MEDIA-04 desktop 同时修改 media state，旧手机 precondition 冲突且不覆盖旧引用／文件；queued 原图保留，不能自动改原 metadata 消除冲突。
- [ ] MEDIA-05 cover 或早期 preview failed/held 时暂停后继；显式 discard 先 native pause，只移除依赖链而非其他 Entry／先前成功媒体。
- [ ] MEDIA-06 坏 MIME／hash／尺寸／容量／UUID changed-body 碰撞给出 actionable 错误，其他工作不丢。缺 existingEntryMedia capability 不发送兼容性错误上传。

## 8. 完整增量同步与 ACK

- [ ] DELTA-01 当前服务端真实 completeSnapshotDelta 广告；首次 Download full，后续实际 Update delta，无注入 flag。diagnostics 如缺字段单独记录，不能反推功能缺失。
- [ ] DELTA-02 Entry／Content／Tags／Facet layout／Author／Directory／Collection／ratings／membership／media 顺序变更精确匹配 full snapshot，包括未 journal 的派生 payload。
- [ ] DELTA-03 多页同步中 desktop 继续写，已冻结 target 不混版本；Unicode／surrogate、大 payload 正确。可用隔离代理记录请求证明真实路径。
- [ ] DELTA-04 server restart／session expiry／baseline eviction 的显式 unavailable 才 verified full fallback；drop／reorder／corrupt pages／scope mismatch 拒绝，不静默全量掩盖故障。
- [ ] DELTA-05 durable shared client UUID跨普通 Update／replay／冷启动不变，media mode none／thumbnails 精确，journal cursor 不当 snapshotSeq。
- [ ] DELTA-06 安装已持久并精确 readback 后才 ACK；ACK 拒绝／commit-response-loss 不提前删 Outbox／Blob，重启先重发原 pending ACK tuple。
- [ ] DELTA-07 真实两 browser tab／多实例 race：Clear、相同 generation/bytes 的 ABA、换 device identity、epoch replacement 与最新 enqueue，旧 install／ACK／settlement 不覆盖 peer 新状态。
- [ ] DELTA-08 quota／事务 abort 在安装与 pending ACK 过程中保留旧 history/pointer/operations/media。epoch 切换遇未同步工作拒绝并给出保留／导出行动。

## 9. pending-work 文件导出／原子恢复

- [ ] RESTORE-01 在真实 Android 下载导出 JSON，确认文件存在且完整；恢复入口 preview→明确确认，无自动网络 replay。含独立媒体、creation children 和所有操作类型。
- [ ] RESTORE-02 same client/library/epoch 的完整包恢复后 cold reopen，UUID、原 envelope／body hash、Blob bytes、upload preconditions／依赖次序不变。
- [ ] RESTORE-03 重复导入幂等；live identical 行的 status／attempt／receipt／lease 不重置，新 local 工作不被旧包覆盖。
- [ ] RESTORE-04 错 owner／wrong epoch／same ID different body、media hash/MIME 错、missing parent／missing preview predecessor、cycle／非法 Collection scope 一项不合法即全部零写。
- [ ] RESTORE-05 原始 creation parent 不完整的包 fail closed；file receipt／numeric ID／UUID 巧合不能补身份证明。用户需完整导出，不能承诺跨设备换 client 自动恢复。
- [ ] RESTORE-06 serialized 文件限制 96 MiB、decoded media aggregate 64 MiB；超限读取前拒绝并保持原 queue。真实 Android file picker／内存压力验证，避免把两个限制混写。
- [ ] RESTORE-07 媒体写入中途失败／quota、preview 后 peer 更改 queue／identity，单事务 rollback／明确冲突，原 queue 和 Blobs intact。

## 10. 原生有限后台任务（不是常驻服务）

- [ ] BG-01 实际 Capacitor plugin：普通 Entry／Producer／Directory／Collection 等所有当前允许操作的 durable enqueue 自动 handoff；媒体分块 seal/activate 后 WorkManager 接手，无后台 WebView eval依赖。
- [ ] BG-02 原生 ledger 初次／旧 v1–v5→v6 升级后 byte-exact originals、scope、计划、lease、result、progress／tombstone 保持；App 覆盖升级亦验证。
- [ ] BG-03 Wi-Fi 断开保持 queued；恢复家庭服务器可达后约束任务执行；两个连续 enqueue、正在 RUNNING 时新任务和重复 resume 不丢 successor、不堆无限 job。
- [ ] BG-04 重复 resume 最多一个待执行 successor；transient failure 使用同任务指数退避，冲突／授权／能力 held 不热循环，不误报 completed。
- [ ] BG-05 普通离开 App／划掉最近任务／可观察 OS kill：记录实际 Worker 是否继续、何时恢复和 ledger保留；不同厂商电池策略逐项写结果，不承诺无限后台存活。
- [ ] BG-06 Android force-stop 不能承诺继续运行；重新打开后恢复 durable work。设备重启且无 boot receiver 的行为同样实际记录，不能标作开机自启成功。
- [ ] BG-07 pinned TLS、fresh Vault、library/epoch、每种 required flag 在 worker 写前检查；撤销／换证／换 epoch 留存工作且不回退 HTTP。独立 owner 仍能继续，依赖／同 owner 后继暂停。
- [ ] BG-08 实际多类型与 create＋media、existing standalone media 的 committed-response-loss，cold native retry、前台 unchanged retry 只应用一次。
- [ ] BG-09 finite budget：standalone 和同 create 的多图循环到 deadline 后不再启动下一 PUT；完成进度保留，剩余 exact UUID retry，不能留下活 lease 阻碍恢复。
- [ ] BG-10 cancel 先 pause native，再 canonical discard；未 sealed capture 的 late chunk／seal 拒绝并清私有 part 文件。新 generation 不被旧 seal／result 覆盖，active lease 下取消明确拒绝且原工作保留。
- [ ] BG-11 Settings 的 scheduled／dependency-held／capability-held／foreground-only／oversize 状态和 counts 对应真实 native 状态；超过 bridge 20 MiB 的工作给前台 fallback，不能声称已排队。
- [ ] BG-12 没有 boot、常驻 foreground service、notification、storage／定位／Accessibility 新权限；相机权限仅实际 QR scanner。OS 约束延迟不能丢已持久工作。

## 11. 冲突、版本降级与并发

- [ ] SAFE-01 same field desktop peer update→visible conflict，different field merge；membership 已 desired state 幂等；rating版本冲突不能 silent overwrite。
- [ ] SAFE-02 failed/conflict 显式 discard 与依赖链处理正确，独立 Entry 不连带丢工作。现有细粒度保留本地／重新基线 UI 未作为已完成能力宣称。
- [ ] SAFE-03 same opId/uploadUUID same body 返回原 receipt；different body拒绝；like/view、Content、Author/Tag origins不会重复。
- [ ] SAFE-04 wrong library、backup restore rotated epoch、旧 schema／protocol／feature flag 缺失与下降均零不兼容写入，保留／导出原工作。
- [ ] SAFE-05 不可信／额外字段或错 opId 的 native receipt 不放行后继；raw JSON 留存不构成 canonical 清理证明。
- [ ] SAFE-06 真实 browser 多 tab enqueue／covered snapshot cleanup 的两种顺序；没有 orphan、丢 parent／child、偷删 peer generation。该项与 Android 单 WebView 行为分开报告。

## 12. 容量、隐私与不在本次交付的边界

- [ ] PRIV-01 actual storage estimate 与 persist() granted/denied 明确，存储压力不会自动删 Outbox/Blob；敏感信息不进入日志／QR／外链／第三方 analytics。
- [ ] PRIV-02 Android backup／device transfer 禁用行为和覆盖升级验证；换手机不可把 same-client pending-work restore 当自动迁移保证。
- [ ] PRIV-03 destructive subject/Collection delete、merge、taxonomy/templates、Import／Source-maintenance batch、新 Gallery/type 与已有媒体 replacement 保持 online-only，普通通用 queue 不误收。
- [ ] PRIV-04 可选纯浏览器 PWA 若另行交付，单独验证可信 HTTPS origin、SW install/update/rollback、offline cold start、mutations不由SW replay；不把 native APK 验收当作 PWA 通过。
- [ ] PRIV-05 整库 backup 的 DB＋assets crash/power-loss 原子恢复若需产品保证，另做隔离平台故障测试；不要与 pending-work 单 IDB 事务恢复混称。

## 13. 一次集中跑完的主序列

1. 确认新版同签名候选与隔离匹配 server → 真 QR 配对 → API／WebView 媒体 → Download。
2. 真断网＋停 server → force-stop → cold launch → 浏览／搜索／缓存媒体。
3. 离线编辑 existing Entry／Author／Directory／Collection；create A/B，修改 children、新 Author／Tag／Facet及跨 Entry复用；stage创建媒体＋已有 Entry独立媒体。
4. Export→校验→same-client restore preview／confirm→cold reopen；注入非法包／quota独立检查。
5. 恢复连接，同时 desktop 制造一个同字段 conflict；后台任务与前台同步；观察实际 delta／typed receipts／ACK与完整依赖链。
6. 中断 upload／replay／ACK 响应，kill／重新打开／server restart，验证只一份数据、原 IDs／bytes、最终 cleanup。
7. 单独跑授权撤销／换证／换 epoch／能力下降、WorkManager deadline／取消、真实多 tab和storage压力。
8. 所有 pending 工作settled后 Clear，离线再启动不见旧库；记录未能执行项并保留 UNVERIFIED。

## 14. 结果记录模板

| Case ID | Result (UNVERIFIED/PASS/FAIL/BLOCKED) | APK SHA/version + server source | Device/Android/WebView | Library/epoch (no secrets) | Steps/evidence/failure |
|---|---|---|---|---|---|
|  | UNVERIFIED |  |  |  |  |

仅当前构建实际设备证据可将对应项勾选。源码／自动化完成、源码窄审、APK完整性和真实App验收为不同状态。原计划功能差距见 `offline-completion-status.md`，不得将 online-only 扩展误算为原方案未完成。
