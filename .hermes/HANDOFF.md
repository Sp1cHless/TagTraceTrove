# T³ 交接说明

> 生成时间：2026-09-11。本文是给下一位接手者（人或 agent）的进度总览。
> 产品能力的权威说明在 `docs/roadmap.md`（状态快照）、`docs/current-architecture.md`、
> `docs/http-api.md`、`docs/api-contracts.md`、`docs/database.md`。

## 一、当前状态

`docs/roadmap.md` 的「小任务与改动」三项**全部完成并验收**：

| 项 | 内容 | 落点 |
| --- | --- | --- |
| 1 | 名下没有作品的作者从所有可检索位置隐藏（不删除行） | `apps/server/src/repositories/producer-tag-repository.ts`（`HAS_LINKED_ENTRY_SQL`） |
| 2 | 18comic / Hanime 繁简字典与自动繁转简（OpenCC `t2s`，无 LLM） | 仓库外 `D:\Project\Dataextracted\site_probe\` |
| 3 | Entry 编辑模式一键「转为多作者」 | 本轮新增，见第三节 |
| 5 | Advanced editing 一键标题缩减（`原文 \| 译文`） | 同日第五轮，见第七节 |

**全部改动仍未提交**：工作区 33 个已修改文件 + 4 个新文件，未 `git add`。
提交历史仍停在 `8930332 Database-upgrade-1`。是否提交、如何切分提交由用户决定。

延期任务（失效 Source 批量维护、save-share、图片规模、FTS5）见 roadmap，均未开始。

**同日第十四轮**：18comic 预览图被站点打乱的问题已定位并修复（见第十六节）——采集器新增还原
逻辑与存量修复命令；T³ 侧按用户决定删除了「临时」合集里的 224 个 entry（5005 → 4781），
等待重新导入 `exports/favorites_spechzy_folder_3401826`。

## 二、第 2 项：提取侧繁简字典（仓库外）

站点工具位于 `D:\Project\Dataextracted\site_probe\`（不在本仓库，`exports/` 为私有数据）。原计划的
Task 1–4 由上一轮完成（代码 + 测试），本轮补完 Task 5（真实数据回填）与文档。

- 18comic：`src/taxonomy.py`（默认 inventory 只刷新字典；`--apply` 才重写 metadata）、
  `应用Tag审核.bat`、`src/import_core.py` 提取时自动刷新字典。
- Hanime：`src/tag_policy.py` 字典由 tags-only 升级为五分区；**本轮新增 `--inventory`**
  （此前只有 apply，会重写 metadata，缺少只读回填入口），含 RED→GREEN 测试。
- 两个站点都用各自的 `src/text_normalization.py`（OpenCC `t2s`）与
  `opencc-python-reimplemented` 依赖。

回填结果（inventory-only，已证明未改写任何 metadata）：

| 站点 | 分区 | tags | 待审核 |
| --- | --- | --- | --- |
| 18comic | series 130 / authors 184 / characters 101 / types 0 | accepted 0 / rejected 0 | 353 行，`zh_cn` 全部预填简体 |
| hanime | series 11 / authors 1 / characters 22 / types 0 | accepted 205 / rejected 20 | 0 |

证据与脚本在 `.hermes/tmp/`：`taxonomy-inventory-check.py`（导出树指纹）、
`taxonomy-validate.py`（字典契约校验）、`{18comic,hanime}-{before,after}.json`。
两站回归测试：18comic 29 passed、hanime 18 passed。

> **修订（2026-09-12）**：18comic 的 `tag_review.csv` 原本以纯 `utf-8` 写出（无 BOM），
> 中文 Windows 的 Excel 会按系统代码页读取，整列中文显示为乱码。三个站点里只有这一处漏了
> `utf-8-sig`（Hitomi / Hanime 的 CSV writer 一直是 BOM）。已改为 `utf-8-sig` 并重新生成该文件，
> 内容逐字节等价（353 行、行内容哈希一致，仅多 3 字节 BOM）；三份测试里按 `utf-8` 读该 CSV 的
> 断言改为 `utf-8-sig`，并新增一条断言 BOM 存在且表头不被污染。站点文档已注明该文件的 BOM 约定。

**操作提醒**：18comic 的 353 个 Tag 尚未决定。在 Excel 里只填 `decision` 即可
（翻译列留空也会自动转简，自定义写法优先）。**一条决定都没填之前不要运行
`应用Tag审核.bat`**，否则所有作品的 `分类信息.分类标签` 会被清空（`source_tags_raw` 不受影响）。

## 三、第 3 项：一键「转为多作者」（本轮实现）

需求原文：清理出现在多作者作品中、名下只有这一件作品的作者，把它们合并为一个
普通作者 tag，被清空的作者因第 1 项规则自动从作者列表消失。

**行为**：在作品（Entry）编辑模式下，把该作品的**所有署名作者**替换为一个共享的普通
作者 `multiple author`；**有其它作品的作者只是不再关联本作品**；被清空的作者行
**不删除**，只是不再可检索，后续导入仍可重新关联。可在任意作品上重复点击，已存在
`multiple author` 则复用。

> **修订（2026-09-12）**：原实现对"名下只有本作品"的作者才吸收。用户指出这仍然会漏掉
> "只在多部合集里出现、名下全是多作者作品"的作者，导致这类作者持续堆积。现改为**吸收
> 全部署名作者，不再做智能判断**（本作品最后只剩 `multiple author`），并在真实数据副本上
> 验证："名下全是多作者作品"的作者由 **82 降至 0**，可见作者由 121 降至 40。
> 同时移除了响应里恒为空的 `keptAuthors` 字段。
>
> **再修订（同日）**：已经只剩 `multiple author` 的作品再次点击改为**幂等空操作成功**
> （`convertedAuthors: []`），不再返回 409。起因是用户遇到的"第二次点击报
> conflicts with current data"，那其实是**服务端进程还在跑旧代码**导致的版本错配
> （详见第二十节陷阱 1），但顺手把重复点击做成幂等更符合直觉。只有一位真实作者的作品
> 仍然拒绝（不能把独作作者也吞掉）。

实现要点：

- 共享契约：`packages/shared/src/schemas/api.ts` 中的 `multiAuthorProducerName`、
  `convertEntryAuthorsResponseSchema`、`multiAuthorConversionAuthorSchema`，以及
  Entry 详情 `producers[].entryCount`（派生：该作者关联的 Entry 数）。
- 服务端：`apps/server/src/repositories/entry-multi-author-repository.ts`
  （单一事务）；路由 `POST /api/entries/:entryId/multi-author`（无请求体）。
  作品作者少于 2 位、或已无可清理作者时返回 409 且不写入；作品不存在返回 404。
  `isDomainConflictError` 增加 `Multi Author conversion ` 前缀。
- `db:probe` 新增检查：`credit a multi-Author Entry to the multi-author Author alone`（修订后改名）。
- 界面：`apps/web/src/GalleryApp.vue` Entry 编辑模式的作者行新增
  `data-testid="convert-multi-author"` 按钮（仅在存在可清理作者时出现，标签带数量），
  成功后刷新作者列表与详情，并在 `data-testid="multi-author-notice"` 显示 4 秒提示。
- i18n：`entry.multiAuthor`、`entry.multiAuthorHint`、`entry.multiAuthorDone`、
  `error.convertMultiAuthor`，中英各一条。

**需要你确认的一处**：你原话写的是 `"mutiple author"`（拼写笔误），实现使用正确拼写
`multiple author`。若想改回原字符串，只需改 `packages/shared/src/schemas/api.ts` 的
`multiAuthorProducerName` 一处；已存在的作者行可改名，但改名后再次点击会新建一个。

### 真实数据副本演练结果

用 `backup()` 复制真实库（**从不触碰 `.data/library.db`**）后执行：

- 45 / 15 / 11 作者的三个合集：`#300` 45 位作者 → 转换 44、保留 1；`#88` 15 → 14/1；
  `#314` 11 → 10/1。另有 6 个双作者作品各转换 1 位。
- 可见作者 96 → 26；存储作者 137 → 138（新增 1 个 `multiple author`）；
  被清空的作者行全部保留。
- 脚本：`.hermes/tmp/multi-author-rehearsal.mts`（命令见第十九节）。

## 四、Hitomi 文件夹导入失败修复（同日第二轮）

