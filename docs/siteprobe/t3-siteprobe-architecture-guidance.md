# T³ 与 SiteProbe 正式架构指导

> 文档目的：固定 T³、SiteProbe Core、Adapter Builder 与站点 Adapter 之间的长期边界。  
> 本文件描述正式开源后的代码组织、仓库边界、adapter contract、发布/更新原则以及后续 T³ 对接时必须遵守的架构约束。  
> 本文件不是具体接口实现计划；其中依赖本地实现才能确认的内容，已按 2026-09-19 的 T³ 与 SiteProbe 工作区现状补齐。

---

# 1. 总体定位

T³ 是一个：

> **内容中立、local-first、可自由组织作品/媒体/收藏数据的个人管理工具。**

SiteProbe 是 T³ 的一个正式子系统，但工程规模可以独立达到项目级：

> **SiteProbe = 将网页中的作品/媒体元数据转换成标准结构的可扩展采集系统。**

SiteProbe 不能被定义为：

- 某类内容专用 scraper；
- 某几个网站的爬虫合集；
- T³ 中散落的一组站点 if/else。

正确关系：

```text
T³
│
├── Library / DB / Taxonomy / Collections / Import UI
│
└── SiteProbe
    ├── Generic Capture
    ├── Adapter Runtime
    ├── Adapter Builder
    ├── Candidate Harvester
    ├── Review / Selection
    └── Adapter Contract
```

具体网站支持属于 Adapter 生态，不属于 T³/Core 身份。

---

# 2. 最关键的架构边界

必须长期保持：

```text
T³ Core
    不知道具体网站怎么抓

SiteProbe Core
    不知道具体内容领域是什么

Adapter
    只知道自己的 domain / page structure

T³ Database
    只消费标准化结果
```

禁止：

```text
T³ core:
if site == ...

SiteProbe generic:
if site == ...

DB schema:
specific_site_special_field
```

---

# 3. GitHub 仓库建议

正式开源后建议拆为以下层级。

```text
GitHub account / organization
│
├── TagTraceTrove
│
├── siteprobe-adapters
│
├── siteprobe-adapters-sensitive      # 名称最终另定
│
└── siteprobe-adapter-template        # 后期再做
```

其中第三个仓库表示：

> 默认不随 T³ 分发的内容敏感/年龄受限等 adapter pack。

本文件只规定**隔离原则**，不规定具体站点、安装入口或站点列表。

---

# 4. 主仓库：TagTraceTrove

主仓库是：

- 项目主页；
- README；
- screenshot/demo；
- release；
- portfolio；
- 普通用户默认下载来源。

应包含完整 T³ 与 SiteProbe Core。

示意：

```text
TagTraceTrove/
│
├── apps/
│   ├── web/                    # Vue/Vite 前端
│   └── server/                 # Hono API、SQLite、import 与媒体存储
│
├── packages/
│   └── shared/                 # T³ 前后端共享 schema/types
│
├── siteprobe/                  # 迁入主仓库后的 Python 子系统；当前仍在独立工作目录
│   ├── src/
│   │   ├── generic/            # runtime/core
│   │   └── builder/            # Candidate Harvester / Adapter Builder
│   ├── adapters/
│   │   ├── builtin/
│   │   └── examples/
│   ├── schema/
│   └── tests/
│
├── tools/
│   └── t3-launcher/            # Windows 托盘启动器
│
├── docs/
│   ├── siteprobe/
│   └── ...
│
├── README.md
└── LICENSE
```

本地现状中只有 `apps/server`、`apps/web` 与 `packages/shared` 三个 workspace package；数据库和 importer 都位于 `apps/server/src/`，并不存在独立的 `packages/database` 或 `packages/importer`。SiteProbe 当前位于 `D:\Project\Dataextracted\site_probe\generic_probe`，是 Python 3.11 项目。迁入主仓库时采用顶层 `siteprobe/` subtree，比把 Python 工程伪装成 pnpm package 更符合现有语言和发布边界；是否以后独立发包仍按第 37 节处理。

