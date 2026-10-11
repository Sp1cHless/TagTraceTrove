
### 修正：规则要命名"你看到的那一组"，不是"全页同名的所有元素"（jable 模特页那一轮）（2026-10-05）

用户：**「（列表适配器的完整运行日志）… 24 card(s) in this set … [WARN] 作品 id 标了，但在 24 张卡上没有任何
一条规则能同时读到它 … [CHECK] title: read nothing on 121 of 145 card(s) … the runtime reads 0 card(s)」**

```text
日志里有两个数字打架：选择页给的是 **24**（你看到的那一组），而检查却在 **145** 张卡上量 ——
`div.col-6.col-sm-4` 在这一页出现 145 次（24 个作品 + 111 个标签云），
所以**发出去的 row_selector 只写了类名**，运行时/检查读的是全页 145 个元素：
  · 你标的 `作品 id` 在标签卡上读不到 → "no rule reads it on all cards" → source_id 没学到 →
    适配器装上了却读 0 张卡（正是日志最后那句）；
  · title/cover 也一样（121/145、120/145 读不到）。

根因：上一轮我只把**选择页的集合**收窄到"组自己的块"（`cards_of_group`），
但**写进规则的 `row_selector` 仍然是裸类名** —— 同一件事的两层，只修了一层。

修法：规则可以带 **`scope`**（选择器词汇本来就有 `scope`/`in`，字段规则一直在用）：
  · Builder：`row_selector_for()` 用**同一个解析树**验证"把类名读在组自己的块里"是否正好等于
    你看到的那一组（`Element.order` 是全局计数器，两次 parse 的对象 identity 不可比 —— 所以
    整条链路共用一次 parse）；
  · 运行时：`rows_of()` 支持字符串或 `{select, scope}`，`read_listing` 用它读行；
  · 检查：`_rows()` 走同一个 helper —— 检查与爬取读的行必须一致；
  · 该页实测：`row_selector = {"select": "div.col-6.col-sm-4", "scope": "section.pb-3.pb-e-lg-40"}`
    → 读到的行 **24**（不是 145），`check_over_cards` **无发现** ✓，
    运行时（走 site.json 文件）读到 **24 张卡、id/title/cover 齐全** ✓（修之前是 0 张）。

顺带修掉日志里那三条 CHECK 各出现两次、以及"page 2 adds no id"这条**无意义的判断**：
两个框填同一个地址时，检查现在**按地址去重**（每页只查一次），并明确说
"2 个样本里有 1 个重复了地址，实际检查的页数更少" ✓

守卫：`tests/test_listing.py::test_a_set_whose_class_is_shared_ships_the_block_that_tells_it_apart`
（共用类名的 24 + 111 两段；断言 scope == section.videos、检查无发现、运行时读到 24 张且 id 正确），
退回旧行为跑一遍红在 `assert None == 'section.videos'` ✓

门：工具 pytest 370；check_undefined_names 74/0；verify_doors 25/25；verify_against_recordings PASS 327/0。
```
