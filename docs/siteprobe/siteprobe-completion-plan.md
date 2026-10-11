# SiteProbe 搜索与陌生站点适配功能正式完善计划

> 文档目的：作为本地 AI 的第一版工程规划输入。  
> 范围：只讨论 **SiteProbe 工具自身从当前状态到“可独立认为完成”** 的工作，不讨论其后与 T³ 的进程调用、前端入口、数据库提交、剪贴板监听等正式对接细节。  
> 依据：当前 `site_probe` 整合交接文档 + 已完成架构 + 对现成开源组件的调研。  
> 原则：本文件中依赖本地代码才能确认的内容，已按 2026-09-19 的 SiteProbe 工作区现状补齐；尚未实现的能力会明确写为后续工作，不凭空当作现状。

---

## 0. 结论先行

SiteProbe 后续不应继续以“为更多网站逐个写爬虫”为核心路线，而应正式发展为：

1. **Level 0：高可靠通用快速抓取**
   - 任意未知 URL 尽量可靠获得 `title + cover + source URL`。
   - 其他字段只允许作为低保证候选，不默认写入正式数据。
   - 当前技术路线基本可保留，不作为本轮重写重点。

2. **Level 1：核心能力——未知网站 Adapter Builder**
   - SiteProbe 自动把浏览器/F12 中“可能是数据”的内容搜集出来。
   - 用户从候选中标记“哪个值是什么字段”。
   - Example 1 建规则候选。
   - Example 2 验证、筛除错误规则。
   - Example 3 盲测。
   - 验证通过后输出标准 `site.json`/adapter package。
   - 运行时继续使用现有确定性 generic engine，不依赖 LLM。

3. **搜索/列表页学习**
   - 与单作品字段学习共享 Candidate Harvester。
   - 重点学习：
     - 重复 card 结构；
     - card 内 title / cover / id / URL 等字段；
     - 搜索入口/查询参数；
     - 分页/next/load-more；
     - listing target 类型。
   - 对极特殊搜索机制，不强行做通解；归类为“需要自定义 adapter/fetch”。

4. **不重复造轮子**
   - 浏览器自动化/网络监听：优先 Playwright。
   - CSS selector 生成/点选：优先 OpenPicker / `@medv/finder`。
   - “已知值 → DOM 抽取规则”：优先评估 AutoScraper。
   - selector 自适应/相似元素匹配：优先评估 Scrapling。
   - Portia 仅作为视觉式 annotation → scraper 的历史架构参考。
   - Crawl4AI 仅作为“一次生成 schema，之后确定性执行”的设计参考/可选实验，不替换现有 generic engine。

---

# 1. 当前基线与必须保留的约束

根据现有交接文档，目前 SiteProbe 已有以下重要基础，后续设计应尽量复用，而不是推倒重写。

## 1.1 已有通用/站点分层

当前核心思想：

```text
站点特有抓取/fetch
        ↓
RawItem
        ↓
site.json + generic selector engine
        ↓
标准字段
        ↓
review / selection / export
```

现有设计中：

- `read_work(...)` 是站点侧唯一必须实现的底层能力；
- `list_work_urls` / `list_cards` / `scan_review` / `export_selection` 为可选能力；
- `site.json` 声明 target、listing、field selector、命名、review 等；
- `tool/*/site.json` 通过磁盘发现；
- generic engine 中原则上不应出现 `if site == ...`；
- review / selection 已经通用化；
- 已有站点搜索实现可作为 regression asset，但不应继续决定核心架构。

**必须保持：**
> 新 Level 1 最终输出应尽可能落回现有 `site.json + generic runtime`，而不是引入第二套长期运行时 extraction engine。

---

## 1.2 已有实测边界

当前通用读取器已经证明：

- 标题、封面是未知网站上最可靠的通用字段；
- 日期、tag、author 等字段在零站点规则下可靠性明显不足；
- 运行时使用小模型进行逐页抽取不适合作为默认依赖；
- 封面等媒体最终仍需由抓取侧拿到真实字节并落盘。

因此后续 Level 1 的定位不是：

> “让 AI 每次看网页猜字段”。

而是：

> “用一次性的自动分析 + 用户标注，生成以后可确定性执行的规则”。

---

# 2. 完成定义

本轮 SiteProbe 工具开发完成时，至少应达到以下状态。

## 2.1 Level 0 完成标准

未知单作品 URL：

- 能解析最终 URL；
- 能稳定给出 title；
- 能稳定给出 cover；
- cover 能真实下载，不只得到字符串；
- 结果有 source URL；
- 不确定的 author/tag/date 不自动当成正式字段；
- 错误时能明确说明“未找到/候选不足/需要教学”，而不是静默填错。

Level 0 现有代码应以修补和加固为主。

---

## 2.2 Level 1 单作品 Adapter Builder 完成标准

对一个此前没有 adapter 的普通网站：

