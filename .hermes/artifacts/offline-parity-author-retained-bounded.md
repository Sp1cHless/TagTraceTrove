# Author02 retained bounded facade/restore continuation — STOP WRITING

Status: **this finite lane GREEN; Author02 overall still WORKING.** No Collection03, native/Gradle, APK, packaging, deployment or standalone +Author UI work was started. Parent owns operational CURRENT/board/previous report; this new report is the only documentation written here.

## Scope and changes

Start source hashes matched the delegated actual bytes: offline-api `4acd96c994bf3d43ba5f5150a929ad5894e3d01d80647a7131128ef1c4f84e74`; pending-work-restore `db9124b09d3e45730e1b4e6fab8e86f67a7ab25e694835b6fd471e79899298fd`; Author integration `d03dc1dd0ed0b5ba3d5e93df940ac997988bad15aef3dbc506e9f9d1c330957e`. Fresh start full bytes saved separately from all historical checkpoints.

Production changes are exactly two narrow replacements in `apps/web/src/offline/offline-api.ts`:
- Snapshot-candidate durable-ACK bootstrapping now applies to Producer deletion receipts as well as Entry deletion receipts. No-copy connected Author deletion could commit SQL but could never settle its retained queue because it lacked an acknowledgement candidate.
- Known-offline unsupported Author deletion now reports `Author deletion is not available under offline`; online-mode messaging is unchanged. The existing general and operation-specific gates themselves were not broadened or bypassed.

`apps/web/tests/offline-author-parity.integration.test.ts`: eight new cases (2 connected + 4 capability + 2 restore). Shared fixture explicitly injects disposable `dataDir:root` and `assetRoot:join(root,'assets')` for the newly registered System runtime; no System endpoint is called. A test-only IDB helper actually deletes a capability key for absence, rather than substituting false/null stored metadata. Existing 15 cases are regression-only; no removed sidebar/button/UI was restored or adapted.

`apps/web/src/offline/pending-work-restore.ts` was watched, backed up and tested but **not modified**. No outbox/planner/server/shared/contracts/native or other production file was edited. Existing LF/mixed CRLF bytes were retained; no full-file normalization or HEAD rollback.

## Finite cells / honest RED classification

| Cell | Actual execution / result |
|---|---|
| Connected, no installed copy | `connected-first.log`: real business RED, SQL Author deleted and works retained, but cold retry could not empty original queue. Existing bounded `/api/producers/:id/sync-identity` ran before replay, with exact returned UID/version/library/epoch; no library/media download prerequisite. Two-condition ACK bootstrap fix -> `connected-green.log` PASS. |
| Connected, Author created and linked online after older installed copy | First-GREEN in `connected-first.log`, no claimed separate defect. Missing snapshot row does not block bounded identity resolution; works retained; replay response loss, cold ACK-loss and final cold exact-UUID retry settle. |
| Known offline `offlineMutations=false` / absent | Real message RED in `cap-red.log`; existing refusal already occurred. Minimal message fix -> PASS. Final absence case removes the actual IDB key. Zero transport, existing queue JSON bytes unchanged, SQL untouched. |
| Known offline `offlineAuthorDelete=false` / absent | Same four-case message RED/GREEN, separately parameterized flag and false/absence. Cold facade/snapshot mode established before the action; no failed server mutation used as availability proof. |
| Ordinary delete export/atomic restore | First-GREEN defense. A real replay response is lost after SQL commits; actual persisted pending/lastAttemptAt/lastError row is exported, removed and atomically restored exactly. Zero restore transport, cold Author absence and two surviving works. Real ACK response loss persists `producerDeleteProof.<original UUID>`; its receipt identity/version and exact original `operationFingerprint` are asserted and survive cold reopening. Final retry empties queue; all three request bodies are identical raw strings and original envelopes. Export format remains operations/media only; it is not falsely claimed to export journal-proof metadata. |
| Later Producer write after queued delete | First-GREEN defense. Fresh UUID, later timestamp and causal higher same-owner baseVersion; `producer.update` envelope and whole pending file validate against strict schemas, and `preparePendingWork` returns unchanged rows before restore. Atomic planner specifically rejects deleted-owner later restored edits; existing queue JSON remains byte-identical, zero transport/SQL write. Existing deletion guard's message says “Entry” generically, but its Producer rejection is independently exercised, not unknown-field rejection. |

