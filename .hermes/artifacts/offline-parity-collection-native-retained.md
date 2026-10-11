# Collection03 Native finite4 — production RED retained / STOP

## Outcome and authoritative execution

Acceptance-only writer STOP. No production edits; no03DONE/04/APK. Final owned class `NativeCollectionTimelineJvmTest` actually ran `c1,c2,c3,c4`: **tests4, failures4, errors0, skipped0; Gradle exit1**. Final XML timestamp `2026-10-10T02:38:52.672Z`. Runner wrapper exit0 is not the Gradle result.

Authoritative evidence: `.hermes/tmp/offline-parity-collection/native-retained/finite4-final-red-archive/` contains actual suite XML, stdout, generated `NativeMutationContract.java`, parsed gate and Worker trace. `checkpoint/manifest.json` seals exact fullbytes/live/saved/size/SHA. Existing guarded sources unchanged (29 files; bounded inventory, not whole-repo freeze).

## Frozen four-cell result

| Cell | Observed / not completed |
|---|---|
| c1 delete | Generated contract and production plan/Native flags align. All three actual required flags individually absent and false (6 scenes) cause held, replay null, zero MutationHTTP, exact original+hash+plan+client/library/epoch retained after native SQLite reopen. Restore flags, truncate applied strict contract receipt, close/reopen, Worker sends byte-identical original twice. Valid `collectionDeleteJournal` receipt is then incorrectly held instead of completed: actual production RED. Completed-row resume/dedup assertion remains unexecuted because of this RED. |
| c2 common-tag | All three actual required flags individually absent and false (6 scenes) pass the same zero-write/cold retention checks. Valid strict nested counts/journal receipt, response loss and cold exact-body retry reach production receipt validation; valid receipt incorrectly held: actual production RED. Completed retention/dedup remains unexecuted. |
| c3 held local-origin create/member → bulk → delete | Actual generated planner dependencies. offlineCollectionManagement false holds create; member/bulk/delete active and blocked; independent Entry completes with sole mutation request. After flag recovery same original create resumes, actual Worker completes create then member (not manually marked completed). Bulk valid nested receipt becomes held, prevents successful full chain: actual production RED. Later complete delete/order assertions unexecuted. Local-origin business replay is explicitly CONTRACT MOCKED; canonical temporary SQL supplies current root/member/facet/context identities, not actual create/member business replay. |
| c4 malformed receipt | Foreign opId rejected and delete remains blocked; independent Entry completes. Fault then removes mandatory-for-actual-kind `collectionCommonTag` from an initially strict-valid receipt: Native incorrectly marks bulk **completed**, not held: actual production RED. Owned-journal UID variant and valid restoration are unexecuted after this failure. No claim that their checks passed. Mutation-count/delete-send assertions after the failing shape assertion were not reached. |

General offlineMutations downgrade is tested with a single staged operation; independent Entry is not claimed capable of bypassing that general flag. c3's independent-owner progress uses Collection-specific management downgrade.

## Minimal production repair seam for next owner (NOT modified here)

`AppliedReceipt.java` currently whitelists only opId/status/resourceVersion/serverSeq/entityId. It rejects both legitimate new nested keys. Conversely a generic applied object lacking actual-kind proof is accepted. `BackgroundTransferWorker.execute` invokes `AppliedReceipt.valid(receipt,id)` without the original envelope; `TransferLedger.dependenciesApplied` also calls that generic validator for predecessors.

A single production owner should introduce **actual-kind-aware** strict receipt validation with original ownership/version/count/journal scope, consistently in Worker settlement and dependency authority. Do not just allow new keys or relax all kinds: shape-omitted bulk is already a false positive. Do not require libraryId/syncEpoch/resourceKind in receipts (current shared strict schema does not define them). Reuse original stored envelopes and current foreground validators' defined owned checks. Rerun only these frozen4 after the repair; extend neither kinds nor cases here.

## Real / mocked / unverified

REAL: production queue builder, originalMutationEnvelope, mutationQueuePlan, current shared original/strict receipt schema, production bounded SQL common-tag/delete identity reader, temporary migrated server file SQLite, private dynamic secure listener and claim/pinned TLS, actual Worker core, Robolectric NATIVE SQLite, close/reopen, same-byte response-loss retry. Legal new-kind receipts are first parsed by current shared schema and validated by production foreground actual-kind receipt validators before fault injection. SQL sync_operation_receipts count0 assertions execute in all four final tests before the failure.

**CONTRACT MOCKED business SQL replay**: receipt map/HTTP truncation only; not canonical server business application, not real-device Android. Native raw receipts/originals are retained, never foreground snapshot/journal/ACK cleanup authority. Physical device/Keystore/PluginCall/WebView/OS WorkManager/force-stop UNVERIFIED. Direct execute is actual Worker core, not OS scheduling.

## Isolation / attempts / scope

Owned init sets every project's layout.buildDirectory in beforeProject and verifies root/app/capacitor-android/capacitor-cordova effective paths. Task graph guards assemble/copyweb/syncassets and protected web-dist/main-assets outputs. Only testDebugUnitTest named class executed, offline/no-daemon/JDK21/explicit SDK/repo, owned project cache. All outputs for each run have fresh token under native-retained/gradle-output. No old shared app/build XML used.

Preserved attempts: fixture-smoke.stdout records openssl ENOENT from incomplete subprocess PATH; final runner supplies verified installed Git usr/bin. finite4-first-archive records first class4 failures (c1/c2/c4 test-harness assumption that resuming already-active work returns true; c3 already showed real valid-receipt RED). Corrected only those new-test resume assertions, then entire frozen4 final run. First test source reconstruction is explicitly named reconstructed, not original baseline provenance. No harness failure presented as production RED.

New repository files only: NativeCollectionTimelineJvmTest.java; apps/server/tests/fixtures/native-collection-timeline.mts; this report. New init/runner/manifests/archives under exclusive .hermes/tmp/offline-parity-collection/native-retained. No existing tests/native/auth/pinning/source edits, migration edits, formal8765/8766/formalDB/assets/envcredential access, APK/buildapp/assemble/capSync/deploy/cache clear/uninstall/redownload/sign/version/git destructive operations. No full-root tests/types foreground48 rerun. No CURRENT/status writes (parent owns those). No pending background writer. STOP after sealed production RED handoff.
