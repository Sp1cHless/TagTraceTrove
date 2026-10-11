# Collection delete — bounded foreground/SQL vertical handoff

## Outcome and stop boundary

**The eight finite Collection-delete foreground classes below are GREEN, backed by 21 real integration assertions. Collection03 is NOT DONE. Production/test writing stopped after the bounded gates and archive.** Bulk common-tag remains a real RED and native Worker/generated Java execution remains UNVERIFIED. No04, full-root build, APK, deployment, commit, formal database/assets access, listener request or restart.

Latest Collection-only authorization superseded CURRENT's historical shared-file exclusion. Only Collection imports/interface/method/route anchors in `api/gallery.ts` and `http/app.ts` were modified; no System, Settings, navigation, launcher or backup behavior was changed. The prior repository DISTINCT fix is retained unchanged.

## Implemented chain

- Added `GalleryApi.getCollectionSyncIdentity` and `GET /api/collections/:collectionId/sync-identity`. Uses existing library/epoch and Collection immutable UID/version, kind, parent UID and complete direct-child UID/version scope. Maximum 200 children; oversized scope refuses rather than truncating destructive scope. There is no whole-snapshot preflight, UID guess, ordinary DTO change, or numeric DELETE fallback.
- Strict `collection.delete` union with mandatory frozen scope; duplicate/self-owned children and unsupported nesting refused. Operation-specific `offlineCollectionDelete`, general mutation and Collection-management flags are explicit. JS/native-contract metadata includes all three. Foreground new-kind replay does not inherit the legacy implicit absent-global permission; unrelated legacy envelope behavior is unchanged.
- Existing replay receipt transaction validates current owner revision and exact direct-child identities/revisions, deletes folders/members only, and saves one immutable receipt containing every owned delete journal identity/version/sequence. Root and child counters are compared only against their own UID chains. Exact original UUID/body returns its stored receipt after absence; different UUID fails, changed body collides. Existing immutable migrations028/037/042 were not edited; no migration was added.
- Durable enqueue precedes transport; projected Collection/member removal survives cold open. Child membership and complete Collection order predecessors block deletion; an independent Entry can progress. Restore preserves actual attempted rows/metadata and rejects structurally valid later deleted-child writes atomically.
- Cleanup requires canonical applied receipt, every matching Collection delete journal, snapshot identity/owned absence/cursor coverage and durable ACK. `collectionDeleteProof.<opId>` stores only previously verified foreground authority, bound to the immutable original operation fingerprint and full owned journal receipt. ACK-loss retry revalidates receipt/scope and absence/cursor, then reuses only exact proof. Corrupt fingerprint or foreign-child proof cannot authorize `removeMany`; native raw receipt JSON is not read as this proof.
- Connected no-copy and older-copy/new-server-folder actions use bounded identity and persist originals. Real replay response loss and real ACK processed-but-response-lost both retain exact UUID/body through cold retry. A connected first-use caller additionally negotiates flags when local capability metadata has not yet been populated.

## Eight finite cells

| Cell | Exercised coverage | Result |
|---|---|---|
|1 Caller/cold/cascade | Actual CollectionsPage double-confirm; root + direct child removal; Entries, Author, shared tags, Author links and peer membership survive; replay and ACK loss | PASS |
|2 Connected identity | No installed copy; older installed copy + new server folder; bounded preflight before replay, no snapshot-before-write or numeric DELETE; replay/ACK loss and cold originals | PASS |
|3 Scope shapes | Root+child, direct-child-only, Author Collection, empty folder; strict missing/duplicate scope; original absence receipt and collision | PASS |
|4 Concurrent scope | Child added or child edited after frozen enqueue; canonical SQL conflict and unchanged original envelopes | PASS |
|5 Causality | Held child membership + independent Entry progress; release and ACK retry; held complete Collection order + explicit planner dependency and release | PASS |
|6 Capability/legacy | Each of three flags false and genuinely deleted IDB metadata key, cold new-write refusal; original delete cold replay downgrade refusal; unknown legacy child identity fail-closed | PASS |
|7 Restore | Actual SQL-committed lost-response attempted row export; atomic restore exact metadata; schema-valid later child write rejected without changing live queue; ACK-loss retry | PASS |
|8 Authority negatives | Actual ACK loss; corrupted fingerprint or foreign child in persisted foreground proof; cold old-journal refusal, retained originals and zero removal | PASS |

