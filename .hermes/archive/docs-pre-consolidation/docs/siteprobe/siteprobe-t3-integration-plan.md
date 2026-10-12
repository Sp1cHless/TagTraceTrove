# SiteProbe × T³ 集成实施计划（正式匹配）

> 这份文件就是架构指导 §17 点名缺的那一份：**transport 与 T³ 侧接入的 integration
> implementation plan**。它不重述「计划」与「记录」，只回答一件事：
> **让 siteprobe 成为 T³ 的一个正式功能，两侧各要改什么、先改哪个、拿什么验。**
>
> 定位：`siteprobe-completion-plan.md` 说做什么（已收束）→ `siteprobe-execution-log.md`
> 说做成了什么（截至 2026-09-21）→ **本文件说怎么接进 T³**。
>
> 术语：「匹配」在本文里只有两个含义 ——
> **(A) 输入 → 谁认领它**（`resolve_input`：哪个站、哪种 target kind、ref 是什么）；
> **(B) 一次运行 → 哪个导出目录 → 哪一批 entry**（selection / export → `ImportBatch` → commit）。

> **状态（2026-09-22）：Phase A/B/C 已完成，链路已打通到导入区面板。** 工具侧有了机器接口
> （`integration.py`：`sites`/`resolve`/`run`/`selection`，JSON-lines + 退出码 + 错误 code），
> T³ 侧有了通道（`apps/server/src/siteprobe/`：spawn + 逐行校验 + 运行登记表 + selection 监视）
> 与 `preview-path`/`commit-path`，前端有了最小可用面板（菜单来自注册表，运行时显示事件日志，
> 结束后把导出交给现有预览界面）。**真链路实测**：一次真实的单作品抓取 12 秒落地，导出能被
> `preview-path` 读成 1 条 entry / 13 个 tag。详见执行记录「集成：链路打通」。
> **C2 已完成（2026-09-24）**：review 页通过当前 T³ 同源 HTTP 服务回传选择，服务校验 run 与 review 文件归属后保留 run ID；点击 Export 不再需要保存对话框或手工上传。普通 `file://` 打开仍保留旧的保存/下载路径。真浏览器手动验收仍待用户设备验证。
> **未做**：D4（用户搁置）、Phase F；
> **未验**：真浏览器完整 review → direct selection return → 只下载所选往返（§8.3 门）。
> 本轮还量出并修掉了四个只在真链路上现形的缺陷（无自己的 schema 的站点整批导不进、argv 少了
> 入口脚本、导出路径多一层 `export`、eslint 扫到 venv 与 Chrome profile），以及三条同族的能力/
> 身份解析错误（`reader_for`、`site_identity`、`runner.resolve` 用 `get` 而非 `get_for`）。

---

## 0. 结论先行

1. **两侧都还没接。** T³ 侧今天只有「把一个导出文件夹拖进来」这条路：两个路由、
   零子进程、零设置项、零剪贴板。工具侧今天只有「给人看的 CLI」：注册表可查但没有
   机器可读出口，review 交接靠浏览器保存对话框 + 人手拖。
2. **要做的第一件事不是 UI，是给工具加一个机器接口**（`--json` 的 JSON-lines 契约：
   `sites` / `resolve` / `run` / `selection`）。没有它，UI 里每一个下拉框都只能靠
   T³ 自己硬编码站点名单，而架构指导 §33 明确「Core 不得包含站点名单」。
> **状态（2026-09-21）：已归位。** home 现在是 `apps/server/.data/siteprobe`，仓库根有 `siteprobe.json`，`builtin` 移到仓库；搬移 412 MB、逐项核对条目数、`22/22` 门通过。见 `siteprobe-execution-log.md` 的「数据根归位与 7 条缺陷」。

3. **数据根当时是错的**：工具的 home 实测在 `<repo>/.data/siteprobe`，而 T³ 的用户数据
   在 `<repo>/apps/server/.data`（`T3.bat:71` 把 cwd 切到 `apps/server`）。指导 §34 要求
   两者是同一个根。**这是 §6 的第一件事，必须你点头**，因为它要搬现有的适配器目录。
4. **不改数据库 schema。** `site_works` / `site_crawl_sources`（migration 021）已经够用，
   commit 那一层不用动，所以本计划**不含任何 migration**。
5. **四件事需要你定**（§11）：数据根归位、review 交接形式、transport 形态、剪贴板归属。
   我的建议都写了，其余按建议走。

---

## 1. 边界（这次集成不许越过的线）

