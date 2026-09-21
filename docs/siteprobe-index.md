# SiteProbe 文档索引

SiteProbe 相关共 5 份。它们的角色不同，读的时候别混：**计划**说做什么、**记录**说实际发生了什么、
**架构指导**钉边界、**交接**说明进 T³ 要什么、**可行性**是最早那份提案。

| 文件 | 行数 | 它是什么 |
|---|---|---|
| `siteprobe-completion-plan.md` | 1521 | **正式计划**（§1–§24）：完成定义、候选采集、规则学习、listing 搜索、分页、review 复用、测试策略、分阶段实施、明确不做与依赖建议。 |
| `siteprobe-execution-log.md` | 见文内导航 | **执行记录**（append-only）：每个阶段做了什么、每次修正错在哪儿、实测数字是多少。顶部的表是全文的导航。 |
| `t3-siteprobe-architecture-guidance.md` | 1277 | **架构指导**：T³ / SiteProbe Core / Adapter Builder / 站点 Adapter 之间的长期边界、仓库划分、adapter contract、发布与更新原则。 |
| `siteprobe-integration-handoff.md` | 347 | **交接文档**：整合进 T³ 的需求、已完成的技术工作、交接位置与入口（不含未来技术方案）。 |
| `generic-site-probe-plan.md` | 104 | **最早的可行性提案**（英文）：“把抓取与保存分开、保存那半做成通用”是否可行 —— 结论是可行，通用那半已存在，缺的是声明式的前半。已被正式计划取代，保留作来龙去脉。 |

## 三者的关系（一句话）

可行性提案 → 正式计划（做什么）→ 执行记录（做成了什么、哪里错了、拿什么量的）→
架构指导（边界与发布）→ 交接文档（进 T³ 需要什么）。

## 用词（易混的两个词）

* **Adapter**：按网站写、单独维护、**可分享**的工具（`tool/<名>/`，带 `fetch.py`）。计划里的 adapter 就是这个意思。
* **Learned rule set**：SiteProbe 自己学出来的规则集（`tool/learned/<域名>/`），**个人**、git 忽略 ——
  因为没人能预知别人对同一个站标了什么样的规则。它**不是** adapter。