---

# 5. 主仓库内 SiteProbe 应包含什么

## 5.1 必须包含

- Level 0 Generic Capture；
- Candidate Harvester；
- Level 1 Adapter Builder；
- adapter registry/runtime；
- adapter schema；
- site.json schema；
- review；
- selection；
- media handling；
- adapter validator；
- neutral fixtures；
- 开发文档；
- SDK/contract。

这意味着：

> T³ 主仓库里的 SiteProbe 必须是完整产品能力，而不是为了“干净”而放一个残缺版本。

---

## 5.2 不应默认包含

- 大量真实站点 adapter；
- 与某类内容强绑定的站点代码；
- 高维护频率的站点兼容逻辑；
- 必须跟 T³ 一起发布才能更新的 adapter；
- 私人本机生成的 adapter。

---

# 6. Adapter 来源分层

运行时建议区分四类来源。

```text
builtin
installed
local
development
```

### builtin
只放：

- generic；
- neutral demonstration adapter；
- 极少数正式决定随 T³ 分发的内容中立 adapter。

### installed
通过外部 adapter package/repository 安装。

### local
用户自己的 Adapter Builder 生成。

### development
开发/测试时挂载的 adapter。

Runtime 对它们使用**同一个 contract**。

---

# 7. 外部 `siteprobe-adapters`

该仓库放：

- 普通公开站点 adapter；
- 与 T³ release 解耦的站点规则；
- 独立版本；
- 独立测试；
- 独立维护周期。

结构示意：

```text
siteprobe-adapters/
│
├── registry.json
├── adapters/
│   ├── site-a/
│   ├── site-b/
│   └── ...
├── schema/
└── tests/
```

每个 adapter 自包含。

---

# 8. 内容敏感 Adapter 隔离

对于默认不适合随主项目分发的内容类别，应该使用独立 optional adapter source/repository。

原则：

- 不随 T³ 默认 Release；
- 不放入 T³ 主 README 的核心 feature 展示；
- 不影响 SiteProbe Core；
- 不创建“另一套 SiteProbe”；
- 仍然实现完全相同的 adapter contract；
- Core 不出现 `adult_mode`、`special_content_site` 之类领域分支；
- 具体内容分类只存在于 adapter metadata / distribution policy。

这样达到：

```text
一个 SiteProbe Core
多个 Adapter sources
```

而不是：

```text
普通版 SiteProbe
内容敏感版 SiteProbe
```

---

# 9. Adapter package 规范

建议每个 adapter 是完整 package。

```text
example-site/
│
├── adapter.json
├── site.json
├── fetch.py          # optional
├── README.md
└── tests/
```

其中具体文件名最终应与当前代码兼容。

---

# 10. `adapter.json`

只负责 package metadata，不负责 extraction rule。

建议字段：

```json
{
  "id": "example-site",
  "name": "Example Site",
  "version": "1.0.0",
  "domains": ["example.com"],
  "minimum_siteprobe_version": "1.0.0",
  "content_classification": "general",
  "capabilities": [
    "single_work",
    "search",
    "listing"
  ]
}
```

可扩展：

```text
homepage
license
maintainer
description
schema_version
update_channel
```

本地确认：当前 `site.json` 已包含 `key`、`display_name`、`tool`、`source_site`、`export_group`、`media_id_prefix`、`hosts`、`targets`，以及 extraction、listing、manifest、naming、review/session 等运行规则；目前没有独立的 `adapter.json`，也没有 adapter version、最低 SiteProbe 版本、许可证、维护者、内容分类或更新渠道字段。

因此正式拆分时：

- `adapter.json` 负责 package identity、版本、兼容性、许可证、维护者、分类、trust/update policy；
- `site.json` 继续保留运行时确实需要的 `key/source_site/hosts/targets` 与 extraction 配置；
- `domains` 与 `capabilities` 可以从 `hosts/targets` 推导时不要维护第二份真相；若 registry 需要缓存它们，validator 必须校验两边一致。

