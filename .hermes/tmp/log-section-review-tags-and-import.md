### 修：审阅屏的 tag 竖排 + 导入按钮被悬浮块盖住（2026-10-06）

用户：**「手机端 preview 现在排版在手机屏幕范围内了，但是目前为了排 tag，tag 现在看起来是竖着排列的
（而不是应该正常的横着的）。然后点击 import 没反应这个要修复」**

两条都在浏览器里量到根因，改完又量了一遍。

**1. tag 竖排 —— 两列网格里标签列只剩 54px。**

```text
  改之前（390×844 实测）：
    .preview-facet-row  width 206，grid-template-columns: 152px 54.07px
    .preview-facet-label width 152（取的是 minmax(6.5rem, 9.5rem) 的**最大值**）
    .preview-facet-tags  width 54   ← 比一个 chip 还窄 → 每个 tag 独占一行 = "竖着排列"
  顺带量到宽度链条：351 → 206，**145px 被四层嵌套的内边距吃掉了**（content-panel 12、
    recent-tab-panel 12、import-review 14.4、template-preview 16、preview-card 16）
  改法：≤760px 时 facet 行改成单列（标签在上一行），并把 preview 那两层的内边距收到 0.7rem
  改之后实测：.preview-facet-tags width **225**，13 个 chip 排成 **4 行**（横着换行）✓
```

**2. 导入按钮被悬浮块盖住 —— 这条是真因，不是"缺逻辑"。**

```text
  实测：.floating-actions 是 position:fixed，视口右下角 44×96，z-index 30；
        而内容区**没有为它留任何位置**（.app-layout 的 padding-bottom 是 0）
  审阅屏的提交按钮在页面最末尾、整宽 —— 滚到底部时正好落进那个角落，
  点在它上面实际打到了悬浮的"回到顶部"
  改法：≤44rem 时 .app-layout { padding-bottom: calc(7rem + env(safe-area-inset-bottom)) }
        —— 每一页都给自己末尾的控件留出悬浮块的位置
  改之后实测（滚到底）：commit { l:52, r:323, t:636, b:680 }，floating { l:315, r:359, t:732, b:828 }
        → **overlap: false** ✓，按钮 enabled ✓，截图里按钮完整可见
```

（这一条改的是外壳 `GalleryApp.vue` 的移动端块 —— 属于另一个 AI 的改动面，但用户点名要修，
所以改动很小、注释写清了测量数字和原因。）

前一轮加的"准备中显示 Preparing Import…"仍在（准备期间按钮是 disabled 的，文字不该还写着
"Import 2 Entries"）。

门：T³ 单测 1110；集成 **610/610**；web vue-tsc 0；eslint 0；产物已重建并实测。