These cells cover existing saved Collections and newly server-created folders. They are not proof of every pending local Collection-create→delete/export combination: negative local numeric root identities remain unavailable until create reconciliation, and a pending newly-created child in a restored deletion scope needs separate origin-aware restore coverage. Do not silently promote that unexecuted origin extension into this finite result.

## Actual executed gates

Evidence directory: `.hermes/tmp/offline-parity-collection/delete-vertical/`.

| Gate | Actual result |
|---|---|
| Final dedicated delete `delete-final21.json` | success true; 21 passed, 0 failed |
| Nearest SQL/Author/Entry integration `nearest-integration.json` | 56 passed, 0 failed |
| Nearest Collection caller/planner/restore/shared default `nearest-default.json` | 42 passed, 0 failed |
| Ordinary Collection parity `ordinary-parity.json` | 2 passed, 0 failed, 1 intentionally filtered-out common-tag case |
| Shared types; server types; web vue-tsc | exit0 each |
| Owned ESLint / scoped git diff --check | exit0 / exit0; checkout CRLF warnings only |
| Remaining common-tag obligation `common-tag-red.json` | exit1, 1 failed: known-offline facade still POSTs `/api/collections/1/tags`; not `it.fails` |

Raw TDD evidence is retained: corrected caller RED (`red-corrected.json`, numeric DELETE), first tracer GREEN (`delete-applied1.json`), explicit order dependency RED (`delete-planner-red.json`) and missing global replay flag RED (`delete-cap-replay-red.json`) followed by final21 GREEN. Most remaining cells were first-GREEN defense coverage, not separately observed production defects. Initial caller selector/timing and unknown checksum-helper failures were harness errors, not production RED. Type narrowing and optional-method typing were corrected. The initial ordinary connected capability RED was observed in actual gate output; its gate JSON was overwritten by the bounded rerun, unlike the separately named tracer/planner/capability RED files. Do not fabricate an original raw file for that result.

## Ownership, full bytes and provenance

Before bytes/SHA manifest registered ten existing files (including the separately registered original parity test); three new source/test files have no invented before baseline. Sequential byte replacements were preflighted with unique anchors and full-byte checks. Per-gate owned and six concrete dependency hashes are saved before/after, with unchanged results on the final gates. Scope is not a whole-tree freeze.

The generic targeted patch tool unexpectedly normalized mixed newline bytes in offline-api during the connected capability fix. This was repaired immediately from genuine full before bytes + the saved sequential applied candidate script + the single required capability change, with **complete normalized-content equality** checked before replacement. `mixed-newline-repair.json` records hashes and method. No unrelated business content was restored from HEAD or overwritten. Shared app/client outside-Collection byte equality and final full-byte live/saved/SHA verification are in the checkpoint provenance/manifest. Parent retains CURRENT/board ownership.

## Common-tag context, prepared only

The new bounded Collection scope can supply kind/parent/direct-child identities to a later tag lane. Existing bounded Entry queries already filter by Collection and paginate membership, but compact ordinary summaries do not establish each Entry's complete sync version/base tag assignments or atomic multi-owner staging. A future bulk tag design must freeze a consistent unique member set and each Entry/tag/Facet owner context, or define a canonical atomic bulk command. No second protocol or half-queue implementation was written. Existing DISTINCT and ordinary unique-count proof remain intact.

## Deferred concentrated obligations

- Run the existing Gradle `generateNativeMutationContract` task and actual retained-ledger/Worker Collection timelines with exact metadata, held predecessors, pinned authority, loss/cold retry and foreground cleanup separation. `build.gradle` derives Java directly from the same shared TS contract; this round checks shared/JS metadata and records that derivation, but does not claim generated Java, JVM, Worker or phone PASS.
- Origin-aware local Collection-create→delete/restore combinations beyond this finite matrix, if required for the next authorized acceptance boundary.
- Complete atomic bulk common-tag lane; Collection03 overall reconciliation belongs to parent after that and native evidence.
- Global/release/device/OS lifecycle gates remain deferred. No03-all-complete, 04 or APK claim.