用户报告：把 `hitomi_la/exports/bonnie` 拖进 batch import 报 `invalid request`，其他作者正常。

**根因**：hitomi 导出里有些作品的 `language` 是 `{"code": null, "name": null}`（站点本身没有语言
信息，`analysis.py` 直接写入 null），而导入端 `site-probe.ts` 的 `languageSchema` 要求字符串；
36 个条目在一个 `Promise.all` 里解析，一个不合格就整批失败，又被全局错误处理统一压成
400 `Invalid request`，看不到是哪个条目。

**修复（本轮）**：

1. `languageSchema` 的 `code` / `name` 允许 `null`，hitomi 适配器改用与 comic / hanime 一致的
   `item.language?.name` 真值判断 → 语言未知的作品正常导入，只是不生成 Language Facet 值。
2. 清单里列了但 `items/<id>/metadata.json` 缺失的作品**跳过**并在 batch `warnings` 里报告，
   不再让整个文件夹失败；界面在导入复核区新增 "已跳过 N 个条目" 列表
   （`data-testid="import-warnings"`，i18n `import.skippedItems`）。
3. 条目存在但不符合 schema 时，错误消息点名作品 id 与字段
   （`Export work 6 does not match the hitomi.la export schema: title: ...`）；
   `app.onError` 新增 `isExportDataError` 分支，让 `Export …` 前缀的错误以 400 +
   原始消息返回，不再吞成 `Invalid request` / `Internal server error`。

**真实数据验证**（只读，未改任何导出文件）：

| 文件夹 | 修复前 | 修复后 |
| --- | --- | --- |
| `bonnie` | 整批 invalid request | 36 entries，2 个无语言标签 |
| `dmm.com` | 9 个条目全部不合格 | 9 entries |
| `mushi` | 2 个不合格 | 42 entries |
| `sole_work` | 缺文件导致失败 | 62 entries + 1 条跳过警告（`888260`） |
| `artist_dmm.com` | — | 仍失败（文件夹根部没有 `metadata.json`，用户表示不用管） |

全量扫描：251 个作者文件夹 / 5558 个条目中，原本 14 个条目被拒（4 个文件夹），现在为 0。

验证脚本：`.hermes/tmp/scan-hitomi-imports.mts`（全量扫描）、
`.hermes/tmp/verify-hitomi-imports.mts`（真实文件夹走真实加载器）、
`.hermes/tmp/diagnose-hitomi-import.mts`（单文件夹逐条定位）。

## 五、导入评分改为按作者记录 + 排序应用作者评分（同日第三轮）

用户要求：批量导入时给整批作品打统一分不合适（同一作者的作品有差距）；评分应该打在
作者身上；筛选栏"按评分排序"再加一个"应用作者评分"，让没有单独评分的作品借用作者评分。

**关键数据事实**：改造前库里 `rating_slots` 只有 entry 侧（Comic 3 个维度、Hentai 4 个），
`producer_rating_values` 为 0 —— 作者评分区域是空的。因此本方案规定：**作者的评分维度
按名字镜像该 Gallery 的 Entry 维度**，写入时在作者所属分区自动创建同名 `producer` 槽。

**A. 导入侧**
- 契约：`importCommitMappingSchema.authorRatings`（`{name, slotName, stars}`）+
  `importCommitResultSchema.authorRatingCount`。
- 服务端：`commit.ts` 的 `applyAuthorRatings()` 在导入事务内、作者创建/关联之后执行：
  作者名过 producer 词典 → 找 producer（本次导入已知的或库中同名的）→
  `createProducerRatingSlot`（按名字镜像、幂等）→ `setProducerRating`。作者不属于本次导入、
  或维度不属于该 Gallery 时报明确消息并整体回滚。
- 界面：移除 `batch-ratings` 与 `import-ratings` 两个作品评分块、`batchRatings`/
  `importRatings`/`batchRatingSlots`/`importRatingSlots` 状态、提交后的 `setEntryRating`
  循环、批次循环里拷贝 batch 值的那行。作者区每行新增"给该作者评分"勾选
  （`data-testid="author-rating-toggle-<作者名>"`），勾选后才出现评分下拉
  （`author-rating-<作者名>-<维度>`）；空值不提交，因此不会清掉作者已有评分；值跨批次
  物品保留。
- 批量对话框：选中文件夹后会预览第一件作品，让作者区在运行前可见；对话框打开时复核区
  隐藏自身的单件提交按钮，改为提示（避免两个 Import 按钮）。

**B. 排序侧**
- 契约：`ratingSortSchema.applyAuthorRating`（默认 false，向后兼容）。
- SQL（`entry-tag-repository.ts` 的 `authorRatingSortValueSql`）：
  `COALESCE(自身分, CASE WHEN 关联作者数 >= 4 THEN NULL ELSE (作者中该维度的 MAX) END)`，
  排序键两处使用同一表达式，参数按出现次数补足。
- 界面：`FacetFilterBar.vue` 的排序下拉每个维度两条选项（`40` / `40:author`），
  不新增筛选槽位；i18n `filter.sortByAuthorRating`（标签为 `{name} ↓ 👤`，符号代替长文案）
  与 `filter.authorRatingHint`（下拉的 title 提示）。native select 会按最长选项撑宽，
  因此该下拉加了 `max-width: 11rem` + ellipsis（移动端恢复 100%），长维度名不会再挤压筛选栏。

**验证**：单元 204、集成 191、typecheck、lint、build、`db:probe`（新增
"sort by the Author rating when a work has fewer than four Authors"）、真实库只读 doctor
全部通过。真实库副本烟测：Comic 的"涩情程度"（154 件有分）排序首屏确实按星级从 5 分起，
打开 `applyAuthorRating` 后顺序不变（因为还没有作者评分），无 SQL 错误。
脚本：`.hermes/tmp/author-rating-sort-rehearsal.mts`。

**已知边界**：作者评分只落在其 dominant Gallery 分区；dominant 不是当前导入 Gallery 的
作者，界面不提供评分开关（服务端同样拒绝）。批量预览只取第一件作品的作者，混合作者
目录里其他作者需要之后在作者页评分。

## 六、作者合并检测支持分隔符变体（同日第四轮）

用户报告：`arai_kazuki` 与 `Arai Kazuki` 在 Settings → Advanced editing → Author merge 里
检测不到，而这类"同一人两种拼写"不该动用 author alias 那套高定制功能。

**根因**：合并分组键是 `normalizeTag(name)`（NFKC → trim → 合并空白 → 转小写），下划线
原样保留，所以 `arai_kazuki` ≠ `arai kazuki`。功能原本只有两条规则（归一化后完全相同、
词典别名映射），"分隔符变体"两条都不沾。真实数据上 `POST /api/producers/merge/plan`
返回 0 个 plan（UI 显示"没有可合并项"）。

**修复**：给合并检测单独一个分组键 `mergeKey()`，把 `_`、`-`、`.` 当作空白；
`normalizeTag` 本身不变（它还被标签去重、导入字段键、词典解析共用，全局放松会误合并
标签并改变导入匹配）。另外在作品数相同时，优先保留**不含分隔符**的拼写作为显示名
（`separatorRank`），作品数多的拼写仍然优先。

**真实数据验证**（全部在库副本上）：

- plan 现在返回 **1** 组：keeper `Arai Kazuki`(6) + `arai_kazuki`(6)，且你库里没有别的
  近似重名会被顺带合并。
- 执行演练：两个拼写本来挂在**同一批 6 件作品**上，合并后生产者 166 → 165，存活行
  `Arai Kazuki` 仍是 6 件作品，`worksRelinked: 0`（因为两边本来就已关联同一批作品，
  这个计数只统计**新增**的关联，UI 结果行显示 0 是正常的），无重复关联，
  `foreign_key_check` 为空，doctor 通过。
- 脚本：`.hermes/tmp/inspect-author-merge.mts`、`.hermes/tmp/execute-author-merge-rehearsal.mts`。

**未做**：没有让导入复核页把变体拼写预选出来。AGENTS.md 要求作者匹配必须由用户确认，
所以这类重复仍可能在导入时产生，靠这条合并规则清理（Plan 干跑 → 执行前备份 → 执行后校验）。
需要入口拦截的话再单独开一轮。

## 七、标题缩减（同日第五轮）