| 来源 | 约束 |
|---|---|
| 指导 §16.1 | T³ 负责：library、DB、entry lifecycle、taxonomy、collections、import transaction、去重的最终业务规则、**主 UI**、**clipboard 等 app-level 功能**、adapter 管理入口 |
| 指导 §16.2 | SiteProbe 负责：**URL/domain detection、adapter matching**、抓取、Builder、listing/search、review、selection、媒体、export、抓取侧状态 |
| 指导 §17 | SiteProbe **不直接控制 T³ DB**；唯一入口是 `标准输出 → T³ import/commit` |
| 指导 §28 Step 6 | transport / Import UI / Clipboard / Batch import / DB commit —— 就是这份计划的范围 |
| 指导 §33 | Core 不得包含站点名单；菜单、类型选项一律由注册表生成 |
| 指导 §34 | 可写运行数据在 `<T3_DATA_DIR>/siteprobe/`；builtin adapter 是随包发布的只读代码，放仓库 `siteprobe/adapters/builtin/` |
| 交接 §1.2 / §1.3 | 目标链路（导入区选工具→选类型→输入→可选手动筛选→batch import）与剪贴板场景 |
| 交接 §1.4 | **本轮不做**：未匹配到工具的网址怎么办 |
| AGENTS.md | 不引入数据库平台特性；不在正常 UI 里出现数据库术语；provider 匹配必须由用户发起；常见操作避免弹窗 |

一句话：**匹配（A）在工具侧，展示与确认（B）在 T³ 侧；两侧之间只有 JSON 与文件。**

---

## 2. 实测现状（接缝逐条量过）

以下全部是本次读代码 / 跑命令量到的，不是判断。

### 2.1 工具侧

> **状态（2026-09-21）：第 8、9 两行已作废。** home 已归位到 `apps/server/.data/siteprobe`（§6），
> `adapter_root()` 现在的实测值是 `D:\Project\TagTraceTrove\apps\server\.data\siteprobe`；
> `--list-sites` 也不再隐藏第二份适配器的 kind（d7）。其余各行仍是现状。逐条证据见执行记录。

| # | 事实 | 证据 |
|---|---|---|
| 1 | 注册表**可查、无出口**：`resolve_input`、`site_for_url`、`dump_sites` 都是干净 callable，但 `dump_sites()` **没有任何调用者**，`--list-sites` 打的是给人看的表格 | `registry.py:198,228,355`；`cli.py:69-85` |
| 2 | `probe.py` 的 stdout 是标签文本，唯一的机器可读值是**两行内嵌 JSON**（`origin`、`media`） | `cli.py:109-121` |
| 3 | 全工具唯一的 JSON-lines 契约是 `fetch_work_meta.py`，而它**故意绕开注册表**（回答的是"没有规则能读到什么"），且永远 exit 0 | `fetch_work_meta.py:1-10,31`；`show_link.py:41-53` 是另一个 4 值退出码契约 |
| 4 | **review 交接是 `file://` + 保存对话框 + 人手拖**：页面导出走 `showSaveFilePicker`，没有目录参数；工具**从不自动打开** review 页 | `review.py:374-411`、`runner.py:171-175` |
| 5 | 但**本地服务这条路已经走通过两次**：Builder 的标注页与卡片选择页都是 loopback + `port=0` + token + `POST /api/...` + `threading.Event` 解阻塞 | `session_server.py:196-223`、`:314-418` |
| 6 | Builder 入口是**交互阻塞**的（无限等标注提交 / 等点卡片），且 `build_adapter` 每次都会 `webbrowser.open` | `session_server.py:216-219`、`build_adapter.py:86` |
| 7 | **没有 `--json` / `--quiet` / 结构化错误**；错误是 `[ERROR] {句子}`，且几个入口把错误打在 **stdout** | `cli.py:106`、`build_listing.py:152,167,173`、`check_adapter.py:42` |
| 8 | home 只有一个 env 开关 `SITEPROBE_HOME`；本机实测 `adapter_root()` = `D:\Project\TagTraceTrove\.data\siteprobe`，`PROJECT_ROOT`（导出根）= 该目录下 `export/` | `registry.py:40-72,51`；`runner.py:26-30` |
| 9 | 实测 `--list-sites`：10 个站；其中三站**各有两份适配器**，而列表只打 `local` 的 kind，`installed` 的三类 kind 看不见 | 见 §7 债务 6 |

### 2.2 工具侧的实测缺陷（会直接咬集成）

