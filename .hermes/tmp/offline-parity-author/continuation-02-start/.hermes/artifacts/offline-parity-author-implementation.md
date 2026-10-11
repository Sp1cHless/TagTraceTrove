# parity-02 Author implementation — WORKING, not full owner GREEN

## Outcome / writer handoff

本接续唯一 production/test writer 已停写。02未完整闭合，03未开始；不要把当前全部测试通过等同于有限要求全部覆盖。不存在审批/权限阻断；这次按预留收束预算完成验证与完整字节checkpoint，剩余gap需要接续源码/测试工作。

接续开始：原ledger 6文件SHA逐一匹配live；保存 `.hermes/tmp/offline-parity-author/continuation-start/` 全字节和manifest，不覆盖原before。只执行已落盘projection之后的10个剩余create edits，未从头重跑create-impl.py。所有production/test edits通过guard.py唯一anchor/SHA保留原CRLF/混合换行；scoped-diffs保留对各自before的diff。

## Proven tracers / actual RED

- 原create-red.log实际业务RED：AddAuthorPage离线submit转发POST /producers，Known offline。现真实AddAuthorPage所有字段(name/occupation/artworkRef/content)→durable producer.create→workless direct detail；列表hide workless；导出/atomic restore→冷fakeIDB编辑content→联已有Entry→app.request真实SQL replay→response-loss cold exact-body retry→ACK-loss retention→再次重试后cleanup，稳定UID/numericID收敛，PASS。
- create-resume.log实际RED：standalone create不是旧entry.author.create-and-link父，Producer dependency gate拒绝。outbox-store显式接受同client/library/epoch的producer.create父，tracer PASS。
- delete-red.log第一次只是Authors按钮text含count的selector harness错误，不能称业务RED。修正实际sidebar `.author-link`、进入Author detail/Edit后，delete-red-actual.log业务RED：双确认未enqueue producer.delete。现真实GalleryApp→AuthorPage双确认→durable delete→local/cold Author absence，作品保留→SQL删除本人→response-loss/ACK-loss完全相同原UUID/body retry→matching journal/absence/cursor/durableACK后cleanup，PASS。
- native-fixture-red.log：共享contract27 kinds而fixture25的真实contract coverage RED；补producer.create/delete shapes后GREEN。
- types-1/types-2保留修复过程中真实type errors；当前types-final PASS。不把这些编译错误称作用户业务RED。

## Current gates (same source boundary)

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

1. **混合Producer edit→delete authoritative settlement未闭合**：当前profiles/anchors/self-rating validators仍要求surviving producer。需要实际RED，按matching original receipts+同owner causal seq/version+verified delete authority授权前驱；不能无条件absence跳过验证。
2. **跨owner causal held-dependency未闭合**：producer.delete计划未显式等待引用本Author的Entry Authors、Collection membership、owned Directory-set retained/held先行操作。当前referencedEntityKeys/mutationQueuePlan缺少完整producer reference映射；先actual held row RED，独立owner应继续；跨owner只比较各自身份/seq因果，不能直接比较不同owner版本数。
3. 删除cascade完整矩阵缺少：本人tags/Directory/ratings/ViewLater/Collection关系清除；其他Author/作品/shared slots/layout保留；Directory-set独立owner receipt被后续delete移除的严格settlement。
4. 实际GalleryApp独立create→直接detail/编辑尚未自动覆盖（当前create仅真实AddAuthorPage+facade；GalleryApp已覆盖delete）。create所有后续编辑族目前只profile content有新identity支持；standalone tag/rating/viewlater/directory cold编辑仍需检查并RED→GREEN。
5. restore新增Author delete full exact export/collision/unknown-attempted retention/有效later edit拒绝矩阵；standalone create collision/reference检查，不能复用generic strict-schema错误冒充特定安全证明。
6. connected无副本/旧副本中新Author create/delete、uncertain create后普通delete、false/absent各cap actual caller冷metadata、错误/缺失snapshot profile/tombstone拒cleanup未建立有限证明。
7. Native已有generated/allkind gate通过，但新create→update→delete真实production Worker依赖/held-independent/resume/restore timeline缺少本项专门证明。Java源码无需改动不代表新scheduler矩阵已闭合。

## Checkpoint / evidence

当前checkpoint将保存为 `.hermes/tmp/offline-parity-author/working-checkpoint/manifest.json`（WORKING，非GREEN），包括11个源码/测试全字节、report、scoped diff、真实JSON/JVM XML/generated Java/Web-build hashes。原before与continuation-start完整字节保留；续接先ledger SHA匹配后定向patch，不得回滚original或重复已有脚本。

保护边界：未read/touch/request正式DB/assets/8765/8766；未改immutable migrations/cache-names/offline-media/offline-media-task；未清cache/卸载/重下媒体；未改APK/version/signing/PairedTransport/NativeAuth/pinning；无git commit/reset/stash/checkout/deploy。父维护CURRENT/board，本writer不修改它们。
