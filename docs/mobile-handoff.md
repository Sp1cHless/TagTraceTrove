# Mobile implementation handoff

> 面向后续规划/执行 agent 的直接输入。领域架构以 `current-architecture.md` 为准，产品边界与测量数据以 `mobile-prep-brief.md` 为准。
> 当前桌面版本已验收、commit 并上传；不要再创建“冻结桌面基线”任务。截至 2026-09-06。

## 1. 目标定义

把现有 T³ 单机 Web 产品扩展为可在家庭可信 Wi-Fi 中通过手机浏览器使用的响应式 Web。

实现原则：

- 同一代码库、同一 Hono server、同一 SQLite library、UI/API/assets 同源。
- 不做原生 App；不按某个手机型号写适配。
- Chrome 是主要实机浏览器，但代码采用标准 Web 能力、feature detection 和渐进增强，不写 UA/Chrome 专用分支。
- 可以先交付浏览主路径，但最终手机端除 site-probe 文件夹和 Batch import 外，必须支持全部既有功能，包括创建、编辑、组织和删除。
- 桌面功能和交互继续保留；移动能力是增量实现。

## 2. 已确认范围

### 最终必须支持

- Home、Gallery、Entry、Author、Search。
- Recently viewed、View later、Random、Collections。
- 所有筛选、排序、分页、评分、Like、来源打开和 SFW/NSFW 行为。
- 手工创建 Entry/Author。
- Entry/Author 编辑、Tag 调整、Rating/Content 编辑。
- Author Directory 和 Collection 子文件夹的创建、移动、排序与移出。
- Advanced editing 的全部现有非 import 能力。
- 删除 Entry、Author、Collection、Directory、Content、Facet 等现有可删除对象。
- Settings、主题、六种 accent、语言和显示偏好。

### 明确桌面专用

- site-probe 文件夹导入。
- Batch import。
- 与上述 import 文件夹选择、拖放、预览和一次性检查合集直接相关的流程。

### 当前不做

- save/share archive export。
- PWA、Service Worker、离线同步。
- 原生 App 或应用商店打包。
- 公网访问、自动端口映射、设备发现。
- 家庭可信 Wi-Fi 之外的无鉴权暴露。

## 3. 不可推翻的产品/架构约束

- Gallery 是 `Entry.type` 的读时投影，不是表。
- Collection 是唯一持久化策展分组；Entry 一层嵌套，Producer 扁平。
- Entry/Producer Tag 词汇严格分开；Entry Tag 必须位于同 type Section 下的 Facet。
- 新 schema 必须使用新不可变 migration，并按 migration → probe → real-SQL integration → doctor → API → UI 顺序。
- 测试永不写 `.data/library.db`；所有写入测试使用内存库或隔离临时文件库。
- `EntryCard.vue` 是唯一作品卡片实现，不能按页面复制卡片。
- 所有可见文案走 `i18n.ts` en/zh-CN 双字典。
- 颜色走 `theme.css` token；保持 light/dark 和六个 accent。
- 媒体保持自然宽高比，禁止为了手机卡片使用 `object-fit: cover` 裁切 Entry 页面。
- Sidebar 导航始终拥有最高优先级；Back 必须恢复真实来源。
- 破坏性操作继续使用两段式确认，禁止恢复 `window.confirm`。

## 4. 当前技术事实

- Web：Vue 3 `<script setup>` + TypeScript + Vite；无 UI/CSS 框架。
- Server：Node + Hono + better-sqlite3；生产 server 托管 `apps/web/dist`。
- 默认地址：`127.0.0.1:8765`。
- LAN 绑定必须同时设置：

```text
T3_ENABLE_LAN=true
T3_HOST=0.0.0.0
```

- 生产 API base 已由当前页面 origin 推导，手机 LAN 地址无需另写 API base。
- `T3.exe` 默认固定 localhost；托盘可显式开启/关闭 LAN，会安全设置两个 LAN 环境变量，并列出所有私有 IPv4 手机 URL 供点击复制。
- 当前约 20 个 media query、44 个 drag/drop 事件绑定；现有响应式主要只有网格列数变化。
- 正式 assets 测量：180 files / 40.5 MB；91 个 Entry 目录；每 Entry 中位数约 430.5 KB、最大约 1.11 MB。
- `EntryCard` 当前未声明 `loading="lazy"` 或 `decoding="async"`。
- 当前测试基线：default 136；integration 158；typecheck/lint/build/probe/doctor 全绿。

