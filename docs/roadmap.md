# T³ 需求进度与待办 (roadmap)

> 需求档案:记录已拍板但尚未实施的功能要求(用户原话要点 + 设计决策)。
> 已落地功能的权威描述以 `docs/current-architecture.md`、`docs/http-api.md`、
> `docs/database.md`、`docs/api-contracts.md` 与代码为准,不在此处重复。
> 已完成并验收的条目在同步进正式文档后即从本文件删除;原始需求对话不留档。
> 两份根目录 plan 文档(产品定义 / 执行架构)的全部执行项已落地。

## 状态快照 (2026-09-08)

- 桌面端收尾完成:probe 新增点赞/分区/合集三个证明项,doctor 新增评分槽
  subject-kind、合集嵌套深度、成员 kind 三类不变量检查;6 处原生 confirm
  对话框全部替换为两段式按钮(首点武装为确认文案,再点执行,4 秒自动撤销,
  落实 Click before dialog);README milestone 刷新到当前状态。
- 此前全部批次(评分系统、使用记录跟踪、点赞、SFW/NSFW 分区、全局搜索、
  合集、稍后再看、正式模板文件、作者筛选等)均已落地、验收并同步进正式文档。
- 运行入口:`T3.exe`(托盘启动器)/ `T3.bat`,单进程 8765。
- 桌面端与手机端基础功能均已完成;下一步边界为万级数据规模/数据库架构升级，当前未启动。UI 升级交接文件见
  `docs/ui-overview.md`(文件清单/约束/外部 AI 计划格式)。手机端规划简报见
  `docs/mobile-prep-brief.md`(给做计划的 agent:现状导览 + 触屏/响应式/LAN/
  缩略图工作清单 + 约定陷阱;核心结论 = 不需要任何新功能,全部是前端与
  运行形态层的工作)。

## 任务

1，作者别名组（✅ 已完成 2026-09-05，待验收）： 

设计决策：不做独立的合并表——一个别名组就是 `producer` 词典里的若干行
（别名 tag 名 → 显示名 canonical，partition=authors），复用现有 taxonomy
机器（导入解析、author merge、名字下暗淡别名小字全部共用一套）。显示名
与 tag 名分开输入；保存时即执行词典归并（先备份），把库内已有的重复作者
行收敛为显示名那一行，因此点击任何拼写都指向唯一作者。

落地范围：
- HTTP `GET/POST /api/author-alias-groups`（重复拼写 400；与显示名相同的
  拼写自动忽略）；保存响应内嵌归并报告（合并数/重命名/作品转移数）。
- Advanced editing 新增第 5 个 tab「Author aliases / 作者别名」：显示名 +
  多行 tag 名表单、已存别名组列表（含每个拼写的移除）。
- 作者详情页信息板名字下显示暗淡别名小字（与列表卡片行为对齐）。
- 顺带修复：Advanced editing 的「Gallery templates」tab 面板标记此前缺失
  （点击后错误渲染未分类 tag 内容），已补回。review 后 preview 进一步改为
  「完整卡片示意」：按每个 gallery 当前保存的 Section→Facet 布局画一张示意
  卡（区段分隔线 + facet 标签列 + 空 tag 槽），并接上评分区（该画廊的共享
  评分槽逐行 ★ 占位）与 Content 区（source url 行 + 正文占位），构成完整
  的卡片界面；不再罗列 tag→facet 归属清单。
- 无 schema 变更。覆盖：5 个 real-SQL 集成测试 + 2 个 HTTP 路由测试 +
  3 个 UI 测试（别名组保存/列表、模板面板渲染、详情页别名小字）；
  probe/doctor 通过。

### 日后待真实数据大量入库时验收。

2，计数统计（✅ 已完成 2026-09-05，待验收）：Gallery 标题在筛选/排序激活时
  显示「筛选后 / 总数」（总数取自 sidebar 投影）；Tag 结果页显示条目数；
  作者列表标题显示可见作者数。Tag 页无筛选，不加。（已验收）
3，合集子文件夹（✅ 已完成 2026-09-05，待验收）：entry 合集详情 edit 模式
  新增「+ 新建子文件夹」；子文件夹以文件夹卡片显示在成员上方，可点击进入
  （后端 parent_id/children 本就支持），返回键回到父文件夹而非列表。）
