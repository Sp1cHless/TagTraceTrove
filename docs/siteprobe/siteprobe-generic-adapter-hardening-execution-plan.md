# SiteProbe 通用规则生成与运行稳定化执行方案

日期：2026-10-11  
状态：待执行；本文是实施方案，不代表代码已完成或已验证。  
目标：减少新网站接入时需要修改 SiteProbe 源码的次数，让常见页面差异可以通过用户创建的声明式规则表达。

## 1. 执行边界与约束

本方案承接当前用户使用方式：通过 T3 的通用 Builder 为不同网站新建作品规则、作者列表规则等。优先完善通用能力；站点域名、API 地址、选择器只能进入用户生成的规则和案例数据，不得成为 Core 内按域名判断的业务分支。

- 本次授权是产出方案文档；代码实施、旧规则升级与真实站点运行尚未开始。
- 保持 T3 的 Entry / Producer 模型和现有导入边界；预计无需数据库迁移。
- 不扩展媒体播放、视频下载、全网抓取、自动选择 Provider 或自动安装站点包。
- 仅沿用已有封面、预览图片处理能力；本文“媒体验证”指这些图片的现有导入链路。
- 保留工作区已有修改，使用定位明确的补丁。用户生成的规则是用户数据，不能直接批量覆盖。
- 测试使用临时目录和隔离数据；不得访问或修改正式 `.data/library.db`、正式 assets。
- 不自动重启服务、部署、打包 APK、提交 Git 或重新生成所有网站规则。
- 每个明确的实现批次只做一轮最基础、聚焦的验证。通过后停止；失败仅修具体问题并重跑同一检查。禁止额外附加全套测试、构建、类型检查、多站点实测或重复回放。
- 用户负责真实网站和界面效果验收；自动化检查结果不能替代该验收。

术语沿用既有文档：`local` 中的 learned rule set 是用户生成的声明式规则集；`installed` 中的 custom adapter 是独立安装的站点代码包。下文“规则适配”泛指前者的生成和运行，不改变分发架构。

## 2. 当前基线与问题证据

以下来自 2026-10-11 本机静态盘点与本会话用户反馈，不能当成所有站点目前均可用的证明。

| 来源 | 数量 | 配置声明的能力 |
|---|---:|---|
| local | 9 | 全部包含作品规则，其中 4 个还包含列表规则 |
| installed | 3 | 18comic、Hanime、Hitomi 的定制实现 |
| builtin | 0 个 site.json | 本机仓库目录仅发现说明文件 |

local 规则集：ACG Gamer、Buondua、Jable、Manwa、Rule34video、Agedm、Bilinovel、Iwara、Vikacg。列表规则分别为 Buondua album、Jable artist、Bilinovel search、Iwara artist。仅代表配置存在，未重新访问这些网站。

Iwara 的最新规则包含浏览器列表采集、作品 API 文档、字母数字作品 ID 和日期转换；用户已反馈修复后正常。本方案应复用这些通用能力，避免重新实现一次。

静态盘点也发现历史元数据不一致：部分较早规则集缺少 `adapter.json`；Manwa 的 `learned.json` 残留旧字段名和空元数据；一些 `t3_needs` 文本可能是历史提示。后续需按实际源码确认，不能把历史提示自动视作当前故障。

| 常见故障 | 已出现的现象 | 要补齐的能力 |
|---|---|---|
| 采集方式不一致 | Builder 看到渲染后的列表，运行时 HTTP 只返回页面壳 | 共享采集计划与文档来源 |
| URL 身份猜测错误 | `/video/<id>/<slug>` 捕获 slug；作者 URL 捕获 sort | 共享身份规则与歧义报告 |
| 行范围不一致 | 卡片本身是链接；多个区块共用 class | 统一行内选择器与区块规则 |
| 数据显示格式变化 | 相对日期、懒加载属性、多值文本 | 可组合的通用转换 |
| 封面链路断开 | 读到 URL，但预览或导入时没有图片 | 共享 URL、请求上下文和图片结果 |
| 验收只覆盖局部 | 保存页面回放成功，但真实采集或 T3 解析失败 | 有预算的单次运行契约检查 |
| 规则格式演进 | 旧元数据缺失或命名过期 | 兼容加载、只读 doctor、显式升级 |

