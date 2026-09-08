# 手机端准备简报

> 目的：定义 T³ 从已验收桌面产品进入手机端工作的真实边界、已拍板决策、待解决问题与质量门槛。
> 权威领域细节见 `current-architecture.md`、`http-api.md`、`api-contracts.md`、`database.md`。
> 截至 2026-09-06；桌面基线已由用户 commit 并上传，不再重复做冻结提交。

## 1. 已拍板方向

- 手机端继续使用同一套响应式 Web，不做原生 App，不绑定具体手机型号。
- 主要实机浏览器为 Chrome；实现必须采用标准 Web 能力与 feature detection，禁止 UA 判断和 Chrome 专用分支。其他现代浏览器至少保持基础可用。
- 当前只考虑家庭可信 Wi-Fi。第一版 LAN 模式不增加鉴权，但必须显式开启并显示安全提示；不支持在 NUS、酒店或公共网络裸露服务。
- 可以分阶段先做浏览体验，但最终手机成品除 site-probe 文件夹/批量 import 外，必须覆盖桌面端现有功能，包括创建、编辑、整理与删除。
- 删除继续使用现有两段式确认，不引入原生 confirm/dialog。
- save/share、PWA、离线同步和原生封装不属于当前手机端准备范围。

## 2. 最终手机端功能边界

必须支持：

- Home、Gallery 浏览、分页、Facet/Author/Rating/Usage 筛选与排序。
- Entry 详情、来源链接、评分、Like、View later、Collection 操作。
- Author 列表、详情、Tag 筛选、Directory 整理。
- Search、Recently viewed、View later、Random、Collections。
- SFW/NSFW、主题、accent、语言、每页行数等设置。
- 手工创建 Entry/Author，以及所有现有非 import 编辑能力。
- Tag 在 Facet 间移动、Directory 创建/移入/移出、Collection 子文件夹整理与排序。
- Advanced editing 中现有的词典、作者归并、未分类 Tag、模板预览和作者别名能力。
- 所有现有删除操作；手机上必须能完成且仍保持两段式确认。

桌面保留：

- site-probe 文件夹导入。
- Batch import。
- 依赖桌面目录拖放/文件夹选择的导入检查流程。

“import 不支持手机”不等于手机只读；除上述 import 流程外，最终目标是完整读写能力。

## 3. 当前架构与移动端边界

- Vue 3 + Vite 前端、Hono + SQLite 服务端，生产环境由一个 server 同源托管 UI 与 `/api`。
- Gallery 是 `Entry.type` 的读时投影；Collection 才是持久化分组。
- 当前领域 API 基本足以支撑手机功能，不应为响应式布局新增 schema 或业务路由。
- 所有工作卡片统一由 `components/EntryCard.vue` 渲染；手机卡片也必须复用它。
- `GalleryApp.vue` 管理 sidebar、全页视图和 Back 上下文。手机导航必须保留 `leaveAllViews` / `returnView` 语义。
- 颜色只来自 `styles/theme.css`；所有新增文案同时进入 `i18n.ts` 的 en/zh-CN 字典。
- 当前质量基线：default Vitest 136 tests；server integration 158 tests；typecheck、lint、build、probe、doctor 均通过。

## 4. LAN 运行形态：当前事实与准备任务

当前 server 实现并不是只设置 `T3_ENABLE_LAN=true` 就会自动监听局域网：

```text
T3_ENABLE_LAN=true
T3_HOST=0.0.0.0
```

两个条件必须同时满足。`T3_ENABLE_LAN` 是越过非 localhost 绑定保护的显式许可，`T3_HOST` 才决定实际监听地址。

当前 `T3.exe` 已完成 LAN 启动基础：

- 默认仍显式设置 `T3_ENABLE_LAN=false`、`T3_HOST=127.0.0.1`，只监听 localhost。
- 托盘菜单 `Allow phone access (LAN)` 经可信网络确认后重启同一 server，并设置 `T3_ENABLE_LAN=true`、`T3_HOST=0.0.0.0`。
- 电脑端探活和 `Open T3` 始终使用 `http://127.0.0.1:8765`。
- `Mobile addresses` 枚举所有启用网卡上的 RFC1918 私有 IPv4，不假定唯一网卡；点击任一 URL 即复制。
- 开启 LAN 时明确提示只在可信家庭网络使用，并给出托盘关闭路径；T3 不自动修改 Windows 防火墙。

Windows Firewall 手动放行（仅在手机无法连接时）：

1. 打开 Windows Security → Firewall & network protection，确认当前 Wi-Fi 是 `Private network`。
2. 进入 `Allow an app through firewall` → `Change settings`。
3. 仅为 `Node.js JavaScript Runtime` 勾选 `Private`，不要勾选 `Public`。
4. 离开可信网络前，在 T3 托盘取消 `Allow phone access (LAN)`。

LAN host guard 与 launcher 的参数、环境变量、私有地址及进程树退出已有定向测试。隔离数据库验证覆盖 localhost 与每个本机私有 IPv4 上的 UI、`/api/galleries` 和 asset；真实手机 Chrome 已在同一 Wi-Fi 通过 `http://192.168.50.155:8765` 验收，Tray Exit 后连接立即失效。若 Chrome 报“无法提供安全连接”，需确认地址仍为 `http://`，并关闭 Chrome 的“始终使用安全连接”；当前可信家庭 LAN 阶段不提供 HTTPS。

