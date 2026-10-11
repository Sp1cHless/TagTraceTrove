# 04 Gallery Native finite acceptance — retained genuine RED

Status: Native acceptance RED; source/tests STOPPED. 04 is not DONE. No 05/APK/full-root/build/deployment or live service/formal DB/assets changes.

## Outcome and real execution

- New exclusive `NativeGalleryFiniteJvmTest.g1` executed production Worker core, PairingState, pinned private TLS and real Native SQLite under Robolectric sdk28/NATIVE. Exclusive server fixture used production secure pairing listener, temporary migrated file SQLite and explicit temporary dataDir/assets. Replay used the actual `createApiApp` canonical SQL path, **not CONTRACT MOCKED receipts**. The fixture parsed original envelopes and unmodified responses with current strict shared schemas.
- Existing-type `entry.create` with genuinely absent `partitionScopeUid` reached `completed`. Worker sent the exact sealed original body; native row/body hash/client/library/epoch/plan remained identical. Canonical temporary SQLite contained one actual operation receipt. XML system-out: `REAL_SQL_EXISTING_ABSENCE completed exact body receipts=1`.
- Next, production queue builder/original-envelope/planner produced a legal new-type create containing `partitionScopeUid`. Its actual shared plan required `[offlineMutations,offlineEntryCreate,offlineGalleryPartitionOrigins]`. Production `NativeMutationPlan.flags(original)` returned only `[offlineMutations,offlineEntryCreate]`.
- Genuine `org.junit.ComparisonFailure` at `NativeGalleryFiniteJvmTest.java:59` preserves that original contract mismatch. It is a production assertion RED, not a fixture syntax/path/TLS/SQLite failure. The post-failure origin stage/Worker/SQL assertions were **not reached**. No native production repair was attempted.

## Actual gate

- `:app:testDebugUnitTest --tests com.speechless666.t3.spike.NativeGalleryFiniteJvmTest`, nested Gradle exit **1**.
- Actual XML: tests **1**, PASS **0**, failures **1**, errors **0**, skipped **0**. Earlier successful subassertions are not counted as a passing JVM test.
- Gradle init sets every project's true `layout.buildDirectory` in `beforeProject`; effective root/app/Capacitor/Cordova paths were printed and verified under `.hermes/tmp/offline-parity-gallery/native-finite/gradle-output/target/`. Generated Java came from the actual shared contract task; parsed generated JSON equals the current shared JSON exactly. No hand-authored Java contract.
- XML, generated Java, counts, scoped metadata diff, diff-check and cleanup evidence are archived under `native-finite/actual-gates/`; actual stdout is `native-finite/target.log`. Scoped `git diff --check` exit0.

## Registration and minimal repair handoff

Only allowed shared metadata was patched: entry.create `fieldFlags.partitionScopeUid=offlineGalleryPartitionOrigins`; gallery.partition.set `fieldFlags.typeOwnerOrigin=offlineGalleryPartitionOrigins`. Base required flags/kinds are unchanged; `gallery.partition.set/gallery_partition` already existed in shared registry and was generated in this isolated run. This registration records the conditional requirement but does **not** repair NativeMutationPlan.

Smallest production-owner seam: `NativeMutationPlan.flags` currently ignores those field-presence conditions; align its conditional flags/order with actual `requiredMutationCapabilities`, preferably consuming registered metadata, while preserving absent-original semantics. `NativeMutationPlan.validate` exact requiredFlags comparison then refuses current origin packets; Worker invokes both plan validation and those flags. Do not remove the shared conditional flag or rewrite attempted original metadata/body to make staging pass.

After explicit transfer, separately inspect `NativeMutationPlan.validate` origin dependency binding: foreground plans require `typeOwnerOrigin.opId`, whereas Native validate explicitly checks parentCreateOpId/producerCreates/tagCreates/facetCreates only. This is an **unexercised candidate seam**, not another claimed defect. Worker/AppliedReceipt/TransferLedger production files remain byte-identical to baseline.

New-type `offlineEntryNewType` is an actual enqueue eligibility capability, not a universally registered required flag on all `entry.create` envelopes. Current shared original/planner has no explicit new-vs-existing-type replay marker, so this writer did not invent one or force that flag on existing creates. Native newtype capability-off acceptance is unresolved; after fixing the first RED, establish its lawful original/context prerequisite rather than guessing metadata.

## Finite matrix disposition / unreached evidence

First working tracer did not become GREEN, so expansion stopped by the acceptance-only RED rule:

1. Existing type / genuine legacy optional absence / new-type origin sealed-plan alignment: existing real SQL subpath reached; full `g1` RED as above. New origin Worker receipt, capability downgrade and optional-presence replay not reached.
2. Saved-type gallery.partition.set, each required capability individually false and truly absent, zero business POST/retention: NOT RUN.
3. Origin create → partition true → false same-owner serial execution; held creator + independent partition/Entry progress; global offlineMutations off: NOT RUN.
4. Native response loss/cold restart/exact UUID/body/hash/revision metadata retry and strict actual shared receipt/ledger authorization: NOT RUN.
5. Foreign/missing/invalid receipt bound to original/owner/version/sequence and child refusal, attempted cap downgrade exact retention: NOT RUN. Partition applied receipt shape must be read from the actual generic strict schema; no invented required nested proof fields.

Nearest JVM collection4 + AppliedReceipt2 + TransferLedger6 + Author3 was deliberately **NOT RUN after genuine production RED**. None is represented as GREEN on this lane. Prior foreground canonical SQL133 remains inherited evidence, not a new Native gate. No every-kind/allNative sweep.

## Files and protection

Modified source metadata: `packages/shared/src/schemas/native-mutation-contract.ts`.
New exclusive test: `spikes/001-android-webview-shell/android/app/src/test/java/com/speechless666/t3/spike/NativeGalleryFiniteJvmTest.java`.
New exclusive fixture: `apps/server/tests/fixtures/native-gallery-finite.mts`.
New report and exclusive before/isolated-output/actual-gates/checkpoint artifacts under `.hermes/tmp/offline-parity-gallery/native-finite/`.

Inherited 540-entry foreground checkpoint was verified live against its SHA before writing, then fresh full bytes were saved; additional Native source/tests expanded the baseline to570 entries. Pre-close audit: **569 protected baseline paths unchanged**; the sole existing-path change is the explicitly owned shared metadata. All existing migration bytes, Collection03 fixture/tests, Native Worker/AppliedReceipt/TransferLedger, protected cache/transport/pairing/settings/navigation/launcher/backup source remained unchanged. Complete checkpoint manifest excludes itself and verifies each entry's live/saved bytes/size/SHA; source/report/test/XML/generated dependency fullbytes are included. See `checkpoint/manifest.json` and `checkpoint-audit.json`.

Fixture Java AutoCloseable requested close and waited for child; fixture finally closes private listener/temporary SQLite and removes its explicitly allocated temporary directory. Actual Windows process cmdline scan found **zero surviving native-gallery-finite fixture processes**. No service started on8765/8766; only disposable fixture TLS listener was opened. No formal database/assets read or write, migrations modification, commit/reset/stash/checkout, packaging, APK, deployment, successor writer or protected production repair.

Evidence does not prove foreground snapshot/ACK cleanup authority, WebView PluginCall/Keystore/WorkManager OS lifecycle, force-stop/phone survival or platform completion. Native completion/raw receipt is not foreground cleanup authority. This RED is retained for a separately authorized minimal production repair; current source/tests STOPPED.
