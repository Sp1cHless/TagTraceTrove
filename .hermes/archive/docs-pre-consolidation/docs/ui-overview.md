# 前端 UI 总览

> 给外部 UI AI 与执行 agent 的结构索引。截至 2026-09-06。
> 本文件主要服务桌面视觉工作；手机端包含响应式导航、触屏等价交互和完整非 import 读写能力，必须优先阅读 `mobile-prep-brief.md` 与 `mobile-handoff.md`。

## 1. UI 架构

- Vue 3 `<script setup>` + Vite + TypeScript；无 UI/CSS 框架和第三方运行时 UI 依赖，样式为手写 CSS。
- `styles/theme.css` 定义 light/dark、surface、边框、阴影、accent 和 Tag 调色板。
- `[data-accent]` 提供蓝、青、紫、玫红、琥珀、绿六套色板；组件只读取变量。
- 各 SFC 样式均为 scoped，类名不会跨组件生效。
- `components/EntryCard.vue` 是唯一作品卡片；Gallery、Recent、View later、Collection、Random、Search 和 Tag results 必须复用它。
- Recent、View later、Collections、Random 使用同类连接式 tabs，但样式分别 scoped。
- 所有可见文案位于 `src/i18n.ts` 的 en/zh-CN 扁平字典，key 集合由测试强制一致。
- 破坏性操作使用 `src/armable.ts` 两段式确认；禁止原生 `window.confirm`。
- `GalleryApp.vue` 维护互斥全页视图和来源恢复。任何移动端 shell 改动都必须保留 sidebar 最高优先级和 Back 上下文。

## 2. 关键文件

行数仅用于评估上传/审查规模，不是稳定 API。

| 文件 | 当前约行数 | 作用 |
| --- | ---: | --- |
| `apps/web/src/styles/theme.css` ★ | 508 | 全局颜色、间距、圆角、阴影及主题变量 |
| `apps/web/src/GalleryApp.vue` ★ | 2981 | 应用 shell、sidebar、header、Settings、Gallery 与 Entry 详情、视图路由 |
| `apps/web/src/AuthorPage.vue` ★ | 1500 | Author 列表/详情、筛选、评分、Directory |
| `apps/web/src/components/EntryCard.vue` ★ | 72 | 唯一作品卡片与媒体 stack |
| `apps/web/src/AdvancedEditingPage.vue` ★ | 1082 | 词典、作者合并、未分类 Tag、模板、作者别名 |
| `apps/web/src/AddEntryPage.vue` ★ | 1076 | 手工创建、文件夹 import、batch import |
| `apps/web/src/components/FacetFilterBar.vue` ★ | 983 | Facet/Author/Rating/Usage 筛选与排序 |
| `apps/web/src/CollectionsPage.vue` ★ | 630 | Entry/Author Collections 与一层子文件夹 |
| `apps/web/src/RandomPage.vue` ★ | 401 | Works/Authors/Tags 随机推荐 |
| `apps/web/src/ViewLaterPage.vue` ★ | 299 | SQLite 共享 Entry/Author View later；独立分页；旧 Entry localStorage 一次性并入 |
| `apps/web/src/RecentViewPage.vue` ★ | 273 | 最近观看 |
| `apps/web/src/SearchPage.vue` | 229 | 全局搜索 |
| `apps/web/src/components/TagCombobox.vue` | 207 | 可输入 Tag 组合框 |
| `apps/web/src/i18n.ts` | 1023 | en/zh-CN 文案边界 |
| `apps/web/src/stores/preferences.ts` | 209 | Entry/Author View later 同步 store，以及 NSFW、rows、accent 等设备本地偏好 |
| `apps/web/src/entry-media-stack.ts` | — | 封面/preview stack 几何 |
| `apps/web/index.html` | 13 | Web 入口与 viewport |

`TagSandbox.vue`、`components/tags/TagChip.vue` 和 `TagBoard.vue` 属于旧沙盒，不是产品页视觉来源。

## 3. 桌面纯视觉任务约束

以下规则适用于不改变行为的桌面视觉升级：

1. 只修改 `apps/web` 的 Vue/CSS/i18n；不动 server、shared、schema 和 API。
2. 不新增 UI 框架、CSS 框架、字体或图标 CDN。
3. 不删除或改名 `data-testid`，不改变按钮行为语义。
4. 颜色只走 `theme.css` 变量；危险红和评分金为语义色例外。
5. 新文案必须同时提供 en/zh-CN。
6. 作品卡片视觉只改 `EntryCard.vue`。
7. 同时检查 light/dark、六种 accent 与现有桌面宽度。

手机端不是纯视觉任务：它允许增加 responsive shell、触屏等价控件和 feature-detected 行为，但仍必须保留领域语义、测试锚点、共享卡片和桌面功能。手机端细则以 mobile handoff 为准。

## 4. 手机端直接相关的现状

- 手机断点统一为 44rem；sidebar 在窄屏成为可关闭 drawer，支持遮罩、Escape、Browser Back 与 safe-area。
- 所有原 drag/drop 整理路径均有显式点按等价操作；桌面 drag 保留但不再是唯一入口。
- `EntryCard` media uses `LazyCardImage`: real URLs are assigned only after `IntersectionObserver` approval, then requested immediately with async decoding while reserved card geometry prevents layout shifts.
- Settings、详情工具栏、Facet filter、Advanced editing、Add Entry/Author 与分页均已适配窄屏和 44px 触控目标。
- 手机最终范围为完整非 import 功能；site-probe 文件夹/Batch import 保持桌面专用。
- Chrome 是主要实机浏览器，但禁止 UA/Chrome 专用适配。

## 5. 外部 AI 计划格式

计划必须让执行 agent 可以逐条机械应用：

```markdown
## 阶段 N：阶段名

### 编辑 1 — apps/web/src/...
- 定位：现有 selector/片段
- 改为：完整替换代码块
- 原因：一句话说明目标
- 响应宽度：受影响断点
- 行为保护：必须保留的 testid/事件/Back 语义
```

要求：

- 每条编辑自包含：给定位片段和完整替换块，禁止“整体更现代”类描述。
- 禁止整文件重写；变量层除外，但必须保留现有变量与六套 accent。
- 新变量和 i18n key 必须列出完整定义。
- 引用未上传文件时标记 `[需要补充上传]`。
- 手机计划必须逐项写明 touch 与 mouse/keyboard 的等价路径，不能只给 CSS。
- 最后列出受影响页面、桌面回归面和验收 viewport。

## 6. 建议分工

桌面视觉项目可按：变量基线 → 核心组件 → 页面微调。

手机项目必须独立按：

1. LAN 运行形态。
2. 响应式 shell 与浏览主路径。
3. Search/Recent/View later/Random/Collections。
4. 通用触屏选择/移动模式。
5. 完整创建、编辑、整理和删除。
6. Advanced editing。
7. 图片性能与真机回归。

不得把手机端混入一次桌面美化任务中，也不得要求执行 agent 在实施时临时决定产品范围。
