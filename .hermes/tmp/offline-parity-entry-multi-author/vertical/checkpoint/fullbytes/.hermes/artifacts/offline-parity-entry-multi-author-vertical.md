# 06 Entry multi-author conversion — genuine RED, not delivered / source writer STOPPED

## Outcome

**06 remains WORKING. No first complete GREEN, atomic offline conversion, finite defensive groups or Native acceptance is claimed.** This run traced the actual ordinary callback and canonical SQL and produced two reproducible product REDs. It stopped without modifying production because the supplied preservation boundary conflicts with the current, explicitly tested Online conversion rule. Parent must adjudicate that rule before a subsequent sole writer implements the vertical; this report is not a foundation-only completion or a DONE promotion.

## Actual path and semantics

- `apps/web/src/GalleryApp.vue:2323–2339`: direct ordinary `convertEntryAuthors` callback; `data-testid="convert-multi-author"` calls it directly, not a separate confirmation dialog. It awaits `props.api.convertEntryAuthors(entry.id)`, refreshes Authors and Entry, and uses `convertedAuthors.length` / `multiAuthorName` in its notice. The mounted RED reaches this actual button in Entry edit mode.
- `apps/web/src/api/gallery.ts:1158`: POST `entries/{entryId}/multi-author`; `GalleryApi` returns the existing strict `ConvertEntryAuthorsResponse` (Entry ID, target Author ID/name, original converted Author ID/name array), **not Entry detail**.
- `apps/server/src/http/app.ts:1335` invokes `convertEntryAuthorsToMultiAuthor` and parses that response.
- `apps/server/src/repositories/entry-multi-author-repository.ts:63–106`: one SQLite transaction. Validate Entry; select the earliest Author whose name equals `multiple author` under SQLite NOCASE; enumerate linked Authors in name-NOCASE/ID order; already-only-target is a no-op; fewer than two linked Authors is rejected; reuse target or call actual `createProducer`; link target; unlink each other Author; return converted names/IDs. No Entry Tag assignment or shared-layout conversion is performed by this function.
- **Semantic conflict:** each unlink at line 93 invokes `producer-repository.ts:341–377`: `unlinkEntryProducer` calls `pruneWorklessProducers`, which runs physical `DELETE FROM producers ... NOT EXISTS(entry_producers)`, then prunes unused Producer tags. This is not merely hidden workless Author projection. Its cascades can remove Producer-owned relationships/ratings/Directory data. Authors retaining other works survive. The current conversion comment explicitly describes entity removal and later re-import recreation.
- `apps/server/tests/integration/entry-multi-author.integration.test.ts` explicitly asserts `stillStored === 0` for emptied contributors. Therefore preserving all credited Author entities, as required by this delegation, is a change to current Online semantics, not merely implementing missing offline parity. No old test expectation or Online rule was silently rewritten.
- Offline facade has no `convertEntryAuthors` override. Ordinary saved-copy click reaches the inherited business HTTP method and enqueues nothing. Existing `entry.authors.set` / `entry.author.create-and-link` provide adjacent owner/identity machinery, but independently enqueueing create+link/unlinks would not reproduce the single Online transaction. Existing create-and-link is additive; it is not conversion.

## Executed evidence

All Node commands used Python `subprocess.run` with absolute `C:/Users/hzy/AppData/Local/hermes/node/node.exe`, argv arrays, repository cwd, captured merged output and timeout 180. No shell Node, TCP server, formal DB or Gradle execution.

New exclusive test: `apps/web/tests/offline-entry-multi-author.integration.test.ts`.

1. **Ordinary saved-copy durable enqueue RED:** actual mounted GalleryApp → Comic card → Entry edit → conversion button. Expected one durable operation; actual queue `[]`. Reached normal UI, no fixture/selector/import error. The subsequent zero-business-HTTP assertion was not reached and is **not** claimed PASS.
2. **Canonical preservation RED:** real migrated-memory DB and production `createApiApp` through `app.request`, explicit temporary `dataDir`/`assetRoot`, real API DTO. Conversion succeeds and returns two original Authors. Expected original one-work contributor to remain stored; actual SQL count `0`. Subsequent retained-other-work assertion was not reached and is not claimed as new defense coverage.

Initial and final selected RED: **0 passed / 2 failed / 0 pending**, exit 1. No production fix applied between runs; final test title removes an unasserted tag-preservation claim. Logs/JSON/actual argv: `.hermes/tmp/offline-parity-entry-multi-author/vertical/gates/{first-red,final-red}*`.

Current existing Online family: **5 passed / 0 failed / 0 pending**, exit 0 (`online-baseline.json`). This establishes that entity deletion is existing tested behavior, not a broken fixture.

Actual gates, all exit 0: shared `tsc`, server `tsc`, web **vue-tsc**, ESLint on the newly owned test. Output and argv archived in `gates`. These are narrow preservation/type gates, not the requested completed-vertical nearest 158/default140 rerun. No full-root/build/package gate or Native execution.

Fixtures close the IDB store and SQLite database and recursively remove only their isolated temporary data root in `finally`; mounted wrapper unmounts and globals are unstubbed. No persistent services were started.

## Byte preservation and inherited drift

Full-byte before copies of ten actually inspected production/old-test files are in `vertical/before`, with size/SHA manifest. All ten remain byte-identical to the run-start copies after execution; **production edits = 0, old-test edits = 0**.

Inherited 654-entry Native05 baseline manifest hash exactly matches the supplied `6a99847ede8bea55c4d8681412068c43bbf5381c0823871c10a20fb827a3aa2a`. An actual fresh comparison found five live differences from that older baseline: `AdvancedEditingPage.vue`, `GalleryApp.vue`, `SuggestionInput.vue`, `i18n.ts`, `gallery-app.test.ts`. These are preserved external language/font/display/build-marker/newline edits; GalleryApp was already different in this run's before capture and remained unchanged by this writer. Diffs saved in `gates/inherited-drift`; do **not** claim protected-0-drift against the old 654 baseline or restore those bytes. Other inherited entries matched. Final fresh full-byte checkpoint preserves current bytes, actual gates and the exclusive RED test; its manifest excludes itself and verifies live/saved/size/SHA equality.

## Required continuation, not implemented or verified here

Parent should decide whether the explicit no-entity-deletion boundary supersedes the existing Online deletion rule and permits its focused production/test repair. Do not implement deletion in replay under the assumption that hidden Authors equal deleted entities; do not change generic prune behavior outside the conversion region.

After that decision, the next writer still owes the requested **first complete ordinary caller GREEN**, then finite 4–6 groups and requested nearest gates. No single immutable UUID conversion command, cold target creation/reuse projection, canonical atomic replay/receipt, exact response-loss retry, own-journal/snapshot proof, durable ACK cleanup, export/atomic restore, bounded connected noCopy/oldCopy command, conditional capabilities, pending creator dependencies, held-owner isolation or semantic receipt/snapshot/restore defenses was implemented or validated in this run. Existing relation machinery is only a reference, not proof of any of those claims.

No migration added/modified. No 07, Native Worker/generated contract changes, Gradle/APK/build/dist/version/signature/auth/global approvals, formal DB/assets/default-service reads or writes, deployment, restart or git side effects. Writer has stopped source/tests; parent owns CURRENT/board promotion and must retain 06 WORKING.