### review（✅ 已修正 2026-09-05）：1) 📁+ 添加菜单现在展开子级（显示为
  「父合集 / 子文件夹」路径），可直接把作品加进子文件夹；2) 复用 author
  directory 的成熟交互——文件夹 edit 模式下，成员卡片可拖到子文件夹卡上移入，
  子文件夹内有「拖到这里移回上一级文件夹」的投放目标；3) 子文件夹内不再提供
  「新建子文件夹」入口（服务端同样硬性禁止超过一层嵌套，409）。
4，主题色切换（✅ 已完成 2026-09-05，待验收；✅ 已按 review 扩大覆盖面）：
  统一接口 = 根节点 `data-accent` 属性驱动的 CSS 变量。每个色板除
  `--accent`/`--accent-hover` 外，还按同一色相旋转（饱和度/亮度与蓝色默认
  完全一致，不变深浅）重着色整个 tag 调色板（tag 底/边框/文字/侧边栏激活
  态/角标等都走它）以及极淡的中性色（页面背景/surface/边框）。Settings
  面板 6 个色板，偏好存 localStorage `t3.accent`。
### 会单独发图片进行效果展示
5，随机推荐（✅ 已完成 2026-09-05，待验收）：sidebar 常驻「随机推荐」入口，
  连接式三 tab：作品（可全部画廊或单一画廊+完整 facet 筛选条）、作者、
  Tag（全库词汇含使用计数，点击进入 tag 结果页，返回时回到随机页）。
  每次「🎲 随机」发一页（24 张）。服务端仅 `/api/entry-tags` 的 entryType
  改为可选（缺省=全库计数）。1 个 UI 测试覆盖三模式。
### review（✅ 已修正 2026-09-05）：Tag 模式每次只抽取 1 个 tag（大号居中
  展示，含使用计数，点击进入 tag 结果页），再点「🎲 随机」重新抽取。之前的
  报错与模板 preview 同源：T3 服务进程是启动时装载代码的，修复后需重启
  T3（托盘 Exit 后重新打开）才会生效。
6，Original series（✅ 已完成 2026-09-05，待验收）：导入 commit 时若条目在
  画廊的 Series facet（按规范化 facet 名匹配）下没有任何 tag，自动打
  「Original」；已有 series 的条目与无 Series facet 的画廊不受影响。
  1 个集成测试覆盖。

7，gallery template preview 报 invalid request（✅ 已修复 2026-09-05，待验收）：
  根因 = `templateSummarySchema` 用非空字符串校验 sections/mappings，而真实
  画廊必有未命名默认 facet（名字为 ''）以及落在其中的 tag，服务端自身 parse
  失败 → 400 Invalid request。已放宽为普通字符串（UI 侧隐藏空名）；新增
  HTTP 回归测试覆盖「未命名 facet + 未归类 tag」的模板清单。

  ### review（✅ 已验证修复 2026-09-05）：用临时文件库端到端复现真实流程
  （建含未命名 facet 的布局 → 应用 tag 布局写模板文件 → GET /api/templates）
  返回 200 且数据正确。"依旧报错"的原因是 T3.exe/tsx 服务进程不会热重载——
  修复在代码里但旧进程还在跑旧 schema。请完全退出托盘再重新打开 T3.exe，
  并 Ctrl+F5 强刷页面。


## 新任务 9-06

1. **✅ 已完成（2026-09-06）— Import 后导航与一次性检查合集。** 单项文件夹导入成功后直接打开新创建的 Entry；多项文件夹导入及 batch import 进入只包含本次新建项的临时检查合集。进入其中一个 Entry 后 Back 返回检查合集；点击 `Complete` 或任意 sidebar 入口后销毁。顶部明确说明导入成功、该合集为一次性检查且可以随时离开。该合集仅存在于前端内存，不写入 Collections。
2. **✅ 已完成（2026-09-06）— SFW/NSFW 全局可见性补齐。** Recently viewed 隐藏 NSFW Gallery tab 与作品；Collections 在 SFW 模式下过滤 NSFW Gallery 的成员作品、NSFW 作者及相应封面和计数；Random works/authors/tags 只从当前可见 Gallery/Author vocabulary 抽取，并在关闭 Show NSFW 时清除已抽出的结果。
3. **✅ 已完成（2026-09-06）— Random 单 Tag 展示升级。** 单个随机 Tag 改为居中的大尺寸 reveal card，使用现有 theme/tag/accent token、柔和渐变、圆角、阴影、focus/hover/pressed 状态，并支持 reduced-motion；点击后进入该 Tag 结果页的语义不变。
4. **⏸ 延期，不在当前范围。** 数据保存/分享（`save-share`）：未来可在 Entry、Author 和 Collection 提供与 import 结构一致的归档导出入口；目前仅记录想法，不实施。


