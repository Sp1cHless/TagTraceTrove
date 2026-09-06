# T³ 首页（Home）设计与实现指导

> 目标：把当前“默认进入第一个 Gallery / 遗留空 Gallery”替换为真正的首页。首页不是统计 dashboard，而是一个轻量、欢迎向、能自然把用户带回内容的入口。

## 1. 目标与边界

### 1.1 目标

1. Web 打开时首先进入 Home，而不是第一个 Gallery。
2. 浏览器 Back 回到根路径时，回到 Home，而不是遗留空 Gallery 或第一个 Gallery。
3. Home 以“欢迎 + 最近内容”为主，统计只作为氛围信息。
4. 简单数据以自动轮换方式展示，不堆叠一排 KPI 卡片。
5. 无数据时，Home 变成 onboarding / empty state，引导用户收录第一条 Entry。
6. 不要求大幅修改后端；优先复用现有 Gallery、Entry、last-view / history 数据接口。

### 1.2 不做

- 不做完整 dashboard。
- 不做复杂趋势图、饼图、周/月报、排行榜。
- 不新增与当前业务无关的功能。
- 不为了 Home 引入 UI 框架或重量级动画库。
- 不把 root route 继续伪装成某个 Gallery。

---

## 2. 首页结构

推荐：

```text
App Shell
┌────────────────────────────────────────────────────────────┐
│ Galleries                                  Search Settings │
└────────────────────────────────────────────────────────────┘

Home Panel
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  Home                                                      │
│  欢迎回来，今天想看点什么？            ┌───────────────┐   │
│  从最近看过的继续，或者随手收录新的作品 │ 轻量信息轮换   │   │
│                                          │ 已收录 248 个  │   │
│  [收录新作品]  [查看全部 Gallery]       │      ● ─ ─     │   │
│                                          └───────────────┘   │
│                                                            │
│  ───────────────────────────────────────────────────────   │
│                                                            │
│  最近看过                                                  │
│  [Entry] [Entry] [Entry] [Entry]                           │
│                                                            │
│  最近的 Gallery                                            │
│  [Gallery] [Gallery] [Gallery]                             │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

核心：这是“欢迎页 + 继续入口”，不是数据中心。

---

## 3. Hero

### 主标题

默认：

> **欢迎回来，今天想看点什么？**

副标题：

> 从最近看过的继续，或者随手收录新的作品。

### 主操作

Primary：

- `收录新作品`
- 直接调用现有 Entry create handler / route。

Secondary：

- `查看全部 Gallery`
- 如果现有侧栏已经足够直接，Secondary 可以省略。

### 可选：按本地时间切 greeting

只改变 eyebrow / 辅助文字，不必改主标题：

```ts
const hour = new Date().getHours()
const greeting = computed(() => {
  if (hour >= 5 && hour < 12) return '早上好'
  if (hour >= 12 && hour < 18) return '下午好'
  return '晚上好'
})
```

---

## 4. Ambient Summary：氛围数据，而不是统计卡

首页不要出现：

```text
248 Entries | 12 Galleries | 36 Views | 8 Added Today
```

推荐 Hero 右侧一次只显示一条：

1. `已收录 248 个作品`
2. `当前有 12 个 Gallery`
3. `最近看过《XXX》`

每隔约 5–6 秒换一条。

切换方式：

- opacity 0 → 1
- translateY(6px) → 0
- 280–340ms
- 不做 marquee
- 不做无限横向 ticker

底部放 3 个很短的 segment / dot。

### 数据接口

第一版只需要：

```ts
interface HomeSummary {
  entryCount: number
  galleryCount: number
  recentViews: RecentEntry[]
}
```

不要为了首页做 analytics 数据仓库。

---

## 5. Vue 实现：自动轮换

```ts
const ambientItems = computed(() => {
  const items = [
    {
      id: 'entries',
      title: `已收录 ${summary.value.entryCount} 个作品`,
      detail: '你的收藏正在慢慢变丰富',
    },
    {
      id: 'galleries',
      title: `当前有 ${summary.value.galleryCount} 个 Gallery`,
      detail: '按你自己的方式整理它们',
    },
  ]

  const latest = summary.value.recentViews?.[0]
  if (latest) {
    items.push({
      id: 'recent',
      title: `最近看过《${latest.title}》`,
      detail: formatRelativeTime(latest.lastViewedAt),
    })
  }
  return items
})
```

```ts
const ambientIndex = ref(0)
let ambientTimer: number | undefined

function nextAmbient() {
  if (ambientItems.value.length <= 1) return
  ambientIndex.value = (ambientIndex.value + 1) % ambientItems.value.length
}

function startAmbientRotation() {
  stopAmbientRotation()
  ambientTimer = window.setInterval(nextAmbient, 5200)
}

function stopAmbientRotation() {
  if (ambientTimer !== undefined) {
    window.clearInterval(ambientTimer)
    ambientTimer = undefined
  }
}

