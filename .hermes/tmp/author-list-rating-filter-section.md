
### 阶段：作者列表按"作者自身"评分筛选与排序（2026-10-08）

用户：作者列表页也要能把 rating 加进筛选 —— **只加 author rating，不考虑 work summary**；沿用 `+ Author tags` / `+ Works contain tags`
那种"加一行"的模式；加了之后**以该评分从高到低为主序**，右上角那四个规则（most viewed 等）**不冲突，退为次序**；
点到 random 就按 random（同星级内 random）。

**服务端（`queryProducerPage`）**

```text
  producerPageQueryRequestSchema 新增两个可选字段：
    ratingConditions: [{slotId, operator, stars}]  ← 与作品侧同一套词汇（eq/gt/lt/unrated）
    ratingSort: {slotId, direction:'desc'}         ← 作者列表专用的小 schema：作者自身维度没有"回退"可谈
  两个字段**可选而非默认值**：这个请求有 7 个不关心评分的调用点（Collections/Search/Random/ViewLater/GalleryApp…），
  让它们各写一个空数组是噪声；仓储端 `?? []` / `!== undefined` 兜底。
  取值表达式只有一条（AUTHOR_RATING_VALUE_SQL），筛选与排序共用，所以两者不会对"这位作者值多少"有不同看法。
  排序：ORDER BY (值 IS NULL) ASC, 值 DESC, <该页自己的排序> —— 右上角那四个规则（含 random）就地变成次序。
  守护：只有 subject_kind='author_self' 的槽位可用；作品概括槽位**明确报错**而不是静默返回空列表
        （空列表看起来像"没有符合的作者"，而其实是问错了类）。
  选项：listAuthorFilterOptions 新增 ratingSlots —— 这些作者**确实被评过**的作者自身维度（值非空），并带上所属画廊
        （同一维度名可能存在于两个画廊；作者自身维度属于其被锚定的那个画廊，别的画廊对他没有这一行）。
```

**UI（AuthorPage）**：`+ Rating` 按钮（没有可筛维度时不出现）+ 与作品侧同形的行（维度 / 运算符 / 星数 / ×），
默认 `greater than 三颗星`（与上一轮作品侧改的默认一致）。**第一行**的维度决定主序 —— 这就是"加了评分就从高到低"。
维度名在两个画廊重名时显示为 `名称 · 画廊`，否则只显示名称。行随 `authorTagFilters` 一起记进 author-list 的导航记忆。

**测试**：集成新增一条（排序 5→2→unrated、`>3` 与 `unrated` 过滤、筛选与排序组合、total 跟着筛选、`random` 作次序
两次调用一致、作品概括槽位被拒、选项只列出真正被评过的维度）；作者页新增一条（空行不发条件、默认 gt 3 且带上 ratingSort、
`unrated` 时星数选择消失、重名维度带画廊后缀、删行后不再带 ratingSort）。另更新 6 处既有断言：作者筛选选项多了一个
`ratingSlots` 字段（服务端三处 HTTP 断言、gallery-api、offline-api，以及两个测试替身）。

门：shared/server typecheck 0、eslint 0、单测 **1208**、集成 **639/640**、build ✓、`db:probe` 49 项 PASS、`db:doctor` PASS。

**一条并行的红，不是本轮改动**：`apps/web/src/offline/offline-api.ts` 正在被另一位改（文件时间 23:34–23:37，本轮改动都在此之前），
web typecheck 报的两处错误全在那个文件里、且都关于 `durationSeconds`（他在把时长接到离线链路上）；同时他的新测试
`author-self-offline.integration.test.ts`（23:36 建）失败于 `expected 'comic' to be 'film'` —— 那是**离线改锚点**，
而锚定目前只有 REST 直写、还没有同步操作（`producer.anchor.set` 之类），正是他那一半要补的东西。按边界我没有动他的文件。
