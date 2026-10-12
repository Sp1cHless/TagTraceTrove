# site_probe 整合进 T³ —— 交接文档

本文件只做三件事：**记录需求**、**记录已完成的技术工作**、**交接位置与入口**。
未来的技术方案不在本文件范围内，下次再研究。

---

## 一、需求（待实现）

### 1.1 定位

site_probe 作为 T³ 的一个**正式的附属功能**进行更新。作品信息爬取工具正式做成**内置工具**，做一定的通用格式化编辑。

**每一个网站的工具都是一个类似的插件包**，放入 `tool/` 后即可在 exe 的网页端页面直接调用，并**跳过一些阶段**。

### 1.2 目标流程（全部在 T³ 界面内完成）

**现状链路（步骤多、要手动搬文件）：**

```
bat 输入目标
  → 提取出一堆文件
  → 打开筛选 html（单个作品没有；或作为可选功能，只有打开时才多这一步）
  → 得到筛选结果 json
  → 把 json 拖进录入 bat
  → bat 产出完整数据结构文件
  → 手动拖进 import 区域
```

**目标链路：**

```
import 区域选择
  → 选择工具（每个工具对应一个网站）
  → 选择对象类型（按网站不同，可选项不同）：
        以作品网址搜索 / 以作者名搜索 / 以收藏夹地址搜索
        （有的网站没有收藏夹功能）
  → 输入对象信息（网址或者作者名）
  → 勾选是否手动筛选
  → 手动筛选：像目前 hitomi 一样打开一个 review html
        · 功能不用变
        · 筛选后点击保存
  → 未勾选手动筛选：自动产生 selection 结果
        （手动筛选保存的 selection 也会被读取到）
  → 直接进入 batch import 环节
  → 之后与目前的 import 流程一致
```

### 1.3 剪贴板场景

设想的使用场景：**作品网页和 T³ 同时开着**，作品网页阅读后觉得不错想保存，直接复制其 URL。

```
T³ 自动检测到剪贴板有复制网址
  → 弹窗询问：是否要创建该 url 的作品 entry
  → 检测源网址，是否有匹配工具
        有 → 调用它
        没有 → 之后再说
  → 执行 1.2 的新界面流程
```

目标：让整个保存动作**方便、顺畅**。

### 1.4 本文件不涉及

- 未匹配到工具的网站怎么办
- 上述流程的具体技术实现方式
- T³ 与本地工具之间的调用接口形式（见第五节待定项）

---

## 二、已完成的工作