1. 输入 Example 1 URL；
2. 系统自动收集页面候选；
3. 用户能从候选中标记：
   - title；
   - cover；
   - creator/author 类字段；
   - date；
   - tags；
   - preview/media；
   - 其他可扩展字段；
4. 系统形成多个 rule hypotheses；
5. 输入 Example 2：
   - 自动应用 hypotheses；
   - 用户确认/纠错；
   - 淘汰不稳定规则；
6. 输入 Example 3：
   - 自动提取；
   - 不再依赖用户从候选中重新找答案；
7. 验证通过；
8. 生成 adapter package / `site.json`；
9. 用现有 generic runtime 运行生成 adapter；
10. 输出与 Builder 盲测结果一致。

---

## 2.3 Level 1 搜索/列表页完成标准

对结构普通的搜索页/作者页/收藏页：

1. 用户提供一个 listing/search 页面或执行一次搜索操作；
2. Candidate Harvester 能发现明显的重复 card 结构；
3. 用户能点选一张 card 并定义：
   - work URL/id；
   - title；
   - cover；
   - 可选辅助字段；
4. 系统能泛化为“同类 card 集合”；
5. 能识别至少以下分页形态中的基础部分：
   - URL page 参数；
   - next link/button；
   - 固定页码列表；
6. 对 load-more / infinite scroll 提供实验支持或明确标记为未支持；
7. 生成 `listings` 规则；
8. 现有通用 review 页可消费这些 card；
9. selection 后只抓选中的作品；
10. 搜索/列表结果与现有 adapter contract 兼容。

---

# 3. 核心新增子系统：Candidate Harvester

Level 1 最大的新工作不是 selector UI，而是：

> **面对陌生网页时，尽可能完整地找出“可能成为字段”的候选数据。**

Candidate Harvester 不应直接判断“这是 author / tag / title”，而应优先完成：

```text
抓取
→ 归一化
→ 去重
→ 类型化
→ 建立来源关系
→ 排序展示
```

---

# 4. Candidate Harvester 的采集通道

## 4.1 Browser Runtime：Playwright 优先

**建议依赖：Playwright Python**

官方能力已经覆盖：

- Chromium 浏览器启动；
- JS 执行后的 rendered DOM；
- request / response 事件；
- XHR / fetch；
- response body / JSON；
- browser context；
- cookies/session；
- 必要时 CDP session。

因此不要自行重写“F12 网络监听”。

建议建立：

```text
BrowserCaptureSession
    ├── page snapshot
    ├── network log
    ├── structured data
    ├── script data
    ├── media candidates
    └── optional screenshot
```

本地现状：

- 目前只有 `tool/comic18/fetch.py` 使用 Playwright。`BrowserFetcher` 先连接 `http://127.0.0.1:9222`；端口不可用且运行可交互时，才用固定 Chrome 路径启动专用 `--user-data-dir`，之后通过 `connect_over_cdp()` 复用该 context。工具只停止 Playwright client，不关闭用户的 Chrome。
- `acquire()` 的顺序是：本地 cache / offline recording → `curl_cffi` Chrome TLS impersonation + 已保存 cookie → Playwright/Chrome fallback。相关代码都在 `tool/comic18/fetch.py`；Playwright、curl_cffi 和 Pillow均为 lazy/optional import。
- 这套生命周期的策略可以复用，但现有实现不能直接成为 Builder Core：其中写死了 18comic host、Chrome 路径、CDP 端口、challenge 判断和 cookie 文件。Phase 1 应把“启动或附着浏览器、context/profile、page、network capture、关闭 client”提取为新的 Builder capture abstraction；18comic 继续调用或适配它，而不是让 Builder import 站点模块。
- Playwright 应作为 Builder 的正式依赖。Runtime 仍保持按 adapter capability 选择：普通声明式 adapter 不被迫启动浏览器，18comic 等 executable adapter 可以继续把 Playwright 作为 fallback。不要为了统一而把所有 runtime 抓取都改成 Playwright。

**原则：**
Builder 可以比最终 runtime 更重。  
不要因为 runtime 轻量要求，限制 Builder 使用真实浏览器。

---

## 4.2 DOM inventory

收集 rendered DOM 中：

- 可见 text node；
- `h1/h2/...`；
- link text + href；
- image：
  - `src`
  - `currentSrc`
  - `srcset`
  - lazy-load 常见属性
- `data-*`；
- `aria-*`；
- `title`；
- 常见内容属性；
- parent/sibling context；
- bounding box；
- visibility；
- DOM path；
- candidate selector。

暂不应把所有 DOM 节点直接展示给用户。

应先转为候选记录。

---

## 4.3 Meta / structured data

扫描：

- `<title>`
- canonical
- OpenGraph
- Twitter card
- JSON-LD
- Microdata（如当前库没有支持，可作为第二阶段）
- 其他 `<meta name/property=...>`

JSON-LD 应递归 flatten：

