# parity-02 Author implementation — WORKING, not full owner GREEN

## Outcome / writer handoff

本轮接续唯一 production/test writer 已停写。02仍未完整闭合，03未开始；不要把当前全部测试通过等同于有限要求全部覆盖。不存在审批/权限阻断；预算预留收束，剩余gap需要下一轮继续源码/测试。此次先逐一验证原12项live SHA并保存continuation-02-start完整字节，未覆盖before/continuation-start/旧working-checkpoint。

接续开始：原ledger 6文件SHA逐一匹配live；保存 `.hermes/tmp/offline-parity-author/continuation-start/` 全字节和manifest，不覆盖原before。只执行已落盘projection之后的10个剩余create edits，未从头重跑create-impl.py。所有production/test edits通过guard.py唯一anchor/SHA保留原CRLF/混合换行；scoped-diffs保留对各自before的diff。

## Proven tracers / actual RED

- 原create-red.log实际业务RED：AddAuthorPage离线submit转发POST /producers，Known offline。现真实AddAuthorPage所有字段(name/occupation/artworkRef/content)→durable producer.create→workless direct detail；列表hide workless；导出/atomic restore→冷fakeIDB编辑content→联已有Entry→app.request真实SQL replay→response-loss cold exact-body retry→ACK-loss retention→再次重试后cleanup，稳定UID/numericID收敛，PASS。
- create-resume.log实际RED：standalone create不是旧entry.author.create-and-link父，Producer dependency gate拒绝。outbox-store显式接受同client/library/epoch的producer.create父，tracer PASS。
- delete-red.log第一次只是Authors按钮text含count的selector harness错误，不能称业务RED。修正实际sidebar `.author-link`、进入Author detail/Edit后，delete-red-actual.log业务RED：双确认未enqueue producer.delete。现真实GalleryApp→AuthorPage双确认→durable delete→local/cold Author absence，作品保留→SQL删除本人→response-loss/ACK-loss完全相同原UUID/body retry→matching journal/absence/cursor/durableACK后cleanup，PASS。
- native-fixture-red.log：共享contract27 kinds而fixture25的真实contract coverage RED；补producer.create/delete shapes后GREEN。
- types-1/types-2保留修复过程中真实type errors；当前types-final PASS。不把这些编译错误称作用户业务RED。

## Prior checkpoint gates (historical; current continuation gates below)

- Default JSON：success=true，1239 passed，0 failed。
- Integration JSON：success=true，696 passed，0 failed；本项2条actual caller tracers均通过。
- shared/server/web vue-tsc root typecheck PASS；root ESLint PASS；git diff --check PASS。
- 首次build仅root `node_modules/vite`路径不存在，属于命令harness error；改用apps/web/node_modules/vite后isolated client Vite build PASS，249 modules。T3_SW_BUILD=1禁用会访问/输出部署dist的嵌套SW插件。只构建隔离outDir；未构建SW、不称完整PWA构建或APK。
- 新执行Gradle `testDebugUnitTest --rerun-tasks`，generated Java contract包含producer.create/delete与对应caps；真实JVM XML 61 tests / 0 failures / 0 errors / 0 skipped，13 suites。不是reuse旧61。现all-kind Worker fixture实际覆盖27种，每个required flag absent/false、enabled原bytes保留；fixture replay receipt仍是contract mock，TLS/pairing/tempSQL真实，不是27 business SQL applies。
- 手机/WebView/PluginCall/Keystore/force-stop/touch/IME仍UNVERIFIED；app.request不是TCP证明，cold fakeIDB不是真实Android存储证明。

## Implemented files

11个production/test ledger路径：
- packages/shared/src/schemas/sync.ts
- packages/shared/src/schemas/native-mutation-contract.ts
- apps/server/src/sync/sync-service.ts
- apps/server/src/sync/replay-service.ts
- apps/server/src/http/app.ts
- apps/web/src/api/gallery.ts
- apps/web/src/offline/offline-api.ts
- apps/web/src/offline/outbox-store.ts
- apps/web/src/offline/pending-work-restore.ts
- apps/web/tests/fixtures/native-valid-kind-fixture.ts
- apps/web/tests/offline-author-parity.integration.test.ts (NEW)

Shared新增producer.create/delete；server cap/receipt transaction/origin registry/Producer tombstone与bounded sync-identity route；facade新增create/delete/profile projected identity/standalone Entry-link origin依赖、delete projection、matching delete journal proof持久化防ACK-loss游标越过；restore新增standalone creates和deleted producer later edit拒绝。

