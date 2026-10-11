### 修正：列表规则的三处"量出来的"和"发出去的"不是同一条（2026-10-05）

用户：**「再检查一下规则。列表适配器的抓取来来回回错了好多次了」** —— 这一轮不再修某一个症状，
而是把"规则"这条链上的三个读法对齐：**测量**、**检查**、**运行时**。

```text
上一轮的收尾测量仍然不对：id 规则选出来是
  {"select":"div.img-box.cover-md a","attr":"href","unique":true,
   "filter":["\-(\d+)(?=[?#]|$)"],"group":1}
而检查说 "source_id: read nothing on any of the 24 card(s)" —— 规则装上了却一个 id 也读不到。
```

三个缺陷，都在同一页（jable 模特页）上量出来：

1. **地址以斜杠结尾时读不出 id。** 卡片地址是 `/videos/snos-357/`，而 id 模式锚在
   "扩展名 / 查询 / 结尾"三者之一上 —— 数字后面是 `/`，三者都不是，于是**一个都匹配不上**：
   旧模式对 `/videos/snos-357/` 实测 `re.search → None`。`/album/1472965/` 这类
   "纯数字段 + 斜杠"同理。
   修法：把尾随斜杠放在锚**之前**（`\-(\d+)/?(?=[?#]|$)`），而不是放进锚里 ——
   放进锚里会让模式匹配"第一个后面跟着斜杠的数字"（`/2025/05/work-123/` 会读成 `2025`），
   而那正是这个锚存在的理由。

2. **`unique` 变体量的是没窄化的规则，发出去的却是窄化后的。** 量的时候它读的是整条地址
   （3/3 填满、互不相同、形状也对 → 满分），而写进 `site.json` 的规则还带着 id 过滤，
   那条规则读出来是空的。**量的是 A，发的是 B** —— 这正是它被选中、并让 id 规则读不到的原因。
   修法：测量统一走 `_values_over_rows()`：按运行时的读法读（`unique` 是**跨行**判定，
   不是行内判定），并且在量之前先做 `_as_shipped` 会做的那次窄化。

3. **检查器把 `unique` 字段按行读。** 一张卡上同类名下有多条链接时，运行时跨行丢掉重复值、
   留下"只出现一次"的那条；检查器却逐行取第一个匹配，于是把**正确**的规则报成"每张卡同一个 id"。
   修法：检查器走同一个 `_values_over_rows()`。**同一条规则，同一个读法。**

顺带：id 的窄化现在有**两种**，由测量决定 —— 数字形（数字站）与整段形（slug 站），
都作为候选摆上桌（`segment_rule_for_id`）。这一页实测：

```text
  · 数字形读 23/24（漏掉 sone-560-b —— 它的数字不在结尾）；
  · 整段形读 24/24 → 整段形胜出，发出去的是
    {"select":"div.img-box.cover-md a","attr":"href",
     "filter":["/videos/([^/]+)(?=[/?#]|$)"],"group":1}
```

端到端（用记录下来的会话 + 当时保存的那一页重放，走工具自己的三段）：

```text
  · 学到的规则：source_id（上式）、cover_url、detail_url；row_selector 带 scope；
  · check_over_cards：只剩"2 个样本里有 1 个重复了地址"（两个框填同一个地址，是说明不是缺陷）；
  · 运行时读到 24 张卡，id = snos-357 / snos-374 / snos-303 …（修之前是 0 张）。
  · missing: ['title'] 是诚实的：候选里本来就有正确的那条（cand_0005 = h6.title a），
    而记录下来的标注选的是 cand_0003（整张卡的文本，也就是行本身），规则正确地把它拒掉。
```

守卫（三条，都退回旧行为跑红过）：

```text
  · tests/test_listing.py::test_a_slug_address_reads_its_id_and_the_rule_reads_every_card
    —— 斜杠结尾的地址；旧模式 re.search(..., '/videos/snos-357/') → None（新：True）；
  · tests/test_listing.py::test_a_candidate_is_scored_as_the_rule_it_will_ship_as
    —— "量 = 发"的不变式；旧行为下 unique 候选满分，而它发出去的那条只读 2/3；
  · tests/test_listing.py::test_the_check_reads_a_unique_field_the_way_the_runtime_reads_it
    —— 检查器跨行读；旧行为逐行读到三个完全相同的值（会报"同一个 id"），运行时读到 101/102/103。
```

门：工具 pytest 375；check_undefined_names 74/0；verify_doors 27/27；verify_against_recordings PASS 327/0。