> **状态（2026-09-21）：d1–d5、d7 已修，d6 按建议只记录。** 逐条证据与修法见执行记录。

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| d1 | `LEARNED_ROOT = <tool>/tool/learned`，而 `<tool>/tool` **不存在**；`registry.tool_roots()` 也不会扫它 | `build_adapter.py:34`、`build_listing.py:47`、`verify_adapter.py:25`；`registry.py:75-91` | Builder 生成的适配器**装到一个没人读的地方**；`_adapter_beside` 恒为 `None`，那句"这个站已有手写适配器"的警告永不触发 |
| d2 | `annotate.SESSIONS = <tool>/builder_sessions` | `annotate.py:35` | 与 `sessions/`（home 下）**两套会话目录**并存 |
| d3 | `refresh_review.py` 默认目录是 `<tool>/export` | `refresh_review.py:20,93` | 默认值指向一个空目录，重写 review 页要多传一个参数 |
| d4 | `local/18comic_vip` 的 `search` 目标 `url_pattern` **没有捕获组**，而 `TargetRule.match` 在无命名组、无捕获组时返回 `None` | `.data/siteprobe/local/18comic_vip/site.json`；`template.py:41-58` | 该 target **永远匹配不上**：`probe.py --site 18comic.vip <搜索URL>` 报错，加 `--kind search` 会产出垃圾 `ref`，只有不带 `--site` 时才悄悄走 `installed/comic18` |
| d5 | `site_for_url` 与 `resolve_input` 对同三站给出**不同适配器**：前者给 registry 优先（listing-only 的 `local`，`work.fields: []`），后者给声明了该 target 的（`installed`） | `registry.py:145-162,198-203,228-274` | 任何"先问站点再跑"的调用都会拿到**读不了作品页**的那一份 |
| d6 | `adapter.json` **只写不读**，本机**一个都不存在**；`capabilities` 只是字段名集合，没有词汇表、没有消费者 | `roundtrip.py:325-332`；全仓 `capabilit` 仅 3 处命中 | 指导 §19 的 capability 驱动 UI 现在**没有数据来源**，只能用 `targets[kind]` 顶替（见 §4.1） |
| d7 | `--list-sites` 对三站只显示 `local` 的 kind | 实测输出 | 人看到的是"18comic 只能搜"，而它能读专辑和收藏夹 |

处置见 §7：d1–d3 是收尾（Phase A 顺手），d4 是**真 bug**（Phase A 必修），d5/d6/d7 是
Phase A 的契约设计输入。

### 2.3 T³ 侧

| # | 事实 | 证据 |
|---|---|---|
| 1 | 导入只有一条路：拖文件夹 / 选文件夹，前端只留 `*.json` 且必须有一个根 `metadata.json` | `AddEntryPage.vue:928-935`；`gallery.ts:566-587` |
| 2 | 只有两个路由：`POST /api/imports/site-probe/preview`（multipart 上传 → 临时目录 → `loadSiteProbeExport`）与 `POST /api/imports/commit` | `app.ts:477-490`；`upload-preview.ts:37-72` |
| 3 | **全仓库没有任何子进程调用**（唯一 `spawn` 是启动器开浏览器） | `server-cli.ts:39`；`apps/`、`packages/` 内无 `execFile`/`spawnSync` |
| 4 | **没有任何 siteprobe home / 工具目录设置**；env 面只有 `T3_PORT/HOST/DATA_DIR/DB_NAME/LOG_LEVEL/ENABLE_LAN/STATIC_ROOT/OPEN_BROWSER` | `server-cli.ts:18-28`；`.env.example` |
| 5 | 用户数据实测在 `<repo>/apps/server/.data`（`library.db`、`assets/`、`backups/` 都在那），而工具 home 在 `<repo>/.data/siteprobe` —— **两个 `.data`** | `T3.bat:71`；`server-cli.ts:18-21`；指导 §34 要求同一个根 |
| 6 | 导入的 batch 由**服务端**产出（preview 返回 batch，前端原样回传 commit），所以 `origin` 在往返里应当活着；但**没有一道测这条往返**（现有测试直调 `commitImportBatch`） | `AddEntryPage.vue:605-618`；`site-crawl-state.integration.test.ts:4` |
| 7 | 中性 contract 已在（试在最后、且只接没有自己 schema 的站），但**只有单品形态**，没有中性 batch | `site-probe.ts:123-136,490-501` |
| 8 | 剪贴板只有一处**写**（复制诊断信息），没有读、没有监视 | `GalleryApp.vue:151` |
| 9 | 没有路由表文件，所有路由都在 `app.ts` 一个文件里 | `apps/server/src/routes/` 只有 `.gitkeep` |
| 10 | 前端没有 router，页面切换靠 `creationView` 这个 ref | `GalleryApp.vue:2758-2807` |

---

## 3. 目标链路（用户视角的一条路）

交接 §1.2 的链路，落成谁在什么时候做什么：

```text
[用户] 导入区 → 「从网站获取」
[UI]   工具（=站点）下拉 ← GET /api/siteprobe/sites   （菜单由注册表生成，core 无站点名单）
[UI]   对象类型下拉（album/favorite/search/artist/playlist/work/single）
         ← 该站 targets 的 kind 列表；label 与「输入名称/输入网址」也来自同一份数据
[UI]   输入框（网址或名字）+ 勾选「手动筛选」
[T³]   POST /api/siteprobe/runs  → 起一个子进程
         无手动筛选： run → 直接产出导出清单
         有手动筛选： run --review → 产出 review.html + cards.json + review_media/
[UI]   进度（JSON-lines 事件转发的 Phase/计数）+ 取消按钮
[用户] 手动筛选：打开 review 页 → 挑 → 保存 selection
[T³]   拿到 selection（形式见 §11-D2）→ 起第二个子进程：selection → 只下载选中的 → 导出
[T³]   POST /api/imports/site-probe/preview-path（服务端本地路径，不再上传文件）
[UI]   预览（现有的 commit 预览界面，一行不改）
[T³]   POST /api/imports/commit（batch 带 origin → migration 021 的游标在这一步推进）
```

