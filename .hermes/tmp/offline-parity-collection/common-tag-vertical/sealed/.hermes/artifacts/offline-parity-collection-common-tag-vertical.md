# Collection common-tag: first functional bulk vertical (not Collection03 DONE)

## Executed outcome

A single production protocol, `collection.common-tag.add`, now replaces known-offline ordinary numeric POST-tags. **First complete tracer GREEN and final 34/34: common-tag file 6/6 (5 product/defense cells + 1 existing prerequisite counterexample), protected Collection-delete 25/25, original ordinary parity 3/3.** The ordinary parity test's historical expected rejection was changed to the requested real successful one-row staging assertion, not an inverted `it.fails`.

No overall eight-class closure, Collection03 DONE, Native,04,APK or deployment claim.

## Implemented production chain

- Dedicated strict shared envelope/context/receipt, explicit `offlineMutations` + `offlineCollectionManagement` + `offlineCollectionCommonTag`, and legal JS native-contract metadata.
- Frozen root/direct-child identities and revisions, DISTINCT unique Entry UIDs and **each Entry's own revision**, tag presence, actual type/layout/Section/Facet identity, bounded global per-type placement aggregates and numeric-Facet tie-break. Bounds reject overflow instead of truncating scope. Offline reads the installed snapshot; connected preflight uses the dedicated transactionally consistent bounded route, not a whole-library/media download. Connected preflight currently requires reconciliation of existing queue rows rather than guessing their authority.
- One durable outbox enqueue; no per-Entry queue loop, separate new-vocabulary command, or partial optimistic publication on enqueue rejection. New Tag transport UID is separate from its local negative numeric projection key. Locally the API's new-Tag result tagId remains null; the saved projection has the usable local Tag ID, and server receipt holds the canonical positive ID.
- Single outer replay SQLite transaction: all frozen semantic preconditions are compared before Tag/assignment writes; production `assignEntryTag` handles actual assignment/display cleaning; each affected Entry advances once, unsupported/already-present Entries do not; actual root version/journal advances once. Existing replay-service receipt hash/lookup/save transaction provides immutable UUID/body retries and result counts.
- Cold-visible projection, prior/next owner references and later Entry delta forecasts; same-device Collection-create origin validation reused from the protected delete identity helper. Restore recognizes stable bulk references/new Tag origins. Positive export/atomic-restore path exercised; complete adversarial origin/member-context restore matrix is still pending.
- Applied receipt owned-count/Tag UID/revision checks; snapshot identity/cursor/assignment verification and specific owned journal reads; verified proof persisted separately from immutable request. Existing durable snapshot ACK must settle before queue cleanup; original request is never retrofitted after response/ACK loss.

## Real finite cells

1. Actual CollectionsPage ordinary form offline: no business HTTP, one durable row, 2 unique Works affected / 0 already / 1 unsupported skipped; SQL untouched until replay; both local details contain Winter.
2. Cold IDB reopen, real pending-work export, remove/reopen/restore and exact fingerprint retention, cold projection; real SQL response deliberately dropped after applying one bulk; one immutable receipt and original wire body on cold retry.
3. ACK response deliberately lost after real server ACK; row remains, cold retry uses original UUID/body, then durable acknowledged settlement removes it without changing the stored receipt.
4. Real SQLite TEMP trigger aborts **the second assignment regardless of random UID order** (condition: one existing assignment). Tag, first assignment, Entry/root journal and receipt counts all roll back. Concurrent second-member Entry title/version change subsequently conflicts before any assignment.
5. Durable enqueue rejects: no queue rows and no optimistic Tag. This rejection is injected at the facade's enqueue boundary; it does not claim browser/OS crash durability or a fault inside an IDB commit.
6. Bulk followed by ordinary Entry update: later baseVersion equals that member's frozen version+1; real requests bulk then Entry; SQL title and complete ACK cleanup verified.
7. Existing per-Entry non-atomic replay counterexample remains PASS as prerequisite evidence, not additional product coverage.

## Actual gates

| Gate | Result |
|---|---|
| `first-RED.json` | 1 PASS / 1 genuine caller FAIL |
| `caller-run2.json` | 2/2 (initial caller GREEN + prerequisite) |
| `first-GREEN.json`, `final-vertical.json` | 34/34, 0 failed,0 pending |
| `nearest-sql.json` | 74/74: prior nearest56 plus actual Entry-tag/pending-Entry-tag SQL tests |
| `nearest-default.json` | 170/170: prior nearest104 with all shared default tests included |
| Server/Web/shared types | exit0 |
| Complete owned TS lint; final revised tests lint | exit0 |
| Scoped git diff check | exit0; existing Git LF→CRLF advisory warnings retained in raw log |

