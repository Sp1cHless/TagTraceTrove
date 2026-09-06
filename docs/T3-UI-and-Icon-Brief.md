T³ UI 调整与图标绘制交接指令

依据：当前两张界面截图、ui-overview.md 及本轮设计讨论。本文确定设计与执行要求；本轮不修改项目、不生成图片。适用于通用收藏工具的界面与功能图标。

1. 给执行 agent：UI 调整指令

1.1 目标与边界

保留现有「暖中性色背景、柔和白色面板、细边框、轻阴影、克制强调色」的气质。目标是轻量、日常、安静，优先统一层级和组件细节。

保持 Vue + 手写 CSS，零新增运行时依赖；不引入组件库、字体或图标 CDN。

本阶段仅修改 apps/web 的 .vue / .css；不改 API、数据结构、路由和操作语义，不删除或改名 data-testid，保留两段式危险操作确认。

本阶段保留现有文案和 i18n 接线；顶部技术性说明先降级显示。文案改写另列任务，届时同时修改中英字典。

当前没有实际源码，本文不提供虚构的选择器、行号或替换代码。执行时先读取对应文件，将下列确定的规则映射到真实实现；不要整文件重写或扩展成架构重构。

手机端重排、背景上传和自动取色均为后续阶段。本阶段完成桌面视觉统一，并预留必要的主题变量。

1.2 按顺序执行

A. 在 apps/web/src/styles/theme.css 统一基础尺度。 保留全部现有变量名；已有等价变量就复用，不重复创建同义变量。

项目

确定规则

字体

保留现有本地系统字体栈；表单控件继承字体；统一中英文混排基线

字号

应用级标题 24px/600；当前页面标题 32px/700；分区标题 16px/600；正文及控件 16px/400；辅助信息 14px/400

行高

标题 1.2，正文和辅助信息 1.5；控件用内边距与最小高度居中，不固定文字容器高度

间距

使用 4、8、12、16、24、32px 六档；组件内部通常 8–16px，分区间 24px，主面板内边距 24px

圆角

主面板 18px；内部卡片 14px；按钮和输入框 10px；短标签保留胶囊形

控件

普通按钮、输入框、下拉框统一最小高度 40px；独立图标按钮点击区域至少 44×44px，图标显示为 20px

阴影

主面板只用一层低强度柔和阴影；内部表单分组不加阴影；弹层可使用更明显的独立阴影变量

颜色继续完全通过主题变量提供，并区分用途：页面背景、面板、弱背景、正文、辅助文字、边框、强调色、强调色上的文字、选中背景和焦点轮廓。明暗主题分别定义，六套强调色分别核对；不要假设旋转色相后仍具有相同对比度。中性色只轻微染色，危险色和评分星色保留语义。

B. 在 GalleryApp.vue 调整页面层级。

缩小顶部 Galleries，使当前页面标题成为主要视觉入口；顶部说明使用辅助文字规格。

保留现有整体布局及宽度策略，不将所有区域一起压紧。统一主面板内边距、标题与内容间距。

保留外层面板边界；对只负责普通内容分组的内层区域，取消重复的背景、圆角外框和阴影，使用标题与 24px 分区间距。输入框、按钮、弹层保留辨识边界。

不通过过淡文字表达“次要”。辅助文字仍需清楚可读，标题、位置与间距共同承担层级。

C. 统一组件和状态。

检查 FacetFilterBar.vue、详情工具栏及各表单：统一字体、最小高度、边框、圆角、图标尺寸和文字间距。给现有原生 select 补齐样式，保留原生选择与键盘行为。

主操作使用实色强调背景；普通操作使用中性表面与边框；选中项使用浅强调背景及明确标记。保留现有操作优先级，避免全部按钮都变成主按钮。

hover 使用轻微底色变化；按下加深底色；键盘焦点使用独立的 2px 可见外轮廓；选中与焦点不得混为同一种状态。状态色全部来自变量。

