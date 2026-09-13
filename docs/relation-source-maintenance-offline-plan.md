# Relation 输入、Source 失效维护与手机离线模式实施方案

> For Hermes: this is a planning/handoff document. Implement it with fresh execution sessions, TDD, isolated databases, and explicit review gates. Do not stage, commit, rewrite history, or touch the formal library database unless the user separately authorizes execution.

**Goal:** 在大批量数据库升级/入库稳定后，依次交付严格的 relation 输入匹配、可审查且不删除旧 URL 的 Source 失效维护，以及分阶段的手机离线库与断线同步。

**Architecture:** Relation 输入使用“严格候选资格 + 独立排序”，不让相似度把无关短 Tag 带入候选。Source 维护继续以 Entry Content 为事实来源，在 Advanced 中通过站点适配器、外部别名目录和人工复核生成新增 `Source URL` Content；旧 Content 永不被替换或批量删除。离线核心采用本地快照 + durable Outbox + 显式同步协议；首选 Android WebView 薄壳复用现有 Vue 页面，PWA 作为需要可信 HTTPS origin 的可选交付方式。两种客户端共享同一同步协议，均不把客户端当成第二个 SQLite。

**Tech stack:** Vue 3, TypeScript, Hono, Zod, better-sqlite3/SQLite WAL, Vitest, Vite, IndexedDB；可选 Android WebView/Capacitor 薄壳；仅 PWA 路径需要 Service Worker。

---

## 0. 结论与推荐顺序

### 0.1 三项结论

1. Relation 输入
   - 第一版完全不使用 Levenshtein 或其他 fuzzy matching 决定候选资格。
   - 输入经 NFKC、trim、连续空白折叠和小写化后为空时，禁止请求和弹出候选。
   - 至少输入一个有效字符后才搜索。
   - 候选 canonical name 或允许的 alias 必须完整包含当前输入文本。
   - 排序只能改变合格候选的先后，不能让不包含输入文本的候选重新出现。

2. Source 失效维护
   - 同标题 + 同语言足以生成强候选，但不足以无审查地断言同一作品。
   - “青色之箱 / 蓝箱 / 青春之箱”这类不同译名可以在不使用 LLM 的情况下，通过 Bangumi、MangaDex、Wikidata、Kitsu 等目录的别名、罗马音、作者、作品形态和外部 ID 形成 alias graph。
   - 外部目录只提供证据，不直接写库；最终仍通过 Advanced 的逐项复核和一次显式 Commit 添加新的 `Source URL` Content。
   - 旧 Source URL 必须原样保留。失效状态是独立 annotation，不是删除或替换。

3. 手机离线模式
   - 技术上可行，但不是“加一个缓存开关”。它是新的客户端数据库和同步子系统。
   - 当前手机通过私有 IP 的 HTTP 访问，无法提供可靠的纯 PWA 冷启动离线模式；Service Worker 要求 secure context，`http://localhost` 例外不适用于手机访问电脑的 LAN IP。[23][27]
   - 当前优先研究“Android WebView 薄壳”：把现有 Vue build 静态打包进 App，只增加入口、持久离线存储、QR 配对和 LAN 同步桥，不重写原生 UI。[58][59]
   - Tailscale 只作为可选部署说明；T3 核心离线和同步在没有第三方账户时必须完整工作。
   - 应先做只读离线快照，再做少量安全写入，最后才开放离线创建 Entry 和媒体同步。

### 0.2 实施顺序

```text
大批量入库稳定门槛
  ↓
A. Relation 输入匹配（无 migration，低风险）
  ↓
B. Source 失效维护（核心功能，新增 workflow/status migration）
  ↓
C0. Android WebView 薄壳可行性 spike；纯 PWA 则先解决稳定 HTTPS origin
  ↓
C1. 只读离线库
  ↓
C2. 小范围离线修改与冲突处理
  ↓
C3. 离线创建 Entry + 媒体同步
```

Relation 和 Source 的设计/fixture 准备可以并行，但代码合入顺序仍建议 A → B。Writable offline 会同时触碰 API、数据库 migration、Content、Entry 创建和状态管理，必须等 B 稳定后再开始。

---

## 1. 开始实施前的数据库阶段门槛

以下全部满足后，才允许开始 A/B/C：

- 正式库 `apps/server/.data/library.db` 已停止大批量入库，Entry 数量不再持续变化。
- 已使用项目备份命令生成可识别的完整备份，并在隔离数据目录做过一次恢复验证。
- 当前最新 migration 全部成功；已发布 migration 文件不允许修改，只能新增下一编号。
- `db:doctor` 通过；foreign key、migration checksum、WAL 和媒体引用无异常。
- Source URL 规范化重复报告已审查：
  - 同一 Entry 内重复 URL；
  - 同一 URL 被多个 Entry 使用；
  - 无法解析的 HTTP(S) 文本；
  - 未识别 host。
- 媒体文件、缩略图及数据库引用抽样一致。
- 保存基线：Entry/Author/Tag/Content/Source-group 数量、数据库大小、查询延迟和正式服务版本。
- 当前工作树已有成果已由用户自行决定如何保存；执行 Agent 不得擅自 clean、stage 或 commit。

未来测试一律使用 `:memory:` 或隔离 data directory，不把正式库当测试沙箱。

---

# A. Relation / Tag 输入匹配

实施状态（2026-09-12）：Phase 1（A1–A4）已完成。Shared 严格 matching policy、request/response schemas、bounded repository、数据库 probe、两个只读 HTTP endpoints 和 GalleryApi client 已按 RED→GREEN 实现；无 migration、无正式库写入。A5–A7（SuggestionInput、编辑页接入、真实 IME/浏览器验收）保留为下一阶段，本阶段尚未替换现有 UI 输入。

## 2. 精确行为契约

### 2.1 候选资格

使用现有 `normalizeTag()` 语义：

```text
NFKC → trim → collapse Unicode whitespace → locale lowercase
```

NFKC 是既有持久化契约，不在本项目中改变；Unicode normalization 的定义可参考 Unicode UAX #15。[41]

规则：

```ts
activeQuery = normalizeTag(rawQuery)
queryIsActive = activeQuery.length > 0
eligible(candidate) = candidate.normalizedName.includes(activeQuery)
                   || allowedAlias.normalizedName.includes(activeQuery)
```

第一版禁止 fuzzy eligibility，无论输入长短都一样。以后如确实需要错字容错，应做成用户主动点击的 “Show near matches”，不能混入默认 relation 下拉框。

必须满足以下例子：

| 输入 | 应出现 | 不应出现 |
|---|---|---|
| 空字符串、普通空格、全角空格 | 无候选、无请求 | 所有 Tag/Author |
| `校` | `校园`、`校服`、`学校` | 不含 `校` 的高频 Tag |
| `校园` | `校园`、`校园生活` | `校服`、`学校` |
| `sch` | `School Life`、`High School`（字符串中含 `sch`） | 只有编辑距离接近但不含 `sch` 的词 |
| `school u` | `School Uniform` | `School Life` |
| `Ｃ＋＋` | 规范化后匹配 `C++` | 仅因相似度接近的词 |

说明：`校` 输入后允许 `学校`，因为“当前输入是必要子串”而不是强制候选必须以查询开头。排序时可把以查询开头的 `校园`、`校服` 放在 `学校` 前面。

### 2.2 排序

只对 eligible candidate 排序：

1. canonical 完全相同；
2. canonical 以 query 开头；
3. canonical 在 token/词边界开始匹配；
4. canonical 普通子串；
5. alias 完全相同；
6. alias 前缀/词边界/子串；
7. 当前 Gallery/Facet 使用次数降序；
8. 全库使用次数降序；
9. normalized name；
10. numeric ID。

Popularity 永远不能让不合格候选出现。

### 2.3 交互

- 未输入有效字符：dropdown 关闭，不显示 “No matches”。
- 输入有效字符：120–180ms debounce，最多返回 20 条。
- 新请求发出前 abort 旧请求；即使 abort 不生效，也用 request generation 丢弃迟到响应。
- `compositionstart` 到 `compositionend` 期间不请求、不提交；中文 IME 的 Enter 不能误选第一项。
- ArrowUp/ArrowDown 移动高亮。
- Enter：
  - 有明确高亮候选时选择它；
  - Tag creatable 模式且没有高亮候选时，提交当前文字；
  - Author ID-only 模式且没有选中候选时，不执行 link。