## 3. 目标结构与完成定义

将 Builder 与运行时的公共步骤收敛到 Core 中。Builder 负责采集样本、接受用户标注、提出规则；运行时负责执行同一套采集和提取逻辑。

```text
用户输入 URL / 标注字段
          ↓
Builder 生成声明式规则
          ↓
Core：目标解析 → 采集文档 → 提取列表/作品 → 图片处理 → 标准导出
          ↓
一次有限的契约检查 + 分阶段报告
          ↓
安装用户规则 → T3 预览与用户确认导入
```

完成标准：

1. 常见 HTTP HTML、浏览器渲染页面、可重放 JSON 请求均可由配置表达。
2. 同一规则在 Builder 和运行时具有一致的文档来源、身份解释与字段转换。
3. 列表的作品 ID 优先复用作品目标规则，歧义不会静默选择后显示成功。
4. 必需字段失败在安装或执行阶段清楚报告；可选字段缺失允许继续，并标明影响。
5. T3 可显示“采集、列表、作品、图片、导入解析”中的具体失败阶段。
6. 旧规则继续可读，升级有差异预览和恢复副本。
7. 每个已修复的通用现象有一个精简案例，可在需要时选择性回放。

不承诺所有网站都能声明式适配。二进制索引、图片重排、动态签名等特殊算法继续允许独立定制插件；遇到这些情况要明确报告能力缺口，不能伪造空列表成功。

## 4. 公共数据契约

### 4.1 执行结果与诊断

建议新增 `siteprobe/src/generic/diagnostics.py`，通过现有 JSON-lines 机器接口传递结构化结果。复用已有事件和 job 流程，不另建任务系统。

单条 finding 至少包含：

| 字段 | 作用 |
|---|---|
| code | 稳定错误码，供机器和翻译使用 |
| stage | target / acquisition / listing / work / media / import |
| severity | error / warning / info |
| field | 涉及字段，可为空 |
| target_kind | work / artist / search 等 |
| message | 面向用户的简明说明 |
| evidence | 行数、文档名称、HTTP 状态等有限证据 |
| suggested_action | 重新标注、登录、重试、检查地址等建议 |

初始错误码：`TARGET_NOT_MATCHED`、`TARGET_ID_AMBIGUOUS`、`ACQUISITION_EMPTY`、`ACQUISITION_FAILED`、`DOCUMENT_UNAVAILABLE`、`LISTING_ROWS_EMPTY`、`SOURCE_ID_EMPTY`、`SOURCE_ID_DUPLICATED`、`WORK_FIELD_EMPTY`、`COVER_URL_EMPTY`、`COVER_FETCH_FAILED`、`IMPORT_CONTRACT_REJECTED`、`CAPABILITY_UNSUPPORTED`、`BUDGET_EXCEEDED`。

要求：保留原有退出码语义；旧调用方忽略新增字段仍可工作；未知内部异常仍保留故障日志。诊断中的 URL 去掉敏感查询值，禁止输出 Cookie、Authorization、浏览器存储和完整私有响应。

### 4.2 采集计划

以现有 `listings.<kind>.acquisition: "browser"` 为兼容起点，新增内部 `AcquisitionPlan`。最终 JSON 形状应在实施时结合现有 documents/session 结构确定，避免仅为命名整齐重写已工作的配置。

计划描述：采集 mode（http / browser / api）、可选 session 引用、文档配方、等待条件和单次预算。缺省继续使用 http。

- `api` 表示执行已声明的请求配方，不表示自动扫描网站接口。
- HTTP 与浏览器同时返回统一的文档集合、最终 URL、状态、来源和诊断。
- 浏览器等待使用规则已知的 row selector / 必需字段条件；没有条件时采用有限 settle。禁止无限滚动或无限重试。
- 同一次列表运行复用浏览器上下文和会话，避免每页启动一次 Chrome。
- 登录态仅引用本地 profile；不把凭据写入可分享规则。
- 显式 browser 规则不得静默降级为 HTTP；显式 HTTP 规则也不得自动打开登录窗口。
- 网络文档使用稳定请求身份，不能依赖 `network:2` 等响应到达序号。

