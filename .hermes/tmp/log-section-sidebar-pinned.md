### 侧边栏：gallery 列表可滚、常用功能固定在下方、+Author 移除（2026-10-06）

用户：**「左侧 gallery 多了以后，一些常用功能就会被挤到下面去了……将从 author 开始直到最下面的添加部分
固定住，并使得 gallery 列表可以滑动。整体的动效要丝滑一点，下面被固定住的部分跟整个侧边栏是一体的，
而 gallery 列表滑动"进入下方口袋"的感觉。还有，+author 功能移除……所有版本都移除。」**

**结构**（`GalleryApp.vue` 侧边栏从"一列全放一起"改成三段的 flex 列）：

```text
  固定头：移动端标题行 + 搜索框 + "Your Galleries N"
  滚动中段：.gallery-list（Home + 各 gallery）—— flex:1 / min-height:0 / overflow-y:auto
  固定底段：.sidebar-pinned（Authors / Recently viewed / Collections / Random pick / View later
            + New Entry）—— flex:0 0 auto，与侧边栏同一张卡片，没有间隙、没有第二块面板
```

**"口袋"的手感**：固定块的顶边画一道**侧边栏自身底色**的渐隐（`::before` + 负 margin，不占布局、
不可点击），列表从下面经过时逐行化掉；列表自己也留了 0.9rem 底部内边距，滚到底时最后一行不会被
化掉一半。移动端抽屉原本是**整个** `overflow-y:auto`，改成 `overflow:hidden` —— 滚的是列表，不是抽屉。

**实测（390×844 抽屉，7 个 gallery）**：列表 `scrollHeight 406 > clientHeight 340` → 可滚 ✓；
固定块紧贴列表下沿（t 501）✓；View later 底 755、New Entry 底 827，都在 844 视口内 ✓；`+ Author` 不存在 ✓；
渐隐存在 ✓。

**桌面端是同一个毛病，只是高了一个断点**：实测 1280×800、7 个 gallery 时侧边栏长到 **811px** 而窗口只有
800 → **New Entry 在折线下方 131px**。所以桌面端侧边栏改成 `position: sticky` + 受限高度
（`calc(100dvh - 9.5rem)`，那 9.5rem 是它所在的 app header 高度，注释里写了来历）。复测：
`everythingOnScreen: true` ✓，列表 `scrollHeight 394 > clientHeight 230` → 可滚 ✓。
（代价：桌面侧边栏卡片不再与内容区等高 —— 换来的是滚动时它一直可见。）

**+Author 移除**：侧边栏那颗按钮和 Home 空状态那颗都删了（`create-author` 事件与监听一并删掉）✓。
**保留**了 Entry 编辑器里那颗"新建作者"—— 它是"给这个作品关联一个新作者"的一部分，不是导航口子。
`AddAuthorPage.vue` 现在**没有任何入口**（页面文件还在，未删）—— 要不要连页面一起删，你说一声。

测试：一颗断言 `add-author-navigation` 存在、一颗整段"从 Add Author 返回"的用例随门一起去掉/改写
（页面已不可达）。

门：T³ 单测 1110；集成 **613/613**；eslint 0；产物已重建并实测。