- Escape 关闭候选，不清空输入。
- Blur 只关闭，不允许继续沿用当前 “blur 自动链接第一名 Author” 的行为。
- 点击候选使用 pointer/mousedown 先于 blur 完成，避免 blur 先创建新 Tag。
- 已绑定 Tag/Author 必须在服务端 exclusions 后再取满 20 条，不能只在客户端过滤导致候选不足。

## 3. 范围与非目标

### 3.1 本次覆盖

- Entry 编辑：添加 Tag 到命名 Facet。
- Entry 编辑：添加 Tag 到 unnamed/default Facet。
- Entry 编辑：将当前 assignment retarget/rename 到已有或新 Tag。
- Author 编辑：添加和 retarget Producer Tag。
- Entry 编辑：链接已有 Author relation。
- Create-and-link Author 保持独立，但输入命中已有 Author/alias 时给出重复警告。

### 3.2 明确不改

- Gallery/Search 的全局搜索仍可保留长文本 fuzzy matching。
- `TagCombobox.vue` 和 `FacetFilterBar.vue` 属于 browse/filter 控件；空输入展示完整可选项是另一种交互，不随本项目改变。
- Entry Tag 与 Producer Tag 仍是两个独立 vocabulary。
- Entry 数值 ID、Author 数值 ID 和 Gallery 派生规则不变。
- 不增加数据库 migration；若真实性能基线证明内存候选扫描太慢，再单独评估 FTS/trigram/normalized Producer name。

## 4. API 与组件方案

### 4.1 Shared contract

建议新增：

- `packages/shared/src/search/suggestions.ts`
- `packages/shared/src/schemas/suggestions.ts`
- `packages/shared/src/index.ts` 导出纯函数和 schema。

DTO：

```ts
type RelationSuggestion = {
  id: number;
  name: string;
  matchedAlias?: string;
  sameContextUsageCount: number;
  totalUsageCount: number;
};
```

Query contract：

```text
q: trimmed non-empty string, max 200
limit: default 20, min 1, max 20
excludeIds: unique positive IDs, bounded count
entryType/facetId: optional ranking context, never silent hard filter
```

### 4.2 Server endpoints

```text
GET /api/suggestions/tags?vocabulary=entry|producer&q=...&limit=20
    &excludeIds=...&entryType=...&facetId=...

GET /api/suggestions/producers?q=...&limit=20&excludeIds=...
```

不要复用：

- `GET /api/search/tags`：这是全局搜索语义，不是 relation autocomplete。
- `POST /api/producers/query`：DTO 太重，而且当前会隐藏 workless Producer；relation picker 应允许重新链接数据库中仍存在但不可发现的 Author。
- `GET /api/producers` 和无界 `GET /api/entry-tags`：大库后不应继续作为编辑 autocomplete 数据源。

Server repository 建议新增 `apps/server/src/repositories/suggestion-repository.ts`：

- Entry Tag 只查询 `tags`；
- Producer Tag 只查询 `producer_tags`；
- Author relation 查询 `producers`，包括 workless Producer；
- Entry Tag alias 只使用 entry vocabulary alias；
- Author identity alias 只使用 producer partition `authors`；
- Producer-own-Tag 不得错误消费 Author identity alias；
- placeholder/空 canonical alias 被忽略；
- alias 命中返回 canonical numeric ID。

### 4.3 Web component

建议新增 `apps/web/src/components/SuggestionInput.vue`，而不是把异步 creatable 行为塞进现有 browse-only `TagCombobox.vue`。

模式：

```ts
mode: 'creatable-text' | 'id-only'
provider(query, excludeIds, signal): Promise<RelationSuggestion[]>
```

由同一个组件处理 dropdown、keyboard、IME、debounce、stale response 和 blur。业务父组件只负责：

- 构造 exclusions；
- Tag submit name；
- Author submit ID；
- mutation 成功后刷新 detail；
- mutation 失败时保留输入并显示错误。

## 5. A 项 TDD 实施步骤

### A1. 固定 shared matching policy

Files：

- Create `packages/shared/src/search/suggestions.ts`
- Create `packages/shared/tests/suggestion-matching.test.ts`
- Modify `packages/shared/src/index.ts`

RED cases：空白、全角字符、`校`、`校园`、英文部分词、NFKC、alias、确定性 tie-break。

未来命令：

```bash
npm exec --yes --package=pnpm@10.15.0 -- pnpm vitest run packages/shared/tests/suggestion-matching.test.ts
```

### A2. 定义 request/response schema

Files：

- Create `packages/shared/src/schemas/suggestions.ts`
- Modify `packages/shared/src/index.ts`
- Test `packages/shared/tests/api-contract.test.ts`

RED cases：blank q 失败、超长 q、limit 边界、重复/超量 exclusions、strict DTO。

### A3. 实现 bounded repository

Files：

- Create `apps/server/src/repositories/suggestion-repository.ts`
- Modify `apps/server/src/repositories/entry-tag-repository.ts` only if shared helpers must be reused
- Tests:
  - `apps/server/tests/integration/entry-tag-repository.integration.test.ts`
  - `apps/server/tests/integration/producer-tag-repository.integration.test.ts`
  - new `apps/server/tests/integration/suggestions.integration.test.ts`

RED cases：分离 vocabulary、workless Author 可链接、alias scope、不返回已选 ID、20 条上限、短 query 无 fuzzy leakage。

### A4. 暴露 HTTP 和 web client

Files：

- Modify `apps/server/src/http/app.ts`
- Modify `apps/web/src/api/gallery.ts`
- Test `apps/web/tests/gallery-api.test.ts`

先写 route/schema/client 失败测试，再写最小实现。

### A5. 完成 SuggestionInput

Files：

- Create `apps/web/src/components/SuggestionInput.vue`
- Create `apps/web/tests/suggestion-input.test.ts`
- Modify `apps/web/src/i18n.ts`

必须覆盖：IME、迟到响应、keyboard、blur、点击顺序、creatable 和 ID-only 两种模式。

### A6. 接入 Entry/Author 编辑面

Files：

- Modify `apps/web/src/GalleryApp.vue`
- Modify `apps/web/src/AuthorPage.vue`
- Test:
  - `apps/web/tests/gallery-app.test.ts`
  - `apps/web/tests/author-page.test.ts`

先只替换 relation 输入，不改页面布局或 browse filters。

### A7. 回归与文档

Files：

- Modify `docs/current-architecture.md`
- Modify `docs/http-api.md`
- Modify `docs/api-contracts.md`

未来验证：

```bash
npm exec --yes --package=pnpm@10.15.0 -- pnpm test
npm exec --yes --package=pnpm@10.15.0 -- pnpm run test:integration
npm exec --yes --package=pnpm@10.15.0 -- pnpm run typecheck
npm exec --yes --package=pnpm@10.15.0 -- pnpm run lint
npm exec --yes --package=pnpm@10.15.0 -- pnpm run build
git diff --check
```

真实浏览器验收必须包含桌面 Chrome 和手机宽度；用真实中文 IME 输入，而不是只用 programmatic `setValue`。

## 6. A 项最容易出错处

- 把 fuzzy score 当候选过滤条件，重新引入 `校园 → 校服`。
- 用 JavaScript UTF-16 `.length` 判断字符数，错误处理 surrogate pair/组合字符。
- Query 是空格时仍发请求，服务器返回热门/全部关系。
- IME 的 Enter 先触发 submit，再触发 compositionend。
- blur 在点击候选前先创建新 Tag。
- alias 命中后提交 alias 文本而不是 canonical ID/name。
- Producer Tag、Entry Tag、Author identity alias 三种 namespace 泄漏。
- 只在客户端过滤 selected IDs，导致 20 条结果被过滤成很少几条。
- rename 到 Entry 已有 Tag 时撞 `(entry_id, tag_id)`；必须由 repository 明确合并/拒绝，而不是冒出 SQLite 错误。
- 为了 autocomplete 改动全局 Search 排名，造成不相关回归。

## 7. A 项成功标准与回滚

成功标准：

- whitespace 永不弹候选；一个字符立即可用。
- `校园` 不出现 `校服`，且任何候选均可指出 canonical/alias 中哪段包含完整 query。
- 结果最多 20 条并稳定排序。
- IME、鼠标、键盘和 blur 不产生误提交。
- 编辑器不再加载全量 Author/Tag vocabulary。
- Browse filters 和全局 Search 行为不变。

回滚：A 项无 migration；可单独恢复旧输入组件/API 调用。服务端新增只读 endpoints 可先保留，不影响现有写入。

---

# B. Source 失效维护

## 8. 产品语义和不可变边界

当前 Source 仍是从每个 Entry 的任意 Content body 中提取 HTTP(S) URL 的 derived projection：