onMounted(startAmbientRotation)
onBeforeUnmount(stopAmbientRotation)
```

Vue：

```vue
<Transition name="home-ambient" mode="out-in">
  <div :key="ambientItems[ambientIndex].id" class="home-ambient-message">
    <strong>{{ ambientItems[ambientIndex].title }}</strong>
    <span>{{ ambientItems[ambientIndex].detail }}</span>
  </div>
</Transition>
```

CSS：

```css
.home-ambient-enter-active,
.home-ambient-leave-active {
  transition: opacity 300ms ease, transform 300ms ease;
}
.home-ambient-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.home-ambient-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
```

---

## 6. 自动轮换行为

这些信息只是 ambient，不是重要通知：

- 不使用持续 `aria-live` 朗读。
- hover 到卡片时暂停。
- focus 在切换控件时暂停。
- `document.hidden` 时暂停。
- `prefers-reduced-motion: reduce` 时推荐停止自动轮换。

如果项目已经安装 `@vueuse/core`，可用：

```ts
useIntervalFn()
useDocumentVisibility()
usePreferredReducedMotion()
```

如果没安装，不要仅为了 Home 加依赖。

---

## 7. 最近浏览

Home 真正有用的部分之一。

Desktop 推荐只显示 3–4 个 Entry。

卡片只保留：

- cover
- title
- type / Gallery
- 相对时间（刚刚、昨天、3 天前）

不要在 Home 展示完整 tag / 评分 / metadata。

优先复用项目已有 latest-view / last-view 数据；如果系统已经能按 latest view 排序，就不要建立第二套 history 数据。

如果数据量小，可以前端：

```ts
recentViews = entries
  .filter(entry => entry.lastViewedAt)
  .sort((a, b) =>
    new Date(b.lastViewedAt).getTime() -
    new Date(a.lastViewedAt).getTime()
  )
  .slice(0, 4)
```

如果 Entry 很多，不要全量加载。改为复用现有 API 的 sort + limit 能力。

---

## 8. 最近的 Gallery

Home 不需要展示所有 Gallery。

推荐 3 个：

- 最近打开的 Gallery（如果已有状态）
- 或现有顺序的前 3 个

不要为了 Home 新增 pinned / favorite Gallery 功能。

如果没有 `lastOpenedAt`，第一版直接：

```ts
galleryList.slice(0, 3)
```

即可。

---

## 9. 空状态

推荐条件：

```ts
const isEmptyHome = computed(() =>
  !loading.value && summary.value.entryCount === 0
)
```

以 Entry 为核心，而不是 Gallery。

文案：

> **先收录第一条作品吧。**

> 这里之后会慢慢变成你的收藏入口。现在只需要从第一条记录开始。

Primary：`收录第一条作品`

Secondary：`创建 Gallery`

如果当前业务要求 Entry 必须先属于 Gallery，按钮仍调用现有 create flow，不要在 Home 自己实现新的创建逻辑。

---

## 10. Root Route：最重要的结构修改

当前如果是：

```text
/
→ 第一个 Gallery
```

或：

```text
/
→ legacy empty Gallery
```

修改为：

```text
/
→ Home
```

Gallery 必须显式进入真实 route。

概念示例：

```text
/                     Home
/galleries/:galleryId Gallery
/entries/:entryId     Entry detail
```

**具体 path 必须读取真实 router，不要照抄示例。**

如果是 Vue Router，优先真正增加 root route：

```ts
{
  path: '/',
  name: 'home',
  component: () => import('../pages/HomePage.vue'),
}
```

并移除任何 `redirect: firstGallery` 逻辑。

如果旧架构是“没有 galleryId 就显示 legacy empty Gallery”，可以先安全替换成：

```vue
<HomePage v-if="!galleryId" />
<GalleryView v-else :gallery-id="galleryId" />
```

但长期仍推荐真正 root route。

---

## 11. Browser Back / Forward 验收

必须测试：

```text
Open web
→ Home

Home
→ Gallery A

Back
→ Home

Home
→ Gallery A
→ Entry detail

Back
→ Gallery A

Back
→ Home
```

不能再出现：

```text
Back → random first Gallery
```

或：

```text
Back → legacy Create Gallery empty page
```

---

## 12. 建议组件

不要过度拆分。

第一版：

```text
pages/
  HomePage.vue

components/
  HomeAmbientSummary.vue
  HomeRecentEntries.vue
```

Gallery preview 可以先留在 `HomePage.vue`。

如果已经有 `EntryCard.vue`：

- 优先复用现有卡片的 compact variant。
- 不要复制出第二套完整 EntryCard。

---

## 13. Home 数据 adapter

不要让 `HomePage.vue` 到处调用 API。

```ts
interface HomeData {
  entryCount: number
  galleryCount: number
  recentViews: EntrySummary[]
  galleryPreview: GallerySummary[]
}
```

推荐建立一个薄 adapter，内部映射项目现有 API。

如果多个数据来源独立，可用：

```ts
Promise.allSettled([...])
```

这样 recentViews 失败不会让整个 Home 白屏。

---

## 14. Loading / Error

Home 不需要全屏 spinner。

- Hero 标题直接出现。
- CTA 直接出现。
- Ambient 用一行 skeleton。
- Recent 用固定高度 skeleton card。

局部请求失败则局部降级：

```text
最近看过
暂时无法读取最近浏览。
```

不要把整页替换成 `Failed to load Home`。

---

## 15. Responsive

Desktop ≥ 1024：

```text
Hero 左 65%：Welcome
Hero 右 35%：Ambient Summary
Recent：4 cards
```

Tablet：Hero 上下堆叠，Recent 2 columns。

Mobile：Welcome → CTA → Ambient → Recent。

优先 CSS Grid / media query，不要用 JS 判断屏宽。

---

## 16. 样式建议

```css
.home-page {
  padding: 32px;
}