### 4.3 身份与地址

建议新增 `siteprobe/src/generic/identity.py`，集中处理目标匹配结果。兼容现有 `url_pattern` / `id_group`，不立即替换全部规则语法。

- 区分 `source_id`、`detail_url`、人类可读 slug、列表身份和分页参数。
- 优先读取明确 `id_group`，其次 named id，再按兼容规则读取位置组。
- 列表卡片 ID 使用已有 work target；无法复用时才提出候选身份规则。
- 支持路径段、数字嵌入段、字母数字段、slug、查询参数、URL 编码。
- 对两个都合理的候选显示 ID 预览，交给用户选择；不使用域名硬编码猜测。
- 作者链接中的 route marker 可作为候选证据，不能把 marker 集合当成所有网站的强制结构。
- 相对 href 先根据页面 URL 解析，再使用统一匹配逻辑；不得出现提取出 ID 后再 absolute 成 URL。
- 不擅自大小写折叠或改变既有 source_id；身份改变可能造成重复导入，必须显式展示。

### 4.4 字段与图片

继续使用 `select.py` 中的 transform vocabulary。新增转换应定义输入、输出和失败语义，不允许无意中把未知值擦为空字符串。

- 日期：绝对日期归一化、已有相对日期、epoch seconds / milliseconds。相对日期使用一次运行冻结的时钟；保留原始值与转换依据，不声称 day-only 文本具有精确时间。
- 文本：多值拆分、空白、HTML 实体；保留字段类型，不把一个字符串展开成字符列表。
- JSON：数组投影、条件筛选、稳定请求文档、已有字段拼接；不引入任意脚本和公式系统。
- 图片：relative / protocol-relative URL、srcset、lazy 属性、现有拼接规则。选择候选图和生成可执行规则必须同步。
- 图片统一结果包含 source URL、fetch URL、referer、状态、MIME、字节数及本地路径；创建页面、列表审核与导出复用同一请求逻辑。
- 封面可选：用户未选择或页面确实没有封面时为 info；标注过封面而运行时失败为 warning。仅当用户声明该字段必需时才阻断安装。

## 5. 按依赖顺序执行

### 阶段 A：错误分类与最小运行契约（最高优先级）

目的：让“生成成功但导入 0 项”尽早成为可定位的失败。

修改入口：`src/generic/diagnostics.py`（新）、`integration.py`、`runner.py`、`src/builder/roundtrip.py`、`build_listing.py`、`apps/server/src/siteprobe/transport.ts` / `jobs.ts`、`packages/shared/src/schemas/siteprobe.ts`。

执行步骤：

1. 列出当前机器事件、退出码和 job 状态，定义向后兼容的 finding 字段。
2. 将关键空结果和重复 ID 统一成结构化诊断；保留可识别的真实空列表与采集失败区别。
3. 让 Builder 在安装前调用一个有限的 runtime probe，而不是只回放已保存 markup。
4. 作品规则 probe 一个作品；列表规则 probe 一页，检查多张卡片，再选一张具有 detail_url 的卡片读取作品。
5. 若尚未创建作品规则，只报告“列表已验证、作品阶段未验证”，不因此禁止用户先创建列表。
6. 图片只验证一个已标注封面；站点没有或未标注则 skipped。不要下载全部 preview。
7. 将标准导出交给 T3 纯解析入口；只读临时导出目录，不调用 commit，不访问正式库。
8. 检查结果区分 passed / failed / skipped / unavailable。预算耗尽不能被包装成通过。

probe 预算建议初值：一页列表、一个作品、一个封面；采集最多 45 秒，合计最多 90 秒；预先冻结上限并报告实际使用。Builder 阶段已有采集可复用，但必须记录哪些是已捕获回放、哪些确实通过运行时取得。

