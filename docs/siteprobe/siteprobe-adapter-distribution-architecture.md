# SiteProbe Adapter 分发与按需安装架构

> 文档目的：明确 SiteProbe 外部 Adapter 的仓库组织、分发方式、按需安装方式，以及内容敏感 Adapter 与 T³ 主项目之间的隔离方式。  
> 本文件专注于 **Adapter Distribution / On-demand Installation**，补充此前 T³ × SiteProbe 总体架构中“仓库分离”但未充分展开的部分。  
> 核心目标：**普通用户下载或 clone T³ 时，不获得任何不需要的站点 Adapter；只有真正需要某个 Adapter 的用户，才主动下载该 Adapter。**

---

## 1. 问题定义

仅把不同类型的 Adapter 放进同一个 Git 仓库的不同文件夹中，并不能实现真正隔离。

例如：

```text
TagTraceTrove/
├── src/
├── siteprobe/
└── adapters/
    ├── general-site-a/
    ├── general-site-b/
    ├── adult-site-a/
    └── adult-site-b/
```

无论用户执行：

```bash
git clone ...
```

还是 GitHub 的 **Download ZIP**，整个仓库都会被下载。

因此：

> **“运行时不调用某个 Adapter” ≠ “用户没有下载这个 Adapter”。**

如果目标是：

> 普通用户默认完全不获得这些 Adapter，只有需要的人才主动取得，

那么必须在 **仓库、发布包、运行时安装** 三个层面同时分离。

---

## 2. 最终目标

默认安装 T³ 时：

```text
T³ Core
SiteProbe Core
Level 0 Generic Capture
Level 1 Adapter Builder
builtin neutral adapters
```

此时：

```text
没有下载 optional sensitive adapters
没有相关站点代码
没有相关站点列表
没有相关站点网络请求
```

只有当用户真正需要某个站点时：

```text
用户添加/启用 Adapter Source
        ↓
发现对应 Adapter
        ↓
主动 Install
        ↓
只下载该 Adapter package
        ↓
SiteProbe 自动发现并启用
```

---

## 3. 正确的 Git 仓库结构

不推荐：

```text
TagTraceTrove/
└── adapters/
    ├── general/
    └── adult/
```

推荐真正拆成独立 repository：

```text
GitHub
│
├── TagTraceTrove
│
├── siteprobe-adapters
│
└── siteprobe-adapters-sensitive
```

名称只是示意，最终可调整。

### `TagTraceTrove`

包含：

```text
T³
SiteProbe Core
Generic Capture
Adapter Builder
Adapter Runtime
Adapter Contract
neutral examples
```

**不包含 optional sensitive adapters。**

### `siteprobe-adapters`

用于：

```text
一般站点 Adapter
公开社区 Adapter
独立维护的站点兼容代码
```

### `siteprobe-adapters-sensitive`

用于：

```text
默认不随主项目分发的内容敏感 / 年龄限制站点 Adapter
```

该仓库：

- 与 T³ 主仓库独立；
- 不进入 T³ 默认 Release；
- 不要求普通用户 clone；
- 不应成为 T³ build dependency。

---

## 4. 仓库分离仍然不够

即使：

```text
siteprobe-adapters-sensitive
```

已经是独立 repo，如果用户安装一个 Adapter 时必须：

```bash
git clone siteprobe-adapters-sensitive
```

那么用户仍然会一次下载整个仓库中的所有站点。

例如：

```text
adapters/
├── site-a/
├── site-b/
├── site-c/
├── site-d/
└── site-e/
```

用户只需要：

```text
site-a
```

却得到全部五个 Adapter。

因此正式架构必须增加：

> **Adapter Package 层。**

---

## 5. 三层模型：Repository / Package / Installed Adapter

这是整个分发系统最重要的区分。

### 5.1 Source Repository

给开发者和维护者使用：

```text
github.com/example/siteprobe-adapters-sensitive
```

内部：

```text
siteprobe-adapters-sensitive/
├── registry.json
├── adapters/
│   ├── site-a/
│   ├── site-b/
│   └── site-c/
└── tooling/
```

它是：

> Adapter 的源码仓库。

普通 T³ 用户不需要 clone。

### 5.2 Adapter Package

每个 Adapter 单独打包：