如有过渡，统一为 150ms，仅用于颜色、边框和轻微透明度变化；尊重减少动态效果的系统偏好，不添加弹跳或循环动画。

卡片视觉仅在 components/EntryCard.vue 中修改，保留内容结构、封面堆叠和现有插槽。

四处连接式 tab 保留造型，统一读取尺寸、间距和状态变量，避免各页面出现不同版本。

D. 为背景自定义确定后续规则，本阶段不新增设置或上传功能。

层级固定为：背景图片 → 全页明暗遮罩 → 内容面板 → 文字和控件。

图片统一在底层模糊；不让每个控件、每张卡片各自运行背景模糊。

面板默认保持不透明。启用图片背景时，以 94% 面板底色不透明度作为初始设计值；需结合真实背景检查可读性，必要时提高至完全不透明。

透明度只作用于面板背景色，禁止降低整个面板容器的 opacity。

背景与强调色允许独立选择；第一版自动配色仅匹配现有六套色板，保留手动覆盖。完整动态色板生成留待后续。

1.3 验收与交付

使用当前仓库的前端测试与构建命令全部通过；说明中的“104 个测试”仅是当时快照，以实际测试集为准。

检查浅色/深色 × 六套强调色；桌面检查 1024、1440、1920 CSS px 宽度，并检查长中文、长英文及键盘焦点。

至少核对主页面、详情、作者页、录入/编辑表单，以及共享卡片和 tab 的所有使用页面；确认无裁切、错位和行为变化。

普通文字对比度至少 4.5:1；用于识别控件和状态的必要非文字视觉信息至少 3:1。纯装饰分隔线不必统一加深。文字要求 · 非文字要求

提交修改文件清单、对应规则、测试结果与代表性前后截图；不要额外重设计页面结构。


# T³ UI 与功能图标设计交接指令

依据：当前界面截图、`ui-overview.md`，以及用户对现有功能的补充说明。本文用于指导 image2 绘制图标母版，并指导本地执行 agent 将图标接入网页。

设计方向保持为：暖中性色背景、柔和面板、细边框、轻阴影和克制的主题强调色。图标应让界面更统一，同时保持轻量、日常、容易理解。

## 1. UI 调整原则

- 保留现有 Vue 3 + Vite + TypeScript + 手写 CSS 架构，不新增 UI 框架、图标库、字体或 CDN。
- 所有界面颜色继续来自 `apps/web/src/styles/theme.css`。组件中的 SVG 只使用 `currentColor`，不硬编码主题色。
- 保留所有 API、状态结构、路由、handler、`data-testid` 和操作语义。图标接入不应顺带改造业务逻辑。
- 缩小应用级 `Galleries` 标题，使当前页面标题成为主要标题；统一按钮、输入框、下拉框的高度、圆角、字体和焦点状态。
- 普通文字至少保持 4.5:1 对比度；重要控件轮廓和状态标记至少保持 3:1。纯图标按钮点击区域使用 44×44px，图标显示尺寸通常为 20×20px。
- 背景图片功能后续按“背景图片 → 明暗遮罩 → 半透明内容面板 → 内容”实现。本轮图标接入不依赖该功能。

## 2. 已确认的图标功能

以下语义由用户确认，执行 agent 必须以此为准：

| 当前图形 | 实际功能 | 最终图标 | 控件类型 |
| --- | --- | --- | --- |
| Thumb-up | 按点赞数排序 | `thumb-up` | 排序状态按钮 |
| Heart | 按 view count 排序 | `eye` | 排序状态按钮 |
| Star | 按 latest view 排序 | `history` | 排序状态按钮 |
| Thumb-up | 在作品详情页增加一次点赞 | `thumb-up` | 可重复执行的动作按钮 |
| Folder / Folder-plus | 打开 Collection 下拉框，把作品加入 Collection | `folder` / `folder-plus` | 菜单触发按钮 |
| Clock | 把作品加入 View later | `clock-later`，成功后可显示 `clock-check` | 动作按钮；是否可反向移除由现有代码决定 |
| Search | 搜索 | `search` | 输入框前缀或纯图标按钮 |
| Edit | 编辑当前内容 | `edit` | 纯图标按钮 |
| Settings | 打开设置 | `settings` | 纯图标按钮 |
| Dark / Light | 切换主题 | `moon` / `sun` | 纯图标按钮 |