## First remaining gaps (must not mark02 GREEN)

1. **混合Producer edit→delete有限正向已修复，负向矩阵仍缺**：新实际业务RED `continuation-02-red-actual.log`证明7个queued rows虽SQL删除却无法cleanup；新增逐original applied receipt、same Producer UID/library/epoch、applied order、serverSeq与同owner version早于已验证delete检查，profiles/anchors/ratings按此结算。profile/anchor/tag/rating/ViewLater→delete真实SQL+ACK-loss retry GREEN；第一次setProducerViewLater不存在是harness错误。receipt允许省略entityId，若有则严格检查；原snapshot有该UID时也核对ID，ACK-loss后的新snapshot已absence时仍以exact UUID receipt+原UID+verified delete因果授权。尚未新增伪receipt/wrong/missing tombstone等负向矩阵，不能称严格安全矩阵完整。
2. **本次限定 Directory/Collection predecessor cells 已闭合**。Directory held 真业务RED：Producer被提前删除（directory-red.log）；现从可信snapshot.authorDirectorySets的独立UID经producerId映射到Producer UID，持久foreground ownedScope绑定original envelope fingerprint，ACK-loss后仅复用精确匹配。unknown mapping failclosed；planner无mapping时保守把先行Directory纳为Producer delete前驱。held Directory及Collection Producer membership阻断删除且独立Entry推进，解除held后真实SQL replay+ACK-loss/cold exact retry清空GREEN。Directory receipt被删除的结算绑定原UUID/独立Directory owner/library/epoch与已验证Producer delete journal/absence/cursor，跨owner只比serverSeq，不比较两种version。unknown scope/raw native JSON、wrong receipt UUID、noncausal receipt seq三个有限拒cleanup测试first-GREEN；不是完整伪receipt/restore/native安全矩阵。
3. **本次相关cascade有限cell已闭合**：实际GalleryApp→AuthorPage双Work拖放创建Directory→移出→改名→移回→普通双确认Author删除；cold facade本人absence、本人新Directory成员查询total0、peer Author/Directory/Collection/ViewLater及两作品保留。真实SQL snapshot本人tags/Directory-set/Directory/ratings/ViewLater/Collection relationships清除；其他Author及其关系、所有作品metadata、共享rating slots/layout和Collection主体保留。Entry关系解除正常推进其自身version+1、Collection保留成员position可压紧，不宣称原revision/index不变。新local-cascade-red.log真业务RED为已删除新Directory仍返回两作品；按producerId滤掉新/旧Directory members后GREEN。
4. 实际GalleryApp独立create→直接detail/编辑尚未自动覆盖（当前create仅真实AddAuthorPage+facade；GalleryApp已覆盖delete）。create所有后续编辑族目前只profile content有新identity支持；standalone tag/rating/viewlater/directory cold编辑仍需检查并RED→GREEN。
5. restore新增Author delete full exact export/collision/unknown-attempted retention/有效later edit拒绝矩阵；standalone create collision/reference检查，不能复用generic strict-schema错误冒充特定安全证明。
6. connected无副本/旧副本中新Author create/delete、uncertain create后普通delete、false/absent各cap actual caller冷metadata、错误/缺失snapshot profile/tombstone拒cleanup未建立有限证明。
7. Native已有generated/allkind gate通过，但新create→update→delete真实production Worker依赖/held-independent/resume/restore timeline缺少本项专门证明。Java源码无需改动不代表新scheduler矩阵已闭合。

## Prior continuation-02 execution boundary (historical)

- 此次production/test只修改offline-api.ts、sync-mutation-plan.ts、offline-author-parity.integration.test.ts；其余原11项来源hash验证未漂移。sync-mutation-plan.ts首次纳入ledger，以当前既有dirty完整bytes保存before，未用HEAD。
- 实际4 focused / 1239 default / 698 integration：success true、failed0、pending0；shared/server/web typecheck、root lint、diff-check PASS。git有既有line-ending提示；isolatedclient Vite249 modules PASS，有configLoader/chunk-size warning，无SW/PWA/deploydist/APK证明。
- 原两条caller未重写，本轮全文件回归PASS。mixed edits及held Entry各为真实业务RED→GREEN；未实现/未新增证明cells仍在上列1–7。全部现有测试PASS不授权02 GREEN。
- 本轮未改Java/shared nativecontract/allkindfixture，未新跑JVM。contract SHA `7d7ac661718a0656b653f7390d2eb53a7ee781951f58195212e5859670a3895e`、fixture SHA `20f620d5dae5af2214a38445830020ac773b521e409f5ce0977548687863b875`与原checkpoint相同；原generated Java归档SHA `c7792a74088c05371d7725d4cdeed9e47eab21514a2f7b920ba993149a44d8b9`匹配。原13suite61 JVM为历史执行；新foreground graph输入变化不等于专门native timeline已覆盖，不宣称新61或完整Java source hash等价证明。手机仍UNVERIFIED。