```text
entry_contents.content
  → URL extraction
  → known-site/host classification
  → Source groups and per-Entry source rows
```

本项目不能把“显示分组”误当成 Source 所有权。新增 Source 的唯一业务写入仍然是给 Entry append 一个 Content：

```text
content_type = "Source URL"
content = canonical target item URL
```

不可变边界：

- 原 Content 和原 URL 永不替换、改写或删除。
- Entry 数值 `id` 是身份；title 只是匹配证据。
- 不允许按 title 合并 Entry。
- 不开放批量删除 Source。
- 不重新引入 title-as-identity。
- 新 target URL 在同一 Entry 已存在时幂等 skip。
- 新 target URL 已属于另一个 Entry 时必须阻止并要求人工解决。
- 媒体、Tag、Author、Gallery 和 Entry title 不由本工作流修改。

## 9. “只靠标题是否足够”的答案

### 9.1 可用之处

对于多数站点搜索结果，当前 Entry title 与目标候选 title 在规范化后完全相同，再加相同语言，足以把结果列为强候选。若目标站只需补 URL，不必访问每个详情页，搜索结果页提供的 title、URL、language/thumbnail 已足够进行第一轮 retrieval。

### 9.2 不足之处

同标题可能代表：

- 原型短篇与后来的连载；
- 漫画与动画改编；
- 单行本、章节、合集和重制版；
- 同名但不同作者作品；
- 同作品不同语言/审校组页面；
- 搜索页误返回或同一个候选被多个 Entry 抢占。

因此“同标题 + 同语言”可以默认预选，但不能后台自动写库。至少要检查唯一性和冲突证据，并由用户显式 Commit。

## 10. 不使用 LLM 处理不同译名

### 10.1 推荐：外部目录 alias graph

实际探索证明这条路线可行：

- Wikidata 的 Blue Box 实体同时提供 English/Japanese/Chinese labels 和 `Ao no Hako`、`藍箱`、`青之箱`、`青色之箱` 等 aliases，并可携带其他目录的外部 ID。[21]
- Bangumi 对应条目的 infobox 包含 `蓝箱`、`青色之箱`，并在本地化版本信息中包含 `青春之箱`；同时提供作者、作品形态和话数，可区分原型短篇与连载。[49]
- MangaDex 搜索结果提供主标题、`altTitles`、original language、status、content rating 和 Author/Artist relations。[3]
- Kitsu 搜索结果提供 canonical title、多语言 titles 和 abbreviated titles，但同名原型短篇与连载仍可能返回两个记录，不能只拿第一项。[4][50]
- AniList 声明提供免费的 public API，但本次 2026-09-12 实测 GraphQL endpoint 返回临时 403，因此只能是可选 provider，不能成为基线依赖。[1][15]
- MyAnimeList 官方 API 需要 client ID/API key，不适合作为默认零配置路径。[8]

推荐 provider 顺序：

1. Bangumi：中文/Japanese manga/anime aliases、作者和形态证据。
2. MangaDex：漫画多语言 altTitles 与 Author/Artist。
3. Wikidata：跨语言 labels/aliases 与跨库 ID 桥接。
4. Kitsu：Romaji/English/Japanese 补充。
5. AniList：服务恢复时可选。
6. MAL：用户以后主动配置 key 才启用。

Provider failure 只能降低证据，不能让整个 run 失败。

### 10.2 本地 deterministic normalization

Title variant generation 只做保守转换：

- NFKC；
- trim / collapse spaces / case-fold；
- punctuation 和全半角统一；
- 保留原始完整标题；
- 对明确分隔符生成候选片段，例如 `Romaji | 中文译名`，但不丢弃完整标题；
- Traditional/Simplified 可以使用项目锁定的 OpenCC 产生额外 query variant；不能依赖全局 Python；
- 不自动删作者、数字、卷号、`OVA`、`oneshot` 等可能决定作品身份的 token；只把这些做结构化 evidence。

罗马音是很强的跨译名桥梁，但仍需防止原型短篇/连载同名。

### 10.3 可选第二证据：缩略图 perceptual hash

若目标搜索结果直接提供 thumbnail，可下载缩略图并与当前 cover 计算 pHash/dHash：

- 只能作为 supporting evidence；
- 水印、裁切、不同卷封面会造成 false negative；
- 同系列共用封面会造成 false positive；
- 第一版可以不实现，先记录 `thumbnailUrl`，待真实 review 数据证明有价值再加。

### 10.4 不采用的方案

- 不使用 LLM/embedding 做 title identity。
- 不抓通用搜索引擎结果作为核心依赖。
- 不对用户输入的任意 homepage 猜测搜索参数或自动遍历全站。
- 不把 edit distance/Jaccard 分数越过阈值直接判为同一作品。
- 不为了判断每个候选而 probe 整个详情页；模糊项直接人工复核。

## 11. 为什么任意 homepage 不能自动搜索

不同站点可能使用：

- GET query、POST form、GraphQL 或内部 JSON API；
- JavaScript hydration；
- 登录/cookie；
- CAPTCHA、Cloudflare 和速率限制；
- 不同分页、语言、canonical URL 和搜索结果结构。

因此 UI 可以接受 target homepage，但 server 只能把它映射到已实现的 adapter。未知站点应显示 “Unsupported target; adapter required”，并保留逐项手动 URL 输入，不能启动通用 crawler。

Target network 请求必须由本地 server 发起，避免浏览器 CORS 和让 rate limit 集中管理。由于 homepage 来自用户输入，必须防 SSRF；最安全的第一版是 adapter hard allowlist，而不是自由 fetch。OWASP 的 SSRF 指南可作为实现检查表。[29]

## 12. Source adapter 和 catalog provider contract

建议目录：

```text
apps/server/src/source-maintenance/
  source-search-adapter.ts
  adapter-registry.ts
  adapters/<target>.ts
  title-variants.ts
  evidence.ts
  catalog-provider.ts
  catalogs/bangumi.ts
  catalogs/mangadex.ts
  catalogs/wikidata.ts
  catalogs/kitsu.ts
  job-manager.ts
  repository.ts
```

Target adapter：

```ts
interface SourceSearchAdapter {
  key: string;
  displayName: string;
  acceptsHomepage(url: URL): boolean;
  canonicalizeHomepage(url: URL): URL;
  canonicalizeItemUrl(url: URL): string;
  search(input: {
    title: string;
    language?: string;
    signal: AbortSignal;
  }): Promise<SourceCandidate[]>;
  rateLimit: { concurrency: number; minDelayMs: number };
}
```

Candidate：

```ts
type SourceCandidate = {
  url: string;
  title: string;
  language?: string;
  creators?: string[];
  workKind?: string;
  thumbnailUrl?: string;
  adapterEvidence: Record<string, unknown>;
};
```

Catalog provider：

```ts
interface TitleCatalogProvider {
  key: string;
  lookup(query: TitleVariant, signal: AbortSignal): Promise<CatalogWork[]>;
}

type CatalogWork = {
  providerId: string;
  titles: Array<{ value: string; language?: string; kind: 'title' | 'alias' | 'romaji' }>;
  creators: string[];
  workKind?: string;
  externalIds: Record<string, string>;
};
```

每个 adapter/provider 必须有保存的 HTML/JSON fixture；测试禁止访问实时网络。

## 13. Retrieval、Eligibility、Evidence 分层

### 13.1 Retrieval

对每个 Entry：

1. 构建本地 title variants。
2. 用原始 title/明确片段查询 catalog providers，收集有限 alias set。
3. 去重并限制 query variants，例如最多 6 个。
4. 依次调用 target adapter 搜索，合并 canonical URL 相同的候选。
5. 保存原始 provider/adapter evidence，供 review 和复现。

### 13.2 Candidate eligibility

Target 搜索可能自身使用 fuzzy，但 T3 本地必须再次过滤。候选至少满足一项：

- normalized target title 与 Entry 某个可信 title/alias 完全相同；
- target title 和 Entry title 被 catalog 解析到同一个 canonical provider ID；
- exact Romaji title 且 creator 不冲突；
- 用户手动输入 URL。

只靠相似度的候选不能进入自动预选，但可以留在 “Other search results” 供人工展开。

### 13.3 Evidence bands，不使用单一魔法阈值

`exact-safe`：

- target title 精确命中 canonical/可信 alias；
- 在该 Entry 候选中唯一；
- target URL 未分配给其他 Entry；
- language/work kind/creator 没有冲突。

`strong-review`：