Heart 和 Star 不再作为这两个排序功能的图标。除非以后出现真正的 Favorite 或 Rating 功能，否则本轮不绘制、不接入 Heart 和 Star。

`history` 在本轮只有一个确定用途：表示 latest view，即按“最近一次查看时间”排序。它不自动加入侧栏或其他页面。普通 `clock-later` 专门表示 View later，二者必须在造型上明显不同。

Plus、Close、Check、Chevron、User、Shuffle 等此前推测出来的图标不属于本轮 image2 强制绘制清单。执行 agent 可以继续保留项目现有的简单 CSS/SVG 几何符号；只有代码审计确认有真实功能需要时，才按同一风格补充。

## 3. 图标美术规范

采用柔和的几何线性图标：清楚、圆润、规整，带少量亲切感，但不使用 emoji 或插画式细节。

- 逻辑画布为 24×24；主图形尽量位于中央 20×20 范围内。
- 轮廓线宽统一为 2 个逻辑像素，使用圆角端点和圆角连接。
- 默认版为 outline。仅在确实需要第二个形状表达状态时制作 state variant，例如 `clock-check`。
- 图标母版使用纯黑图形和真实透明背景。黑色只是交付颜色，网页运行时由 `currentColor` 着色。
- 不使用渐变、阴影、3D、纹理、皮肤色、彩色 emoji、发光、装饰性星光、文字、数字或外包按钮底板。
- 必须在 20px 显示尺寸下仍可辨认。image2 输出 1024×1024 透明 PNG 作为造型母版；接入 agent 依据母版整理为简洁的 24×24 内联 SVG。
- 先绘制 `thumb-up` 作为线宽、圆角和视觉重量的母版。后续每个图标都把已经批准的母版作为参考图，保持相同的占画布比例和视觉重量。

### 3.1 第一批需要 image2 绘制的图标

| 文件名 | 造型要求 |
| --- | --- |
| `thumb-up.png` | 竖起的拇指和简化手掌，手腕短而圆润；无指甲、掌纹或皮肤细节。排序按钮和作品点赞按钮共用同一个图形 |
| `eye.png` | 水平眼睛轮廓，中央圆形瞳孔；轮廓不尖锐，不加睫毛、眉毛或写实眼球细节，用于 view count |
| `history.png` | 一段逆时针回转箭头围绕简化时钟，钟面只保留两根短指针；箭头与钟面合成一个整体，用于 latest view |
| `folder.png` | 单层文件夹轮廓，顶部标签短而圆润，无文件或文字细节 |
| `folder-plus.png` | 与 `folder` 完全相同的主体，右下角增加小型 plus；plus 不遮挡文件夹主轮廓 |
| `clock-later.png` | 清楚的圆形钟面与两根指针；可带很小的右向延续提示，但不带回转箭头，避免与 `history` 混淆 |
| `clock-check.png` | 与 `clock-later` 主体完全相同，在右下角增加短 check；附加符号的位置与 `folder-plus` 的视觉尺度一致 |
| `search.png` | 标准放大镜，圆环和手柄比例轻巧；手柄使用圆角端点 |
| `edit.png` | 约 45° 斜放的简化铅笔，可带一条很短的书写线；不画纸张、方框或复杂笔尖 |
| `settings.png` | 六齿圆润齿轮，中心单圆孔；齿形宽而少，保证 20px 下不糊成圆圈 |
| `moon.png` | 简洁新月，内外弧线平滑，不加星星 |
| `sun.png` | 中央圆形加八根等距短光线，光线使用圆角端点；与 moon 占据相同的视觉面积 |

