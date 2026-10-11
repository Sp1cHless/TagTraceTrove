
### 修正：作者评分的六处按用户反馈改动 + 两栏动态布局（2026-10-08）

用户看过上一节的实机效果后给了六条：① 说明文字只留「inherited by unrated work」这一层意思，**且只在 edit 模式下显示**；
② 去掉「套用本画廊的作品维度」按钮 —— **作品概括应当自动跟随 gallery 的 entry 模板**，不该让人手动点一次；
③「作者自身」的说明改成「not inherited by work. applied for all author under gallery」，同样只在 edit 显示；
④ 去掉「No ratings yet — add one to share it across this Gallery.」那句；⑤ 排版：作品概括只占一部分、**作者自身移到右半边**，
两边正好各半；没内容的半边依旧不显示；⑥ 这个布局要**动态**：空间不够（手机网页端）时作者自身落回下方。

**② 的做法（这是本节唯一改到数据的一处）**

"作品概括的维度集合 = 该画廊作品维度的集合"这句话本来就是这一类的定义，所以让它**按构造同步**而不是靠按钮：

```text
  createRatingSlot(kind='entry', ...) 现在同时确保存在同名的 ('producer', 同画廊, 同名) 那一行（已存在则 no-op，不碰任何分数）。
  存量数据另补一次：041_works_summary_follows_gallery.sql —— 只为"作品维度存在、概括维度缺失"的组合补名字。
    实测（正式库只读副本）：AV/电影/小说 三个画廊此前 producer 侧一个维度都没有，041 后每个画廊两边一一对应；
    评分值完全未动（entry 627 行/Σ2276、producer 779 行/Σ2793 前后一致），foreign_key_check 空、integrity ok、重复跑为幂等。
    041 已被服务自身的 capabilities 轮询应用到正式库（applied_at 13:26:43 UTC），布局变更按分区正常记账。
```

`reconcileWorksSummarySlots` 这个函数、它的路由、共享 schema、facade 方法与作者页按钮**全部删除**（不再有手动那一步）。
probe 里那条检查改成断言"建了作品维度，概括维度自己就有了"，而不是断言 reconcile 的返回值。

**④ 顺带清理**：`rating.empty` 这条文案随之没有使用者，按仓库惯例连同两种语言一起删掉；`rating.noWorks` 的措辞从
"主导画廊"改成"所属画廊"（模型已经不是派生的了）。空态时只剩 `+ Rating`，`noWorks` 只在"这位作者还没有所属画廊"时出现。

**⑤⑥ 布局**：一个 `.author-ratings-board`（`grid-template-columns: minmax(0,1fr) minmax(0,1fr)`）把两半并排，
`minmax(0,1fr)` 是必须的 —— 网格项默认 `min-width:auto`，不加就会被长维度名或十格星条把右半边挤走；
`@media (max-width: 44rem)` 时改成单列、两半之间补一条分隔线。某一半没内容时不渲染（判断在 `authorRatingGroups` 里），
所以读模式下只有"作品概括"时右半边就是空的，正是用户要的"各占一半"。

**门**：typecheck 0 / eslint 0 / 单测 **1204** / 集成 **635** / build ✓ / `db:probe` 49 项 PASS / `db:doctor` PASS。
跟改的既有断言 4 处，都是新行为的正确表达：概括分区的 sort_order 因镜像而 +1；`041` 会把只在作品侧存在的维度名补到概括侧，
所以那条"重建前后完全相等"的断言改成"值完全相等 + 既存槽位/分区是子集"（分区的 sync_version 会因新增维度而合法地前进）；
`sync` 里"删掉槽位后重建会复用同一个 rowid"这条不再成立（镜像占据更高的 id），改成断言**身份不被回收**（那才是它要证的事）。

**一个必须点明的运行状态**：写到这里时服务进程起于 21:13:33，而我最后几处改动是 21:28–21:32 ——
**它比代码旧**（实测：`/rating-slots/reconcile` 仍有响应，即旧的删除前的版本；自动镜像尚未生效）。
好消息是这次的 UI（布局、说明、锚定编辑）全在 web 侧，重建产物已是最新，刷新页面就能看到；
`subjectKind` 与锚定路由在 21:13 那个版本里已有，所以"新建作者自身维度 / 改锚点"现在就能用。
只差"新加的作品维度自动出现在概括里"这一条要等下次重启 —— 存量已被 041 补齐，所以日常看不出来。