---

# 11. `site.json`

继续负责：

- targets；
- URL patterns；
- listings；
- work fields；
- selectors；
- transforms；
- manifest；
- naming；
- review config。

核心要求：

> Level 1 Builder 生成的 local adapter，也尽量直接生成这种格式。

---

# 12. `fetch.py`

`fetch.py` 只能用于无法声明化的行为，例如：

- 特殊登录/session；
- 特殊 API；
- 必须运行的浏览器交互；
- 非普通分页；
- 特殊媒体处理；
- 特殊 request signing；
- 其他 site-specific mechanics。

**原则：**
能 `site.json` 解决的，不写 Python。

---

# 13. Local Adapter 与官方 Adapter 完全同构

Level 1 Builder 最终生成：

```text
local/
└── example.com/
    ├── adapter.json
    └── site.json
```

未来如果用户手工扩展：

```text
fetch.py
```

也仍然是同一种 package。

因此：

```text
builtin adapter
external adapter
local generated adapter
developer adapter
```

对 SiteProbe Runtime 来说只区别：

```text
origin
trust
update policy
```

不区别 extraction API。

---

# 14. Repository Dependency 必须单向

长期依赖关系：

```text
TagTraceTrove
      │
      ▼
SiteProbe Core
      │
      ▼
Adapter Contract
      ▲
      │
external adapters
```

adapter 仓库可以依赖：

```text
schema
contract
test kit
```

但是：

> SiteProbe Core 绝不能 import 某个外部 adapter。

---

# 15. 强制架构测试

应建立一个 test：

```text
remove / disable every real adapter
```

然后：

- T³ build 通过；
- SiteProbe core tests 通过；
- generic capture 通过；
- Adapter Builder 通过；
- neutral fixture adapters 通过。

如果失败，说明 Core 被站点代码污染。

---

# 16. SiteProbe 与 T³ 的职责边界

## 16.1 T³ 负责

- 用户 library；
- DB；
- entry lifecycle；
- taxonomy；
- collections；
- import transaction；
- duplicate resolution 的最终业务规则；
- 用户权限/设置；
- T³ 主 UI；
- clipboard 等 app-level 功能；
- adapter 管理入口（未来）。

---

## 16.2 SiteProbe 负责

- URL/domain detection；
- 页面抓取；
- adapter matching；
- generic capture；
- Adapter Builder；
- listing/search；
- review；
- selection；
- media fetch/validation；
- export；
- site origin/source metadata；
- crawl-side state；
- adapter validation。

---

## 16.3 Adapter 负责

- 站点 URL 规则；
- 站点 DOM/API 结构；
- 站点 listing；
- 站点字段映射；
- 站点特殊 fetch；
- 站点特殊媒体逻辑。

---

# 17. SiteProbe 不应直接控制 T³ DB

建议长期原则：

```text
SiteProbe
→ 标准输出
→ T³ import/commit
```

而不是：

```text
SiteProbe
→ 直接写 T³ tables
```

原因：

- 可以 standalone 测试；
- SiteProbe 可作为真正子系统维护；
- Adapter 不获得 DB 权限；
- import transaction 只保留一个入口；
- 数据库 schema 改动不会逼所有 adapter 跟着改。

具体 transport：
- subprocess JSON；
- local API；
- IPC；

本文件不定。

本地现状已满足这一边界：SiteProbe 通过文件导出，T³ 的 `apps/server/src/import/site-probe.ts` 将其转换为 `packages/shared/src/schemas/import.ts` 定义的 `ImportBatch`，再由 `apps/server/src/import/commit.ts` 统一提交；SiteProbe 不连接 T³ 数据库。当前 SiteProbe CLI 尚无稳定的机器 JSON 输出，所以未来 transport 仍应由单独的 integration implementation plan 决定，但不得绕过 `ImportBatch → commit` 边界。

