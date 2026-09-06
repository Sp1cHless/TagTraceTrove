# 前端 UI 总览(给外部 UI AI 与执行 agent 的交接文件)

> 目的:让一个擅长 UI 的外部网页端 AI 快速理解 T³ 的前端结构与约束,产出一份
> **执行 agent 可以直接落地**的 UI 升级计划。截至 2026-09-05。

## 1. UI 架构

- 技术栈:Vue 3 `<script setup>` + Vite + TypeScript,无 UI 框架、无 CSS 框架、
  无图标库、零第三方运行时依赖。全部样式是手写 CSS。
- **所有颜色来自 CSS 变量**(`apps/web/src/styles/theme.css`):
  - `[data-theme='light' | 'dark']` 定义明暗两套:页面背景 / surface / 文字 /
    边框 / `--accent` / tag 调色板。
  - `[data-theme=…][data-accent=…]` 定义 6 个主题色板(蓝默认/青/紫/玫红/
    琥珀/绿),每个色板是纯色相旋转(深度不变),同时重着色 accent、tag
    调色板、淡中性色。组件只读变量,永不硬编码颜色(红色危险/金色星星除外)。
- **样式全部 scoped**:每个 `.vue` 文件一个 `<style scoped>`,类名不跨组件。
  全局只有 theme.css 和 GalleryApp 内对全局工具类的定义。
- **`components/EntryCard.vue` 是唯一的作品卡片实现**(多封面透视堆叠 +
  标题 + type + 可选灰字注释 + corner 插槽),Gallery/最近观看/稍后再看/
  合集成员/随机推荐全部复用——改卡片视觉只改这一个文件。
- **连接式 tab**:RecentView / ViewLater / Collections / Random 四个页面共用
  同一种"标签页与内容面板相连"的浏览器 tab 样式(各自 scoped,但视觉一致)。
- **i18n**:`src/i18n.ts` 中 en 与 zhCN 两个扁平字典,key 集合完全一致
  (测试强制)。所有可见文案必须走字典,模板里禁止硬编码文案。
- **交互语言**:数据操作走 API;破坏性操作用两段式按钮(`src/armable.ts`,
  首点武装为确认文案,再点执行),禁止原生 confirm。

## 2. 文件清单(按 UI 重要性排序;★ = 建议上传给外部 AI)

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `apps/web/src/styles/theme.css` ★ | 204 | 全部颜色变量、明暗主题、accent 色板 |
| `apps/web/src/GalleryApp.vue` ★ | 2889 | 应用壳层:侧边栏、顶栏、Settings、全部视图路由、画廊/详情/筛选/最近观看入口。**UI 的核心,必须上传**(最大文件,含全局工具类样式) |
| `apps/web/src/AuthorPage.vue` ★ | 1481 | 作者列表/信息板/作品卡/评分/合集菜单 |
| `apps/web/src/components/EntryCard.vue` ★ | 72 | 唯一作品卡片(封面堆叠) |
| `apps/web/src/AdvancedEditingPage.vue` ★ | 1082 | 高级编辑五 tab(词典/合并/未分类/模板预览/作者别名) |
| `apps/web/src/AddEntryPage.vue` ★ | 1076 | 录入页:拖放导入、预览卡、batch |
| `apps/web/src/components/FacetFilterBar.vue` ★ | 965 | 筛选条(评分/usage/作者行) |
| `apps/web/src/CollectionsPage.vue` ★ | 559 | 合集页(连接式 tab、文件夹卡、子文件夹) |
| `apps/web/src/RandomPage.vue` ★ | 329 | 随机推荐页 |
| `apps/web/src/ViewLaterPage.vue` ★ | 274 | 稍后再看 |
| `apps/web/src/RecentViewPage.vue` ★ | 257 | 最近观看 |
| `apps/web/src/SearchPage.vue` | 228 | 搜索页 |
| `apps/web/src/components/TagCombobox.vue` | 207 | 可输入 tag 组合框 |
| `apps/web/index.html` ★ | 12 | 入口(仅 viewport,无样式) |
| `apps/web/src/AddAuthorPage.vue` | 57 | 新建作者表单 |
| `apps/web/src/components/tags/TagChip.vue` / `TagBoard.vue` | 90/85 | 沙盒遗留积木,产品页未使用 |
| `apps/web/src/TagSandbox.vue` | 207 | 沙盒,产品页未使用,不必上传 |
| `apps/web/src/i18n.ts` | ~900 | 文案字典(计划涉及文案时上传,否则不必) |
| `apps/web/src/entry-media-stack.ts` | — | 封面堆叠几何(纯函数+样式常量) |

