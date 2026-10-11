
### 修正：作品概括不再作为可选维度；作品维度一律"自己的分，没有就用概括分"；新增筛选默认 greater than 三颗星（2026-10-08）

用户看过筛选列表后给了两条：①「作品概括」的选项**直接不出现**更好 —— 直接用作品自己的 rating，没打分的作品自动采用 author 下的
work summary，压根不需要单独选；②新增评级筛选行现在是默认 `equal` 三颗星，改成默认 `greater than` 三颗星。

**① 的做法：把"回退"从一种模式变成作品维度的读法。** 之前 entry 与 producer 是两个可选维度、`applyAuthorRating` 是第二种模式；
现在 `ratingValueSql` 里 `entry` 与 `producer` 合并成同一条表达式（作品自己的值 → 否则名下作者该同名概括维度的最高分，作者数 ≥ 4
不继承），**筛选与排序都一样**：

```text
  listFacetFilterOptions 只返回两类：作品的自身维度（不带后缀）+ 作者的自身维度（带 · The author）
  producer 槽位不再出现在选项里（API 仍接受它：旧筛选/手机记着它时，它问的是同一个问题，测试钉住这一点）
  applyAuthorRating 在服务端不再改变任何东西；UI 仍发 true —— 离线副本的比较器靠它排序，
    不发就会让手机按别的顺序排（两半必须一致）
  随后删掉两条只有旧下拉在用的 i18n 键（filter.sortByAuthorRating / filter.authorRatingHint，两种语言各一）
```

**语义变化必须记下**：按作品维度筛选，以前是"只看作品自己的值"（有一条既有断言写着 "The filter stays entry-only:
an Author-rated work is still 'unrated'"），现在作品没有自己的值时用作者概括分 —— 那条断言随之改写成"只有无法继承的作品
（四作者）才算 unrated"。这正是用户要的：不再需要单独选概括。

**②**：`addRatingRow` 的默认从 `{operator:'eq', stars:3}` 改成 `{operator:'gt', stars:3}`（配一句注释：评分筛选多半是问
"我想要的那些"）。整题：既有用例里"默认行 = 等于 3 星 → 只有 Hades II 命中"随之改成"大于 3 星 → Endfield（5）命中、
Hades II（正好 3）不命中"。

**测试更新**：probe 那条检查改成断言**两种 flag 给出同一个顺序**（回退已无条件）；facet-filter 三处（回退用例、按类用例、
选项列表 = 只列出可选的两类）；web 两处（筛选栏标签无 "Works summary"、排序下拉每个维度只有一个选项且发出
`applyAuthorRating: true`）。门：typecheck 0 / eslint 0 / 单测 **1207** / 集成 **637** / build ✓ / db:probe 49 项 PASS / db:doctor PASS。

**运行状态**：这两处里"默认 gt"和"下拉只有一个选项"是客户端（刷新即可），而**选项列表与取值表达式在服务端 —— 需要重启服务**。
