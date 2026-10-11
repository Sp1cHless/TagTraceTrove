
### 修正：字段标签去掉 "(optional)"（2026-10-08/09）

用户：把 optional 去掉，感觉没必要了。

去掉的五个键（两种语言）：`entry.pageCountLabel`（页数）、`entry.uploadDateLabel`（日期）、`entry.durationLabel`（时长）、
`entry.authorLabel`（作者）、`entry.sourceUrl`（粘贴作品原网址）。前三者的键同时被 Entry 的统计行当作 aria-label 使用
（`EntryStatsRow`），所以那里的读屏文案也跟着变短 —— 同一字段，同一句话，两处一致。没有测试断言过这些字面量（改前 grep 过）。

**顺带解决了上一节的折行**：标签变短后，`Pages / Date / Duration` 那一行在 760–1200px 全都**单行且框对齐**
（浏览器实测：标签高 [70,70,70]/[66,66,66]，框 x 三值、y 单值）。所以 `align-items: flex-end` 那条保底改动留着 ——
它防的是以后某个标签又变长的情况，不再靠它救场。

门：typecheck 三包 0、eslint 0、单测 **1212**、build ✓。纯文案 + CSS，刷新页面即可。
