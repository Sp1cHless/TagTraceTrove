# Collection local-create origin → delete — bounded foreground/SQL closure

## Outcome and stop boundary

**Dedicated Collection deletion: 25 passed, 0 failed, 0 pending — the previous 21 assertions remain intact, plus four finite origin classes.** This is not Collection03 DONE. Common-tag remains a real failure. Native/generated Java/Worker/device execution remains UNVERIFIED. Production and test writing stopped after scoped gates and the full-byte archive.

No formal DB/assets, default listener request/restart, env credentials, migrations, Native, 04, APK, build/dist, deployment, git commit/reset/stash/checkout, Settings/System/navigation or connection-recovery changes. No bulk-tag half-protocol. The same-file unrelated bytes in the large offline API are preserved; shared API/server files were not edited in this round.

Evidence directory: `.hermes/tmp/offline-parity-collection/origin-resume/`.

## Four finite classes actually exercised

| Class | Actual exercised behavior | Result |
|---|---|---|
|1 Local root caller | Retained original parent-proven RED test; actual CollectionsPage two-click deletion invocation; negative local root projection; durable create→delete queue; cold absence; real migrated-memory SQL replay response loss and processed-but-response-lost ACK; original UUID/body retries | PASS |
|2 Existing root + local child | Frozen queued-create child UID and initial revision 1; planner dependency on the child create; conflict-held create causes zero replay and preserves root; release, real SQL cascade and ACK loss; original queue retained until exact cold retry | PASS |
|3 Local root + local child | Origin-derived owner UID/base revision and exact child scope; cold projected removal; real SQL create response loss then create+child+delete replay/ACK loss; all original bodies invariant; Entries, Author, links, shared tags and peer membership survive | PASS |
|4 Export/atomic restore | Actual attempted create export; atomic restore preserves original rows, status, timestamps and errors; pending origin references validate without an installed owner; schema-valid later deleted-child write rejected with unchanged queue; foreign create receipt ID cannot settle/ACK; actual SQL receipts and ACK-loss metadata exported/restored again after installed absence; exact cold replay finally cleans up | PASS |

All business application in these chains uses the production replay HTTP handler and migrated isolated SQLite, not fabricated SQL output or native contract receipts. The foreign-receipt rejection is explicitly fault-injected over real SQL replay responses; it is not a claim of a naturally emitted server response. The existing-root local-child cell was first-GREEN defense coverage, not an invented production RED. The SQL fixture remains migrated memory with explicit temporary dataDir/assetRoot; no file-WAL crash or OS power-loss guarantee is claimed.

The empty local root UI can issue the two invocations before its first async removal finishes. The existing caller test was not loosened: a per-Collection in-flight delete guard now prevents duplicate durable deletion envelopes. This is invocation/deduplication proof, not a new UI policy claiming empty folders require confirmation.

## Minimal production changes

- `apps/web/src/offline/collection-delete.ts`: allow a projected local numeric ID only after matching a validated queued Collection create in the same client/library/epoch, immutable UID, kind and parent. Local IDs remain projection keys, never guessed server IDs. Strict scope/identity validation remains; missing legacy optional identity/version fields are not manufactured.
- `apps/web/src/offline/offline-api.ts`: pass parsed original queue origins into Collection scope resolution; coalesce concurrent deletion of the same projected folder; require a create receipt's numeric entity ID to match its owned delete journal ID, in addition to original receipt revision and causal sequence/order. For older non-create receipt kinds, an absent optional entityId remains absent; any provided ID must match. No old sealed envelope or metadata is rewritten.
- `apps/web/src/offline/pending-work-restore.ts`: resolve delete owner/parent/direct-child references from canonical rows plus prior validated same-device creates. Preserve complete frozen child identities; canonical children still need actual version metadata. Restore does not infer arbitrary absence authority.
- `apps/web/tests/offline-collection-delete.integration.test.ts`: preserve the recovered caller test and original 21 tests; append three further classes, for four origin classes total.

The initial projected revision 1 is the existing production `collection.create` projection/replay contract (queued create baseVersion 0), not invented from a negative numeric ID. Existing planner semantics already block child/create predecessors; no planner source change was needed. The existing receipt/delete-journal/snapshot-cursor/owned-absence/durable-ACK proof is reused. A create disappearing from the final snapshot is not sufficient to discard it: original create receipt and exact causal frozen-delete journal identity remain mandatory.

## RED/GREEN evidence and issues encountered