用户要求：Advanced editing 加一键标题缩减，针对 `<罗马音> | <译文>` 这类标题（译文在后面），
因为两倍长度会拉高卡片。

**先做的数据分析**（699 个作品，112 个标题含 `|`）：90 条"罗马音/ASCII | 中文"、
1 条"日文 | 中文"、5 条"罗马音 | 韩文"、14 条两侧都是 ASCII、2 条不适用
（`Artist || akchu` 双竖线、`Drip Coffee→From♡You |` 右侧为空）。主目标平均长度 58 → 15 字符。

**规则**（确定性，无语言识别）：恰好一个 `|` 且两侧非空即成为候选，逐条给出建议方向——
分隔符之后是中文/日文（Han/Kana）→ 建议保留后半；之后只有韩文（Hangul）→ 建议保留**前半**
（用户明确韩语标题对他没用，原文至少与同系列其它标题一致）；两侧都是纯 ASCII → **不预选**
（`Nagareboshi | Shooting Star` 与"英文标题 | 罗马音"外形相同，脚本无法判断方向），
保持原样直到人工选择。用户确认：不加无分隔符的附加规则（#799/#800 之类）。

**实现**：`apps/server/src/repositories/title-shortening-repository.ts`
（`splitTitle` / `planTitleShortening` / `applyTitleShortening`），路由
`POST /api/entries/titles/plan`（返回 `candidates: [{entryId,title,keepFront,keepBack,suggested}]`）
与 `POST /api/entries/titles/apply`。apply 只应用前端回传的已选条目，并要求条目的当前标题仍
等于清单里的 `title`（否则计入 `skipped`，避免旧清单覆盖后来的改名）；文件库在执行前写
`<db>.title-backup-<timestamp>`。界面在 Advanced editing 新增「标题缩减」标签页：生成清单后
逐条两个按钮（保留前半／保留后半，建议方向高亮预选，未预选的显示提示），只有选中的条目进入
改动数，二次确认后执行；执行后重新生成清单（结果摘要保留在屏幕上）并刷新作品列表。

真实数据复核（719 个作品）：112 条候选 → 建议保留后半 92、保留前半 5（就是那 5 条韩语）、
未预选 15；按建议执行 97 条，平均长度 56 → 15，0 跳过；执行后清单只剩那 15 条待人工决定。

**已知边界**：只处理 `|`；标题里没有 `|` 的条目（例如 Dokuneko Noil 的多数作品）不会被缩短；
两侧纯 ASCII 的 14 条需人工处理。

## 八、批量导入临时合集为空的修复（同日第六轮）

用户报告：批量导入确认后进入的临时合集是空的（最近两次都是，作者 Hato Devilbu 与 Haruhisky），
导入本身成功，但失去了最后一次集中复核的机会。

**根因**：提交用的是**解析后**的 Gallery 类型（`importType.value`，例如输入 `comic` 解析为
`Comic`），而 `AddEntryPage` 发给临时合集的是**用户输入的原文**（`itemType`）。临时合集用
「类型 + id」查询（`entry.type = ?` 是精确匹配，SQLite BINARY collation），于是
`entry.type = 'comic'` 在库里叫 `Comic` 时返回 0 条 → 空集合。间歇性出现，取决于当时输入的大小写。

**证据**（真实库副本，同一批 id）：`entryType: "Comic"` → 12 条；`entryType: "comic"` → 0 条；
不传 `entryType` → 12 条。库里只有 `Comic`(938) 与 `Hentai`(4) 两种拼写，无大小写变体。

**修复**（两处，互相兜底）：
1. `AddEntryPage.vue` 的批次结束事件改为发送 `importType.value.trim()`（提交真正使用的类型），
   临时合集标题也随之显示正确的 Gallery 名。
2. `GalleryApp.vue` 的 `openBatchReviewEntries()` **不再传 `entryType`**，只按本次提交的
   Entry id 查询（id 精确且全局唯一），这样即使类型拼写以后发生变化（改名等）也不会把集合清空。

**测试**：新增用例「typed Gallery spelling」，mock 严格模拟服务端的精确匹配；已验证在没有这两处
修复时会失败（标题显示 `GAME` 且集合为空），修复后通过。

**注意**：临时合集本身是一次性的、不落库，所以那两次已经错过的复核无法补回；那些作品并未丢失
（Hato Devilbu 4 件、Haruhisky 25 件都在库中，可从作者页进入）。

## 九、导入 hews 报 500 的修复（同日第七轮）

用户报告：导入作者 `hews` 时 internal server error，导入失败。

**定位过程**（值得复用）：先看 `t3-server.log`（只有启动行，服务端不记录请求错误）→ 检查
`hitomi_la/exports/hews` 数据（manifest 22 条与 items 22 个目录完全对应，语言/标题/日期/
分类信息全部合规，无越界路径）→ 在库副本上**分别复现预览与提交**：预览成功（22 条、0 警告），
提交抛出

```
Error: Tag "哥布林杀手" is mapped to more than one Facet for the same Entry
    at collectTags (apps/server/src/import/commit.ts)
```

根因：`items/4103646/metadata.json`（标题就是 `hews`，一件跨多作品合集）的 `作品` 与
`登场人物` 都含 `Goblin Slayer`，经 producer/entry 词典解析后是同一个标签（哥布林杀手），
而 `collectTags` 的守卫要求同一 Entry 内一个标签只能落在一个 Facet，于是抛错；该错误消息
不匹配任何已映射的前缀 → `app.onError` 归到 500 `Internal server error`。

**修复**：不再整体失败，改为**保留第一个位置**并把被跳过的那次列为警告：
- `collectTags()` 收到同名不同 Facet 时保留先到者（Entry 自身标签 → 规范 Facet 优先，其次
  按映射字段顺序；已有既定位置的标签两边都解析到同一 Facet，本就不会冲突），并 push 一条
  带 Facet 名称的警告（新增 `facetLabel()`，未命名 Facet 回退到 Section 名）。
- `ImportCommitResult` / `importCommitResultSchema` 新增 `warnings: string[]`。
- 界面：警告随 `batchImported` 事件传到 `GalleryApp`，显示在**批量导入的临时合集页**
  （`data-testid="batch-review-warnings"`）。注意：Add Entry 页在提交完成时就被卸载了，
  所以写在导入页上的提示是看不到的（作者先试了一版才发现这一点）。

**真实数据复现验证**（库副本）：修复前提交抛错；修复后 `COMMIT OK`：22 entries、282 tag
assignments、22 contents，并给出 1 条警告——
`Tag "哥布林杀手" arrived for both "Series" and "Characters" in one Entry; kept the first placement`。

脚本：`.hermes/tmp/reproduce-import.mts`（预览复现）、`.hermes/tmp/reproduce-commit.mts`
（提交复现，均只在库副本上运行）。

## 十、作者搜索支持别名拼写（同日第八轮）

用户要求：用了 author alias 之后，在 Search 页输入被合并掉的拼写（如 `ishikei`）应该能找到
对应作者（`石恵`），因为这个拼写也是作者信息的一部分。范围只需 Search 页。

**实现**：
- `search-ranking.ts` 的 `rankSearchResults` 新增可选 `alternateTextsOf`（额外可命中的拼写），
  排序仍按条目自己的显示文本做并列，所以作者始终以本名列出。
- `producer-tag-repository.ts` 的 `queryProducerPage`：搜索时一次性载入
  `taxonomy_aliases`（vocabulary='producer' 且 `normalized_canonical <> ''`，按
  `normalized_canonical` 分组成别名列表），以 `normalizeTag(producer.name)` 查表作为
  alternate 文本。占位别名（canonical 为空）不参与。
  → 只有 Search 页会传 searchQuery 给该函数，因此生效范围正好是搜索（以及以后任何走同一
  搜索入口的界面）。
- `SearchPage.vue`：作者结果卡片在本名下加一行淡色别名（`search-result-author-alternates-<id>`），
  复用 AuthorPage 的推导方式（`listTaxonomyAliases('producer')` → normalizedCanonical → 别名），
  否则输入 `ishikei` 却显示 `石恵` 会让人以为搜索没生效。

**真实数据验证**（库副本）：别名行 `Ishikei → 石恵`；搜索 `ishikei` → 1 条（石恵 #524，
修复前为 0），`ishikeii`（错一字母）→ 同样命中（沿用既有容错），无意义词 → 0 条。
脚本：`.hermes/tmp/verify-alias-search.mts`。

