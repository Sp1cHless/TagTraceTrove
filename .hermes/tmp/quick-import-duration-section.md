
### 阶段：快速导入页（手动录入）可以直接填时长；View later 让位（2026-10-08）

用户：quick import 那张表单要把**时长**做成可以直接填的一项；那一行没位子了，得把 "Add to 'View later'" 挤开。

**布局**（这一行原本就是"三个短字段"的设计）：`页数 / 日期 / 时长` 占一行 —— 页数四位数、日期十位、时长八位（`h:mm:ss`，
输入框 7rem，"h:mm:ss is eight characters; the box holds them without the row stretching"）。**View later 移到日期提示下一行独自一行**，
并加了注释说明理由：它是"建成之后放进哪"的库级开关，不是作品本身的一个事实，所以让出这一行。

**取值**：输入框是文本框（占位 `h:mm:ss`），提交时用共享的 `parseDurationSeconds` 解析成**秒**（与 Entry 列存同一单位），
支持 `h:mm:ss` / `mm:ss` / `m:ss` / `ss` / `s`，全角冒号折半角。**读不出来时在输入框下方就地报错并阻止提交**，
不做静默丢弃 —— 表单本身没有本地报错通道（`submitError` 是 shell 传下来的 prop），所以加了一条本地错误行（`role="alert"`）。

**链路**：`ManualEntryDraft.durationSeconds` → GalleryApp 的**三条创建路径**都带上（离线入队输入、入队的同步操作 payload、
在线 `createEntry`），为空时不写这个键。这条能一口气通到离线，是因为**另一位刚把时长接进离线创建链路**
（`syncEntryCreatePayloadSchema` 与 `OfflineEntryCreateRequest` 都已有 `durationSeconds`）—— 所以本轮是干净的加法，没有碰他的文件。

**测试**：gallery-app 新增一条（占位与 View later 仍在；先填一个读不出来的形状 → 就地报错且**没有创建**；再填 `13:25` → 提交带
`durationSeconds: 805`）。顺序是刻意的：创建成功会离开这一页，表单也就随之消失。

门：typecheck 三包 0、单测 **1210**、集成 **641**、build ✓、db:probe 49 项 PASS、db:doctor PASS。
lint 仍有 1 条错在**另一位正在改的文件**（`apps/web/tests/duration-author-offline.integration.test.ts` 的未使用 import），不是我这边。