## 5. 浏览器兼容原则

- 以 Chrome 作为主要实机验收浏览器，不把 Chrome 当成实现前提。
- 以响应宽度、Pointer Events、标准表单、CSS media/container 能力和 feature detection 为基础。
- 不通过 user-agent 判断手机或浏览器。
- 长按只能是快捷方式，不能是唯一入口；所有关键操作必须有可发现的点按路径。
- 不依赖 hover 才能发现或执行操作。
- iOS 上的 Chrome 仍使用 WebKit，因此不得把“Chrome 测过”误当成跨引擎验证；若用户没有 iPhone，则至少通过窄屏模拟与基础 Safari/WebKit 风险检查。
- PWA/Service Worker 需要 HTTPS 等安全上下文能力，当前普通家庭 LAN HTTP 阶段不以此为目标。

## 6. 触屏交互准备

当前前端约有 44 处 drag/drop 事件绑定。需要先建立统一的触屏语义，再逐页落地：

- Tag：点选 Tag → 选择目标 Facet → 确认移动。
- Author Directory：选择作品 → 新建 Directory / 移入已有 Directory / 移回 loose works。
- Collection：选择成员 → 移入子文件夹 / 移回父文件夹。
- 排序：进入显式排序模式，使用上移/下移或可访问的触屏排序控件；不把原生 HTML5 drag 当作手机唯一方案。
- 长按可进入选择模式，但必须提供普通按钮入口、取消入口和当前选择提示。
- 鼠标拖拽继续保留，触屏路径是等价补充而不是替换桌面行为。

应先在一个 Author Directory 或 Collection 场景做 spike，确认模式后抽取可复用状态/控件。

## 7. 响应式准备

当前约有 20 个 `@media`，多数只改变网格列数。主壳层在 44rem 以下只是把 18rem sidebar 堆到内容上方，不是完整手机导航。

计划必须先定义：

- sidebar 抽屉/底部导航结构和打开、关闭、Back 行为。
- header、搜索和 Settings 的窄屏位置。
- Entry/Author 详情工具栏的换行或移动端 action bar。
- Facet filter 的折叠/全屏面板形态。
- 连接式 tabs 的横向滚动和选中可见性。
- 表单、评分、分页、Advanced editing 多 tab 的窄屏形态。
- 360/390/430/768px、横屏、软键盘与 `safe-area-inset-*`。
- 最小 44×44px 触控区域、无横向页面溢出、无 hover-only 功能。
- 桌面布局不得因移动端 CSS 回归。

不要预先大规模重构 `GalleryApp.vue`。仅在 shell spike 证明必要时抽取 Sidebar/Header/Settings。

## 8. 图片性能准备

正式数据当前有 180 个 asset 文件，共约 40.5 MB；91 个 Entry 媒体目录，单 Entry 媒体总量中位数约 430.5 KB，最大约 1.11 MB。`EntryCard.vue` 当前没有原生 lazy loading 或 async decoding 提示。

顺序：

1. 在真实家庭 LAN + 手机 Chrome 记录首屏请求量、图片解码、滚动和内存表现。
2. 先尝试 `loading="lazy"`、`decoding="async"`、离屏渲染控制和正确尺寸提示。
3. 复测后仍有问题，才设计缩略图。
4. 若生成缩略图，必须定义生成/删除、旧数据回填、asset 路由、备份恢复和无裁切规则；优先使用可由 Entry id 推导的文件，不轻易新增数据库字段。

CSS 缩小显示尺寸不会减少原图传输量，不能把视觉缩放当作性能方案。

## 9. View later 共享状态（2026-09-07 已实现）

用户已拍板：电脑和手机必须使用同一个 View later 数据源；可以不实时推送，但刷新后必须收敛一致。

- `011_view_later.sql` 与 `012_view_later_producers.sql` 分别建立 library-wide Entry/Author 有序列表，SQLite 是唯一权威来源。
- GET、两类主体的幂等添加/移除和 Entry legacy merge API 已落地；删除 Entry 或 Author 会级联清理 membership。
- 首次升级会把旧 localStorage `t3.view-later` 去重后 merge 进 server，成功后删除旧 key；已删除 Entry 的悬挂 id 会被安全忽略。
- 页面启动、进入 View later、窗口重新聚焦都会重新读取 server；本机 mutation 后直接采用 server 响应。
- 客户端请求串行化，避免慢速旧响应覆盖较新的操作。
- 当前不使用 WebSocket/SSE，因此另一设备可以短暂显示旧列表，但重新进入、聚焦或刷新后必须一致。
- locale、accent、Show NSFW、每页行数和 tab 顺序仍是设备本地偏好。

## 10. 推荐实施阶段

0. ✅ 共享 View later 数据与收敛式同步基础（2026-09-07）。
1. LAN 启动形态和实机连通。
2. 响应式 shell、导航与只读浏览主路径。
3. Search、筛选、Recent/View later/Random/Collections 的移动布局。
4. 通用触屏选择/移动模式。
5. 手工创建、编辑、整理与删除能力。
6. Advanced editing 等低频管理页面。
7. 图片性能、跨浏览器和完整回归。

每阶段都保留桌面行为，不等最终阶段才检查桌面回归。