- catalog canonical ID 相同，且 creator 或 work kind 至少有一项支持；或
- exact Romaji + creator 支持；或
- 同标题 + 同语言，但作品形态信息缺失。

`ambiguous`：

- 多个 target 候选共享同一标题；
- 仅有翻译 alias，无法区分 oneshot/series/adaptation；
- 只有 cover hash 或部分标题支持。

`conflict`：

- creator、work kind、language、target URL ownership 等出现明确冲突。

`no-match/error`：无候选、provider unavailable、adapter parse 失败、rate limit exhausted。

规则：

- `exact-safe` 可默认勾选，但仍不自动写库。
- `strong-review` 和 `ambiguous` 必须逐条确认。
- `conflict` 默认不可提交，除非用户手动 URL 并再次确认。
- 任何 band 都不能绕过全库 URL ownership 检查。

## 14. 数据模型：保留 derived Source，新增 annotation/workflow

本功能本身仍不需要把 Source membership 物化成第二份事实。Advanced 页面是低频管理操作，先继续从 Content 派生；只有真实测量证明扫描无法接受时，才单独设计可重建 cache。

使用下一可用 migration 编号，不在计划中硬编码 `014`，因为实施前可能已有其他 migration。

建议表：

```sql
CREATE TABLE source_statuses (
  source_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active', 'invalid')),
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE source_maintenance_runs (
  id INTEGER PRIMARY KEY,
  origin_source_key TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  adapter_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'running', 'paused', 'review', 'committed', 'cancelled', 'failed')
  ),
  mark_origin_invalid INTEGER NOT NULL DEFAULT 0 CHECK (mark_origin_invalid IN (0, 1)),
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE source_maintenance_items (
  run_id INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  entry_title_snapshot TEXT NOT NULL,
  origin_urls_json TEXT NOT NULL,
  query_titles_json TEXT NOT NULL DEFAULT '[]',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (
    decision IN ('pending', 'accept', 'skip', 'conflict', 'error')
  ),
  selected_url TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_text TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, entry_id),
  FOREIGN KEY (run_id) REFERENCES source_maintenance_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) WITHOUT ROWID;
```

注意：

- `source_statuses` 是 source-group annotation；Content 仍是真实 membership。
- `state=invalid` 只在 UI 加 badge/排序，不隐藏也不禁用旧 URL。
- run/item 保存网络结果和人工决策，保证 server restart 后可继续。
- JSON 必须经 shared Zod schema parse，不允许任意对象直接传播。
- 若未来需要单 URL 失效状态，再新增 `entry_source_annotations(entry_id, normalized_url, ...)`；第一版不要同时实现两级状态。

## 15. Advanced UI 工作流

建议把新 child panel 挂到 `apps/web/src/AdvancedEditingPage.vue`，不要继续把全部逻辑堆入该大组件。

### Step 1 — Origin

- 展示 Source library：name、hosts、Entry count、当前 active/invalid。
- 选择一个 origin source group。
- Checkbox：`Commit 后将此 Source group 标记为 invalid`。
- 明确说明这不会删除或隐藏旧 URL。

### Step 2 — Target

- 输入 target homepage。
- Server 只进行 adapter probe：规范化 origin、显示 adapter 名称和 capability。
- 未支持站点停在这里，提示需要 adapter；可继续使用 manual URL review，不可 generic crawl。
- 显示预计 Entry 数、请求上限和最短预计时间。

### Step 3 — Search job

- Start / Pause / Resume / Cancel。
- 显示 processed / matched / ambiguous / no-match / errors。
- 每 host 默认 concurrency 1–2，并遵守 `Retry-After`；不要指数并发。
- server 每完成一小批持久化 checkpoint，不在网络 fetch 期间持有 SQLite transaction。

### Step 4 — Review

每行显示：

- Entry ID、current title、Author、language、old URL；
- target title、target URL、可选 thumbnail；
- exact title / alias / Romaji / author / language / work-kind / URL ownership evidence badges；
- `Open target`、候选 radio、manual URL、Skip；
- evidence band 和冲突原因。

过滤器：exact-safe、strong-review、ambiguous、conflict、no-match、error、already-present。

可以提供显式 `Select all exact-safe`，但不能自动 Commit。

### Step 5 — Commit

Commit 前摘要：

- 将新增多少 Content；
- 幂等 skip 多少；
- unresolved 多少；
- 是否标记 origin group invalid；
- 备份路径。

使用项目现有的 two-click arm pattern。第一次 arm，第二次执行。

## 16. Commit 契约

Network search 与正式写入严格分离。Commit 之前：

1. 重新读取每个 accepted Entry。
2. 验证 Entry 仍存在。
3. 比较 `entry_title_snapshot` 和 origin URL snapshot；任何 stale item 返回 409，整批不写。
4. 规范化 selected URL。
5. selected URL 必须属于 adapter target origin。
6. 同批不同 Entry 不能选择同一 normalized URL。
7. 全库扫描：
   - 同 Entry 已有 URL → idempotent skip；
   - 其他 Entry 已有 URL → conflict，整批不写。
8. 创建正式数据库备份。
9. 单一 SQLite transaction：
   - 为每个 accepted Entry append 一个 `Source URL` Content，sort order 在末尾；
   - 如 checkbox 开启，upsert `source_statuses` 为 invalid；
   - 将 run 标为 committed。
10. transaction 后重新 derive Source rows，返回 created/skipped/conflicts counts。

Commit 中不执行网络访问、媒体下载、旧 URL 删除或 Entry merge。

## 17. API 方案

```text
GET    /api/source-library
PATCH  /api/source-statuses/:sourceKey

POST   /api/source-maintenance/runs
GET    /api/source-maintenance/runs/:runId
POST   /api/source-maintenance/runs/:runId/start
POST   /api/source-maintenance/runs/:runId/pause
POST   /api/source-maintenance/runs/:runId/resume
POST   /api/source-maintenance/runs/:runId/cancel
GET    /api/source-maintenance/runs/:runId/items?page=&pageSize=&state=
PATCH  /api/source-maintenance/runs/:runId/items/:entryId
POST   /api/source-maintenance/runs/:runId/commit
```

所有 request/response 放到独立 `packages/shared/src/schemas/source-maintenance.ts`。IDs、URL、分页、JSON evidence 和 state 使用 strict schemas。

若 server 在 running 中退出：启动后将该 run 标为 paused；用户显式 Resume，从未完成 item 继续。不要启动 daemon 自动访问外站。

## 18. Network、安全与礼貌访问

- 仅允许 `https:` target，除非某个 hard-coded adapter 明确证明必须 HTTP。
- Adapter allowlist 限定 hostname/port；拒绝 credentials、fragment、非标准危险端口。
- 每次 redirect 重新校验 scheme/host/IP，限制 redirect 次数。
- 禁止 loopback、private、link-local、metadata IP 和本机文件协议；防 DNS rebinding。
- 限制 response bytes、解压后大小、Content-Type、超时和总请求数。
- 识别 429/503 和 `Retry-After`；持久化 pause，不无限 retry。
- 固定有说明性的 User-Agent；Bangumi 官方专门记录了 User-Agent 要求。[32]
- 尊重目标站 robots/terms；robots protocol 参考 RFC 9309。[28]
- 不绕 CAPTCHA、不复用用户浏览器 cookie、不记录凭据。
- 日志只记录 adapter、status、timing、entry ID 和脱敏 URL；凭据一律 `[REDACTED]`。

## 19. B 项 TDD 实施步骤

### B1. 锁定 Source/status/run schemas

Files：

- Create `packages/shared/src/schemas/source-maintenance.ts`
- Modify `packages/shared/src/index.ts`
- Test `packages/shared/tests/api-contract.test.ts`

### B2. 新增 immutable migration

Files：

- Create next migration under `apps/server/src/database/migrations/`
- Modify `apps/server/src/database/migrations.ts` only as required by existing loader conventions
- Modify `apps/server/src/database/probe.ts`
- Modify `apps/server/src/database/doctor.ts`
- Test `apps/server/tests/integration/migration-runner.integration.test.ts`

必须测试空库、已填充库、重复 apply、checksum 和 rollback/restore。

### B3. Source status overlay

Files：

- Modify `apps/server/src/repositories/source-library-repository.ts`
- Create `apps/server/src/source-maintenance/repository.ts`
- Extend existing Source integration tests, currently colocated with Entry merge/source tests.

先证明 status 不改变 derived membership 和 URL。

### B4. Title variant 与 evidence engine

Files：

- Create `title-variants.ts`, `evidence.ts`
- Create unit tests with `青色之箱/蓝箱/青春之箱/アオのハコ/Ao no Hako/Blue Box` fixtures。