## Directory/Collection bounded continuation — current closure

- 唯一writer本轮只修改offline-api.ts、sync-mutation-plan.ts、offline-author-parity.integration.test.ts及本report；父维护CURRENT/board，本writer已停production/test写。02整体仍WORKING，03未开始，未推进gaps4–7。
- 真实当前10 focused / 1239 default / 704 integration，success=true、failed0、pending0；shared/server/web typecheck、root lint、diff-check全PASS；T3_SW_BUILD=1隔离client Vite249 modules PASS。无部署dist/SW/PWA/APK/手机证明，Vite configLoader/chunk-size/outDir warnings如实保留。
- 新增6测试：actual Directory生命周期/cascade、held Directory、held Collection以及wrong UUID/noncausal seq/unknown scope三个拒结算边界。未重写原两caller、profile-delete、held Entry测试；全文件/全suite仅回归。actual Directory-set version高于Producer delete baseVersion的真实seed通过，未跨kind数字比较。
- directory-red.log为Directory held真业务RED→directory-green-final.log GREEN；directory-local-cascade-red.log为新Directory cold查询残留两作品真业务RED→当前GREEN。新Directory survivor验证最初导致旧Entry-delete Directory/Collection回归失败（directory-integration.json：703pass/1fail），补已验证Entry delete journal+causal seq后按最终membership timeline比较，当前704pass。未重新新增Entry held矩阵。
- 初次actual caller空Directory无卡可移动属于harness路径不适配；改用现有真实双Work拖放create caller，不修改AuthorPage。getViewLater方法名、Directory-set不存在numeric id假设、Entry关系version及Collection position预期、TS/unused-variable错误均保留真实日志，不能冒充业务RED。Directory-set实际schema只有producerId/syncUid/version。
- 普通动作期间记录两个既有navigation-counts读取；断网fetch抛错，Directory/create/move/rename/delete无业务mutation transport。不是零shell请求证明，不扩大成known-offline-read审计。
- trusted ownedScope只由当前verified snapshot写入并绑定完整original fingerprint（含UUID/kind/UID/library/epoch/base/payload）；candidate先验证Producer删除journal/absence/cursor，再验证每个Directory receipt的causal seq及原identity，最后安装verified snapshot+durable ACK后清queue。ACK-loss保留exact原封包，cold重试通过。无可信scope时拒replay/cleanup，不接受任意native receipt JSON；缺失proof更多负向矩阵仍不宣称完整。
- 新native contract/Java/fixture未改，未新跑JVM；历史61/13suite归档不替代新timeline。共享planner的无scope conservative dependency变化只建立foreground及default回归证明，专门production Worker新Author/Directory/Collection timeline仍UNVERIFIED。contract及nativefixture SHA与directory-start完全一致；手机/WebView/Keystore/force-stop仍UNVERIFIED。
- 第一未闭合功能cell仍gap4：actual GalleryApp standalone Author create→direct detail/编辑与新Author后续编辑族；gap1剩余完整negative、gap5restore、gap6connected/capability/snapshot、gap7native原样继承。没有把本组GREEN等同于02 owner GREEN。

## Checkpoint / evidence

旧before/continuation-start/continuation-02-start/working-checkpoint/continuation-02-checkpoint均原样保留；本轮开始已验证13项live SHA并保存directory-start全字节。最新checkpoint：`.hermes/tmp/offline-parity-author/directory-checkpoint/manifest.json`，WORKING_NOT_OWNER_GREEN，含12 source/test+最终report exact fullbytes、start/original scoped diff、真实当前JSON/log及isolatedclient Web hashes。下一轮先比ledger/checkpoint/live SHA，不重跑已落盘脚本。

保护边界：未read/touch/request正式DB/assets/8765/8766；未改immutable migrations/cache-names/offline-media/offline-media-task；未清cache/卸载/重下媒体；未改APK/version/signing/PairedTransport/NativeAuth/pinning；无git commit/reset/stash/checkout/deploy。父维护CURRENT/board，本writer不修改它们。