```text
$.name
$.image
$.author.name
$.datePublished
...
```

注意：
- 仅把它们作为候选；
- 不因为 key 名像 `author` 就直接写正式字段；
- 允许对明显标准字段提高 ranking，但不能绕过用户确认。

---

## 4.4 Inline script / hydration data

重点扫描：

- `application/json`；
- `application/ld+json`；
- 能直接 parse 的 script JSON；
- 常见 hydration state；
- 页面初始化对象。

应设置体积与深度限制，避免把巨大 bundle 当数据扫描。

建议：

```text
parseable object
→ recursive flatten
→ scalar / list candidates
→ record source path
```

本地确认：`src/generic/select.py` 已有可复用的 `json_path()`，支持点号字段与数字下标，例如 `languages[0].name`；`resolve()` 已实现 `json`、`json_list` 与 `json_length`。`json_list` 还支持 `where`、`take`、filter、offset/limit、transform。

Builder 可以直接用同一 path 语法生成最终 runtime rule，但 Candidate Harvester 仍需自己的递归 flatten/provenance 层：当前 `json_path()` 不支持 wildcard、递归 descent、任意数组枚举或来源图。Harvester 应在扫描时遍历对象，记录可回写成现有 dotted/index path 的来源；只有确实无法表达的通用情况，才扩展 selector primitive。

---

## 4.5 Network JSON

Playwright 监听 response：

优先保留：

- `application/json`
- GraphQL JSON
- fetch/XHR JSON
- 体积合理的结构化 response

每条记录保留：

```text
request URL
method
request payload/query
response status
content-type
JSON path
value
```

需有过滤：

- analytics；
- ads；
- telemetry；
- config；
- 超大 response；
- 与当前页面无明显关系的后台请求。

第一版不要追求完美语义判断。

---

## 4.6 Media inventory

收集：

- `<img>` / `<picture>`；
- CSS `background-image`；
- video poster；
- OG image；
- structured data image；
- network 中真实 image response；
- 页面可见尺寸；
- intrinsic size；
- 页面位置；
- URL query/token 信息。

统一形成 image candidate。

不要把“URL 不同但实际同一张图”当完全不同候选；至少支持：

- strip fragment；
- 可配置 strip 某些 tracking query；
- 本地 hash（下载后）；
- 相同尺寸/路径弱匹配。

---

# 5. Candidate 数据模型

建议不要直接把 selector 当作核心数据。

一个“真实值”可能同时来自：

- DOM；
- meta；
- JSON-LD；
- network JSON。

因此建议设计 Candidate Graph / Candidate Record。

示意：

```json
{
  "candidate_id": "cand_0012",
  "kind": "text",
  "normalized_value": "Example Work",
  "display_value": "Example Work",
  "sources": [
    {
      "channel": "dom",
      "selector": "main h1.title",
      "dom_path": "...",
      "visible": true
    },
    {
      "channel": "meta",
      "path": "og:title"
    },
    {
      "channel": "jsonld",
      "path": "$.name"
    },
    {
      "channel": "network_json",
      "request_fingerprint": "...",
      "path": "$.data.work.title"
    }
  ],
  "context": {
    "nearby_text": [],
    "bbox": null,
    "attributes": {}
  },
  "score": null
}
```

图片 candidate 可增加：

```text
width
height
mime
source variants
downloadable
same-resource hash
```

collection candidate 可增加：

```text
member candidates
repeated parent
common selector
array source path
```

最终字段 annotation 指向 `candidate_id`，不是只指向一个 selector。

---

# 6. Normalize / Deduplicate

这是自研的核心之一。

## 6.1 文本

归一化：

- trim；
- collapse whitespace；
- HTML entity decode；
- Unicode normalize；
- 保留原文。

不要在候选阶段做过强语言/标题清洗。

---

## 6.2 URL

归一化：

- resolve relative URL；
- strip fragment；
- 保留原始 fetch URL；
- canonical comparison URL 与 fetch URL 分离。

有签名/token 的 URL必须区分：

```text
fetch_url
stable/source_url
```

现有媒体处理经验应继续复用。

---

## 6.3 跨来源合并

例如同一个 title：

```text
DOM h1
OG title
JSON-LD name
API title
```

展示为一个候选，并列出 4 个来源。

跨来源一致性本身可以提高候选排序。

---

# 7. Candidate Ranking

第一版 ranking 应是确定性启发式，不需要模型。

可用信号：

- 多来源一致；
- 页面可见；
- DOM heading；
- 在主内容区域；
- image 尺寸较大；
- 与页面中心/主卡片接近；
- structured data 标准 key；
- API key 稳定；
- 重复出现频率；
- 是否像导航/footer/logo；
- 是否来自同域资源；
- 是否高频全站 boilerplate。

**Ranking 目标：**
不是自动决定字段，而是让用户优先看到合理选项。