T3 不可用时，独立 SiteProbe 仍可生成规则，import 阶段记 unavailable；T3 内发起创建时必须得到纯解析结论。不要令 Python Core 强依赖正在运行的 T3 服务：通过已有 transport/临时产物桥接，解析逻辑留在 TypeScript。

本阶段唯一基础验证：一个临时导出与模拟采集的聚焦契约场景，证明空列表被定位、有效结果能交给现有 T3 解析器；执行前确定选择 Python 或 TS 的单一入口，禁止两边分别跑完再加总为“一轮”。

完成标准：安装报告能够指出失败阶段；不存在必需数据为空却宣告完整成功的路径；每个 skipped 阶段可见。

### 阶段 B：统一采集与文档来源

依赖：阶段 A 的诊断结构。

修改入口：建议新增 `src/generic/acquisition.py`；调整 `declarative.py`、`document.py`、`template.py`、`src/builder/capture.py`、作品 Builder 和 `build_listing.py`。

执行步骤：

1. 把运行时需要的 HTTP / browser 公共能力移到 Core；Builder 的标注、候选发现仍留在 Builder。
2. 去掉运行时对 Builder capture 的直接依赖，Builder 改为调用共享采集器。
3. 将旧 acquisition 字符串和旧 documents request 转成内部计划；不强制修改用户 site.json。
4. Browser run 管理上下文生命周期、profile、超时和 page ready 条件；逐页复用上下文。
5. 作品页和列表页各自保留 mode，可由 API 读取作品而由 browser 读取列表。
6. 统一文档命名、最终 URL 和失败信息；保留来源证据供规则学习选择。

唯一基础验证：选择一个模拟 SPA fixture 的聚焦检查，证明 Builder 与 runtime 读取同一来源，并且分页不重复启动上下文。

完成标准：渲染 DOM 上生成的规则可由运行时按相同方式执行；默认 HTTP 不被改变；未运行的浏览器实机路径明确标为未验证。

### 阶段 C：统一作品与列表身份规则

依赖：阶段 A；可以复用阶段 B 的 URL/文档结果。

修改入口：`src/generic/identity.py`（新）、`template.py`、`src/builder/learn.py`、`src/builder/listing.py`、`build_listing.py`。

执行步骤：

1. 提取当前 target 匹配和 Builder ID 推断的重复逻辑，明确兼容优先级。
2. 把已有 target_rule_for_id 的经验整合为共享身份提取；增加 query ID 与显式 id_group 支持。
3. 列表读取已学 work target 时从 registry 按现有层级与目标能力取规则，不只猜本地文件夹名。
4. 从卡片 URL 派生 source_id 和 detail_url，并记录身份依据。
5. 显示“作品链接 → 提取 ID”的简短预览；出现歧义时保留用户选择。
6. 身份规则变化作为显式更新差异，不悄悄重新命名已导出作品目录。

唯一基础验证：一个聚焦、有限输入表覆盖 ID 在 slug 前、查询 ID 和 artist 排序参数；不连接真实网站。

完成标准：同一作品 URL 经 work 和 listing 得到相同 ID；排序与分页不改变列表身份。

### 阶段 D：转换与图片执行统一

依赖：阶段 B、C。

修改入口：`select.py`、`extract.py`、`media.py`、`review_media.py`、`src/builder/harvest.py` / `learn.py` / `session_server.py`。

执行步骤：

1. 整理当前已存在的 transform，新增明确输入/输出契约，优先消除重复实现。
2. 将相对日期的时钟冻结在 extraction context，保留 date_raw 和转换状态的诊断信息。
3. 统一图片 URL 解析与请求上下文；保留已有 preview、referer 和 fetch_url 兼容。
4. 用户选中图片时同时确认一条可重放规则；只有视觉候选而没有可执行规则时明确提示。
5. 校验图片响应，避免把 200 状态的 HTML 挑战页当成 JPEG 文件成功导出。
6. 字段缺失、转换失败、图片取回失败分开记录，不用一个“没封面”覆盖所有原因。