以下全部已实现并实测验证。工具位于 `D:\Project\Dataextracted\site_probe\generic_probe\`（仓库外，与原三个站点目录同级）。

### 2.1 工具结构：两段式拆分

这是整个改造的骨架。**底部一半按站点分开，上面一半通用**：

| 环节 | 位置 | 是否通用 |
|---|---|---|
| 登录、翻页、反爬、取原始页面 | `tool/<站>/fetch.py` | 站点特有 |
| 原始文档 → 标准字段 | `tool/<站>/site.json` + `src/generic/` | 通用引擎 |
| review 页 → selection | `src/generic/review.py` | 通用 |
| selection → 只下载选中的 → 导出 | `src/generic/selection.py` | 通用 |
| 抓取增量状态 | `src/generic/crawl_state.py` | 通用 |

**站点接口契约**（`src/generic/site_api.py`）：

```
read_work(template, url, options) -> RawItem      # 必须实现
list_work_urls(template, kind, ref, options)      # 可选：列举
list_cards(template, kind, ref, options)          # 可选：卡片（带标题封面），供 review 用
scan_review(template, kind, ref, options)         # 可选：站点自己的 review（hitomi）
export_selection(template, path, options)         # 可选：站点自己的 selection 导出（hitomi）
```

- **`read_work` 是唯一必需的底层**：给一个作品网址，产出该作品的原始文档。三个站都有，且都源自各自原有的单作品工具逻辑，**不是重写**。
- `scan_review` / `export_selection` 只有 hitomi 有 —— 那是它自己的原代码。其他站走通用卡片路径。
- **注册表从磁盘发现**：`tool/*/site.json` 有几个就是几个。加一个网站 = 加一个文件夹，**不改任何共享代码**。界面菜单、目标类型选项都由注册表生成。

**`site.json` 声明的站点特有设定**：

- `targets`：每种输入形态的网址正则 + `single`（是否单个作品）+ `accepts_name`（是否接受裸名字）
- `listings`：**按 target kind 分表**的行列规则（搜索页和收藏夹页的行结构不同）
- `work.fields`：每个标准字段从哪来（选择器）
- `manifest`：清单形态 + `accumulate`
- `naming`：产出目录命名
- `review.language_tags`：语言标签表（声明式）

**选择器词汇**（`src/generic/select.py`）：`json` / `json_list` / `json_length` / `html` / `html_param` / `meta` / `regex` / `url` / `card` / `const`，配套一批命名变换（`trim`/`collapse_ws`/`t2s`/`date_only`/`basename`/`strip_query`/`split_csv`/`strip_gender_marker`/`titlecase`/`map`/`promote_first`）。**通用引擎里没有任何一处 `if site == ...`**。

### 2.2 三个网站的接入现状

| 站点 | 单个作品 | 列举形态 | 搜索 |
|---|---|---|---|
| 18comic.vip | `album` | `favorite`（收藏夹，需登录一次） | `search` |
| hanime1.me | `work` | `playlist` | `search` |
| hitomi.la | `work` | `artist`（输入名称） | `search` |

- 三站的**单个作品网址**均已实测通过（各 1 个作品，封面 + 预览图正常落地）。
- 18comic 单本**无需登录**：实测裸 `urllib`/`httpx` 会拿到 `HTTP 403 Cf-Mitigated: challenge`，原因是 `cf_clearance` 与浏览器 TLS 指纹绑定；改用 `curl_cffi impersonate="chrome"` 后同一份 cookie 返回 200。抓取按"缓存 → 无浏览器请求 → 附着已开的调试 Chrome → 必要时启动 Chrome"由便宜到贵升级，只在真的需要时才打扰用户。
- hitomi 的作者路径支持**两种方式**：作者名扫描（原有的完整 review，含 cluster 池）与关键词搜索（通用 review 页）。
- 原有的三个站点目录**未删除**，仍可独立使用；新工具读取它们的 `exports/` 作为录制语料与验收依据。

### 2.3 搜索（本阶段新增）

三站都支持"输入一个关键词"。**机制各不相同**，全部实测：

| 站点 | 机制 | 实测 |
|---|---|---|
| 18comic | 搜索结果页服务端渲染，直接解析 | `kakao` → 218 个作品，4 个页面请求 |
| hanime | 同上 | `Rinhee` → 80 个卡片（59+21） |
| hitomi | **无结果 HTML**（`search.html` 是 3.7KB 的 JS 空壳）。改为按类型依次试索引，第一个命中就用 | `kakao` → artist 索引命中 **369** 个作品；其余类型全 404 |

- hitomi 的 `tagindex.hitomi.la/global.json` **只有约 10 条**热门词，**无法解析任意关键词**。
- hitomi 的搜索索引只给 id，所以卡片需要逐作品读元数据（已按作品缓存）。代价高但换来**最全的卡片字段**：语言 347/369、日期、作者、分类。
- **翻页用页码而不是 next 链接**：结果卡片稳定，分页标记才是站点改版时会变的东西；循环靠"本页无新增 id"终止。
- `search` 标记为"接受裸名字"，因此**裸词现在跨站有歧义** —— 会明确报错并列出候选，`--site` 可消歧；picker 流程不受影响（先选站再输入）。

### 2.4 通用 review 页

`src/generic/review.py`，自包含 HTML，**由列表卡片生成**。

**关键实测**：对 18comic 和 hanime 这类"列表页本身带标题和封面"的站点，**218 个结果只需 4 个请求，一个作品详情页都不抓**。这正是它存在的理由 —— 几百个 entry 不该先全抓一遍再让你挑。

功能（按你的要求逐项实现并实测）：

- **相似名字分组**：归一化后分组（去掉 `[...]` 前缀、`[DL版]`/`[中国翻訳]`/`[無修正]` 这类版本尾巴、标点）。实测 `kakao` 的 218 张卡片 → 164 组，40 组不止一条（`4× 狩り妻` 等）。多条的默认折叠，组头可整组选/取消。
- **按语言筛选**：卡片自带 `language` 就直接用（hitomi），否则用站点声明的 `review.language_tags` 从标签/标题推断（18comic）。实测 hitomi `中文 123 / 한국어 84 / 日本語 48 / Español 35 / English 23`。两者都拿不到时隐藏该筛选器。
- **其他基础功能**：多字段搜索（标题/作者/标签/id）、`Select shown`、`Clear`、展开/收起、**实时 `selected / shown` 计数**。
- **原网址可点**：标题即链接 + 右下角 `open ↗`（悬停显示完整 URL）；因为卡片是 label，点链接做了 `stopPropagation`，不会连带切换勾选。
- **封面本地化**：扫描时把每张卡的封面下载到 `<listing>/review_media/`，卡片指向**相对路径**，并记录**真实像素尺寸**让卡片跟随封面的形状（实测 hitomi 竖版 `1359x1920`、hanime 横版 `640x360` —— 固定比例必然错一个）。这同时解决了"热链封面随 token 过期变空白"的问题。
- **导出**：`selection_<ref>.json`，键沿用 hitomi 页面的那套（`source_site` / `selected_source_ids` / `whitelisted_source_ids` / `excluded_source_ids` / `selected_items`），**另加 `target_kind` / `target_ref`** 供通用消费端重新列举。用 Chrome 的保存对话框并把目标目录**显示在页面上**，不支持时退回普通下载。

**两个曾把封面搞坏的原因（已修，记录以免重犯）**：

1. 页面里判断写成了"URL 以 http 开头才建 `<img>`"，而本地化后是相对路径 → 刚下好的封面全被跳过。
2. hanime 的缩略图**必须带签名 `secure=`** 才能取到（去掉就是 403），而它自己的脱敏逻辑在**提取之前**就把 token 替换成了 `[REDACTED]` → 卡片从来没有可用的 URL。现在**从活体响应提取、只把脱敏版写缓存**；含脱敏标记的缓存页会被重读一次。

### 2.5 通用 selection 消费端

`src/generic/selection.py`：

- **有 `export_selection` 钩子就用**（hitomi 走它自己那套完整导出），**没有就走通用路径**。
- 通用路径**不存任何状态**：selection 自带 `source_site` / `target_kind` / `target_ref`，重新列一次目录即可解析 id（搜索页只有几个请求）。只有被选中的作品才会 `read_work` + 下载媒体。
- 实测：kakao 搜索 218 → 挑 3 → **只抓 3 个**（各含封面 + 3 张还原后的预览图），清单能被 T³ 导入且带 `origin`。
- hanime 往返也实测通过（`Rinhee` 80 → 挑 2）。

### 2.6 抓取侧状态（增量抓取）—— 这是本轮的一次架构纠正

**原实现把游标放在 T³ 库里**，导致"没导入 = 没有游标 = 每次重抓"。已按"游标属于抓取"改到**导出树**里：

```
export/<site>/crawl_state.json
  每个 listing 两样东西：
    inventory  该 listing 已落在磁盘上的作品 id（从 items/ 目录自己推导，不可能与实际脱节）
    cursor     已见过的最新作品（用于报告，也供库那一侧以后读取）
```

- **裁剪用 inventory 而不是 cursor**：cursor 是对顺序的假设，inventory 是精确答案。
- 下载运行只抓磁盘上没有的。实测：`80 个已在磁盘 → 抓 0 个`；中途一次 `47 已持有 → 抓 33 个`。
- **`--review` 故意列出全部**（要挑就得看到全部，包括已在磁盘上的）；`--refresh` 绕过裁剪。
- **游标由"清单列出的全部 id"推进**，所以一次什么都没抓的运行也能推进游标（实测：0 次抓取，游标仍推进到 `408266`）。无日期的条目永远不会越过有日期的游标 —— 对 hanime 这类整站无日期的站点正常推进，对有日期的站点保守不动。
- 库那一侧的游标（T³ 的 `site_crawl_sources`）**保留**，但它不再是裁剪依据。

### 2.7 T³ 侧：作品 id 与更新游标（migration 021）

- `site_works`：每个 `(站点, 作品id) → entry_id` 的持久映射。**这是"保证每个已录入作品留下一个 id"的落点**，也是爬取文件被删掉后唯一能证明"我们收过这个作品"的记录。
- `site_crawl_sources`：每个 listing 一行的游标。
- commit 时对**新建和已存在（跳过）的作品都记录 id** —— 所以重跑一次导出就能给老库补齐 id，不需要解析旧 URL。
- **重复检测：先 Source URL，再站点作品 id**。后者让站点改写 URL 形态时不会产生重复条目。
- batch 增加 `origin`（`packages/shared` 的 schema + `site-probe.ts` 透传 + commit 推进游标）。
- `import:cursor` CLI：`status` / `filter` / `list` / `set`。其中 `filter` 是"给一批 id，回答哪些已持有"的精确接口。
- **一次搜索如果关键词就是某作者名，会额外登记一条作者游标**（ref 用规范化名字，显示用卡片拼写）—— 通用实现，无站点分支。实测：搜 `kakao` 且卡片署名 `Kakao` → 只产生一条作者行；搜标签（`full color`）→ 只留搜索行，不凭空造作者。

### 2.8 原三个网站的数据迁移

- `taxonomy_dictionary.json` + `tag_review.csv`：三个站均以**原件覆盖**新工具的测试数据，覆盖前留 `<名字>.pre-migration` 备份。校验通过：`kakao` 在 18comic 作者词表中、`rinhee` 在 hanime 作者词表中。
- hitomi `author_list.json`：原件 251 条 + `sharekoube` = **252 条**。**此处做了合并而不是覆盖** —— `sharekoube` 不在原件里，且它是真实爬过并审阅导出的作者，不是测试项，覆盖会把它静默丢掉。
- `character.json` **未迁移**：内容是缺外层括号的**截断碎片**，旧工具里无代码写它，characters 已在 taxonomy 里（1559 条）。判定为遗留产物。
- 18comic 与 hanime **没有 `author_list.json`** —— 那个文件是 hitomi 自己的机制，在原工具和新工具里都只属于 hitomi。
- 库内实测：`site_works` 195 行（18comic 53 / hanime 134 / hitomi 8），说明导入确实走了 commit 层；但 `site_crawl_sources` 当时为 **0 行**（原因见第五节）。已手工为 `kakao`（18comic，最新 `1451404@2026-07-07`）与 `rinhee`（hanime，最新 `408266`）补上作者游标。

### 2.9 媒体相关的实测结论与修复

- **18comic 预览图被打乱**：`image_scramble.py` 与 `repair_scramble.py` **逐字节复制**自原工具（`diff` 确认一致），在下载时调用；`修复缺失封面预览.bat` 用它对已下载的旧文件就地还原。**我第一版手写的还原算法是错的**（条带索引算法不同），所以坚持用原件。
- **签名 URL 的双重身份**：hanime 的封面 URL 带过期签名，**下载需要它、导出不能留它**。实现为卡片/记录里的 `cover_fetch_url`（用于取图，写盘前被 `scrub_fetch_urls` 清除）与 `source_path`（干净，用于导出）。
- **元数据不得撒谎**：写记录前逐个核对 `local_path` 指向的文件是否真的在磁盘上，不在就删掉该键。这是一次真实事故后的加固 —— 曾出现 53 条记录全部声称有封面而其中 20 个文件不存在，且**导出看起来是完整的**。
- **媒体缺口要点名**：`missing_media` 列出缺媒体的作品，运行摘要里显示，而不是只给一个计数。`repair_media.py` / bat 可对已有导出补齐。
- **过期文件清理**：站点每次返回的预览图集合不同，重跑会留下一堆记录不再引用的孤儿文件（曾被误认为"抓了整本漫画"）。现在每次运行后清理未被引用的媒体文件。
- 18comic 搜索结果页**没有页数**（全页 `頁數` 出现 0 次），所以通用 review 的页数留空 —— 这是明确取舍，不是遗漏。

### 2.10 验证资产

- **录制语料回归**：hitomi 3901 个作品（`cache/galleryinfo`）、hanime 147 个（保留的 `playlist_220566`）、18comic 21 个专辑页 → **41,547 项字段比较 / 0 处不一致**。
- `tests/` 52 个测试，含几道**结构性守卫**：
  - **站点契约**：每个站点必须实现 `read_work`；每个声明的 target 必须有实现（这条抓出过"声明了 album 却没实现"的实际缺陷）
  - **网址解析**：粘贴形态（`#锚点`、`?查询`、尾斜杠、百分号编码标题）
  - **bat 卫生**：每个 `.bat` 必须 CRLF + 纯 ASCII（LF 会让 CMD 吃掉每行开头字符，非 ASCII 会打乱解析器；这两条都真实发生过）
  - **未定义名检查**：静态扫描 `tool/*/fetch.py` 与 `src/generic/`，找"调用了但没定义"的名字（抓出过两处，其中一处会让 hitomi 作者路径直接崩）
- T³ 侧：290 集成 + 412 单测 + `db:probe` 33 项 + `db:doctor` + lint + typecheck，全绿。

---

## 三、实测得到的产品约束（决定了上面的取舍）

这几条是**测量结果**，不是判断，未来做方案时应以它们为前提：

1. **通用规则读取器（零站点规则）对 7 个不同类型作品页的产出**：标题 **7/7**、封面 **7/7**（且封面 URL 实测能取到图片，非仅字符串）;日期约一半；tag 约一半且其中一半是 **SEO 噪声**（`拷貝漫畫_海賊王…` 这种）；**作者约 1/4，且会把作品官网当作者**。
   → 结论：**通用层只承担"标题 + 封面"**，作者与 tag 留给站点模板或人工。
2. **`gallery-dl` / `yt-dlp`（预设站点列表型工具）**：7 个站点里**只有 1 个被支持**（e-hentai，且需限流否则超时）；jable 是 yt-dlp **主动移除**支持（判定为盗版站）。这两个工具的站点列表与我们要用的站点类型**几乎不重叠**。
   → 结论：这个方向不能用现成工具解决。
3. **模型抽取不适合作为运行时依赖**：3~8B 模型 2~4.5 GB、CPU 单页 20~60 秒，而一次搜索是几百个作品（数百倍代价），与"轻量、开箱即用"直接冲突。且封面 URL 是长上下文里逐字照抄的任务，恰是小模型最不可靠的字段。
   → 结论：模型只能用在**编写期**（产出 `site.json`），运行时保持确定性、零依赖。
4. **封面必须由抓取侧取并落盘**，而不是让浏览器直接显示远程 URL：浏览器取图会撞 CORS（拿不到字节无法入库）、Referer 限制（hitomi）、以及 token 过期（hanime）。而抓取侧本来就具备 curl_cffi、页面上下文与 Referer 处理能力 —— **这已经是现状**。

---

## 四、交接：位置与入口

### 4.1 目录

```
D:\Project\Dataextracted\site_probe\
  generic_probe\                    ← 合并后的工具
    probe.py  pick.py  tag_review.py  selection.py  refresh_review.py
    repair_media.py  fetch_work_meta.py（雏形，见第五节）
    src\generic\                    ← 通用层
    tool\{hitomi_la, hanime1_me, comic18}\   ← 每站的 site.json + fetch.py
    export\{hitomi_la, hanime1_me, 18comic_vip}\
    \tests\  \verify_against_recordings.py
  hitomi_la\  18comic_vip\  hanime1_me\   ← 原工具，未删除，仍可独立使用
