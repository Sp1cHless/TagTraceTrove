
### 修正：模型页的列表适配器把"标签云"当成了卡片集（一组卡片，两个数字）（2026-10-05）

用户：**「jable.tv尝试录入list规则，使用网站 https://jable.tv/models/12613c56a25c8efef14f7b7f6f9912e7/，
结果适配器是这样的：看看是不是通用适配器解决不了的网页」**（截图：60 张"卡片"全是 `/tags/Cosplay/`、
`/tags/stockings/` 这类标签链接）

```text
先量，结论：不是"通用适配器解决不了"，是**通用缺陷**。
  · 同一页：`div.col-6.col-sm-4` 出现 **145** 次，其中 **24** 个是这位模特的作品
    （`/videos/snos-357/`，带封面），**111** 个是站点的标签云（`/tags/…`，只有链接、没有图）。
  · 复现（同一条命令）：工具自己印的是
      `[0] 24 card(s)  selector='div.col-6.col-sm-4'  container='section.pb-3.pb-e-lg-40'`
    紧接着却印 `111 card(s) in this set` —— **同一个东西两个数字**，这就是线索。
  · 真因：`cards_of_group` 只用**类名**在整页重读成员（`select_all(root, group.selector)`），
    完全没用组自己知道的 `container`；随后"按多数链接类型收窄"这一步就跟着**污染块**走
    （111 > 24 → 收窄成标签）。于是给人点的集合是标签云，被标成"作品"的那张卡是标签，
    学出来的规则描述的是标签。`CardGroup.container` 的注释本来就写着 "the block they repeat
    inside"，但它只被用于打印那一行。

修法：集合先在**组自己的块**里读（`_members_of`），再按多数链接类型收窄；容器选择器命中多个块时，
取"成员数与组的 `count` 最接近"的那个（`count` 就是印给用户看的数字），一个都命中不到时退回整页
（原行为）。这样印出来的数字和实际用的集合必然一致 ✓

守卫：`tests/test_cards.py::test_a_shared_class_elsewhere_on_the_page_does_not_hijack_the_set`
（24 个带图作品 + 111 个无图标签共用同一个类），退回旧行为跑一遍红在
**`the set has 111 cards but the group says 24`** ✓

真机复验（同一条命令）：现在印 `24 card(s) in this set`，选择页 **24 张卡全是作品、24 张封面** ✓

顺带一句类型：这是一张**模特页**，按 UI.md 的列表类型应当建成 `artist`（面板上就有那个按钮；
bat 默认 `search`，只影响 T³ 高级导入里显示的类型名，不影响规则本身）。

门：工具 pytest 365；check_undefined_names 73/0；verify_doors 25/25；verify_against_recordings PASS 327/0。
```