- Parent's untouched raw RED is copied as `parent-root-red.json` / `.log`: 0 passed, 1 failed, 21 pending. Root delete expected create+delete but originally retained only create.
- `root-first.json`: after local identity support, the unchanged caller test exposed duplicate async delete enqueue. `root-green.json`: 1 passed, 21 filtered pending after single-flight fix.
- `cells-red.json`: origin restore genuinely rejected a missing installed owner. A separate fixture expectation for two tag assignments initially installed only one; the new fixture was corrected to place the same tag in parent and peer. This was a harness error, not a production defect.
- `first-green.json`: 25 passed before the receipt-negative strengthening.
- `causal-receipt-red.json`: real SQL receipts with a fault-injected foreign create ID wrongly cleaned the queue; 0 passed, 1 failed, 24 filtered pending. The fourth class now proves unchanged queue and zero ACK under that fault.
- `final-collection-sealed.json`: strengthening initially required entityId even for legacy non-create membership receipts, regressing one of the original 21 tests. The guard was narrowed to mandatory create IDs / provided optional non-create IDs; no optional field was backfilled.
- An optional-method Vitest spy inferred `never` in vue-tsc; a non-optional intersection on the test target fixed typing without changing production contracts.
- Failed byte-anchor preflights did not write disk. Complete byte replacements preserve existing mixed line endings; no generic patch normalization, HEAD restoration or old script rerun was used.

## Actual scoped gates

| Gate | Latest evidence | Actual result |
|---|---|---|
| Dedicated old21 + origin4 | `collection-closed.json` | 25 passed, 0 failed, 0 pending |
| Nearest SQL/Author/Entry | `nearest-integration-closed.json` | 56 passed, 0 failed, 0 pending |
| Collection caller/tree + restore/atomic + JS planner/shared contracts | `nearest-default-closed.json` | 104 passed, 0 failed, 0 pending |
| Shared types | `shared-types-final-guard.json` | exit0 |
| Server types | `server-types-final-guard.json` | exit0 |
| Web vue-tsc | `web-types-closed-guard.json` | exit0 |
| Owned ESLint / scoped diff check | `owned-lint-closed-guard.json`, `scoped-diff-closed-guard.json` | exit0 / exit0 |
| Ordinary Collection delete | `ordinary-delete.json` | 1 passed, 2 explicitly name-filtered pending |
| Ordinary common-tag remaining lane | `common-tag-red.json` | 2 passed, 1 real failed, 0 pending; offline caller still POSTs `/api/collections/1/tags` |

These are separate gates, not a fabricated aggregate full-suite result. Name-filtered cells are not skipped obligations disguised as PASS. Native-named default planner tests are JS contract/dependency tests, not actual Native Worker execution. No full-root suite/build was run.

Every Node invocation used Python `subprocess.run` with explicit exe/argv, cwd, stdout capture and 120/180-second timeout, without shell or terminal Node invocation. Raw logs, JSON, commands and per-gate source/dependency hashes are retained. No Node timeout occurred.

## Full-byte provenance and scope protection

- `before-manifest.json` and `before/` preserve complete fresh before bytes for the three production files and the already-recovered root test. Those production hashes match the prior origin manifest. The before test is hash `9375bb5fc56ce93bf1d1543bc1af70fa4458d10a785723db957853ac5f61965d`, deliberately not mislabelled as the older 21-test baseline.
- `dependency-provenance.json` and `dependencies/` preserve the concrete API/server/shared/planner/repository dependencies and immutable migrations028/037/042. They remained unchanged across gates. Those dependency captures start before this round's final gates, not a fabricated pre-project baseline.
- `scope-byte-guards.json` verifies byte equality outside the two Collection-owned regions in the large offline API, including all unrelated existing mixed-newline bytes; final expected owned SHAs and unchanged shared dependency SHAs match.
- `fullbytes-manifest.json` binds complete before/source/test/report/raw RED/first GREEN/final gates/guards/dependency files to byte-identical saved copies, sizes and SHA-256, with live/saved/hash equality. Its own digest is recorded separately, not recursively included as self-evidence.

Parent retains CURRENT/board ownership. The prior 21-test artifact is historical evidence, not rewritten. This report is the bounded origin extension only.

## Remaining obligations — do not promote to DONE

- Atomic ordinary common-tag offline lane: still genuine RED, no half-protocol written.
- Native generated contracts, retained ledger/Worker execution, pinned transport/device/OS lifecycle: unverified in this round.
- Global/release/build/04/APK and formal application: not attempted.
- Origin variations beyond the four listed finite classes, malformed/foreign restore origin combinations beyond existing schema/ownership gates, and file-SQLite crash/power-loss behavior: not separately exercised here.

**Stop writing after archive verification and hand this finite result back to parent.**