## 5. 已完成的数据共享基础（2026-09-07）

`View later` 已从设备本地状态迁移为电脑和手机共享的 library data：

- `011_view_later.sql` + repository + HTTP/shared contract 已落地，SQLite 是唯一权威来源。
- `GET /api/view-later` 读取完整列表；PUT/DELETE membership 幂等；merge 只并入、不覆盖 server 已有数据。
- 旧 localStorage `t3.view-later` 在首次成功启动时去重并入；悬挂的已删除 Entry id 被忽略；成功后旧 key 删除。
- 启动、进入 View later、窗口重新聚焦时拉取；本机 mutation 采用 server 返回状态；请求串行以防 stale response 回写。
- 不要求 WebSocket/SSE。另一设备允许短暂陈旧，但刷新、重新进入或聚焦后必须收敛一致。
- locale、accent、Show NSFW、rows per page 和 tab order 仍保持设备本地。

## 6. 阶段 1：LAN 运行形态（✅ 已完成并实机验收）

### 目标

用户从 `T3.exe` 明确开启 LAN 后，手机 Chrome 能通过家庭 Wi-Fi 访问同一 library；默认启动仍只监听 localhost。

### 工作项

1. 给 launcher 增加 LAN 开关/菜单或等价的显式启动选择。
2. LAN 模式向 server 传入 `T3_ENABLE_LAN=true` 和 `T3_HOST=0.0.0.0`。
3. 继续用 localhost 做电脑端健康检查和 Open T3。
4. 枚举私有 IPv4 地址，显示/复制手机 URL；多网卡时不要任意假定唯一地址。
5. 显示“仅可信家庭网络”提示和关闭 LAN 的路径。
6. 编写 Windows Private network 防火墙说明；未经用户确认不自动改防火墙。
7. 在隔离 SQLite backup 上验证 `/`、`/api/galleries` 和 `/api/assets/...`。
8. 添加 host guard、launcher 参数/环境设置和生命周期验证。

### 验收

- 默认模式不能从 LAN 访问。
- LAN 模式可由手机访问，电脑 localhost 仍可访问。
- Tray Exit 同时结束监听进程。
- 手机访问不回连 `127.0.0.1` 获取 API/assets。
- 公共网络风险提示清晰。

### 实施状态（2026-09-07）

- `Allow phone access (LAN)` 默认关闭；开启前显示可信家庭网络警告，切换会重启 launcher 拥有的 server，关闭后恢复 localhost-only。
- `Open T3` 和 launcher 健康检查始终走 `127.0.0.1:8765`；`Mobile addresses` 单独列出并复制全部 RFC1918 IPv4 URL。
- T3 不自动修改 Windows Firewall；托盘帮助和 `mobile-prep-brief.md` 只指导为 Node.js 放行 Private network，明确禁止 Public network。
- server host guard、launcher 参数/环境/地址/进程树退出定向测试已通过。
- 隔离数据库在 localhost、`192.168.50.155` 和本机第二私有网卡地址上验证 `/`、`/api/galleries` 与 `/api/assets/...` 均返回 200；隔离服务和数据已清理。
- 真实手机 Chrome 已通过同一 Wi-Fi 打开 `http://192.168.50.155:8765`；Tray Exit 后刷新立即失效，生命周期验收通过。
- 若 Chrome 报“无法提供安全连接”，确认地址仍为 `http://`，并关闭“始终使用安全连接”；当前可信家庭 LAN 阶段不提供 HTTPS。

## 7. 阶段 2：响应式 shell 与浏览主路径

状态：**✅ 已完成并通过真实手机 Chrome 验收。**

实机反馈修正：Entry detail 点击 Tag 后新结果页强制回到顶部；Collections / View later 的移除按钮改为封面左上角的小圆形视觉，同时保留 44px 触摸命中区；Entry 与 Author View later 的独立状态增加回归测试，历史误入的 Author works 已在备份后清理。