唯一基础验证：一个已保存的图片/日期案例，包含 protocol-relative URL、图片响应与新旧日期两种显示；只验证本批次实际修改的能力。

完成标准：创建预览、列表审核和作品导出的封面请求语义一致；未知日期不被无声丢弃。

### 阶段 E：T3 展示与导入解析收口

依赖：阶段 A 的事件；阶段 B–D 的最终数据契约。

修改入口：`apps/server/src/import/site-probe.ts`、`apps/server/src/siteprobe/transport.ts` / `jobs.ts` / `log.ts`、shared siteprobe schema、`apps/web/src/components/RuleBuilderPanel.vue` / `AdvancedImportPanel.vue`、`apps/web/src/siteprobe/adapter-status.ts`、`apps/web/src/i18n.ts`。

执行步骤：

1. 复用现有 import parser 的纯解析/映射入口，避免另外实现一套“看起来像导入”的验证器。
2. 保留三类定制站点的严格 schema；通用中性导出走标准入口，不因为失败自动降级到更宽松 schema。
3. 核查 title、ID、detail_url、author、date、description、cover/preview 的字段路径和丢弃策略。
4. Panel 显示简明阶段结果：已读取多少卡片、当前哪个字段失败、是否仅封面失败、哪些未验证。
5. 常见错误给操作建议；未知内部错误仍允许复制现有诊断报告。
6. 元数据读取成功而封面失败时允许已有导入能力继续，不把两者混成导入 0 项。
7. 保持现有人工 Provider 匹配、标签审核与最终提交流程。

唯一基础验证：一个隔离的解析/报告测试，证明通用批量导出得到正确 entry 数量且错误阶段到达 UI 数据边界；视觉效果留给用户手动确认。

完成标准：T3 不再只展示“0 项”或泛化失败；导入映射与 probe 使用同一解析实现。

### 阶段 F：规则兼容、doctor 与回归案例

依赖：前述契约稳定。

修改入口：`template.py`、`registry.py`、`src/builder/health.py` / `roundtrip.py`；建议新增只读 doctor 入口及 `siteprobe/fixtures/adapter_contract/`。

执行步骤：

1. 定义 Core capability/version 与规则格式版本的兼容关系，避免每次加可选字段就要求全量升级。
2. doctor 默认只读，检查 target 捕获组、文档可提供性、transform 名称、必需字段与元数据一致性。
3. 将“读取配置即可判断”的问题与“需要网络才能判断”的问题分开；doctor 默认不访问网站。
4. 缺 adapter.json、旧 learned 字段等记录为可修复提示；未知 capability 为明确不可执行。
5. 升级命令必须显式执行，先预览差异、保存字节一致的恢复副本，再原子替换指定文件。
6. 不修改 installed 定制代码，不自动重新生成 local 规则，不删除未知配置字段。
7. 将用户本轮已确认的 Iwara 通用现象，以及已有 Jable/Bilinovel/Buondua 修复提炼为最小脱敏 fixture。
8. 每个 fixture 保存输入 URL、精简文档、用户确认值、预期结果和所覆盖能力；不保存 Cookie、令牌或完整浏览器 profile。
9. fixture 按能力标签选择，日常只跑本次变更相关的一个聚焦检查；语料库存在不构成全量回放授权。

唯一基础验证：一个临时旧规则 fixture，证明缺省兼容、doctor 不改原文件，以及显式升级可恢复；不扫描和升级真实用户规则。

完成标准：旧规则有清楚兼容结论，doctor 无副作用，后续每次修复可以沉淀为通用案例。

## 6. 批次拆分与实际验证原则

上述阶段是工作依赖，并非要求同一次任务跑六轮验证。后续每次用户授权一个实现批次时，先明确本批次交付范围和唯一检查入口；完成所有本批次补丁后运行该检查一次，通过即交付。

推荐第一批仅做阶段 A 的最小版本：诊断结构、核心空结果分类、单次 probe 报告与纯解析桥接。阶段 E 中的完整视觉优化暂后置。第一批应优先消除“已安装成功、后续才发现必需字段为空”的情况。

