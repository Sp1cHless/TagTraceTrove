# 06 canonical conversion — first working SQL GREEN; source/test writer STOP

## Outcome
Production now accepts one strict `entry.authors.convert-to-multi` command through `/api/sync/replay`. First real migrated-memory HTTP-route RED was **0 PASS / 1 FAIL**, response 400 because the kind was absent. After production implementation the same tracer reached **1 PASS / 0 FAIL**. Final current-source gates: **new canonical 8/8 + frozen Online 5/5 = 13 PASS / 0 FAIL / 0 pending**. Shared/server TypeScript and scoped ESLint exit 0. This is the requested canonical first working command, **not 06 DONE**.

The first implementation attempt returned 500 due to a capability-function export typo; the paired server typecheck exposed that and a literal DTO type mismatch. Both were fixed without validator weakening. Historical logs retain this failed attempt. No semantic blocker or Online-rule change.

## Actual production changes
- `packages/shared/src/schemas/sync.ts`: strict operation union member; positive Entry base revision; frozen unique affected Producer UIDs/names/own revisions/full work UID sets; explicit existing-target UID/revision versus absence; frozen payload target UUID; semantic uniqueness/work-owner/target-match checks. Applied result has optional typed `conversion` retaining exact legacy DTO IDs/names after physical contributor deletion. Legacy result shapes remain legal. Conflict uses existing strict `producerUids` current-values variant.
- `packages/shared/src/schemas/native-mutation-contract.ts`: typed Entry owner and required flags **offlineMutations**, **offlineEntryMultiAuthorConversion**; contract now **31 kinds**. No conditional marker added.
- `apps/server/src/sync/sync-service.ts`: advertises **offlineEntryMultiAuthorConversion** for schema >=43, alongside existing general flag. Replay itself reads migration metadata only and never runs migrations.
- `apps/server/src/sync/replay-service.ts`: one existing outer receipt/hash transaction owns Entry/Producer/target preflight, canonical conversion, stable target creation-origin row, journal/tombstones and receipt insertion. Exact original retry reads immutable stored DTO before querying now-deleted contributors; changed-body same UUID returns collision without business mutation. Entry's revision is never used as a Producer revision.
- `apps/server/src/repositories/entry-multi-author-repository.ts`: optional `replayTargetUid` only for absent target INSERT, setting immutable UID at insertion rather than updating a random server UID. Old two-argument calls remain unchanged. SQLite NOCASE earliest target reuse, ordering, target-only no-op, minimum credited authors and affected-only unlink/prune/cascades stay authoritative.
- New exclusive test `apps/server/tests/integration/entry-multi-author-sync.integration.test.ts`. First tracer uses actual createApiApp/app.request, explicit owned temporary dataDir/assets, migrated-memory SQLite, finally cleanup; other finite cells use production replay dispatch.

No migrations were added or changed. No new entity kind/journal table is necessary. 001–043 and five frozen Online tests are byte-preserved; generic pruning unchanged. No formal DB/assets/TCP/default services, frontend, hand-written Native, Gradle/APK/build/deployment/git side effects, CURRENT/board/todo or 07.

## Finite canonical evidence
1. Frozen creation target UUID, conversion DTO, affected one-work author physically removed, established author keeps peer work, unrelated workless author retained; exact UUID retry retains immutable DTO after deletion, no extra journal, one stored receipt; changed body collision.
2. Reuses earliest SQLite-NOCASE existing target without changing UID, even when a later duplicate exists.
3. SQLite BEFORE INSERT receipt-abort trigger proves rollback of credits, target, prune, Entry revision, journals, tombstones and origin; no receipt remains.
4. Fail-closed author own-revision change, changed other-work facts, absent-target/name race and target UUID already owned by unrelated Producer: conflict with zero business-state mutation.
5. Unsupported schema capability holds command without migration/backfill or business/receipt mutation.

Scoped gates: `gates/final-canonical.json`, `server-types-stop.log`, `shared-types-final.log`, `owned-lint-stop.log`; before/after gate SHA identical. All Node commands used direct absolute node.exe argv via Python subprocess.run, timeout 180, merged output, JSON counts actually parsed.

## Next writer exact handoff
Envelope keys:
```
{ opId, clientId, libraryId, syncEpoch, entityKind:'entry', entityUid,
  clientCreatedAt, operationKind:'entry.authors.convert-to-multi', baseVersion,
  baseValues:{authors:[{producerUid,name,version,workUids:[entryUid,...peerUids]}],
              target:null | {producerUid,version}},
  payload:{targetUid} }
```
All credited authors must be frozen, including an already-credited target if present. `target:null` freezes SQLite-NOCASE target absence and a new client UUID; existing target freezes actual earliest server UID plus its own Producer revision, and payload targetUid must match. Stale Entry or affected author, changed work set, target race/foreign UID fail atomically. Applied `{opId,status:'applied',entityId:entryId,resourceVersion,serverSeq,conversion:{entryId,multiAuthorId,multiAuthorName:'multiple author',convertedAuthors:[{id,name}]}}` survives immutable retry. Strict schema permits target-only no-op originals.

Foreground ordinary enqueue, unconditional successful-probe metadata persistence, bounded trusted UI preflight endpoint, optimistic cold cascade projection, coherent pending/successor scheduling, own receipt/journal proof, ACK-loss settlement/cleanup and valid saved-copy export/atomic restore remain **unimplemented this lane**. Current schema freezes own Producer versions/work facts, not separate Directory/Collection owner revisions; additional cascade-owner concurrency/settlement context should be assessed in the serial full foreground tracer, not inferred proved here. Newly-created conversion target origin is recorded; use of that origin by existing pending-create dependency validators is not acceptance-tested (conversion receipt entityId is Entry, unlike legacy author-create receipt).

Shared Native registration is present. `gates/NativeMutationContract.java` is a mechanical equivalent of the actual `android/app/build.gradle` generator task with decoded 31-kind equality checked (`metadata-equality.json`); **actual Gradle generation/build-output equality and Native runtime consumption were NOT run** under this lane's no-Gradle/no-Native scope. Existing all-kind fixture registration needs the new shape in the later foreground/Native lane; no old fixture/test was rewritten to inflate acceptance. No frontend 158/140/all-kind suite, web types, Worker or restore/ACK claims.

## Byte preservation / STOP
Inherited checkpoint manifest has 719 rows. Comparison finds exactly five authorized production files changed; no inherited outside-domain/old-test/migration drift. Fresh original bytes for changed production are saved in canonical/before; unchanged inherited bytes stay verified against inherited checkpoint rather than restoring older654/691. Final checkpoint manifest records current complete live/saved bytes, size and SHA, using verified inherited saved references for unchanged paths and fresh fullbyte copies for changed/new artifacts. Source/test writer is STOPPED; parent allocates next serial foreground writer. 04 markerless eligibility and 05 noCopy/noTrustedSnapshot restore gaps remain separate.