剪贴板场景（交接 §1.3）：

```text
[UI] 窗口获得焦点 → 读剪贴板（首次需授权）→ 是 http(s) URL？
[T³] POST /api/siteprobe/resolve → { matched, site, kind, ref } | { matched:false, reason }
     命中 → 一条不打断的提示条：「要创建这个网址的作品吗？」→ 点开即进上面的流程（预填）
     未命中 → 本轮不处理（交接 §1.4 已押后）
```

三个设计约束直接来自上表：**菜单不能硬编码**（§1 指导 §33）、**T³ 不解析任何站点规则**
（指导 §16.3）、**常见动作不弹窗**（AGENTS.md）。

---

## 4. 要先建的东西：工具侧的机器接口

### 4.1 为什么是它，而不是先做 UI

1. 没有 `sites`/`resolve` 出口，T³ 只能自己维护站点名单 —— 指导 §33 禁止；
2. 没有结构化进度，UI 只能转述人类日志；
3. 没有稳定退出码/错误对象，UI 只能把句子当分类用（`build_listing` 还把错误打 stdout）；
4. 指导 §19 的 capability 驱动 UI **现在没有数据来源**（d6）：`adapter.json` 只写不读。
   本轮**用 `targets[kind]` 顶替**它（`single`、`accepts_name`、`label` 已足够支撑 §1.2 的三档
   选项），capability 词汇表留到 adapter contract 冻结那一步，别现在造一个没有读者的键。

因此：**不新增 `capabilities`，不新增 `adapter.json` 读者；先把注册表的事实暴露成 JSON。**

### 4.2 新增模块与命令

新文件 `siteprobe/src/generic/integration.py`（**人类 CLI 一行不改**，只在 `probe.py` 旁边加
两个入口脚本 `siteprobe_json.py` 或 `python -m src.generic.integration`）：

```text
integration sites   [--json]              # 注册表快照（含两份适配器的关系）
integration resolve [--json] <input> [--site K] [--kind K]
integration run     [--json] <input> [--site K] [--kind K] [--review] [--limit N] [--refresh]
integration selection [--json] <selection.json>
```

一律 **JSON-lines 到 stdout**（一行一个对象，便于流式读取），人类日志走 stderr。

```jsonc
// sites
{"event":"sites","sites":[
  {"key":"18comic.vip","display_name":"18comic.vip","export_group":"18comic.vip",
   "source":"installed","sources":["installed","local"],
   "targets":[{"kind":"album","label":"Album","single":true,"accepts_name":false},
              {"kind":"favorite","label":"Favorite","single":false,"accepts_name":false},
              {"kind":"search","label":"Search","single":false,"accepts_name":true}]}]}

// resolve —— matched:false 也是成功回答，不是错误
{"event":"resolve","matched":true,"site":"18comic.vip","kind":"album","ref":{"id":"1472965"}}
{"event":"resolve","matched":false,"reason":"no-site","input":"https://example.com/x",
 "known":["18comic.vip","hanime1.me","hitomi.la", "..."]}
{"event":"resolve","matched":false,"reason":"ambiguous","candidates":[{"site":"a","kind":"search"}]}

// run / selection —— 事件流，最后一定是 result 或 error
{"event":"progress","phase":"scan","message":"listing page 3","count":80}
{"event":"review","path":"...\\export\\18comic_vip\\search_x\\review.html","url":"http://127.0.0.1:PORT/?token=..."}
{"event":"result","site":"18comic.vip","kind":"search","ref":"x","works":218,
 "listing":"...\\export\\18comic_vip\\search_x","export":"...\\search_x\\metadata.json",
 "origin":{"kind":"search","ref":"x"},"media":{"cover":218,"previews":0,"failed":0},"warnings":[]}
{"event":"error","code":"NO_MATCH|UNKNOWN_KIND|NETWORK|BLOCKED|NEEDS_LOGIN|INTERNAL","message":"..."}
```

要点：

* **`export` 是给 T³ 的唯一入参**：T³ 拿到它就走现有的 `loadSiteProbeExport`，
  不需要知道任何站点知识（`metadata.json` 的形态仍由各站 `site.json` 的 `manifest` 决定）。
* `resolve` 必须**修掉 d4/d5**：按「声明了该 target 的适配器」回答，并把
  `source`（`installed`/`local`/…）一起给出来，让"两份适配器"这件事在 UI 上可解释。
