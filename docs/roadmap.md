# T³ 需求进度与待办 (roadmap)

> 本文件是**前向计划**：尚未实施、或达到规模门槛后才实施的工作。
> 已完成能力的权威说明在 `docs/status.md` 与各板块文档（`architecture.md`、`http-api.md`、
> `database.md`、`offline-sync.md`、`mobile.md`、`ui-design.md`、`siteprobe.md`、`development.md`）。
> **进行中的中间状态**（未验收、未完成、下一步）不记在这里，统一放在仓库根目录的 `WORKLOG.md`
> （git-ignored，具体规则见 `AGENTS.md`）。

## 当前执行队列（发布收尾，按顺序）

发布工具链**已就绪**：一键打包 `Release.bat` / `tools/release/release.ps1`，同一次 Web 构建产出签名 APK 与
Windows ZIP；安装 / 更新 / 卸载以及 debug→release 迁移的说明见 `docs/release-installation.md`。

仍待进行：

1. **实机验收** —— 干净 Windows 首次点击 GUI；已有库升级并保留数据；手机配对；离线连续编辑/重连；
   数据库备份/恢复。
2. **宣传视频**。
3. **发布**。

前提（已完成）：Android 正式身份与版本（T3 / 1.0.0 / versionCode 100）与**专用长期 Release 签名密钥**
已就绪并核验（`docs/status.md` §2b）。

## 延期任务（门槛触发，达到门槛再做）

1. **失效 Source 批量维护** —— Source library 已能按站点识别关联作品；等具体站点失效或换域名时，
   再实现预览、批量替换/禁用与回滚流程。
2. **数据保存/分享（`save-share`）** —— 未来可为 Entry / Author / Collection 提供与 import 结构兼容的
   归档导出。当前无实际需求，不实施。
3. **图片资产规模扩展** —— 图片库达到约 10–20 GB 后，再评估内容 hash 去重、预计算 ETag、流式响应
   与 assets 增量备份。
4. **搜索规模扩展** —— 数据达到数万条、且 SQLite 标题/标签搜索出现可测量延迟后，再评估 FTS5。
   在出现真实性能瓶颈前继续使用 SQLite，不引入外部数据库或对象存储。