### 3.2 可直接给 image2 的通用提示词

每次只生成一个图标，将 `[ICON_SPEC]` 替换为上表中的造型要求。首张 `thumb-up` 不需要参考图；后续把已批准的 `thumb-up` 或同组图标附为参考。

```text
Create ONE functional interface icon for T³, a calm personal collection app.
The interface uses warm off-white backgrounds, clean panels, soft corners,
subtle borders and restrained accent colors.

ICON TO DRAW: [ICON_SPEC]

Use a soft geometric outline style with precise simple geometry, rounded line
caps and joins, consistent optical weight, and very few internal details.
Design on a logical 24 × 24 grid. Keep the main shape within approximately
20 × 20 units, centered optically, with a consistent 2-unit stroke. It must
remain clear when displayed at 20 px.

Use opaque black artwork with clean antialiased edges on a genuinely transparent
background. Match the attached approved reference icon in scale, stroke weight,
corner softness and visual density.

No text, numbers, labels, emoji styling, gradients, shadows, 3D effects,
textures, decorative sparkles, surrounding button, panel or scene. Do not draw
a checkerboard background and do not create an icon sheet.

Deliver one square transparent PNG master at 1024 × 1024.
```

## 4. 三个 Sort 状态按钮

### 4.1 功能模型

三个图标分别代表：

- `thumb-up`：按点赞数排序。
- `eye`：按 view count 排序。
- `history`：按 latest view 排序。

它们是一个排序选择组。通常同一时间只有一个 active；如果现有代码允许“都不选”，则保留 none 状态。点击另一个按钮会改变当前 sort mode 并刷新列表。点击已经 active 的按钮是否反转方向或恢复默认，完全沿用现有逻辑；本文不增加新的排序方向行为。

三个按钮必须共用完全相同的容器尺寸、状态颜色和切换动画。Active 主要通过按钮底色、边框和图标颜色表达，而不是依赖某个图标变成实心。这样 Eye 和 History 不需要制作勉强的 filled 版本，也不会让 Thumb-up 显得比另两个更重。

### 4.2 状态与颜色

| 状态 | 图标 | 背景 | 边框 | 动效 |
| --- | --- | --- | --- | --- |
| Default | `--icon-muted` | transparent 或面板底色 | `--border` | 无 |
| Hover | `--accent` | `--surface-hover` | `--border-strong` | 图标在 120ms 内从 1 放大至 1.04 |
| Pressed | `--accent` | `--accent-soft` | `--accent` | 图标压缩到 0.94，松开恢复 |
| Active | `--accent` | `--accent-soft` | `--accent` | 切入时执行一次 160ms 的轻微 pop；之后静止 |
| Focus-visible | 保持当前状态色 | 保持当前背景 | 保持当前边框 | 外加 2px `--focus-ring`，offset 2px |
| Disabled/loading | `--icon-muted` | 保持当前背景 | `--border` | opacity 0.42，不执行动画 |

Active 状态还应在按钮底部中央显示一个 3px 圆点，颜色为 `--accent`。圆点和容器底色共同表达状态，避免只靠颜色区分。切换排序时不让三个按钮发生位移，也不对结果卡片增加大面积动画；现有 loading 状态继续负责数据刷新反馈。

### 4.3 建议的 Vue 接线

状态名和 handler 需要映射到项目已有代码，下面只规定结构：

```ts
type SortMode = 'likes' | 'views' | 'latestView'

const sortOptions = [
  { value: 'likes', icon: 'thumb-up', labelKey: 'sort.likes' },
  { value: 'views', icon: 'eye', labelKey: 'sort.views' },
  { value: 'latestView', icon: 'history', labelKey: 'sort.latestView' },
] as const
```

