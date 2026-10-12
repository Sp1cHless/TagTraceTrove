# App 在线模式「界面跳转 / 延迟 / 回来像重载」总览研究与修复（v46）

用户报告（在线模式）：
1. 点进 entry、或从 entry 退出，界面不是直接切换：**先看到 Home，再跳进 entry**；刚打开 entry 时有零点几秒可见延迟，tag 与信息**一个个**出现。
2. 只要切出 App（比如跳到浏览器），回来时**像重新加载**：回到 Home，并且能看到 offline 模式一闪而过。

本轮先说结论：**症状 1 的根因在原生传输层，已定位并修复（v46）**；**症状 2 目前只能缩小到「Android 后台回收 WebView 渲染进程 ⇒ 冷启动」这一种解释，还需要设备复测确认**。

## 一、测量手段

- 代码级：逐条读 `spikes/001-android-webview-shell/android/app/src/main/java/.../PinnedLanTransport.java`、`PairedTransportPlugin.java`、`PairingVault.java`、`PairingState.java`、`MainActivity.java` 与 web 侧的 `GalleryApp.vue` 导航/加载路径。
- 桌面侧实测（分离「服务器/LAN 慢」还是「手机客户端慢」）：`/api/sync/capabilities` 在桌面本机 API（8765）上**200 且只用 5.2ms**；对配对 TLS 监听器（8766，局域网另一地址）**全新连接 + TLS 握手 + 取响应 7.7–11ms**、**复用连接 0.24ms**（未带 token 时返回 401，仍走了完整 TLS 与一个往返）。也就是说服务器与局域网本身极快。
- 上一批真机数据（v45，adb + WebView CDP）：一张缩略图的 JS 抓取实测 **143–413ms**；v40 曾实测同类串行问题：**同一次打开 entry，无探针 313ms，探针卡住时 7674ms**。
- 本轮 USB 掉线，未能在设备上重跑上述探针（见第五节）。

## 二、根因（症状 1）

一次「读」在手机上的真实成本，是四笔叠加、且全部排在同一条线程上：

1. **每个请求都多做一次服务器往返。** `PairingState.verify()` 自己就是一次 `GET /api/sync/capabilities`（`PairingState.java`），而它在**每一个**请求前都被调用：插件里一次（`request`）、WebView 子资源拦截器里再一次（`MainActivity.shouldInterceptRequest`，也就是**每一张图片**）。于是「取一张图」= 2 次服务器往返。
2. **每个请求都重新解密一次配对凭据。** `PairingVault.load()` 每次都要 `AndroidKeyStore.load(null)` → `getKey` → AES-GCM 解密（Android Keystore 是硬件/绑定的往返），而它在插件与拦截器里各来一遍。
3. **每个请求都新建一个 HTTP 客户端和一份 SSLContext。** 原 `PinnedLanTransport.request()` 在方法体内 `new OkHttpClient.Builder()...build()` 且 `SSLContext.getInstance("TLS")` + `init()`：连接无法复用 ⇒ 每张图都重做一次 TCP+TLS 握手，并各自创建一套 dispatcher/连接池线程。
4. **所有请求共用一条单线程。** `PairedTransportPlugin` 只有一个 `Executors.newSingleThreadExecutor()`。媒体预载（v45 修复后约 2.5 张/秒）持续占用这条线程，界面自己的请求只能排队 —— 这正是用户要求修的「下载变快之后界面反而卡」的机制：以前预载慢（1.6 张/分钟），争用很少；现在预载快了 90 倍，争用变成常态。

界面侧的放大器（本身不是 bug，但让延迟可见）：`openEntry()` 先 `await` 三个接口（`getEntry` + `listCollections` + `listCollectionsForEntry`）才 `activeEntry = detail`，而 `isHomeView` 的定义就是 `activeEntry === null` ⇒ **数据到达前，界面在语义上就是 Home**。延迟一放大，用户就看到「先 Home，再 entry」；明细的次级请求（如媒体移除阻断原因）后到，于是「一个个出现」。

> 桌面量出的 7–11ms 与手机量出的 143–413ms 之间的差额，全部落在上面 1–4 这笔客户端成本里，而不是网络或服务端。

## 三、修复（v46 `0.0.46-c3-transport-latency`，全部在原生层；web 无改动）

1. **凭据缓存**：`PairingVault.load()` 按存储中的密文缓存已解密状态；重配对/清除会写新的（或不写）密文，本进程与其他进程都以密文变化为失效条件。
2. **去掉读路径上重复的身份往返**：读请求只带 token（服务端才是权威，设备被撤销时该请求本身会拿到 401，应用照旧走未授权分支）；**写请求仍然先做严格确认**。`verify()` 改为**独占一条新连接**（池化连接会让「服务端已换证书」逃过握手时的 pin 校验）。
3. **连接与 SSLContext 复用**：读请求用池化客户端（并允许对「服务端已关闭的空闲连接」透明重试一次，避免偶发 SocketException 直接变成界面报错）；写请求用**不池化、不重试**的客户端 —— 保留原来的严格语义，并让每次写都重新校验当前证书。
4. **读请求独立通道**：读走 4 线程池；写仍走原来的串行单线程，顺序不变。