测试 oneshot/series、同名不同作者、同 URL 多 Entry 和 alias collision。

### B5. Catalog providers（fixture-first）

依次实现 Bangumi → MangaDex → Wikidata → Kitsu。每个 provider：

1. 保存最小 JSON fixture；
2. 写 parser RED test；
3. 写最小 HTTP client；
4. 测 timeout、429、malformed JSON、missing fields；
5. live endpoint 只做单条手动 smoke，不进入自动测试。

### B6. 第一目标站 adapter

这是唯一需要用户补充的执行前输入：

- origin Source group；
- target homepage；
- 目标站可复现的 3–5 个搜索 URL/fixture：正常、无结果、多结果、特殊字符、分页。

没有这些信息时，Agent 必须停在 adapter contract/fixture scaffold，不能猜站点。

### B7. Resumable job manager

实现 bounded concurrency、pause/resume/cancel、checkpoint 和 restart→paused。使用 fake adapter + fake clock 做确定性测试。

### B8. Commit service

先写 integration RED cases：

- old Content remains byte-for-byte unchanged；
- accepted candidate append `Source URL`；
- same Entry duplicate idempotent skip；
- cross-Entry duplicate aborts all；
- duplicate selected URL inside run aborts all；
- stale title/origin snapshot 409 and zero writes；
- one invalid URL causes zero writes；
- group invalid state commits atomically；
- injected failure rolls back all new contents/status；
- backup failure prevents transaction。

### B9. HTTP/web API/Advanced panel

Files：

- Modify `apps/server/src/http/app.ts`
- Modify `apps/web/src/api/gallery.ts`
- Create `apps/web/src/SourceMaintenancePanel.vue`
- Modify `apps/web/src/AdvancedEditingPage.vue`
- Modify `apps/web/src/i18n.ts`
- Add focused web/integration tests.

### B10. 隔离 QA

- Clone/seed a temporary DB with duplicate titles、translation aliases、oneshot/series、workless Author、unknown host 和 malformed Content。
- Fake adapter verifies full wizard without network。
- Staging/live adapter只搜索少量授权样本，不 commit 正式库。
- 真正执行 batch 前再次备份、doctor 和 preview counts。

## 20. B 项最容易出错处

- 把 Source projection 误做成第二套必须双写的 Source ownership table。
- 把 target homepage 当任意 fetch URL，形成 SSRF。
- Target site 搜索 HTML 改版后 parser 默默返回错误 URL，而不是 fail closed。
- 使用第一条搜索结果或最高 fuzzy score直接写库。
- `青色之箱` 同时命中原型短篇和连载；忽略 work kind/page count。
- 同一个 target URL 被批量分配给多个 Entry。
- URL query 参数顺序、fragment、trailing slash 规范化不一致。
- 只检查 `Content.type === Source URL`，漏掉其他 Content body 中已经存在的 URL。
- 搜索过程中长时间持有 SQLite transaction。
- server restart 后自动继续外网访问，而用户以为已停止。
- Commit 时发现 Entry/title/source 已变化仍继续写。
- 标记 invalid 时把旧 URL 隐藏、删除或禁止点击。
- Provider outage 让全部候选消失，且未保留已完成结果。
- 外部 API 结果、凭据或成人内容标题泄漏进普通日志。
- 修改已发布 migration 或在正式数据库做 destructive QA。

## 21. B 项成功标准和回滚

成功标准：

- 用户可选 origin Source、输入受支持 target homepage、暂停/恢复搜索并逐项复核。
- 不同译名可通过 alias graph 生成候选且 evidence 可解释。
- 未匹配和歧义项不会阻止已审查结果保存，但一次 Commit 对 selected set 保持原子。
- 每个新增 target URL 对应一个新 `Source URL` Content；旧 Content 不变。
- invalid 只是状态 annotation；批量删除没有入口和 API。
- 网络失败、重启和 429 可恢复；Commit 重试幂等。

回滚：

- 未 Commit run 可直接取消/删除 workflow rows。
- 已 Commit 的新 Content 不在自动回滚中批量删除；需要单独生成反向审查清单，由用户逐项确认。
- `source_statuses` 可切回 active，不修改 Content。
- migration 不回写/删除；代码回滚时新表保持惰性无害。

---

# C. 手机离线库与断线同步

## 22. 当前状态与可行性

当前应用是同源 Vue/Hono/SQLite online-first 应用：

- 手机依赖电脑本地 server；
- 无 manifest、Service Worker、IndexedDB、outbox、change feed、revision 或 idempotency protocol；
- `localStorage` 只适合小型设备偏好；
- Entry 创建目前是多次 API 调用链，尚不是可重试的原子 sync command；
- assets 使用数据库 ref + filesystem，不能把全部原图直接塞进快照。

结论：

- “离开 Wi-Fi 后继续浏览离线库”可以先实现。
- “离线新增 Entry，回家自动合并”也能实现，但必须先增加稳定 identity、operation receipts、change journal、冲突 UI 和媒体 staged upload。
- 不能用 Service Worker 静默缓存/重放所有 POST；它不知道 domain transaction、依赖和冲突。

IndexedDB 适合存大量结构化数据和 Blob。[24] Background Sync 在部分主流浏览器仍不是 Baseline，因此只能做可选增强，主路径必须是 app launch/focus/显式 Sync。[25]

## 23. Phase C0 — 移动外壳与连接方式决策

### 23.1 当前推荐：WebView 薄壳，而不是重写原生 App

当前暂定方案：

```text
T3 Mobile APK
  ├─ WebView 加载同一份 Vue UI/build
  ├─ 本地 offline snapshot
  ├─ durable Outbox
  ├─ QR/一次性码配对
  └─ 仅在 App 前台且家庭服务器可达时同步
             ↕
Desktop T3 Server + authoritative SQLite
```

Android 官方支持将 HTML/JavaScript/CSS 静态编译进 App，并通过 WebView 加载，不需要从互联网取得页面。[58] Capacitor 是可选包装工具；不因此重写 Gallery、Entry、Author、Tag 或编辑 UI。[59]

薄壳原生职责严格限制为：

- 启动同一 Vue 页面；
- 保存配对信息、离线快照、Outbox 和待上传 Blob；
- 扫描桌面端二维码；
- 提供受控的 LAN 网络桥；
- 提供 App/Server/sync protocol 版本协商；
- Source 外链继续交给系统浏览器。

不申请或实现：开机自启、常驻后台、VPN、Accessibility、定位、精确闹钟、后台扫描或静默常驻同步。Android 后台限制因此只会延迟同步，不得造成已持久化 Outbox 丢失。[60]

### 23.2 纯浏览器 PWA 的证书边界

Service Worker 只在 HTTPS secure context（开发时 localhost 例外）可用；手机访问 `http://<PC-LAN-IP>:8765` 不满足。[23][27]

桌面端可以自动生成 local CA/server cert、启用 HTTPS 并显示二维码，但普通网页或 App 不能静默把 CA 加入手机系统信任；手机仍必须在系统证书界面显式确认。[56]

纯 PWA 可选路径：

1. Tailscale HTTPS / Serve：低维护，但只是用户自行选择的第三方部署方式。[37][38]
2. 纯 LAN HTTPS：本地 CA + 稳定 hostname；T3 可以自动完成电脑端生成/配置和手机引导，但不能绕过手机的信任确认。
3. 公共 CA：不需要手机装 CA，但需要用户拥有真实域名和 DNS 验证，或重新引入托管服务。
4. 三者都不接受：只能支持页面保持打开期间的临时 offline，不能宣称纯浏览器可 cold-start。

Tailscale、Headscale、反向代理和用户自有域名均不得进入业务层依赖。同步 API 对 transport 保持中立。

### 23.3 App 内证书与 LAN 连接

WebView 薄壳不需要修改手机全局信任库。可选实现顺序：

1. Spike/MVP：沿用既有 trusted-home-LAN threat model，在 App 中显式允许仅配对私网地址的 HTTP；
2. 正式增强：桌面首次运行生成证书，QR 带 endpoint、`libraryId`、一次性配对码和证书 fingerprint；App 的 native network layer 只信任已配对证书/公钥；
3. 证书变化、library identity 变化或 endpoint 指向非私网时 fail closed，要求重新配对。

Android 支持 App 范围的自定义 trust anchors、cleartext policy 和 certificate pinning；这些设置不会把 T3 CA 加入整台手机的全局信任。[57]

不要把固定私钥或通用 CA 私钥打包进公开仓库/APK。每个 Desktop library 独立生成身份。

