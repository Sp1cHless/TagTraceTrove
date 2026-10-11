
### 阶段：作者评分的两类 + 作者锚定画廊（迁移 039/040）（2026-10-08）

用户读了上一节的研究后拍板六条：① 现有 `producer` 数据算「作品概括」；②「作者自身」也要挂画廊（这才是"同 gallery apply"的核心）；
③ 允许按作者类筛选；④ 与作品维度的对账要显式；⑤ "apply"指的是**模板（用了哪些维度）**，不是把某个作者的分数抄给别人；
⑥ 不考虑主导 gallery 翻转，把作者**锚定**在一个 gallery 上（waterring 就锚定在 Comic）。其余按我给的方案做。

**先说结论：模型与迁移这一半已完成并全绿；"按作者类筛选"和离线/手机那半边没做**（理由在最后）。

**数据模型（实测的现状，不是设计稿）**

```text
  rating_slots.subject_kind 现在三个值：
    'entry'        作品自己的维度
    'producer'     作品概括 —— 本画廊**作品**的维度，对该作者整体打一次分；没单独评分的作品继承它
                   （它就是 039 之前唯一存在的那一类，所以旧数据意义不变、继承 SQL 不用改）
    'author_self'  作者自身 —— 关于人/社团的维度，与作品维度无关；演员不再被按电影的「剧情」打分
  两类作者维度都按 (类, 画廊) 分区 → 维度集合是共享的，"apply 到同画廊所有作者"是模型属性，不是批量复制。
  producers.gallery_anchor：作者的所属画廊，从"每次读都派生"改为"存下来"（039 用旧的派生规则回填了全部 764 位）。
```

用户库里量到的漂移正是这一条的证据：`Comic` 的 entry 与 producer 两边维度名完全一样（导入镜像出来的），而
`AV`/`电影`/`小说` **只有 entry 维度、producer 侧一个都没有** —— 那三个画廊的作者今天根本没有评分行可填。

**迁移是一次高风险操作，过程和两次实测救回的教训**

加第三个 `subject_kind` 必须重建 `rating_slots`（SQLite 不能改 CHECK），而它是 `entry_rating_values` 与
`producer_rating_values` 的**外键父表且是 `ON DELETE CASCADE`**。迁移在事务里跑（`applyAllMigrations` 包了一层），
所以 `PRAGMA foreign_keys=OFF` 是空操作。实测两件事：

```text
  1. 改名法（ALTER TABLE rating_slots RENAME TO ..._old）**不可用**：实测子表外键被改写为 REFERENCES "parent_old"，
     随后 DROP 旧父表触发隐含 DELETE，子表被级联清空（3 行 → 0 行）。`PRAGMA legacy_alter_table=ON` 在事务内没能
     阻止这次改写。也就是说"更简单"的那个写法会**静默毁掉全部评分值**。
     正确顺序（仓库 025/028/037 已有先例，本次在模型库上复验）：建新父表→建新子表→**先 drop 旧子表**→再 drop 旧父表→改名。
  2. 还有**两个 `entries` 上的触发器**（`entries_rating_layout_insert` / `_type_update`）引用 `rating_slot_layouts`。
     `ALTER TABLE ... RENAME` 会重解析所有触发器，漏掉它们就整条迁移中止（`no such table: main.rating_slot_layouts`）。
```

**一次必须记下来的事故：039 在我写完之后自动落到了正式库上**

我在 20:43 前后编辑 039 时，出现过一个中间态（14 个 drop 已写入、两个 `entries` 触发器还没写回）。**服务进程的下一次
`/api/sync/capabilities` 轮询就把它应用到正式库**（`buildSyncCapabilities` 内部调用 `applyAllMigrations`，和上一节记的
038 是同一个机制 —— 不需要重启）。于是正式库丢了那两个触发器，且 039 的 checksum 与我随后改好的文件不符 ——
那会让服务**下次启动直接因 checksum 不符而拒绝启动**。