* 退出码：`0` 成功、`2` 输入/匹配类失败、`1` 运行类失败；**错误也以 `error` 事件出现**，
  这样父进程不必解析句子（现在的 `[ERROR]` 前缀保留给人类）。
* 取消：父进程直接杀子进程（工具无共享状态、导出是逐文件写的，`metadata.json` 最后写，
  半途被杀只会留下一次可被下次运行裁剪的导出，符合「游标属于抓取」的现有设计）。

### 4.3 review 页的交接（形式待定，见 §11-D2）

现状是 `file://` + 保存对话框 + 人手拖（`review.py:374-411`）。两个可选做法：

| 方案 | 改动 | 代价 | 体验 |
|---|---|---|---|
| **C1 监视目录** | 零（工具不变）；T³ 在运行期轮询 `<listing>/selection_*.json` | 用户仍要在保存对话框里选对目录 | 一次手动选择；符合交接 §1.2「手动筛选保存的 selection 也会被读取到」 |
| **C2 回传服务** | `--review` 时工具起一个 loopback 服务（复用 `session_server` 的 token 模式），页面 `POST /api/selection`，工具**直接写进 `<listing>/`** | 改 `review.py` 的导出分支 + 一个 handler | 点击导出即回传，无对话框、无拖拽 |

**建议：C1 先做（它同时覆盖"用户自己保存的 selection"这个已写进需求的场景），C2 在 C1
跑通后作为收尾**——因为 C2 是"改一个已经工作的页面"，风险与收益都集中在体感上。

---

## 5. T³ 侧改动

### 5.1 服务端

新增 `apps/server/src/siteprobe/`：

| 文件 | 职责 |
|---|---|
| `home.ts` | 解析 SiteProbe home：`SITEPROBE_HOME` → `<T3_DATA_DIR>/siteprobe`；解析解释器：`<home>/../..`… 见下 |
| `transport.ts` | 起子进程、按行读 JSON-lines、超时、杀进程；**不解析人类日志** |
| `jobs.ts` | 运行登记表（内存，单进程）：id / 状态 / 事件环形缓冲 / 取消 |
| `review-watch.ts` | C1：轮询 `<listing>/selection_*.json`（只在运行登记表里有活动运行时） |

解释器发现（必须明确，因为工具自带 venv）：
`SITEPROBE_PYTHON`（env，可覆盖）→ `<repo>/siteprobe/.venv/Scripts/python.exe`（Windows）
→ `<repo>/siteprobe/.venv/bin/python`（其它）→ 都不在则**明确报错**："先在 siteprobe/ 跑一次
`uv sync`"（不要悄悄退化成系统 python，那会缺 `curl_cffi`/`playwright`/`Pillow`）。

新增路由（都挂在 `/api/siteprobe/` 前缀下，风格与现有 `app.ts` 一致）：

```text
GET  /api/siteprobe/status        → { home, python, ok, detail }        （给设置/排障用）
GET  /api/siteprobe/sites         → integration sites 的透传
POST /api/siteprobe/resolve       → { input } → resolve 事件
POST /api/siteprobe/runs          → { input, site?, kind?, review?, limit?, refresh? } → { id }
GET  /api/siteprobe/runs/:id      → { status, events[], selection?, error? } （轮询；若要 SSE 也在这里）
POST /api/siteprobe/runs/:id/cancel
POST /api/imports/site-probe/preview-path   → { metadataPath } → SiteProbeUploadPreview
```

`preview-path` 的约束（安全边界，必须写进测试）：
路径必须是**绝对路径**，且 resolve 后落在 `<home>/export/` 之内（复用 `resolveLocalPath` 的
"逃逸就报错"写法）；**不接受客户端的相对路径**。它复用 `loadSiteProbeExport`，
`preserveRelativeMediaPaths` 换成 `false`（媒体在服务端本地，commit 时需要真实路径）。

> 现有 `preview`（上传）**保留不动**：手动拖文件夹那条路仍然合法，且它是没有 siteprobe
> venv 时的唯一通路。

### 5.2 前端

`AddEntryPage.vue` 里加一块「从网站获取」面板（与现有 dropzone 并列，不替换）：

* 工具下拉 ← `GET /sites`；类型下拉 ← 所选站的 `targets`（`label` 直接显示，
  `accepts_name` 决定输入框提示「网址 / 名字」，`single` 决定"手动筛选"是否可勾）；
* 「手动筛选」勾选框 → 传 `review: true`；
* 运行中：进度条用 `progress` 事件的 `phase`/`count`，一个可展开的原始日志抽屉；
* `review` 事件到达 → 显示「打开筛选页面」（`<a target="_blank">`，本机 loopback）；
* 运行结束 → 若有 selection → 起 selection 运行 → 结束后自动调 `preview-path`，
  **落到现有的预览/commit 界面**（那一屏一个字都不改）；