UI 仍必须允许：
- 查看所有候选；
- 按类型过滤；
- 搜索 value/path/selector；
- 展开来源。

---

# 8. 点选与 selector：不要重造轮子

## 8.1 OpenPicker

OpenPicker 已提供：

- hover highlight；
- 点击锁定元素；
- selector inspector；
- DOM parent/child/sibling navigator；
- match count；
- selector 编辑；
- Shadow DOM 隔离 UI；
- cross-tab/cross-origin picker 协议；
- `@medv/finder` selector 生成。

建议：

1. 先做 PoC，判断能否直接把其 picker/SDK 作为 Builder 辅助；
2. 如果完整 extension 架构不合适，也可只借其设计和协议思想；
3. 不应重新写一套完整 hover/inspector/selector editor，除非本地集成需求明确证明必要。

许可证：MIT。

---

## 8.2 `@medv/finder`

用途：

- 用户直接点击 DOM 元素时生成短且唯一 CSS selector；
- 通过 filter 排除：
  - hash class；
  - 自动生成 ID；
  - 不稳定 attribute。

建议由前端/浏览器侧直接调用。

许可证：MIT。

---

# 9. “已知值 → rule”学习：优先验证 AutoScraper

AutoScraper 的能力与 Example 1 高度接近：

```text
HTML + wanted_list
→ 学习可复用规则
→ 在其他页面提取相似/相同结构
```

支持：

- text；
- URL；
- HTML attribute；
- 规则保存/加载。

建议用途：

> 作为 DOM Rule Learner，而不是整个 Candidate Harvester。

Builder 可以：

```text
Playwright rendered HTML
        ↓
用户确认 candidate value
        ↓
AutoScraper 尝试生成 DOM hypotheses
```

然后 Example 2 / Example 3 再验证。

需要 PoC 回答：

- 对现代动态 DOM 是否稳定；
- 对重复 collection 是否好用；
- 规则是否能可靠翻译成当前 `site.json` selector vocab；
- 与 `@medv/finder` 的结果谁更稳定；
- 项目维护状态是否足够适合作为长期硬依赖。

许可证：MIT。

---

# 10. selector 自适应：优先评估 Scrapling

Scrapling 已提供：

- CSS/XPath；
- auto selector generation；
- similar element；
- adaptive / auto-save / relocation；
- DOM navigation。

建议使用场景：

### Builder 阶段
Example 1 保存元素特征。

### Example 2 / 3
若原 selector 不命中，可尝试按元素特征重新定位。

### 后期 maintenance
adapter 原 selector 因小改版失效时，可用于：
- 给出 candidate replacement；
- 生成修复建议；
- 不应默认静默修改正式 adapter。

**重要：**
adaptive matching 应作为辅助，不要成为不可解释的主规则。

Generated adapter 最终仍应能落成确定性 selector/path。

许可证：BSD-3-Clause。

---

# 11. Portia：仅作为设计参考

Portia 的核心产品思想：

```text
render page
→ user annotation
→ identify field
→ learn scrape rule
→ apply to similar pages
```

与 SiteProbe Level 1 高度一致。

值得参考：

- sample；
- annotation；
- item schema；
- repeating element；
- extractor；
- 视觉式 scraper workflow。

但仓库已在 2026-06-24 archived/read-only。

因此：

**不要把 Portia 作为正式运行依赖。**

---

# 12. Crawl4AI：可选 schema-generation 参考

Crawl4AI 当前支持：

- CSS/XPath extraction；
- LLM 一次生成 extraction schema；
- 之后重复使用 schema，不再需要 LLM。

这验证了 SiteProbe 的总体原则：

> 智能放在 authoring/build 阶段，runtime 保持确定性。

但 SiteProbe 已有自己的：
- `site.json`
- generic selector engine
- RawItem
- review/selection

所以不建议把 Crawl4AI 作为第二套长期 extraction runtime。

可做一个实验：

```text
同一 Example 1
→ SiteProbe 用户标注结果
→ Crawl4AI schema generation
→ 比较生成 selector
```

只用于评估，不设为完成 SiteProbe 的必需依赖。

---

# 13. 三样本训练流程

## 13.1 Example 1：Discovery + Annotation

流程：

```text
URL
↓
BrowserCapture
↓
Candidate Harvester
↓
Normalize + Deduplicate
↓
Candidate UI
↓
用户标记字段
↓
Rule hypotheses
```

用户可标记：

### scalar
- title
- creator
- date
- description
- 其他

### media scalar
- cover

### collection
- tags
- characters/subjects
- preview/media list
- 其他重复值

UI 必须允许：

```text
Use this exact element
Use all similar/repeated elements
```

collection 不应被当成多个 scalar 手工逐个标记。

---

## 13.2 Rule hypotheses

每个字段保存多个候选来源：

```text
DOM selector
meta path
JSON-LD path
inline JSON path
network response + JSON path
```

不要 Example 1 就选死唯一规则。

