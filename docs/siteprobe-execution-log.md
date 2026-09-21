<!-- siteprobe-log-index -->

> **怎么读这个文件。** 它是 append-only 的执行记录：每节按当时发生的顺序追加；被修正过的
> 判断不会抹掉，而是以「修正 / 回归修正」接在后面（谁先写错、错在哪、拿什么量的，都留着）。
> 要按阶段看就顺着读，要按主题找就用下面的表。正文没有被删减。


| 类别 | 章节 | 行 |
|---|---|---|
| 阶段 | SiteProbe Phase 1 — Library PoC 结论 | 0048 |
| 阶段 | Phase 2 — Candidate Harvester v1 | 0227 |
| 阶段 | Phase 3 — Normalize / Deduplicate / Ranking | 0314 |
| 阶段 | Phase 4 — Annotation UI | 0387 |
| 阶段 | Phase 5 — Single Work Rule Learner（三样本） | 0463 |
| 阶段 | Phase 6 — Runtime Round-trip（含 confirm 模式） | 0540 |
| 阶段 | 修正：标注页的封面从来没显示过（Phase 4/6 回归） | 0642 |
| 阶段 | 修正：真正的封面从来没进过候选（Phase 2 召回缺口） | 0671 |
| 修正 | 修正：confirm 模式的封面、简介字段、以及"这项本就没有" | 0729 |
| 修正 | 修正：字段名映射、以及"简介"的 T³ 侧需求 | 0780 |
| 修正 | 修正：无法安装、读错元素的规则、以及冗余 | 0844 |
| 修正 | 修正：日期定位不到，以及确认按钮点不动 | 0907 |
| 修正 | 修正：兄弟项里的值无法定位（"日期每次都没找到"） | 0938 |
| 修正 | 修复：重建 crawl 状态，并重新同步三个站点的 taxonomy | 0976 |
| 修正 | 修正：每次生成标注页都要等好几分钟 | 1030 |
| 修正 | 修正：读不到的那些字段——三个通用形状问题 | 1071 |
| 修正 | 修正：把同级的值误当成标签（`creator` 恒为空的真因） | 1126 |
| 修正 | 修正：hitomi 暴露的三个通用缺陷（合并的列表 / 截断的集合值 / 有分歧也叫 PASS） | 1161 |
| 修正 | 修正：18comic 的作者读不到（页面"声明的身份"从未被使用） | 1248 |
| 修正 | 修正：作者指向了 series；以及"只有作品 1 被问过" | 1299 |
| 修正 | 修正：登场人物与作品学到的是同一个块（`原神`） | 1346 |
| 修正 | 回归修正：封面变成"无可用规则" | 1379 |
| 验收 | 全量验收（18comic 验收通过后） | 1393 |
| 阶段 | Phase 7 开始：列表页的重复 card（§16 Card Detection） | 1428 |
| 结论/其它 | 多值字段的拆分（tag、角色这类要去掉空格、逗号） | 1461 |
| 阶段 | Phase 7 核心：listing 规则与分页（`src/builder/listing.py`） | 1476 |
| 阶段 | Phase 7 完成（交互入口 + 三个"缺的翻译"） | 1503 |
| 阶段 | Phase 7 第一次真实列表页运行：卡片识别对了，规则选择错了 | 1535 |
| 阶段 | Phase 7 在真实列表页上验通（hitomi artist 页） | 1561 |
| 结论/其它 | 列表页的两处重复结构：都可能是列表 | 1590 |
| 阶段 | Phase 7 收束：真实列表页验通，以及这一阶段学到的四条 | 1599 |
| 阶段 | 下一阶段：维护那一半（计划 §10 的 "后期 maintenance"） | 1665 |
| 结论/其它 | 评估结论：AutoScraper（§9）与 Scrapling（§10）都不引入为依赖 | 1698 |
| 结论/其它 | 登录态：通用化的只有"会话"这一层（用户的决定） | 1736 |
| 结论/其它 | 结论：登录态/防护这条线，通用层到此为止（两次实测支撑） | 1760 |

---

# SiteProbe Phase 1 — Library PoC 结论

> 执行 `siteprobe-completion-plan.md` §21 Phase 1。目的是回答该阶段的四个验收项，并决定哪些现成轮子成为正式依赖。
> 测量日期：2026-09-19。测量脚本：`D:\Project\Dataextracted\site_probe\generic_probe\poc\`。
> 环境：Python 3.11.6，playwright 1.63.0，curl-cffi 0.16.3，Pillow 12.3.0。

---

## 0. 四个验收项

| 验收项 | 结论 |
|---|---|
| Browser capture chosen | **Playwright，用 `channel="chrome"`**，且只作为 Builder 的发现工具，不进 runtime |
| Picker / selector strategy chosen | **延后到 Phase 4**（沿用 `@medv/finder` 的思路，上线前再评估；本轮标注走 JSON/CLI） |
| DOM rule learner chosen | **不引入外部库**，用现有 selector vocabulary 自己写 |
| Adaptive matching strategy chosen | **不做**。Scrapling 在本版本没有该能力，且自适应匹配会引入不可解释的主规则 |

---

## 1. 最重要的发现：看起来最难的站点，runtime 根本不需要浏览器

iwara 原本被判定为"JS 空壳，需要浏览器或 API 规则"。PoC A 的浏览器捕获显示它的会话里有
`cf_clearance`，网络日志里出现 `api.iwara.tv`。于是直接测那个 API：

```
GET https://api.iwara.tv/video/sOAekITnnSb24p     (curl_cffi impersonate=chrome，无浏览器、无 cookie)
200  2005B
  title      "Fleurdelys"
  user.name  "mingja"
  tags       [{id: "fleurdelys"}, {id: "koikatsu", type: "category"}, ...]
  file.id    "9813760e-7a81-40ae-a0c5-5674aef5be07"
  thumbnail  12          file.numThumbnails 16
```

封面 URL 可由 `file.id` 与 `thumbnail` 拼出：

```
https://i.iwara.tv/image/thumbnail/9813760e-7a81-40ae-a0c5-5674aef5be07/thumbnail-12.jpg
→ 200  5905B  image/jpeg  magic=b'\xff\xd8\xff'
```

**即 title / author / tags / date / cover 全部来自一次普通 GET，不需要浏览器、不需要会话。**

这条对架构的影响大过任何单个库的取舍：

- iwara 是**伪装成 SPA 的静态站点**，它的适配器只需要一条规则，复杂度低于 18comic（无 Playwright、无 cookie）。它属于你所说"少数值得适配的知名站点"里最便宜的一个。
- 浏览器在 Builder 里的角色是**发现仪器**（找到那个 XHR、记录 request recipe 与 JSON path），不是 runtime 的执行手段。这正是计划 §4.5 + §15.2 Level C。
- 因此 Builder 的网络捕获不是可选装饰，而是这一类站点的**主通道**。

---

## 2. 浏览器捕获的真实代价（PoC A 实测）

| 站点 | 普通请求 | 浏览器捕获 | 渲染 DOM | JSON 响应 | 浏览器带来了什么 |
|---|---|---|---|---|---|
| manwa（静态可读） | 0.96s | **7.83s** | 145KB，67 img | **0** | 无。封面与普通请求完全一致，标题反而更差（带站点后缀） |
| iwara（JS 空壳） | 0.83s，0 候选 | 4.66s | 830KB，51 img | 19 | 拿到真标题；但候选前 5 张是广告和头像 |
| nshens（Nuxt + hydration） | 0.42s，0 候选 | 4.19s | 519KB，6 img | 3 | 拿到真标题；6 张 img 全是 `data:` SVG 占位，**封面仍未到手** |

要点：

- **成本 4–8s 对 0.06–1.0s**，这是每次捕获的固定地板，符合"fast daily use"是产品第一优先级这一约束 —— 所以它不能进 Level 0 的默认路径（此前已按此决定）。
- **渲染后的候选空间更嘈杂**：iwara 前 5 张图是广告 banner 与用户头像，19 条 JSON 响应里真正相关的约 2 条。无规则的 reader 在渲染 DOM 上**更难**判断哪张是封面，不是更容易。
- **渲染不保证拿到封面**：nshens 渲染后拿到标题，但 6 张图全是占位——封面值仍只在 hydration 块里。
- 浏览器确实带出整套会话（24–32 个 cookie，含 `cf_clearance`）。这正是"18comic 级别"那套机制的本体。

---

## 3. 规则学习库：两个都不合格（PoC B 实测）

在同一页（manwa，静态 HTML）上，用已知的真实标题与真实封面 URL 喂进去。

### AutoScraper 1.1.14（MIT）

它**学对了结构**：

```
标题  html > body > div.main-content > h1.detail-main-info-title
封面  … > div.detail-main-flex > img.lazy        wanted_attr='data-original'
```

但**三种取回方式全部返回空**：`get_result` → `([], [])`，`get_result_similar` → `[]`，`get_result_exact` → `[]`。
即学出的规则无法应用，连它自己学的那一页都取不出来。

而且它的规则方言与本 runtime 不相容：规则是 `>` 子链 + 精确属性字典，而 `htmltree.py` 明确不支持子组合器（实测 `div > h1` → `UNSUPPORTED: unsupported selector step: '>'`）。它学的属性字典里还带 `style` 全值，页面小改即失效。

**结论：不作为依赖。**

### Scrapling 0.4.15（BSD-3）

`Adaptor` 没有任何 `auto*` 方法 —— 计划期待的 auto selector / adaptive relocation 在本版本**不存在**。
它的选择器语言比 `htmltree` 更宽（`div > h1` 命中 1、`img.lazy::attr(data-original)` 命中 11），这是**翻译成本**而非所需能力。若引入，就要维护"它的选择器 → 我们的选择器"的翻译层，且翻译后的行为不等价。

**结论：不作为依赖。** 自适应匹配也一并否决：计划 §10 自己就说它"应作为辅助，不要成为不可解释的主规则"，而它连可用的入口都没有。

---

## 4. 但 PoC B 给出了正面结论：需要学的规则很短

两个库都没能用，可是**该学出来的规则本身极简**，而且**现有 vocabulary 完全能表达**：

```
标题  {"from": "html", "select": "h1.detail-main-info-title", "text": true}     → 命中 1
封面  {"from": "html", "select": "img.lazy", "attr": "data-original"}           → 命中 11
```

实测 `img.lazy` 命中 11、`img[data-original]` 命中 11、`h1` 命中 1。

也就是说 Builder 不需要"规则学习库"这个部件，它需要的是：

1. **候选发现**（把值挖出来，含 provenance）；
2. **一个人指出哪个候选是对应的字段** —— 这正是计划 §13 的三样本流程，也正是你选定的"先 JSON/CLI 标注"。

这条路径比引入 AutoScraper 更短，且产出的规则天然落在 runtime 自己的 vocabulary 里，不会出现"学出来了但运行时用不了"的翻译层。

---

## 5. 通道召回率（PoC C，计划指定的核心指标）

不提供真实值，只看正确的值**是否出现在**候选里。（manwa 的期望值取自页面本身，iwara 取自 API 的 `file.id`，nshens 取自 hydration 块里的图片路径。）

| 站点 | markup 通道（meta/jsonld/img） | 内联脚本通道 |
|---|---|---|
| manwa | **HIT**（8 个候选，封面在内） | MISS |
| iwara | MISS（0 个候选） | MISS（0 个值） |
| nshens | MISS（0 个候选） | MISS（17 个值，无一含目标） |

两个诚实的注解：

- iwara 与 nshens 的 MISS 是**通道缺失**，不是提取失败：目标值确实存在于 hydration 块 / API 里，但静态 HTML 的 markup 通道里没有它。
- nshens 那格尤其说明问题：值是 `…\u002Ffree\u002F10039037\u002F….jpg`，目标子串被 `\u002F` 转义切成两半，**字符串扫描跨不过转义边界**。所以内联脚本通道必须真解析、真解码，这恰恰是计划把它放在 Harvester（而非 Level 0）的原因。

另外：非 markup 通道拿到的多是**零件**（uuid、转义路径、数字索引），不是拼好的 URL。规则需要把它们组装成 URL —— 现有 vocabulary 的 `url {template, context}` 支持这一点，但**这是一次模板替换，不是一次取值**，Builder 的规则生成必须覆盖它。

---

## 6. 依赖裁决

| 组件 | 能解决什么 | 集成成本 | 维护风险 | 许可证 | 裁决 |
|---|---|---|---|---|---|
| **Playwright** | 渲染 DOM、network log、cookie 会话、截图 | 已装。**注意**：本 venv 的 playwright 1.63 要 chromium-1243，本地只有 1208，故用 `channel="chrome"` 复用系统 Chrome 153，免下载 | 低，微软维护 | Apache-2.0 | **成为 Builder 依赖**；runtime 不依赖 |
| AutoScraper | 已知值 → DOM 规则（理论） | 低（+5 包） | **中高**：学习正确但取回失败；规则方言与本 runtime 不兼容 | MIT | **不引入** |
| Scrapling | 更宽的选择器、自适应匹配（本版本缺失） | 中（+6 包，需翻译层） | 中高：目标 API 在本版本不存在 | BSD-3 | **不引入** |
| `@medv/finder` | 点选时生成短 selector | 需在页面内注入单文件 JS（无 npm，符合你的依赖姿态） | 低 | MIT | **延后到 Phase 4**，与标注 UI 一起评估 |
| OpenPicker | 点选 / inspect UX | 浏览器扩展形态，与"CLI + 本地 HTML"的现状冲突较大 | 低 | MIT | **延后到 Phase 4**，只参考其设计 |
| Portia | 视觉式标注 → scraper 的产品设计 | — | 仓库已归档 | — | **仅参考设计** |
| Crawl4AI | 一次生成 schema、之后确定性执行（设计参考） | — | — | — | **不引入**，已有自己的 runtime |

---

## 7. 环境基线（后续阶段要记住的）

- Playwright 的浏览器二进制在本机**版本不匹配**：包要求 `chromium_headless_shell-1243`，已下载的是 `-1208`。**用 `channel="chrome"` 复用系统 Chrome（实测 153.0.8010.50）**，无需 `playwright install` 的 150MB 下载。若将来改用自带 chromium，必须先跑 `playwright install`。
- Python 3.11.6；`uv` 在 `/c/Users/hzy/AppData/Local/hermes/bin/uv`。
- PoC 期间临时装入的 `autoscraper` 与 `scrapling`（含 lxml / beautifulsoup4 / cssselect / orjson / tld / w3lib）**已按裁决卸载**；重跑 `poc/rule_learning*.py` 需先 `uv pip install autoscraper scrapling`。
- PoC 脚本位于 `poc/`，不属于 runtime，也不在 `tests/check_undefined_names.py` 的扫描范围内。

---

## 8. 本轮未做

- **PoC C 的样本量**：只测了 3 个站点 × 2 个通道。它的结论（markup 通道覆盖静态站点、非 markup 通道的值是零件且需解码）方向明确，但"召回率"这个数字本身需要更大样本才有统计意义。
- **`@medv/finder` / OpenPicker 的实际集成成本**：你已选择"先 JSON/CLI 标注"，它们属于 Phase 4 的标注 UI，推迟评估与计划的分期一致。
- **自适应匹配**：随 Scrapling 一并否决。

---

## 9. 由此确定的下一步（Phase 2）

按 PoC 结论，Phase 2 的 Candidate Harvester 应优先实现这三个通道，且以**召回**为目标而非排序：

1. **markup**（已有 `cover_candidates` 的原型，扩大为通用候选）——静态站点的唯一必需通道；
2. **hydration / inline script**（带真正的解码：转义、位置参数），因为它是 nshens 一类唯一的数据来源；
3. **network JSON**（需要 request recipe + JSON path），因为它是 iwara 一类的主通道，而且能反过来让 runtime 免掉浏览器。

排序、去重、provenance 展示按计划 §6–§7 随后补。

---

# Phase 2 — Candidate Harvester v1

> 执行 `siteprobe-completion-plan.md` §21 Phase 2。完成标准：`capture.json` / `candidates.json`，
> 先用 CLI 看结果，不做 UI。通道范围按 Phase 1 的结论定：markup / jsonld / inline / network / media。
> 代码：`src/builder/capture.py`、`src/builder/harvest.py`，CLI 为根目录 `harvest.py`。

## 1. 做出来的东西

```text
capture.json     builder_sessions/<host>/<session-id>/capture.json
                 页面 markup + 每个内联脚本 + 每条 JSON 响应，作为 documents
candidates.json  builder_sessions/<host>/<session-id>/candidates.json
                 Candidate 记录：kind / normalized_value / display_value /
                 sources[{channel, document, detail}] / context / score