---

# 18. 标准输出 Contract

SiteProbe 应输出内容中立的数据。

示意：

```json
{
  "source": {
    "site": "example-site",
    "url": "https://example.com/work/1",
    "source_id": "1"
  },
  "work": {
    "title": "...",
    "creator": [],
    "date": null,
    "tags": [],
    "media": []
  },
  "origin": {
    "adapter_id": "example-site",
    "adapter_version": "1.2.0"
  }
}
```

具体 schema 以现有 shared schema 为准。

关键是：

> contract 使用作品/媒体抽象，不使用某站点特有字段作为根结构。

---

# 19. Adapter capability

Adapter 不应该简单只有：

```text
supported = true/false
```

而应声明 capability：

```text
single_work
search
creator_listing
collection_listing
review
incremental
authentication
custom_media
```

T³/SiteProbe UI 由 capability 决定显示哪些选项。

这与当前“target kind 由 registry 生成”思路一致。

---

# 20. Versioning

至少区分三个版本：

## T³ version

```text
T3 1.x
```

## SiteProbe contract/schema version

```text
siteprobe_schema = 1
```

## Adapter version

```text
adapter 1.4.2
```

Adapter manifest 应声明：

```text
minimum_siteprobe_version
schema_version
```

这样站点修复不要求发 T³ 新版本。

---

# 21. Release 生命周期

## T³ Release

包含：

- T³；
- SiteProbe Core；
- Generic Capture；
- Adapter Builder；
- builtin neutral assets。

## Adapter Release

单独更新：

```text
site adapter 1.2.3
```

网站改版：

```text
只更新 adapter
```

不应：

```text
网站改一个 selector
→ T³ 整体发版
```

---

# 22. Adapter Registry

未来 registry 可保存：

```json
{
  "adapter_id": "...",
  "latest_version": "...",
  "domains": [],
  "source": "...",
  "classification": "...",
  "capabilities": []
}
```

但 registry/marketplace 不应成为 SiteProbe Core 完成前的阻塞项。

---

# 23. 安全与信任边界

这一点必须从一开始考虑。

## 声明式 adapter

仅：

```text
adapter.json
site.json
```

风险较低。

## executable adapter

包含：

```text
fetch.py
```

本质上是可执行代码。

因此未来外部 adapter 安装时必须区分：

```text
declarative
executable
```

不能把第三方 `fetch.py` 当普通 JSON 自动执行。

具体：
- 签名；
- sandbox；
- trust prompt；
- source approval；

以后再定。

但 contract 从现在就必须保留这一分类。

---

# 24. Level 1 Builder 的安全优势

Builder 默认生成声明式 adapter：

```text
site.json only
```

这非常重要。

意味着普通用户：

```text
Teach SiteProbe
→ generated local adapter
```

不需要产生任意 Python code。

只有真正高级站点才进入：

```text
custom fetch.py
```

这也是 Level 1 应优先声明式设计的另一原因。

---

# 25. Neutral Fixtures

主仓库的 examples/test fixtures 不建议直接依赖真实内容站点。

建立：

```text
fixtures/
├── book-demo/
├── movie-demo/
├── gallery-demo/
├── api-demo/
└── dynamic-demo/
```

可覆盖：

- title；
- creator；
- date；
- tags；
- cover；
- preview；
- listing；
- search；
- pagination；
- JSON API。

这样：

- README/demo 内容中立；
- CI 稳定；
- 不受真实网站改版影响；
- Adapter Builder 可以测试完整流程。

---

# 26. 项目 README 定位

主 README 应介绍：

> T³ 是 local-first personal media/collection manager。

SiteProbe 表述可采用：

> SiteProbe is a configurable metadata acquisition layer that turns web pages into structured T³ entries. It supports generic capture, user-trained site adapters, and optional site-specific adapters for complex sources.

主 README 不需要列举大量实际站点。