可以建立优先级：

```text
稳定的结构化 API/path
> 稳定 JSON-LD/meta
> semantic DOM selector
> DOM selector with weak position
```

但最终必须由多页面验证决定。

---

## 13.3 Example 2：Confirmation / Pruning

自动应用 Example 1 hypotheses。

界面显示：

```text
Title   extracted value
Cover   image preview
Creator extracted value
Date    extracted value
Tags    N values
```

用户只需：

```text
✓ correct
✗ incorrect
```

错误项才重新打开 candidates。

对于每个 hypothesis 记录：

```text
hit / miss
value agreement
type agreement
collection cardinality
source stability
```

淘汰：
- 不命中；
- 命中错误元素；
- 只在 Example 1 靠 `nth-child` 偶然成立；
- 指向 boilerplate；
- collection 泛化错误。

---

## 13.4 Example 3：Blind Validation

第三个页面不再让用户重新选择候选。

先完整运行生成规则。

然后用户只做最终验收。

验证通过后才生成正式 adapter。

如果失败：

```text
field-specific failure
→ 回到该字段 Rule hypotheses
→ 不必整站重教
```

---

# 14. 规则选择与 site.json 生成

最终 adapter 规则应尽量落回当前 selector vocabulary。

本地 `src/generic/select.py` 的精确映射如下：

```text
Candidate source type                  → current selector type
DOM visible text / raw text            → html {document, scope/select, text|html}
DOM attribute                          → html {attr, absolute?, filter?}
DOM href query parameter               → html_param {attr, param}
meta name/property                     → meta {name|property}
JSON scalar / object path              → json {document, path}
JSON object-array projection           → json_list {path, where?, take?}
JSON collection/string length          → json_length {path}
regex fallback over one document       → regex {document, pattern, group?}
source URL / captured URL group         → url {pattern?, template?}
listing-card value reused by work rule → card {field}
constant/default                       → const {value}
```

所有 selector 都可使用 `transform` 和 `fallback`；HTML/JSON list 还支持 filter、list、offset/limit 等投影选项。`extract_listing_page()` 已让每张 card 的相对 DOM subtree 使用同一 selector vocabulary，因此 Builder 不需要为 listing field 再造 selector DSL。

现有限制也必须写入 Builder validator：JSON path 只有 dotted key + numeric index；CSS 能力由 `htmltree.py` 的自有实现决定，并非完整浏览器 `querySelector`；network response 在成为 selector document 前必须有稳定的 request recipe 和 document 名。需要新增 primitive 时，只增加跨站点通用能力并配 neutral fixture test。

如现有 vocabulary 不足：

- 只加真正需要的通用 primitive；
- 不允许为某网站加通用层特例；
- 新 primitive 必须有 fixture test。

---

# 15. 搜索/Listing Builder

这是单作品 Builder 完成后的第二阶段。

## 15.1 目标类型

继续沿用当前 target 概念，例如：

```text
single work
search
creator/author listing
collection/favorite/playlist-like listing
```

具体 target 名称以现有 schema 为准。

用户负责声明：

> 这是“搜索页”还是“某种列表页”。

Builder 不需要猜业务语义。

---

## 15.2 搜索入口发现：分层支持

不要一开始试图“自动理解任意站点搜索”。

### Level A：URL-template search

例如用户执行一次搜索后 URL 出现 query。

记录：

```text
before URL
after URL
query term
```

推断 query 参数模板。

再用第二关键词验证。

---

### Level B：form-based search

用户在浏览器里实际执行一次搜索。

捕获：

- form；
- input；
- submit；
- method；
- request URL；
- query/body。

生成 search recipe。

---

### Level C：network-backed search

如果 UI search 触发 XHR/fetch：

记录：

```text
request fingerprint
query parameter/body path
response type
```

用第二关键词验证。

---

### Level D：custom site mechanism

如果搜索机制依赖：
- 特殊索引；
- 多阶段请求；
- 自定义签名；
- 非标准 JS；
- 特殊鉴权；

Builder 应明确：

```text
Generic search recipe unsupported.
Custom fetch adapter required.
```

不要为了“100% 通用”污染核心。

---

# 16. Repeated Card Detection

搜索/listing 最重要的是从候选中识别重复结构。

候选来源：

## DOM
寻找：
- sibling repeated subtree；
- 相似 tag/class structure；
- repeated links/images/text组合。

## JSON
寻找：
- object array；
- 每个 object 有 URL/id/title/image 等类似 key。

Candidate Harvester 输出：

```text
RepeatedGroup
    member count
    common parent
    common selector
    representative members
```

用户选择一张 card，并标记：

```text
work URL
title
cover
id
optional metadata
```

然后系统生成：

```text
baseSelector
field selectors relative to card
```

这部分可参考 SelectorGadget/Portia repeating-element 思想。

---

# 17. 分页学习

第一版优先顺序：