```text
site-a-1.4.2.zip
site-b-2.0.0.zip
site-c-1.1.5.zip
```

每个 zip 只包含一个站点：

```text
site-a/
├── adapter.json
├── site.json
├── fetch.py
├── README.md
└── ...
```

用户需要哪个，就只下载哪个。

### 5.3 Installed Adapter

T³/SiteProbe 最终只使用本机安装目录：

```text
T3 user data/
└── siteprobe/
    ├── builtin/
    ├── installed/
    └── local/
```

安装 Site A 后：

```text
installed/
└── site-a/
    ├── adapter.json
    ├── site.json
    └── fetch.py
```

SiteProbe Runtime 只扫描：

```text
builtin/
installed/
local/
```

而不关心它来自哪个 Git repository。

---

## 6. Adapter Source 抽象

T³ / SiteProbe Core 不应该硬编码：

```text
general adapters
adult adapters
```

更通用的抽象是：

> **Adapter Source**

每个 Source 提供：

```text
registry metadata
package locations
versions
hashes
capabilities
```

Core 只理解：

```text
add_source
remove_source
refresh_source
search_adapter
install_adapter
update_adapter
```

Core 不需要知道 Source 中是什么内容。

---

## 7. 默认 Source

默认 T³ 可以只配置：

```text
Official General Adapter Source
```

甚至初期完全不配置远程 Source，只提供：

```text
Generic Capture
Adapter Builder
```

用户真正需要其他支持时，再自行添加 Source。

---

## 8. Sensitive Source 不应硬编码进 Core

推荐让 `TagTraceTrove` 源代码中完全不出现：

```text
adult-adapter-repository URL
NSFW site list
sensitive domains
adult_mode
```

Core 只实现：

```text
Add Adapter Source
```

需要相关 Adapter 的用户自行添加对应 Source。

这意味着：

> **T³ Core 根本不知道某个 NSFW Adapter 仓库的存在。**

它只知道：

> 用户添加了一个 Adapter Source。

---

## 9. Adapter Registry

每个 Adapter Source 应提供 registry，例如：

```json
{
  "schema_version": 1,
  "adapters": {
    "site-a": {
      "name": "Site A",
      "version": "1.4.2",
      "domains": ["example.com"],
      "capabilities": [
        "single_work",
        "search",
        "creator_listing"
      ],
      "package": "releases/site-a-1.4.2.zip",
      "sha256": "...",
      "minimum_siteprobe_version": "1.2.0"
    }
  }
}
```

SiteProbe 读取 registry 后可以：

```text
根据 domain 搜索 Adapter
显示版本
检查兼容性
下载 package
校验 package
安装
```

---

## 10. 用户按需安装流程

理想流程：

```text
用户复制某网站 URL
        ↓
检查 builtin
        ↓
检查 installed
        ↓
检查 local
        ↓
没有匹配
        ↓
Generic Capture 可用
        ↓
[Quick Import]
[Teach SiteProbe]
[Find compatible adapter]
```

如果用户点击：

```text
Find compatible adapter
```

则：

```text
查询已启用 Adapter Sources
        ↓
根据 domain 查 registry
        ↓
找到 compatible adapter
        ↓
显示能力 / 版本 / 来源
        ↓
用户主动 Install
```

安装流程：

```text
下载单 Adapter package
        ↓
校验
        ↓
解压到 installed/
        ↓
重新加载 Adapter Registry
        ↓
重新匹配 URL
        ↓
开始运行 Adapter
```

---

## 11. 不应该自动下载 Sensitive Adapter

即使 URL 明显属于某个支持站点，也不建议：

```text
检测到域名
→ 自动下载 Adapter
```

应当：

```text
检测到 compatible adapter
→ 提示用户
→ 用户主动 Install
```

原因：

- 尊重用户控制；
- 避免隐式执行第三方代码；
- sensitive Adapter 不应无提示落地；
- executable Adapter 可能包含 `fetch.py`。

---

## 12. 一次只下载一个 Adapter

如果用户需要 Site A：

```text
下载：
site-a-1.4.2.zip
```

而不是：

```text
clone 整个 Adapter repository
```

因此：

```text
Repository
```

是开发者组织形式，

而：

```text
Package
```

才是普通用户的分发单位。

---

## 13. GitHub Releases 的作用

GitHub Repository 用于：