补充材料(非代码):几张当前界面截图(浅色+深色、不同 accent)对 UI AI 很有价值。
**不需要上传任何 `apps/server` / `packages/shared` 文件**——UI 升级不涉及它们。

## 3. 硬性约束(计划必须遵守,执行 agent 不会妥协)

1. **只允许改 `apps/web` 内的 `.vue` / `.css` 文件**;`server`、`shared`、
   路由契约、数据结构一律不动。
2. **不新增任何依赖**(无 Tailwind、无组件库、无字体/图标 CDN);保持
   零运行时依赖的手写 CSS 路线。
3. **不得删除或改名任何 `data-testid`**(测试锚点);不得改变交互行为语义
   (哪些按钮存在、点击发生什么);这是纯视觉升级。
4. **颜色只走 theme.css 变量**:新增颜色必须先在明暗两套(必要时 6 个 accent
   色板)里定义变量;禁止组件内硬编码主题色。红(危险)/金(评分星星)是
   语义色,保留。
5. 涉及文案的改动必须同时给出 en 与 zhCN 两个字典的 key 与文案。
6. `EntryCard.vue` 的改动自动作用于五处页面——卡片升级只能在这里做。
7. 明色/暗色主题、6 个 accent、桌面宽度都要兼顾(响应式可作为一个独立阶段,
   见 §5)。

## 4. 外部 AI 应如何写计划(输出格式规范)

计划必须写成**执行 agent 可逐条机械执行**的形式,按以下结构组织:

```markdown
## 阶段 N:<阶段名>(如 基线变量层 / 组件细节 / 布局 / 响应式)

### 编辑 1 — apps/web/src/styles/theme.css
- 定位:【现有选择器或片段,原文引用 ≤5 行】
- 改为:【完整的新代码块,可直接粘贴】
- 原因:一句话(视觉目标)

### 编辑 2 — apps/web/src/GalleryApp.vue
- 定位:`.gallery-link:hover` 规则(第 ~2741 行附近)
- 改为:【完整新规则】
- 原因:…
```

要求:

- 每条编辑**自包含**:引用现有原文片段定位 + 给出完整替换块。禁止"把整体
  风格调得更现代"这类不可执行的描述;禁止要求 agent 自行发挥设计决策。
- **禁止整文件重写**(theme.css 除外,它是纯变量层,可以整体替换,但必须
  保留全部现有变量名与 data-testid 无关)。
- 若需要新变量/新文案 key,在编辑里明确给出变量名与两语言文案。
- 若计划引用了未上传文件中的样式,明确标注 `[需要补充上传]`。
- 最后附**验收标准**:预期视觉效果(文字描述或参考图)、受影响的页面清单;
  执行 agent 将以"现有 104 个前端测试全部通过 + 截图人工核对"作为闸门。

## 5. 建议的阶段划分(外部 AI 可参考,也可自行调整)

1. **变量与基线**:theme.css 的字体、圆角、阴影、间距节奏、变量补全——
   一层改动全局生效,性价比最高。
2. **核心组件细节**:EntryCard、gallery-link 侧边栏、连接式 tab、详情
   工具栏、筛选条、表单控件。
3. **页面级微调**:各页面 scoped 内的局部样式。
4. (可选独立阶段)**响应式/移动端**——该阶段应先阅读
   `docs/mobile-prep-brief.md`,不要与前三阶段混在一起。

> 执行方式:外部 AI 的计划由用户带回给执行 agent(agent 在本地仓库上逐条
> 应用、跑测试、构建、截图核对)。计划写得越"逐条可粘贴",执行越忠实。
