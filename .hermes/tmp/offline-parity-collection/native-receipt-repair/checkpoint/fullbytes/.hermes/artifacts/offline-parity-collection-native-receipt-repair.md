# Collection03 native actual-kind receipt repair — finite GREEN / writer stopped

## Outcome

Production repair attempt 1 passed the frozen `NativeCollectionTimelineJvmTest` c1–c4: **tests 4, failures 0, errors 0, skipped 0; actual Gradle exit 0**. No test or fixture assertions were changed. The previous genuine RED (4 failures, 0 errors, 0 skipped, Gradle exit 1) is preserved as `native-receipt-repair/prior-red.xml`; its original archive remains untouched.

Nearest bounded regressions, separately isolated, passed with actual Gradle exit 0:

| Class | Tests | Failures/errors/skipped |
|---|---:|---|
| AppliedReceiptJvmTest | 2 | 0/0/0 |
| TransferLedgerJvmTest | 6 | 0/0/0 |
| NativeAuthorDeleteTimelineJvmTest | 3 | 0/0/0 |

## Exact root cause and repair

The Worker and ledger dependency gate both used `AppliedReceipt.valid(receipt, opId)`, a strict generic applied-result whitelist. It rejected legitimate Collection delete/common-tag nested proof but accepted a common-tag applied result missing the actual-kind-required proof. An opId-only predecessor check could not establish owned scope.

Only three production files changed:

- `AppliedReceipt.java`: new original-operation overload. Known kinds without Collection proof retain the old strict generic validation unchanged; unknown kinds fail closed using the generated contract. The old String overload remains strict and compatible. For `collection.delete` and `collection.common-tag.add`, only the correct kind-specific extra is admitted and it is mandatory. Nested objects use exact allowed/required key sets, UUID/type/noncoercion and safe-positive/nonnegative integer checks.
- `BackgroundTransferWorker.java`: the settlement gate supplies the actual original `op`, not merely its id.
- `TransferLedger.java`: completed predecessor receipt is validated with the retained original operation body. Stored client/library/epoch and SHA256 are checked against that body, plus dependency id, before the same typed validator is used.

Typed semantics are derived from live `packages/shared/src/schemas/sync.ts`, shared `collection-common-tag.ts`, and web `validateCollectionDeleteReceipt` / `validateCommonTagReceipt`: root UID/id and own baseRevision+1; exact unique owned journal set; each child/target's own captured revision+1; top serverSeq equals maximum journal sequence. Delete root must be journal[0]. Common-tag target selection and affected/alreadyPresent/skipped counts match the shared helper, tag id/UID null pairing and payload tag identity are enforced. No cross-owner revision ordering is introduced. Cross-kind proof fields and unknown extras fail closed. No receipt libraryId/syncEpoch/resourceKind fields or defaults were invented. Generic optional entityId absence, UUID domain and legacy safe integer rules remain intact.

Raw native receipts still confer neither foreground journal/snapshot authority nor ACK/IDB cleanup. No Native clear was added.

## Actually reached evidence

Fresh final Collection XML system-out contains **12 CAP_HOLD**, two VALID_RETRY, CHAIN_BULK, and all of FAULT foreign / FAULT shape / FAULT owned / RESTORED_VALID. Thus c4's missing-proof assertion now passes, and the previously unreached owned-journal UID negative and valid restoration execute in this new run. All frozen phase/body/hash/plan/scope/mutation-count/independent-owner assertions pass. Completed retained rows are not replayed again.

This is real production Worker, native SQLite/cold reopen, production planner, pairing and pinned TLS against private temporary fixtures. Business replay receipts are **CONTRACT MOCKED**, with asserted SQL receipt count zero. Temporary Collection context/identity readers are not canonical business SQL application. This does not establish phone/OS/plugin/Keystore/WorkManager device behavior or foreground cleanup.

## Isolation and exact evidence paths

All new artifacts are beneath `.hermes/tmp/offline-parity-collection/native-receipt-repair/`:

- `collection-green-1-archive/gate.json` and `project-app/test-results/testDebugUnitTest/TEST-com.speechless666.t3.spike.NativeCollectionTimelineJvmTest.xml`
- `nearest-legacy-1-archive/gate.json` and three corresponding fresh XML files
- Both archives retain actual stdout and generated `NativeMutationContract.java`.
- `run.py`, `isolated.init.gradle`, `prior-red.xml`, `before-manifest.json`, `before/`, `owned.diff`, `diff-check.txt`, `protected-check.json`, `fixture-process-check.txt`
- `checkpoint/manifest.json` and `checkpoint/fullbytes/` contain live/saved size/SHA verified full-byte handoff copies, including production/test sources, fixtures, generated contracts, XML/stdout/gates and this report. The manifest is intentionally outside its own entry list.

Both executions use offline/no-daemon Gradle and exclusive project cache. The init sets layout.buildDirectory in beforeProject for root/app/Capacitor/Cordova, verifies all project directories after evaluation, and rejects assemble/copyweb/syncassets or protected web dist/main-assets output tasks. Actual stdout confirms all four project output roots are isolated per fresh token. No APK or web synchronization/deployment occurred.

## Source integrity and limits

Fresh baseline captured 32 full-byte source/test/shared/fixture files. Exactly the three authorized production files differ; the other 29 match byte for byte. Native timeline tests and fixtures are unchanged. The parent's 79-entry checkpoint has 76 exact matches and only the same three authorized production differences. LF newline style was preserved. Owned git diff --check exit 0; complete before/after diff archived. No old snapshot was restored onto live source. No new helper/test/source contract file was necessary.

Fixture process inspection returned no surviving native Collection/Author Node timeline process. Fixture finally blocks completed. All source writes stop at this handoff.

No transport/pin/auth/newscope, queue planner/server/shared schema, root/settings/perf/v45media/v46, immutable migrations, formal DB/assets/services/credentials, APK, deployment or git history changes. No full-root matrix was run, no 03 DONE/04/mobile-proof claim is made. Existing unrelated foreground gates were not rerun.

Issue encountered: requested skill reference `references/native-worker-acceptance.md` is not present; loaded the available `references/native-isolated-worker-proof.md` instead. File search tools returned a Windows path mapping failure, so scoped direct pathlib inspection was used. Neither caused harness/test changes. No production patch retries or fixture construction failures were needed.
