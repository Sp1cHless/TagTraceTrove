# SiteProbe 文档索引

## 通用规则稳定化后续方案（2026-10-11）

[SiteProbe 通用规则生成与运行稳定化执行方案](siteprobe-generic-adapter-hardening-execution-plan.md)：面向“新网站创建规则后仍需额外修复”的问题，列出运行契约、诊断、采集、身份、转换、T3 导入及旧规则兼容的分阶段执行任务。状态为待执行；每个实现批次仅一次基础聚焦验证，真实站点由用户手动验收。下方原有文档数量与行数为历史记录。

SiteProbe 相关共 8 份（含本索引）。它们的角色不同，读的时候别混：**计划**说做什么、**记录**说实际发生了什么、
**架构指导**钉边界、**分发架构**说适配器从哪来、**交接**说明进 T³ 要什么、**集成计划**说怎么接进去、
**可行性**是最早那份提案。

| 文件 | 行数 | 它是什么 |
|---|---|---|
| `siteprobe-t3-integration-plan.md` | 445 | **集成实施计划**：T³ 侧正式接入（transport、机器接口契约、导入区链路、剪贴板、数据根归位、前置债务、分阶段与验收）。架构指导 §17 点名缺的就是这一份。**进度（2026-09-22）**：Phase A/B/C 已完成 —— 工具侧有了 `integration.py` 的 JSON-lines 契约（附带 4 道 judged 门），T³ 侧有了 `apps/server/src/siteprobe/` 通道与 `preview-path`/`commit-path`，前端有了最小可用导入区面板；真链路实测到「一次真实抓取的导出能被读成 entry」。未做：UI 的正式操作逻辑（下一轮）、C2、D4（搁置）、Phase E/F。 |
| `siteprobe-completion-plan.md` | 1521 | **正式计划**（§1–§24）：完成定义、候选采集、规则学习、listing 搜索、分页、review 复用、测试策略、分阶段实施、明确不做与依赖建议。 |
| `siteprobe-execution-log.md` | 见文内导航 | **执行记录**（append-only）：每个阶段做了什么、每次修正错在哪儿、实测数字是多少。顶部的表是全文的导航。 |
| `siteprobe-adapter-distribution-architecture.md` | 见文内 | **适配器分发架构**：四个来源（`builtin/installed/local/development`）、优先级 §17、发现方式、缓存与会话。 |
| `t3-siteprobe-architecture-guidance.md` | 1277 | **架构指导**：T³ / SiteProbe Core / Adapter Builder / 站点 Adapter 之间的长期边界、仓库划分、adapter contract、发布与更新原则。 |
| `siteprobe-integration-handoff.md` | 347 | **交接文档**：整合进 T³ 的需求、已完成的技术工作、交接位置与入口（不含未来技术方案）。 |
| `generic-site-probe-plan.md` | 104 | **最早的可行性提案**（英文）：“把抓取与保存分开、保存那半做成通用”是否可行 —— 结论是可行，通用那半已存在，缺的是声明式的前半。已被正式计划取代，保留作来龙去脉。 |

工具本体在仓库根的 `siteprobe/`，**验收入口是 `siteprobe/验收.bat`**（静态审计每道门 +
用 bat 用的解释器真跑每道门）。适配器数据在 `<T³ user data>/siteprobe/` ——
本机即 `apps/server/.data/siteprobe`，**已归位**（2026-09-21，集成计划 §6；`library.db`
同根，逐项搬移并核对条目数）。仓库根的 `siteprobe.json` 把 home 固定成这一条，
所以双击 bat 与「被 T³ 拉起」落在同一个 home；`builtin` 例外，它是随包发布的只读代码，
在仓库 `siteprobe/adapters/builtin/`。

## 三者的关系（一句话）

可行性提案 → 正式计划（做什么）→ 执行记录（做成了什么、哪里错了、拿什么量的）→
架构指导（边界与发布）→ 分发架构（适配器从哪来）→ 交接文档（进 T³ 需要什么）→
集成计划（怎么接进去、先做什么、拿什么验、哪些要你定）。

## 用词（易混的两个词）

* **Adapter**：按网站写、单独维护、**可分享**的工具（一个目录 + `fetch.py` + `site.json`，
  放在适配器来源里：手写的三个在 `installed/<名>/`，随工具分发的放 `builtin/`）。
  计划里的 adapter 就是这个意思。
* **Learned rule set**：SiteProbe 自己学出来的规则集（`local/<域名>/`，由 Builder 安装），
  **个人**、git 忽略 —— 因为没人能预知别人对同一个站标了什么样的规则。它**不是** adapter。

同一域名同时有两者时两份都留着、各自服务自己声明的目标（`probe.py --list-sites` 会打出来）。
