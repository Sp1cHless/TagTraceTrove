
### 阶段：删除 rating 维度（× 在箭头上箭头左边 + 二次确认弹窗）（2026-10-08）

用户要求：加删除 rating 的功能；× 放在上箭头左边；点删除弹窗写「delete this will remove from all entries under same
gallery」并要求二次确认。这条需求是他自己撞出来的——上一轮那条跑错类目的 `外貌颜值` 需要删掉，而当时**没有任何删除入口**。

**服务端（两页共用一条实现，按所属分区把关）**

```text
  DELETE /api/entries/:entryId/rating-slots/:slotId      守护：该槽位必须是这张 Entry 所属画廊的 'entry' 维度
  DELETE /api/producers/:producerId/rating-slots/:slotId 守护：该槽位必须是该作者两类作者维度之一，且属于其画廊
  实现：requireSlot(...) 通过后 DELETE FROM rating_slots WHERE id = ?。值表是 ON DELETE CASCADE，随行一起走；
        分区版本由 rating_slots_layout_delete 触发器自己推进并记账 —— 不需要任何额外代码。
```

**删一行，就只删那一行。** 作品概括里同名的那个维度是**另一行、另一个主体**，所以删作品维度不会带走作者已经打过的分，
反之亦然（集成测试把这两侧都钉住了）。这是刻意的：一个 author 的"作品概括·涩情程度"可以独立于作品维度存在。

**UI（作者页与作品页都加了）**：`×` 放在 `↑ ↓` 左边。它与右边星条里那个 `×` 是两件事 ——
那个**清空本行的分数**，这个**删除整个维度**，位置分开就是为了不让人点错；星条里的 `×` 只在有分数时出现，
新的这个在编辑态一直在。点击后弹对话框（复用应用里既有的 overlay/dialog 外壳）：

```text
  标题：Delete “{name}”?
  正文（作品页）：Delete this will remove it from all entries under the same Gallery, together with every rating on it.
  正文（作者页）：Delete this will remove it from all authors under the same Gallery, together with every rating on it.
  按钮：Cancel / Delete —— 未确认前不发任何请求，取消也同样不发
```

作者页那句我按"作者"改写而不是照搬"entries"：作者自身那一类删掉影响的确实是同画廊的所有作者。要统一成一句就说一声。

**测试**：集成新增一条（删一个作品维度：两张 Entry 都少一行、值级联清零、别的画廊同 kind 的维度不受影响、
作者自身类与作品概括同名类各自保留、跨画廊/跨类的槽位被 400 拒绝、删作者自身维度同样生效、integrity/fk 干净）；
作者页新增一条（点 × 先弹窗、取消不发请求、确认后才 `deleteAuthorRatingSlot(3, 70)`、行从界面上消失）。
门：typecheck 0 / eslint 0 / 单测 **1205** / 集成 **636** / build ✓ / db:probe 49 项 PASS / db:doctor PASS。

**运行状态（第三次同一类）**：写到这里服务进程起于 **21:48:56**，而删除这条路是 21:52 之后写的 ——
实测 `DELETE /api/producers/:id/rating-slots/:id` 与 `/api/entries/...` 都回 `Route not found`，
也就是说**要重启服务才能用这个 ×**（同时缺的还有上一轮的自动镜像）。用户那条 `外貌颜值` 重启后从作者页直接删即可。