```

`capture.json` 是 Harvester 的**唯一输入**——这是为了可回放、可事后调试、可做回归 fixture，三者都要求输入不是实时页面。

CLI：

```bash
python harvest.py <url>              # 只用 markup，无浏览器
python harvest.py --browser <url>    # 渲染，并把页面自己请求的 JSON 一起记下
```

## 2. 通道

| 通道 | 来源 | 状态 |
|---|---|---|
| `markup` | 标题层级、`<title>`、meta、链接文本与 href、`data-*`/`aria-*`、正文块 | 完成 |
| `jsonld` | `application/ld+json`，递归展开为点号路径 | 完成 |
| `inline` | 内联 `<script>` 里的框架状态 | **部分**：能 parse 的按路径取值；不能 parse 的（压缩 IIFE）退化为字符串字面量扫描 |
| `network` | 浏览器捕获到的 XHR/fetch JSON 响应体 | 完成 |
| `media` | `<img>`/`<source>` 的每个图片属性，带声明尺寸与文档位置 | 完成 |

`inline` 通道的能力边界是明确的、也写在代码里：压缩状态的值藏在位置参数后面（`(function(a,b){…}("A Work","/c.jpg"))`），**正确解码需要 JavaScript 求值器**，那是后续工作。当前做法是：有 `key:` 前缀的字面量记为 `path` 证据；没有前缀的（位置参数）**保留**但标记为 `literal` 并扣分——因为它们确实是数据，只是没有路径。每次退化都会写进 `notes`，所以"让出了多少召回"是可见的，不是静默的。

## 3. 六个内容中立的 fixture

`fixtures/` 下六个用例，每个带 `page.html`（+ 需要时 `network_N.json`）与 `expected.json`（声明必须被找到的值，以及应由哪个通道给出）：

```text
static_work      普通 markup：h1 + img + data-author
jsonld_work      JSON-LD Book：name / author.name / datePublished / image.url
hydrated_work    Nuxt 风格 window.__NUXT__，封面路径写成 \u002F 转义
api_work         空壳 markup + 一条 JSON 响应（数据只在响应里）
repeated_listing 三张重复卡片：三个标题、三个 href、三张图，一个都不许被合并掉
pagination       next 链接与 page 参数
```

测试逐 fixture 断言**召回**：值必须出现在候选集里，并且必须带有来源。测试不排序——"排得不好还能被人挑出来，没被提出来的值无法补救"。

## 4. 实测

| 站点 / 路径 | 候选数 | 真封面排名 | 真标题排名 |
|---|---|---|---|
| manwa（markup） | 616 | **1** | **2** |
| iwara（`--browser`） | 1236 | **563** | 5 |

同一页的排名在实现过程中改过一次，值得记录：**真封面最初排第 479 位**。

## 5. 期间发现并修掉的两个排序缺陷

计划 §7 的信号是"**多来源一致**"。第一版实现成了"来源越多加分越多"，于是同一页 markup 里重复三次的模板值（`a[data-id]`、`i[data-id]`、`div[data-id]`）拿到最高分。**但重复出现恰恰是模板垃圾的特征**：一个值在同一个通道里出现三次不是被印证，是被模板化。改成按**不同通道数**计分后：

- manwa 的 `moon`/`sun`（图标名，靠 markup+inline 才凑到两个通道）从榜首掉下来；`data-id` 那一批直接掉出前列。
- 真封面从第 479 位升到第 1 位。

第二个缺陷是图片**完全没有分数**：只有声明了 `width`/`height` 才有分，而 lazyload 站点两者都不写。45 张图因此全部 0 分、按 URL 字母序排，封面自然沉底。补上两条计划列出的信号：图片自身或其 URL 含 `cover`/`poster`/`thumbnail`/`main`/`detail`（+2），以及文档位置靠前（+2）。

## 6. 诚实的缺口：浏览器路径的排序还不够

iWara 的封面在 1189 个候选里排第 563 位，而榜首是视频分辨率（`360`、`540`）、评论者昵称、**其他作品**的标题——渲染后的页面上确实存在这些东西，而且在 network 通道里它们和本作品的数据长得一样。标题排第 5 位已经可用，封面不行。

这**不是 Phase 2 的失败**：§21 把"归一化 / 去重 / 排序"明确划给 Phase 3，而 Phase 2 的完成标准是 `capture.json` + `candidates.json` 与上述通道，均已达到。它给 Phase 3 留下一个量化的靶子：

> iwara 的封面必须从第 563 位进入前 5。凡是同一响应里属于"相关作品"的元素（`related`、`results[]`、评论、分辨率变体）都必须让位给页面主对象自己的字段。

## 7. 环境与约定

- `builder_sessions/` 是会话产物，已加入 `.gitignore`。
- fixture 里的响应体文件名用 `network_0.json`（下划线）：**Windows 文件名里的冒号是 NTFS 数据流**，`network:0.json` 会写成一个空文件加一条隐藏流。文档名 `network:0` 仍照旧，映射写在测试的 loader 里。
- `tests/check_undefined_names.py` 的扫描范围已扩到 `src/builder/*.py`。
- 全量：141 passed、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# Phase 3 — Normalize / Deduplicate / Ranking

> 执行 `siteprobe-completion-plan.md` §21 Phase 3，验收为计划自己列的四条。
> 另有 Phase 2 留下的一处量化缺口：iWara 的封面必须从第 563 位进入前 5。

## 1. 四条的验收结果

| 计划验收项 | 结果 | 依据 |
|---|---|---|
| 同一 title 多 source 合并 | 达到 | `markup`(og:title / h1) + `jsonld` 合成**一个**候选，列出全部来源；测试断言通道集合为 `{markup, jsonld}` 且来源数 ≥ 3 |
| 同一 cover 多 source 合并 | 达到 | 同一图片的多种尺寸形式合并为一个候选（见 §3），URL 只差 fragment / tracking 参数的也合并 |
| logo / 导航不会永远排第一 | 达到 | 站点导航、页眉、页脚内的文本与链接打上 chrome 标记并扣分；测试断言 `<h1>` 的标题排在 `Login`/`Home` 之前 |
| 能展开看到所有来源 | 达到 | 候选携带全部 `sources[{channel, document, detail}]`；测试断言每个来源都有 document 与 detail |

## 2. 实测

| 站点 / 路径 | 候选 | 真标题排名 | 真封面排名 | 封面在**图片之内**的排名 |
|---|---|---|---|---|
| manwa（markup） | 624 | 2 | 1 | **1 / 45** |
| iwara（`--browser`） | 1237 | **1** | 176 | **4 / 29** |

## 3. 一处措辞上的修正：把图片和文本放在同一个尺度上比较是错的

Phase 2 记下的靶子是"iWara 封面从第 563 位进入前 5"。补完排序后它是 176 位——仍然差得远。但把它拆开看就清楚了：

> **封面在图片之内排第 4 / 29（iWara），第 1 / 45（manwa）。**

也就是说靶子**在它真正有意义的形式下达成了**。176 这个数字来自把所有候选放在一张榜上：一个被多个通道印证的文本值（`title`，13 分）必然压过一张图片（`named_cover` 2 分），可它们并不在竞争同一个字段。计划 §7 要求 UI "按类型过滤"，所以单一混合榜本来就不是正确的呈现，**CLI 已改为按类型分组展示**（`strongest image` / `url` / `text` / `number`）。

这条修正本身是这个阶段最有价值的产出：如果继续追那个 176，就会为了一个不存在的问题往排序里堆特例。

## 4. 排序新增的信号（全部出自计划 §7 的清单）

- **`SCORE_FIELD_KEY`**：路径最后一段是字段名（`title`/`name`/`cover`/`author`/`date`…）而非响应参数。这是"structured data 标准 key"与"API key 稳定"两条。实测效果最大：`title` 从第 5 位升到**第 1 位**，因为此前 `limit`、`numComments` 这些分页参数和标题拿到了同样的分——它们都在本页自己的响应里，同样吃到 subject 加分。
- **`SCORE_SHALLOW`**：值位于该对象顶层（路径深度 ≤ 2）。
- **`SCORE_SUBJECT`**：产生它的响应的地址与本页地址共享同一个 id 片段（`subject_tokens`），即"这个响应讲的是本页这个作品"。
- **`PENALTY_LIST_MEMBER`**：路径经过 `results`/`related`/`comments`/`recommend` 之类的列表键，或数组下标 > 0——它是**别的东西**里的一条。这是 iWara 案例的关键：本作品在 `api.iwara.tv/video/<id>` 的根上，而它的邻居在 `…/related` 的 `results[]` 里，两者形状完全一样，只有路径能分辨。
- **`PENALTY_CHROME`**：站点导航 / 页眉 / 页脚内的内容（复用 Level 0 的 `in_site_chrome`，已提升为公共函数）。
- **`PENALTY_UNKEYED`**：脚本里没有键的字面量——是数据，但没有路径。

`capture.json` 因此新增了 `Document.source_url`：没有"响应自己的地址"，subject 判断无从谈起。

## 5. 同一张图的合并规则

实测的形态：一个页面把同一张照片发成 `…/250px-X.jpg`、`…/960px-X.jpg` 和 `…/X.jpg`，得到三个候选，而它们是一张封面。

合并依据是 **`picture_key`：去掉 resize 留下的标记后，路径段序列必须相等**。去掉的标记包括 `thumb/` 这类插入目录、`250px-` 这类前缀、`-300x400` 这类后缀，以及相邻重复的段（resize 路径会把原文件名再写一遍）。

为什么是"相等"而不是第一版写的"包含"：

- 第一版的包含规则**对我自己举的维基百科例子就不成立**——缩略图路径是插入了 `thumb/` 目录，短路径并不包含在长路径里。测试立刻抓到了这一点。
- 包含关系有误合并风险：`…/a/Photo.jpg` 与 `…/x/a/Photo.jpg` 会被合并。相等关系不会。
- 而必须避免的正是误合并：**安全的失败是留下一个重复候选（人还能挑），不安全的失败是把两个作品的封面合成一个**。所以 `…/book/1/cover.jpg` 与 `…/book/2/cover.png` 除关键段外完全相同，也不合并——这一条有专门的测试。

## 6. 归一化

- 文本比较形：NFKC + 空白折叠 + 去首尾；显示值保留原样（`display_value` 与 `normalized_value` 分开）。
- **实体解码只对 JSON 通道施加**：markup 的文本与属性值已经被解析器解过，再解一次就是本项目已经付过代价的那个 bug（`?w=1&copy=2` 变成 `?w=1©=2`）。有专门测试。
- URL 去重按 `comparison_url`（去 fragment、去 tracking 参数），保留页面上实际书写的地址作为值——那是规则将来要去取的地址。
- 报告里的每条 note 按文档折叠成一行：此前一页里 11 个脚本产生 11 条几乎相同的警告，把真正不同的那些埋掉了。

## 7. 仍未做的

- **图片与文本仍在同一个分数尺度上**。按类型展示解决了呈现问题，但如果将来要在**一张榜**上给出"最可能的字段"，图片需要一个更强的自身信号。已经看到的最有希望的杠杆是：图片 URL 里含有本页 subject 响应中的某个值（iWara 的封面 URL 含 `file.id` 那个 UUID，而该 UUID 不在页面地址里，所以现有的 `subject_tokens` 抓不到它）。
- **`inline` 通道仍是字符串扫描**，位置参数没有路径。需要 JavaScript 求值器。
- **`same_picture` 的域名近似**取最后两段标签，对 `co.uk` 这类会出错。当前只用于判断两条路径是否可比，已写在代码注释里。

## 8. 本轮全量

153 passed（新增 12 个用例）、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# Phase 4 — Annotation UI

> 执行 `siteprobe-completion-plan.md` §21 Phase 4。
> **硬约束（用户明确要求）**：最终一定由 T³ 当操作窗口，因此**完全不允许任何需要用户手动移动文件的方式**。

## 1. 这条约束改变了交付形态

现有工具的规矩是"生成自包含 HTML → 用 `file://` 打开 → 靠浏览器下载把结果交回来 → 用户自己把文件挪到工具能找到的地方"。`review.py` 就是这么做的（`showSaveFilePicker` 优先，`file://` 不是安全上下文所以实际走 `<a download>` 兜底，页面上的提示语就是让用户把文件夹选对）。

**这条路被约束排除了。** Phase 4 因此起一个只在回环地址上的本地服务，让结果直接回到工具手里：

```text
GET  /                 标注页（候选已内嵌，无需二次请求）
GET  /media?c=<id>     某个候选图片的字节，按候选 id 取，不按 URL 取
POST /api/annotations  标注本体；由服务写进会话目录
```

`/media` 只接受**候选 id**而不是 URL，所以这个端点无法被页面变成任意地址的抓取器。绑定 `127.0.0.1` 与操作系统分配的端口，URL 里带一次性 token，避免同机其它页面误投。

这也是与 T³ 汇合的自然形态：T³ 本身就是服务端，标注页到时候由它提供、结果直接进它的流程，不存在"下载再搬运"这一步。

## 2. 做出来的东西

```text
src/builder/annotate.py         字段表、标注→假说的映射、标注页本身
src/builder/session_server.py   本地服务：页面 / 候选图片 / 接收标注
annotate.py CLI                 python annotate.py [--browser] <url> | --replay <session-dir>
```

会话目录（`builder_sessions/<host>/<session-id>/`）：`capture.json`、`candidates.json`、`annotations.json`、`media/`（看过的候选图片就地缓存，所以会话可离线重放）。

**标注产物不是"字段名"，而是可执行的规则**：

```json
{"title": {"candidate_id": "cand_0007", "value": "Quiet Harbor",
           "rule": {"from": "html", "document": "page", "select": "h1", "text": true}}}
```

## 3. 让"选择候选"等于"选择规则"

计划 §14 的映射表要求"最终 adapter 规则应尽量落回当前 selector vocabulary"。为此给 `Source` 加了 `rule`：每个通道在采集时就把读这个值所需的选择器记下来，选择器由 `element_selector` 生成——**id > class > tag**，因为那正是"改版后还剩下什么"的顺序。Phase 1 实测出页面真正需要的规则长得像 `h1.detail-main-info-title`、`img.lazy`，而不是 `h1`。

**关键测试**：把候选自己带的规则交给运行时自己的 `src/generic/select.py:resolve()` 去解析，断言它读得出值。这条走的是适配器将来使用的同一条代码路径——也就是 Phase 6 round-trip 的雏形。

## 4. 期间发现的两个真问题

**一、一条从候选推导出的规则，未必读到它自己那个值。** 测试直接抓到：候选 `One` 带着规则 `{select: "a", text: true}`，解析结果是 `Home`——因为 `a` 匹配页面上每一个链接，而运行时取第一个。

这不是测试的毛病，而是**规则生成的固有真相**：规则是假说，不是答案。计划要求三样本验证与淘汰，正是因为这个。所以把它在采集时就量出来并写进规则：`"matches": N`（本页命中几个元素），页面上对 `matches > 1` 的候选标注"规则会匹配多个元素，需验证"。Phase 5 有了可淘汰的依据，而不是靠人记得。

**二、JSON-LD 的规则不可执行，除非生成的适配器满足一份契约。** JSON-LD 的值是在 markup 里被找到的，但它给出的规则是 `{from: "json", document: "jsonld", path: "name"}`——运行时的 `json` 通道要求那是一份 **JSON 文档**，而 markup 是 HTML。所以：

> **生成的适配器必须把页面的 JSON-LD 块暴露成一份名为 `jsonld` 的 JSON 文档**，否则这条规则跑不起来。

契约写进了代码（`JSONLD_DOCUMENT`）与测试构袋的方式里。这是 Phase 6 要检查的事情之一，现在先把它说明白而不是让它埋着。

顺带修掉一个更隐蔽的同类问题：压缩脚本里的**位置字面量**（没有键的那类）此前会拿到一个假规则 `{from: "json", path: "literal"}`——页面会把它当成"可用的候选"让人选，然后静默读出空值。现在它没有规则，页面显示 `[无可用规则]`。

## 5. collection 候选（§13.1 的前置缺口）

计划 §13.1 明确要求 collection 不能逐个标。此前 Harvester 没有 collection 类型的候选，所以补了 `build_collections`：**任何读到多个值的 selector 都成为一个 collection 候选**，规则是同一个 selector 加 `list: true` 一次读完。

manwa 实测得到 9 组，包括 `li`（章节列表 29 项）、`p.buy-manga-title`（相关作品）、`a`（导航 13 项）。采集端提出**候选组**，人来指定哪一组是 tags——这正是计划的模型。

## 6. 做不到的，以及页面自己会说

- **不能高亮真实页面上的元素，也不能点击拾取 harvester 没抓到的元素。** 那需要在受控浏览器里注入 picker，即被延后的 OpenPicker / `@medv/finder` 那条路。
- 后果是：**正确的值如果不在候选里，这个页面帮不上忙。** 逃生通道是手写规则或补一个采集通道（`inline` 通道的位置参数就还缺）。这句话写在页面上，不只写在文档里。
- 三样本不需要三套 UI，而是同一个页面的三种模式（`annotate` / `confirm` / `validate`），已实现的是第一种。

## 7. 本轮全量

170 passed（新增 17 个用例，含一次真实的 HTTP 往返：GET 页面 → POST 标注 → 断言文件出现在会话目录、且不是下载来的）、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# Phase 5 — Single Work Rule Learner（三样本）

> 执行 `siteprobe-completion-plan.md` §21 Phase 5，对应 §13 的三样本流程。
> 完成标准：Example 1 / 2 / 3 跑通，且能生成 draft `site.json`。

## 1. 一句话：什么让一条假说变成规则

单一标注产出的是**假说**，不是规则。原因是量出来的、不是理论上的——**一条从候选推导出的规则，可能连它自己那一页她都读不对**（Phase 4 实测：`a` 匹配每个链接，于是读到第一个）。

把假说变成规则的，是它**在一个标注从未见过的页面上仍然读到对的值**。

关键性质：**验证完全不需要网络**。三个样本是三个已录会话，规则是在已经在磁盘上的文档里解析的——这正是 `capture.json` 存在的理由，也是这一阶段能在没有浏览器的情况下被测试的原因。

## 2. 三样本的产物

```text
learning.json     每个假说、它的判决、以及判决理由
draft_site.json   幸存下来的规则，写成 runtime 能直接 load 的 site.json
```

判决有三种，第三种是刻意保留的：

| 判决 | 含义 |
|---|---|
| `keep` | 在每一个有期望值的样板上都读到了对的值 |
| `prune` | 在某个样板上读到了错的值、或者什么都没读到 |
| `unproven` | **只有被标注的那一页能检查它**：没有被支持，也没有被反驳。保留，但明确标为未经证实——而不是当成已被两页认可的规则写进草案 |

## 3. 适配器契约：`capture_to_bag`

解析规则需要 runtime 自己的 `DocumentBag`，所以 `capture_to_bag` 把捕获还原成一个——**这同时就是"生成的适配器必须满足什么"的定义**：

```text
page        标记本体
jsonld      页面的 JSON-LD 块，作为 JSON
network:N   每条已录响应体
inline:N    脚本体，当且仅当它能被解析为 JSON
```

`json` 通道读的是 JSON 文档，所以凡是没有以这些名字暴露出来的东西，都没有规则能读到它。不是 JSON 的脚本被跳过——这与"位置字面量没有规则"是同一条理由。Phase 6 要检查的就是生成的适配器是否真的满足这份契约。

## 4. 本轮测出并修掉的五个缺陷（全部由测试直接抓出）

1. **`og:title` 的假说根本没被提出。** `rule_for(candidate)` 只返回一个来源的规则，而计划 §13.2 明确要求**每个字段保留多个候选来源**——同一个标题同时来自 `og:title` 和 `h1`，是另一个页面来决定用哪个的。改为：**候选的每一个带规则的来源各自成为一个假说**。
2. **被标注的那一页在给自己的假说背书。** `creator` 被误判为 `keep`，因为它在样本 1 上"读到了对的值"——而那正是标注本身。加了 `source` 标记把被标注页排除出判决，`creator` 于是正确变成 `unproven`。
3. **封面规则解析出相对路径。** 规则里的 `absolute` 意思是"相对页面解析"，而 `resolve` 需要页面地址在 context 里；没传时读到的是标记里写的 `/media/...` 而不是 URL。
4. **`<meta property="og:title">` 的规则一律写成 `name`。** OpenGraph 用 `property` 声明，运行时的 meta 通道按规则里写的那个属性去查——所以写成 `name` 的规则在真实页面上读不到任何东西。改为按页面实际使用的属性生成。
5. **派生的 URL 模式里多了一个 `/`。** `"/work/x".split("/")` 的首段是空串，会变成一个独立的模式步，产生 `fixture.test//work/x`。由一个本来用来**自检**的测试抓到：Mode 必须匹配它自己来源的每一个样本。

另外补了一个召回缺口：**作者名写在 `<span class="byline">` 里读不到**（`PROSE_BLOCKS` 原先只有 `p/li/dd/figcaption/blockquote`）。计划 §13.1 把 creator 列为标量字段，而署名恰恰常在 `span`/`div` 里——两者已加入，靠条数与长度上限控噪，并且不给它们 heading 或 structured 的加分。

## 5. 三个样本的 fixture

`fixtures/learned_site/{sample1,sample2,sample3}/`——同一个虚构站点的三页，结构相同、作品不同，故意埋了两处差异：

- 第三页把 `h1` 的 class 从 `work-title` 改成 `title`，于是从 class 学到的规则在那里读不到东西，**必须被淘汰并给出理由**；
- `creator` 只出现在第一页的标注里，于是它的规则**必须被报为 unproven**，而不是悄悄晋升为规则。

## 6. 草案的分寸

`draft_site.json` 只写它**从样本推导得出来的东西**：host、目标模式、规则要读哪些文档、字段规则本身。推导不出来的，列在 `_draft.review` 里而不是凭空补上：

```json
"_draft": {"generated_from": ["sample1", "sample2", "sample3"],
           "review": ["the target's other kinds (artist, listing, search) are not derived here",
                      "the export manifest shape is not derived here",
                      "field rules were learned from one kind of page; a listing page is Phase 7"]}
```

而且它被测试**用 runtime 自己的 `load_template()` 装载过**——只产出一份 JSON 不算草案，能被装载器接受才算。目标模式同样有自检：它必须匹配它自己来源的每一个样本，且不能匹配别的路径。

## 7. 本轮全量

183 passed（新增 13 个用例）、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# Phase 6 — Runtime Round-trip（含 confirm 模式）

> 执行 `siteprobe-completion-plan.md` §21 Phase 6，计划称其为"最关键验收"：
> Builder extraction == generated site.json == existing generic runtime extraction。
> 另按要求把 Example 2 的 confirm 模式接进了 CLI。

## 1. 一句话：生成的适配器现在是**配置**，不是另一套系统

声明式读取器放在 **runtime 侧**（`src/generic/declarative.py`），因为生成的适配器若 import builder，runtime 就依赖了自己的创作工具。registry 于是多了一条回退：**站点没有 `fetch.py` 就按 `site.json` 声明式读取**；而 `fetch.py` 存在却导入失败，仍是响亮的错误——回退针对的是模块的**缺席**，不是它的**损坏**。

生成物落在 `local/`（gitignored），按计划 §25：**两个文件、不生成 Python**。

```text
local/<slug>/site.json      规则与文档声明
local/<slug>/adapter.json   这是什么、由什么生成的
```

`registry.tool_roots()` 现在返回两个根：`tool/`（人写的三个）在前，`local/`（生成的）在后。所以"我有哪些站点"仍然指人写的那些，而 `probe.py` 又能直接跑生成的——`discover()` 不带参数时合并两个根。

## 2. 实测：整条链在真实站点上跑通

三个 manwa 作品，全程无文件搬运：

```text
实际日志：第一页标注 → 第二、三页 confirm（假说自动套用）
    served 281906B of annotation page      ← 标注页由本地服务提供
    saved: ...work2\annotations.json       ← 结果 POST 回来

=== what the samples decided
    title  {"from":"html","select":"h1.detail-main-info-title","text":true}
        keep   read the right value on work2, work3
    cover  {"from":"html","select":"img.lazy","attr":"data-original","absolute":true}
        keep   read the right value on work2, work3

=== does the draft read what the runtime reads
    title  agree   runtime=CALL-铃响-
    cover  agree   runtime=https://mwappimgs.cc/static/upload2/book/...
    PASS — 2/2 field(s) agree
    installed ...\local\manwa_me
```

然后**用现有 runtime 在新进程里跑**：

```text
$ python probe.py https://manwa.me/book/104722
site: manwa.me (manwa.me) kind: work
read 1 work document(s)
export  ...\export\manwa.me\sole_work
origin  {"kind":"work","ref":"104722","url":"https://manwa.me/book/104722"}
```

学到的标题规则是 `h1.detail-main-info-title` —— **与 Phase 1 PoC B 独立测出该页面所需的规则一致**。

## 3. 手动验收的入口

```text
生成适配器.bat        拖入或粘贴 1 个 URL，再给 2 个（可回车跳过）
```

一个进程做完：抓取 → 浏览器里标注（第一页）/确认（后续页）→ 学习 → 逐字段与 runtime 比对 → **比对通过才安装**。等价命令：`build_adapter.py --browser --install <url> [<url>] [<url>]`；另有 `annotate.py --confirm-from <目录>` 与 `verify_adapter.py`。

## 4. confirm 模式（Example 2）

`apply_to(reference, capture)` 把第一页的假说套到没标注过的页面上，离线解析（样本是已录会话，规则在磁盘上的文档里解析）。页面为每个字段显示"读到的值"与 ✓/✗；按 ✗ 就重新打开该字段的候选列表。契约相应变为：

```json
{"fields": {"title": "值"},       // 人接受的值——learn 比较的就是它
 "picks":  {"title": "cand_7"},   // 点过的候选，规则从它来
 "verdicts": {"title": "ok"}}     // 仅 confirm 模式
```

服务把 `applied` 与 `picks` 一起交给 `hypotheses()`，所以一个被确认的字段保留了读它的那条规则，不必再问一次。

## 5. 本轮测出并修掉的五个真 bug

1. **草案的 `documents` 声明位置错了**（写在顶层，而 `extract` 从 `documents.work.<name>` 读）——`jsonld` 会被当成 HTML，`json` 规则**静默读到空值**。
2. **`load_session` 仍按候选 id 读 `fields`**——契约改为"值"之后，**真实会话会学不到任何东西**；Phase 5 的 fixture 测试直接构造 Sample 对象，抓不到。
3. **`install` 规范化了目录名却把原始 `tool` 写进 site.json**——加载器按 `tool.<tool>` 解析读取器，两者不一致就是"发现得了、读不了"。
4. **派生的 URL 模式用了非捕获组**——能匹配却取不到 id，runtime 报"没有站点认领这个 URL"，读起来像"未安装"，其实是模式少了一对括号。**实跑才暴露**。
5. **`do_POST` 先回响应、后置 done 标志**——客户端可能先读到回复。这**正是那个偶发失败的成因**（测试读完回复立刻断言该标志）。改为先置标志再回响应；此后连续四次全量运行全绿。

## 6. 生成的适配器：可运行 ≠ 契约完整

把 `manwa_me` 放进 `tool/` 时，项目自己的两个测试会红：一个固定"当前只有三个站点"，另一个套用**完整站点契约**（`naming`、`manifest`、listing 支持）。这是真实状态而不是测试的问题：

> **生成物满足它运行所需的那部分，尚未满足人写适配器的全部契约。**

处理方式是把这两条断言**显式限定到 `DEFAULT_TOOL_DIR`**（人写的站点），并在注释里说明原因——生成物现在住在自己的根里、能被 `probe.py` 跑、且不再影响这些基线。补齐契约段落是后续工作。

## 7. 仍未做

- **请求配方还没派生**：读 `network:N` 的规则一律报 `unrunnable`（读取器支持手写配方，Builder 还不生成）。所以 API 型站点（iWara 那一类）还 round-trip 不了——报出来了，不是漏掉的。
- **confirm 模式尚无专门测试**（页面 UI、服务传递、`apply_to` 的离线解析）。
- 实跑的标注是**脚本提交**的，不是人点的；代码路径相同，但没人手点过一遍。
- 生成物的 `naming` / `manifest` 段落未生成（见 §6）。

## 8. 本轮全量

198 passed（新增 15 个用例）、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# 修正：标注页的封面从来没显示过（Phase 4/6 回归）

手动验收时报告："封面现在没法筛选，因为只显示了图片名，没有图；尝试复制图片地址，也无法选中地址。"

## 根因（两个，都是我的）

1. **页面自己拼 URL，没带 token。** 页面地址是 `/?token=...`，但页面里的图片请求写成 `/media?c=<id>`、保存写成 `/api/annotations`——**都不带 token**。服务对每个请求都校验 token，所以**每一张封面都被 403 拒绝**，而 `onerror` 只把它换成一个空提示。保存按钮同样会 403。
2. **列表里任何点击都会整表重绘。** 行上的 click 处理器在指派字段后调 `render()`，把整个列表重建——于是你刚拉出的选区立刻消失，地址**选不中也就复制不了**。

## 为什么测试没抓到

Phase 4 那个 `/media` 测试是**用「把页面 URL 的 `/` 换成 `/media`」构造请求的**，token 恰好被带上了；真实页面从不这样构造。于是测试验证了一个页面永远做不到的 URL，而套件一直绿着。**这是我这一路上第三次同类错误：断言自己构造的东西，而不是被测系统实际会用的东西。**

## 修法

- **URL 由服务端产出**，写进页面载荷：`save_url`，以及每个图片候选的 `thumb`（`/media?c=<id>&token=<token>`）。服务端才是知道 token 的一方，页面不再自己拼。
- 图片下方**单独一行 `<code>` 显示地址**（可选中、可复制），并给一个 **`打开图片` 链接**（新标签打开，直接看图）。
- 行的点击处理器**跳过落在 `a`/`code` 上的点击**，选中和打开都不会再触发重绘。
- `onerror` 现在显示"图片无法加载"，而不是一个空提示——失败可见。
- 趁此修掉同类的**静默失效**：`ambiguous`（"规则会匹配多个元素"）这个键因为一次引号风格不匹配的替换**从来没进过载荷**，页面读到的永远是 `undefined`，提示从未显示。

## 补的测试（这次走页面自己的数据）

- 从**服务返回的 HTML** 里取出 `const DATA = {...}`，用它里面的 `thumb` 去取图片——真实页面会做的事；
- 同样用载荷里的 `save_url` 提交标注，断言文件被写出；
- 断言每个候选都带脚本读取的**每一个键**（`thumb`、`ambiguous` 都在内）——两个键曾这样无声消失。

---

# 修正：真正的封面从来没进过候选（Phase 2 召回缺口）

手动验收报告："以 iwara 为例，F12 能看到封面应该是 thumbnail 12，但筛选器里各种其他推荐作品的缩略图都有了，偏偏没有 thumbnail 12。"

## 根因（量出来的，不是猜的）

用浏览器抓下该页，`thumbnail-12` 只出现在两处：

```html
<meta property="og:image" content="//i.iwara.tv/image/thumbnail/9813760e-.../thumbnail-12.jpg">
<div class="vjs-poster" style="background-image: url(&quot;//i.iwara.tv/image/original/9813760e-.../thumbnail-12.jpg&quot;)">
```

而页面上 **18 个 `img[src]` 里带 thumbnail 的，全部是别的视频**（相关推荐）。也就是说：

> **这一页真正的封面是 CSS 背景图，而 `harvest_media` 只读 `<img>`/`<source>`。**

计划 §4.6 把 "CSS `background-image`"、"video poster"、"`srcset`" 明确列为媒体通道——**三个我都没有实现**。用户看到的现象因此完全成立：推荐作品的缩略图（真 `<img>`）都在，本作品的封面（背景图）不在。

第二个缺口：`og:image` 只被当作**普通 URL** 候选加入（我的 `looks_like_a_path` 分支），所以**没有缩略图预览**——而封面正是要靠眼睛挑的字段。

## 修法

媒体来源现在覆盖四处，全部出自 §4.6：

| 来源 | 适用元素 | 说明 |
|---|---|---|
| 具体 `src` / 懒加载属性 | `img`、`source` | 原本就有 |
| `srcset` | `img`、`source` | 取第一候选 |
| `poster` | `video` | 播放器的静帧 |
| CSS `background-image` | **任意元素** | 就是它救了这一页 |

并且**声明为图片的 meta 键**（`og:image`、`twitter:image` 等）现在产出 `image` 候选而不是 URL——否则它没有预览、没法用眼睛挑。

**验证时我自己引入又修掉一个回归**：放宽到遍历所有元素后，`script[src]`、`iframe[src]`、`video[src]` 也变成了"图片候选"，而那个 JS bundle 的分数高到能排进真实页面前列。现在 `src` 与懒加载属性只对 `img`/`source` 生效，`poster` 只对 `video`，只有 CSS 背景对任意元素生效。

## 同一页的实测结果

```text
images: 26 (was 32)   total: 1032
image #1  score=6  div[style[background-image]],meta[og:image]
   https://i.iwara.tv/image/original/9813760e-.../thumbnail-12.jpg
image #2  score=2  img[src]      .../image/avatar/...
无 script / iframe 残留
```

本作品的封面升到**图片第 1**，score 6 来自**两个通道一致**（背景图与 `og:image` 合并为一条候选）；其后是头像。用户报告的那个"偏偏没有"消失了。

## 补的测试（5 个）

背景图成为图片候选；`video[poster]` 与 `srcset` 首候选；`script`/`iframe` **不是**图片（把那条回归钉住）；声明为图片的 meta 产出 `image` 候选；非图片的 meta（`og:url`）仍只是 URL。

## 这一轮自己的失误模式

两次都是**测试期望由我编造**而非来自被测系统的行为：一次断言 `srcset` 旁边的 `src` 不该被提供（它也是页面真实声明的图片，丢掉违反召回），一次把 provenance 写成 `poster` 而实际是 `video[poster]`。加上前面三次（无捕获组、meta `name`/`property`、页面自拼 URL），**同一类错误已经出现五次**：把"我以为它该是什么样"写成断言。往后凡是能实测的，一律实测后再写。

---

# 修正：confirm 模式的封面、简介字段、以及"这项本就没有"

手动验收（iwara）报告三条。第一条先实测再改。

## 1. 作品 2/3 读不到封面 —— 真因不是"数字不一样"

用两页真实 iwara 实测，封面候选带着两个来源：

```text
div[style[background-image]]   rule={"attr": "style[background-image]"}   ← 无此属性
   自己页面上 -> None          ← 这条规则在任何页面都读不出东西
meta[og:image]                 rule={"property": "og:image"}
   自己页面上 -> .../thumbnail-12.jpg
   在第二页上 -> .../thumbnail-00.jpg    ← 正是那一页的封面
```

**`rule_for` 取的是第一个来源**，而背景来源排在前面——于是 confirm 模式套用的是一条**永远读不出值**的规则，作品 2/3 的封面因此永远显示"读不到值"。数字不同只是表象：`og:image` 那条规则**不含数字**，跨页正是对的。

修法：**没有基元可表达的来源不带规则**。`srcset` 需要"从集合里挑一个"的基元，`style` 背景需要"从 CSS 值里解析 url()"的基元，runtime 两者都没有——给它一条引用不存在属性的规则，等于给一条在任何页面（包括它自己）都读不出东西的规则。现在这类来源仍然**作为候选出现**（召回不丢），但没有规则，于是 `rule_for` 落到同一候选上真正可执行的 `og:image`，页面也据此标出"无可用规则"。

**副作用（诚实记下）**：若某页封面**只**存在于背景图，则该字段拿不到规则 → round trip 会报失败、不安装。这是真的，不是回归：没有基元就读不了，报出来比编一条规则好。

## 2. 去掉"简介"，并明确自由文本的唯一去处

计划 §13.1 把 description 列为标量字段，我照抄了——但它**没有可注入的地方**。T³ 的导入条目里自由文本只有一个位置：**Entry 的 `body`，与 source url 同级**。所以留一个"简介"字段等于邀请一个库接不住的值。字段已删除，代码里写明了原因。

（将来若要接 `body`，那是在生成 `site.json` 时声明一个 content，而不是在标注页多一个字段。）

## 3. 接受"没有这项"，并且不强迫作答

一个作品不必拥有每个字段：登场人物常只存在于 tags 里（hanime 就是这样），或者只有部分作品声明。此前 confirm 模式只有"正确""错误，我来选"两个按钮，而**两种都不是**——现在有了第三个：「**本作品没有这项**」，它同时是一个有效答案。

语义上最要紧的一点是把**两种沉默区分开**：

| 情况 | 判定 |
|---|---|
| 那一页你标了「本作品没有这项」 | 正常，规则保留 |
| 那一页你**接受了某个值**，规则却读不到 | 规则坏了 → 淘汰（计划 Example 2 要抓的正是这条） |
| 规则连它自己那一页都读不到 | 淘汰——它连被标注的值都复现不了 |
| 规则读到了**不同的**值 | 淘汰 |

所以「接受失败」不等于放弃验证：唯一无歧义的失败信号（读到错的值）仍然淘汰规则，而"这页本来就没有"不再被误判为失败。判决理由会写明是哪一种（`absent on sample2 (no rule needed there)`）。

保存也**不再与任何选择挂钩**：没标的字段不会被记录，「本作品没有这项」同样是记录。

## 4. 本轮全量

212 passed（新增 6 个用例）、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# 修正：字段名映射、以及"简介"的 T³ 侧需求

起因是一个提问："T³ 支持导入 `body`，那简介其实可以保留吧，只是最后匹配的时候对接上就行？"

## 1. 这个问题让我发现自己上一轮的 round trip 查错了东西

用户要求先解释、再按 (b) 对齐。解释过程中我意识到必须**先实测**一件事：`compare` 只断言了"规则能读出一个值"，**没有断言那个值进得了导出记录**。

实测（跑已安装的 manwa 适配器）：

```text
media       {"cover": 0, "previews": 0, "failed": 0}     ← CLI 说零张封面
  title      "CALL-铃响-"                                  ✓ 对
  cover      null                                          ← 规则学到了、比对通过了，记录里却是空
```

**这是载荷性的**：我此前告诉你 round-trip（2/2 agree）通过了，而那个适配器实际上给不了 T³ 封面。**又是同一类错误的第六次**：断言了自己构造的东西（规则可解析），而不是被测系统的产出（记录里有值）。

根因：`extract_work` 按**它自己的字段名表**写记录——`cover_url`、`author`、`date_added`、`works`——而标注的词表是 `cover`、`creator`、`date`、`series`。**不认识的键被静默丢弃**，于是导出看起来像"这页没有封面"，而不像"适配器坏了"。

## 2. 修法：名字映射 + 记录断言

新增 `learn.FIELD_TO_RUNTIME`，生成 `site.json` 时把标注词表映射到 runtime 的名字：

| 标注字段 | runtime 名字 |
|---|---|
| `title` | `title` |
| `creator` | `author` |
| `date` | `date_added` |
| `cover` | `cover_url` |
| `tags` / `characters` | 同名（写进 `分类信息`） |
| `series` | `works`（runtime 的"作品"栏目） |
| `description` | `description` + **声明 passthrough** |

`roundtrip.compare` 因此多了一整半断言：先是 `extract_work` 真的产出一份记录，然后**每个字段的值必须按名字出现在记录里**（`record_carries`：`cover_url` 查 `record["cover"]["url"]`，分类字段查 `分类信息` 对应栏目，其余查同名槽位）。读得到但写不进记录 → 判 `DISAGREE`，理由写明"the record has no 'X'"。

实测确认（真适配器）：

```text
media       {"cover": 1, ...}
  cover url: https://mwappimgs.cc/static/upload2/book/id/104722/cover_1.jpg
  cover local: items/104722/cover/cover.jpg
```

## 3. 简介：site_probe 侧做齐，T³ 侧记录在案

按 (b) 执行，但**不动 T³**。site_probe 侧已完成：

- 标注页恢复 `description` 字段；
- 生成的 `site.json` 在 `work.passthrough` 里声明 `description`——**这一步是必须的**：`extract.py` 对未声明的键一律丢弃，只声明才写进记录；
- 生成物同时产出 `adapter.json` 的 `t3_needs`，把下面的清单随适配器一起交付。

### T³ 侧需要的改动（未做，记录在案）

1. **`apps/server/src/import/site-probe.ts`**：把导出文档里的 `description` 映射到导入条目的 `body`。**必须动这里**，因为 zod 的 `z.object` 会剥掉未声明的键——不改就是静默丢弃。两个分支都要（三个站点的适配函数，以及我为陌生站点加的中立分支）。
2. **提交映射必须声明 `bodyContentType`**：`commit.ts:96` 在收到 `body` 而没有对应映射时**直接抛错**（`Import Entry body has no reviewed Content mapping`）。所以一旦生成的适配器开始产出 `body`，那批条目的导入就**多出一个必填步骤**——这不是代码问题而是流程变化，导入界面/提示需要相应处理。
3. 契约本身**无需改动**：`importEntrySchema.body` 与 `importCommitMappingSchema.bodyContentType` 都已存在（`packages/shared/src/schemas/import.ts:30` 与 `:87`）。

## 4. 本轮全量

214 passed（新增 2 个用例，其中一个是把刚才那个静默 null 直接钉成断言）、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# 修正：无法安装、读错元素的规则、以及冗余

以 gamer.com.tw（ACG 资料页，三个作品）为样本的失败报告。日志里能读出**四个独立缺陷**。

## 1. 阻塞性：`jsonld` 规则被判成"读取器做不到"，于是永远装不上

判定可产出性时我用了 `documents_from(template, "")`——**用一个空页面**去问读取器它能产出什么。`jsonld` 是从页面文本里提取的，空页面自然产不出它，于是**每一条 JSON-LD 规则都被误报 `unrunnable`**（该次运行里 title 与 works 正是这样），round trip 判 FAIL，什么都不安装。

修法：新增 `declarative.producible_documents(template)`，回答的是"这个站点**能有**哪些文档"——`page`、`jsonld`，以及**带 `request` 配方**的声明文档。声明了却无配方（如 `network:0`）仍然正确地报 `unrunnable`。

## 2. "同一位置为什么找不到" —— 根因是选择器退化成裸标签

这是本轮最有价值的一条。日志里：

```text
date   select="li"  matches=166   → 读到的第一个 li 是 '通知'
tags   select="a"   matches=195   → 读到的第一个 a 是 '留下祝福'
```

那些元素**没有 id 也没有 class**，而我的 `element_selector` 于是返回裸标签。裸标签在门户页上命中上百个元素，规则读到的是站点导航——**不是"找不到"，是找到了一条读错元素的规则。**

修法：元素自己说不出名字时，**用最近的、说得出名字的祖先来命名它**。实测效果（同一站点）：

```text
div.seasonACG li(13)   a.sidenav-section__link(13)   div.wikiContent li(57)   ul.ACG-box1listA li(9)
```

不再是 166/195 的裸标签。副作用同样是改进：`div.tags a` 与导航链接**分成两组**，不再混成一个"页面上所有链接"的集合。

## 3. 字段的形状：标量字段不该拿到集合规则

日志里 `creator` 学到的规则是 `{"select": "a", "text": true, "list": true}`——读整个链接组。原因是我选规则时只看分数与 `matches`，**没有看字段需要的是单值还是多值**。

修法：`FieldReport.shaped()` 按字段类型过滤假说——`scalar` 只接受不带 `list` 的规则，`collection` 只接受带 `list` 的。这直接编码了"标题是一个值、标签是一组值"。

## 4. 冗余：验证到什么就用什么，未验证的记名而非否决

按要求放宽：`RoundTrip.ok` 现在是"**至少有一个字段被验证**"，而不是"全部被验证"。未验证的字段（读不到、读错、或需要尚未派生的请求配方）**记名**在报告与 `adapter.json` 的 `unverified` 里，其余字段照常安装——**验证过的字段值得保留，而未验证的字段被指名，不假装它没问题**。

（"取消/返回修改上一个作品"属于 T³ 操作端，未做，按你说的先不管。）

## 5. 另一处改进：站点声明的封面高于它只是展示的图

实测该站点时，真封面（`meta[og:image]` 与 `img[src]` 合并）与占位图 `none.gif` **同为 4 分**、靠排序侥幸分出先后。`og:image` 是站点**声明**"这就是本页的图"，比"页面上出现了一张图"强。加 `SCORE_DECLARED_COVER` 后：

```text
score=6  meta[og:image],img[src]   .../B/ACG/c/56/0000141656.JPG     ← 封面，第 1
score=4  img[src]                  .../none.gif                       ← 占位图
```

两个样本页均如此。

## 6. 未做

- **封面只显示 URL、没有图片**（你的第 3 点）：同意，属展示优化且可在 T³ 端做，未动。
- **取消 / 返回修改**：T³ 操作端的事。

## 7. 本轮全量

214 passed、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# 修正：日期定位不到，以及确认按钮点不动

手动验收第二轮（gamer.com.tw）。两条都是**通用**缺陷，未针对该站点做任何特化。

## 1. 日期定位不到：缺了"类型化"这一步

计划 §3 的流水线写的是 **归一化 → 去重 → 类型化 → 建立来源关系 → 排序展示**，而我只把值分成 `url` / `number` / `text`——**没有类型化**。再加上 `<time datetime>` 这个语义化的日期元素我也没读。所以日期值虽然作为文本候选存在，却和站点导航文本同为 0 分。

修法（两条都是通用的值/结构特征，与站点无关）：

- **按值的形状定型**：`looks_like_a_date()` 认 `2026-04-03`、`2026-09-30T12:00:00Z`、`09/30/2026`、`2026年9月30日`（含带前缀的 `當地首播:2026-04-03`），命中则加 `SCORE_DATE_LIKE`。这正是"类型化"那一格。
- **读 `<time>`**：`datetime` 给机器值、文本给人读值，两个都收，`datetime` 的规则是 `attr: datetime`。

实测同一站点：日期值从"与导航同为 0 分"变为 **score 3、在 370 个文本候选里排第 24/29**——可搜索、可选中（页面上有搜索框，输 `2026-` 即可）。它不会排到榜首，因为榜首是标题与站点名这些高分值，而**标注本来就是人挑**，不是自动决定。

## 2. 确认按钮点不动：把"接受提议"错误地建模成"选中候选"

confirm 模式的 ✓ 实现成"在候选里找一个值**严格相等**的候选"，找不到就把该字段置为 `undefined` —— 于是重绘后按钮再次出现（看起来点了没反应），而保存时 `byId.get(undefined).value` 直接抛错。

根因是概念错误：**工具提议的是一个值外加读它的那条规则**，接受它只需要这条规则，不需要存在对应候选。候选 id 只在"人从列表里点选"时才有意义。

修法：页面状态拆成两份——`values`（人接受的值）与 `picked`（点过的候选 id，仅作来源记录）。✓ 只写 `values`；保存发 `fields: values` + `picks: picked`。**`matching()` 这个按值反查候选的函数整个删掉了**，它本身就是那个错误的化身。

顺带修好了同一处：`absent`（本作品没有这项）此前也依赖 `assigned`，现在同样与 id 解耦。

## 3. 本轮全量

218 passed（新增 4 个用例）、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# 修正：兄弟项里的值无法定位（"日期每次都没找到"）

## 现象与真因

截图显示 `當地首播:2026-10-02` **就在候选里**（搜索 `2026` 的第一条，score 3），它下面那行却写着"**规则会匹配多个元素，需验证**"。

> 值找得到，**读不到**。该页每个信息项都是一个兄弟 `li`，所以规则 `ul.ACG-box1listA li` 命中十三个元素、只读第一个——第一页学到的东西拿到下一页读出来就是另一行文字，于是日期规则每次都被淘汰。这就是"每次都没找到"。

## 修法：这个基元本来就存在，我从没生成过

`select.py` 的 `_apply_filters` 里，`filter` 是一串**正则**，值只有匹配才被保留（`group` 还能顺带截取捕获组）。所以"一堆兄弟项里的一项"本来就可表达：

```json
{"select": "ul.ACG-box1listA li", "text": true, "filter": ["當地首播"], "matches": 1}
```

**锚点就藏在值里**：`當地首播:2026-10-02` 的**标签**部分跨页不变，变的是日期。于是采集时对每一个"规则命中多个元素"的值，若它形如 `標籤:值`，就再给出一条带 `filter` 的锚定规则，并把锚定后真正命中的元素数量记为它的 `matches`。`rule_for` 同时改为优先选命中最少的规则——**能指名一个元素的规则才是规则**。

## 实测（真实站点，两页）

```text
s=141656  當地首播 -> {"select":"ul.ACG-box1listA li","filter":["當地首播"],"matches":1}
              own page -> '當地首播：2026-04-03'
s=147362  同一规则 -> '當地首播：2026-09-30'      ← 第二页自己的正确日期
```

跨页正确，而两页的日期本来就不同——这正是"标签作锚、值随页变"该有的结果。

## 连带的一处观察

页面上的值用全角冒号 `：`，而候选的**归一化值**（NFKC）写成半角 `:`。所以 `resolve` 回来的字符串与候选值**并不严格相等**——这恰好解释了上一轮"确认按钮点不动"为何在日期/简介这类字段上必现：那条路径要求在候选里找到严格相等的值。两处修复是互补的。

## 本轮全量

220 passed（新增 2 个用例）、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# 修复：重建 crawl 状态，并重新同步三个站点的 taxonomy

起因是 `generic_probe/export/`（含全部 `crawl_state.json`）被我用一条未限定范围的 `rm -rf` 删除。补救分两件事。

## 1. crawl 状态：库存从 T³ 取回

抓取器判"已有"看的是磁盘（`runner.py` → `crawl_state.local_work_ids(listing)` → `items/*/metadata.json`）。导出树没了，这个集合就是空的，于是**只能全量重抓**。

修法是让裁剪端**也读记录**：新增 `crawl_state.recorded_ids(site_root, kind, ref)`，`local_work_ids(listing, recorded=())` 返回磁盘与记录的**并集**。并集不会出错，只会更知情——磁盘是"不会漂移"的答案，记录是"磁盘没了还活着"的答案，而两者不会脱节：作品在库里被删时，`site_works` 的行会随 `ON DELETE CASCADE` 一起走。

`repair_crawl_state.py`（新）以**只读**方式打开 `apps/server/.data/library.db`，把 `site_works` 的 514 条身份写回各列表：

```text
database ...\library.db  (opened read-only)
  18comic.vip 118   hanime1.me 134   hitomi.la 262

  18comic.vip   export/18comic_vip   10 listing(s), 118 known work(s)
  hanime1_me    export/hanime1_me     4 listing(s), 134 known work(s)
  hitomi_la     export/hitomi_la     65 listing(s), 262 known work(s)
  → 79 listing state(s) written
