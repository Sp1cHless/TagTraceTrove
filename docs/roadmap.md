# T³ 需求进度与待办 (roadmap)

> 本文件是**前向计划**：尚未实施、或达到规模门槛后才实施的工作。
> 已完成能力的权威说明在 `docs/status.md` 与各板块文档（`architecture.md`、`http-api.md`、
> `database.md`、`offline-sync.md`、`mobile.md`、`ui-design.md`、`siteprobe.md`、`development.md`）。
> **进行中的中间状态**（未验收、未完成、下一步）不记在这里，统一放在仓库根目录的 `WORKLOG.md`
> （git-ignored，具体规则见 `AGENTS.md`）。

## 后续版本交付

发布工具链**已就绪**：一键打包 `Release.bat` / `tools/release/release.ps1`，同一次 Web 构建产出签名 APK 与
Windows ZIP；安装 / 更新 / 卸载以及 debug→release 迁移的说明见 `docs/release-installation.md`。

正式发布基线为 **1.0.14**。后续版本沿用以下交付顺序：

1. **发行包回归验收** —— Windows 首次点击 GUI；已有库升级并保留数据；手机配对；离线连续编辑/重连；
   数据库备份/恢复。
2. **宣传视频**。
3. **按新版本号打包与发布**。

前提（已完成）：Android 正式身份与版本线（当前发布版 T3 / 1.0.14 / versionCode 114）与**专用长期 Release 签名密钥**
已就绪并核验（`docs/status.md` §2b）。

## 延期任务（门槛触发，达到门槛再做）

1. **更多失效 Source 站点支持** —— 现有来源维护已提供检索、证据复核与追加来源；等具体站点失效或换域名时，
   根据该站点补充适配与恢复流程。
2. **数据保存/分享（`save-share`）** —— 未来可为 Entry / Author / Collection 提供与 import 结构兼容的
   归档导出。当前无实际需求，不实施。
3. **图片资产规模扩展** —— 图片库达到约 10–20 GB 后，再评估内容 hash 去重、预计算 ETag、流式响应
   与 assets 增量备份。
4. **搜索规模扩展** —— 数据达到数万条、且 SQLite 标题/标签搜索出现可测量延迟后，再评估 FTS5。
   在出现真实性能瓶颈前继续使用 SQLite，不引入外部数据库或对象存储。





## 其他产品计划

- 背景自定义。