```text
源码
Issue
PR
CI
Release
```

例如更新：

```text
site-a/
```

CI 自动生成：

```text
site-a-1.4.3.zip
```

并上传到 GitHub Release。

随后 registry 更新：

```text
version = 1.4.3
package = release asset
sha256 = ...
```

SiteProbe 只根据 registry 下载该 package。

---

## 14. Adapter 更新

SiteProbe 可以：

```text
refresh enabled sources
```

然后比较：

```text
installed site-a 1.4.2
source latest 1.4.3
```

显示：

```text
Update available
```

用户再主动更新。

不要出现：

```text
网站改一个 selector
→ T³ 整体发新版
```

---

## 15. Runtime Adapter Roots

建议 Runtime 支持：

```text
builtin/
installed/
local/
development/
```

### builtin

随 T³ 正式发布：

```text
generic
neutral examples
极少数正式 builtin adapter
```

### installed

用户通过 Adapter Source 下载：

```text
installed/site-a
```

### local

Level 1 Adapter Builder 生成：

```text
local/example.com
```

### development

开发/调试挂载：

```text
development/test-site
```

正式 Release 不依赖它。

---

## 16. Adapter Discovery

Runtime 统一扫描：

```text
adapter roots
    ↓
adapter.json
    ↓
domain / capabilities / version
```

例如：

```text
builtin generic
installed site-a
local user-trained-site
development test-site
```

对 Runtime 来说全部只是：

```text
Adapter
```

---

## 17. Adapter 优先级

当多个 Adapter 匹配同一 domain 时，建议概念优先级：

```text
development
    >
local
    >
installed
    >
builtin
    >
generic
```

原因：

- 开发调试版本应能覆盖正式版本；
- 用户本地训练规则可覆盖下载版本；
- installed 比 builtin 更容易更新；
- generic 永远作为最后 fallback。

具体策略以后可调整。

---

## 18. Adapter Package Manifest

建议：

```text
adapter.json
```

至少包含：

```json
{
  "id": "site-a",
  "name": "Site A",
  "version": "1.4.2",
  "domains": ["example.com"],
  "schema_version": 1,
  "minimum_siteprobe_version": "1.2.0",
  "type": "executable",
  "capabilities": [
    "single_work",
    "search"
  ]
}
```

其中 `type` 至少区分：

```text
declarative
executable
```

---

## 19. Declarative 与 Executable Adapter

### Declarative Adapter

只有：

```text
adapter.json
site.json
```

运行 SiteProbe Core 自己的 generic engine。

风险相对较低。

Level 1 Builder 默认应生成这种 Adapter。

### Executable Adapter

额外包含：

```text
fetch.py
```

本质上：

> 安装后会执行第三方代码。

因此安装 UI 必须明确提示。

未来可以增加：

```text
trusted source
signature
sandbox
permission model
```

但不能把 executable Adapter 当普通 JSON 无提示执行。

---

## 20. Sensitive Adapter 的默认用户体验

默认：

```text
SiteProbe → Adapter Sources

Official / General
    enabled

Additional sources
    none
```

如果用户主动：

```text
Add Adapter Source
```

之后才会看到对应 Adapter。

因此普通用户：

> **不会默认看到敏感站点列表。**

---

## 21. “藏”的准确含义

可以实现：

```text
不默认下载
不默认安装
不默认展示
不默认加载
不默认查询
不默认发相关网络请求
主 README 不列出
T³ Release 不包含
```

这就是推荐的“隐藏在生态中”。

但如果某个 Adapter repo 本身是 public GitHub repository，那么仍可能通过：

```text
GitHub profile
GitHub search
直接链接
```

被发现。

因此：

> **不默认出现 ≠ 互联网完全不可发现。**

---

## 22. 如果希望和主项目视觉绑定更弱

可以把 sensitive Adapter repo 放到：

```text
独立 GitHub organization
```

或：

```text
独立 maintainer account
```

T³ Core 仍然只提供：

```text
Add Adapter Source
```

主 README 也不必直接链接该 repo。

---

## 23. 不推荐 Git Submodule 作为最终分发机制

Git submodule 技术上可以做到：

```text
普通 clone 主 repo
→ 不自动下载 submodule 内容
```

但不推荐最终使用，因为：