```vue
<div class="sort-icon-group" role="group" :aria-label="t('sort.groupLabel')">
  <button
    v-for="option in sortOptions"
    :key="option.value"
    class="sort-icon-button"
    type="button"
    :aria-pressed="sortMode === option.value"
    :aria-label="t(option.labelKey)"
    @click="setSortMode(option.value)"
  >
    <AppIcon :name="option.icon" :size="20" />
    <span class="sort-active-dot" aria-hidden="true" />
    <span class="icon-tooltip" aria-hidden="true">{{ t(option.labelKey) }}</span>
  </button>
</div>
```

如果当前三个按钮旁边已有可见文字，保留文字并取消 tooltip；如果改成纯图标，必须保留 `aria-label` 和 tooltip。Tooltip 在鼠标停留约 400ms 后显示，键盘 focus 时立即显示。

### 4.4 Sort 切换动画

```css
@keyframes sort-icon-selected {
  0% { transform: scale(0.94); }
  65% { transform: scale(1.06); }
  100% { transform: scale(1); }
}

.sort-icon-button[aria-pressed='true'] .app-icon {
  animation: sort-icon-selected 160ms ease-out;
}
```

如果 Vue 因为同一个按钮持续保持 `aria-pressed=true` 而重复触发动画，应只在 sort mode 实际发生变化时给图标临时添加 `.just-selected`；不要使用持续循环动画。

## 5. 作品详情页的 Thumb-up 点赞按钮

该按钮和 Sort 的点赞数按钮共用 `thumb-up` 图形，但交互完全不同。

- Sort 按钮选择一种排序方式，是持久 active 状态。
- 作品详情的 Like 是可重复执行的动作。每次点击增加一次点赞，不是 on/off toggle，因此不得设置 `aria-pressed`，也不得在第一次点击后永久显示为 selected。
- 按钮可保留 `Like` 文案和当前点赞总数。若改为纯图标，使用本地化 `aria-label="Like this entry" / "点赞此作品"`，并给出 tooltip。
- 每次点击都要重新播放一次短反馈，包括连续快速点击。动画结束后按钮恢复普通状态。
- 点赞总数如何更新、是否乐观更新以及请求失败处理，全部沿用现有业务实现。视觉动画不得假装服务器已经接受点赞。

推荐动效：

1. Pointer down：图标在 70ms 内缩到 0.90。
2. Pointer up/click：图标在 180ms 内上移 2px并放大到 1.10，再回到原位。
3. 图标短暂变为 `--accent`，约 260ms 后恢复默认颜色。
4. 如果按钮附近已有点赞数字，数字播放一次 160ms 的轻微放大；可以在图标右上短暂显示 `+1`，向上移动 6px 并在 360ms 内淡出。`+1` 只作视觉反馈，不进入辅助技术的朗读队列。

为了让每次点击都能重播，可在页面局部使用递增 key 或移除后重新添加动画 class。示意：

```ts
const likeAnimationKey = ref(0)

function onLikeClick() {
  likeAnimationKey.value += 1
  return existingLikeHandler()
}
```

```vue
<button class="like-action with-icon" type="button" @click="onLikeClick">
  <span :key="likeAnimationKey" class="like-icon-feedback">
    <AppIcon name="thumb-up" :size="20" />
  </span>
  <span>{{ t('entry.like') }}</span>
</button>
```

不要因等待上一次动画而吞掉后续点击。业务层是否允许并行请求由现有 handler 决定；动画层只负责及时反馈输入。

## 6. Collection 按钮与下拉框

`folder` 是 Collection 的基础图形，`folder-plus` 用于作品详情页“加入 Collection”的菜单触发器。