## 十一、导入时别名拼写必须链到既有作者（同日第九轮）

用户要求：作者别名也要在**导入匹配**时生效——已记录别名的作者（如 `和泉`，别名
`izumi / 冷泉 / サイクロン / Reize`），以后导入的作品如果署名落在别名里，要 link 到该作者。

**先确认现状**：别名解析本身是好的——前端 `resolveProducerName()` 与服务端
`resolveTaxonomyName()` 都能把 `冷泉`/`Reize` 等解析成 `和泉`；Search 页也已能按别名搜到作者。

**复现出的真实缺陷**（库副本）：给一件署名 `冷泉` 的作品提交导入（复核页未预选匹配时），
提交后**多出一个同名作者行**：`和泉 #527 (37 件)` 变成 `#527 (37 件) + #530 (1 件)`，新作品
挂在重复行上。原因：`commit.ts` 解析出 canonical 名后只在"本次复核已确认的匹配表"
（`knownProducers`）里查，查不到就 `createProducer`，从不回头在库里按名字找既有作者——
这与 `docs/import-commit.md` 一直写的"links to or creates the canonical author"矛盾。
（复核页通常会预选出既有作者，所以只在预选失败时发作，例如作者列表尚未刷新。）

**修复**：解析出 canonical 名后，先 `findProducerIdByName(database, canonicalName)`（该 helper
本是为作者评分加的）在该 canonical 名下查既有 Producer，命中就链接并记入 `knownProducers`；
只有确实不存在时才新建。`createUnmatched: false` 的语义不变（它防的是"为未复核的拼写新建
作者"，而别名指向的是既有行，不是新建）。

**真实数据验证**（副本）：四种拼写 `冷泉 / Reize / サイクロン / izumi` 各自导入一件作品后
都是 `createdProducerCount: 0`、`producerLinkCount: 1`，作者仍是 `和泉 #527`（37 → 38 件），
没有任何重复行。用户当前库中**尚无**此类重复（已扫描确认）。

脚本：`.hermes/tmp/reproduce-alias-import.mts`、`.hermes/tmp/inspect-author-alias-import.mts`。

## 十二、批量导入复核页再次为空的修复（同日第十轮）

用户报告：最近的两次作者导入，临时合集复核页又是空的（截图显示标题 `Comic` 正确、无卡片、
也没有分页条）。

**排查路径**：先排除上次的类型问题——标题已正确显示 `Comic`。然后逐层验证：
1. 库副本上按最近导入的 12 个 id 复现复核页的查询（只传 id + source-order）：12 条正常，
   响应也通过 schema 校验；
2. **直接向正在运行的服务端发同一个请求**：`status=200`、12 条 ✓ 说明请求、服务端与数据
   都没有问题 → 问题在前端渲染。

**根因**：`PagedCardGrid` 的**本地分页**把页码记在导航记忆里，而临时合集的 page-key 只用
`batch:<Gallery>`，**跨批次复用**。上一次较长的批次如果翻到了第 2 页，这个页码会被下一次恢复：
新批次条目少、只有 1 页时，`items.slice(30, 60)` 切出空数组 → 空列表；而且分页条在
`pageCount === 1` 时不渲染，所以既没有卡片也没有翻页控件，看起来就是"导入成功但复核页空了"。
钳制页码的 watcher 只在 `items.length`/`pageSize` **变化**时触发，而网格是在数据加载完成后
才挂载的（模板里 `v-if="batchReviewLoading"`），长度不再变化 → 钳制不会执行。另外
`rowsPerPage × 列数` 恰好等于初值 6 列时 pageSize 也不变，两者叠加就更不会自愈。

**修复**（两处，互相兜底）：
1. 每次批次复核有独立的 `runId`，page-key 变为 `batch:<Gallery>:<runId>`，新批次不会继承
   旧页码（`pendingBatchReview` 沿用同一对象，所以从作品详情返回时仍恢复本次页码）。
2. `PagedCardGrid` 的本地切片按当前 `pageCount` 钳制（`Math.min(page.value, pageCount.value)`），
   任何视图都不会再因为越界页码渲染空白。
3. 顺手修掉可诊断性问题：复核页加载失败原本被 `catch {}` 静默吞成空列表（这次就是这样被
   掩盖的），现在会把错误显示到通用错误提示里。

**测试**：`paged-card-grid.test.ts` 新增本地分页用例（记忆页码 = 3、数据只有 2 条 → 必须
渲染这 2 条），已验证去掉钳制会失败（渲染 `[]`，正是用户看到的空页）；`gallery-app.test.ts`
新增端到端用例（先跑 40 条的批次并翻到第 2 页，再跑 20 条的批次，后者必须显示自己的卡片）。

## 十三、作者合并后完整性检查报外键违规的修复（同日第十一轮）

用户报告：author merge 功能正常，但每次都报
`Integrity check FAILED: foreign key violation: producer_rating_values row without rowid -> producers` ×3。

**根因**：作者评分（第三轮的作者评分功能）比 merge 逻辑晚出现，`executeProducerMerges` 迁移了
作品、作者标签、文件夹，但**没有处理 `producer_rating_values`**。被吸收的作者一删，其评分行
就成了悬空外键：既让 `foreign_key_check`/doctor 报错，也让那些评分实际上丢失了。

真实库只读确认：`producer_rating_values` 里有 3 行指向已不存在的作者 #534（slot 8/9/10），
正是那 3 条报错。

**修复**（`merge-producers.ts`）：
1. 吸收时同步迁移评分：`INSERT OR IGNORE INTO producer_rating_values ... SELECT ... WHERE
   producer_id = 被吸收者`，然后删除被吸收者的行；同一 slot 上已有 keeper 评分时 keeper 的值胜出，
   被吸收者独有的 slot 会被搬过去（跨分区 slot 的行也会迁移，只是不在 keeper 分区里显示）。
   执行结果新增 `ratingsRelinked` 计数，并在合并报告的明细里显示（中英文案已加）。
2. **自动修复历史遗留**：执行合并时先删除 `producer_rating_values` 中 producer 已不存在的行——
   它们永远无法再被读取或编辑，只会拖着完整性检查；合并前本来就会写备份。

**真实库副本验证**：修复前 `foreign_key_check` 3 条 + doctor `false`；执行一次合并后
`foreign_key_check` 为空、doctor `true`。测试新增一条用例（跨分区 slot 迁移 + keeper 值胜出 +
孤儿行清理 + FK/doctor 通过）。

## 十四、作者页作品每页数量与网格布局不同步的修复（同日第十二轮）

用户报告：作者页下作品列表没有遵循 6×5 布局——第一页只有 6×4，第五行仅 2 个卡片就翻页了。

**根因**：`AuthorPage.vue` 里作品查询的每页数量是写死的 `const pageSize = 26`，而作品网格的
CSS（`.author-card-grid`）是固定 6 列（≤52rem 为 3 列、≤30rem 为 2 列），每屏行数由
`rowsPerPage` 偏好决定（默认 5）→ 期望 6×5 = 30。26 = 4 行整 + 2 个，正好是用户看到的
"6×4 加第五行 2 个"。作者**列表**一侧本来就用对了模式（`authorListPageSize` + 网格的
`update:page-size`），作品列表漏了。

**修复**：作品页大小改为按布局计算并与窗口联动：
- `worksColumns`（6/3/2，匹配网格的媒体查询）+ `worksRowMultiplier`（≤44rem 翻倍，与共享网格
  的公式一致）；`pageSize = 列数 × rowsPerPage × 倍数`（computed）。
- 查询、`maxPage`、`pageCount` 全部改用该 computed；`pageSize` 变化时（窗口缩放或偏好变化）
  回到第 1 页重新请求。
- setup 时先测量一次，避免首屏按桌面默认值请求再重取；并注册/移除 resize 监听。

**测试**：`author-page.test.ts` 新增用例断言请求的 `pageSize` 为 30（而非 26）且第一页渲染 30
个作品、翻页后 10 个；原有断言按新数量更新；`gallery-app.test.ts` 两个作者分页用例的 fixture
从 30 件增到 40 件（否则一页放得下、翻页用例失去意义）。文档中"每页最多 25 张"的旧描述
已改为按布局计算。

