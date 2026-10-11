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

## gap4 bounded continuation — latest checkpoint (partial, not gap4 complete)

- 本writer只修改 GalleryApp.vue、offline-api.ts、stores/preferences.ts、本integration tracer和report；production/test现已停写。当前 **gap4仍未完整闭合，02仍WORKING，03 NOT_STARTED**。没有重开已GREEN的Directory-delete/held/cascade cells，原10tests仅回归。
- 完整验证directory checkpoint manifest SHA `13bdf0d6d7c9e6763fd0e4ddc926a40c2a6a67e4fc5d7d279f922c2434e2537a`与13项live==saved==ledger后，独立保存gap4-start原完整bytes；新纳入GalleryApp/preferences实际dirty pre-edit bytes，不从HEAD恢复。
- GalleryApp 的 `creationView='author'` branch/submitAuthor既有，但普通入口没有任何调用openCreation('author')。新建入口RED：`gap4-entry-red.log`要求实际sidebar按钮不存在；最初按英文Add Author文本查找失败记为selector/setup，不冒充准确业务断言。最小恢复sidebar普通New Author按钮使用既有author.new翻译+openCreation。该函数清collections/random等view，submit后showAuthors→authorTarget实际direct detail/Edit通过；**旧Collections/Random出发的专门caller变体未新增证明**。
- `gap4-cold-red.log`真业务RED：冷IDB新Author实际Tag输入提交后tags仍为空。三个Producer enqueue family仅查baseline身份；改为仅同client/library/epoch producer.create投影供应initial revision，既有updates仍独立计同Producer version advances。无旧envelope改写或默认字段注入。
- `gap4-green-2.log`真业务RED：View later实际button提交后facade membership为空（不再是编辑态selector错误）；viewlater/rating overlay仅查snapshot旧Producer。改为已投影Producer identity。preferences对facade Author state保留safe非零negative localID，legacy localStorage/Entry/HTTP positive规范化未改；actual button aria-pressed=true证明当前UI保留本地membership。rating两classes覆盖为本tracer后续first-GREEN，不宣称独立rating缺陷RED。
- 新tracer实际GalleryApp New Author→AddAuthorPage所有fields→直接detail→实际profile表单name/occupation/artwork/content→冷fakeIDB负numericID且稳定UID→真实AuthorPage tag/ViewLater；Gallery anchor及两class共享layout创建/rating用production facade（**未宣称这三项actualUI手势证明**）→origin-backed联既有Work→真实app.request/迁移memorySQL→create response-loss→冷ACK-loss→再次冷exact原UUID/body重试→同一UID单Producer numericID、profile/tags/ratings/viewlater/Work刷新和outbox cleanup。workless list隐藏/direct detail保持。原requests canonical bytes不追加字段；每original重复body字符串Set=1。
- 当前focused11/default1239/integration705：success=true、failed0、pending0；shared/server/web types、rootlint、diff PASS；T3_SW_BUILD=1隔离client Vite PASS（完整输出保留）。不是SW/PWA/APK/手机/TCP证据；没有新nativecontract/Java/fixture改动，没有重跑历史JVM61，也没有新production Worker timeline证明。
- **第一未闭合仍gap4：新Author在未replay前的独立Directory-set scope身份供应，以及联作品后的实际Directory UI冷编辑纵向。** producer.create只持Producer UID；server INSERT触发创建随机独立Directory-set UID，现create envelope没有可信预供identity，不可假定两UID相同或猜scope。需要新的未seal create显式向后兼容scope字段+新cap failclosed，并协调共享/server/native/restore+真实JVM；本轮未启动这项合同扩展、未留新未实现Directory RED。不用在线-only禁用冒充完成。
- gap1其余完整negative、gap5 restore完整矩阵、gap6 connected/cap/旧fieldunknown/错误snapshot、gap7 production native timeline按原状态继承，均未宣称闭合。本组可用GREEN只属于上述bounded cells；预算收束不等于已完成用户要求完整gap4。
- 最新fullbytes checkpoint `.hermes/tmp/offline-parity-author/gap4-checkpoint/manifest.json` 包含全部ledger sources/tests/report、gap4-start diff、exact saved report哈希、当前真实JSON/log和隔离Web。旧before/continuation-start/continuation-02-start/directory-start/各checkpoint不覆盖。父继续维护CURRENT/board，本writer不修改。
- 未read/touch/request正式DB/assets/8765/8766；未改migration/v45 cache三文件/媒体/PairedTransport/NativeAuth/pinning/APK/version/signing；无commit/reset/stash/checkout/deploy。