### 23.4 不采用的“外部 Chrome + helper App”设计

以下设计只记录为拒绝方案：

```text
Helper App 在手机启动 localhost server
→ 再打开外部 Chrome
```

它虽然可利用 localhost 的特殊信任待遇，但 Chrome 在前台时 helper App 转入后台；为了持续提供页面通常需要 foreground service、常驻通知并面对厂商电池管理。它恰好引入本方案希望避免的后台存活风险。

单纯“App 只打开 `http://PC-IP:8765` 后退出”也不能解决离线冷启动或存储：Chrome 的 IndexedDB 属于 Chrome 的 origin，helper App 无法代管。

因此正式候选是内嵌 WebView：视觉和交互仍是网页，只是网页运行在可持久化、可离线冷启动的 App 容器中。

### 23.5 C0 disposable spike gate

在修改正式 sync schema 前，先做独立可丢弃 spike，只验证：

1. 当前 Vue production build 能在 WebView 原样打开；
2. 飞行模式下能 cold launch；
3. force-stop/重开后测试 snapshot 与一条 outbox item 仍存在；
4. 同一 Wi-Fi 下能访问隔离的 T3 health endpoint；
5. QR 配对信息能持久化；
6. 不申请后台/通知/广泛存储权限也能完成以上流程；
7. App 被系统终止只延迟同步，不损坏本地事务或丢 Outbox。

Spike 禁止连接正式数据库；只用 fixture 或隔离 server。任何一项失败都先给出 `VALIDATED / PARTIAL / INVALIDATED` verdict，不继续搭建完整移动工程。

### 23.6 若选择 PWA 的 foundation

Files likely：

- Modify `apps/web/vite.config.ts`
- Modify `apps/web/index.html`
- Modify `apps/web/src/main.ts`
- Create manifest、icons、service worker registration/update UI
- Add HTTPS/pairing support to launcher/server config as separately approved

Service Worker 第一版只负责：

- versioned app shell；
- navigation fallback；
- 明确下载的 immutable hashed thumbnails；
- network-first `/api/sync/capabilities`。

它不缓存 mutation，不拥有业务快照。WebView 路径不要求 Service Worker；同一离线 repository/snapshot/outbox 应能在两个壳层复用。

## 24. Phase C1 — read-only atomic offline snapshot

### 24.1 Server API

```text
GET /api/sync/capabilities
GET /api/sync/snapshot?media=none|thumbnails
```

Capabilities：

```text
libraryId
syncEpoch
sqliteSchemaVersion
snapshotFormatVersion
syncProtocolVersion
serverBuild
featureFlags
```

Snapshot：

```text
libraryId / syncEpoch / snapshotSeq / generatedAt
Entries and details
Authors and Entry relations
Tags / Sections / Facets / assignments
Ratings / slots
Contents
Collections / memberships
Directories
View later / gallery partition settings
media manifest
counts + checksum
```

Gallery、Source、dominant Author Gallery 和 cards 继续是 projection，不在离线库制造所有权表。

### 24.2 Snapshot consistency

- 在同一个 SQLite read transaction 中确定 snapshot 数据和 `snapshotSeq`。
- 不允许“分页导出完成后再取 cursor”，否则会漏掉导出过程中发生的更新。
- Client 写入一个新的 IndexedDB generation。
- 全部 records、counts 和 checksum 校验成功后，原子切换 `activeGeneration`。
- Quota/解析/断网失败时保留上一 generation。
- 初次下载默认 metadata + thumbnails；不自动下载全部原图。

### 24.3 Client repository 与 shell boundary

离线业务模块保持 Web-first，并由 PWA 或 WebView shell 共同调用：

```text
apps/web/src/offline/db.ts
apps/web/src/offline/snapshot.ts
apps/web/src/offline/library-repository.ts
apps/web/src/offline/connectivity.ts
apps/web/src/offline/media-cache.ts
apps/web/src/offline/status-store.ts
```

如果 C0 spike 通过，再决定 wrapper 路径（例如 `apps/mobile/`）；wrapper 不复制 Vue 页面，只消费同一 production build。原生桥只暴露最小能力：pairing、network request、private file/blob persistence 和 external-link open。不要在 JSBridge 暴露任意文件、shell 或 URL 加载能力。

UI 查询通过 repository abstraction 选择：

- online server result；
- offline IndexedDB snapshot；
- 后续阶段的 snapshot + optimistic outbox overlay。

禁止把 `POST /api/entries/query` response cache 当完整离线数据库。

### 24.4 C1 功能范围

先支持：

- Gallery/Entry/Author/Tag/Collection 浏览；
- 本地标题/Tag/Author 搜索；
- Recently viewed（device-local overlay）；
- Random；
- View later 只读。

复杂 Facet、rating、usage 排序在 parity tests 通过后再开放。所有写按钮显示明确的 `Requires connection`。

## 25. Phase C2 — 安全的离线更新

### 25.1 最小 identity/migration

保留现有 numeric ID 用于 URL、SQL join 和 filesystem。为需要同步的实体增加不可变 `sync_uid`；第一批只覆盖：

- Entries；
- Entry Contents。

同时新增：

- singleton sync metadata (`library_id`, `sync_epoch`, protocol version)；
- append-only change journal with monotonic sequence；
- tombstones；
- operation receipts keyed by `op_id` + request hash；
- resource version/revision。

以后开放 Author/Tag/Collection offline mutations时，再扩展相应 stable identity；不要第一版一次改遍所有表。

### 25.2 API

```text
GET  /api/sync/changes?after=<cursor>&limit=<n>
POST /api/sync/operations
POST /api/sync/ack
```

Operation：

```ts
type SyncOperation = {
  opId: string;          // client UUID, idempotency key
  clientId: string;
  entityKind: string;
  entityUid: string;
  operationKind: string;
  baseVersion: number | null;
  baseValues: unknown;
  payload: unknown;
  clientCreatedAt: string;
};
```

Result：

```text
applied | duplicate | conflict | rejected
serverSeq
currentVersion
canonicalRecord
optional numeric-ID mapping
```

### 25.3 同步顺序

1. Probe capabilities；验证 `libraryId`、`syncEpoch` 和 protocol。
2. Pull 到当前 high-water mark。
3. 在 client view 上保留 outbox optimistic overlay，不覆盖本地意图。
4. 按 client 顺序 Push pending operations。
5. Server 对每项独立 transaction，返回 per-operation result。
6. 再 Pull 到每个 result 的 high-water mark。
7. 收到 ACK 且 pull 看见 canonical state 后，才删除 outbox item/blob。

不把 `navigator.onLine` 当真相；在 app launch、focus/visibility、成功 health probe 和用户点击 Sync 时运行。Background Sync 只能锦上添花。[25]

### 25.4 Idempotency

- receipt 保存 `opId + canonical request hash + original result`。
- 同 opId、同 body 重试 → 返回原结果。
- 同 opId、不同 body → conflict。
- mutation 与 change-journal 写入在同一 SQLite transaction。
- lost response 后重试不能重复创建 Entry、增加 like/view 或重复 Content。

### 25.5 第一批允许离线的 mutation

- Entry title/upload date/page count 的 scalar patch；Entry type 不允许。
- Rating final value（只有在 slot/layout version 稳定后）。
- Content append 和 scalar update；reorder/delete 不允许。
- View later 的显式 add/remove desired state。
- like/view 使用 unique event/delta，而不是覆盖 aggregate count。

初期 online-only：

- 所有 delete；
- Entry/Producer merge、multi-author conversion、title shortening；
- Gallery type 创建/修改；
- Tag/Author link、rename、move；
- Section/Facet/rating-slot/layout/template 修改；
- Collection/Directory 结构修改与删除；
- taxonomy；
- Import、Source maintenance batch；
- 现有媒体 replacement。

## 26. Conflict 规则

- Scalar patch：比较 base/local/server；不同字段可自动合并，同字段变化进入可见 conflict，不 silent last-write-wins。
- Rating：server 已是同一 final value → idempotent；不同 value 且 version 变化 → conflict。
- Membership：以后使用 desired state，不用 toggle；server 已是 desired state → success。
- Content append：content sync UID + opId 保证幂等。
- Delete/tombstone：删除优先于旧 edit；绝不隐式复活。
- Entry title 不作为 identity 或去重依据。
- wrong `libraryId`：停止同步，要求用户选择另一个离线库或清除 cache。
- wrong `syncEpoch`：先保护/导出 outbox，再 full resnapshot，不丢未同步工作。
- 备份 restore 必须 rotate `syncEpoch`，因为 change sequence 可能回退。