站点生态单独放：

```text
Adapter ecosystem
```

---

# 27. 文档结构建议

```text
docs/siteprobe/
├── overview.md
├── quick-capture.md
├── adapter-builder.md
├── adapter-format.md
├── adapter-runtime.md
├── writing-adapters.md
├── testing-adapters.md
├── security.md
└── architecture.md
```

外部 adapter repository 自己有：

```text
CONTRIBUTING.md
ADAPTER_GUIDELINES.md
```

---

# 28. 从当前代码迁移到正式架构

注意：当前代码仍位于独立 `site_probe` 工作目录，且后续 T³ 调用形式未定。

因此迁移不要一次完成。

## Step 1 — 完成 SiteProbe 工具自身

先完成：
- Level 0；
- Level 1；
- generated adapter；
- search/listing builder；
- tests。

此时仍可以 standalone。

---

## Step 2 — 冻结 Adapter Contract

明确：

```text
adapter metadata
site.json schema
optional fetch API
capabilities
output schema
```

一旦冻结，再做仓库拆分。

---

## Step 3 — Core 与真实 Adapter 物理解耦

当前：

```text
tool/<site>/
```

未来变成：

```text
core registry scans adapter roots
```

Adapter root 可以来自：

```text
builtin
installed
local
development
```

而不是只有一个源码目录。

---

## Step 4 — 建 neutral fixtures

确保删除全部真实 adapter 后：

```text
core CI remains green
```

---

## Step 5 — 外部 adapter repo

把适合独立维护的真实 adapter 移走。

主仓库不再依赖其测试才能通过。

---

## Step 6 — T³ integration

最后才决定：

```text
subprocess
local service
other IPC
```

并正式接入：

```text
Import UI
Clipboard
Batch import
DB commit
```

---

# 29. 当前数据库相关历史的处理原则

现有交接文档中已经出现：

- `site_works`
- `site_crawl_sources`
- `origin`
- crawl-side state

正式架构应继续区分：

```text
crawl state
≠
T³ library state
```

### SiteProbe crawl state
用于：
- 抓过哪些；
- inventory；
- cursor；
- 避免重复下载。

### T³ DB state
用于：
- 哪些 entry 已经正式入库；
- source id → entry；
- duplicate detection；
- library history。

任何一个不能替代另一个。

---

# 30. Adapter Source ID

每个正式导入结果最好始终保留：

```text
adapter id
source site/domain
source work id
source url
adapter version
```

这样：

- URL 变形仍可去重；
- Adapter 升级可追踪；
- 出问题可知道数据由哪版规则产生。

具体字段位置由当前 schema 决定。

---

# 31. Adapter 更新不能静默改数据库

Adapter update 只意味着：

> 以后如何抓。

不意味着：

> 自动覆盖以前 T³ 已存 metadata。

如果以后做 re-scan/reconcile，应作为单独流程。

避免：

```text
adapter update
→ library data silently changed
```

---

# 32. Core / Adapter 的测试分层

## Core CI

不需要网络：

- generic parser；
- candidate harvester fixtures；
- builder fixtures；
- adapter schema；
- review；
- selection；
- neutral adapter。

## Adapter CI

每个 adapter：

- recorded fixtures；
- contract validation；
- optional live smoke test。

## Live tests

不能成为每次主仓库 CI 的硬依赖。

---

# 33. “站点已支持”应变成 capability + health

未来 registry 可以表达：

```text
single_work: stable
search: stable
listing: experimental
last_verified: date
```

不要只有“支持/不支持”。

因为真实站点会局部改版。

---

# 34. 本机运行时目录建议

本地 T³ 已用 `T3_DATA_DIR` 作为可写数据根目录；未设置时，正式启动器从 `apps/server` 工作目录启动 server，因此当前默认值解析为 `apps/server/.data`。数据库位于 `<T3_DATA_DIR>/library.db`，媒体位于 `<T3_DATA_DIR>/assets/`。

