# 06 Entry multi-author continuation — corrected specification, still WORKING

## Outcome / stop boundary

**06 is not delivered. The requested first complete atomic offline conversion tracer remains unimplemented and RED.** This continuation corrected the parent's erroneous blanket Author-entity-preservation assumption and verified the actual Online baseline. It did not implement a new replay kind or production path. Do not promote this report to first GREEN, finite acceptance, Native acceptance, or 06 DONE. No semantic-adjudication blocker remains: the current authorization explicitly preserves actual Online pruning.

The ordinary callback still reaches an empty durable queue. No production repair was attempted in this continuation; this is incomplete implementation, not merely unverified device behavior. Source/test writer is STOPPED. Parent owns CURRENT/board/todo and subsequent lane allocation.

## Author lifecycle correction

The old second assertion in `apps/web/tests/offline-entry-multi-author.integration.test.ts` expected the one-work contributor to remain physically stored. That expectation was added by the parent, not required by the current user, and contradicted the existing Online repository and five frozen integration tests. Only the newly owned test was corrected: contributor stored count is now **0**, while the established Author's remaining links must equal `[peer.id]`.

The current canonical implementation remains untouched:

- `convertEntryAuthorsToMultiAuthor` owns one SQLite transaction, validates the Entry, selects the earliest SQLite-NOCASE `multiple author` match or creates the target, orders credited Authors by NOCASE/name + ID, links the target, and unlinks the other credited Authors.
- Each actual unlink invokes `pruneWorklessProducers` only for the affected Author. An Author without other works is physically deleted with existing cascades and unused Producer-tag pruning; an Author retaining other works remains.
- A target-only repeated conversion is a no-op. DTO remains `{entryId,multiAuthorId,multiAuthorName,convertedAuthors:[{id,name}]}`. No Entry Tag or shared-layout migration was introduced.
- Existing Online tests, generic prune, and all production files are byte-preserved. This correction is **not** a production bugfix and does not weaken the genuine ordinary-callback enqueue RED.

The historical vertical report/logs are deliberately preserved. Its former characterization of entity deletion as a second product RED and its outstanding semantic-adjudication request are superseded by this continuation; the historical callback RED remains genuine.

## Actual execution on final source

All Node commands used Python `subprocess.run`, absolute `C:/Users/hzy/AppData/Local/hermes/node/node.exe`, argv arrays, repository cwd, merged stdout/stderr capture and timeout 180. No shell Node/TCP/formal database/assets were used.

Exclusive continuation logs: `.hermes/tmp/offline-parity-entry-multi-author/continuation/gates/`.

| Gate | Actual result | Boundary |
|---|---|---|
| Corrected new integration test, canonical-corrected-red | 1 PASS / 1 FAIL / 0 pending, exit 1 | Ordinary saved-copy button reaches queue `[]`; corrected Online lifecycle PASS |
| Final corrected new integration test, final-red | 1 PASS / 1 FAIL / 0 pending, exit 1 | Same genuine queue failure on final source |
| Frozen existing Online family | 5 PASS / 0 FAIL / 0 pending, exit 0 | Actual unchanged canonical baseline |
| Shared tsc | exit 0 | Narrow preservation/type gate |
| Server tsc | exit 0 | Narrow preservation/type gate |
| Web actual vue-tsc | exit 0 | Narrow preservation/type gate |
| Owned ESLint, final-owned-lint | exit 0 | Newly owned test only |

The queue failure occurs before the zero-business-HTTP assertion. That subsequent assertion remains **unreached**, not PASS. Cold conversion projection, canonical replay, receipt retry, journal authority, ACK cleanup and conversion export/restore were not reached or implemented.

An initial `corrected-red` run mistakenly used the default Vitest config. The callback failed during GalleryApp setup (`Cannot read properties of undefined (reading 'modules')`), while the corrected canonical test passed. This is a **fixture/config error**, separately archived; it is not the genuine callback RED. The retry used the actual inherited `--config vitest.integration.config.ts` argv and reached the genuine empty queue assertion.

The newly owned test's wrapper allocation/offline setup was moved inside `try`, with optional unmount in `finally`, so setup failure also closes its store/database and removes its own root. The one empty fixture directory left by the initial config error was identified by its creation time within that exact failed test interval and removed; `fixture-cleanup.json` records the exact root. Final run left no `t3-entry-multi-author-*` fixture roots.

No 4–6 finite conversion groups, requested 158/140 nearest matrices, full-root suites, build, generated Native registration/equality, Worker acceptance, Gradle or APK were run. Those are not inferred from the narrow GREEN preservation gates; first complete conversion GREEN has not occurred.

## Fresh-byte preservation

The inherited vertical fullbytes manifest contained **691** entries. All live bytes initially matched that manifest; `continuation/before/` saves fresh complete copies of all 691 entries with size/SHA manifest. This preserves the existing external GalleryApp/font/i18n/display/newline edits rather than restoring the older 654-entry checkpoint.

Final comparison to this fresh 691 baseline found exactly one changed inherited path: `apps/web/tests/offline-entry-multi-author.integration.test.ts`. Its changes are the corrected canonical test name/count and fixture-finally guard. Production changes = **0**; frozen old tests changes = **0**; migrations changes = **0**. `gate-pre-sha.json`, `gate-post-sha.json`, and `owned-drift.json` preserve the actual hashes. Final `continuation/checkpoint/fullbytes/manifest.json` stores fresh live bytes and verifies saved/live/size/SHA for each entry; the manifest excludes itself.

## Outstanding implementation, not merely verification

Still required in 06:

1. One strict capability-gated atomic command and durable immutable original UUID from the ordinary callback, preserving the DTO and Online transaction/prune behavior.
2. Own stable Entry/affected-Producer/target/cascade identities, revisions and origin context; legal frozen target creation/absence and race fail-closed behavior. Never replace conversion with separately committed create/link/unlink operations.
3. Cold target creation/reuse and scoped workless-prune projection, including Author/Directory/rating/tag/Collection/View Later cascades and read/count parity.
4. Canonical single SQL transaction, strict preflight, typed immutable receipt retaining converted IDs/names after pruning, exact body/UUID retry and receipt-insert rollback.
5. Own canonical journal/tombstone/cascade proof bound to original and immutable receipt, valid-checksum snapshot ownership/current context, proof persistence before durable ACK, ACK-loss retry and cleanup only after authority.
6. Valid saved-copy export/atomic restore and all-or-nothing rejection of foreign/altered metadata/body/origin.
7. Only after first complete GREEN: 4–6 bounded requested groups for target variants, independent capabilities, connected noCopy/oldCopy bounded context/original retry, pending creator dependencies or explicit fail-closed, held-owner isolation, and semantic snapshot/receipt/restore defenses; then requested nearest/types/lint/fullbytes stop.
8. New-kind shared/foreground/generated Native metadata equality if introduced; Native runtime/platform acceptance remains the later parent-owned lane, not registration-as-GREEN.

No formal DB/assets, default ports 8765/8766, environment credentials, auth/pins/transport, cache/media shards, migration 001–043, System/navigation/display business regions, 03–05 frozen production/tests, git side effects, deployment or 07 were changed. Explicit historical gaps from 04 markerless eligibility and 05 noCopy-without-trusted-snapshot restore remain untouched.
