
### 阶段：视频"时长"落地为 Entry 的字段（与 page count 同级）（2026-10-08）

**接上一节**——那一节的结论是"只研究不实现"，本节是它的落地，所以那两句"本轮只研究不实现"到此失效。

用户指令四条：① DB 新增字段；② 导入 JSON 多一项（可为 null），格式 `h:mm:ss`，支持 `mm:ss` / `m:ss` / `ss` / `s`；
③ Entry 的展示位置与编辑规则照 page count 的样子，不要另写；④ 适配器只留接口——通用适配器读不到时长，
在 page count 的注释下面写「若为视频，不支持读取时长，请单独适配」。

**① 数据库**

`038_entry_duration.sql` → `ALTER TABLE entries ADD COLUMN duration_seconds INTEGER;`。存**秒**（与
`page_count INTEGER` 同形），显示形状由 `formatDuration` 一处负责：`805` → `0:13:25`（小时不补零，`h:mm:ss`）。

**② 导入**

导出文档里字段名 `duration`，由 `apps/server/src/import/site-probe.ts` 的 `durationSchema` 接收并解析。
只加在 `hanimeItemSchema` 与 `neutralItemSchema` 两个 item 形状上——只有它们可能装视频；18comic 与 hitomi 是
画册，放一个时长字段只会招来误读。

解析规则只有**一处实现**（`packages/shared/src/duration.ts`）：数字即秒；`ss`/`s`／`m:ss`／`mm:ss`／`h:mm:ss`；
全角先折半角（`１：０２：３６` 是中文输入法还开着时的产物，判成"不是时长"看起来像 bug）。**除首位外每一段必须
小于 60**：`100:00` 是 100 分钟，合法；`1:75` 拒绝，因为 1h75m 与 1m75s 只能靠猜，而一个看着对的错时长比没有更坏。

实测（集成测试固化）：`805` → 805、`'805'` → 805、`'13:25'` → 805、`'1:02:36'` → 3756、`'2:02'` → 122、
`'45'` → 45、`null` → 无字段。

**读不出来的值不静默丢掉。** item schema 一失败，整个文档会落到最后那句 `Unsupported site_probe export format`
——真话但没用。所以补了 `unreadableDurationReport`，在那句之前先点名：

```text
  Work 99737 has a duration this importer cannot read: "1 hour 2 minutes" (expected h:mm:ss, mm:ss, m:ss, ss or s)
```

**③ Entry 展示与编辑**

`EntryStatsRow.vue` 加第三个 stat，位置/手势/空槽全部照 page count：双击（触屏点按）进编辑、Enter 存、Esc 撤、
失焦存，空槽是 `+ 时长` 的 chip。**与 page count 的唯一差异，也是刻意的**：时长可为 null，空框即清除——"不确定/
记错了"是常态；page count 是 optional-not-nullable，只能改不能删。清除路径在 DB probe 与集成测试里都测了。

**④ 适配器半边**

`siteprobe/src/generic/extract.py` 的 `_SCALAR_FIELDS` 加 `duration`、`canonical.py` 的字段分组加 `duration`，
并在 page_count 那条注释下面写下了用户要的那句：

> **若为视频，不支持读取时长，请单独适配。**

**标注页不加"时长"字段、学习器不为它提候选**：接口留出（site.json 可声明 `duration` 规则 → 进导出 → 进 T³），
通用链路不假装能读——依据就是上一节五个站的实测。

**两条必须留档的过程发现**

```text
1. `createEntry` 会在旧 schema 上崩，14 个集成测试同时红。
   那些 fixture 是"逐版本建库"的：它们用**当前** writer 往 v15/v17/v18/v31/v33/v34 的库里写 entry。
   新列一加，INSERT 与后面的 SELECT 都点名了那个版本还没有的列。
   修法不是让 production 代码容忍旧 schema —— 光写容忍不够，读也得容忍（`getEntryRecord` 每读一次都会点名列），
   那会把一个只为测试存在的分支塞进热路径。真正的错在 fixture：它想要的是"那个版本上存在的一条作品"，
   却用了今天的写入口。于是 `testing.ts` 多一个版本忠实的 `insertLegacyEntry`（raw INSERT title/type），
   7 个文件的 9 处换掉。**副产品**：这些 fixture 从此对"以后再给 entries 加列"免疫。
2. 我自己先写错的测试暴露了过严的规则：初版是"任何一段 ≥ 60 即拒绝"，于是 `100:00` 被判非法。
   改成"只有非首位分段有上界"后，两边的语义都对了。
```

**门**：typecheck 0；eslint 0；单测 **1202**（本轮新增 shared 5 条 / import 2 条 / web 3 条）；集成 **631/631**
（并行跑时 `delta-payload` 的 utf8 预算那条偶发失败过一次，单独跑与整树重跑都过，与本改动无关）；
`pnpm build` 通过；`db:probe` 新增 `schema-38 Entry duration` 与 `store a work duration as the peer of its page count`
两项并 PASS；`db:doctor` PASS。跟随更新的版本断言共 7 处（37 → 38）。

**本轮没做（用户明确"只留出接口，即可"）**：`AddEntryPage` 的创建表单不加时长输入——它经
`OfflineEntryCreateRequest` 进 sync 载荷，属于离线/同步那半边；离线副本与手机端也因此不携带该字段
（`sync-service.ts` 的快照 SELECT、`offline-api.ts` 的 metadata 白名单、`syncEntryRowSchema` 均未动，归另一位）。
结论：**桌面在线**的导入、展示、编辑是完整的；手机上的时长既不可见也不可编辑，直到同步半边补上。
