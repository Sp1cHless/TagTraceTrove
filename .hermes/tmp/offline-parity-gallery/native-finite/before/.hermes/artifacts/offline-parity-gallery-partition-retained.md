# Gallery partition retained foreground lane — parent recovery

Status: finite retained lane accepted; parity-04 remains WORKING. deleg_287ab264 stopped after API HTTP429, without a report/checkpoint. Its completed status is not acceptance. Parent inspected live trace and actual JSON, finished the remaining genuine no-copy RED and lint gate. No Native/05/APK/formal deployment.

## Actual exercised behavior

- Connected no-copy uses GET per-type partition-context, trusted library/epoch/type/UID/revision/value plus capabilities, one durable gallery.partition.set and canonical SQL replay. Response loss and cold repeat preserve UUID, envelope/raw body/fingerprint. Explicit replay must not download snapshot/media, use legacy PUT or activate a generation.
- Connected old-copy accepts server-new types from bounded canonical owner context, not guessed stale-copy identities; no snapshot/media fetch or PUT in that command tracer.
- New eligible offline entry.create optionally carries partitionScopeUid. SQL atomically binds the actual overlay owner to that explicitly allocated UID. Subsequent partition command freezes typeOwnerOrigin as the original strict creator envelope; server compares creator receipt/envelope hash. Gallery remains Entry.type-derived; empty layout remains empty. Capability offlineGalleryPartitionOrigins is required for that extension; genuinely absent capability/legacy unknown origin still refuses locally. Already attempted packets are never enriched.
- Local per-type staging serializes pending new-type create -> partition true -> false with owner baseVersions 1/2. Cold projection/export/atomic restore/real canonical SQL own journal/snapshot/durable ACK-loss retry are exercised.
- Altered owner UID, exact type, library, epoch, client, creator opId and creator body reject archives atomically; valid archive still restores/settles. Foreign embedded creator envelope also fails in real SQL without partition mutation.
- Held creator blocks its partition successors. Attempted capability downgrade retains exact original origins/bodies. Connected legacy without new capability can still use existing Online PUT only when no prior canonical partition command exists; attempted originals never fall back to PUT.

## Recovery and evidence

- Child connected-red.json and pending-red.json archive genuine missing functionality; other first-green defenses are not retroactive defect claims.
- Child nearest-sql.json had127/0/0 and nearest-default.json140/0/0, but later nocopy-auto-red.json was0PASS/1FAIL/5unselected: generic replay downloaded a full snapshot. Parent did not present that as GREEN.
- Parent minimal offline-api.ts guard retains no-copy partition originals after applied commands, bypassing snapshot installation/ACK cleanup; it does not authorize receipt-only cleanup. RED test assertions were preserved.
- Parent finite-green.json:6PASS/0FAIL/0SKIP. Current final-sql-fixed.json:127PASS/0FAIL/0SKIP, including retained6, type6, saved-partition6, protected Collection48 and nearest SQL61. Current final-default.json:140PASS/0FAIL/0SKIP.
- shared/server/web typechecks exit0. Owned lint initially found six unused test imports and one prefer-const issue from copied fixture; only unused declarations/const were changed. owned-lint-fixed exit0. Production lint passed before that test cleanup.
- Parent guards, full-before byte copies, actual command argv/exit/logs/JSON: .hermes/tmp/offline-parity-gallery/partition-retained/parent-resume/. Child earlier failing outputs remain preserved, not substituted with new output.
- Existing saved-partition negative test now explicitly removes offlineGalleryPartitionOrigins before creating its unknown-origin pending type. Its refusal invariant is preserved, rather than refusing the newly supported legitimate origin.

## Explicit remaining work

- Connected no-copy applied commands remain durable pending originals, without snapshot/ACK cleanup. Repeating the same desired value is tested; staging a DIFFERENT connected desired value currently refuses until earlier work is settled. This is a remaining ordinary-operation limitation, not merely an unverified claim. Resolve with bounded trustworthy predecessor receipt/journal/context causality, not implicit full-library download, guessed versions, original-body rewrite or receipt-only cleanup.
- Full finite conflict/held plus independent-owner behavior and complete derived hidden-surface/read/inflight visibility matrix remain pending. Current held-creator test is not that full matrix.
- New type/partition/origin generated Java contract and real Native Worker/ledger/typed receipt acceptance remain pending; foreground TS native-plan tests do not prove Native production behavior.
- WebView/PluginCall/Keystore/OS lifecycle/force-stop/device and global gates remain grouped at12. No full-root, build, APK, live service, formal DB/assets/env/pins/transport/cache changes. All migrations including043 remain immutable and formal deployment is not performed.