处理方式遵守"迁移一经应用即不可变"：把 039 **逐字节还原成已应用的那份内容**（用记录的 checksum 反推并校验通过），
补丁另开 **040**（原样写回那两个触发器）。查证与结果：

```text
  正式库 039 checksum b744b53... = "当前文件去掉那两个重建块" 的内容 → 认定无误，040 由同一次轮询应用（12:45:31 UTC）
  评分值全程无损：entry 627 行/Σ2276、producer 779 行/Σ2793、摘要 bfdf769c… 在迁移前后完全一致；foreign_key_check 空、integrity ok
  全新安装路径另测：001→040 依次应用全部成功，最终 14 个触发器，第三类可用、其分区行按需生成并正常记账
```

**落地的部分**

```text
  迁移  039（三类 + anchor + 回填）/ 040（补触发器的修正），均有注释说明"为什么不能先 drop 父表"
  仓储  RatingSubjectKind 三类；AUTHOR_RATING_KINDS；listAuthorSelfRatings；setProducerRating 同时接受两类；
        createProducerRatingSlot({kind})；reorderProducerRatingSlots 从载荷推断类（拒绝混合）；
        reconcileWorksSummarySlots（显式、只建维度名、不碰任何分数）；setProducerGalleryAnchor；
        galleryTypeForProducer → COALESCE(anchor, 派生)
  契约  ratingSlotSchema 带 subjectKind；createAuthorRatingSlotRequestSchema（subjectKind 默认 producer）；
        authorDetailResponseSchema.authorSelfRatings（可选，离线半边未动）；reconcile 响应；
        sync 的 ratingSlot/layout 行 schema 接受第三类；能力位 offlineAuthorSelfRatings（>=39）
  路由  POST /producers/:id/rating-slots 带类；POST .../rating-slots/reconcile；PUT .../gallery-anchor
  UI    作者页一个区块、两组（作品概括 / 作者自身），组标题+一行说明；同画廊维度集合本就共享，增删排序自动作用于
        该画廊所有作者；「套用本画廊的作品维度」按钮只出现在作品概括一组；画廊徽章在编辑态可点改（锚定）
  测试  新增 rating-class-migration 集成测试 3 条（重建不丢值、三类共存、锚点回填）；作者页新增 1 条（两组互不串）
        并更新既有的调用断言；门：typecheck 0 / eslint 0 / 单测 1203 / 集成 635 / build ✓ / db:probe 49 项全 PASS /
        db:doctor PASS
```

**没做的两件（本轮到此为止）**

1. **按作者类筛选/排序**：需要把 `listFacetFilterOptions` 的槽位列表扩到作者两类、把 `buildFacetFilterQuery` 里
   entry-only 的评分筛选与排序泛化到"每一类各有一套 per-work 有效值"（作品自身 → 本作品的值；作品概括 → 本作品的值
   ?? 作者概括（<4 作者）；作者自身 → 只取作者的自身分）。这是现有测试钉得最紧的一段，改动面比上面所有加起来还大，
   所以单独一轮做。今天已有的：排序下拉里每个维度仍可切"👤 按作者评分"（即作品概括）这一模式。
2. **离线/手机那半边**：快照会自然带上 `author_self` 槽位与值（表的 SELECT 是全量），但 `offline-api` 的
   producer 槽位白名单、`effectiveRating` 的比较器、Android 侧都还没认第三类 —— 归另一位，能力位已留出。
3. 另外记一处**已知缺口**：新作者的锚点仍靠派生，直到有人显式锚定。我试过"第一次建关联时就冻结锚点"，但作者页测试
   立刻暴露它会**取决于先关联了哪部作品**（同一批作品的两位作者可能显示不同画廊），比派生更不可预测，因此撤回。
   要在导入时定锚（那批作品同属一个画廊，值唯一）是下一步的小改动。
