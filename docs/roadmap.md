# T³ 需求进度与待办 (roadmap)

> 本文件只记录尚未实施或达到规模门槛后才实施的工作。
> 已完成能力的权威说明见 `docs/current-architecture.md`、`docs/http-api.md`、
> `docs/database.md`、`docs/api-contracts.md` 与代码。

## 状态快照（2026-09-09）

- 当前范围内的桌面端、手机端、LAN、导入、搜索、评分、使用记录、合集、
  View later、随机推荐、作者词典与别名、服务端分页及缩略图任务均已完成并验收。
- Gallery、Author、Search、Tag、Recently viewed、Random、View later、Home、
  Author works/directories 与 Collection members 均使用有界服务端查询；Web
  主路径不再依赖完整 Entry/Producer 数组。
- migration 013 已应用于正式数据库，提供稳定分页所需索引。
- cover/preview 上传会生成 512px WebP 卡片缩略图；正式 assets 已完成补建，
  原图仍用于 Entry 详情。
- 手机端 Gallery/Author 跨页进入详情后，顶部 Back 会恢复原页和滚动位置。
- 当前默认测试、集成测试、typecheck、lint、production build、database probe
  与正式数据库 doctor 均通过。
- 正式入口仍为仓库根目录 `T3.exe`；`T3.bat` 仅作备用。

## 延期任务

1. 数据保存/分享（`save-share`）
   - 未来可为 Entry、Author、Collection 提供与 import 结构兼容的归档导出。
   - 当前无实际需求，不实施。

2. 图片资产规模扩展
   - 图片库达到约 10–20GB 后，再评估内容 hash 去重、预计算 ETag、流式响应
     和 assets 增量备份。

3. 搜索规模扩展
   - 数据达到数万条且 SQLite 标题/标签搜索出现可测量延迟后，再评估 FTS5。
   - 在出现真实性能瓶颈前继续使用 SQLite，不引入外部数据库或对象存储。

## 当前执行队列

无。先进入正常使用与数据导入阶段；新工作由实际使用反馈或上述门槛触发。