## 十五、批量复核页「存为临时合集」（同日第十三轮）

用户要求：批量导入后的临时复核界面加一个功能，把本次导入的全部条目放入一个新合集，命名为
`临时`；若已存在则 `临时2`、`临时3`……起因是 18comic 一个收藏夹条目太多，无法一次复核完，
需要一个比一次性复核更持久的分组。

**实现**：
- 契约：`createTemporaryCollectionRequestSchema`（`{ entryIds }`，至少一条）+
  `temporaryCollectionResponseSchema`（`{ collectionId, title, entryCount }`）。
- 服务端：`collection-repository.ts` 新增 `createCollectionFromEntries()`——在**单一事务**内
  先按现有 entry 集合的标题取第一个未占用的 `临时N`，再逐个 `INSERT OR IGNORE` 成员；
  entry id 去重、已不存在的直接跳过（这是方便复核的分组，不必让整个动作失败）。
  路由 `POST /api/collections/temporary`（201）。
- 界面：复核页标题栏新增按钮（`batch-review-save-collection`），点击后显示结果提示
  （`batch-review-collection-notice`：把 N 个条目放入了哪个合集），保存成功后按钮变为禁用并
  显示合集名，避免重复创建；复核视图本身不受影响。进入新的批次时重置该状态。

**测试**：服务端 2 条（编号序列 `临时`/`临时2`/`临时3` + 成员正确 + 重复 id 不重复计数 +
缺失条目跳过）+ 路由 1 条（201 形状、编号、空数组 400）；前端 1 条（点击后调用接口、
提示显示合集名与数量、按钮进入已保存状态、复核仍在）。

## 十六、18comic 预览图被站点打乱：根因与还原（同日第十四轮）

**现象**：入库作品的预览图与站点显示的不一致，像「几张图各裁一段拼在一起」；只有少量作品正常。

**根因**：18comic 把作品页图 `media/photos/<作品ID>/<页文件名>.webp` 横向切成若干条**打乱顺序**
存放（条数由作品 ID 与页文件名的 MD5 推导），详情页自带脚本用 `scramble_image(img, aid,
scramble_id)` 在浏览器里重排后显示，页面里可见 `scramble_id = 220980`。所以**下载到的就是
错乱内容，重采也只会再采到同一份错乱文件**。

证据链：

1. `metadata.json` 记录的预览 URL 与 `raw.html` 中站点自己的预览轮播/放大区块 URL 完全一致；
2. 重新下载同一 URL（python UA 与 Chrome UA 各一次）与磁盘文件 sha256 相同（`d621d70d…`）；
3. 详情页脚本里存在 `scramble_image` 与 `scramble_id = 220980`；
4. 导出树 457 部作品中只有 8 部 ID 低于 220980（站方未打乱），与「少量正常」的数量吻合；
5. 用公开参考实现（JMComic `JmImageTool.get_num`/`decode_and_save`）还原 302092 的
   00029/00003/00055（6/2/16 条）后，三张页图文字方向、上下白边、jmcomic 水印位置均正常。

**修复**（仓库外 `D:\Project\Dataextracted\site_probe\18comic_vip`）：

- 新增 `src/image_scramble.py`：条数推导 + 条带还原 + 写进 webp 的 XMP 标记（用于幂等）；
- `src/media.py`：下载预览图后自动还原；复用已有文件时补做一次（能就地修好接入前的存量文件）；
- 新增 `src/repair_scramble.py`：离线修复存量 exports，默认 dry-run，`--apply` 才写入并把原图
  备份到 `_scramble_backup/`，已还原的文件会被跳过（可安全重跑）；
- 新增 `tests/test_image_scramble.py`（含真实作品的 6/2/16 条对齐、往返、幂等、复用修复）；
- `pyproject.toml` 加入 `pillow` 依赖。采集器 55 个测试全绿。

**T³ 侧处理**：改动导出目录里的图片字节**不会**被已入库条目感知（导入时图片字节由浏览器复制进
`.data/assets/entries/<id>/`，且重导按 Source URL 去重会直接跳过）。按用户决定改为「删掉这批
entry 再重新导入」，已执行：临时合集（`collections` id 17「临时」）里的 224 个 entry 通过
`DELETE /api/entries/:id` 删除（资源目录同步清理、无残留），entry 总数 5005 → 4781，
空的「临时」合集也已删除。删除清单留档在 `.hermes/tmp/scramble/temp-collection-entries.json`，
删除前的库副本在 `.hermes/tmp/scramble/db-before-delete/`。

**下一步**：在批量导入界面重新导入 `exports/favorites_spechzy_folder_3401826`（224 部作品
全部来自该文件夹，已核对 224/224 命中）。

## 十七、hanime 收藏夹只采前 100 条 + 跨收藏夹重复作品（同日第十五轮）

**问题 1：收藏夹超过 100 条时只导入前 100 条。** 站点 playlist 页用 Laravel 分页，每页渲染 100 条，
采集器只请求了第一页。证据：`playlist_220566` 与 `playlist_535580` 的 `item_count` 正好都是 100，
其 `raw/playlist.html` 里存在 `?list=...&page=2` 的 `rel="next"` 链接，实测第 2 页分别有 47 与 6 条。

修复（仓库外 `D:\Project\Dataextracted\site_probe\hanime1_me`）：

- `_PlaylistParser` 记录 `rel="next"` 链接，`parse_playlist` 返回 `next_page_url`；
- 新增 `collect_playlist()`：按 `rel=next` 逐页抓到底（上限 200 页），跨页按视频 ID 去重，
  标题取第一页；
- `extract_playlist` 改用它，每页原始 HTML 存 `raw/playlist.html` / `raw/playlist-page<N>.html`，
  `state.json` 增加 `pages_fetched` / `discovered_count` / `selected_count`；
- 新增 4 个测试，**22 个测试全绿**。

真实站点复核：220566 → 147 条、535580 → 106 条（正好补回第 2 页的 47 + 6 条），两个单页收藏夹不变。
补这 53 条只需重新跑一次这两个收藏夹的导入命令，已存在的条目会复用缓存的详情页与封面。

**问题 2：同一作品出现在多个收藏夹是否有问题。** 没有。导出侧 270 条记录去重后 250 部，其中 20 部
同时出现在两个收藏夹，两份记录的 title/author/tags/封面 URL 完全一致（0 处差异），共享的
`exports/tag_review.csv` 仍是 9 行唯一 tag。T³ 侧导入按 Source URL 去重：库里 46 条 hanime entry /
46 个唯一 URL / 0 重复；第二个收藏夹中的重复作品会被报告为 skipped 并保持原样，既不产生重复 entry，
也不会覆盖已有 tag。唯一需要知道的是「以先导入的那份为准」，被跳过的文件夹不会带来 tag 更新。

**顺带**：hanime 导出侧共 250 部作品，库中只导入了 46 部（正好是 `playlist_640641`），**还有 204 部未入库**，
与 hitomi 的 750 部同理——删导出前需先补导或保留这些文件夹。

## 十八、详情页合集菜单：已加入项可点击退出（Entry + 作者页，同日第十六轮）

需求：Entry 详情页与作者详情页右上角的「加入合集」菜单里，已加入的项原来是 disabled（只能看不能改），现在点一下即退出。两个页面同一套交互。

改动（仅前端 `apps/web`）：

- `src/GalleryApp.vue`：新增 `removeEntryFromCollection()`（调 `removeCollectionEntry` 并同步
  `entryCollectionIds`）与 `toggleEntryCollection()`；菜单项改为 `role="menuitemcheckbox"` + `aria-checked`，
  不再 disabled，带 `is-member` 类与 title 提示。
- `src/AuthorPage.vue`：同一套改动，走 `addCollectionProducer` / `removeCollectionProducer`；
  退出后同样 `refreshAuthor()` 重读成员关系。
- 交互约定：**加入沿用原行为（点完收起菜单）**；**退出保持菜单打开**，✓ 就地消失，便于连续退出多个合集。
- `src/styles/theme.css`：新增 `.add-to-collection-option.is-member`（沿用原 `:disabled` 的 accent 色）。
- `src/i18n.ts`：中英各加 `collections.joinHint` / `collections.leaveHint`（两个页面共用）。
- 测试：`gallery-app.test.ts` 新增「已加入 → 点击调 remove 且 ✓ 消失、再点调 add」；`author-page.test.ts` 新增作者侧同类用例。