当前实现：

- `44rem` 以下使用左侧 drawer；header 保留 Menu、主题和 Settings，drawer 包含搜索、全部 destinations 与创建入口。
- drawer 支持关闭按钮、遮罩、Escape 和 Browser Back；选择 destination 后自动关闭并保留目标页面。
- Home、Gallery、Entry、Author、Search、Recent、View later、Random、Collections 均已做窄屏溢出检查；桌面 sidebar 保持原布局。
- Gallery/Author Facet filter 在移动端默认折叠，可通过 44px `Show/Hide filters` 打开完整 filter surface；筛选组合语义未改变。
- Entry 中 Author 与 Tag chip 在 read mode 使用标准单击 button，不再要求双击；媒体翻页、详情工具栏、筛选、Settings、分页和主要控件提供 44px 触控区。
- tabs 与分页在自身区域横向滚动，不扩大页面宽度；shell 使用 `safe-area-inset-*` 与 `100dvh`。
- Chromium 已检查 360/390/430/768/1280px、844×390 横屏和 390×420 软键盘近似视口；这些视口的 document width 未超过 viewport/client width。

### 首批页面

Home → Gallery → Entry → Author → Search → Recent/View later/Random/Collections。

### Shell 要求

- 窄屏 sidebar 使用可关闭抽屉或经确认的等价导航；不能只是堆到正文上方。
- 搜索、Settings、Home 和主要 destinations 在单手操作下可达。
- 打开 destination 后 drawer 自动关闭；Browser Back 和应用 Back 不产生空页。
- Header、content panel、分页、连接式 tabs 无页面级横向溢出。
- 使用 360/390/430/768px 和现有桌面宽度检查。
- 支持 `safe-area-inset-*`、横屏和软键盘。
- 触控目标原则上不小于 44×44px。

### 页面要求

- Entry/Author 工具栏在窄屏换行、折叠或转为移动 action area。
- Facet filter 在小屏使用折叠面板或独立 filter surface；保留全部组合语义。
- 连接式 tabs 可以横向滚动，active tab 必须自动可见。
- 卡片继续复用 `EntryCard.vue`，不裁切媒体。
- 44rem 以下每页行数使用 Settings rows 的两倍；桌面保持原值。
- View later Author 详情返回时恢复 View later 的 Authors tab。
- Hover 只能提供增强，不能承载唯一提示或操作。

## 8. 阶段 3：统一触屏编辑/整理

状态：**✅ 已完成。** New Entry / New Author、Entry / Author 编辑控件和二次点按删除确认已完成移动适配；窄屏 Rating 改为紧凑网格，完整五星不再被标题、排序按钮挤出。Entry Tag 已支持点选后移至目标 Facet；Author Work 已支持 Move here / Group with / Move out；Collection Work 已支持父子文件夹间 Move here / Move out，顶层 Collection 在编辑模式提供 44px 前移/后移按钮；Recently viewed / View later 的 Gallery tabs 使用第一排 Reorder 图标，激活后原位只显示左右箭头，并将两页顺序分别保存在设备本地。全部保留桌面 drag。导航会话按 surface/context 保存活动 tab、分页、筛选/排序状态、Collection/Author/Directory 路径与逐层滚动栈；打开子页显式置顶，Back 恢复直接父页。全局 top bar 在主题/Settings 旁提供 Back（Home 禁用），Entry/Author 右下角提供固定回顶部按钮。

不要直接把 HTML5 drag-and-drop 当作手机方案。先做一个 spike，确定统一模型后复用。

推荐基础模型：

1. 点按显式“整理/移动”进入选择模式。
2. 点选对象；长按可作为进入该模式的快捷方式。
3. 显示可选目标或底部 action area。
4. 明确显示选中对象、目标和取消操作。
5. 执行后使用现有 API，保持桌面 drag 行为不变。

必须映射：

- Tag → Facet。
- Work + Work → 新 Directory。
- Work → Directory；Directory member → loose works。
- Collection member → child folder；child member → parent。
- Recent/View later tab 排序。
- Collection 排序。