## Checkpoint / evidence

旧before/continuation-start/continuation-02-start/working-checkpoint/continuation-02-checkpoint均原样保留；本轮开始已验证13项live SHA并保存directory-start全字节。最新checkpoint：`.hermes/tmp/offline-parity-author/directory-checkpoint/manifest.json`，WORKING_NOT_OWNER_GREEN，含12 source/test+最终report exact fullbytes、start/original scoped diff、真实当前JSON/log及isolatedclient Web hashes。下一轮先比ledger/checkpoint/live SHA，不重跑已落盘脚本。

保护边界：未read/touch/request正式DB/assets/8765/8766；未改immutable migrations/cache-names/offline-media/offline-media-task；未清cache/卸载/重下媒体；未改APK/version/signing/PairedTransport/NativeAuth/pinning；无git commit/reset/stash/checkout/deploy。父维护CURRENT/board，本writer不修改它们。


## Directory seed continuation — STOPPED on external source drift (latest status)

本轮为唯一 production/test writer 接续；已落盘 seed scripts 仅静态读取/在内存核对，未重新执行。8个未随后修订 seed-impl 源SHA及 pending-work-restore 指定最终SHA匹配；seed-fix 的5文件以 before 完整bytes及 AST literal edits 内存复演并核对最终 foreign nonempty Directory fixture，均匹配。独立 seed-closure-start 保存27份完整bytes（19 owned source/test + 7新纳基线tests + report），未覆盖旧恢复点。migration042 原SHA ee9dccd44efe6cf383633d7e44ebab39368a58a9e8c1da0f6d971c362cdbb008 未改/未正式应用。

### 已完成与当前阻断

- 旧 seed-integration.json 的695pass/14fail是真实断言RED：latest schema41→42；新增独立Directory-set INSERT journal令 sync seed从5到6。隔离 migrated-memory生产repository probe实际查到6条：Directory-set create/v1；Producer create/v1；Entry create/v1；Entry关系 update/v2；Content create/v1；Entry媒体 update/v3。Entry版本不因此增加。probe首次错误relative import为setup failure，修正后输出保存在 seed-closure-journal-success.log。
- 本轮只修改7个 server integration baseline tests，全batch预flight、实际dirty fullbytes备份与SHA守卫。最新schema断言42；明确 migration applied 列表新增42、idempotent skip及count42，新增逐migration归一LF checksum验证；旧v31/v12/v34历史边界原样保留。sync seed新增完整6条 kind/change/version/seq严格断言；receipt/restart/tombstone/snapshot序号按新增journal对应更新，Entry revision断言不变。rollback拟强化完整journal和sqlite_sequence前后等价，**但声明插入因CRLF anchor转换未落盘，当前beforeJournal/beforeSequence未定义，尚未完成修复**。不要把这些tests称GREEN；checkpoint保留实际partial字节。
- 正确POSIX npm exec pnpm typecheck已执行，不再使用错误cmd.exe wrapper。真实exit2：既有新seed probe.ts:1158调用 buildSyncCapabilities 缺 serverBuild 参数；本轮 sync.integration 三个rollback缺 beforeJournal/beforeSequence，共6个TS2304。types此前 seed-types1 GREEN属于早期证据，不覆盖当前；seed-types.log语法错误仅wrapper setup failure。最新失败日志 seed-closure-types.log/exit 原样保留。
- seed-closure focused JSON真实15/15 PASS，success=true，failed/pending0。default JSON结果见checkpoint gates summary；**其运行期间外部改写 GalleryApp.vue 和 gallery-app.test.ts，不能将结果归因到冻结的本writer来源或宣称current default GREEN**。guard发现后退出1，未启动本轮integration/lint/diff/Web；无当前完整gates GREEN。
- 发现外部源码漂移后立即停源码写入与后续gates。相对 seed-closure-watch.json 的 GalleryApp.vue/gallery-app.test.ts expected/actual SHA已登记 seed-closure-drift.json；不覆盖、回退或吸收另一AI优化。新Writer继续前须父协调 ownership/重新确认来源，并先修复本轮已明确类型问题。无03，无02 owner GREEN；gap4 Directory seed功能实际已落盘，full gate/native闭合仍不足。

