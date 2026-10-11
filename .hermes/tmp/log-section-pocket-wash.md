### 侧边栏交界处：淡淡的主题色渐隐（2026-10-06）

用户：**「我希望效果上在我画线的大概位置，有比较淡的主题色渐变，使得上方的 gallery 往下滑动时有往下
收的感觉」**（画线处 = 滚动列表与固定块的交界，也就是 Authors 上方那一带）。

原来那道渐隐用的是**侧边栏自己的底色**（只是把行化进背景）。改成主题色：

```css
.sidebar-pinned::before {
  height: 1.5rem;                     /* 24px —— 用户画的那条带子大致就是这个高度 */
  background: linear-gradient(to bottom,
    transparent 0%,
    color-mix(in srgb, var(--accent) 5%, transparent) 45%,
    color-mix(in srgb, var(--accent) 13%, var(--surface)) 100%);
}
```

* **淡**：5% / 13% 两个色标 —— 它是"口袋的口"，不该变成一条自己的色带；
* **跟主题走**：用 `--accent`（`color-mix` 是这个仓库已有的写法，`.sidebar-search:focus-within` 就在用），
  所以换 accent 时它跟着变；
* 末段落在侧边栏底色上，因此在面板上不会出现一条硬边；
* 列表自己的底部内边距同步改成 1.5rem，滚到底时最后一行不会被这条带子吃掉一半。

实测（390×844，抽屉滚到中段）：带子 24px ✓，计算出的 `background-image` 是
`transparent → accent 5% → accent 13% + surface` ✓，列表可滚 ✓；截图里 Authors 上方那条淡淡的
蓝紫色带子就是它（用户的 accent 是 `#5361d5`）。

门：T³ 单测 1110；eslint 0；产物已重建并实测。