- `.gitmodules` 仍然暴露 repo；
- 普通用户操作复杂；
- Release/build 流程麻烦；
- 不能做到只装某一个 Adapter；
- 不适合 GUI Adapter Manager。

Submodule 最多用于开发期。

---

## 24. 可类比 VS Code Extension

VS Code 不会：

```text
把全世界所有 extension 塞进安装包
```

而是：

```text
Core
    ↓
Extension API
    ↓
用户按需安装
```

SiteProbe 应采用：

```text
SiteProbe Core
    ↓
Adapter Contract
    ↓
用户按需安装 Adapter
```

区别只在于 SiteProbe 可以支持多个 Adapter Source。

---

## 25. 推荐的最终分发结构

```text
┌─────────────────────────────┐
│ TagTraceTrove               │
│                             │
│ T³                          │
│ SiteProbe Core              │
│ Generic Capture             │
│ Adapter Builder             │
└─────────────────────────────┘
```

独立：

```text
┌─────────────────────────────┐
│ General Adapter Repository  │
│                             │
│ registry                    │
│ source code                 │
│ individual packages         │
└─────────────────────────────┘
```

可选：

```text
┌─────────────────────────────┐
│ Additional Adapter Source   │
│                             │
│ registry                    │
│ source code                 │
│ individual packages         │
└─────────────────────────────┘
```

三者独立下载。

---

## 26. 推荐本机结构

```text
T3 user data/
└── siteprobe/
    ├── builtin/
    │   └── generic/
    ├── installed/
    │   ├── site-a/
    │   └── site-b/
    ├── local/
    │   └── user-trained-example/
    ├── sources/
    │   └── sources.json
    ├── cache/
    └── sessions/
```

---

## 27. `sources.json`

概念上：

```json
{
  "sources": [
    {
      "id": "official-general",
      "registry": "...",
      "enabled": true
    },
    {
      "id": "user-source-1",
      "registry": "...",
      "enabled": true
    }
  ]
}
```

Core 不需要：

```text
source_type = adult
```

内容分类属于 Adapter metadata 或 Source 自身，而不是 runtime branching。

---

## 28. Adapter 安装状态

SiteProbe 应能区分：

```text
Available
Installed
Update available
Disabled
Broken
Incompatible
```

针对某个 URL 也应区分：

```text
installed match
available match
generic fallback
```

---

## 29. Offline 行为

没有网络时：

```text
builtin
installed
local
```

都应正常运行。

Adapter Source 只影响：

```text
发现
安装
更新
```

不应成为每次抓取时的强依赖。

---

## 30. 卸载

卸载 Adapter：

```text
删除 installed/<adapter>
```

不应：

```text
删除 T³ 已导入的数据
删除用户 local adapter
影响其他 adapter
```

Adapter 与 library data 生命周期必须分离。

---

## 31. 删除 Adapter Source

用户删除一个 Source：

```text
remove source
```

不代表：

```text
自动卸载从该 Source 已安装的 Adapter
```

推荐：

```text
Source removed
Installed adapters remain
No future updates available
```

除非用户主动卸载。

---

## 32. Adapter 更新与数据安全

Adapter 更新只改变：

```text
未来如何抓取
```

不能自动：

```text
重写已存在 T³ 数据
```

未来如果实现：

```text
re-fetch / reconcile
```

必须是单独流程。

---

## 33. SiteProbe Core 不得包含站点名单

禁止：

```python
SENSITIVE_SITES = [...]
```

禁止：

```python
if adult_mode:
    ...
```

禁止：

```text
siteprobe/adult/
```

Core 只理解：

```text
Adapter
Adapter Source
Capability
Trust
```

---

## 34. Adapter Metadata 可以带内容分类

例如：

```json
{
  "content_classification": "restricted"
}
```

用途：

```text
UI filter
source policy
user preference
```

但不应改变 generic runtime 的代码路径。

---

## 35. 主 README

主 T³ README 只需要说明：

> SiteProbe supports generic capture, user-trained adapters, and optional site-specific adapters.

不需要在主页列出敏感站点。

站点生态另放：

```text
Adapter ecosystem
```

文档。

---

## 36. 安装来源与安全提示

第三方 Source 必须视为外部代码源。

特别是包含：

```text
fetch.py
```

的 Adapter。

安装时至少显示：

```text
Adapter name
Source
Version
Declarative / Executable
Capabilities
```