All Node gates use absolute `C:/Users/hzy/AppData/Local/hermes/node/node.exe` via Python stdlib subprocess direct argv, stdout+stderr captured, explicit repo cwd and finite120/180 timeouts. No terminal/shell/TCP/default services. Real Hono app.request over migrated-memory SQLite, explicit temp dataDir/assets, and fake-IDB only. No Native Worker/Gradle executed.

## Remaining finite eight-class acceptance (not hidden PASS)

- Class1: actual caller/unique/new Latin name/cold projection covered; majority/tie/existing/normalization/mixed-type full matrix still pending.
- Class2: single enqueue rejection and true second-write SQL rollback covered; interior IDB transaction/crash fault cells pending.
- Class3: actual export/cold restore, SQL response loss, ACK loss, immutable receipt/body retry covered; corrupt/foreign restore matrices pending.
- Class4: explicit flags implemented; absent/false/downgrade/sealed-retention cells pending.
- Class5: bounded connected/no-copy implementation exists; no-copy/newer-than-copy acceptance still pending. Queued connected predecessors currently fail closed for reconciliation.
- Class6: member predecessor references and real bulk→later Entry metadata forecast/ordering covered; held-context/independent-owner/bulk→delete/same-device local-origin common-tag matrix pending. Common-tag journal settlement currently expects its affected owners and assignments still visible; later destructive/superseding writes need explicit successor-proof acceptance before claiming those chains closed.
- Class7: each Entry version checked and real member conflict/zero-write covered; root/child/member/context concurrent freeze matrix pending.
- Class8: real positive counts/tag UID/owned journal/cursor/ACK authority covered; forged counts/Tag identity/journal/foreign receipt/snapshot-negative cells pending.

## Files and provenance

New production helpers: `packages/shared/src/collection-common-tag.ts`, `apps/server/src/sync/collection-common-tag.ts`, `apps/web/src/offline/collection-common-tag.ts`.

Modified: shared sync schema/native metadata/index; shared package dependency and the matching pnpm-lock importer entry; server dedicated replay/service and only Collection route/import seam of app.ts; GalleryApi Collection interface/factory seam; offline facade/projection/planner/restore; exclusive common-tag integration test and the original ordinary parity common-tag assertion. No Collection-delete source/test edits.

The shared helper reuses the exact existing OpenCC converter via an explicitly declared shared dependency, not a guessed character map. The existing local package cache was reused without network install. Windows denied an attempted dependency symlink (WinError1314); a local node_modules copy of the existing installed package resolved it. An initial guessed Git executable path was absent; discovery found `D:/install/Git/cmd/git.EXE`; final diff gate ran through absolute Node child_process. Neither failure blocked production validation. One SQL test initially forgot to reconnect its fixture; archived failure was a harness transport error, corrected before claiming SQL proof.

`before/` contains complete fresh original bytes before each edited file. Targeted unique-anchor candidates were held in memory and final full-byte equality guards checked immediately before writes; mixed existing line endings were not normalized. `source-diffs/`, `owned-provenance.json`, gate-before/after hashes and new-file markers retain exact source/dependency evidence. Gates did not change production bytes; only the final test trigger was tightened to force a true second write and then the entire34 plus test lint reran. Protected delete test SHA remains `05950c3faa1ae0ca51fa0b35dbb4066bc9b09600e6d03585bacc4006e9e5925a`.

No writes to CollectionsPage (latest external display classes retained), other System/Settings/GalleryApp/navigation/root script/config, launcher, backup/connection-recovery, v45/v46/media/auth/pinning, immutable028/037/042, formal DB/assets/env, services8765/8766, dist/build/APK/signing or git commit/reset/stash. New dependency importer-only lockfile/package entry is necessary to make the existing production simplifier available to the shared projection; no root scripts/config changed.

Evidence root: `.hermes/tmp/offline-parity-collection/common-tag-vertical/`. `fullbytes-manifest.json` binds fresh-before/latest source/test/report/raw RED/GREEN/gates/provenance to byte-identical saved copies and actual size/SHA verification. Writer stops after this first-functional vertical. Follow-up should add the remaining bounded acceptance cells rather than report8classes or03DONE.
