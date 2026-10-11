
### 修正：学来的列表**永远只读第一页**（两个 pagination 字段写出来没人读）+ 编号分页器（2026-10-05）

用户：**「真实地址的2链接，知道用户层面看不到。因为这个网站第1页和第2页直接复制浏览器框的地址，就是一样的」**
（即：我上一条给的"填分页器里那个真实地址"的办法对用户不成立 —— 工具必须自己认出来）

```text
一、真正的病根（比 jable 的分页器更早、影响所有学来的列表）
  运行时读的是 **`next`**（`template.py`: `next_selector=raw_listing.get("next")`），
  而 Builder 写的是 **`next_selector`**（`listing.py` 的 draft）——**没有任何适配器写过 `next`**（实测
  把 `installed/` + `local/` 全扫一遍：只有 `next_selector` 与 `page_param`），
  于是**学来的列表每一条都在第 1 页停下**，规则明明在文件里、没人去查。
  `page_param` 同样只有解析、没有读者（`extract`/`declarative` 都不用它）——
  两个"分页配方"都是**写出来没人读**，症状一样：只有第一页。
  修：运行时读 `next_selector`（`next` 作为旧拼写仍接受）；`page_param` 由运行时自己走
      ——「本地址 + 该参数 +1」（第 1 页常常根本没有该参数，所以缺省按 1 算）✓
  实测：bilinovel 的列表现在 `listed page 1: 30 new` → `listed page 2: 30 new, 60 in total`
      → `page 3: 0 new`（停）✓ —— 修之前它一直只有 30。

二、jable 的编号分页器：不需要第二个地址也能走
  它的分页器把页号写在链接自己身上（`<span class="page-link active">01</span>` +
  `<a class="page-link" href="…/2/">02</a>`），地址栏不变、没有 `rel=next`、没有"下一页"箭头。
  既然页号在标记里，**证据就来自第一页本身**，不需要第二页样本：
  · 授权：`pagination_from` 认出"文字是数字、且地址是本页地址带上这个数字"的链接
    → `kind="numbered_pages"`，`next_selector={"select": "a.page-link", "page_numbers": true}`
    （`a[href]` 里的页脚 `2024` 之类被"同形状"判断挡掉）；
  · 运行时：读**当前页号**（地址最后的数字段，或页参数，缺省 1），取**文字为当前+1**的那个链接
    （选择器规则算不出算术，所以这一步由运行时做）。
  实测（真站、真页面，两个框填**同一个地址**）：第 1 页 24 篇 → next `…/2/` → 第 2 页 11 篇 →
  next 为 None（结束）→ **35 篇互不相同的作品** ✓

三、顺带修掉的假通过
  两个地址相同 + 页面上任何指回自己的链接（`href="#"`）曾被当成"下一页"，学出
  `filter: ['\\#']`（"任何含 # 的链接"）还报 `usable: True` —— 现在指回当前页的链接不算下一页；
  只有真的什么都认不出来时才说"两个地址相同、什么都没学到"。

守卫（三条，各退回旧行为验证过能失败）：
  · `test_the_next_page_rule_the_builder_writes_is_the_one_the_runtime_reads` —— 旧行为下
    `next_selector=None`（规则被丢掉）✓
  · `test_a_numbered_pager_is_walked_without_a_second_address` —— 授权认出 `numbered_pages`，
    并用运行时自己的路径走 1 → 2 → 3 → 停 ✓
  · `test_a_pager_that_never_changes_the_address_is_walked_from_its_own_numbers`（旧断言"学不到"已按新
    行为改写：现在学得到，而且不含那个 `#` 链接）✓
  另两条老测试的期望按新行为更新（`page_param` 现在真的会多走一页 ✓）。

观察（不是回归）：`--limit 40` 那次抓取里，第 2 页的部分作品报 "the page did not contain a work"，
而单独抓同一批 URL 全是 200 —— 像是**连续快速抓取被限流**；大爬取时值得留意（工具不做节流）。

门：工具 pytest 368；check_undefined_names 73/0；verify_doors 25/25；verify_against_recordings PASS 327/0。
```