验证：`vue-tsc` 干净；`pnpm test` 24 文件 / 236 用例通过；`pnpm build` 通过并已写入 `apps/web/dist`
（前端是静态资源，刷新页面即可生效；服务端未改动，无需重启）。

## 十九、作者页合并作品：按 URL 选主体 + 可选/改写标题（同日第十七轮）

需求（用户）：① 合并时先选主体，用来源网址区分——选中的保留、另一个删除；② 然后选标题，可以选被删除那条的标题，
选完还能自己输入覆盖；③ tag 合并与 URL 迁移保持不变。

改动：

- 契约 `packages/shared/src/schemas/api.ts`：`mergeAuthorEntriesRequestSchema` 增加可选 `title`（trim 后非空；
  缺省沿用原标题）。
- 服务端 `apps/server/src/repositories/entry-merge-repository.ts`：事务内按 `title` 更新保留作品的 `title` 与
  `updated_at`（与现值相同则不写）；tag 复制、URL 迁移、删除被吸收作品的行为一律不变。路由无需改动（整包透传）。
- 前端 `apps/web/src/AuthorPage.vue`：
  - 主体选择列表改为「标题 + 该作品的全部来源网址」，并标出 `将被保留 / 将被删除`
    （选择器 `data-merge-keeper-entry-id` / `data-merge-keeper-radio-id`）；
  - 新增标题区：可点选任一条（含将被删除那条）的标题作为基础（`data-merge-title-source-id`），
    下方输入框 `entry-merge-title-input` 可直接改写；标题为空时确认按钮禁用；
  - 切换主体时标题默认跟随新主体。
- i18n：中英各加 `entryMerge.chooseKeeper / willKeep / willDelete / noSource / titleOverride`；
  `chooseTitle` 改为「保存的标题」，`confirmDescription` 重写。
- 测试：服务端集成新增「合并写入指定标题（取另一条 / 自行改写 / 不传则保持）」；前端合并用例改为覆盖新流程
  （主体按 URL 展示与标记、标题可选另一条并改写，断言 payload 带 `title`）。
- 文档：`docs/http-api.md` 的 merge 段更新（keeper 由客户端按 Source URL 选出；body 可选 `title`）。

门禁：typecheck（shared/server/web）、lint、单测 236、集成 216、build、db:probe、db:doctor 全绿。

**注意**：`title` 是新字段且走严格 schema，**旧服务端会拒绝新前端的请求**——必须重启 T3 之后再使用合并功能。

## 二十、作者别名 Save 无反应：浏览器跑的是过期前端（同日第十八轮）

**现象**：Advanced editing -> Author aliases，填完 Display name 与 Tag name 后点 Save 没有任何反应（无请求、无提示、表单不清空）。

**根因（两层，本质都是「前端代码过期」）**：

1. `apps/web/dist/` 是 15:18 构建的，而 `AdvancedEditingPage.vue` 在 15:41 被改过（给两个 SuggestionInput 补上
   `commit-on-blur`）。别名表单靠 blur 提交：没有该属性时 blur 只关闭下拉框，`aliasDisplayName` / `aliasTagNames`
   始终是空串，`saveAuthorAliasGroup()` 随即在 `if (!displayName || tagNames.length === 0) return;` 静默返回。
   已核对服务中的旧 bundle：两个输入框都缺 `commit-on-blur`。
2. 即便重新构建，浏览器仍可能拿到旧 bundle：SW 的 `/index.html` 用的是 stale-while-revalidate（先返回缓存 shell、
   后台再刷新），所以刷新一次看到的还是旧代码。我自己开的新会话没注册 SW，因此一直没暴露这一层。

**修复**：

- 重新构建 `apps/web/dist`（新 bundle 已含 `commit-on-blur`）；`SW_VERSION` 由 `t3-shell-v1` 提升到 `t3-shell-v2`，
  使旧 shell 缓存作废。
- `apps/web/src/sw/service-worker.ts`：`shell` 策略从 stale-while-revalidate 改为 **network-first**（本地服务器取
  shell 很便宜，离线时仍回落到缓存），从设计上消除「刷新了还是旧代码」。
- `T3.bat`：由「只在 dist 缺失时构建」改为「dist 缺失，或 `apps/web/src`、`packages/shared/src` 等源文件比
  `dist/index.html` 新时构建」（PowerShell 比时间戳；构建后清一次退出码，避免误判构建失败）；文件保持纯 ASCII。
- 验证：修复后在真实浏览器完整走了一遍「填 Display name → 加 tag 行 → 填 Tag name → 点 Save」，出现
  `Alias group for ZCodeProbeName saved.` 且表单清空；测试数据随后删除（producer 别名回到 1434 条，无残留）。

**给用户的提醒**：浏览器里可能仍由旧的 v1 SW 控制，第一次刷新或许还是旧样子，再刷一次即可；此后 shell 走 network-first，
不会再出现这一类问题。

**追加修复（同一缺陷的第二半，同日）**：blur 提交生效后输入框会被清空（`afterChoice()`），于是"填好名字 → 点另一个框 → 名字消失"，
看起来像没保存。现在 `SuggestionInput` 在 fill-in 表单（`selectFillsInput`，目前仅别名表单使用）里 blur 提交后**保留输入文字**，
清空输入框则同时清掉对应值，与"选中候选后回填文字"一致；tag 创建类输入框（GalleryApp / AuthorPage 的 `commit-on-blur`）仍按原设计
提交后清空，方便连续录入。测试：`suggestion-input.test.ts` 新增 fill-in 保留/清空用例，`gallery-app.test.ts` 的别名用例加了
"失焦后文字仍在"的断言。真实浏览器复核：输入「雪」「雪绪」→ 点开新 tag 行后文字仍在 → 点 Save 出现 `Alias group for 雪 saved.`
且表单清空（测试数据已删除，producer 别名回到 1434 条）。

## 二十一、验证证据（本轮全部通过）

| 门禁 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（shared / server / web） |
| `pnpm lint` | 通过 |
| `pnpm test` | 24 文件 / 234 用例通过 |
| `pnpm test:integration` | 35 文件 / 194 用例通过 |
| `pnpm build` | 通过 |
| `pnpm db:probe` | 全部 PASS（含新增检查与 doctor 洁净） |
| `db:doctor`（真实库只读） | PASS database integrity, foreign keys, and application invariants |

本轮顺带修复的两个既有问题（上一轮中断遗留）：`apps/web/tests/gallery-app.test.ts`
的 typecheck 错误，以及该文件 100+ 个 `mount` 从不卸载导致 window 监听累积、末尾
焦点用例顶着 10 秒超时（现启用 `enableAutoUnmount(afterEach)`，该用例 10.6s → 37ms）。

第十四轮（18comic 预览图）证据：本实现与公开参考实现给出的切条数一致（302092 的
00029/00003/00055 = 6/2/16 条），还原后三张页图文字方向、上下白边、jmcomic 水印位置正常；
采集器 55 个 pytest 全绿；修复前 dry-run 统计 1323 个乱序文件 / 441 部作品，未打乱的正好是
8 部（ID < 220980）共 24 个文件，与阈值判断完全吻合。

## 二十二、本轮改动文件

新增：

```text
apps/server/src/repositories/entry-multi-author-repository.ts
apps/server/tests/integration/entry-multi-author.integration.test.ts
```

仓库外（第十四轮，站点工具 `D:\Project\Dataextracted\site_probe\18comic_vip`）：

```text
src/image_scramble.py        新增：切条数推导 / 还原 / XMP 幂等标记
src/media.py                 预览图下载后自动还原，复用旧文件时补做
src/repair_scramble.py       新增：存量 exports 离线修复 CLI
tests/test_image_scramble.py 新增：18 个用例（含真实作品的条数对齐）
pyproject.toml, uv.lock      新增依赖 pillow
README.md                    新增「预览图打乱与还原」一节
```

修改（本轮相关）：