## 27. Phase C3 — 离线创建 Entry

### 27.1 Entry identity

- Client 生成 UUID。
- UI/IndexedDB 临时 key 使用 `local:<uuid>`，不用负 numeric ID。
- 同一个 UUID 成为 server `sync_uid`。
- Server 正常生成 numeric ID，response 返回 mapping。
- Client 在一个 IndexedDB transaction 中更新 Entry、relations、outbox dependency 和 route mapping。

同 title + 不同 UUID 是两个合法 manual Entries；不做 title dedup。

### 27.2 首版 composer

允许：

- title；
- 从 snapshot 选择已有 Gallery/type；
- upload date；
- page count；
- 可选现有 rating；
- 可选 View later；
- 可选 cover/preview blobs。

不允许离线创建新 Gallery、复杂 layout、Author/Tag relations 或 Import batch。

在开放 C3 前，应先把当前在线多请求 create chain收敛成一个可重试的 server command（metadata/ratings/view-later 原子；media 独立）。

### 27.3 Media sync

```text
PUT /api/sync/media/:uploadId
Idempotency-Key: <operation UUID>
metadata: entryUid, kind, ordinal, mime, byteLength, sha256
body: Blob
```

Client：

- Blob 存 IndexedDB，记录 MIME、size、SHA-256 和 Entry-create dependency；
- server ACK + subsequent pull 之前不删除；
- quota 不足时禁止选择更多媒体，但不能删 outbox。

Server：

- 校验实际 bytes、magic bytes、MIME、dimension、size 和 hash；
- 先写 staging file；
- atomic rename；
- 生成 thumbnail；
- 在 transaction 中更新 DB ref/journal/receipt；
- same key+same hash 返回旧结果，same key+different hash 冲突；
- 安全保留期后清理 abandoned staging。

## 28. Offline UX、容量与隐私

Settings 新增：

- Offline library 状态、last sync、pending/conflict/error 数；
- Download/Refresh；
- metadata only / thumbnails / selected originals；
- Sync now；
- conflicts；
- export pending work；
- remove offline library。

容量：

- 请求 `navigator.storage.persist()`，但浏览器可能拒绝，不能假设成功。[26]
- 显示 `navigator.storage.estimate()`。
- 先清旧 snapshot/cache generation；永不自动删除 outbox 或 unsynced Blob。
- `Remove offline library` 必须区分可重建 cache 和未同步工作，要求 sync/export/discard 明确选择。

隐私：

- NSFW hiding 只是展示，不是手机本地数据保护。
- 初次离线下载含 NSFW metadata/media 前明确提示。
- 提供一键清除离线副本；不向第三方 analytics/CDN发送 library 内容。
- 若启用 LAN write/sync，推荐桌面端二维码/一次性码配对、Secure HttpOnly SameSite cookie、Origin/CSRF 校验。
- 若继续完全无 auth，文档必须明确同 LAN 设备可读写数据库。

版本必须分开：

- mobile shell build / bundled web build / optional service-worker cache；
- IndexedDB schema；
- snapshot format；
- sync protocol；
- SQLite migration；
- library `syncEpoch`。

升级 Service Worker 或 mobile shell 时不得先删旧 cache/IDB；pending outbox 必须跨 app update 保存。App 与 Server 必须通过 sync protocol range 协商，不允许旧壳静默发送不兼容 mutation。

## 29. C 项 TDD 与 QA 阶段

### C0 tests

- WebView spike：同一 Vue build、airplane-mode cold launch、force-stop persistence、QR pairing、隔离 LAN health request、最小权限；
- WebView 被系统终止后，snapshot/outbox 完整且下一次 foreground 可恢复；
- App/Server protocol mismatch fail closed；
- 若保留 PWA：secure-origin capability detection、service-worker install/update/rollback、cold offline navigation；
- Service Worker 从不拦截/replay mutation。

### C1 tests

- snapshot 与 snapshotSeq 原子性竞争测试；
- IDB generation 完整切换；
- 中断、checksum mismatch、quota failure 保留旧 snapshot；
- online/offline 查询 parity；
- libraryId/epoch mismatch。

### C2 tests

- 每个允许 mutation 生成 journal；
- lost-response retry；
- same opId/different body 拒绝；
- scalar three-way conflict；
- tombstone；
- server restart；
- backup restore rotates epoch；
- pull/push/pull 不覆盖 optimistic overlay。

### C3 tests

- local UUID → numeric ID mapping；
- create retry 不重复；
- metadata transaction failure 无半成品；
- media interruption、wrong hash/MIME/dimension；
- app update 时 Blob/outbox 保留。

### Real-device gate

首选 WebView shell 的真实 Android gate：

1. 安装使用稳定 release key 签名的测试 APK，并确认只申请已批准的最小权限；
2. 首次打开、QR 配对并下载 snapshot；
3. 离开 Wi-Fi并关闭 server；
4. force-stop 后 cold launch；
5. 浏览/搜索；
6. 离线修改和创建 Entry；
7. 回到连接，桌面端同时制造一个同字段 conflict；
8. Sync 并解决冲突；
9. server/app restart 后再次 Sync；
10. 验证正式 SQLite 和 assets 只有一份 Entry/Content/media。

若交付 PWA，则另外在真实 Android Chrome 走完：

1. 在可信 HTTPS origin 安装 PWA；
2. 下载 snapshot；
3. 离开 Wi-Fi并关闭 server；
4. 杀掉浏览器进程后 cold launch；
5. 浏览/搜索；
6. 离线修改和创建 Entry；
7. 回到连接，桌面端同时制造一个同字段 conflict；
8. Sync 并解决冲突；
9. server restart 后再次 Sync；
10. 验证正式 SQLite 和 assets 只有一份 Entry/Content/media。

正式库上线前所有 destructive/chaos tests 使用克隆数据库和独立 assets 目录。

## 30. C 项最容易出错处

- 在当前 LAN HTTP 上做完 UI 后才发现 Service Worker 无法注册。
- 把纯 PWA 的 secure-origin 限制错误地套到 WebView shell，或反过来假设外部 Chrome 能读取 App 私有存储。
- helper App 通过后台 localhost server 喂给外部 Chrome，最终被电池管理杀死。
- 为了“自动同步”加入常驻服务、通知、自启或广泛权限，制造不必要的系统拦截面。
- APK 和 Server 独立升级却没有 protocol negotiation，旧壳向新 API 写入错误 payload。
- 固定 CA 私钥被打包进公开 APK/仓库，导致任何人都能伪造 Desktop T3。
- PC IP/hostname 变化导致浏览器把它当另一个 origin，离线库消失。
- Service Worker 缓存 POST 或 API response，离线读到不完整/过期状态。
- Snapshot 分页与 cursor 不在同一读事务，漏掉并发更新。
- 只用 numeric ID 做跨离线 identity；Entry 删除后 ID 复用造成错写。
- Outbox 放内存/localStorage，浏览器杀进程后丢失。
- 用 “toggle” 表达 View later/membership，重试后状态反转。
- `navigator.onLine` 显示 online 但 PC server不可达。
- backup restore 后 sequence 回退而 client 不 resnapshot。
- 先删 Blob 再确认 server journal，lost response 后媒体永久丢失。
- IndexedDB migration 失败时删除整个库，连未同步工作一起丢。
- 自动下载全部 originals，迅速触发 quota eviction。
- Source maintenance、merge、delete 等高风险操作被通用 offline queue误收。
- Service-worker/app/API/snapshot 版本耦合，旧 app 向新 server 发不兼容 mutation。

## 31. C 项成功标准与回滚

C1 成功：

- 无网络 cold launch；可浏览用户选择的离线数据；刷新失败不破坏旧 snapshot。

C2 成功：

- 允许列表内的 mutation在断线后可重试、无重复、无静默覆盖；conflict 可见。

C3 成功：

- 离线新 Entry 在回连后只生成一个 server Entry；numeric ID、media 和依赖关系正确映射。

回滚：

- C0/C1 可 feature flag 关闭；server online path 保持原样。
- C2/C3 每种 operation 单独 feature flag；关闭后保留 outbox export/read-only，不丢数据。
- 新 migration 不删除；旧代码忽略 sync tables/columns。
- 遇到 protocol/library/epoch 不兼容时 fail closed，要求 full resnapshot，不猜测合并。

---

# 32. 统一交接与冲突管理

## 32.1 文件冲突热点

三项目共享：

