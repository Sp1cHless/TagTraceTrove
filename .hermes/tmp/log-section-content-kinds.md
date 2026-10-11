
### 阶段：manga/movie 退役；模板的 Content 面（内容种类随模板走；内置 Source URL / description；空行不显示）（2026-10-04）

用户：**「manga,movie清理。完成模板content面的特性。」**

```text
一、manga / movie 退役（与 模板专用 同一类残留）
  先清点（库的只读副本）：manga 0 作品、tag_groups 两段（1/basic、5/fsfsf）+ 9 个 facet、0 条 tag 归属、
  无 rating_slots；movie 0 作品、两段（8/basic、138/3）+ 6 个 facet。另有一次**全库文本扫描**
  （每张表每个文本列都按字面值查一遍），确认除了 tag_groups 与 entry_tag_layouts 之外：
    · tags.normalized_name = 'manga' 与 taxonomy_aliases.normalized_alias = 'manga'
  ——那是**一个名叫 manga 的 tag**（全局词表），不是类型引用，故意没碰。
  做法同上一轮：程序自己的 DELETE /api/sections/:id 各段删掉（子行级联），entry_tag_layouts 那行留着
  （同步记账，全库没有退役接口）。
  实测：GET /api/templates 的 entryType 现在正好是 Comic / Hentai / 小说 / 漫画 / 电影 / 真人 ✓

二、Content 面：先量"到底缺什么"，再定模型
  子代理全仓核对（server + shared + offline/pending + sync）的结论：**没有任何地方model"某个 Gallery 的
  Content 种类"**——`contentType` 处处都是单行的自由文本，手机端那条线也没有引入按类型的种类表。
  所以这不是"补一个字段"，是一个新概念；也因此先定了它的语义（都对齐用户的原话）：
    · 内置两种：`Source URL` 与 `description`，"跟 source url 一样默认的存在" —— 谁都不用创建它们；
    · 拼写照抄程序自己的（实测线上库写的是 `Source URL`，AddEntryPage 传的也是这个字面量），
      否则同一个种类会以两种拼写出现在界面上（我一开始写成小写 `source url`，看到线上数据后改回来）；
    · "如果这个entry没有就不显示" → **不写空行**：种类是词表，不是待填的空槽；
    · "用户自己加的第三个 content……点击应用 template 的时候也要被应用" → 种类**从作品派生**：
      `contentKindsForType()` = 内置优先（作品里有这个拼写就用作品的）＋ 这个 Gallery 的作品真正用过的种类
      （按用到的作品数排序）。派生的好处是：某人在**一个**作品上加了 `comment`，从此它就是这画廊的一部分，
      而不用为任何"没话可说"的作品写一行空内容。

三、落地（一层一处，文件与视图同一来源）
  · `packages/shared/src/constants/content-kinds.ts`：`DEFAULT_CONTENT_KINDS`（新概念唯一的一处声明）；
  · `template-export.ts`：`contentKindsForType()`；`<type>.template.json` 增加 `contentKinds`；
    `listTemplateSummaries` 用**同一个** helper 填 summary —— 文件与进阶编辑视图不可能互相矛盾；
  · 新路由 `GET /api/content-kinds/:entryType`（+ shared schema `contentKindsResponseSchema`，客户端
    `listContentKinds`），给编辑器用，不必为了拿一个画廊的词表去读全部模板（Comic 的 tag-layout 有几千条）；
  · 进阶编辑：模板预览的 Content 块改成渲染**真实种类**（原来是硬编码 `source url` + 一个空槽——正是用户
    拿自己那条 entry 对照出来的东西），公共模板块标出两种内置；
  · Entry 编辑：`+ 内容` 表单把该画廊的种类做成**一键标签**（点一下就填进 Label，输入框仍可自由输入）；
    空内容被拒（表单校验 + `createContent` 守卫，提示 `content.bodyRequired`）；
    只读态**不显示没有文字的那一行**，编辑态照常显示（那里才是填/删它的地方）。
  线上实测：
    · GET /api/content-kinds/电影 → ["Source URL","description","评价"] ——`评价` 正是用户在一个作品上加的，
      真实数据把"自己加的种类也会被应用"这半边验掉了；
    · 六个 gallery 的模板文件已按新形状重写（脚本只读库、只写那两个导出文件，不动任何一行数据），
      `电影.template.json` 现在带 contentKinds: ["Source URL","description","评价"]；
    · 真浏览器（用户那一层）：预览行读到 "Content Source URL description 评价 … Content kinds a work here
      carries: 3"，编辑器里读到 chips ["Source URL","description"]。
```

```text
门（本轮改动触及：shared 常量与 schema、template-export、app.ts 新路由、GalleryApp/AdvancedEditingPage/
    i18n/客户端，以及三个测试文件）：
  · apps/server typecheck ✓、apps/web typecheck ✓（对方那条 pending-work-restore 报错这一轮已经不在了）
  · 服务器单元+import 95/95 ✓；模板集成 7/7 ✓（新增两条：种类随文件与 summary 走、空画廊只有内置且不写行）；
    HTTP 路由 30/30 ✓（新增一条：中文画廊名走路径、内置在前）；shared 67/67 ✓；
    web：gallery-app + add-entry-quick + i18n 213/213 ✓（新增两条：一键标签+空行被拒、空行只读态不显示）
  · 全量单元套件 1030 passed / 3 failed —— 三条都在 apps/web/tests/advertised-delta-settings.test.ts，
    报的是 **Cannot find package 'tsx' imported from D:\Project\TagTraceTrove\**：该测试自己 spawn 一个
    一次性服务器（`node --import tsx`），而 tsx 只装在 apps/server/node_modules 下。与本次改动无关；
    且该文件 mtime 是 **11:08:53**，正好落在我 11:08:17 开始的全量跑里 —— 手机端/离线那位 AI 正在写它。
    处置照旧：不碰、不"修"，记录在案。
```