1. URL page parameter；
2. explicit next link；
3. numbered pagination；
4. load-more button；
5. infinite scroll。

其中 1–3 作为完成最低要求较合理。

4–5 如实现复杂，可：
- 作为 experimental；
- 或输出“manual/custom fetch required”。

验证方式：

```text
page 1
→ next
→ page 2
→ 确认出现新 item ids
```

终止条件仍应优先使用：

```text
本页无新增 id
```

而不是只信任 UI 的 next 标记。

---

# 18. Review / Selection 复用

当前通用 review/selection 已经成熟。

因此 Level 1 搜索成功后不要重新设计一套 review。

目标：

```text
Learned listing
→ list_cards
→ existing generic review
→ selection
→ only selected read_work
```

本地确认：现有 contract 与 Builder 生成的普通 listing 兼容，但 Builder 必须满足以下最小字段和 hook：

- `list_cards(template, kind, ref, options)` 返回 card；每张 card 必须有稳定的 `source_id`，并至少有一个 `detail_url` 或 `url`。`title`、`cover_url`、`author`、`tags`、`language`、尺寸和页数都是 review 展示增强项。
- selection payload 保留 `source_site`、`target_kind`、`target_ref`、`source_url`、`selected_source_ids` 与 `selected_items`。
- generic selection 会重新调用 `list_cards`，按稳定 `source_id` 找回所选 card，再把 card 交给 `collect_items()`，最后只对所选 URL 调用 `read_work`。
- Builder 生成的 target 必须在 `site.json.targets` 中声明为非 single，fetch/runtime 必须能提供 `list_cards`；普通 HTML listing 可复用 `extract_listing_page()`，其 card field 已使用同一个 selector resolver。

因此不需要新增第二套 review/selection contract。Phase 7 的验收重点是 generated listing 在重新列举后仍产生相同的 source id 和 detail URL。

---

# 19. Builder Session 的中间产物

建议 Builder 不是一次性黑盒。

每次教学保存 session：

```text
builder_sessions/
    <domain>/<session-id>/
        example1/
            capture.json
            candidates.json
            screenshot.*
        example2/
            ...
        example3/
            ...
        annotations.json
        hypotheses.json
        validation.json
        draft_site.json
```

好处：

- debug；
- 回放；
- 不用每次重新访问站点；
- 做 regression fixture；
- 本地 AI 可直接检查失败案例。

正式路径以后由本地仓库情况决定。

---

# 20. 测试策略

## 20.1 Library PoC 测试

在正式改架构前先做独立实验。

至少验证：

### PoC A：Playwright Capture
- rendered DOM；
- JSON response；
- image/resource；
- session/cookie。

### PoC B：known value → rule
同一已知站点选 3 个作品：

```text
Example 1 给真实 title/creator/cover
→ AutoScraper / finder / Scrapling 生成规则
→ Example 2
→ Example 3
```

先证明“选完以后能学”。

### PoC C：Candidate discovery
不提供真实值：

```text
→ 自动列候选
→ 人工确认目标值是否都在候选中
```

核心指标是 **recall**，不是一开始就追求排序。

---

## 20.2 Golden fixture

建立内容中立的本地 fixture：

```text
fixtures/
    static_work/
    jsonld_work/
    hydrated_work/
    api_work/
    repeated_listing/
    pagination/
```

不要让全部测试依赖真实在线网站。

每个 fixture 同时保存：

```text
HTML
JSON
expected candidate set
expected adapter
expected extraction
```

---

## 20.3 现有真实 adapter regression

保留现有录制语料回归。

Builder 改 generic primitives 时必须保证：

```text
existing field comparisons remain unchanged
existing review/selection tests remain green
```

本地基线（2026-09-19）：

```text
PYTHONDONTWRITEBYTECODE=1 .venv/Scripts/python.exe -m pytest -p no:cacheprovider -q
52 passed in 0.43s
```

测试文件为 `tests/test_generic_probe.py`、`tests/test_site_contract.py`、`tests/test_work_urls.py`。现有覆盖包括 selector/json/fallback、registry 与 URL target resolution、canonical importer contract、origin/manifest、taxonomy review、adapter contract、BAT 可解析性和三站点 work URL 解析；尚无 Candidate Harvester、Builder session、三样本学习或 generated adapter round-trip 测试，这些必须由 Phase 2–7 新增 neutral fixtures 覆盖。

---

# 21. 分阶段实施

## Phase 0 — 本地代码审计

本地 AI 先补：

- 当前目录树；
- current CLI；
- current `site.json` schema；
- generic selector implementation；
- fetch/browser code；
- review/selection contract；
- tests；
- dependency management；
- Python/TS 边界。

输出：

```text
CURRENT_ARCHITECTURE.md
```

或直接补进本计划。

**此阶段不改代码。**

---

## Phase 1 — Library PoC

目标：

> 确认哪些轮子可以直接用。

实验：