* 无匹配（`resolve` 返回 `matched:false`）→ 一行提示，不弹窗（AGENTS.md：常见动作不弹窗）。

剪贴板（§11-D4）：`window` 的 `focus` 事件里读一次 `navigator.clipboard.readText()`
（localhost 是安全上下文，可行；首次会要授权，拒绝后本会话不再问），是 URL 就走
`POST /resolve`，命中则显示提示条。**绝不自动创建 entry**（AGENTS.md：provider 匹配必须
由用户发起）。

### 5.3 不做的事

* 不新增表、不改 schema、不新增 migration（`site_works`/`site_crawl_sources` 已够）；
* 不让 T³ 解析 `site.json`、不判断站点、不抓页面；
* 不在 UI 里出现"adapter / 规则集 / 选择器"这类术语（沿用现有 i18n 的口径：`import.folderHint` 那类站点中立文案）；
* 不引入常驻服务（除非 §11-D3 选它）。

---

## 6. 数据根归位（第一件事，需你点头）

> **状态（2026-09-21）：已按建议 (a) 执行完毕**（用户指令「将这些内容都修复了」）。搬迁脚本先列两侧条目数、逐项 move、搬后逐项核对：`installed` 844、`local` 20、`cache` 814、`sessions` 735、`export` 10、`browser_profiles` 329 个文件，全部一致；空的旧 `.data` 已删。`builtin/` 按 D6 去了仓库而不是新 home。

现状：工具 home = `<repo>/.data/siteprobe`（实测），T³ 用户数据 = `<repo>/apps/server/.data`
（`T3.bat:71` 把 cwd 切到 `apps/server`）。指导 §34 要求 home = `<T3_DATA_DIR>/siteprobe`。

**建议（D1）**：把 home 归位到 `apps/server/.data/siteprobe`，方式两条一起用：

1. 仓库根放一份 `siteprobe.json`：`{"home": "apps/server/.data/siteprobe"}`。
   工具的解析顺序里这已经是第 2 条规则（`registry.py:57-67`，读 `parents[2]/[3]` 下的
   `siteprobe.json` 的 `home` 键），所以**双击 bat 独立使用**与**被 T³ 拉起**会落到同一个 home。
2. T³ 起子进程时**显式**传 `SITEPROBE_HOME=<T3_DATA_DIR>/siteprobe`（env 是第 1 条规则，
   优先级最高，且让"运行期真实用的 home"在进程环境里可查）。

搬迁（**move，不是 delete**，一次做完、可回退）：

```text
<repo>/.data/siteprobe/{installed,local,builtin,sessions,cache,browser_profiles,export,sources}
  → <repo>/apps/server/.data/siteprobe/         # 逐项移动，不覆盖任何已存在的同名目录
```

* `export/` 里有真实产出（18comic 的清单、各站字典），**移动前先列一遍条目数**，
  移动后逐项核对数量一致；`browser_profiles/` 含登录态，同理。
* 移动后跑 `probe.py --list-sites`（应仍是 10 个站、三份双适配器提示）与 `验收.bat`。
* 如果 `apps/server/.data/siteprobe` 已存在同名项：**停下报告**，不要合并覆盖。

替代方案（不推荐）：保持现状，让 T³ 用 `SITEPROBE_HOME` 指向仓库根那份。代价是
"T³ 备份/清理策略管辖的目录"与"工具实际写数据的目录"继续分裂（指导 §34 明确反对）。

---

## 7. 前置债务清单

> **状态（2026-09-22）：本表已全部清账。** 下面是各阶段的记录，保留作来龙去脉。
>
> 本轮又补了三处同族的解析错误（都在集成时才现形，已修并有测试）：
> `reader_for(key)`（下载 selection 时按「能读作品页」挑适配器 —— 原来 `get(key)` 给的是
> `work.fields` 为空的那份，实测 0 对 11/13/11）、`site_identity(key)`（`display_name`/
> `export_group`/`source_site` 是**站点**的属性，而 Builder 学出来的那份把 key 原样写回，取值时
> 「等于 key」视为未声明）、`runner.resolve` 的 `--site` 分支改用 `get_for(key, kind)`。
>
> 另外四个只在真链路上现形的缺陷见执行记录「集成：链路打通」第 4 节（没有自己 schema 的站点
> 整批导不进、argv 少了入口脚本、导出路径多一层 `export`、eslint 扫到 venv 与 Chrome profile）。
>
> **仍未修（新记 d8）**：Builder 学出来的 draft 把 key 原样写进 `display_name` / `export_group` /
> `source_site`。消费端现在兜住了，生成端应该写对或干脆不写 —— 等 adapter contract 冻结
> （指导 §28 Step 2）那一步一起定。