实现可抽取共享的 selection/move 状态或控件，但不要先建立泛化框架再寻找用例。

## 9. 阶段 4：完整非 import 写能力（✅ 已完成）

阶段 3 的响应式与触屏整理工作已同时补齐：

- 手工创建 Entry/Author。
- Entry 的 Section/Facet/Tag/Content/Rating/Author link 编辑。
- Author 信息、Tag、Rating、Directory 编辑。
- Collection 创建、改名、成员和子文件夹管理。
- Advanced editing 五个 tab。
- 所有删除入口。

删除验收：

- 按钮触控可达。
- 首次点击只武装，第二次才执行。
- 武装状态和取消/超时清晰。
- 不出现原生 confirm。
- 删除后返回上下文正确，相关 asset/关联清理沿用现有 server 行为。

## 10. 阶段 5：当前架构内图片性能（✅ 已完成）

当前架构内已完成：

1. 真实手机 Chrome + 家庭 LAN 记录 Gallery 首屏、滚动和详情加载。
2. 共享卡片图片经 `IntersectionObserver` 批准后才赋真实 URL；批准后立即请求，不再叠加 native `loading="lazy"`，并保留 `decoding="async"`。
3. 图片完成加载前保持不可见并保留卡片占位；无 `IntersectionObserver` 时立即赋值，避免旧浏览器空图。
4. asset route 使用 ETag revalidation；返回已访问 Gallery 时可复用浏览器缓存。

2026-09-07 桌面 CDP 初测：返回 Gallery 会因 Vue 分支重建重新创建图片节点；旧 asset `no-store` 让一次返回产生 20 个 200 请求，本机约 108ms，并非单纯设备机能。asset route 已改为内容 ETag + `private, max-age=0, must-revalidate`；缓存热身后同路径返回可为零图片请求，同时替换同 URL 媒体会因 ETag 变化拿到新内容。首次访问新图片的传输/解码成本仍存在；若未来出现实测性能回归，再在万级规模阶段以真实请求数、字节数和可见图片完成时间为准评估。

派生缩略图会牵涉生成、旧数据回填、删除、备份/恢复、asset route 与持久化契约，已明确移入“万级数据规模/数据库架构升级”边界，本轮不启动；不得只在 CSS 中缩小原图冒充优化。

## 11. 浏览器策略

- Chrome 为主验收，但实现不绑定 Chrome。
- 使用 Pointer Events/标准点击和键盘语义，不写 UA 分支。
- 避免依赖 touch-only 或 mouse-only 事件。
- 关键功能使用语义 button/input/select；自定义控件保留 focus-visible 和键盘路径。
- 如果没有第二台真实设备，至少做 Chromium 桌面窄屏模拟和 WebKit/Safari 风险审查。
- 不因为 iOS Chrome 也叫 Chrome 就假定它与桌面 Chromium 同引擎。

## 12. 验收矩阵

每阶段至少检查：

- 360×800、390×844、430×932、768px/tablet、现有桌面宽度。
- 竖屏、横屏、软键盘打开。
- light/dark × 六个 accent。
- Show NSFW 开关前后。
- 空数据、少量数据和满页数据。
- 长标题、无封面、四层媒体 stack。
- 从 Search/Tag/Author/Recent/View later/Random/Collection 打开 Entry 后的 Back。
- 所有触屏写操作的成功、取消和 API 失败状态。
- 无页面级横向溢出、无裁切、无 hover-only 功能。
- 家庭 LAN 真机访问和关闭 LAN 后不可访问。

质量闸门：

```text
pnpm test
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm build
pnpm db:probe
pnpm db:doctor
```

浏览器写入验证只使用正式数据库的隔离 backup；不得对 `.data/library.db` 写测试数据。

## 13. 执行纪律

- 每阶段先写针对行为的 RED 测试，再做最小修改。
- 响应式 CSS 必须同步检查桌面，不做整页重写。
- 发现一个重复交互至少在第二个真实用例出现后才抽象。
- 不在移动任务中顺手增加新领域功能。
- 每阶段完成后更新本 handoff 与 `current-architecture.md`，并立即收口等待验收。