SiteProbe 的可写运行数据应沿用同一个根：

```text
<T3_DATA_DIR>/
└── siteprobe/
    ├── installed/
    ├── local/
    ├── cache/
    ├── sessions/
    └── export/
```

`builtin` adapter 属于随程序发布的只读代码，应位于仓库/安装包中的 `siteprobe/adapters/builtin/`，不要复制成用户数据。`development` adapter 通过显式开发路径挂载。Registry 最终合并 builtin、installed、local、development 四类 root，但 cache、session、export、cookie 和浏览器 profile 始终留在 `T3_DATA_DIR` 下并被备份/清理策略明确管理。

---

# 35. 不要把私人开发语料放进公开主仓库

公开仓库应区分：

```text
tests/fixtures/neutral
```

和本机：

```text
recordings/private
cache
exports
cookies
browser profile
```

尤其必须 `.gitignore`：

- cookies；
- session；
- auth；
- exported media；
- personal review selection；
- local adapters（除非用户主动发布）；
- browser profiles。

---

# 36. 许可证治理

正式开源前，应为第三方依赖建立清单。

目前考虑中的主要库：

| Dependency | 当前许可证 |
|---|---|
| Playwright Python | Apache-2.0 |
| OpenPicker | MIT |
| `@medv/finder` | MIT |
| AutoScraper | MIT |
| Scrapling | BSD-3-Clause |
| Portia | BSD-3-Clause（仅参考，不建议依赖） |

正式发布前应由本地 AI / maintainer 再读取实际 lockfile 与 LICENSE 确认。

不要因为本计划写了许可证就当成最终法律审计。

---

# 37. SiteProbe 是否独立发包

短期不要求。

可以：

```text
TagTraceTrove/packages/siteprobe
```

以后若：

- contributor 增加；
- adapter ecosystem 独立；
- Builder 可以独立运行；

再考虑：

```text
siteprobe-core package
```

关键是架构边界先独立，不要求立刻独立发布。

---

# 38. 架构不变量

以后任何实现方案都必须满足：

1. 删除全部真实 adapter 后，T³ / SiteProbe Core 仍能 build/test。
2. SiteProbe Core 不写站点名分支。
3. Adapter 不直接写 T³ DB。
4. Adapter Builder 默认输出声明式规则。
5. Local/generated adapter 与 external adapter 使用同一 contract。
6. Adapter 更新不要求 T³ 发版。
7. 内容类别不进入 generic extraction architecture。
8. 默认分发与 optional adapter source 可以独立管理。
9. crawl state 与 library state 分离。
10. T³ 与 SiteProbe 通过标准 contract 交互。

---

# 39. 已确认的本地实现基线

以下事实已从 2026-09-19 的实际工作区确认，后续 implementation plan 应以此为起点：