| # | 债务 | 严重度 | 处置阶段 |
|---|---|---|---|
| d4 | `local/18comic_vip` 的 search target 没有捕获组 → **永远匹配不上** | **高**（会让 `--site` 路径直接报错） | Phase A 修（在 Builder 的 listing 规则生成里补自检：模式必须匹配它自己的样本，且必须能取到 id） |
| d5 | `site_for_url` / `resolve_input` 给不同适配器 | 高（`resolve` 命令的正确性前提） | Phase A：`resolve` 一律按"声明了该 target"回答，并输出 `source` |
| d1 | `LEARNED_ROOT` 指向不存在的 `<tool>/tool/learned` | 高（Builder 产出无人可读） | Phase A（收到 `<home>/local/`），因为 Phase E 的 Builder 入口依赖它 |
| d2 | `annotate.SESSIONS` 指向 `<tool>/builder_sessions` | 中 | Phase A（收到 `<home>/sessions/`） |
| d3 | `refresh_review.py` 默认 `<tool>/export` | 低 | Phase A |
| d6 | `adapter.json` 只写不读、`capabilities` 无词汇表 | 中 | Phase A **只记录**；等 adapter contract 冻结那一步再定，本轮 UI 用 `targets` 顶替 |
| d7 | `--list-sites` 对双适配器站点隐藏 `installed` 的 kind | 中 | Phase A（`sites` 命令已给出全部；人类列表顺手补一行） |
| — | 两个 `.data` | 高 | Phase B 前完成（§6） |
| — | 中性 contract **只有单品、没有 batch** | 中 | 本轮按需（若某个站导出的是 items 数组而它不在 `SITES_WITH_OWN_SCHEMA` 里，就需要；否则不动） |

---

## 8. 测试与验收

### 8.1 工具侧（进现有的门）

* `integration.py` 的契约测试：`sites` 的形状、`resolve` 的四种回答（命中/无站/歧义/无效）、
  `run` 的事件序列（用假的 runner + 录制的目录，**不联网**）、`error` 事件的 code 集合；
* d4 的回归测试：`local/18comic_vip` 的 search target 必须能匹配它自己的样本 URL；
* `check_undefined_names.py` 与 bat 卫生门自动覆盖新文件（新入口必须进某个 bat 或在
  `verify_doors` 的门列表里，否则等于没有门）；
* `验收.bat` 新增一道门：`integration sites --json` 必须 exit 0 且输出可被 `json.loads`
  逐行解析（**并自测**：喂一个坏输出必须判失败 —— 参照上一轮 `check_undefined_names` 的教训）。

### 8.2 T³ 侧

* transport 测试**用桩**：仓库内放一个假解释器（一个会把契约 JSON 打到 stdout 的小脚本），
  测试里 `SITEPROBE_PYTHON` 指向它 —— 集成测试**不依赖真 venv、不联网、不碰 `.data/`**；
* `preview-path` 的路径守卫测试：`..` 逃逸、home 之外的绝对路径、非 `metadata.json` 一律 400；
* jobs 测试：起→进度→结果、起→取消→进程被杀、子进程崩溃→`error` 事件＋非 0 状态；
* **origin 往返测试**（补 §2.3 #6 的空白）：从 `preview-path` 拿到的 batch 原样送给
  `POST /api/imports/commit`，必须推进 `site_crawl_sources`；
* 前端：面板的组件测试（下拉由 `/sites` 驱动、`accepts_name` 影响提示、无匹配不弹窗），
  API 用 mock（现有 `gallery-app.test.ts` 的写法）。

### 8.3 手工真门（每个 Phase 结束跑一次）

```text
cd D:\Project\TagTraceTrove\siteprobe && .venv\Scripts\python.exe verify_doors.py --slow
cd D:\Project\TagTraceTrove && pnpm test && pnpm test:integration && pnpm db:probe && pnpm db:doctor
                              && pnpm lint && pnpm typecheck
```

外加一条**只有人能走的门**（写进本文件的验收要求，Phase C 的出口）：

```text
T3.bat → 导入区 → 从网站获取 → 选一个站 → 单作品 → 导入 → 库里有条目、有封面
        → 再来一次 → 搜索 → 手动筛选 → 挑 3 个 → 只下载这 3 个 → 导入 → 游标推进
```

---

## 9. 分阶段实施