```text
packages/shared/src/schemas/api.ts            entryCount、multiAuthorProducerName、转换响应
packages/shared/tests/api-contract.test.ts    fixture 补 entryCount
apps/server/src/repositories/entry-repository.ts           详情派生 entryCount
apps/server/src/repositories/entry-multi-author-repository.ts
apps/server/src/http/app.ts                  新路由 + 409 前缀
apps/server/src/database/probe.ts            新检查
apps/server/tests/integration/http-routes.integration.test.ts        新用例
apps/server/tests/integration/entry-repository.integration.test.ts   fixture
apps/server/tests/integration/producer-repository.integration.test.ts fixture
apps/web/src/api/gallery.ts                  convertEntryAuthors + 类型
apps/web/src/GalleryApp.vue                  按钮 / 提示 / 处理函数
apps/web/src/i18n.ts                         4 条中英文案
apps/web/tests/gallery-app.test.ts           memory API + 2 个用例 + auto-unmount
eslint.config.mjs                            忽略 .hermes/**
docs/roadmap.md / docs/http-api.md / docs/api-contracts.md / docs/current-architecture.md
```

第二轮（Hitomi 导入修复）：

```text
apps/server/src/import/site-probe.ts          language 容错 + 缺文件跳过 + 精确错误消息
apps/server/src/http/app.ts                   isExportDataError → 400 保留原始消息
apps/server/tests/import/site-probe-import.test.ts           3 个新用例 + 作者导出 fixture
apps/server/tests/integration/http-routes.integration.test.ts 预览路由用例
apps/web/src/AddEntryPage.vue                 已跳过条目列表
apps/web/src/i18n.ts                          import.skippedItems
apps/web/tests/gallery-app.test.ts            已跳过条目渲染用例
docs/import-commit.md                         导入容错与跳过规则
```

第三轮（导入评分改为按作者 + 排序回退）：

```text
packages/shared/src/schemas/import.ts    importAuthorRatingSchema、authorRatings、authorRatingCount
packages/shared/src/schemas/api.ts       ratingSortSchema.applyAuthorRating
packages/shared/src/index.ts             导出新 schema/类型
packages/shared/tests/api-contract.test.ts           契约用例（新 describe）
apps/server/src/import/commit.ts         applyAuthorRatings（事务内、维度镜像）
apps/server/src/repositories/producer-repository.ts   findProducerIdByName
apps/server/src/repositories/rating-repository.ts     findRatingSlotId
apps/server/src/repositories/entry-tag-repository.ts  authorRatingSortValueSql（<4 作者规则）
apps/server/src/database/probe.ts        新检查 + commit fixture 补 authorRatings
apps/server/tests/integration/import-commit.integration.test.ts     2 个新用例 + 7 个 fixture
apps/server/tests/integration/facet-filter.integration.test.ts      回退排序用例
apps/server/tests/integration/{taxonomy-repository,template-export}.integration.test.ts  fixture
apps/web/src/AddEntryPage.vue            移除作品评分、作者评分开关、批量预览首件
apps/web/src/components/FacetFilterBar.vue  排序下拉的"应用作者评分"选项
apps/web/src/i18n.ts                     3 条新文案 + 移除 import.ratingsHint
apps/web/tests/gallery-app.test.ts       2 个新用例（替换原批量评分用例）+ fixture
apps/web/tests/gallery-api.test.ts       mapping fixture 补 authorRatings
docs/import-commit.md / docs/http-api.md / docs/current-architecture.md / docs/roadmap.md
```

第九轮（导入时别名链接）：

```text
apps/server/src/import/commit.ts                        解析出 canonical 后先按名字找既有作者
apps/server/tests/integration/import-commit.integration.test.ts  别名链接用例
docs/import-commit.md / docs/roadmap.md
```

第十二轮（作者页每页数量）：

```text
apps/web/src/AuthorPage.vue                     作品每页数量按布局计算并与窗口联动
apps/web/tests/author-page.test.ts              页大小与分页用例
apps/web/tests/gallery-app.test.ts              作者分页用例 fixture 增到 40 件
docs/current-architecture.md / docs/roadmap.md
```

第十三轮（批量复核页存为临时合集）：

```text
packages/shared/src/schemas/api.ts                       临时合集请求/响应契约
apps/server/src/repositories/collection-repository.ts    createCollectionFromEntries（事务 + 编号）
apps/server/src/http/app.ts                              POST /api/collections/temporary
apps/server/tests/integration/collection-repository.integration.test.ts  2 条用例 + 1 条路由用例
apps/web/src/api/gallery.ts                              createTemporaryCollection
apps/web/src/GalleryApp.vue                              复核页按钮 + 结果提示
apps/web/src/i18n.ts                                     import.batchCollection* 与 error.batchCollection
apps/web/tests/gallery-app.test.ts                       memory API + 组件用例
docs/http-api.md / docs/current-architecture.md / docs/roadmap.md
```

第十轮（复核页再次为空）：

```text
apps/web/src/components/PagedCardGrid.vue   本地切片按 pageCount 钳制
apps/web/src/GalleryApp.vue                 复核页按 runId 使用独立 page-key + 加载失败不再静默
apps/web/tests/paged-card-grid.test.ts      本地分页回归用例
apps/web/tests/gallery-app.test.ts          批次先后分页端到端用例
```

第十一轮（合并后的外键违规）：

```text
apps/server/src/import/merge-producers.ts               迁移作者评分 + 清理悬空评分行 + 计数
packages/shared/src/schemas/api.ts                      ratingsRelinked
apps/server/src/http/app.ts                             计数聚合透传
apps/web/src/AdvancedEditingPage.vue / i18n.ts          报告明细显示迁移的评分数
apps/server/tests/integration/merge-producers.integration.test.ts  新用例
docs/import-commit.md / docs/roadmap.md
```

第四轮（作者合并检测）：

```text
apps/server/src/import/merge-producers.ts    mergeKey（_ - . 视为空白）+ separatorRank
apps/server/tests/integration/merge-producers.integration.test.ts  3 个新用例
docs/import-commit.md / docs/http-api.md     合并规则说明
```

第五轮（标题缩减）：

```text
packages/shared/src/schemas/api.ts           titleShorteningChange/Plan/Apply 契约
apps/server/src/repositories/title-shortening-repository.ts   新文件：规则 + 计划 + 执行
apps/server/src/http/app.ts                  entries/titles/plan 与 /apply（含备份）
apps/server/tests/integration/title-shortening.integration.test.ts   5 个用例
apps/server/tests/integration/http-routes.integration.test.ts        路由用例
apps/web/src/api/gallery.ts                  planTitleShortening / applyTitleShortening
apps/web/src/AdvancedEditingPage.vue         「标题缩减」标签页 + works-changed 事件
apps/web/src/i18n.ts                         advanced.titlesTab 与 title.* 文案
apps/web/tests/gallery-app.test.ts           memory API 实现 + 组件用例
docs/http-api.md / docs/current-architecture.md / docs/roadmap.md
```

第六轮（批量导入临时合集修复）：

```text
apps/web/src/AddEntryPage.vue                批次结束事件改为发送解析后的 Gallery 类型
apps/web/src/GalleryApp.vue                  临时合集只按 Entry id 查询，不再带 entryType
apps/web/tests/gallery-app.test.ts           新增「typed Gallery spelling」用例
```

第七轮（导入 hews 报 500）：

```text
apps/server/src/import/commit.ts             collectTags 保留首个 Facet + facetLabel + warnings
packages/shared/src/schemas/import.ts        importCommitResultSchema.warnings
apps/server/tests/integration/import-commit.integration.test.ts   冲突用例
apps/web/src/AddEntryPage.vue                batchImported 带上 warnings
apps/web/src/GalleryApp.vue                  临时合集页显示 warnings
apps/web/tests/gallery-app.test.ts           警告渲染用例
docs/import-commit.md / docs/roadmap.md
```

第八轮（作者搜索别名）：

```text
apps/server/src/repositories/search-ranking.ts          rankSearchResults 增加 alternateTextsOf
apps/server/src/repositories/producer-tag-repository.ts 搜索时把别名拼写纳入排名
apps/server/tests/integration/search.integration.test.ts 别名命中用例
apps/web/src/SearchPage.vue                             结果卡片显示命中的别名
apps/web/tests/gallery-app.test.ts                      别名卡片用例
docs/http-api.md / docs/current-architecture.md / docs/roadmap.md
```