- 触发按钮使用 `aria-haspopup="menu"`、`:aria-expanded="collectionMenuOpen"` 和 `aria-controls`。
- 关闭时使用普通前景色；hover 时使用 accent；菜单打开期间使用 accent 图标、`--accent-soft` 背景和 accent 边框。
- 按钮打开菜单后仍显示 `folder-plus`。作品可以加入多个 Collection，因此触发按钮本身不使用 `aria-pressed`，也不永久改成 filled folder。
- Collection 列表中已经包含当前作品的项目如何表示，应沿用现有复选、选中或禁用逻辑。本文不要求为其新增 Check 图标。
- 图标点击反馈为 100ms 的 `scale(0.94)` 后恢复。
- 下拉框从按钮下方或右下方出现，transform-origin 对准触发按钮。进入时使用 150ms 的 `opacity: 0 → 1` 与 `translateY(-4px) → 0`；退出时使用约 100ms 的反向动画。
- 动画不能改变菜单最终尺寸或推开页面内容；下拉框保持浮层定位。点击外部、Escape 和选中后的现有关闭行为保持不变。

## 7. View later 的 Clock

作品详情中的 Clock 表示“把当前作品加入 View later”。它不是 latest view；latest view 始终使用 `history`。

界面应优先读取现有代码是否提供 `isInViewLater` 或等价状态：

- 如果现有功能支持加入与移出：未加入时显示 `clock-later`；已加入时显示 `clock-check`、accent 色和浅 accent 背景，并使用 `aria-pressed`。再次点击执行现有移出逻辑。
- 如果现有功能只有“加入”动作：按钮不设置 `aria-pressed`。成功后临时切到 `clock-check` 约 700ms；之后显示什么由现有数据状态决定。不要自行增加移出功能。
- 请求进行时沿用现有 loading/disabled 逻辑。图标可降低透明度，但不使用无限旋转的 Clock。
- 成功反馈使用一次 180ms 的轻微 pop；失败时恢复 `clock-later`，并沿用项目已有错误提示。

Clock 和 History 的视觉区别：`clock-later` 是完整单圆钟面；`history` 的外轮廓由回转箭头构成。即使都以 20px 显示，也应能在不看 tooltip 时区分。

## 8. Search、Edit、Settings 与主题切换

这些功能目前使用文字或普通素材，可以改成纯图标。纯图标会降低初次识别度，因此统一提供 tooltip、`aria-label` 和 44×44px 点击区域。

### Search

- 输入框内部的 `search` 是装饰，设置 `aria-hidden="true"`。默认使用 `--icon-muted`，输入框 `:focus-within` 时转为 `--accent`。
- 如果右侧存在独立提交按钮，它可以同样使用 `search`，但父按钮必须有“搜索”ARIA 和 tooltip。
- 聚焦时只切换颜色，不让放大镜位移，避免输入框内容抖动。

### Edit

- Entry、Author 等页面现有 Edit 按钮可改成 `edit` 纯图标按钮。
- 默认使用 `--icon-default`；hover 时转为 accent，铅笔在 130ms 内逆时针转约 5°，离开后恢复。
- 点击后立即恢复原角度，再执行现有编辑 handler 或路由跳转。它没有 pressed/selected 状态。

### Settings

- 顶部 Settings 可改成 `settings` 纯图标按钮。
- hover 时齿轮在 160ms 内顺时针旋转约 20°；离开时恢复，不持续旋转。
- 如果打开的是 modal，使用 `aria-haspopup="dialog"` 和 `aria-expanded`，modal 打开期间按钮保持 accent 状态。如果是路由页面，则按普通导航链接处理。

### Sun / Moon

- 图标表达点击后将进入的主题：浅色主题下显示 Moon，ARIA 为“切换至深色主题”；深色主题下显示 Sun，ARIA 为“切换至浅色主题”。
- 两个图标占用完全相同的 20×20 区域。切换时采用 180ms 的淡出、轻微缩小与旋转，再淡入新图标；按钮容器不旋转、不改变尺寸。
- 主题色切换本身使用项目现有逻辑。动画不能延迟实际主题更新，也不应产生白屏闪烁。

## 9. 通用图标组件和 Tooltip

新增 `apps/web/src/components/AppIcon.vue` 作为唯一 SVG 图形出口。建议使用以下接口：