| Phase | 内容 | 出口（可观察） |
|---|---|---|
| **A 契约与债务** — **已完成（2026-09-22）** | `integration.py`（sites/resolve/run/selection）+ 错误 code + 4 道 judged JSON 门；d1–d5/d7 收尾；单作品 target 自检 | `integration sites` 与 `resolve` 三种回答实测通过；门 `24/24`（含 4 道新门，且有喂坏流的自证）|
| **B 通道** — **已完成（2026-09-22）** | `home.ts`/`transport.ts`/`jobs.ts`/`runtime.ts` + 全部 `/api/siteprobe/*` 路由 + `preview-path`/`commit-path`（含路径守卫与媒体落盘）| 桩测试全绿；真解释器下 `sites`/`resolve`/一次单作品运行实测通过，导出能被 `preview-path` 读成 entry |
| **C 导入区闭环** — **最小实现已完成（2026-09-22）** | 前端面板（工具/类型/输入/手动筛选/进度/取消）+ C1 selection 监视 + origin 往返测试 | 面板与桩的测试全绿；**§8.3 那条人手门只有「单作品」走过（我实测到导出就绪），带手动筛选的搜索往返仍待人在浏览器里走一遍** |
| **D 剪贴板** | focus 读剪贴板 → resolve → 提示条 → 预填进 C 的面板 | 复制一个作品 URL、切回 T³ 窗口，出现提示条；点开即可完成导入；未匹配的网址只静默 |
| **E review 回传（C2）** | **已实现**：复用 T³ 同源 HTTP selection 接口；export-file 路由仅对该 run 自己的 review 页保留 run ID，按真实路径验证导出根目录并从校验句柄读取；ID-list/Hitomi sidecar 与 media import 也走同一 guard；缺失路径返回 404。Review 页只回传给归属 run。 | 导出不再需要保存对话框；无需额外 Python loopback service/token 生命周期 |
| **F Builder 入口** | T³ 里启动 `build_adapter.py`/`build_listing.py`，进度转发，标注页在浏览器里开；d1 之后产出直接进 `local/` | 在 T³ 里为一个陌生站造出适配器，`sites` 立刻列出它 |

顺序理由：A 是 B 的前提（没有机器接口就没有数据驱动的 UI）；B 是 C 的前提；
D 便宜且独立；E/F 是"改已经工作的东西"，放最后。

**本轮建议做到 C**（D 可顺手），E/F 单独排 —— 因为 F 会把"运行中的交互式进程"
这个新问题带进来（进度转发 + 无限阻塞 + 浏览器归属）。

---

## 10. 明确不做（本轮）

* 未匹配到工具的网址怎么处理（交接 §1.4 已押后）；
* adapter marketplace / 远程下载 / 更新 / 签名 / trust model（分发架构 §12-14、§38）；
* 让 T³ 自己下载或解析站点页面（指导 §16.3）；
* 运行时 LLM 抽取（实测否决，见记录「模型抽取不适合作为运行时依赖」）；
* 逐站人工适配的新站点；
* `capabilities` 词汇表与 `adapter.json` 读者（等 adapter contract 冻结那一步，指导 §28 Step 2/4）；
* 中性 fixtures 与"删掉真实 adapter 仍绿"（指导 §28 Step 3/4，与本文件正交）；
* 任何数据库 schema 变更。

---

## 11. 待你决定

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| **D1** | 数据根归位 — **已按 (a) 完成（2026-09-21）** | (a) 迁到 `apps/server/.data/siteprobe` + 仓库根 `siteprobe.json` 固定；(b) 保持 `<repo>/.data/siteprobe`，T³ 用 env 指过去 | **(a)**：指导 §34 要的是同一个根，且 (b) 让备份/清理策略继续漏掉工具的数据 |
| **D2** | review 交接 — **用户已定：先 a，终态要 b 的效果** | (a) 先 C1 监视目录，再做 C2 回传；(b) 直接做 C2 | **(a)**：C1 零改动、且正是交接 §1.2 写明的"保存的 selection 也会被读取到"；C2 是"改一个已经工作的页面" |
| **D3** | transport — **用户已选 (a)，已实现** | (a) 子进程 + JSON-lines；(b) 常驻本地小服务 | **(a)**：与交接 §5 的倾向一致；常驻服务要处理端口、生命周期、版本漂移三件额外的事 |
| **D4** | 剪贴板归属 — **用户已定：搁置（「这个功能不关键」）** | (a) 前端 `focus` 时读一次；(b) 后端轮询 | **(a)**：`navigator.clipboard` 只有页面能读（localhost 是安全上下文）；后端要读剪贴板得靠平台 API，跨平台代价高 |
| **D5** | 本轮范围 — **用户已定：A+B+C，做到能在 T³ 里跑一次为止** | (a) A+B+C（+D）；(b) 只做 A+B；(c) 一路做到 F | **(a)**：C 是"闭环可验收"的最小单位；(b) 做完了看不见成果，(c) 会把交互式进程的问题混进来 |
| **D6** | builtin adapter 位置 — **已按 (a) 执行：README 移入仓库，home 里不再有 builtin/** | (a) 仓库 `siteprobe/adapters/builtin/`（指导 §34）；(b) 留在 home 的 `builtin/` | **(a)**，但**本轮不动**：现在 `builtin/` 只有一份 README，没有读者也没有内容（记录里已列为待决），等"随 T³ 分发适配器"落地时一起做 |

除此之外的默认判断（我按这些走，除非你否掉）：菜单与类型全部由注册表生成；T³ 只认
`metadata.json` 与 selection 两个文件；`preview`（上传）保留；不新增 schema；不引入新依赖。