- Playwright；
- `@medv/finder`；
- OpenPicker；
- AutoScraper；
- Scrapling。

每个库记录：

```text
能解决什么
集成成本
长期维护风险
许可证
是否成为正式依赖
是否只抄设计
```

完成标准：

```text
Browser capture chosen
Picker/selector strategy chosen
DOM rule learner chosen
Adaptive matching strategy chosen
```

---

## Phase 2 — Candidate Harvester v1

先支持：

- DOM；
- meta；
- JSON-LD；
- parseable script JSON；
- network JSON；
- images。

完成：

```text
capture.json
candidates.json
```

先用 CLI/调试 HTML 看结果，不急着做漂亮 UI。

---

## Phase 3 — Normalize / Deduplicate / Ranking

实现 Candidate Graph。

验收：

- 同一 title 多 source 合并；
- 同一 cover 多 source 合并；
- logo/导航不会永远排第一；
- 能展开看到所有来源。

---

## Phase 4 — Annotation UI

实现：

```text
field list
candidate list
image preview
source details
element highlight
pick from page
scalar / collection
```

尽量复用 OpenPicker / finder。

---

## Phase 5 — Single Work Rule Learner

实现：

```text
Example 1
Example 2
Example 3
```

能生成 draft `site.json`。

---

## Phase 6 — Runtime Round-trip

最关键验收：

```text
Builder extraction
        ==
generated site.json
        ==
existing generic runtime extraction
```

否则 Builder 只是另一套系统，不能算完成。

---

## Phase 7 — Listing/Search Builder

加入：

- repeated groups；
- card fields；
- search recipe；
- basic pagination；
- existing review/selection round-trip。

---

## Phase 8 — Hardening

加入：

- failure diagnostics；
- selector stability；
- adapter validation；
- fixture replay；
- corrupted/partial session recovery；
- media verification；
- structured logs。

---

## Phase 9 — Standalone SiteProbe Completion

此阶段只保证 SiteProbe 自身：

- Level 0 可用；
- Level 1 单作品完成；
- Level 1 普通搜索/listing 完成；
- generated adapter 可保存、重新加载、运行；
- existing adapters 不回归；
- CLI/standalone debug UI 可完整完成教学；
- 文档齐全。

到这里结束。

**不进入 T³ integration。**

---

# 22. 明确不做 / 延后

本轮不应被以下工作拖住：

- T³ 正式前端入口；
- T³ clipboard；
- T³ database commit；
- T³ process/API transport；
- adapter marketplace；
- 大量逐站人工适配；
- 运行时 LLM；
- “任何网站搜索都自动成功”的承诺；
- 自动生成复杂自定义 `fetch.py`；
- adapter 远程更新/签名；
- 第三方 adapter trust model。

这些属于后续架构/生态工作。

---

# 23. 依赖建议总表

| 组件 | 建议角色 | 是否优先实际依赖 | 备注 |
|---|---|---:|---|
| Playwright Python | 浏览器、rendered DOM、network capture | 是 | Apache-2.0 |
| OpenPicker | 点选/inspect UX、跨 tab picker 参考或复用 | PoC 后决定 | MIT |
| `@medv/finder` | CSS selector 生成 | 是/高优先 | MIT |
| AutoScraper | 已知值 → DOM rule hypotheses | PoC 后决定 | MIT |
| Scrapling | adaptive matching / selector 辅助 | PoC 后决定 | BSD-3-Clause |
| Portia | annotation/repeating-item 产品设计参考 | 否 | 已归档 |
| Crawl4AI | schema-generation 设计/可选实验 | 否（默认） | 不替换现有 runtime |

---

# 24. 外部参考

调研日期：2026-09-19。

- Playwright Python Network  
  https://playwright.dev/python/docs/network
- Playwright Response API  
  https://playwright.dev/python/docs/api/class-response
- Playwright Python repository/license  
  https://github.com/microsoft/playwright-python
- OpenPicker  
  https://github.com/usertour/openpicker
- OpenPicker DESIGN  
  https://github.com/usertour/openpicker/blob/main/DESIGN.md
- `@medv/finder`  
  https://github.com/antonmedv/Finder
- AutoScraper  
  https://github.com/alirezamika/autoscraper
- Scrapling  
  https://github.com/D4Vinci/Scrapling
- Scrapling selector/adaptive docs  
  https://scrapling.readthedocs.io/en/latest/api-reference/selector.html
- Portia（架构参考；已归档）  
  https://github.com/scrapinghub/portia
- Crawl4AI quickstart/schema generation  
  https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/quickstart.md

---

# 25. 已确认的本地工程基线