- `packages/shared/src/index.ts`
- `apps/server/src/http/app.ts`
- `apps/web/src/api/gallery.ts`
- `apps/web/src/i18n.ts`
- `docs/current-architecture.md`
- `docs/http-api.md`
- migration runner/probe/doctor（B 与 C）

因此不得让多个 Agent 同时修改这些文件。推荐 ownership：

- Agent A：suggestion shared/repository/component；
- Agent B1：Source schemas/migration/repository；
- Agent B2：catalog providers/adapters，只改独立目录和 fixtures；
- Agent B3：Advanced UI/API，在 B1/B2 PASS 后串行；
- Offline 另开阶段和 session，不与 B 并发。

## 32.2 每阶段完成协议

每个 Agent：

1. 先读取本文件、`AGENTS.md`、相关 architecture/API/database docs。
2. 读取最新 `git status`，不覆盖不属于自己的已有改动。
3. 写 RED test 并确认失败原因正确。
4. 最小实现。
5. 运行 focused test。
6. 运行相关 regression。
7. 检查 diff 只包含授权范围。
8. 提交给 reviewer；PASS 即停，不扩审。
9. 不 stage/commit，由用户统一处理。

## 32.3 Stop conditions

立即停止并报告，不自行绕过：

- 目标 Source 站没有 adapter/fixture 或要求绕 CAPTCHA。
- 需要修改已发布 migration。
- 需要在正式数据库制造破坏性样本。
- 同一 target URL 被多个 Entry 选择。
- Source commit 出现任何 stale item 或 backup failure。
- 纯 PWA 路径没有 stable trusted HTTPS，或 WebView shell 尚未通过 C0 spike 就开始写 sync migration。
- Sync protocol 无法证明 idempotency、journal atomicity 或 conflict handling。
- 两到三次修复仍无法通过 focused test；回到设计/证据层重审。

---

# 33. 尚需用户在执行前决定的事项

当前只有两项真正会改变实现路径：

1. Source 第一组真实迁移：origin Source 名称、target homepage，以及 3–5 个搜索样本。没有它只能实现通用 framework，不能可靠实现 adapter。

- 尝试使用hitomi.la作为原网站，对随机数个样本，尝试寻找 https://e-hentai.org/ 的同样作品。两个网站都是以罗马音+英语字符为主的网站，应该能顺利匹配，18comic这种以中文翻译标题为主的可以尝试一下但我觉得脚本做不到，
- 第二个可以测试的网站节点：
www.baozimh.com，目前本地没有数据，我直接找了几个漫画的网址，尝试用我们提取器常有的信息来进行匹配
https://www.baozimh.com/comic/gengyirenouzhuiruaihe-futianjinyiseshe
https://www.baozimh.com/comic/wuyexinxuanlu-wushilanzhengbang 
https://www.baozimh.com/comic/huaxunlinran-sanxiangjiansaka 
https://www.baozimh.com/comic/zongzhijiushifeichangkeai-tianjianerlangxiaoxueguan 
https://www.baozimh.com/comic/woxinzhongdeyeshou-yingjingjixiong 

以下是去寻找匹配源的网站案例： 
https://www.mangacopy.com/  拷贝漫画
https://tw.manhuagui.com/list/view.html 漫画柜
https://www.mangabz.com/ 
https://www.guazimanhua.com/

前三个和baozi一样都是繁中文本，第四个是简中文本。尝试。

> 实施状态（2026-09-13）：`mangabz` 已作为第一个真实 adapter 接入
> （更新 2：新增 `generic-html.ts` 盲发现层——对完全陌生的站点不写任何规则：
> 搜索端点自动发现（表单 → 裸输入框 → 有限的传统 URL 形态），探测词取自站内
> 自身标题，结果区用"探测词搜索 − 乱码搜索"差分确定，语言无关、fail-closed。
> 六个陌生站盲测：dongmanhi.com 完全自动发现（12 行结果，模板可复用）；
> nhentai 被 Cloudflare 403（按计划不绕过机器人防护）；kanman/manben/60ti/mh03
> 为 SPA/JS 渲染，HTML 层无差分行，需要 JSON adapter——失败时引擎自动输出
> 主页搜索能力统计供分类。）
> （更新：`manhuagui` 已作为第一个**声明式模板**站接入——`adapters/template-html.ts` 提供
> 通用"简单 HTML 列表站"模板：一段配置（域名白名单/搜索 URL/行切分/字段正则/零结果与
> 计数交叉检查）+ 真实 fixture 即完成接入，无需逐站写代码；探测确认四站结构各异
> （mangabz `mh-item`、manhuagui `book-result li.cf`、CopyManga SPA、瓜子未知），
> 因此"每个站有自己的配置与 fixture"不可省略，但已降为填配置级别。CopyManga 为
> JS 水合页，需要独立 JSON adapter，瓜子漫画待探测。）（`source-maintenance/adapters/mangabz.ts`）。
> 搜索 `GET /search?title=<kw>&page=<n>`，HTML 结果解析 fail closed（布局改版时抛错而非返回错误 URL；
> 页面自带命中数用于区分"真零结果"与"解析失败"）。三个真实 fixture（多结果/分页/无结果）保存在
> `apps/server/tests/fixtures/source-maintenance/mangabz/`，自动化测试零联网；live smoke（手动单条）通过
> （"青色之箱" 返回 12 个候选）。礼貌访问：并发 1、请求间 ≥1500ms、15s 超时、2MB 响应上限、
> 描述性 User-Agent。其余三站（mangacopy / manhuagui / guazimanhua）按同一流程逐站补 fixture 后接入。



2. Offline C0 verdict：默认先验证 Android WebView 薄壳；若 spike 失败或用户坚持外部 Chrome，再在 Tailscale HTTPS、受信任的纯 LAN HTTPS、公共 CA/自有域名或有限临时 offline 中选择。

其他默认决策已在本方案中给定：

- Relation 默认严格 substring eligibility、无 fuzzy。
- Source invalid 默认是 group-level annotation。
- Source batch只追加 Content，不替换旧 URL。
- External catalogs只提供 evidence，不自动写库。
- Offline 核心不依赖 Tailscale；Tailscale 仅为可选部署说明。
- Mobile 默认不重写原生 UI，而是复用现有 Vue build 的 WebView 薄壳；不同壳层共享 snapshot/outbox/sync protocol。
- Mobile 不依赖后台常驻；只在 foreground/显式 Sync 时连接，系统终止不能丢 durable Outbox。
- Offline 先只读、后写入；delete/merge/import/source maintenance 保持 online-only。

---

## Sources

[1] https://raw.githubusercontent.com/AniList/ApiV2-GraphQL-Docs/master/docs/guide/introduction.md — AniList API Introduction
[3] https://api.mangadex.org/docs — MangaDex API Documentation
[4] https://kitsu.docs.apiary.io — Kitsu API Documentation
[8] https://myanimelist.net/apiconfig/references/api/v2 — MyAnimeList API v2 reference
[15] https://graphql.anilist.co — AniList GraphQL endpoint
[21] https://www.wikidata.org/wiki/Special:EntityData/Q106447820.json — Wikidata Blue Box entity
[23] https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API — MDN Service Worker API
[24] https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API — MDN IndexedDB API
[25] https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API — MDN Background Synchronization API
[26] https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist — MDN StorageManager.persist
[27] https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts — MDN Secure Contexts
[28] https://www.rfc-editor.org/rfc/rfc9309.html — RFC 9309 Robots Exclusion Protocol
[29] https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html — OWASP SSRF Prevention Cheat Sheet
[32] https://github.com/bangumi/api/blob/master/docs-raw/user%20agent.md — Bangumi User-Agent guide
[37] https://tailscale.com/kb/1153/enabling-https — Tailscale HTTPS certificates
[38] https://tailscale.com/kb/1242/tailscale-serve — Tailscale Serve
[41] https://unicode.org/reports/tr15 — Unicode Normalization Forms
[49] https://api.bgm.tv/v0/subjects/332037 — Bangumi Blue Box subject record
[50] https://kitsu.io/api/edge/manga?filter%5Btext%5D=Blue%20Box&page%5Blimit%5D=3 — Kitsu Blue Box manga search result
[56] https://support.google.com/pixelphone/answer/2844832?hl=en — Google Pixel: add and remove certificates
[57] https://developer.android.com/privacy-and-security/security-config — Android network security configuration
[58] https://developer.android.com/develop/ui/views/layout/webapps/load-local-content — Android WebView local content
[59] https://capacitorjs.com/docs — Capacitor documentation
[60] https://developer.android.com/topic/performance/background-optimization — Android background optimization