Executable Adapter 应明确提示：

```text
This adapter contains executable code.
```

未来可加入：

```text
publisher trust
signature
hash
review status
```

---

## 37. Registry 不应直接执行代码

正确：

```text
download registry JSON
→ inspect metadata
→ user installs
→ download package
→ verify
→ unpack
→ runtime loads
```

错误：

```text
download registry
→ 直接执行 registry 返回内容
```

---

## 38. Package 完整性

每个 package 最好提供：

```text
SHA-256
```

安装时：

```text
download
→ hash
→ compare
→ unpack
```

未来可增加 cryptographic signing。

---

## 39. CI / Release

Adapter repo 推荐：

```text
PR
↓
contract validation
↓
fixture tests
↓
package build
↓
hash
↓
release
↓
registry update
```

不要手工维护大量 zip。

---

## 40. Adapter Builder 与分发系统

Level 1 用户生成：

```text
local adapter
```

默认只保存到：

```text
local/
```

不会自动上传到任何 GitHub。

用户如果愿意贡献：

```text
Export Adapter
```

再主动提交到某 Adapter Repository。

因此：

> **Adapter Builder 是本地功能；Adapter Repository 是分发生态。**

---

## 41. Local Adapter 不应被远程覆盖

如果：

```text
local/example.com
```

与：

```text
installed/example.com
```

同时存在，

推荐优先：

```text
local
```

至少必须明确告诉用户存在 override。

远程 update 不得覆盖 local adapter。

---

## 42. 开发阶段实施顺序

当前不需要马上实现完整 marketplace。

### Phase 1

实现多个 Adapter Roots：

```text
builtin
installed
local
development
```

### Phase 2

实现：

```text
adapter.json
package install from local zip
```

先验证：

```text
单 Adapter
→ zip
→ 安装
→ Runtime 发现
```

### Phase 3

实现：

```text
registry.json
```

先从本地文件加载。

### Phase 4

再支持：

```text
remote registry
remote package
```

### Phase 5

最后才做：

```text
GUI Adapter Manager
update checker
multiple sources
trust model
```

---

## 43. 当前不应成为阻塞项

SiteProbe Level 1 自身完成前，不必优先实现：

- marketplace；
- automatic remote update；
- cryptographic signing；
- rating/review；
- publisher account；
- 云端账号同步；
- 自动上传 local adapter。

当前只要保证：

```text
Adapter Contract
Adapter Package
Adapter Roots
```

设计不阻碍未来扩展即可。

---

## 44. 架构不变量

正式架构必须满足：

1. `git clone TagTraceTrove` 不会下载 optional sensitive adapters。
2. T³ Release 不包含 optional sensitive adapters。
3. Adapter repo 与 T³ repo 独立。
4. 用户不必 clone Adapter repo。
5. 每个 Adapter 可以独立打包和下载。
6. 用户只下载自己需要的 Adapter。
7. SiteProbe Core 不硬编码某类内容 Source。
8. Sensitive Source 必须用户主动添加/启用。
9. Adapter 安装必须是显式操作。
10. Runtime 只关心 installed/local/builtin adapters，不关心 Git 仓库。
11. Level 1 Builder 生成 local adapter，不自动发布。
12. Executable Adapter 与 Declarative Adapter 必须区分。
13. 删除 Adapter 不影响已导入 T³ 数据。
14. Adapter 更新不要求 T³ 整体发版。
15. Adapter Source 是生态概念，不是 SiteProbe extraction logic。

---

## 45. 最终总结

正确目标不是：

> “把 NSFW Adapter 放进 T³ 里一个不显眼的文件夹。”

而是：

> **T³ / SiteProbe Core 完全不携带这些 Adapter；它们存在于独立 Adapter Source 中，并以单站点 package 的形式按需安装。**

最终用户体验：

```text
T³
    ↓
默认没有这些 Adapter
    ↓
用户真正需要某站
    ↓
主动添加/启用对应 Adapter Source
    ↓
只安装该站 Adapter
    ↓
SiteProbe Runtime 自动发现
```

这样可以同时满足：

```text
主项目内容中立
普通用户默认干净
敏感内容用户仍得到完整支持
站点 Adapter 可独立维护
Adapter 更新不绑定 T³ Release
未来社区生态可扩展
```
