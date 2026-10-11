
### 阶段：作品 id 就是数字（用户拍板）；两条路径现在给出同一个身份（2026-10-04）

用户：**「就数字吧。实际上这些数字完全也是应用内部使用的，用户不需要也不能看见。只需要保证在一个
网站内部有区分、能定位就行」**

```text
问题（上一节量到的）：同一篇作品两个身份 —— 列表半边给 3095（卡片链接里的数字），
作品半边给 3095.html。根因：作品侧没有"标 id"这一步，身份是 `declarative.read_work` 现算的
（target 正则的命名组 id，没有就退到地址最后一段），而目标正则由 `learn.url_pattern_for` 从样本
地址推导 —— 它把"变化的最后一段"整段捕获成 `([^/]+)`，于是 `.html` 一起进了身份。

改（一处，规则生成里）：`url_pattern_for` 现在把**最后一段里的最后一个数字**捕获为 `(?P<id>\d+)`，
与卡片侧 `card_rule_for_id` 同一套判断（同一句 doctrine：作品地址里带着自己的标题，只有**最后**
那个数字是作品的）。同一段里的其他内容：
  · 数字后面的固定尾巴（`.html`）写成**可选**字面量，所以站点哪天不带扩展名也照样匹配；
  · 末尾锚 `(?=[/?#]|$)`——**它就是"取最后一个而不是第一个数字"的那一步**（`…-abc-2025-title/`
    否则会报 2025）；它允许路径分隔符/查询/片段/结束，所以 `…/album/1472965/`、`…/novel/4525.html`、
    `…/4525.html?page=2` 都是同一个作品；
  · 数字前面是随作品变的标题时用 `[^/]*?` 兜住；整段没有数字时**照旧**整段捕获（纯 slug 站点不变）。
四种地址形状都量过（数字带扩展名 / 数字带尾斜杠 / 标题+尾部数字 / 纯 slug），每一条都能匹配它自己的
样本，纯 slug 那条仍然得到 `abc-title`。

实测（真适配器，两条门）：
  · 重建 bilinovel 作品半边（同样三个 10-03 session，round trip 4/4）→ 目标正则变成
    `^https?://www\.bilinovel\.com(?:/novel)/(?P<id>\d+)(?:\.html)?(?=[/?#]|$)`；
  · `match_target('…/novel/4525.html')` → `('work', {'id': '4525'})`，`declarative.read_work` 的
    `source_id` = `'4525'`；
  · `probe.py <作品 URL>` → `target work 4525`（原来是 `4525.html`）；
  · `probe.py --limit 1 <列表页>` → 导出 `items/2906/`（数字），作品页那半边读出来的 id 也是数字；
  · 顺手清掉我 16:56 那次探针留下的三/四个 `.html` 命名目录（我造的重复品）；用户自己 00:59
    那次运行的 `sole_work/items/3095.html` **没动**。

守卫：`tests/test_learn.py::test_the_pattern_captures_the_number_that_names_the_work`（四种形状 +
查询/去扩展名 + 纯 slug + "不匹配别的路径"），退回旧捕获跑一遍红在
`assert ['4525.html', '4057.html'] == ['4525', '4057']` ✓

门：pytest 361；check_undefined_names 73/0；verify_doors 25/25；verify_against_recordings PASS 327/0。
```