No native receipts, forged SQL output, arbitrary snapshot identity, numeric DELETE fallback, guessed UID/version or rewrites to attempted originals were used. Cross-kind versions were not compared. The legacy/create-origin cases passed only as inherited regression coverage, not renewed standalone-create requirements.

## Current bounded gates

Machine-readable JSON was parsed, not inferred from wrapper exit:
- `focused-final.json`: **45/45 PASS**, success=true, failed=0, pending=0: current Author23 + unchanged nearest Entry-delete22.
- `nearest.json`: **178/178 PASS**, success=true, failed=0, pending=0: offline-api, pending-work-restore, pending-work-restore-atomic, outbox-store, outbox-cleanup-race.
- `web-types-final`: web `vue-tsc -p apps/web/tsconfig.json --noEmit` exit0.
- `owned-lint-final`: configured ESLint on the three owned/watched paths exit0.
- `owned-diff-check.json`: scoped git diff --check exit0. Git's pre-existing mixed-line-ending warning is retained; no whitespace defect reported.

Current source changes had already been present for nearest178; afterward only test assertions were strengthened to export an actual response-loss attempt and verify fingerprint/raw-body equality. Focused45/web types/owned lint were rerun after this refinement.

These are **limited gates**, not full default/integration/root/server/shared types/build/native/phone GREEN. No complete Author02 or release claim. Real `createApiApp().request`, migrated in-memory SQLite and fake IndexedDB are exercised; not TCP, Android WebView, hardware touch, Keystore, PluginCall or force-stop evidence.

## Parallel desktop provenance / scope fence

User's narrow current authorization supersedes historical whole-tree stop rules. No app.ts rollback or System/UI absorption. Read-only dependencies include current real server app/producer repositories/database migrations/shared contracts, web API, snapshot/outbox/restore/sync facades and Vue dependencies from existing cases. `*.gate.json` records actual UTC execution time, command, owned hashes and external-before/after hashes. Early targeted gates recorded the bounded app/Producer/API dependencies; expanded final gates additionally recorded repository/database/shared inventories. `read-dependencies-before.json` / `read-dependencies-after.json` inventory server source, shared source, web offline and web API bytes around the nearest gate batch (a read-dependency superset, not proof every listed module executed). `app-observed-before.bytes` is externally observed full source, **not owned GREEN or a rollback source**.

All recorded gate before/after dependency pairs matched. The full recorded dependency inventory also had no observed drift in this bounded batch. Current System route registration was already present at this continuation start; it was avoided, not treated as mobile business failure. The inventory does not claim whole desktop-tree stability. Any future change to owned files or intersecting ordinary Author/sync contracts requires coordination; unrelated System/UI/service changes remain outside this lane.

## Stop / next finite seam

Production/test writes are stopped after this lane; fullbytes checkpoint `.hermes/tmp/offline-parity-author/bounded-retained/checkpoint/manifest.json` contains owned source/test/report, start hashes, exact scoped diffs and hashes for raw executed evidence. It must not overwrite/restore any historical checkpoint over live source.

Existing Directory wrong-UUID/noncausal-sequence/unknown-scope negatives were rerun in Author23 but not expanded. Next concrete unclosed finite seam, if separately authorized: after a real ordinary-Author ACK-loss persists `producerDeleteProof.<UUID>` and installs the absent-owner snapshot, corrupt its fingerprint or replace receipt owner/library identity, cold retry and require original queue retention/zero unauthorized cleanup. Do not add infinite malformed combinations or standalone seed-specific UI matrices. Separately, retained ordinary production-native deletion/dependency timelines remain unverified; no native gate was run here.

Formal DB/assets/default 8765/8766/env credentials were not read, touched, requested or restarted. No migrations/cache media files/v45 shard/v46 native transport/auth/pinning/settings/navigation/desktop/launchers/root config were written. No cache clear/uninstall/media re-download, git history/index/rollback, version/signing/package/deployment side effects.