若阶段 A 跨 Python / TS 的检查桥接过大，先选择既有 TS 测试作为统一入口，以 stub Python acquisition + 临时真实导出执行 parser；不可通过测试存根声称真实 Chrome 或网站网络已验证。真实运行契约是产品能力，其可执行性与本次自动测试覆盖范围分别报告。

| 检查类型 | 执行规则 |
|---|---|
| 开发验证 | 每批一次最小聚焦检查；失败重跑同一入口 |
| Builder 产品内 probe | 一次有限运行，只检查用户本次创建的目标与一个代表作品 |
| 真实网站与 UI 验收 | 用户手动确认，失败后只修对应问题 |
| 全套测试、构建、打包、多站点回放 | 本方案不自动安排，需用户另行要求 |

验收报告必须写出检查输入、通过内容、skipped 内容和仍未验证的路径；禁止把“规则配置存在”写成“站点成功适配”。

## 7. 风险与处理方式

| 风险 | 处理 |
|---|---|
| Browser 更慢或占用 profile | 用户选择的采集计划、上下文复用、有限超时、明确 profile 占用错误 |
| 运行时 probe 带来额外请求 | 限一页/一作品/一封面，复用已获取文档，预算可见 |
| 偶发网络失败被误判为规则错误 | acquisition/media 与 selector 错误分开；保留草稿，允许用户明确重试 |
| 严格检查阻断可用但无封面的页面 | 必需字段与可选字段区别，warning 不自动升级为 error |
| 新身份规则使老作品变成新 ID | 不改既有身份；明确差异与用户选择，旧导出目录不自动重命名 |
| 多布局列表只部分读取 | 输出行数、可读数、空 ID 数、重复数和区块范围；不得声称完整覆盖 |
| 相对日期跨午夜漂移 | 一次运行冻结时钟；保留原值；日期级转换不虚构精确时间 |
| 旧规则升级丢未知字段 | 保留未知字段、明确 diff、字节恢复副本、原子写入 |
| T3 与 Core 强耦合 | 标准导出为边界，TS 纯解析留在 T3，独立 CLI 标明 import 未验证 |
| 新诊断泄漏登录信息 | 最小证据、URL 脱敏、禁止凭据与 profile 内容进入报告 |

## 8. 每个实现批次的交付清单

- [ ] 明确授权阶段、修改文件与本批次唯一检查入口。
- [ ] 新能力由声明式配置表达，没有新增 Core 的站点域名分支。
- [ ] 复用已有能力；用户现有规则和身份保持兼容。
- [ ] 必需字段失败、可选缺失、网络失败、未验证阶段分别报告。
- [ ] 新增或调整的案例只覆盖实际修复的通用现象。
- [ ] 完成一轮基础验证，记录真实结果，通过后停止。
- [ ] 明确用户应手动观察的新行为，避免重复派发旧验收事项。
- [ ] 未触碰正式库/assets、重启服务、自动部署或批量升级用户规则。
- [ ] 文档进度与代码实际完成程度一致。

## 9. 后续执行记录格式

每批在本文件下方追加简短记录，或链接现有 `siteprobe-execution-log.md` 中对应记录；不改写原始失败证据。

```text
批次 / 日期：
授权范围：
实施阶段与修改文件：
行为变化：
唯一基础检查及结果：
未验证内容：
用户手动反馈：
剩余事项：
```

## 10. 相关文档

- [文档索引](siteprobe-index.md)
- [总体架构指导](t3-siteprobe-architecture-guidance.md)
- [适配器分发架构](siteprobe-adapter-distribution-architecture.md)
- [现有正式完成计划](siteprobe-completion-plan.md)
- [T3 集成实施计划](siteprobe-t3-integration-plan.md)
- [历史执行记录](siteprobe-execution-log.md)

本方案是现有架构内的后续稳定化计划，不取代分发、Provider 匹配、数据模型与用户验证约束。实施优先顺序为 A → B → C → D → E → F；遇到用户实际失败，可选择其中最小相关能力批次先执行，并记录依赖是否具备。
