### 侧边栏大改：搜索框与 Home 行移除、三个图标门、交换模式（含一条新 migration）（2026-10-06）

用户：**「1，移除目前的搜索框和 home gallery。2，icon 文件夹里存有 search, homepage, exchange 三个图标……
在我标记的三个蓝点处，从左到右依次为 search homepage exchange 的位置……3，对于新加的 exchange 功能，
用于点击后可以移动 gallery 在列表里的上下位置。可以就用 collection 里移动文件夹的上下箭头。这是编辑
切换键，所以其动效应该是点击后颜色加深表示状态应用（参考 view later 按钮），search 和 homepage 只需要
有点击那一下的动画就可以了。4，移除搜索框后侧边栏相当于多了一大行，可以考虑再给 gallery 列表多加 1-2 行」**

**这次动到了数据库 —— 因为"移动 gallery 的顺序"在库里根本无处可存。**

```text
  Gallery 是 entries.type 的读时投影，不是表；listGalleries 一直是 ORDER BY type COLLATE NOCASE
  → 顺序只是字母序，没有任何地方能记住"我要 Comic 在 Hentai 上面"
  所以按 AGENTS.md 的顺序做了一整套：
    036_gallery_order.sql（新表，稀疏：只有被移动过的 type 才有行）
    → db:probe 加了一条 schema-36 检查（由 integration 测试在一次性库上跑到 ✓）
    → 真 SQL integration 测试（4 条：默认字母序 / 记住顺序且新 gallery 排最后 / 整表替换 / 拒绝重复或空名）
    → listGalleries 读顺序 → API PUT /api/galleries/order（整份列表，不是交换两个）
```

**为什么写整份列表**：交换相邻两行会让其余 gallery 留在字母序里 —— 那是一个看列表猜不出来的顺序。整份写入
让顺序成为**全序**，而之后新建的 gallery 没有行、自然排在末尾 ✓。

**UI**：

```text
  · 搜索框与 Home 行移除；三个图标门放进 "Your Galleries" 那一行（44px 触摸目标，正合用户画的蓝点位置）
  · search / homepage：点击反馈是按下时 scale(0.9)
  · exchange：**模式键**，打开时用与 view-later 同一套"已应用"外观（accent 描边 + accent-soft 底），
    aria-pressed 跟着变；打开后每行出现 Collections 页同款的 ↑ ↓ 箭头（首尾自动禁用）
  · 移动是**先本地后落盘**：行跟着手指走，写失败就退回并报错，而不是让侧边栏显示一个库里没有的顺序
  · 图标按 icons.ts 的既有风格手描（24×24、2 单位描边、currentColor），母版就是 apps/web/icon 里那两张 PNG
```

实测（390×844 抽屉 / 1280×800 桌面）：

```text
  三个图标各 44px、SVG 正确（放大镜 / 房子 / 双箭头）✓
  搜索框与 Home 行都不存在 ✓；交换打开后 7 行 × 2 = 14 个箭头 ✓，aria-pressed=true ✓，按钮底色为 accent-soft ✓
  列表高度：抽屉 340 → **381px**（+0.8 行）；桌面 382 → **420px**（+0.8 行）
  剩下那点被标题行吃掉了 —— 它现在和图标一样高（44px 触摸目标），所以第 4 条只兑现了约一行而不是两行
```

门：T³ 单测 1111；集成 **617/617**；eslint 0；server/shared/web tsc 0；产物已重建并实测。

（新 migration 让 schema 版本从 35 变 36 —— 六处"当前 schema"的断言与两处 applied 列表随之更新，
这是新增 migration 的必然结果。）