## 新任务 9-07
1，**✅ 已完成（2026-09-07）— 所有通用排序增加 Random。** Gallery、Author 作品、Author 列表、Recently viewed 与 View later 均保留原排序并增加稳定随机排序；使用一次 Fisher–Yates 副本洗牌，不修改源数组，也不会因无关响应式渲染持续跳序。
2，**✅ 已完成（2026-09-07）— Author 共享 View later。** Author 详情页右上角使用与 Entry 相同的时钟/勾选按钮；View later 增加独立 Entries/Authors 分页。两类列表均以 SQLite/server 为权威，手机与桌面共享、按插入顺序保存、幂等增删，Author 删除时由外键级联清理。

## 手机端阶段 1（2026-09-07）

1. **✅ 已完成并实机验收 — LAN 启动形态。** T3.exe 默认 localhost-only；托盘可经可信网络确认显式开启/关闭 LAN，列出并复制全部私有 IPv4 手机地址，不自动修改防火墙。server host guard、launcher 契约、隔离数据库 UI/API/assets 与真实手机 Chrome 均已验证；Tray Exit 后手机连接立即失效。

## 手机端阶段 2（2026-09-07）

1. **✅ 已完成并实机验收 — 响应式 shell 与浏览主路径。** 44rem 以下 sidebar 改为可关闭 drawer，destination、遮罩、Escape 与 Browser Back 均可关闭；Home、Gallery、Entry、Author、Search、Recent、View later、Random、Collections 已完成窄屏布局。Facet filter 使用移动端折叠 surface；Settings、tabs、分页和工具栏适配窄屏与 safe-area；关键触控目标为 44px，Entry 的 Author/Tag chip 改为单击可达。实机反馈后补充了 Entry Tag 跳转置顶、Collections/View later 左上角小型移除视觉，以及移动端使用 Settings rows 两倍数量分页。View later Author 详情返回时会恢复 View later 的 Authors tab，不再落到 Author gallery。

## 万级数据规模阶段（手机端基础功能完成后）

> **边界：尚未启动。** 当前工作停在服务端分页/筛选/排序及任何数据库架构升级之前。

目标：在大批量网站数据导入前，让 Gallery、筛选、搜索与图片卡片稳定支持至少 10,000 条 Entry；保持 SQLite + 文件系统的单用户本地架构，不引入不必要的外部数据库或对象存储。

1. **⏳ 第一优先级 — 服务端分页、排序与筛选。** 当前 `/api/entries`、Facet 筛选和搜索返回全部匹配摘要，前端收到完整数组后才分页。改为由 SQL 执行排序/筛选并返回 `{ items, total, page, pageSize }`（必要时再升级为 cursor），Gallery、Tag 结果、Search、Author works、Recent、View later、Collections 等长列表只请求当前页；Random 使用服务端抽样或独立稳定种子语义。以 10,000 条和 100,000 条合成数据做响应时间、响应体、内存和查询计划基准。
2. **⏳ 第二优先级 — 卡片专用缩略图。** 导入时为 cover/preview 生成约 400–600px 的 WebP 卡片版本，卡片只使用 thumbnail，Entry 详情继续使用原图；为现有 assets 提供可恢复、可中断的后台补建流程。缩略图 URL 必须版本化或内容寻址，避免同路径替换的旧缓存问题，并在基准中记录首屏请求数、传输量和解码时间。
3. **后续扩展门槛。** 图片库达到约 10–20GB 后再实施内容 hash 去重、预计算 ETag/流式响应和 assets 增量备份；搜索达到数万条后评估 SQLite FTS5。SQLite 本身继续保留，除非产品边界变成多用户或公网服务。