### Directory seed已落盘功能证据（不是本轮新native GREEN）

显式可选 create.payload.directorySetUid，offlineStandaloneAuthorDirectorySeed条件cap、server INSERT独立scope绑定/不可变seed、scope journal、client本地Directory投影/producerCreates因果传递、restore collision、防foreign owner已实现。旧create无字段保持无字段，新cap false/absent拒新seed，不因新cap阻挡legacy retry。独立scope不等于ProducerUID，不跨owner版本比较。现15focused覆盖真实冷Directory双Work手势、atomic pending restore、application HTTP/memorySQL、response/ACK loss exact original retry；原真RED与setup失败仍保留旧日志。app.request不等于手机TCP。

此前 seed-jvm.log 真实 BUILD SUCCESSFUL in8m23s、63 actionable tasks 是task数不是测试数。新Java AuthorDirectorySeedJvmTest有2个@Test，静态内容包含field presence/legacy bytes/generated contract与productionWorker absent/false/enabled byte retention；Java/contract/fixture已变，不能复用旧61suite。seed suite XML/full native test-count归档缺失，当前shared结果可能被另一AI覆盖，本轮严格未读其XML作为证据、未运行Gradle或写共享Android输出。当前完整native证明UNVERIFIED；需先协调隔离build输出再另行执行，gap7 create→edit→delete/held/resume专门Worker timeline仍OPEN。手机/WebView/PluginCall/Keystore/force-stop/touch/IME UNVERIFIED，无APK。

### 实际STOP checkpoint

最新 `.hermes/tmp/offline-parity-author/seed-closure-stop-checkpoint/manifest.json` 登记全部27份当前source/report fullbytes，source continuity/original-before hashes、7test before/after ledger、exact report saved SHA、实际新旧JSON/log和Web artifacts hashes。GalleryApp live因external drift与expected不同，仅列observed-external，不冒充本writer输出或GREEN恢复源。旧 gap4/checkpoints是historical，不覆盖当前seed。source/gates summary及native边界与report一致。

未read/touch/request正式DB/assets/8765/8766；未改migration042或existing migrations/v45 cache三文件/无关media；未default doctor/probe/deploy；未Android build/test/APK/版本/签名；无cache clear/uninstall/redownload、auth/pinning bypass、git commit/reset/stash/checkout。父维护CURRENT/board，本writer不修改它们。


## Parent resume — CURRENT SOURCE GATES GREEN (not complete Author02)

User explicitly released the additional pending-work-restore test writer. The released GalleryApp, restore-test cache adaptation and v46 transport optimization remain in the live baseline; no old checkpoint was restored. Parent took sole source/test ownership after all previous executors stopped.

Only two files were patched after full-byte backups and complete candidate preflight: database/probe.ts supplies the existing 'probe' serverBuild argument; sync.integration.test.ts captures actual complete journal and sqlite_sequence before each of three receipt-failure rollback tests. The existing three tests were run first and each failed with ReferenceError: beforeJournal is not defined; after the fix all three passed. This is repair of introduced test/type defects, not a new Directory-business RED.

Fresh current gates after these patches: Author focused15/15, default1239/1239, integration709/709; all JSON success=true, failed=0, pending=0. Shared/server/web typecheck, root lint, diff-check, isolated T3_SW_BUILD=1 client Vite passed. Watched32 source/test/report files remained byte-identical before/after each broad gate. Client bundle is not SW/PWA/deployment/APK evidence. No Gradle run or new native suite/count is claimed.

Directory identity seed functionality and schema42 baseline tests now have current source-gate closure. Author02 remains WORKING: remaining finite negative authority, restore, connected/no-copy/old-copy/capability/snapshot, ordinary create-origin caller variants and production-native timeline cells are still inherited. Next bounded work is restore/connected facade coverage, not Collection03. Native field-presence test and full Worker timeline remain unverified until fresh executed/archived proof.

Latest full-byte checkpoint: .hermes/tmp/offline-parity-author/parent-resume/checkpoint/manifest.json. It records current source/report, released external provenance, actual RED/nearest-GREEN/type/full-suite logs and isolated Web hashes; older STOP/GREEN manifests are historical. No formal DB/assets/default services, migrations, caches, APK/signing/deployment or git history were touched.