预期（设备到手即可量）：单次读从约 250–700ms（Keystore 解密 + 双往返 + 新连接 + 排队）降到约 10–30ms；`openEntry` 的三个请求并发且不再排在媒体之后，因此「先 Home 再 entry」与「字段一个个出现」应当消失，长列表/切页的抖动也随之消失。

## 四、症状 2：切出再回来像重载

已排除的路径（读码结论）：

- web 侧只有一处 `location.reload()`：原生壳退役旧 PWA Service Worker 时的一次性重载，且带 sessionStorage 守卫（每个 WebView 生命周期最多一次）。
- 原生侧没有「恢复时重载已渲染页面」的逻辑：`onResume` 的 8 秒看门狗只在 WebView URL 为 `null`/`about:blank`（空白文档）时补载，并且只在未配对时弹原生配对框；另一处 `reload()` 发生在配对成功之后。
- 因此「回来 = 冷启动」最可能来自 **Android 在后台回收了 WebView 渲染进程或 Activity**：回来时重新加载页面 ⇒ 重新走启动路径 ⇒ 先 Home、再偏好离线快照（offline 一闪）、再探针转在线。每个请求新建客户端/线程池、以及每次请求的 Keystore 往返，都会放大内存与 GC 压力，本次修复顺带减轻这一项，但它**不是**对症状 2 的证明。

待设备复测（计划）：
1. 在页面里埋 `performance.timeOrigin` 记号，切出→回来，记号变化 = 真的重载过（可分辨「重载」与「只是离线横幅闪一下」）。
2. 若确实重载：`dumpsys meminfo <pkg>` 看内存水位、`adb logcat` 找 Activity 重建/低内存记录。
3. 只有在确认是重载之后，才考虑加「恢复上次视图」（把当前视图写进 sessionStorage，启动时恢复），避免为一个还没证实的行为改动界面语义。

探针脚本已固化在 `spikes/001-android-webview-shell/device-probes/`（`entry-open.mjs` 量打开 entry 的耗时，`rate.mjs` 量下载速率，`cdp.mjs` 是通用通道；README 写了重装后必须重新 `adb forward` 的坑）。

## 五、边界与未做

- 未改 web 的导航/渲染模型（`openEntry` 的「先请求后切换」保持原样），因为延迟修复后它不再可见；若复测仍觉得「先 Home」，再单独讨论是否加立即切换的骨架态。
- 未改媒体预载策略、离线/同步面、服务端；未触碰正式库与 assets。
- 版本：v46 候选 `T3-v46-transport-latency.apk`，debug 签名与 v43/v44/v45 相同，可覆盖安装（保留离线副本、待同步编辑与媒体缓存）。

## 六、装机实测（v46，正式库、媒体已下完）

装机后（`T3-v46-transport-latency.apk`，SHA256 `1e3360cc…`，装机后 `adb pull` 出来的 base.apk 与本地逐字节一致）在同一台手机上量的：

| 测项 | 修复前 | 修复后 |
|---|---|---|
| 打开 entry（首页最近卡片 → 详情出现） | 581ms | **129 / 213 / 132ms** |
| 打开 entry，且后台有媒体抓取在跑 | 574ms | **100 / 140ms** |
| 从详情返回首页 | 280–409ms | 190–260ms |
| `openEntry` 三个请求的发出时刻 | 第 3 个在 **301.9ms** 才发出 | 三个都在 **6.7ms** 内发出 |
| 单次请求稳态耗时（warm） | — | **11–16ms**（`status` 4ms） |
| 首个请求（新连接+TLS 握手） | 每次请求都付 ~200–300ms | 每个连接池只付一次 ~100ms |

两个结论：
1. **原生四处修复**把「每个请求都付一次握手与一次额外往返」变成「每个连接池一次握手、之后 11–16ms」，所以媒体下载与所有读都快了；但**它没有单独把打开 entry 变快**（装完仍是 581ms）——因为那 581ms 的主因是下一条。
2. **真正的主因是每次读都重新做一遍整份快照投影**：`readActiveSnapshot` → `snapshotState` 会对整个 8.85MB 快照跑一次 zod 校验（手机上约 200–300ms，`JSON.parse` 本身只要 35ms），而它被 **65 处**调用，且 `getEntry` 在发网络请求**之前**先做它 ⇒ 请求被推迟 301.9ms。按「revision + activeGeneration 指针」缓存投影后（两个极小的 meta 读作键，任何快照写入都会移动其中之一），三个请求 6.7ms 内并发发出，打开 entry 降到 100–200ms（余下主要是 Vue 渲染详情，属正常 UI 成本）。

**症状 2：三种场景都没有复现重载。** 在页面里留记号（`performance.timeOrigin` + 当前视图）后分别做了：① HOME 键后台 25 秒；② 真的切到浏览器（`am start -a VIEW https://example.com`）45 秒；③ 在 240 张图的媒体抓取压力下后台 30 秒。三次回来都是**同一个进程、同一个 `timeOrigin`、仍停在原来的 entry 上**——即没有重载、视图也没丢。因此症状 2 要么已被本轮的改动（请求/内存开销大幅下降）消除，要么触发条件是当时「正在下载 1.3 万张图」时的内存压力（现在下载已完成，无法复现）。**没有**加「恢复上次视图」，因为实测显示视图本来就没丢；探针已固化在 `device-probes/`，一旦再出现就能立刻抓到是不是重载。