```

### 4.2 入口

| 入口 | 用途 |
|---|---|
| `提取单条链接.bat` | 粘贴作品网址，自动判断站点 |
| `提取作者或收藏夹.bat` | 选站（菜单由注册表生成）→ 输入 → 选择是否 review |
| `下载selection.bat` | 拖入 selection json，只下载选中的 |
| `应用Tag审核.bat` | 应用 tag_review.csv 的保留/屏蔽 |
| `修复缺失封面预览.bat` | 为已有导出补齐缺失媒体 |

命令行等价物：`probe.py [--review]`、`selection.py`、`tag_review.py`、`refresh_review.py`（重写旧版生成的 review 页面，**不需要重爬**）。

### 4.3 跑验证

```
.venv\Scripts\python.exe -m pytest -q                      52 个测试
.venv\Scripts\python.exe verify_against_recordings.py      录制语料回归
.venv\Scripts\python.exe tests\check_undefined_names.py    未定义名检查
cd D:\Project\TagTraceTrove && pnpm test:integration && pnpm db:probe && pnpm db:doctor
```

---

## 五、遗留问题与待定决策

**遗留问题（已在运行中暴露，未解决）：**

1. **网页导入不带 `origin`**。T³ 网页端是在浏览器里现场拼 batch JSON 的，那个 batch 没有 `origin`，所以**网页导入不会推进任何库侧游标**（`site_works` 有 195 行，而 `site_crawl_sources` 为 0）。它是静默的。当前**不影响增量抓取**（增量已由抓取侧接管），但库侧那条记录是空的。
2. **通用读取器 `fetch_work_meta.py` 尚是雏形**，已知三个缺陷：属性路径未做 HTML 实体解码（`&amp;` → URL 失效）；封面启发式可能选中站点 logo（e-hentai 实测选中了 `ehgt.org/g/ygm.png`）；部分 CDN 需要 Referer。**你已要求先停下**，等接口形式定了再继续。
3. **作者覆盖薄弱**（1/4 且可能不是人名）—— 通用层不打算解决，交给模板。
4. **hitomi 的 cluster 分析只服务 hitomi**。其他站点的 review 是通用卡片页，没有同标题证据/内容哈希覆盖率那套。

**待定决策（需要你定，然后我才动手）：**

1. **T³ 与本地工具的调用形式** —— 子进程（`python ...` 读 JSON）还是本地小接口（常驻端口）。我倾向子进程：一次性任务、无常驻状态、失败好诊断。
2. **剪贴板检测属于 T³ 侧功能**，需要明确它在 T³ 里由谁负责（前端轮询 `navigator.clipboard` 还是后端）。
3. **"未匹配到工具的网址"** 的处理方式（你在需求里已明确押后）。
4. 通用读取器是否继续投入（既然已确认它只值得承担"标题 + 封面"，而封面恰恰是最有价值的那一项）。

---

## 六、架构方向已确认的决策（2026-09-19）

`docs/t3-siteprobe-architecture-guidance.md` 已读过，其中四处需要判断的地方已定，记录在此以免重复讨论。

### 6.1 中立 contract：现在就换，不并存

`apps/server/src/import/site-probe.ts` 目前仍是**三个站点各一份 Zod schema + 三个 adapt 函数**，靠 `source_site` 的文面值区分。SiteProbe 侧已经通用了，T³ 侧的桥接层没有 —— 这违反架构指导第 2 节与不变量 #2/#10，且 `adapter.json`、capabilities、adapter version 都无处落脚。

决定：**用一份通用 contract 取代三者**，SiteProbe 按内容中立的形状输出。改动集中在 `site-probe.ts` + `packages/shared/src/schemas/import.ts`，由现有 294 个集成测试兜底。

理由：这是不变量 #2/#10 的前提，也是 adapter 元数据能存在的前提；并存只会让站点分支延续下去。

### 6.2 Adapter Builder：两侧分工

- **T³ 网页端负责点选 UI**，生成候选选择器（`@medv/finder` 一类）。
- **Python 侧负责候选校验、去重、生成并校验 `site.json`**。

理由：符合第 24 节"Builder 默认只产出声明式 adapter"，也让第 36 节列出的 JS 依赖有明确归属；纯 Python 做不了"点一下那个元素"，纯 JS 又不在 `siteprobe/` 子树里。

### 6.3 可写数据：可配置根，默认工具目录

新增 data-root（命令行参数或环境变量）：

- **独立运行**（双击 bat）默认仍是工具目录下的 `export/`，现有用法不变；
- **被 T³ 拉起**时指向 `<T3_DATA_DIR>/siteprobe/`，满足第 34 节。

不搬迁现有数据，不破坏当前用法。

### 6.4 Neutral fixtures：中立 contract 定完就做

顺序是**先 contract，再 fixtures**。届时：

- 建 `book-demo` / `movie-demo` / `gallery-demo` / `api-demo` / `dynamic-demo`；
- 把站点契约测试从"必须存在这三个站"改成"**每个被发现的 adapter 都满足契约**"；
- 录制回归（`verify_against_recordings.py`）保持为可选/本地任务，不进 Core CI。

理由：现在删掉三个真实 adapter，测试会挂（契约测试断言三个 key 存在、发现测试断言集合恰好三个、录制回归依赖仓库外的私人语料）—— 即不变量 #1 目前是红的。先用现有形状搭 fixtures 会让它们改两遍。

### 6.5 由此得到的实施顺序

```
1. 中立 contract（含 site-probe.ts 通用化 + shared schema）
2. neutral fixtures + "无真实 adapter 时 Core CI 仍绿"
3. data-root 可配置（小，可并入 1）
4. 冻结 adapter contract（adapter.json / site.json 职责划分、capabilities、output schema）
5. registry 多 root（builtin / installed / local / development）+ 声明式/可执行分类
6. Adapter Builder（两侧分工）
7. T³ integration（transport / Import UI / clipboard / batch import）
```

第 5 步之前不搬仓库：第 28 节明确"契约冻结后再拆分"。