.home-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(260px, 0.7fr);
  gap: 32px;
  padding-bottom: 32px;
  border-bottom: 1px solid var(--border);
}

.home-title {
  font-size: clamp(40px, 5vw, 64px);
  line-height: 1.08;
  letter-spacing: -0.03em;
}
```

全部继续读取现有主题变量；不要为 Home 再造另一套 accent。

---

## 17. 动效原则

Home 只需要：

1. Ambient：fade + translateY，约 300ms。
2. Entry hover：`translateY(-2px)`，约 150ms。
3. CTA：沿用现有 button hover / pressed。

不要：

- hero parallax
- continuous floating
- infinite bounce
- autoplay cards carousel
- background particles
- count-up 数字动画

---

## 18. 可以直接使用的现成能力

### Vue 自带

- `ref`
- `computed`
- `onMounted`
- `onBeforeUnmount`
- `<Transition>`
- `<TransitionGroup>`（必要时）

### 浏览器

- `setInterval`
- `document.visibilityState`
- `matchMedia`
- `Intl.RelativeTimeFormat`
- CSS Grid
- CSS `clamp()`
- `prefers-reduced-motion`

### 可选

如果已经安装 `@vueuse/core`：

```ts
useIntervalFn
useDocumentVisibility
usePreferredReducedMotion
```

### 不推荐新增

本需求不需要：

- GSAP
- Framer Motion
- Swiper
- Chart.js
- ECharts
- 新 UI component library

---

## 19. Relative time

优先复用项目已有 date util。

否则可用：

```ts
new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
```

目标文案：

```text
刚刚
12 分钟前
昨天
3 天前
```

---

## 20. 文案原则

数字不能成为 KPI。

不要：

```text
248
ENTRIES
```

要：

> 已收录 **248** 个作品

同理：

> 当前有 **12** 个 Gallery

> 最近看过《XXX》

数据应该像欢迎语的一部分，而不是报表。

---

## 21. 本地 agent 实施顺序

### Step 1：审计 router

找出：

- root route
- first-gallery redirect
- legacy empty Gallery
- Back 后回到 empty Gallery 的来源

不要先改 UI。

### Step 2：建立静态 HomePage

只做：

- Hero
- Ambient placeholder
- Recent placeholder
- Gallery preview placeholder

### Step 3：修 root route

让 `/` 真正进入 Home，并先测试 Back / Forward。

### Step 4：接数据

只接：

- entryCount
- galleryCount
- recentViews
- galleryPreview

### Step 5：加 ambient rotation

Vue Transition + 5.2s timer。

### Step 6：接 Empty Home

`entryCount === 0` 时进入 onboarding。

### Step 7：清理 legacy empty Gallery

只有确认没有 route / test 依赖后再删旧实现。

---

## 22. 测试清单

### Routing

- Fresh load `/` → Home
- Back to `/` → Home
- Refresh `/` → Home
- Gallery URL refresh → 原 Gallery
- Entry URL refresh → 原 Entry
- 不再自动打开 first Gallery

### Data

- 0 entry
- 1 entry
- 0 Gallery
- 1 Gallery
- recentViews empty
- recentViews API error
- large counts

### UI

- 1024 / 1440 / 1920
- light / dark
- 六套 accent
- 长中文 / 长英文

### Interaction

- Ambient rotates
- hover pauses
- hidden tab pauses
- reduced motion 简化 / 停止 rotation
- Recent card 使用现有 route
- CTA 使用现有 create handler

---

## 23. 最终验收标准

1. 打开 Web，第一个看到的是 Home。
2. Home 不依赖“第一个 Gallery”存在。
3. Back 不再掉入 legacy empty Gallery。
4. Hero 是视觉第一层，不是统计。
5. 统计一次只出现一条，轻量自动轮换。
6. Recent View 是最主要的继续入口。
7. 无内容时自然变成“收录第一条作品”的 onboarding。
8. Home 某个 API 失败不会导致整页不可用。
9. 不新增重量级库。
10. 不修改 Gallery / Entry 原有业务语义。

## 24. 推荐组件关系

```text
App
└── RouterView
    ├── HomePage
    │   ├── HomeAmbientSummary
    │   ├── HomeRecentEntries
    │   └── Gallery preview / navigation
    ├── GalleryPage
    └── EntryPage
```

**Root route 不再承担任何 Gallery fallback。**