```

验证（离线）：现在抓 `hitomi.la/artist/viali` 会跳过 **262** 个作品、抓 `18comic.vip/artist/kakao` 会跳过 **118** 个——即"以后不会重复抓取"。

**列表清单（listing refs）的来源在输出里逐条标注**，因为其中两类是二手的：

| 来源 | 条数 | 性质 |
|---|---|---|
| T³ 的 `site_crawl_sources` | 2（`18comic.vip/artist/kakao`、`hanime1.me/artist/rinhee`） | 一手 |
| hitomi 的 `autolistdone.txt` | 65 个作者名 | 一手 |
| 被删目录树的回忆（hanime 2 个 playlist + 1 个 search、18comic 9 个搜索词） | 12 | **二手**，输出与本节都写明 |

## 2. taxonomy 重新同步

`migrate_site_data.py` 重跑，三个站点的词典与 tag 审核表都回到 `generic_probe/export/<group>/`：

```text
18comic_vip  taxonomy_dictionary.json (53317B)  tag_review.csv (6609B)   author 'kakao': present
hanime1_me   taxonomy_dictionary.json (24625B)  tag_review.csv  (640B)   author 'rinhee': present
hitomi_la    taxonomy_dictionary.json            tag_review.csv          author_list.json
```

每个被覆盖的文件都先留了一份 `.pre-migration`。`character.json` 按既有判断**不迁移**（它是以 `"characters": {` 开头的截断片段，且角色已在词典里）。

## 3. 顺带暴露的设计缺口（已修一半）

**列表清单从来没有被持久化。** `site_crawl_sources` 只在该批次带 `origin` 时才写；更早的抓取没留下"抓过哪些列表"。所以导出树一删，列表清单就只剩回忆。现在状态文件本身会记下每个列表的 `source_kind`/`source_ref`，重建不再依赖记忆——但**这一轮里那 12 条二手 ref 仍然来自回忆**，你要是不认可某一条，改状态文件即可。

## 4. 本轮全量

220 passed、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# 修正：每次生成标注页都要等好几分钟

报告：`agedm.io` 的详情页，Level 0 正常，但 Builder 每个链接都要等很久。日志给出的数字是决定性的：

```text
11431 candidate(s): collection 13, image 16, text 1543, url 9859
```

**近万个 URL 候选**——该页的章节列表有近万条链接。而我对**每一个**元素做了两次全树扫描加一次整页文本查找，于是"每个链接都要很久"完全成立。

## 两处随页面规模放大的计算（都是我的）

1. **`selector_matches(root, selector)` 当场整树遍历**，对每个标题、每个正文块、每条链接各来一次。近万条链接 = 近万次整树扫描，只为算"这个选择器命中几个元素"——而那个答案**只取决于选择器**，同一页上绝大多数元素共用同一个。
2. **`score()` 里的可见性加分**：`candidate.value in visible_text`，其中 `visible_text` 是**整页拼成的长字符串**。一万多个候选 × 约两百 KB 文本 ≈ 十亿次字符比较。

## 修法

1. `selector_matches` 增加**按选择器的记忆**（`harvest_markup` 内共享一个 `counts` 字典）——同一个问题只问一次。
2. 可见性加分改为**查一个集合**：先把页面上真实显示的字符串在**一次遍历**里收成 `set`，候选查集合而不是查整串。语义上更准确（"这个值就是页面显示的一段文字"），且 O(1)。
3. `capture_browser` 记录网络响应时：**先看 `content-length`** 再决定要不要取 body（取 body 是一次往返浏览器的同步调用），并设 40 条的条数上限。
4. **让等待可见**：`serve()` 现在先打印标注页 URL 与"等待提交（Ctrl-C 停止）"，然后每 30 秒打印一次已等待时间。此前提交前一句话都不打印，**"在等 POST"和"卡死了"看起来一模一样**——这正是你遇到"几分钟没反应"的直接原因。

## 实测（同一台机器，同一个采集器）

```text
同一个 6203 候选的合成页面:  harvest 8.0s -> 0.39s      (20x)
树大 5 倍的同一页面:          harvest 1.94s
```

分钟级消失，210 个集成测试与 220 个总用例全绿。

## 仍未解决的一处

**标注页的载荷仍然很大**（该页约 2–4 MB 的 JSON + 最多 400 行、每行走一次 `/media` 代理抓图），所以"页面出现"仍会滞后几秒到十几秒。近万个 URL 候选是**如实保留**的（召回优先；它们本质是重复组，属 Phase 7 的卡片识别），但载荷可以按需分页发送，这留作后续。

## 全量

220 passed、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# 修正：读不到的那些字段——三个通用形状问题

报告：agedm.io 三个作品，标题正常、简介 5 条假说全 keep，但 `creator`/`date`/`tags` 全读出 `日本`，封面与简介被判"不一致"。要求：**不要做站点特化，研究到底什么情况**。

三个根因都是通用的形状/编码问题，与站点无关——这也解释了为什么"每个网站都有各自的找不到"。

## ① 值是"一堆兄弟行之一"：容器+标签的选择器读错了那一行

```text
creator  select="span.detail_imform_value"  matches=11  → 读出 '日本'
date     同上                                          → 读出 '日本'
tags     同上                                          → 读出 '日本'
```

那一页每个字段是一个 `<span>`，十一个兄弟。规则"容器 + 标签"于是读第一个 ✗。我在 gamer.com.tw 那次只加了**值自带标签**（`當地首播:2026-10-02`）的锚点；**这一页的标签是另一个兄弟元素**，所以没有锚点：

```html
<div class="info"><span class="name">制作</span><span class="value">日本</span></div>
```

**页面其实说清了这一行是哪一行——行里有它的标签。** 而 runtime 早就表达得了：`filter` 是正则、`group` 能取捕获组。于是新增 `sibling_label()` + `label_pattern()`：取该元素**前一个兄弟**的文本作标签，用**父行**的选择器取值，`filter: ["制作\s*[:：]?\s*(.+)$"]` + `group: 1` 把值从行文本里截出来。发出前用 `re` **本地自检**捕获结果必须等于该值，否则不发——一条读不到自己那个值的规则比没有规则更糟，因为标注页会把它当选项给人看。

实测（同一形状的合成页，四个字段）：

```text
'日本'        filter=["地区…"] group=1 matches=1  -> '日本'       （裸规则读到 'TV'）
'MADHOUSE'   filter=["制作…"] group=1 matches=1  -> 'MADHOUSE'  （裸规则读到 'TV'）
'2026-07-17' filter=["首播…"] group=1 matches=1  -> '2026-07-17'
'历史'        filter=["标签…"] group=1 matches=1  -> '历史'
```

标签跨页不变，所以这是真正"同一位置、同一规则"的解——新增测试还断言它在**另一页**读出那一页的值。

## ② 值被 NFKC 折叠，而规则读的是页面原文

简介被判不一致，差的是一个全角逗号 `，` vs `,`。原因：我把 `normalize_text`（**含 NFKC**）的结果**当成了值本身**，而规则读出的是 DOM 原文 ✗ 两者永远不相等。

修法：**折叠只用于身份**（去重比较），值本身只折叠空白。新增 `page_text()`，`normalize_text()` 保留给 `text_identity`。这条修完之后，任何含全角标点的字段都不再"永远不一致"。

## ③ 站点双重编码的 URL：候选值已解码，但 meta 规则读回的是编码形式

封面：站点自己写的是 `&amp;amp;`，解析器解一次剩 `&amp;`，而 DOM 属性是 `&`。修法是在 URL 归一化时把残留实体再解一次（`&amp;` 在 URL 里本就是坏地址）。

但**同一候选上仍有一条规则读不回这个值**：`meta[og:image]` 返回属性原文（带 `&amp;`），而 `img[data-original]` 返回解析器解过的（`&`）。**这不修，正是三样本验证要淘汰的东西**——`learn` 拿每条规则去比对接受值，不一致的淘汰、一致的留下。测试因此明确断言"两条规则各读出什么"，而不是假装它们一样。

## 顺带的观察

标题（`h2.video_detail_title`，matches 1）与简介（5 条假说全 keep）本来就没问题——所以这不是"工具坏了"，而是三种特定的形状。三者都是**通用**的：兄弟行、全角标点、双重编码，任何一个站点都可能碰上。

## 本轮全量

225 passed（新增 5 个用例）、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# 修正：把同级的值误当成标签（`creator` 恒为空的真因）

buondua.com 三个作品：标题、日期、封面、tags 都正常，**只有 `creator` 读不到**。问题是通用性的还是这个站点特有的——查下来是两者各一半。

## 真缺陷：`sibling_label` 分不清"标签"和"同级的值"

上一轮我加的"兄弟标签"规则在这一页**误触发**了：

```text
creator  {"select": "div.item-tags.tags", "text": true,
          "filter": ["Fantia\s*[:：]?\s*(.+)$"], "group": 1, "matches": 1}
```

那一页的 tags 是一串同级 chip，所以"前一个兄弟"不是标签名，而是**另一个同级的值**（`Fantia` 是前一个 tag）。它 `matches: 1`，于是 `rule_for` **优先选它**——而它在下一作品上读不到任何东西（那个作品的标签里没有 `Fantia`），于是 `creator` 恒为 `None`。

**它之所以骗过了发出的自检**：在**它自己那一页**上确实能截出值，只有换页才失效。单页自检不可能发现这一点。

通用判据：**前一个兄弟若是 ≥3 个同形兄弟之一，它是同级的值，不是标签。**（agedm 那页的名字/值两两成行 → 判定为标签 ✓ 仍然正确；buondua 的 4–22 个 chip → 判定为同级 ✓ 不再误发。）这也正是"每个网站都有各自的找不到"的来源：误发的规则**恰好最具体**，所以总赢。

## 顺带修掉：图片规则从不记录命中数

`cover_url` 在这轮被判不一致，规则是 `div.article-fulltext img`（读到第 1 张，接受的是第 2 张）。而**图片规则此前没有 `matches`**，所以它既不能与其他规则比具体性、页面上也不会标"命中多个"。现在图片规则与文本规则一样记录命中数。

## 这一半是真·不可学：作者值住在同级里、并且嵌在标题字符串里

该页的 `creator`（`rioko凉凉子`）出现在两处：**标题字符串里**（`Coser@rioko凉凉子: …`）与 **tags 里**。tags 里它是**同级之一**——"哪一个 tag 是作者"是语义问题，结构上无从判别，所以按上面的修复它会正确地变成"没有规则存活"，而不是propose一个错的值。

而标题那一处**是可学的**：runtime 的 vocabulary 里有 `regex {document, pattern, group?}`（计划 §14），一条 `Coser@([^:：]+)` 就能截出作者 ✓。**但 Builder 从不生成 regex 规则**——这是真实的通用能力缺口，不是站点问题：任何"字段嵌在格式化字符串里"的站点都受益于它。列为下一步。

## 本轮全量

228 passed（新增 3 个用例）、AST 检查 exit 0、录制语料回放 327 comparisons / 0 mismatches。

---

# 修正：hitomi 暴露的三个通用缺陷（合并的列表 / 截断的集合值 / 有分歧也叫 PASS）

用户拿 hitomi 做了三个作品，报了三件事：**①作者一直找错；②tag 特别多、页面右侧只显示了一部分，选中它之后下一作品能跟到正确位置，但"录入完整结果就多了很多结构字符"；③验证环节给出的结论与事实不符**。三个都是通用缺陷，没有一处是对 hitomi 的特化。

## ① 三份列表共用同一个 class，被合并成一条规则

hitomi 的真实结构：

```html
<h2 id="artists"><ul class="comma-list"><li><a href="/artist/…">yuuhei</a></li></ul></h2>
<td id="series"><ul class="comma-list"><li><a href="/series/…">bang dream</a></li></ul></td>
<tr><td>Group</td><td id="groups"><ul class="comma-list">…</ul></td></tr>
```

`element_selector` 的次序是"id > class > tag"，但它**只取最近的那个有身份的祖先**：`li` 自己没有 id/class → 最近的祖先是 `ul.comma-list` ✗ → 得到 `ul.comma-list li`，在页面上命中 **3** 个元素（artists / group / series），读第一个 ✗。后果：

- `series` 的候选读到的是**作者** ✗ → 三样本验证 prune ✗ → 系列永远学不到 ✗；
- `creator` 只是**恰好**第一个列表是 artists 才对 ✗（换个页序就读到 group ✗）。

这就是"作者一直找错"的来源：一条规则同时被作者和系列共用。

**修法**：向上找祖先时先找**任何带 id 的祖先**（无论多远），没有 id 才退回最近的 class 祖先。通用理由：id 是文档自己给的唯一身份，class 可以是重复的装饰。修完 `#artists li` / `#series li` / `#groups li` 各自独立。

一个例外是必须的，否则这个改动会**制造**不可迁移的规则：id 里带长数字的（`post-12345`、`comment-99`）是这一页给这一条内容铸的，下一页不存在 —— 这类 id 跳过，用它旁边的 class ✓（这也正是改动之前的行为 ✓，所以那种页面零回归）。这个守卫要同时放在"元素自己的 id"和"祖先的 id"两处：只放一处时，回退分支读回来的仍是同一个坏 id（实测过：`#post-12345 p` 从 fallback 里出来 ✗）。

## ② collection 候选只带前 5 个成员；页面又把值截到 300 字符

`build_collections` 里 `preview = " / ".join(members[:5])` ✗ —— 候选的 `value` 本身就是"前 5 项预览"，而**点击候选 = 把 `value` 录进标注** ✗。于是同一条规则读出全部 16 个 tag ✗ 与刚接受的 5 个不符 ✗，被当作"规则错了"prune 掉 ✗✗。页面上 `c.value.slice(0, 300)` 又把长值砍掉 ✗（29 个角色 ≈ 600 字符）——这正是"只显示了部分"。

另一条路径（接受工具提案）提交回来的是**数组**，而 `Annotation.from_json` 用 `str(v)` ✗ 把它写成 Python 列表的 repr `['a', 'b', …]` ✗ —— "录入完整结果就多了很多结构字符"就是它，而且这个 repr 又反过来让验证"看起来通过" ✗。

**修法**：集合值**全程是列表**。

- 候选携带全部成员（`COLLECTION_JOIN` 一个常量，采集器与页面共用）；
- 页面：集合字段选中即记 `value.split(join)`，显示时 join，字段框与候选行都不再截断；候选超过 400 条时**明说还剩多少条**；
- `Annotation.from_json` 保留类型（列表还是列表）；
- `learn` / `roundtrip` 的比较统一走 `same_members`（成员逐项、保序），报告里 join 成一行而不再出现 repr。

顺带把规则细节（来源行、"规则会匹配多个元素"）折进 `<details>`，默认收起：这是给人看**值**的页面，不是给人看规则的。

## ③ 验证把"唯一能反驳它的那一页"排除在外

`Hypothesis.verdict` 里 `checked` 排除了来源样本自己那一页 ✗，理由是"规则在它自己那页读到自己当然是废话" ✓。但由此产生一个洞：**连自己那页都读不对的规则，不会被任何样本否掉** ✗。hitomi 的 tags 规则正是这样"保活"的（另外两页因为 repr 巧合反而算同意）。

**修法**：来源样本有预期值却与读取不符 → PRUNE，reason 写明"在它自己那页读成了 X，而标的是 Y"。

## ④ 有分歧也叫 PASS

`RoundTrip.ok` 此前是 `bool(self.agreeing())` ✗ —— 4/5 一致、第 5 个两边读出不同值，仍然报 PASS ✗（用户看到的正是这行）。现在 `ok = 有比较结果 且 无分歧`；"无法验证"（unrunnable，例如缺请求配方的 API 规则）仍然不阻塞 —— 那是"留冗余"，不是矛盾。分歧字段单独列为 `disagreed:` 并在 adapter.json 里说明。

## 顺带发现并修掉：生成适配器把整个工装打停

那轮 hitomi 装进了 `local/hitomi_la`，而 `hitomi.la` **已有手写适配器** ✗ → `registry()` 抛 `two site templates claim the key` ✗✗ → **此后每个 URL 都失败**（连三个原本正常的站点也一起停）✗✗。现在：手写优先、生成的那个**跳过并记录** ✓，`probe.py --list-sites` 会明说"生成的那个没在用，它在 …" ✓，`adapter.json` 里写明 `shadowed_by` ✓。

## 实测（三个真实录制样本离线回放，无网络）

修完重放用户那三个 hitomi 会话（只把集合字段换成"规则读到的完整列表"，新页面本来就会这么录）：

```
tags        keep   #tags li         list: true        （修前：prune ✗）
characters  keep   #characters li   list: true        （修前：keep，但两边读数不一致 ✗）
series      keep   #series li                         （修前：学不到 ✗）
round trip  PASS — 7/7 field(s) agree                 （修前：PASS — 4/5，characters 分歧 ✗）
```

## ⑤ 只有两个值的一组，此前根本不成组

用户在页面上选 `series` 时看到的是**两个独立候选**（`bang dream`、`mahou shoujo no majo saiban`），而不是一组。量了三张真实页面：

```
work1（/imageset/，一个集合页里有两个作品）  #series li     2 个成员
work2（一个作品恰好两个角色）                #characters li 2 个成员
work3                                      #lang-list li   2 个成员
```

`MIN_COLLECTION = 3` 是为了不把噪声（导航里的两个链接）当字段 ✗ —— 但它同时也把**合法的两成员集合**挡在外面 ✗：上面 work2 那种"两个角色"的作品**根本没法标成集合** ✗，只能二选一录进去 ✗。而它挡噪声的效果也很有限：同一批页面上本来就有 `div.navbar li`（4）、`h1.lillie`（4）这类被 offer 的噪声 ✓。

**修法**：容器**自己有 id** 时门槛降到 2 ✓，匿名容器仍是 3 ✓。判据与 `element_selector` 优先 id 是同一条：**文档自己命名的东西就是一个"东西"**，不论它有几个成员 ✓（实测三页各新增 1–2 个组，都是真字段 ✓）。

顺带说明：`series` 那两个值**没有唯一答案**，因为 work1 是 `/imageset/`——一个集合页里装了两个作品 ✗。工具不该替人猜哪一个才是"这个作品的系列"✗；通用解法是**把整组当成一个整体标注** ✓（现在这一组在候选里了 ✓），"这一页不是一个作品" 属于 Phase 7 的 listing 范围 ✓。

## 本轮全量

242 passed（新增 14 个用例）、录制语料回放 327 comparisons / 0 mismatches、`probe.py --list-sites` 正常（含被手写适配器挡下的生成适配器提示）。

---

# 修正：18comic 的作者读不到（页面"声明的身份"从未被使用）

用户报告：18comic 其他都正常，**只有作者找不到，而且一直显示 `×`**。

## 真因：值被页面声明了，而选择器只看 class

```html
<div class="tag-block"><h2 class="h2_info">作者：</h2>
  <span itemprop="author" data-type="author">
    <a class="btn btn-sm phone-author-tag btn-primary visible"
       href="/search/photos?search_query=夢宮すばる">夢宮すばる</a>
  </span>
```

`夢宮すばる` 的候选**是存在的** ✓，但它携带的规则只有两条：`a.btn.btn-sm`（70 处共享 → 读第一个 = `剧情` ✗）和 `#intro-block span`（30 处共享 → 读第一个 = `×` ✗✗）。**`×` 就是从这来的**：标注时人点的确实是"作者"那个候选（值对 ✓），可它带的规则读的是另一个 span ✗；而 `rule_for` 按"命中越少越好"排序，于是**提案**每次都给出 `×` —— 用户看到的正是这个。

通用缺口：`element_selector` 只认 id / class / tag，而**页面自己声明了这是什么**（`itemprop`、`property`、`data-type`）却没人看。

## 修法一：声明的属性就是身份

`_self_selector` 的顺序改为 id → 声明属性（`itemprop`/`property`/`data-type`）→ class，并且**每个声明都作为候选变体给出** —— 因为哪一个才有区分力是页面的事：18comic **所有**标签类型都写 `itemprop="author"`（作品 / 作者 / 標籤 全是 ✗），只有 `data-type` 分得开 ✓。

## 修法二：规则必须在"它自己那一页"读到同一个值

只按"命中数最少"挑规则是不够的 ✗。新增 `widening_rules`：主规则 `matches > 1` 时，从**最近的、自己命名的祖先**起给出 `祖先 <tag>` 候选，并**逐个检查它读出来的是不是同一个值**（同页自查；手机/桌面两份同样的块也算通过 —— 读哪份都对 ✓）。文本与 `attr`（封面）走同一套 ✓。

实测（三张真实 18comic 页面，离线，无需任何人工修正）：

```
creator   keep   span[data-type="author"] a     修前：没有 author 字段 ✗，提案恒为 ×
          prune  span[itemprop="author"]        read '原神 GenshinImpact' on work3 …
          prune  a.btn.btn-sm                   read '剧情' on work2 …
          prune  span[itemprop="author"] a      read '原神' on work3 …   ← 前两页它恰好是对的
cover     keep   div.show_zoom img              修前：img[itemprop="image"]（10 处共享）→ 被 prune ✗
round trip PASS — 4/4 field(s) agree             修前：3/3，根本没有 author
```

顺带：同一页的解析**快了 6 倍**（5.7s → 0.9s）——"首个匹配读什么"这次也进了按选择器的缓存，之前每个候选都要重走一遍树 ✗。

另外，用户自己重跑的 hitomi 会话（23:41 那三个）**原样回放、未做任何修正**，现在是 **7/7 PASS**：`tags`/`characters` 是列表（新契约已在真实操作中生效 ✓），`series` 读的是**两个**系列 ✓（正是上一轮"命名容器两个成员也成组"的效果 ✓）。

## 仍未解决

18comic 的 `tags`：三页的标签块标记不一致（work1/2 用 `a.btn.phone-tags-tag`，work3 用 `a.tag`），所以没有一条规则能同时读对三页，按设计被正确丢弃（用户上一轮的结果也是如此）。这是"同站多模板"的通用问题，需要 Phase 7 的 listing 处理或字段级回退，不在本轮。

## 本轮全量

244 passed（新增 2 个用例）、录制语料回放 327 comparisons / 0 mismatches。

---

# 修正：作者指向了 series；以及"只有作品 1 被问过"

用户第二次跑 18comic（新会话 `20260919-235931` / `20260920-000036` / `20260920-000154`）报了两件事。

## ① 作者还是不对，而且指向的是 series 的位置

`applied from …: creator=ブルーアーカイブ`（第 2 页）/ `creator=原神`（第 3 页）—— 提案读到的是**作品**块的第一个值。

根因：`span[itemprop="author"] a` 与 `span[data-type="author"] a` **在它自己那一页上无法区分** —— 两者的匹配都只读到作者 ✓（第 1 页恰好没有作品块）。上一轮我加的检查只问"第一个匹配读什么" ✗，于是两条都通过 ✗，`rule_for` 按命中数并列后**按出现顺序**取胜 ✗ → 用的是 `itemprop`（18comic 给所有标签类型都写的那一个 ✗）。第 2 页它的第一个匹配是作品块 → 提案就是 series ✗。

三处修法：

1. **每个匹配都要读同一个值**（不再只看第一个 ✗）。同页自查因此变强：手机/桌面两份同样的块仍算通过 ✓，但"两个匹配里有一个是别的字段"就不算 ✓。
2. **同一祖先的多个命名，容器更具体的胜出**。两条规则读起来一样时，`span[itemprop="author"]` 命中 **6** 个块、`span[data-type="author"]` 命中 **2** 个 —— 容器数量才是区分信号 ✓。
3. **读了不同值的规则，永远不进产物**（`conflict` 标记）：标注规则排序时排最后 ✓，`chosen_rules` 直接丢弃 ✓（宁可这个字段空着，也不把别的字段的值装进去 ✓）。

## ② 作品 1 没填的字段，作品 2 填了，作品 3 却什么都没被学

用户的判断是对的：`learn()` 只从**第 1 个样本**取答案与候选 ✗ → 第 1 个作品没有 `登場人物`/`系列` ✗ → 这两个字段**从未被学过** ✗✗；而页面上给第 3 页的提案同样只来自第 1 页 ✗。

修法：**哪个样本回答了这个字段，就由那个样本提供规则** ✓；提案则合并"此前所有样本的答案"（先答者优先 ✓）——`build_adapter.py` 因此把 `directories` 全部传下去 ✓（日志也从 "applied from the first page" 改成 "applied from the pages before this one" ✓）。

## ③ 顺带：没被回答过的字段，不能算"一致"

第 ② 条一改就暴露出来：第 1 个作品没填的字段，`compare()` 会走到"两边读得一样但无可比对象"的分支并判 **agree** ✗ —— 一个读别的字段块的规则就这样被报告为"验证通过" ✗✗。现在这种字段判 **unchecked** ✓（既不冒充一致 ✓，也不阻塞安装 ✓）。

## 实测（用户那三个新会话，原样回放）

```
提案   第2页 creator -> ぽみ太          （修前：ブルーアーカイブ ✗）
       第3页 creator -> 古江みみ          （修前：原神 ✗）
规则   creator  keep  span[data-type="author"] a     （修前：itemprop 那条 ✗）
       series   keep  a.btn.phone-work-tag  list:true  （第 2 页答的，现在学得到 ✓）
       characters 丢弃（conflict ✓）—— 宁可空着，也不装别的字段的值 ✓
回放   PASS — 3/4 agree（works 判 unchecked ✓）
```

## 仍未解决

18comic 的 `登場人物`：每个角色 chip 只共用祖先 `span[data-type="characters"]`，而 `build_collections` **只按成员自己的选择器分组** ✗（这些 chip 自己的选择器是 `a.btn.btn-sm` ✗，混了各种标签块）→ 于是学不到 ✓ 按设计丢弃 ✓。通用修法很清楚：**分组时也要用祖先的声明属性**（`span[data-type="characters"] a` + `list: true` ✓），并且"命名容器 2 个成员也成组"的门槛判据要从"含 `#`"扩展到"含声明属性" ✗ 目前只认 `#`。这是下一轮该做的第一件事。

## 本轮全量

245 passed、录制语料回放 327 comparisons / 0 mismatches。

---

# 修正：登场人物与作品学到的是同一个块（`原神`）

用户第三次跑 18comic：`登场人物` 与 `作品` 学到的都是 `原神`（作品块的值）。

## 真因：页面把块声明了两次，而值只看第一个声明

18comic 的一个 span 同时写着 `itemprop="author"`（**所有**标签类型都写 ✗）和 `data-type="actor"`（只有登场人物块写 ✓）。`_self_selector` 返回**第一个**声明 ✗，所以登场人物块的自己的文本，规则是 `span[itemprop="author"]` ✗（6 处共享 ✓ → 在别的页上读到的正是作品块 ✓ = `原神` ✓）。而补齐用的 `widening_rules` **只往祖先走** ✗，从来不看元素自己**另外的声明** ✗✗。

三处修法（都是通用的，无站点特化）：

1. **元素自己的其他声明也试** —— `widening_rules` 从"元素自身"开始，再到祖先 ✓（`node is element` 时候选取 `naming` 本身 ✓，否则 `naming + tag` ✓）。于是 `span[data-type="actor"]` 作为登场人物块的规则被给出 ✓，两处匹配读到同一个值 ✓ → 通过 ✓。
2. **`rule_for` 不再提案"已测得读错值"的规则** —— 这类规则仍然**记录**在候选里 ✓（三样本验证要用它、页面也该知道它在 ✓），但不当提案 ✗。这一条直接堵掉 `×`、`剧情`、`原神` 这一类"提案别的字段的值" ✓。
3. **声明了的块，自己的文本也作为值** —— 此前只有标题、正文块、链接、`data-` 属性会进候选 ✗，`<span data-type="actor">美甘寧瑠 美甘妮露</span>` 这种**纯文本块**从来不是候选 ✗ → 登场人物只能从块内 chip 的共享 class 去学 ✗。现在凡是带声明属性的元素，其文本都进入候选 ✓（带 chrome 判定 ✓）。

另外：`group_rule`（"整组作为一个值"的那条规则 ✓）只在**声明属性**上生效 ✓，不再用 class 或 id —— 否则 `#wrapper`（页面上百个链接 ✓）会被当成一个字段 ✓。分组时每个成员**每组只算一次** ✓（同一选择器出现两次不会算两个成员 ✓）。

## 实测（用户三个新会话，原样回放）

```
creator     keep      span[data-type="author"]            提案 第2页 ぽみ太 / 第3页 古江みみ ✓
characters  unproven  span[data-type="actor"]             提案 第3页 芭芭拉 空 ✓（修前：原神 ✗）
series      unproven  a.btn.phone-work-tag  list:true
draft       title / author / date_added / characters / works
```

注意一处需要说明的事实：18comic 的 **作品与系列本来就是同一个声明块**（`data-type="works"` = 作品 = 该作品所属系列 ✓），所以"作品读到 `原神`"不是错读 ✓——它是那一页的 作品 值 ✓。真正错读的是**登场人物** ✓，现已修正 ✓。

## 本轮全量

245 passed、录制语料回放 327 comparisons / 0 mismatches。

---

# 回归修正：封面变成"无可用规则"

用户报告：封面候选显示 `无可用规则`，下一个作品也学不到——"之前的版本都没问题"。

**是我上一轮引入的回归。** 我把"**每一个**匹配都必须读到同一个值"这条检查套用到了**所有**规则上 ✗，而封面规则的语义本来就是"读第一个"：`div.show_zoom img` 命中 4 张不同的原图、读第一张 ✓ —— 这是对的 ✓。被毙掉之后，封面上只剩一条共享声明 `img[itemprop="image"]`（10 张图 ✓），而它因为 `conflict` 又被跳过 → 一条都不剩 → `无可用规则` ✗✗。

**修法**：那条"所有匹配一致"的检查**只适用于文本值** ✓。地址/媒体规则仍用"第一个匹配读到这个值"——也就是回归之前的行为 ✓（`_flag_conflicting_rules` 与 `widening_rules` 两处都区分 `attr` 规则 ✓）。

实测（用户最新三个会话）：`cover` 重新得到 `div.show_zoom img` ✓；第 3 页的提案七项全对 ✓ —— 封面 URL ✓、登场人物 `芭芭拉 空` ✓、作者 `古江みみ` ✓、系列 ✓、tags ✓、标题 ✓、日期 ✓。

一处如实说明：那一轮用户只填了第 1 页（work2/work3 空着 ✓），所以这七个字段都是 `unproven`（可用、但没有第二页交叉核对 ✓）——多填两页就会转成 keep 或被否掉 ✓。

---

# 全量验收（18comic 验收通过后）

用户宣布 18comic 验收完毕、暂不再测更多站点，要求对改动后的版本跑一次全量。跑了仓库自己的两道门禁，外加这次改动可能碰坏、而门禁没覆盖的部分：

| 检查 | 结果 |
|---|---|
| `.venv/Scripts/python.exe -m pytest -q` | **245 passed** |
| `verify_against_recordings.py`（真实录制页面） | **PASS — 327 comparisons / 0 mismatches** |
| 全部模块导入（66 个：根 CLI + `src/**` + `tool/**`） | 全部导入成功 ✓ |
| Builder 离线全链路（accepted 那次运行的副本：`learn.py` → `draft_site.json` → `verify_adapter.py`） | `learning.json` 含 7 个字段 ✓、round trip **PASS — 6/6 agree**（含 `characters`/`works`/`cover_url`）✓ |
| 三个手写站点加载 + 目标解析（hitomi·work、hanime1·work、18comic·album） | 全部 ✓ |
| 生成适配器不再让工装停摆 | 两个生成适配器被报为"未使用" ✓、不再抛错 ✓ |

两处如实说明：

1. **hitomi / hanime1 的录制语料现在是 0 works** —— 它们的录制文档在更早那次误删里丢了（已记在案 ✓），所以这两个站点的"runtime vs golden"逐字段对比这一轮**没有**被执行 ✗（适配器仍能加载并解析 URL ✓，且本次改动没有碰站点层 ✓）。18comic 的 21 部作品仍在参与对比 ✓。
2. **T³ 的最终门禁这一轮跑不通**，原因定位到一行，且**与本次改动无关**：

```
pnpm import:site-probe <18comic_vip>/output/v2_dry_run/items/122916/metadata.json
→ Error: Unsupported site_probe export format

原因：文档里 cover.local_path = null，而 T³ 的
      apps/server/src/import/site-probe.ts:32 是
      local_path: z.string().min(1).optional()    // null ≠ undefined → 整个 item 解析失败
```

本次改动只碰了 Builder 与 `registry`/`cli` ✓，没有碰导出写入方（`tool/comic18/`、`extract.py`、`export_layout.py` 均未修改 ✓），所以这是导出物与 T³ schema 之间的既有错位 ✗。两种修法各一行：T³ 侧 `.nullable().optional()` ✓，或导出侧不写这个键 ✓。属于 T³ 仓库的取舍，未擅自改动 ✓。

## 本轮全量

245 passed、录制语料回放 327 comparisons / 0 mismatches。

---

# Phase 7 开始：列表页的重复 card（§16 Card Detection）

先读契约，得到一个决定整阶段的结论：**运行时读列表页时，把"一行"当作整个文档**（`extract.read_listing`：每个字段规则作用在一行上，"listing 字段与 work 字段用的是同一套选择器词汇" ✓）。因此：

> **一张 card 就是一个小作品页。** 把它从页面里抬出来、当作文档交给采集器，现有的候选采集、标注页、规则学习、三样本修剪**全部原样复用** —— 不需要第二套词汇，也不需要第二个 UI ✓。

这也决定了本阶段的形状：harvest/annotate/learn 那一套不动 ✗，新代码只负责"**找出重复结构**"和"**把一张 card 抬出来**" ✓。

## 新增 `src/builder/cards.py`

* `find_card_groups(root, minimum=3)` —— 按"同形兄弟"分组，并且**看两级**：响应式布局会把卡片两两包进行里 ✗，此时卡片不是兄弟、行才是 ✓，只看直接子元素会找到三行而不是十二个作品 ✗。每张卡片必须同时有**链接和图片** ✓，否则导航、标签云、页脚都会被当成卡片 ✗（实测真实收藏页的 `ul.pagination` 正是这一类 ✓）。输出 `selector / count / container / hints(url,title,cover,id) / score` ✓；被保留组**内部**的重复（卡片里的标签列表 ✗）直接丢弃 ✓。
* `to_html(element)` —— `htmltree` 没有序列化器（树是只读设计 ✓），这一阶段第一次需要把片段写回 markup ✓（void 元素不加闭合 ✓、属性与文本转义 ✓）。它是"把 card 当作页面"的前提 ✓。
* `card_page(group, page_url)` —— 一个 `Capture`，唯一文档就是这张 card 的 HTML 片段 ✓，并注明"这里每条规则都是相对于一行的" ✓。

## 测试 `tests/test_cards.py`（7 个用例）

列表页找到并命名卡片 ✓、**导航/页脚不算卡片** ✓、**行内卡片仍是一组** ✓、卡片能被采集且规则是相对的 ✓、片段写回可重新解析（`&`、引号、void ✓）、真实收藏样本（`18comic_vip/samples/favorite_page.html`，2 张卡片 ✓ 用 `minimum=2` ✓）、卡片页标注自己为行内作用域 ✓。

一处如实记录：**卡片自身的规则会出现在候选里**（卡片是 `<li>`，而 `<li>` 属于正文块 ✓），而它在行内**什么也选不到** ✗ —— 这条必须由下一步的 listing 学习拒掉 ✗，测试里已注明 ✓。

## 本阶段剩余（下一步）

1. **卡片标注**：复用现有标注页 ✓，字段语义换成 url/id/title/cover ✓，并**拒绝命名行本身的规则** ✗；
2. **分页学习**（§17：URL page 参数 → next 链接 → 页码列表 ✓；load-more/无限滚动标记为未支持 ✓），验证用"**本页无新增 id**"而不是只看 next 标记 ✓；
3. **草稿的 `listings` 段** + 与运行时 listing 路径的离线往返 ✓；
4. 一个真实列表页的端到端（需要用户提供一个列表页或跑一次 `build_adapter.py --listing` ✓ —— 磁盘上唯一的"真实列表页"只有 1KB 的测试样本 ✓，真实抓取属于用户的验收动作 ✓）。

## 本轮全量

252 passed（新增 7 个用例）、录制语料回放 327 comparisons / 0 mismatches。

---

# 多值字段的拆分（tag、角色这类要去掉空格、逗号）

用户提醒：这类含复数信息的字段要做提取 ✓。

**第一次做错了**，错得值得记：我在**采集时**按值的形状给"看起来是列表"的文本加了一个拆分候选 ✗ —— 结果每个含空格的字符串都变成集合 ✗（`Only One` ✗；含全角逗号的一句话也被拆 ✗，而后者正是解析器测试专门保护的值 ✗）。**"这个字符串是不是列表"无法从字符串自身判定** ✗ —— 与"作者值住在同级里"是同一条教训 ✓。

**正确的位置：拆分是字段的属性，不是字符串的属性** ✓。知道"这是 tags / 角色"的只有两个地方：标注（人把某块标成角色 ✓）与学习（`learn` / `apply_to`，那里按字段 kind 知道 ✓）。

实现：

* 运行时新增 `split_members`（公开 ✓，即 `transform: ["split"]`）：逗号（半角 / 全角 / `、`）✓、分号 ✓、斜杠 ✓、竖线 ✓、空白 ✓；**输入是列表时逐项拆并展平** ✓（`list: true` 与拆分组合才有意义 ✓）；旧的 `split_csv` 保留 ✓。
* `learn`：集合字段的答案若写成**一个字符串**（≥2 个成员 ✓），这条假设的规则自动带上 `transform: ["split"]` ✓，于是**规则产出的正是人接受的那些成员** ✓；比较时也按成员逐项对齐 ✓（`_as_members` ✓）。**标量字段一字不动** ✓。

实测：`美甘寧瑠 美甘妮露` → 两个角色 ✓；`a, b、c；d` → 四项 ✓；`['x y', 'z']` → 三项 ✓；而 `Only One` 与含全角逗号的句子**不再**变成集合 ✓。

# Phase 7 核心：listing 规则与分页（`src/builder/listing.py`）

契约读自三个手写站点 ✓：`listing.document` / `row_selector` / `fields`（`source_id`、`title`、`cover_url`、`date_added`、`author` ✓）/ `listings: {<kind>: …}` ✓，而 `source_id` 的写法就是从卡片链接里正则取 id ✓（`{"select": ["a[href]"], "attr": "href", "filter": ["/album/(\\d+)"], "group": 1}` ✓）。

* `LISTING_FIELDS` ✓ —— 用运行时已有的字段名 ✓ → 生成的 listing 规则与手写的同形 ✓ → 现有 review / selection 可直接消费 ✓（§2.3 第 8–10 条 ✓）。
* `id_rule_for(href)` ✓ —— 从地址自身的形状把数字变成捕获组 ✓（不需要知道什么叫 album ✓）。
* `rule_from(group, fields)` ✓ —— 卡片的 selector 成为 `row_selector` ✓；**命名行本身的规则被丢弃并计为缺失** ✓（行内它什么也选不到 ✓）。
* `pagination_from(pages)` ✓ —— 按 §17 的顺序：URL page 参数 ✓ → `rel=next` / next 链接 ✓ → 页码列表 ✓；**load-more / 无限滚动判为 unsupported 并说明需要自定义 fetcher** ✓；只采到一页也明说 ✓；`pages_sampled` 记下来，免得"两页"冒充"多页" ✓。
* `listing_draft(...)` ✓ —— `targets` + `listings` + `documents.listing` ✓（与 work 草稿同形 ✓）。
* `cards_as_read_by_the_runtime(...)` ✓ —— 走**运行时自己的** `extract_listing_page` ✓（不是私有副本 ✓，否则那是排练不是验收 ✓）。

## 验收（离线，fixture）

`tests/test_cards.py` 7 个 + `tests/test_listing.py` 10 个 ✓。其中最重的一条：**运行时读出的卡片 = Builder 标注的卡片**（id `1/2/3` ✓、标题 ✓、封面 ✓、`page_param` ✓）。

## Phase 7 还差一件（唯一）

**交互入口**：`build_adapter.py --listing`（抓列表页 → 选一组卡片 → 用现有标注页标一张卡 ✓，字段换成 url/id/title/cover ✓ → 拿同页其它卡当样本 ✓ → 生成草稿并安装 ✓）。机制全部就位 ✓（`card_page` → `harvest` → 标注 → `learn` → `rule_from` → `listing_draft` ✓），差的只是把这条链接起来的那约 100 行，以及让标注页接受一份**字段清单**（现在它硬编码 work 的字段表 ✓）。

还有一条 listing 专属检查要一并加上：同页的其它卡片作为样本偏弱 ✓（近乎同构 ✓），所以规则必须**在每张采样卡上都读到值、且 id 互不相同** ✓ —— 一个在所有卡上都读到同一个 id 的规则是坏的 ✓，这一条目前还没有 ✓。

## 本轮全量

262 passed（新增 17 个用例）、录制语料回放 327 comparisons / 0 mismatches。

---

# Phase 7 完成（交互入口 + 三个"缺的翻译"）

**交互入口 `build_listing.py`** ✓：抓第一页（后续页只用于核对 ✓）→ 列出候选卡片组 ✓（`--card=N` 选哪一组 ✓）→ 把选中的那一张抬成独立页面 ✓ → 用**同一个标注页**（字段清单换成 listing 的 ✓）→ `learn(fields=LISTING_FIELDS)` ✓ → `listing_rules` ✓ → `card_rule_for_id` ✓ → `rule_from` ✓ → `check_over_cards` ✓ → `listing_draft` ✓ → `install` ✓ → 最后用**运行时自己的** `extract_listing_page` 把同一页读一遍 ✓（计划验收的第三条腿 ✓）。页面的种类由人声明（`--kind=` ✓，§15.1 ✓），Builder 不猜 ✓。

写这个入口时暴露出三个**缺的翻译** —— 都是措辞层面的翻译 ✓，选择器词汇、字段名、读取器全部是运行时的 ✓：

1. **行的前缀必须去掉。** 卡片片段里卡片自己就是根 ✗，于是规则长成 `li.card h3` ✗ —— 行内它什么也选不到 ✓（行本身就是那个元素 ✓）。现在剥掉前缀 ✓，只剩前缀的规则直接丢弃 ✓（与"命名行本身的规则不上线"是同一条 ✓）。
2. **选择必须发生在剥离之后。** 同一个标题会被给出两条规则（`li.card` = 卡片自己的文本 ✗、`li.card h3` ✓），先选后剥会把好的那条丢掉 ✗（实测如此 ✓）。`listing_rules` 先按学习者的顺序排 ✓，再挑第一条能存活到行内的 ✓。
3. **`document` 名要跟着行走。** 卡片页里它叫 `page` ✗，listing 里叫 `listing_html` ✓ —— 不改的话规则去找一个读取器从未产出的文档 ✗，于是"在每张卡上都读不到" ✓（实测报错的第一条正是它 ✓）。

另外加了 `card_rule_for_id` ✓：人标的是卡片上的**链接** ✓（那是页面上看得见的东西 ✓），而 listing 的 `source_id` 是链接里的编号 ✓ → 规则收窄成 `filter` + `group` ✓，与三个手写站点同形 ✓。

**`check_over_cards`（listing 专属检查）** ✓：行选择器在某页选不到 ✓、字段在某张卡上读空 ✓、**id 不互不相同** ✓（同页重复 ✓ 与跨页"本页无新增 id" ✓ —— 计划 §17 的终止条件，用在卡片上 ✓）。

## 验收

`tests/test_listing.py` 15 个 + `tests/test_cards.py` 7 个 ✓。其中两条是这一阶段的支点：

* `test_a_marked_card_becomes_the_rule_the_runtime_reads` —— **无浏览器**的端到端：抬卡 → 采集 → 标注 → 学习 → 行内规则 → 检查无发现 ✓；
* `test_the_runtime_reads_the_cards_the_builder_marked` —— 第三条腿：运行时读出 id `1/2/3`、标题、封面，`page_param` 也对 ✓。

## 未验证的部分（如实）

* `build_listing.py` 的**网络路径没跑过** ✗ —— 磁盘上没有真实列表页 ✓（之前那个 1KB 的是测试样本 ✓），第一次真实运行仍是用户的验收动作 ✓；
* 分页只用了 fixture ✓ —— 真实站点上 page 参数 / next 链接的写法会有差异 ✓（`unsupported` 分支已覆盖"按钮/无限滚动"✓）。

## 本轮全量

267 passed（新增 22 个用例）、录制语料回放 327 comparisons / 0 mismatches。

---

# Phase 7 第一次真实列表页运行：卡片识别对了，规则选择错了

用户用 hitomi 的 artist 列表页跑通了整条链（`div.dj`，24 张卡 ✓，hints url/title/cover/id ✓），暴露两件事：

1. **一个崩溃**：CLI 调 `draft_base` 时多传了一个参数 ✓（一行 ✓）。
2. **规则选择的依据错了** ✗。学到的规则是 `a.lillie`（被标那张卡的链接 class ✗）——它**只存在于 24 张卡中的 1 张** ✗，于是 23 张读不到、id 全空 ✓。`check_over_cards` 把这件事报了出来 ✓（这正是它存在的意义 ✓），但**选择规则的地方没有用这批卡片** ✗：它用的是学习者的顺序 ✓。

**修法**：
* `listing_rules` 接收采样页 ✓，对每条候选按**实测**打分 —— 能读到的卡片比例 ✓，以及（对 `source_id`）读到的值里**互不相同**的比例 ✓ —— 取最优 ✓；`source_id` 若没有一条能做到 id 互不相同 ✓，**直接不装** ✓（装一条"永远爬同一页"的规则比缺一个字段更糟 ✓）。
* 新增 `_tag_only` ✓：同一个元素**只用标签命名**的版本也参选 ✓ —— 卡片中有一张布局与众不同时（实测就是如此 ✓），手写站点给这个字段写的正是这种规则 ✓，而哪条更好由卡片实测决定 ✓，不由这个函数决定 ✓。
* 一处真 bug：测量发生在 `document` 改名**之前** ✗ → 每条规则都在找一个读取器从未产出的文档 ✓ → 全判 0 分 ✓ → 好的规则被当成空规则丢弃 ✓。`_inside_the_row` 现在一并改名 ✓。

**另一件事**：`build_listing.py` 原本在**看到卡片组清单之前**就问"选第几组" ✗ —— 改成先列清单 ✓，只有一组时不再问 ✓，多组时才问 ✓；`生成列表适配器.bat` 同步去掉了那个提示 ✓。

实测（fixture 里造了一张"和邻居不一样"的卡 ✓）：`source_id` 现在选中 `a` ✓（每张卡都读到 ✓、id 互不相同 ✓），class-only 那条落选 ✓；`check_over_cards` 无发现 ✓。

## 本轮全量

268 passed（新增 1 个用例）、录制语料回放 327 comparisons / 0 mismatches。

## 仍未验证

真实 hitomi 列表页上的**重跑**（需要用户再跑一次 bat ✓ —— 标注会重新做 ✓）；`div.dj` 那 24 张卡里第一张确实是不同布局 ✓（从这次结果看出来的 ✓），重跑后 `source_id` 应落在"每张卡都读到"的那条规则上 ✓。

---

# Phase 7 在真实列表页上验通（hitomi artist 页）

用户跑了第二次，我用**他标注的答案** + 浏览器抓的真实两页（144KB / 143KB）把整条链重跑了一遍，修掉两个真 bug：

1. **id 规则不能带 `absolute`** ✗ —— `filter` + `group` 已经把地址缩成纯数字 id ✓，再 `absolute` 就把它对着页面 `urljoin` 一次 ✗ → 每个 id 变成 `https://hitomi.la/artist/3547173` ✗，而且**每个都不同** ✗，于是"值是否互不相同"这条检查被骗过去了 ✓（它报告没问题 ✓）。三个手写站点从不把两者写在一起 ✓，生成器现在也不 ✓。
2. **id 的 filter 不能用整条地址** ✗ —— 之前把数字周围的整段 path 都 escape 了 ✓，只可能匹配它自己那张卡 ✓（hitomi 的作品地址里带着作品标题 ✓）。现在按最短上下文生成 ✓：hitomi 式 slug → `-(\d+)\.html` ✓；路径段本身是 id → `/album/(\d+)` ✓。
3. **`source_id` 的选择现在也看值的形状** ✓（同 host + 同第一段路径 ✓）—— 在"填充率"和"互不相同"之外再加一条 ✓，因为 tag 链接与作品链接两者都填充、都互不相同 ✓（实测正是如此 ✓）。

## 实测（真实两页，浏览器抓）

```
page 1   24 张卡 / ids 24 个互不相同（4200450, 4035909, 4015160 …）
page 2   16 张卡 / ids 16 个互不相同
每张卡   标题 ✓ 封面 ✓ 日期 ✓ 作者 ✓（24/24、16/16）
检查     check_over_cards 无发现
分页     url_param, page_param=page
```

## 两个操作事实（记下来）

* hitomi 的 artist 页**必须用浏览器抓** ✓ —— 非浏览器路径拿到的是混淆 JS 外壳（26KB、0 张卡 ✓）；bat 里的 `--browser` 是必需的 ✓。
* 会话目录里的 `capture.json` 是**卡片片段**（学习需要它 ✓），不是整页 ✓ —— 想复核整页要另外保存 ✓。

## 本轮全量

269 passed（新增 1 个用例）、录制语料回放 327 comparisons / 0 mismatches。

---

# 列表页的两处重复结构：都可能是列表

用户问 hitomi artist 页上的 `div.imageset`(20) 与 `div.acg`(5) 是什么 ✓。量出来：前者是**图片集**（链接 `/imageset/…` ✓），后者是 **CG 作品**（链接 `/cg/…` ✓）—— 同一页把画师的作品按类型分成两块 ✓，只选一块就漏掉另一块 ✓。

* **显示改成说人话** ✓：不再打印选择器 ✗，而是**每组第一张卡的内容**（标题 / 链接 / 封面文件名 ✓）加一句建议（卡片最多的一组 ✓）；选择器移到 `--verbose` ✓。理由与之前一致：选择器是工具的词汇 ✓，人不需要知道 `acg` 是什么 ✓。
* **支持同时选多组** ✓（输入 `0,1` ✓）：`row_selector` 用逗号列表 ✓（运行时的选择器语法本来就支持 ✓ —— `select_all` 按逗号拆分并合并 ✓）。实测该页 25 行 ✓（20+5 ✓）。被标注的卡取自第一块 ✓，而**规则是对全部 25 行测量的** ✓ → 只在其中一块成立的规则会落败 ✓。

---

# Phase 7 收束：真实列表页验通，以及这一阶段学到的四条

## 1. 页面级唯一性：`unique`（新能力）

hitomi artist 页的 `source_id` 反复读错，根因是**同一张卡里有多个同类链接** ✗（作品链接、日期链接、标签链接**同一个 class** ✓），哪一条是作品在**行内结构上无法区分** ✗。唯一可靠的信号是**整页唯一** ✓：日期/期号在每张卡上重复 ✗、作品号各不相同 ✓ —— 而"跨行唯一"是**页面级**性质 ✗，逐行规则表达不了 ✓。

于是给运行时加了 `unique` ✓：列表读取器（`extract_listing_page`，它手里有全部行 ✓）对声明 `unique` 的字段，先读每行的**所有**候选值 ✓、丢掉别的行也有的值 ✓、再对留下的值套用 `filter`/`group` ✓。判定逻辑 `select.first_unique` 由读取器与生成器**共用同一份** ✓（"用读取器测量"而不是"另写一份模拟"——这一阶段为此踩过三次 ✗）。

实测（真实两页）：`page 1 -> 25 张卡 / id 互不相同 25 个 ✓`、`page 2 -> 25 张 / 25 个 ✓`。`unique` 只提供给**读链接的规则** ✓（`attr == "href"` ✓）——文本天然各异、"唯一"无意义 ✗；图片地址每张也不同但不标识任何东西 ✗。两次都是**实测**发现它们会赢走评分、装错东西，才收窄的 ✓。

## 2. 编号取"地址里最后一个数字"，并锚定结尾

`filter` 最初 escape 了数字周围的**整段路径** ✗ → 只匹配得到它自己那张卡 ✗；改成"最短上下文"后又成了 `-(\d+)` ✗ → 取到地址里**第一个**数字 ✗ —— 而作品地址里带着作品标题、标题里也有数字（`…-日本語-4201383` 前面还有 `2026.09.20` ✓）→ 每张卡的"作品号"都成了日期或期号 ✗✗。现在取**最后一个**数字 + 结尾锚点 `(?=[?#]|$)` ✓；路径段本身是编号时保留 `/album/(\d+)` 形式 ✓（与手写站点同形 ✓）。

另一处必须一起去掉的：`filter`+`group` 已把地址缩成编号 ✗，此时 `absolute: true` 会把它对着页面 `urljoin` 一次 ✗ → 每个 id 变成 `https://…/artist/<id>` ✗，且**每个都不同** ✗ —— "值是否互不相同"的检查因此被骗过、报告"没问题" ✗。三个手写站点从不把两者写在一起 ✓，生成器现在也不 ✓。

## 3. 卡片可见、可点名（计划 §8 picker 的人半边）

选中一组后，工具**列出该组卡片**（前 3 张 + 最后 1 张，带标题与链接 ✓），并允许 `--card-of=N` 指定代表 ✓。理由是两处实测边界：hitomi 那次工具抬到了**中间**那张 ✗；18comic 搜索页上**第一个** `/album/` 链接属于结果**上方**的推荐区块 ✗（老作品 ✗）。"文档顺序第一张"是合理默认值，但不总是对的 ✓。剩下"在页面上点击"那一半属交互优化 ✓。

## 4. 列表页的日期可缺席；search 比作者名自由得多

* **日期**：列表页不显示日期是常态 ✓，只要该站点**单个作品页**读得对，内容获取不受影响 ✓（日期由作品页补上 ✓）。现在只在**必需字段**（作品 id / 标题）整页读不到时才报 ✓；可选字段整页缺失不算问题 ✓；标注页的日期提示写明"没有就留空" ✓。
* **search**：结果里可能混着几百个作品、大量不同作者 ✓，但**不影响规则学习** ✓ —— 学的是"这张卡怎么读" ✓。使用层面建议选内容清晰的列表（同一作者 / 同一标签）作学习对象 ✓。同类事实：一个标签页可能**混着不同种类的内容** ✓（buondua 该标签下 20+18 张同一类、20 张 KelaGirls 另一类 ✓）→ 用多选分开或合并 ✓。

## 5. 审计（用户测试一轮后的 6 个 listing 草稿）

```
221157  19 张（合并两组）  cover/source_id/title   id=unique+filter ✓  分页 -
222441  div.items-row…     author/cover/id/title   id=plain            分页 start ✓
215120  div.playlist-item… author/cover/id/title   id=plain            分页 -
101457  div.dj             全五项                  id=plain            分页 page ✓
210748  div.imageset, div.acg  缺 source_id ✗（修复前那次）
214323  div.imageset, div.acg  全五项                 id=plain            分页 page ✓
```

除修复前那一次外必需字段齐全 ✓；分页未识别是因为那次没提供第二页 ✓（预期 ✓）。另外：`search/photos` 那页的 31 张是**这一页**的全部 ✓（站点显示的 43 是跨"分流"的合计 ✓ —— 页面里只有 31 个 `/album/<id>/` 链接 ✓）。

## 仍未做的

* **picker 的点击半边** —— 已完成 ✓（本次）：本地服务上的卡片选择页（token 鉴权 ✓、缩略图走已有 `fetch_image` 所以外站封面也能显示 ✓、每张卡一个"用这张"✓、关掉页面不选就取默认第一张 ✓、等待时 30 秒心跳 ✓）；CLI 在有 >1 张卡且未给 `--card-of=N` 时先问 ✓，给了就直接用（脚本化路径不变 ✓），页面最多展示 60 张 ✓。离线验证（起服务 → 取页面 → 断言列出卡片与缩略图地址 → POST 选择 → 断言被记录并返回 ✓）固化为 `tests/test_listing.py::test_the_choosing_page_serves_the_cards_and_records_a_choice` ✓。另外封面取值改为按懒加载属性顺序（`data-original` 等，`src` 最后 ✓）并跳过占位图 ✓ —— 之前选择页全是空白条，是因为读到了 `blank.jpg` ✓。
* **规则失效检测 / 自适应**（计划 §9–§10）：站点改版后规则读不到时怎么办 ✗ —— 未开始 ✓。

## 一个真实的边界：登录态的结果集，工具抓不到（18comic 搜索页）

用户指出 18comic 的搜索结果应有 43 个，而工具只拿到 31 个，并且举出实例 `/album/1042569/…` 存在却没被找到 ✓。逐个求证后的实测：

| 抓取方式 | 结果 |
|---|---|
| 用户给的 URL（`search_query=平つくね&main_tag=2`） | 31 个 `/album/<id>/`，页面无分页链接 |
| 同 URL + `&page=2` | **同样 31 个**（有分页控件，内容不变） |
| 去掉 `main_tag=2` | **41 个** |
| 滚到底（新增的滚动例程） | 31 → 31，**没有增长** |
| 页面脚本 | 无任何"加载更多"逻辑（`ajax` 命中的是评论/上传/弹窗 ✓） |

也就是说：**同一地址在登录态的浏览器里给出 43 个，在工具的新会话里给出 31 个** ✗ —— 差的不是滚动、不是分页参数、不是分流，而是**会话/登录状态** ✓。这正是计划 §15.2 Level D 说的那一类（自定义机制 / 鉴权）✓，计划对它的要求是**明说"通用搜索配方不支持、需要自定义抓取适配器"** ✓，而不是近似 ✗。

* **顺带做的**：`capture_browser` 现在会在读 HTML 前**滚到文档不再增长为止** ✓（`_scroll_until_settled` ✓ —— 终止条件与 §17 的"本页无新增 id"同源 ✓）。对真正滚动加载的站点这是必需的 ✓；对上表这一页实测**无变化** ✓（它不靠滚动 ✓）。
* **未解决的**：要覆盖登录态的结果集，需要让抓取使用**已登录的浏览器配置**（持久化 profile ✓）或该站的自定义适配器 ✗ —— 尚未做 ✓，且属于需要用户决定的范围（涉及凭据 ✗）。

## 本轮全量

270 passed（新增 4 个用例）、录制语料回放 327 comparisons / 0 mismatches。

---

# 下一阶段：维护那一半（计划 §10 的 "后期 maintenance"）

计划 §9/§10 要的是两件评估（AutoScraper 作 DOM Rule Learner、Scrapling 作自适应辅助 ✓）加一条维护行为，而维护行为的要求写得很硬 ✓：

> adaptive matching 只能是辅助 ✓；**不得默认静默修改正式 adapter** ✓；最终仍要落成确定性 selector/path ✓。

今天做的是这条要求里**可立刻验证、且不引入第三方依赖**的那一半：**适配器健康检查**。

## `src/builder/health.py` + `check_adapter.py`

* `check_work_adapter(site.json, url, html)` ✓ —— 用**运行时自己的路径**读一次页面（`declarative.documents_from` + `extract_work`，与已安装 adapter 走的是同两个调用 ✓），逐字段报告读到什么 ✓；读不到的字段就是"规则失效"的现场 ✓。
* `suggestions_for(html, url, like=<失效的规则>)` ✓ —— 把**该页自己的候选**（Builder 的 harvester，原样 ✓，每条都带它自己的确定性规则 ✓）作为替换建议 ✓。按**字段的形态**筛：文本规则给文本候选 ✓、链接规则给地址候选 ✓ —— 实测：不筛的话，按分数取前 40 全是导航链接和书库索引 ✗，而页面明明有 `#book-name` 这个真标题 ✗。
* CLI `check_adapter.py --site=<site.json> [--offline=<page.html>] [--browser] <url>` ✓ —— 只报告 ✓，**从不写文件** ✓（计划的原话 ✓）；退出码 1 = 有字段读不到 ✓、0 = 全部读到 ✓。
* 对手写站点**自带说明** ✓：它有 `fetch.py`，文档由它产生 ✗ —— 实测一手写 adapter 在这里报出 14 个空字段 ✓，而它自己的 fetcher 跑起来时字段是全的 ✓，所以"读不到"未必是规则失效 ✓，CLI 现在会把这句话打出来 ✓。

## 实测与全量

* 真实录制页（`18comic_vip/output/v2_dry_run/items/122916/raw.html` ✓，925KB ✓）跑通 ✓；
* `tests/test_health.py` 2 个用例 ✓：可读字段被报告为读到 ✓；**故意改坏**的字段被点名 ✓、给出该页的文本候选 ✓（无导航链接、含命名元素 ✓）、且池子会随字段形态变化 ✓；
* **272 passed**（新增 2 个用例）、录制语料回放 327 comparisons / 0 mismatches。

## 仍未做的

* **Scrapling / AutoScraper 的评估本身** ✗（§9/§10 明说要先评估 ✓）：需要拉第三方库跑对照实验 ✗ —— 未开始 ✓。今天的"候选替换"用的是项目自己的 harvester ✓，没有引入这两个依赖 ✓，所以**不预判评估结论** ✓。
* 登录态结果集（上一节 ✓）：按用户决定，**所有涉及账号登录的问题暂时搁置** ✓。
* 计划里剩下的其它参考项（§11 Portia ✓ 已归档、仅设计参考 ✓；§12 Crawl4AI ✓ 可选 ✓）✗ —— 均未展开 ✓。

## 本轮全量

272 passed（新增 2 个用例）、录制语料回放 327 comparisons / 0 mismatches。

---

# 评估结论：AutoScraper（§9）与 Scrapling（§10）都不引入为依赖

计划要求先评估这两个库 ✓。事实取自各自的 PyPI 元数据（2026-09 时点 ✓）：

| | AutoScraper | Scrapling |
|---|---|---|
| 最新版本 / 时间 | 1.1.14 — **2022-07-17** ✗ | 0.4.15 — 2026 年，发布**频繁**（同月多次）✓ |
| 许可 | MIT ✓ | BSD-3-Clause ✓（与计划一致 ✓） |
| Python | ≥3.6 ✓ | ≥3.10 ✓（本工装是 3.11 ✓） |
| 维护状态 | **Development Status :: 4 - Beta**，发布间隔常超一年 ✗ | 活跃 ✓ |
| 基础依赖 | 无（轻 ✓） | lxml / cssselect / orjson / tld / w3lib / typing_extensions（轻 ✓）；重依赖只在 `fetchers` 等 extra 里 ✓ |

## §9 AutoScraper：作为**设计参考**，不作为依赖

它的能力（HTML + wanted_list → 可复用规则 ✓）与 Example 1 高度重合 ✓，但**项目自己的 harvester 已经覆盖这件事** ✓，而且做法更贴合计划要的形状：候选与"读它的规则"是**同一个对象的两面** ✓（`Source.rule` ✓）—— 人确认一个值，就等于确认了一条规则 ✓。许可证 MIT ✓，但**四年未更新 + Beta 分类 + 长间隔发布** ✗ 对一个要长期跑的工装来说不是可以依赖的状态 ✓。它的 `wanted_list` 思路已经体现在标注流程里 ✓。

**结论：不引入 ✓；作为设计参考保留 ✓。**

## §10 Scrapling：能力有用，但**不需要**，且计划禁止它成为规则

活跃维护 ✓、许可合适 ✓、基础依赖轻 ✓ —— 从工程角度它可用 ✓。真正的问题是**它该用在哪**：计划自己写得很清楚 ✓ —— adaptive matching 只能作辅助 ✓，**不得成为不可解释的主规则** ✓，最终仍要落成确定性 selector ✓；而 §10 给它的用途是"原 selector 失效时给出 candidate replacement / 修复建议" ✗。

而这件事，**现在由项目自己的代码做，且已经验证过** ✓：`health.py` 读一次页面 → 点出读不到的字段 ✓ → 用同一页的候选（每条都带确定性规则 ✓）作为替换建议 ✓。实测在一张真实相册页上，它把坏掉的 title 判为 empty ✓，并给出该页的文本候选（含 `#book-name` 一类命名元素 ✓、排除导航链接 ✓）。

Scrapling 相对这套做法唯一的增量是**元素指纹**（保存元素特征，改版后重新定位 ✓）✗ —— 而这正是计划允许的"辅助"位置 ✓。**当前没有证据表明需要它** ✓：候选来自页面本身 ✓，只要页面还暴露那个值，建议就成立 ✓（实测成立 ✓）。为了一个尚未遇到的场景引入重依赖 ✗，与"不要为了 100% 通用污染核心"是同一条原则 ✗。

**结论：暂不引入 ✓。触发条件写明**：当遇到一次**真实改版**、页面仍能显示出该值、但 harvester 的候选里不再有它（即"按页面自身的候选给建议"这一条失效 ✗）时，再评估引入 Scrapling 作 builder-only extra ✓（`uv sync --extra ...`，与现有的 `--extra browser --extra media` 同一形态 ✓）。届时它只用于**生成建议** ✓，生成物仍必须是确定性 selector ✓。

## §11 Portia / §12 Crawl4AI

按计划本身的口径 ✓：Portia 仓库已 archived/read-only ✓ → 仅作设计参考 ✓（sample / annotation / repeating element 的 workflow ✓，与本项目 Level 1 一致 ✓）；Crawl4AI 的 LLM 生成 schema 属于可选参考 ✓ —— 与既定的"LLM 只在作者期出现、绝不进运行时"一致 ✓，不引入 ✓。

## 本轮全量

272 passed、录制语料回放 327 comparisons / 0 mismatches；未新增任何第三方依赖 ✓。

---

# 登录态：通用化的只有"会话"这一层（用户的决定）

用户决定 ✗：不做自动检测 ✓（"这个站需要登录"由人决定 ✓，之后交给交互去问 ✓），**从"已确定需要登录"开始做** ✓。

实现（`capture.py`）：

* `--profile <dir>` ✓ —— 用 Playwright 的**持久化配置**启动 ✓（`launch_persistent_context` ✓），该目录里的会话在之后每次抓取都生效 ✓。这是唯一真正通用的做法 ✓：它用的是**浏览器的机制**，不是某个站的 ✓。
* `--login` ✓ —— **有头**打开 ✓，并在终端等一句回车 ✓；密码是人敲进 Chrome 的 ✓，**工具从不接触凭据** ✗（这也是它比"粘贴 cookie/token"更好的根本原因 ✓：后者要求人搬运机密、且站点一换 token 就失效 ✗）。
* `profile_for(host)` ✓ —— 按 host 一个目录 ✓（`browser_profiles/<host>` ✓），已加入 `.gitignore` ✓：profile 里是 cookie 与 token ✓，属于人的东西 ✓，永不进仓库 ✓。
* **默认行为一字不改** ✓（无 `--profile` → 全新上下文 + 无头 ✓），所以三个站点与所有测试不受影响 ✓（272 passed ✓）。
* 两个 Builder CLI（`build_listing.py` / `build_adapter.py`）都接受这两个开关 ✓；只给 `--login` 时按目标 host 自动取默认目录 ✓。

尚未通用化的那一层（如实）✗：**"登录之后的数据"** —— 若某站只把数据发给会话绑定的请求（签名、设备指纹、多步鉴权 ✗），那只能是该站的自定义抓取适配器 ✓（计划 §15.2 Level D ✓，18comic 的工装本身就是 ✓）。

实测：带 profile 的真实抓取成功 ✓（31 个 id、status 200 ✓，因该 profile 尚未登录 ✓），目录已创建并在下次复用 ✓；`tests/test_listing.py` 增加 1 个用例锁住"按 host 分目录 + 已被 git 忽略 + 默认参数不变" ✓。

**待用户执行的一步** ✓：`python build_listing.py --login --profile=browser_profiles/18comic.vip <搜索页 URL> [<第二页>]` → 在弹出的 Chrome 里登录 → 回终端回车 ✓ → 抓取即读到登录态的结果集 ✓（预期 43 ✓）。这一步必须由人做 ✓（工具不接触凭据 ✓）。

## 本轮全量

273 passed（新增 1 个用例）、录制语料回放 327 comparisons / 0 mismatches。

---

# 结论：登录态/防护这条线，通用层到此为止（两次实测支撑）

用户要求尝试通用解 ✓，逐个试过并各自量到结果 ✓：

| 尝试 | 实测结果 |
|---|---|
| `--profile`（Playwright 持久化配置 ✓） | 站点**连首页**都出安全验证页 ✗（截图 ✓）—— 被识别的是 Playwright 启动本身 ✓ |
| `--login` 先开站点根页再进深链 ✓ | 同上 ✗（防护跟的是浏览器身份，不是访问路径 ✓） |
| 加 `--disable-blink-features=AutomationControlled` ✓ | 同上 ✗ |
| `--attach`：用普通方式启动真 Chrome，再附加读取 ✓ | 在这台机器上**不可行** ✗ —— 用**全新未占用**的 profile 目录实测，Chrome 仍然**立刻退出**、把网址交给已在运行的 Chrome ✗（Windows 上的进程单例行为 ✓）：只要用户的 Chrome 开着，工具就拿不到一个自己的实例、也就没有调试端口 ✓ |

于是两个方向都被堵住 ✗：自己起浏览器 → 被站点识别 ✗；用普通 Chrome → 拿不到可读的实例 ✗。
**这个站点在通用层到底了** ✓ —— 按计划它属于 §15.2 **Level D**（自定义机制/鉴权 → 自定义抓取适配器 ✓），
而 comic18 自己的工装本来就是这样一个适配器 ✓，继续用它 ✓。

## 留下的代码与行为（都要说清）

* `--attach` 保留在 `capture.py` ✓：**默认关闭** ✗、不影响任何既有路径 ✓（273 passed ✓），
  并且现在**失败会一行说清** ✓（"Chrome 立刻退出了 —— 网址被交给了已在运行的 Chrome…" ✓），
  而不是像之前那样安静等 60 秒 ✗。它在这台机器上不可用 ✓，记录在此以免日后再试一遍 ✓。
* `--profile` / `--login` 同样保留 ✓（对**没有**这类防护的站点是有用的通用能力 ✓）。
* 未做的、且不再尝试的 ✗：为某个站点调指纹档位、识别拦截页特征、替人解验证 —— 这些正是 comic18
  那样"每站写一份"的理由 ✓，不进入 `src/generic` ✓。

## 本轮全量

273 passed、录制语料回放 327 comparisons / 0 mismatches。
