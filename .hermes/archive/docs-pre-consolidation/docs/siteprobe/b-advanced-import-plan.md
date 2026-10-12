# B 高级导入 —— 实施计划（2026-09-22）

规格来源：`docs/siteprobe/UI.md` 的 B 部分（第 67–115 行）。四项待定已由用户决定：
**① 新建 `login.bat`**（登录门）·**② 多内容先跑 `--review` 再问**·**③ review 页改由 T³ 路由以 http 提供、新标签页打开**·
**④ 三个手写适配器各写一份 README.md 由我写**。

---

## 0. 规格 → 现实的对齐

| 规格要点 | 现成可用 | 缺什么 |
|---|---|---|
| 不选 tool，输入网址自动判定 | `integration sites` 每条带 `hosts`；`resolve` 返回 `matched/site/kind/ref` | 无（前端做 host 判定） |
| 不存在规则 → 提示 + 去第三页 | 第三页（占位）已存在 | 面板间传网址（父组件持一个 ref） |
| rule found + 主域名 + 按站显示可用规则 | `sites[].targets[]` 已是 `{kind,label,single,accepts_name,source}` | kind 映射到你的四类 + 四类说明文案 |
| 逐类输入（work/album/playlist 网址、search 关键词） | `run --site --kind <input>` 已支持 | 输入校验（见 1.3） |
| playlist 是否要登录 | — | 只记录，不实现（用户已定：留接口） |
| 工作状态 / 计数 | `progress` 事件的自由文本，每 10/20/25 条一次计数 | 结构化计数不做（显示最后一行 + 计时） |
| 单作品直接去 import | `/api/imports/site-probe/preview-path` → 现有 mapping 审阅界面 | 跑完要**切到"文件直接导入"页**才看得见（现在锁在该页分支里） |
| 多内容 → 询问是否筛选 | review 页 + selection + `selection` 命令 + T³ 的 selection watcher 全都在 | ① review 事件要有统一数量 ② review 页要能用 http 打开 ③ selection 导出有一行中文破坏 JSON-lines |
| 多内容 → 导入 | 同上 | selection 跑完的导出走同一条 import 路径 |
| 有 adaptor 的站点优先用它的特殊功能 | adapters 已按 `development→local→installed→builtin` 优先级合并 | 特殊功能不做 UI 适配（用户已定：写进规则里 + readme 说明） |
| adaptor existing + 问号 readme | — | 适配器里没有 readme，`sites` 也没有描述字段（见 1.1/1.2/1.8） |
| 需要登录时「进行登录」按钮 | — | 工具里没有任何登录门（见 1.6） |

**kind 映射（用户四类 ← 工具的七类）**：`work→work`；`search→search`；`album+artist→album`
（作者页即合集页）；`favorite+playlist→playlist`；`folder` 无人声明，不显示。

---

## 1. 新增 / 改动的接口

### 工具侧（Python）

**1.1 `sites` 事件的 adapter 条目加一个布尔**（形状不变，只加字段）

```text
adapters: [{"source": "installed", "reads": "adaptive" | "declarative", "readme": true|false}]
```
`readme` = 该适配器目录里有没有 `README.md`。"adaptor existing" 徽章按 `source in (builtin, installed)`
显示（随工具发布的手写适配器），学到的（local/development）只显示 "rule found"。

**1.2 新命令 `readme --site <key>`**（懒取，不塞进 sites 文档）

```text
stdout: {"event": "readme", "site": "18comic.vip", "source": "installed", "text": "<markdown>"}
exit 2（UNKNOWN_SITE / 无 readme 时不报错，text 为空串），无 readme 时 text = ""
```
T³ 只在用户点问号时才调它——工具自己的树由工具自己读。

**1.3 `resolve` 收紧（这是"输入校验"的接口）**

现状：`resolve --site X --kind K <任意字符串>` 会**静默接受**（内部回退成 `{"id": 原文}`），
形状不对的网址要跑到后面才炸。改为：

- 输入**形如 URL**（`^https?://`）时：必须匹配该 `--site` 下该 `--kind` 的 `url_pattern`，否则
  `matched:false` + `reason:"NO_MATCH"`，`detail` 写明"这个网址不是该站的 <kind> 页"；
- 输入**不是 URL** 时：只有声明了 `accepts_name` 的 kind 接受（search / artist），其余 `INVALID_INPUT`；
- 不带 `--kind` 的旧行为不变（`--site` 分支仍按原样解析整串），所以现有 bat 不受影响。

前端用法：输入框失焦 / 点 apply 前先 `resolve(input, site, kind)`，`matched:false` 就地提示并禁用 apply。

**1.4 `review` 事件加统一数量**

```text
{"event":"review", …, "summary": {...}, "count": 42}   ← 新增 count，整数，永远是"这一页有多少条"
```
工具的落点：通用 review 路径 `count = len(cards)`；站点自有 review（hitomi）`count = summary["total_items"]`。
T³ 的 `siteprobeReviewEventSchema` 加必填 `count`。这样"发现 N 个内容，是否筛选？"不需要猜站点字段。
（非 review 的运行，数量本来就在 `result.works` 里。）

**1.5 hitomi 的显式索引前缀**

`提取`/搜索输入支持 `artist:名字`、`tag:名字`、`series:`、`character:`、`group:`、`language:`、`type:` ——
前缀把搜索**钉在**那个索引上（直接 `/{kind}/{query}-all.nozomi`）。裸名字仍走现在的自动判断
（依次试七种索引），行为不变。

**1.6 `login.py` + `登录.bat`（新的登录门）**