```ts
export type IconName =
  | 'thumb-up'
  | 'eye'
  | 'history'
  | 'folder'
  | 'folder-plus'
  | 'clock-later'
  | 'clock-check'
  | 'search'
  | 'edit'
  | 'settings'
  | 'moon'
  | 'sun'

const props = withDefaults(defineProps<{
  name: IconName
  size?: 16 | 20 | 24
}>(), {
  size: 20,
})
```

`AppIcon` 固定输出 `viewBox="0 0 24 24"`、`aria-hidden="true"`、`focusable="false"`，使用 `currentColor`。可访问名称由父按钮提供，不给 SVG 单独增加 title。

再新增一个轻量的 `IconButton.vue`，用于纯图标按钮，接口建议为：

```ts
defineProps<{
  icon: IconName
  label: string
  active?: boolean
  disabled?: boolean
  size?: 16 | 20 | 24
}>()
```

该组件根元素是原生 `<button type="button">`，设置 `:aria-label="label"`，并将未声明 attributes 自动透传到根按钮，使页面可以继续传入 `data-testid`、`aria-pressed`、`aria-expanded`、`aria-controls` 和事件。Tooltip 文案直接使用同一个 `label`：鼠标 hover 约 400ms 后出现，键盘 `focus-visible` 时立即出现，离开或失焦时关闭。

Tooltip 使用固定的小型面板样式：12px 字号、6px 8px 内边距、6px 圆角、单行显示，位置优先在按钮下方；靠近视口右缘的按钮改到左下方。Tooltip 不捕获鼠标事件，不参与布局，也不代替 `aria-label`。

## 10. 颜色变量与通用状态

先复用项目现有变量；缺失时再在 light/dark 与六套 accent 中添加等价语义变量：

```css
--icon-default: var(--text-primary);
--icon-muted: var(--text-secondary);
--icon-on-accent: var(--accent-foreground);
--icon-disabled-opacity: 0.42;

--icon-control-bg: var(--surface);
--icon-control-hover-bg: var(--surface-muted);
--icon-control-active-bg: var(--accent-soft);
--icon-control-border: var(--border);
--icon-control-active-border: var(--accent);
--icon-focus-ring: var(--focus-ring);
```

通用纯图标按钮：

```css
.icon-button {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  padding: 0;
  color: var(--icon-default);
  background: var(--icon-control-bg);
  border: 1px solid var(--icon-control-border);
  border-radius: 10px;
  cursor: pointer;
  transition: color 150ms ease, background-color 150ms ease,
    border-color 150ms ease;
}

.icon-button:hover:not(:disabled) {
  color: var(--accent);
  background: var(--icon-control-hover-bg);
}

.icon-button[data-active='true'],
.icon-button[aria-pressed='true'],
.icon-button[aria-expanded='true'] {
  color: var(--accent);
  background: var(--icon-control-active-bg);
  border-color: var(--icon-control-active-border);
}

.icon-button:focus-visible {
  outline: 2px solid var(--icon-focus-ring);
  outline-offset: 2px;
}

.icon-button:disabled {
  opacity: var(--icon-disabled-opacity);
  cursor: not-allowed;
}
```

`data-active` 只用于没有合适原生 ARIA 状态、但需要视觉保持的容器。排序优先使用 `aria-pressed`，菜单优先使用 `aria-expanded`。不能为了套用 CSS 而给普通动作按钮添加错误的 ARIA。

## 11. 动效总表