仓库外（`D:\Project\Dataextracted\site_probe\`）：

```text
18comic_vip/src/taxonomy.py, src/text_normalization.py, 应用Tag审核.bat,
  src/import_album.py, src/import_favorite.py, src/import_core.py,
  tests/test_taxonomy.py, tests/test_import_v2.py, README.md, DATA_SCHEMA.md,
  pyproject.toml, uv.lock, exports/taxonomy_dictionary.json, exports/tag_review.csv
hanime1_me/src/tag_policy.py, src/text_normalization.py, tests/test_tag_policy.py,
  README.md, DATA_SCHEMA.md, pyproject.toml, uv.lock, exports/taxonomy_dictionary.json
```

## 二十三、未决与风险

1. 18comic 353 个 Tag 待人工审核（决定前不要 apply）。
2. `multiple author` 拼写待用户确认（见第三节）。
3. 真实库里已有约 41 个「零关联作品」的作者行（第 1 项之前就存在，来自历史删除/导入），
   它们已被隐藏但行仍在。若想彻底清理可用 `DELETE /api/producers/:producerId`；本轮未动。
4. 工作区改动未提交；`.hermes/` 未纳入版本控制（含本文件与脚本），是否提交由用户决定。
5. 提交时注意 `apps/server/.data/`（含真实库与 WAL）永远不要纳入版本控制。
6. `hitomi_la/exports/artist_dmm.com` 文件夹根部没有 `metadata.json`，拖入仍会失败
   （报 500，因为缺文件不是 `Export …` 前缀的错误）。用户表示不用管；若要支持，
   可在 `loadSiteProbeExport` 读取根文件处包一层友好消息。
7. `sole_work` 的清单仍列着 `888260`，每次导入都会出现一条跳过警告。想消掉它就把该 id
   从 `sole_work/metadata.json` 的 `items` 里删掉；我没有改用户的导出文件。
8. 作者评分维度**不在导入界面独立维护**：它镜像自该 Gallery 的 Entry 评分维度（按名字），
   首次写入作者评分时在作者分区自动建同名槽。所以在作者页用 `+ Rating` 另加的名字不会
   参与"应用作者评分"排序（排序按名字找同维度）。
9. 批量导入的作者区只列出**第一件作品**的作者；混合作者的目录需要之后在作者页补评分。
10. **正在采集的 `exports/favorites_spechzy_folder_3789293`（82 部作品）的预览图仍是乱序**：
    下载它的是改动前的采集进程。收工后、导入前必须先跑修复命令（见第二十节）；重启采集器
    之后新下载的预览图会自动还原。同理，任何在本次修复之前采集、尚未修复的文件夹都要先修再导。
11. 重新导入 `favorites_spechzy_folder_3401826` 时会重新复制预览图/封面并重建缩略图
12. **删除 `site_probe/exports/` 前必须核对两件事**（2026-09-12 检查结果）：导入侧数据是安全的（hitomi 4775 条 entry 的封面/预览引用全部指向 `.data/assets` 且文件齐全，无任何引用指向导出目录），但导出树里 hitomi 有 **750 部作品从未入库**（77 个作者文件夹、约 222MB 图片，清单见`.hermes/tmp/hitomi-unimported.json`），删掉即永久丢失；同时 `.data/backups/` 里只有 09-07、09-09 的小备份（277/279 条），远不是全量。顺序应为：先补导或保留这些文件夹 → 跑 `pnpm db:backup` 生成含 `.data/assets` 的全量备份 → 再删导出。其他站点（18comic/hanime/baozimh）需各自做同样的核对。；缩略图
    按内容哈希命名，首次访问时按当前字节生成，也可跑 `pnpm media:thumbnails` 预生成。

## 二十四、常用命令

测试/门禁必须用启动器选定的项目本地 Node（当前为 Hermes 的 Node 22），否则 jsdom
用例会大面积误报：

```bash
export PATH="/c/Users/hzy/AppData/Local/hermes/node:$PATH"
cd /d/Project/TagTraceTrove
npm exec --yes --package=pnpm@10.15.0 -- pnpm typecheck
npm exec --yes --package=pnpm@10.15.0 -- pnpm lint
npm exec --yes --package=pnpm@10.15.0 -- pnpm test
npm exec --yes --package=pnpm@10.15.0 -- pnpm test:integration
npm exec --yes --package=pnpm@10.15.0 -- pnpm db:probe
cd apps/server && node_modules/.bin/tsx src/database/doctor-cli.ts .data/library.db
```

提取侧（各自目录，不访问网络）：

```bash
cd /d/Project/Dataextracted/site_probe/18comic_vip && uv run pytest -q
cd /d/Project/Dataextracted/site_probe/hanime1_me && uv run pytest -q
uv run python -m src.taxonomy                      # 18comic：只刷新字典
uv run python -m src.taxonomy --apply              # 18comic：应用审核结果
uv run python -m src.tag_policy --inventory        # hanime：只刷新字典
```

18comic 预览图还原（存量导出离线修复，默认只预览）：

```bash
cd /d/Project/Dataextracted/site_probe/18comic_vip
uv run python -m src.repair_scramble --export-root exports/favorites_spechzy_folder_3789293          # 看
uv run python -m src.repair_scramble --export-root exports/favorites_spechzy_folder_3789293 --apply  # 写（含备份）
uv run pytest -q                                                                    # 采集器测试
```

T³ 侧按 collection 批量删除 entry（走 DELETE 路由，顺带清理资源目录）：

```bash
node .hermes/tmp/scramble/delete-temp-entries.mjs <id列表文件> [http://127.0.0.1:8765]
```

真实数据副本演练（只读源库，写入临时副本）：

```bash
cd /d/Project/TagTraceTrove/apps/server
node_modules/.bin/tsx ../../.hermes/tmp/multi-author-rehearsal.mts
```

## 二十五、已知陷阱

1. **服务端改动必须重启 T3（最容易踩）**：打包入口用 `tsx` 且**没有 watch**，服务进程
   只在启动时加载一次代码；只重建前端 dist 会造成"新前端 + 旧服务端"的契约错配。用户
   实际遇到过一次：新前端用严格 schema 解析旧服务端多返回的 `keptAuthors`，弹窗里出现
   Zod 报错文本，随后的点击又拿到旧服务端的 409 `Request conflicts with current data`，
   看起来像算法 bug，其实是版本错配。判断方法：比对 `Get-CimInstance Win32_Process` 里
   tsx 进程的 `CreationDate` 与源文件 mtime；也可以用只读查询试探（例如 query 接口是否
   接受新增字段）。**改完服务端代码 → 重启 T3；只改前端 → 刷新即可。**
2. **Node 版本**：命令行里的 Node 26 自带全局 `localStorage`，vitest 的 jsdom 环境不会
   覆盖它，会让 122 个用例以 `window.localStorage` undefined 误报。用 Node 22。
3. **Git Bash 路径翻译**：`uv run python ... /tmp/x` 这类**参数**会被 MSYS 翻译成
   Windows 路径，而写在 `python -c "…'/tmp/x'…"` **字符串里**的不会，容易指向不同位置。
4. **私有数据**：`site_probe/exports/`、`apps/server/.data/` 都不进版本控制；测试一律
   使用内存库/临时文件库，绝不碰 `.data/library.db`。
5. **`.hermes/tmp` 已被 eslint 忽略**，但脚本若被误放进 `apps/`，`no-undef: console`
   之类的规则会报错。
7. **前端改动必须重新构建，浏览器才看得到**：`T3.bat` 现在会在源文件比 `dist/index.html` 新时自动构建（此前只在
   dist 缺失时构建，于是出现过「改了源码、浏览器仍跑旧代码」导致作者别名 Save 无反应的 bug）。服务端改动仍必须重启
   T3（见第 1 条）。SW 的 shell 已改为 network-first，但用户浏览器里的旧 SW（v1）可能还需一次刷新才会被 v2 取代。
6. **18comic 的作品页图在 CDN 上就是打乱状态**：`media/photos/<ID>/<页>.webp` 按 MD5 推导出的条数横向切条打乱，站点在浏览器里用 `scramble_image`（`scramble_id = 220980`）重排；直接下载必然得到错乱内容——「预览图和站点不一样」不是采集 bug，必须还原（`site_probe/18comic_vip/src/image_scramble.py`）。封面走 `media/albums/`，未打乱，别去还原它。还原是对合运算（做两次回到原状），因此修复工具靠写进 webp 的 XMP 标记判重，不能盲目重跑两次。