- **Monorepo：** pnpm workspace 当前包含 `apps/server`、`apps/web`、`packages/shared`；Windows 启动器位于 `tools/t3-launcher`。
- **SiteProbe 位置：** 当前独立工作目录为 `D:\Project\Dataextracted\site_probe\generic_probe`，尚未进入 Git 仓库。正式迁移目标采用主仓库顶层 `siteprobe/` Python subtree。
- **Shared contract：** `packages/shared/src/schemas/import.ts` 定义 `ImportBatch { source, origin?, entries, warnings }`。`ImportEntry` 已支持 external key、标题、封面/预览、日期、页数、tags、扩展 fields、sources 与 body。
- **Import transaction：** `apps/server/src/import/commit.ts` 是唯一库提交入口，负责 entry、作者、tag、source identity、重复处理及 crawl provenance；媒体当前在 commit 后通过媒体 API/asset store 写入，不属于 SiteProbe 的数据库权限。
- **现有 TS bridge：** `apps/server/src/import/site-probe.ts` 目前仍以三个站点的 Zod schema 和 adapter 分支读取旧导出；正式通用 contract 尚未建立。
- **Migration 021：** `apps/server/src/database/migrations/021_site_crawl_state.sql` 创建 `site_works` 与 `site_crawl_sources`；前者保存 `(source_site, source_id) → entry_id`，后者保存 `artist/folder/work/search` 来源游标。
- **Origin：** SiteProbe 导出使用 snake_case 的 `origin { kind, ref, display_name?, url? }`，TS bridge 转成 shared schema 的 `displayName`；完整 manifest 导入时会进入 commit。
- **当前 registry：** `src/generic/registry.py` 只扫描项目内单一 `tool/` root，并通过 `tool.<folder>.fetch` 导入可执行 adapter。最小演进是让 `discover()` 接受有优先级的 root 列表，并在注册结果中携带 `origin/trust/update policy`；不要复制 runtime contract。
- **Python packaging：** `pyproject.toml` 要求 Python `>=3.11`；基础依赖为 OpenCC，browser extra 为 Playwright/httpx/curl_cffi，media extra 为 Pillow，dev extra 为 pytest。当前 setuptools package 列表硬编码三个 adapter，外部/生成 adapter 接入前必须改为正确的 package discovery 或明确的运行时目录加载。
- **Launcher 影响：** 当前 `T3.exe` 只定位 Node/pnpm/本地 `tsx` 并启动 server，不提供 Python、虚拟环境、Playwright browser 或 adapter dependency 安装。因此 SiteProbe runtime 的随包解释器/venv/bootstrap 与健康检查必须进入正式 release 设计。
- **Adapter roots：** external adapter discovery 与 local generated adapter 目录尚未实现。可写 local/installed 根使用 `<T3_DATA_DIR>/siteprobe/`；builtin 留在安装包；development 使用显式路径。
- **Trust boundary：** 声明式/可执行分类应在 SiteProbe registry/installer 验证；真正启动 Python 的 T³ server endpoint 只能接受 registry 中已启用的 adapter，并应限制为 localhost 或受 capability token 保护，不能直接暴露任意脚本路径。
- **CI：** T³ 当前使用根级 pnpm build/typecheck/lint/Vitest；SiteProbe 当前独立运行 pytest，实测 `52 passed`。尚无跨语言 release CI，迁入后需把离线 Core/neutral fixture tests 加入主 CI，并把真实站点 live smoke tests保持为可选任务。

基于这些事实，后续另写：

```text
T3_SITEPROBE_INTEGRATION_IMPLEMENTATION_PLAN.md
```

该计划负责确定 transport、job lifecycle、staging、UI 与 release packaging；本架构文件不替它猜接口。

---

# 40. 最终推荐结构

```text
GitHub
│
├── TagTraceTrove
│   ├── T³ application
│   ├── SiteProbe Core
│   ├── Level 0 Generic Capture
│   ├── Level 1 Adapter Builder
│   ├── Adapter Contract / SDK
│   └── neutral fixtures/examples
│
├── siteprobe-adapters
│   └── optional general site adapters
│
├── siteprobe-adapters-sensitive
│   └── separately governed optional adapter pack
│
└── siteprobe-adapter-template
    └── advanced contributor template
```

运行时：

```text
SiteProbe Runtime
     │
     ├── builtin adapters
     ├── installed adapters
     ├── local generated adapters
     └── development adapters
              │
              ▼
      one Adapter Contract
              │
              ▼
       normalized export
              │
              ▼
          T³ Import
```

---

# 41. 最终指导原则

T³ 要公开展示的是：

> **一个内容中立的收藏与媒体管理系统。**

SiteProbe 要公开展示的是：

> **一个可扩展、可教学、运行时确定性的网页元数据采集子系统。**

具体站点 adapter 只是：

> **对 Adapter Contract 的独立实现。**

只要这个边界不被破坏，SiteProbe 即使本身成长为项目级复杂度，也不会让 T³ 的定位被某一类网站或内容绑死。
