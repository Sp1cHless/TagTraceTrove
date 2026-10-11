# 全库深审处置清单（决策稿）

来源：`.zcode/workflow-drafts/深审存量.json`。本文件记录审查发现的分级与后续逐项处置；不重新运行全量深审，也不把未复核候选冒充已复现。原始证据以 JSON 中 `finding` / `confirmation` 为准；行号是审查时位置，使用前须对照当前工作树。`confirmed` 79 条中 1 条标记 `reproduced=false`；`pending` 25 条在此按“需要处置的候选”纳入。工作树存在大量并行未提交变动，任何修复都应单独圈定范围并做对应回归。

编号格式：C=confirmed 列表序号；P=pending 列表序号（均按源 JSON 的数组顺序，从 01 起）。这份文档不改变原报告的 severity；下面按用户影响/数据安全/改动风险重新定优先级。状态“暂缓”并非断言无缺陷。

## A. 优先处理：阻断主要使用、错误写入或不可信输入

| ID | 问题 / 入口 | 建议的最小验收 |
|---|---|---|
| C24 | usageSort + Author ratingSort 组合导致 SQL 绑定参数错误、列表失败 | 已修：仅在 rating 排序实际生效时绑定其参数。HTTP 集成回归先 RED(500)、后 GREEN(200)；同文件 5 条、全量门禁均通过。 |
| P03 | 非 ASCII 标签的 SQL/JS 排序不同导致离线 `entry.tags.set` 永久 conflict | 已修：当前标签改用与传入基线相同的排序；RED conflict→GREEN applied，相关集成测试通过。 |
| P11 | 局域网 HTTP 非安全上下文 `crypto.subtle` 不可用，离线快照下载/更新失败 | 已修：缺少 subtle 时本地 SHA-256 校验（不跳过完整性），篡改快照仍拒绝；相关测试通过。 |
| C55 + C56 | 通用 SiteProbe review 写出 TypeError；修好后 selection 仍可能丢失 listing 上下文 | 已修：写出移除错误参数；review 元数据保留完整 ref/listing，选择下载回归通过，相关 Python 测试 30 通过。 |
| C33 | Source maintenance 把 Entry 级 catalog ID 误盖到候选上，可能误导人工批准错误来源 | 已修：保留逐候选身份，origin ID 单独作为证据；回归确认不会被自动选中。 |
| C08 | `db:restore` 默认路径受启动目录影响，可能恢复到错误库 | 已修：backup/restore 默认解析到 server 包的 `.data/library.db`；显式路径仍相对调用目录。路径测试通过，未触碰正式库。 |
| C19 | 封面替换中缩略图失败时旧封面已被覆盖 | 已修：先成功渲染缩略图再替换封面；注入渲染失败的隔离测试确认旧封面/DB 引用仍在。 |
| C75 | 创建 Entry 成功但上传失败，重试会重复创建 | 已修：保留已创建 ID 与剩余待上传媒体，提供只补媒体的重试按钮；RED/GREEN 回归、Gallery 163 测试通过。 |
| C13 + C39 | 子进程 stdin 错误 / Source maintenance 作业逃逸异常可使服务器退出 | 已修：C13 吞掉已结束登录门的 stdin EPIPE；C39 捕获作业异常并暂停运行、记录错误；两项 RED/GREEN 测试通过。 |
| C32 | 模板导出文件名使用未约束的 entryType，可能写出模板目录 | 已修：写出和列表路径统一拒绝路径分隔符/非法文件名字符；真实 SQL/文件测试先 RED 后 GREEN。 |
| C61 + P06 | SiteProbe review / Builder 页面将站点内容直接嵌入 script，`</script>` 可破坏页面或注入执行 | 已修：review、标注页、选卡页在 JSON 嵌入 script 前编码 `<`；三处真实 payload 回归先 RED 后 GREEN，SiteProbe 全套 343/343 通过。P06 原属未复核候选，此次已在页中复现。 |
| P09 | Builder sweep 清理可能删除并发产生、非本次 sweep 拥有的 session 目录 | 已修为保守策略：不再按时间差自动删除任何 session；并发 session 保留的 RED/GREEN 回归与 SiteProbe 全套 344/344 通过。代价：sweep 生成的 session 需人工清理，直到有可信所有权标记。 |

## B. 跟相关功能一起处理，不单独展开大规模重构

- 同步/离线：C02（旧 View later ID 迁移）；C65（缓存的 capabilities 假在线：已修，SW 对 capabilities 不拦截，RED/GREEN 测试通过）；C66（epoch 切换竞态）；P12/P13/P15（离线作者可见性与筛选语义）；P16（跨标签页快照竞争）。其中 P16 在上线多设备/多标签页离线流程前提升优先级。P14 搜索语义漂移先定产品是否要求等价，再决定是否修。
- 导入/媒体：C17（已跳过条目不能补媒体）、C18（artist 游标错位）、C20/C21（并发预览、批次 externalKey 关联）、C57（selection 缩小累计 manifest：已修，selection 复用原 `_accumulate`，RED/GREEN 测试通过）、P23（review 后自动续跑）；下一轮导入流程验收一起覆盖。
- Source maintenance：C34（已修：备份 await 后在写入事务内重验 run、decision、Entry 快照及 URL ownership；并发提交/取消/改决定回归通过）；C35（已修：生产适配器及 catalog 限流信号进入暂停分支，HTTP 429/503/509/软封禁 403 fixture 回归通过）；C36（表单关键词占位符）、C37（O(n²)）、C38（已修：评审对同一 URL 被目标与其他 Entry 共同持有判为 conflict，与提交一致；RED/GREEN 回归通过）。其余功能正式高频使用前再评估。
- UI 错误反馈/恢复：C63（非 JSON 错误响应丢状态码：已修，错误响应保留 `ApiError.status`，RED/GREEN 客户端测试通过）、C69（已修：切换 Gallery 前清空旧列表与筛选选项、失败展示错误；回归 RED/GREEN，Gallery 164 条通过）、C76（已修：Author works 各加载入口统一接住请求失败、清掉不匹配的旧卡片并展示错误；RED/GREEN 回归，Author 24 条通过）、P22（恢复页码被重置）、P24（Home 加载失败显示空库）；仅在对应页面/错误处理改动时做针对性修复。
- 字典/标签：C25/C26（改名后遗留孤儿标签）只在证实影响候选展示时处理；P05（Builder limit 与标注不一致）若正在生成适配器则提前。

## C. 暂缓 / 接受当前限制（有触发证据再提级）

其余条目不做“为了清零报告”的修补。包括文档及文案漂移（C01/C05-C07）、低频错误码/重复路由/日志文件碰撞（C03/C04/C14/C15）、不常用 CLI/极端输入（C09-C11、C22-C23、C27-C29、C40-C43、C48-C54、C58-C60、C62、C64、C67-C68、C70-C74、C77-C79、P01-P02、P04、P07-P08、P10、P17-P21、P25）。C16（备份无限积累）先观察磁盘使用，不做自动删除备份；P14 搜索策略与 P24 首页错误展示已列入 B，遇实际问题再提级。

C30 的复核结果为 `reproduced=false`，不列为待修故障。未在 A/B 明列的候选默认仍保留在原 JSON，不代表已经排除；若实际使用中复现、涉及正式数据或安全边界，应重新提级。修复某项时按 ID 回原报告读取 evidence/confirmation，增加一个失败回归，再做最小修改；禁止把整份报告作为一次性重构规格。