```text
用法：登录.bat <网址或站点 key>          （无参数则提示输入，风格同现有 bat）
流程：resolve 出站点 → 该站的固定 profile（`<home>/browser_profiles/<host>`）
      → 打开有头浏览器到站点首页 → 打印"登录/过验证后回到这个窗口按回车"
      → 回车后取 context.cookies()
      → 若适配器模块导出 save_cookies(profile, cookies) 就交给它（18comic 就是这么读回来的）
        否则写 <profile>/../session-cookies.json
退出码：0 成功 / 2 输入不对 / 1 失败（与工具其它门一致）
```
工具**不保存密码、不读密码**；它只把浏览器会话的 cookie 交给适配器自己的落盘函数。

**1.7 修一个真 bug**：hitomi 的 selection 导出会往 stdout 打 `作品文档：x/y`（`review/export_selected.py:460`），
破坏 JSON-lines 契约 → T³ 把整行当 malformed 并报一个假的 `INTERNAL`。改成写 stderr 或走 progress。

**1.8 三个 README.md**（`installed/{comic18,hitomi_la,hanime1_me}/README.md`，中文）
内容：这个站点是什么、覆盖范围、支持哪些规则类型（及各自怎么用）、是否需要登录、
特殊功能（如 18comic 的预览图还原、hitomi 的作者页聚类）、已知限制。

### T³ 侧

**2.1 `GET /api/siteprobe/export-file?path=<abs>`** —— 用与媒体同一套 `resolveInsideExportRoot` 守卫，
只在该站导出根内、只服务 `.html`/`.json`，`Content-Type` 按扩展名。给 review 页与新标签页用
（`file://` 从 http 页跳会被 Chrome 拦）。`..` 一律拒绝。

**2.2 登录 job**（复用现有 jobs 状态机，新增 `kind: 'login'`）

```text
POST /api/siteprobe/login  {"input": "<网址或站点 key>"}
→ 在**新控制台窗口**里跑 `cmd /c start "" /wait <登录.bat> <input>`（用户能看见、能敲回车）
→ 该 job 的 stdout 是纯文本（不做 JSON-lines 校验），进度行由 T³ 自己写
   （"已打开登录窗口，完成登录后回到窗口按回车继续…"）
→ 进程退出即 done；非 0 → failed
GET /api/siteprobe/runs/:id 复用；取消 = 杀掉那个 cmd
```

**2.3 `sites` 透传 `readme` 标志 + `GET /api/siteprobe/readme?site=<key>`**（转发 1.2）。

**2.4 `AddEntryPage` 两处小改**：① 预览产生后把 `activeTab` 切到 `files`（否则 import 审阅区不可见）；
② 一个父组件持有的 `ruleDraftUrl`，B 页 emit、第三页（导入规则创建）作为输入框初值。

### 前端页面（替换 `SiteProbePanel` 的主体）

- 顶部：**一个网址输入框**（"粘贴任意该站的网址，主页/作品页都行"）→ 失焦即 `resolve`；
- 无规则：提示 + `去创建规则` 按钮（带网址跳第三页）；
- 有规则：`rule found · target: <host>` + 可选 `adaptor existing ?`（气泡显示 readme）；
- 四类规则**逐行列出**（不用下拉），每条带你写的那段说明；选中态加深颜色；按站点实际声明显示；
- 逐类输入：work/album/playlist 一个网址框，search 一个关键词框；playlist 多一行"是否需要登录"；
- `apply`：先 `resolve` 校验 → 跑（多内容先带 `--review`）；状态区显示最后一行进度 + 计时 +
  `bug → 请报告 + 复制诊断信息`（复用 A 页那套文案与日志路径）；
- 多内容：`发现 N 个内容，可能有重复/多语言/垃圾，是否手动筛选？` → 是：打开 review 页（T³ 路由，新标签页）
  → 等 selection（现有 watcher）→ 只抓选中的 → 导入；否：再跑一次不带 review → 导入；
- 导入：切到"文件直接导入"页，复用现有 mapping 审阅与提交。

---

## 2. 分阶段与验收（每段都能独立验收）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1 工具侧契约与登录门** | 1.1–1.8 + 工具测试 | 工具 pytest 全绿；`resolve` 收紧有"能失败"的测试；`readme` 命令真跑一次；登录门真开一次浏览器并落盘 cookie（用一个假适配器或 18comic 真登录一次） |
| **P2 T³ 传输与路由** | 2.1–2.3 + schema + 测试 | 单测/集成绿；`export-file` 的越界路径全部拒绝；登录 job 起一次真窗（用假 bat 写标记文件验证等待与退出码） |
| **P3 B 页** | 页面 + i18n(中英) + 测试 | 面板测试覆盖：无规则分支、四类显示、校验失败、多内容询问、review 打开、导入交接 |
| **P4 真实链路** | 真站各一条：18comic 单作品、hitomi 作者（多内容 → 筛选）、hanime playlist、一个 search | 每条跑到 import 预览；多内容那条走完 review → selection → 只抓选中的；登录门用 18comic 收藏夹真登一次 |

## 3. 明确不做 / 留给以后

- **playlist 的"是否需要登录"只记录**（用户已定：留接口），不实现登录后的 playlist 抓取；
- **iframe 嵌入 review 页**不采用（改用新标签页）；
- hitomi 的 `artist:` 只做"指定索引"，不改它的自动判断；
- `folder` 这一类工具里没人声明，界面不显示；
- C2（review 页回传）与 D4（剪贴板）仍欠；离线模块一行不动（另一人在写）。