- **当前目录/模块：** SiteProbe 根为 `D:\Project\Dataextracted\site_probe\generic_probe`。Core 位于 `src/generic/`；站点 adapter 位于 `tool/<site>/`；已有 `hitomi_la`、`hanime1_me`、`comic18`；测试位于 `tests/`；导出默认进入 `export/`。
- **浏览器复用边界：** `tool/comic18/fetch.py` 的 cache → curl_cffi → CDP/Playwright 策略可作为设计和抽取来源，但站点常量必须留在 adapter。Builder 应有独立的 `BrowserCaptureSession`，不能直接依赖 comic18 模块。
- **Python 与依赖：** `pyproject.toml` 要求 Python `>=3.11`。基础依赖只有 `opencc-python-reimplemented`；extras 为 `browser = playwright/httpx/curl_cffi`、`media = pillow`、`dev = pytest`。当前本地 `.venv` 可运行全部测试。
- **Selector schema：** `src/generic/select.py` 支持 `const/card/url/json/json_length/json_list/html/html_param/meta/regex`，以及 transform、fallback、map、filter、list、offset/limit、where/take、absolute 和 context interpolation；第 14 节已列精确映射。
- **Builder 模块位置：** standalone 完善阶段在当前 Python 工程新增 `src/builder/`，与 `src/generic/` 并列；它可以依赖 generic contract，但 runtime 不反向依赖 builder。以后整体迁入 T³ 主仓库顶层 `siteprobe/` subtree。
- **Standalone UI：** 当前没有常驻 GUI。已有 UI 是 `src/generic/review.py` 生成的自包含 `review.html`；CLI/BAT 负责启动 probe、picker、selection 与 tag review。Builder v1 可沿用“CLI 启动 + 本地生成/服务 HTML”的形态，不要求先引入第二个前端框架。
- **Adapter discovery：** `src/generic/registry.py` 只扫描项目根 `tool/` 下含 `site.json` 的直接子目录，并通过 `tool.<site.tool>.fetch` import module。当前每站必须有可调用的 `read_work`；listing/review/export hooks 可选。
- **Test command：** `PYTHONDONTWRITEBYTECODE=1 .venv/Scripts/python.exe -m pytest -p no:cacheprovider -q`；当前结果为 52 passed。正式开发也可使用 `uv sync --extra browser --extra media --extra dev` 后运行 pytest。
- **Schema version：** 当前 `site.json` 没有 schema version，loader 也未验证 version。冻结 Adapter Contract 时应新增顶层整数 `schema_version`（第一版为 1），并让 loader 对未知 major/version fail loudly；不要靠工具版本猜配置形态。
- **Generated adapter 保存位置：** 当前 Builder 和 local root 尚不存在。Standalone 阶段新增 gitignored 的项目根 `local/` 作为默认输出，并让 registry 接受显式 roots；T³ 集成后正式位置为 `<T3_DATA_DIR>/siteprobe/local/`。生成物至少包含 `adapter.json` 与 `site.json`，默认不生成 Python。
- **Search/listing CLI 与 code path：** `probe.py`/`src.generic.cli.main` 负责非交互输入，`pick.py`/`pick_main` 负责 registry 驱动的交互选择，`--review` 进入 scan；`list_cards` 或 `scan_review` 产生 review，`selection.py`/`src.generic.selection.run_selection` 重新列举并只抓 selected ids。普通 HTML card 解析走 `extract_listing_page()`，特殊 listing 留在 adapter fetcher。
- **可直接复用的 Phase 6/7 验收：** 现有 importer-contract、manifest/origin、selector/fallback、registry discovery、target resolution、adapter contract 与 URL parsing tests 可继续作为回归；新增 round-trip 必须断言 Builder 结果、generated `site.json` runtime 结果与期望 fixture 三者一致，并覆盖 repeated card、分页和 selection relist。
- **打包冲突：** 当前 setuptools `packages` 明确写死三个 adapter，不能自动包含新增 external/local adapter；Playwright 还需要浏览器二进制，OpenPicker/`@medv/finder` 属于 JS 依赖，而当前 SiteProbe 是纯 Python package；AutoScraper/Scrapling 会增加可选依赖与维护面。Phase 1 PoC 后再决定依赖，并在引入 external roots 前先修正 package discovery/runtime path 机制。

以上基线已经足够开始 Phase 1；在 PoC 结论出来前仍不应大范围重构 runtime。

---

# 26. 最终工程原则

后续实现中始终守住以下约束：

1. **Candidate Harvester 追求高 recall；用户负责语义确认。**
2. **Builder 可以复杂，runtime 必须确定性、轻量。**
3. **智能用于生成规则，不用于每次运行。**
4. **一个真实字段可对应多个数据 source；不要过早绑定一个 selector。**
5. **三样本是训练/验证流程，不是三次重复标注。**
6. **普通站点尽量生成声明式 `site.json`。**
7. **遇到特殊机制就承认需要 custom adapter，不污染 generic core。**
8. **搜索/listing 建立在同一 Candidate Harvester 上，不另造体系。**
9. **现有 review/selection 尽量复用。**
10. **最终验证标准是生成 adapter 能被现有 SiteProbe runtime 独立执行。**
