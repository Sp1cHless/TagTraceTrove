# 手机端规划简报(给做计划的 agent)

> 目的:一页讲清 T³ 当前状态与手机端工作的真实边界,便于直接产出贴近本地的方案。
> 权威细节以 `current-architecture.md` / `http-api.md` / `api-contracts.md` / `database.md`
> 为准;本文件只做导览,不重复它们。截至 2026-09-06。

## 一句话现状

桌面端功能已完备(两份根目录 plan 与 9-06 桌面收尾任务全部落地；roadmap 仅保留延期的 save/share 想法)。**手机端不需要任何
新功能——不加 schema、不加 API、不加领域逻辑。** T³ 是一个 localhost 单进程 web
应用(`apps/web` 构建产物由 `apps/server` 同源托管),手机端工作的本质是:
让这个现有 web 应用在手机浏览器里通过局域网可用,并把桌面鼠标交互换成触屏等价物。

## 产品与边界(不要在手机方案里越界)

- 本地优先、tag 优先的个人收藏索引;轻量、快速日常使用。
- 不是:通用数据库、PKM、项目管理、媒体播放器、下载器、爬虫。
- Gallery = `entries.type` 的读时投影,不是表;合集(Collections)是唯一的用户
  策展分组(一层嵌套);Author=Producer 仅 UI 改名。
- Entry/Producer 双 tag 词汇表严格隔离;Entry tag 必属于 Facet,Facet 必属于
  同 type 的 Section;Source 永远只是可选内容,不是身份。
- 常见操作禁止对话框(两段式按钮已全量落地);UI 不暴露数据库术语。

## 运行形态(手机端的核心变量就在这里)

- `pnpm build` 后 `T3.exe`(托盘)或 `T3.bat` 启动,单进程 `127.0.0.1:8765`,
  托管 `apps/web/dist` + `/api` 同源。
- `T3_ENABLE_LAN=true` 允许绑定非 localhost(手机浏览器直接开 `http://<电脑IP>:8765`,
  同源所以无 CORS 问题);**完全无鉴权**,开 LAN = 库对局域网可见,需有意识决策。
- API base 在生产构建下取当前页面 origin,开发模式才用 `127.0.0.1:8765`,
  因此手机端无需改 API 寻址。
- 注意:服务进程启动时装载代码,改任何 server 代码必须重启 T3 才生效;
  浏览器端要强刷,否则会出现新旧版本错位的 "Invalid request"。

## 功能地图(均已实现并有测试)

Gallery 浏览 + facet 筛选条 + 评分筛选/排序 + usage 排序;Entry 详情
(Section/Facet 布局编辑、tag 拖拽、有序 Content、评分槽);Author 页
(信息板、独立 tag、Directory 文件夹、按作者/作品 tag 筛选);全局搜索;
最近观看 / 稍后再看 / 随机推荐;合集(作品/作者两类、一层子文件夹、
添加菜单、拖拽移动);SFW/NSFW 分区 + Show NSFW 偏好;正式模板文件
(Advanced editing 里卡片式预览,导入时按多数派落位);作者别名组;
备份/恢复工具(`db:backup` / `db:restore`)。中英双语 i18n。

## 代码导航

- `apps/web/src/GalleryApp.vue` — 壳层与全部视图路由(leaveAllViews/returnView)
- `apps/web/src/` 各页面组件;`components/EntryCard.vue` — 唯一的作品卡片实现
- `apps/web/src/styles/theme.css` — 全部颜色变量(含 6 个 accent 色板,
  `data-accent` 属性驱动);`stores/preferences.ts` — 本地偏好
- `apps/web/src/i18n.ts` — en/zhCN 双字典(同一 key 集合,测试强制)
- `apps/server/src/http/app.ts` — 全部路由;`repositories/` — 领域读写
- `packages/shared/src/schemas/api.ts` — 前后端共享 Zod 契约
- localStorage 键:`t3.locale` `t3.accent` `t3.showNsfw` `t3.view-later`
  `t3.view-later-tabs.order` `t3.recent-tabs.order`

## 手机端实际要做的事(全部是前端/运行层)

1. **触屏交互等价(最大项)**。桌面以下操作全是鼠标拖拽,手机不可用:
   - Entry 编辑中 tag 在 Facet 间拖拽
   - Author 页:作品拖到作品上建 Directory、拖到 Directory 移入、
     拖到移除目标移出(edit 模式)
   - 合集详情:成员拖到子文件夹移入 / 拖到「上一级」目标移出(edit 模式)
   - 侧边栏画廊 tab 拖动排序(最近观看/稍后再看)、合集文件夹拖动排序
   需要设计长按/点选等触屏范式,而非逐个适配。
2. **响应式布局**:全库仅 14 个 `@media`(基本是网格列数)。三栏壳层
   (侧边栏+内容面板)、详情工具栏、Settings 面板都是桌面尺寸,需一次
   系统性收敛(如侧边栏抽屉化)。
3. **LAN 运行验证**:`T3_ENABLE_LAN=true` + Windows 防火墙放行 + 手机实机
   打通;顺便决策无鉴权是否可接受(家庭网络)。
4. **图片性能**:封面/preview 原图直接进卡片网格,无缩略图管线;手机上
   需要缩放方案(导入时生成小图或按需缩放代理)。
5. 可选:PWA manifest(可后置)。

## 明确不需要做的

新表/迁移、新 API 路由、鉴权体系(除非用户要求)、离线同步、服务端渲染、
任何新领域功能。

## 约定与陷阱(方案里要写进执行注意事项)

- Schema 变更必须走新不可变迁移,且顺序是 迁移→probe→real-SQL 集成测试→
  doctor→API→UI;测试永不触碰 `.data/library.db`(内存库/临时文件库)。
- 样式全部 scoped:类名不跨组件共享;卡片视觉只改 `EntryCard.vue` 一处。
- 文案必须进 i18n 双字典,不得硬编码在模板里。
- 验证命令:`pnpm test` / `pnpm test:integration` / `pnpm db:probe` /
  `pnpm db:doctor` / `pnpm lint` / `pnpm typecheck` / `pnpm build`。