| 功能 | 触发 | 动画 | 时长 | 最终是否保持状态 |
| --- | --- | --- | --- | --- |
| Sort | 切换到新排序方式 | 图标 0.94 → 1.06 → 1，颜色与背景过渡 | 160ms | 是，直到 sort mode 改变 |
| Entry Like | 每一次点击 | 压缩、向上 2px、放大后归位；可带 `+1` 淡出 | 180–360ms | 否，恢复普通按钮 |
| Collection | 打开菜单 | 按钮短暂压缩；菜单淡入并上移 4px | 100–150ms | 只在菜单打开期间保持 active |
| View later | 加入成功 | Clock 轻微 pop，必要时换成 Clock-check | 180ms | 是否保持由现有 membership 状态决定 |
| Search | 输入框聚焦 | 图标颜色过渡 | 150ms | 聚焦期间 |
| Edit | Hover | 铅笔旋转约 −5° | 130ms | 否 |
| Settings | Hover | 齿轮旋转约 20° | 160ms | 否；modal 打开时只保持颜色 |
| Theme | 切换 | Sun/Moon 淡出缩小旋转并交叉淡入 | 180ms | 新图标保持 |

所有动效只作用于 `transform`、`opacity`、颜色和边框，不能引发布局重排。加入：

```css
@media (prefers-reduced-motion: reduce) {
  .app-icon,
  .icon-button,
  .icon-tooltip,
  .collection-menu,
  .like-icon-feedback {
    animation: none !important;
    transition: none !important;
    transform: none !important;
  }
}
```

## 12. ARIA 与 i18n

复用现有 key；缺少时同时添加 en 与 zhCN：

| key | en | zhCN |
| --- | --- | --- |
| `sort.groupLabel` | Sort entries | 作品排序 |
| `sort.likes` | Sort by likes | 按点赞数排序 |
| `sort.views` | Sort by view count | 按浏览次数排序 |
| `sort.latestView` | Sort by latest view | 按最近查看排序 |
| `a11y.likeEntry` | Like this entry | 点赞此作品 |
| `a11y.addToCollection` | Add to collection | 加入合集 |
| `a11y.addViewLater` | Add to view later | 加入稍后查看 |
| `a11y.removeViewLater` | Remove from view later | 移出稍后查看 |
| `a11y.search` | Search | 搜索 |
| `a11y.edit` | Edit | 编辑 |
| `a11y.openSettings` | Open settings | 打开设置 |
| `a11y.switchToDark` | Switch to dark theme | 切换至深色主题 |
| `a11y.switchToLight` | Switch to light theme | 切换至浅色主题 |

可见文字按钮中的图标一律是装饰。纯图标按钮必须同时拥有本地化 `aria-label` 和可见 tooltip。Tooltip 不使用英文硬编码。

## 13. 给执行 agent 的实施顺序

1. 在实际源码中找到三个 Sort 按钮、详情 Like、Collection、View later、Search、Edit、Settings、Theme 的真实组件、状态和 handler，记录映射；不要依据当前 emoji 名称猜功能。
2. 建立 `AppIcon.vue` 和第一批 12 个 `IconName`。根据 image2 母版整理 SVG path，使用少量干净路径；不要自动描摹成大量碎 path。
3. 建立或整合 `IconButton.vue`、Tooltip 和通用主题变量。
4. 先接入三个 Sort 按钮并验证排序结果未改变，再接入详情页动作，最后替换 Search、Edit、Settings 与主题切换。
5. 加入本地化 ARIA 文案和 tooltip；保留原 `data-testid`、事件及路由。
6. 运行当前完整前端测试与构建，检查 light/dark × 六套 accent，以及键盘、200% 缩放和 `prefers-reduced-motion`。

验收时重点确认：

- Sort 的 Thumb-up、Eye、History 表示三种排序状态，选中项清楚且不靠图标填充区分。
- 详情页 Thumb-up 每次点击都能获得短反馈，不成为永久 selected，也不会吞掉快速连续点击。
- Collection 按钮只在菜单打开时 active；Clock 与 History 在 20px 下不会混淆。
- Heart 与 Star 已从这两个错误语义中移除；未确认的图标没有被强行接入。
- 所有纯图标按钮都有准确 tooltip 和 ARIA；所有颜色跟随主题变量，动效在减少动态偏好下完全关闭。
