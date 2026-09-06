# Mobile planning handoff (手机端规划输入)

> 目的:给做计划的 agent 一页看清当前状态,产出贴合本地实际的手机端方案。
> 权威细节见 `docs/current-architecture.md` / `docs/http-api.md` / `docs/ux-rules.md`,
> 本文件只做索引和要点,不重复正文。

## 1. 当前状态(2026-09)

- **桌面端功能完成态**:评分、使用记录(观看/点赞)、SFW/NSFW 分区、全局搜索、
  合集(一层嵌套)、稍后再看、正式模板文件、作者别名组、作者筛选、随机推荐、
  备份恢复全部落地;roadmap 无待办。作者别名组等真实数据验收中。
- **技术栈**:Vue 3 + Vite(web)/ Node + Hono(server)/ SQLite + better-sqlite3 /
  Zod contracts(`packages/shared`)。单仓库 pnpm workspace。
- **运行形态**:单进程 `127.0.0.1:8765`,生产模式 server 托管 `apps/web/dist`
  (UI/API 同源);`T3.exe` 托盘启动。开发 `pnpm dev:server` + Vite 5173。
- **质量闸门**(必须遵守):schema 变更走 不可变迁移 → db:probe → real-SQL
  集成测试 → db:doctor → API → UI。测试永不碰 `.data/library.db`。

## 2. 与手机端直接相关的事实

- **LAN**:`T3_ENABLE_LAN=true` 才允许绑非 localhost;客户端 API 地址生产模式
  取同源 `/api/`,手机浏览器开 `http://<电脑IP>:8765` 理论可通,未实测;Windows
  防火墙需放行。**无任何鉴权**——开 LAN = 库对局域网裸奔,需有意识决策。
- **无缩略图管线**:封面/preview 原图存储、原图直出(`apps/server/src/import/media.ts`
  只有 store/read/delete)。卡片网格加载原图,手机流量/速度不可接受。
- **交互全部是桌面拖拽**:作品拖作品建 Directory、拖进 Directory/合集子文件夹、
  Tag 拖拽换 Facet、拖动排序。无 hover、无长按、无触屏等价物——这是最大的
  设计缺口,plan 原文要求 directory 交互"像手机桌面合成文件夹"。
- **响应式不完整**:仅 14 处 `@media`(多为网格列数);三栏壳层(侧边栏+内容
  面板)、详情工具栏、Settings 面板是桌面尺寸。`index.html` 已有 viewport meta。
- **对话框已清零**:破坏性操作全部是两段式按钮(`apps/web/src/armable.ts`),
  无 window.confirm——触屏友好,可直接沿用该模式。

## 3. 已定方向(不要推翻)

- 手机端 = **响应式 web 优先**(同一代码库、同一 server),PWA manifest 后置,
  不做原生/打包 app。
- 严禁引入 AGENTS.md 禁项:通用数据库、公式系统、PKM、播放器、下载器、爬虫、
  数据库术语出现在 UI。
- UX 规则(`docs/ux-rules.md`)继续生效:Gallery before table、click before
  dialog、共享 EntryCard 唯一卡片实现、sidebar 最高优先级导航、连接式标签页、
  usage 仅排序等。

## 4. 方案需要回答的决策点

1. 触屏交互映射:每个拖拽交互的长按/点选等价物(逐项列出,见 §2 第三条)。
2. 布局收敛:侧边栏在窄屏的处理(抽屉/折叠)、详情工具栏换行策略。
3. 图片策略:导入时生成缩略图 vs 请求时按需缩放;缩略图要不要落盘/进备份。
4. LAN 运行形态:是否加最小鉴权(PIN/token)?防火墙/发现机制的说明方式。
5. 范围切分:第一版手机端包含哪些视图(建议:浏览/筛选/详情/随机/最近观看
   优先,整理类操作跟随触屏交互设计)。

## 5. 关键文件入口

- 布局壳层与视图路由:`apps/web/src/GalleryApp.vue`(`leaveAllViews`/`returnView`)
- 共享卡片:`apps/web/src/components/EntryCard.vue`
- 页面:Gallery 内联于 GalleryApp;其余 `AuthorPage` / `RecentViewPage` /
  `ViewLaterPage` / `CollectionsPage` / `SearchPage` / `RandomPage` /
  `AdvancedEditingPage` / `AddEntryPage`
- 偏好(localStorage):`apps/web/src/stores/preferences.ts`(showNsfw /
  view-later / accent)
- 服务端入口:`apps/server/src/http/server-cli.ts`(LAN 开关在此)
- 测试:`apps/web/tests`(vitest + jsdom)、`apps/server/tests/integration`
  (real-SQL)、`vitest.integration.config.ts`

## 6. 验收基线

改动后必须全绿:单元测试(`pnpm test`)、real-SQL 集成
(`pnpm test:integration`)、web 测试(`apps/web` 下 vitest)、
`db:probe` / `db:doctor`、`pnpm build`。当前数字参考:单元 ~278 /
集成 ~158 / web ~104。
