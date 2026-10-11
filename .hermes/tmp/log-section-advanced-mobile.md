### 移动端适配：高级编辑页（用户：「完全没有适配，就是横屏展开，划不动」）（2026-10-05）

先在**真实浏览器**里量，再改 —— 这一步不能靠读源码（jsdom 不做排版）：

```text
  在 390×844 的视口打开 T³ → 设置 → 高级编辑
  实测（改之前）：
    .advanced-tabs   510px 宽（5 个按钮一行），而容器只有 326px
    .advanced-page   510px 宽，right: 534 —— 比视口宽 144px
    docScrollW 375 = 视口内，scrollW == clientW → **没有任何东西可以滚动**
    → 内容被外壳裁掉，"Source maintenance" 这个标签**点都点不到**
       （点击时直接报 "outside-viewport"）
```

根因是 CSS 里一条通用规律：**grid 子项的自动最小尺寸等于它的内容**。`.advanced-page` 是 grid，
里面一行放不下的标签栏（5 个按钮）就把整页撑成 510px，外壳再把多出来的裁掉。

改法（两条都要，只做一条会留下另一半症状）：

```text
  · .advanced-page > * { min-width: 0 }   —— 允许子项比自己的内容窄
  · @media (max-width: 44rem) 里 .advanced-tabs 变成**横向滚动的条**
    （沿用 app 自己 .recent-tabs 在 ≤44rem 的做法：nowrap + overflow-x:auto + 44px 触摸高度）
  · .advanced-toolbar 允许换行；.advanced-card 内边距收窄
  · 别名行在手机上**分成两行**：名字一行，动作一行 —— 实测改之前两个按钮把名字挤成
    约四个字的窄列（"Aemea th →"），而名字是这一行的主语
  · 字典导入那行改用页面自己的 .dictionary-import（顺带修掉上一轮我写的一个真 bug：
    我在这个页面用了 .rule-builder__exists-row，那是另一个组件的 **scoped** 样式，这里根本没有规则）
  · SourceMaintenancePanel 的来源行加 flex-wrap —— 它是这一页里唯一还溢出的（实测 448px / 326px）
```

改后实测（同一视口、逐个标签页量，排除滚动条内部的元素）：

```text
  五个标签页全部可达 ✓（改之前最后一个点不到）
  .advanced-page 326px（= 卡片宽度）✓，docScrollW 375 ✓，标签栏 scrollW 718 > clientW 326 → 可横滑 ✓
  tags / authors / templates：剩下的"溢出"全部是滚动条**内部**的标签按钮（预期）
  sources：0 个溢出 ✓
```

**没有加单元测试，理由要说清楚**：这是排版，jsdom 不做布局，任何断言都只会测到 class 名而不是行为。
这一页的验收层就是浏览器，上面的数字就是证据（已记在这里）。手机 App 端用的是同一份 web 产物
（`spikes/.../prepare-web.mjs` 把 dist 拷进去），所以这次改动同时覆盖网页端和 App 端。

门：T³ 单测 1110；集成 609/610（`delta-payload` 那条既有的并行超时抖动）；web vue-tsc 0；产物已重建。
