# Offline parity takeover batch — 06–08, 11 (2026-10-10) and 09/10 + review (2026-10-11)

User resumed the paused board (see `offline-parity-entry-multi-author-safe-pause.md`) and then asked for the remaining lanes with internal review only, no packaging. This report covers both passes. Every lane is genuine RED→GREEN with focused integration tests; the sole writer is this session. **All twelve board lanes are now code-complete; packaging is deliberately deferred per user.**

## Environment note (measured)
Native Gradle runs MUST put the bundled **Adoptium JDK 21** first on PATH (`/c/Program Files/Eclipse Adoptium/jdk-21.0.7.6-hotspot/bin`); the shell default is Oracle JDK 25, whose class files (major 69) Robolectric 4.14.1's ASM cannot read — the failure surfaces as `Unsupported class file major version 69` during Robolectric reset AFTER tests actually passed. In Git Bash invoke gradle as `cmd.exe //c` (a single `/c` is path-converted).

## 06 Entry multi-author conversion — four seams closed
- **06a mounted Gallery invalidation** (`GalleryApp.vue` `convertEntryAuthors`): after conversion the type's backing Gallery bumps the request seq, clears the cached card list and reloads list + Author filter options (mirrors `confirmRatingDelete`). Mounted test `offline-entry-multi-author-foreground.integration.test.ts`: a held pre-conversion query result (tampered duplicate card) is dropped after release, filter options reload, foreground stays offline.
- **06b target-alone/no-op settlement** (`offline/entry-multi-author.ts` + `offline-api.ts`): a conversion original that declared only the target author settles — the server applies a no-op (empty journal, no version bump) and `verifyConversionSnapshot` accepts the empty journal **only** when the original itself declared the target alone; the proof re-fetch handles the empty journal. Two cells in `offline-entry-multi-author-noop.integration.test.ts` (clean settlement; response/ACK-loss cold exact-body retry).
- **06c dependent continuations on the created target** (`enqueueDurably` + `enqueueCollectionProducerMembership`): the created target uid is excluded from the conversion's held scope (continuations referencing only it serialize behind the original; owners still held); collection membership resolves producers from the projected queue state. `offline-entry-multi-author-dependent.integration.test.ts`.
- **06d Native actual-kind receipt validation** (`AppliedReceipt.java`): the conversion receipt was rejected by the generic 5-key check (it carries `conversion*` extras), so the native Worker held every conversion forever. Added `validConversion` with two measured corrections: `resourceVersion > baseVersion` (conversion bumps the entry several times) and `JSONObject.NULL` sentinel handling for JSON `null` (`target`, delete rows' `record`). `native-entry-multi-author.mts` + `NativeEntryMultiAuthorConversionJvmTest` **3/3** under real Worker/native SQLite/pinned TLS/canonical SQL.

## 07 Author-page work merge — full vertical, new op kind `entry.merge`
Shared schema + result fields (`merge`/`mergeJournal`), contract row, capability `offlineEntryMerge`; server replay branch (same-type + shared-author + version conflicts, in-transaction `mergeAuthorEntries`, tombstone proof, validation throws become `failed` receipts); client `enqueueEntryMerge` (frozen both versions, quiet-queue guard over both owners), `applyMergeProjection`, settlement proof (absorbed gone, keep revision/title/sources/tags, journal exact re-fetch) before durable ACK, restore-union intersect guard, offline `listEntrySources` (host-scoped classification; the known-site registry stays server-side). Native `AppliedReceipt.validMerge` + fixture/JVM test **2/2**. Integration **4/4** (`offline-entry-merge.integration.test.ts`): settle, response/ACK-loss retries, owner holds both ways, export/atomic restore.

## 08 Entry tag rename / Section create-rename-delete / Facet delete-reorder — new op kind `entry.tag-layout.set`
Per-type layout owner (`entry_tag_layouts`); every tag_groups DML journals and bumps the layout version via existing triggers, so the replay branch deletes facets-then-sections explicitly (FK cascades do not fire the sync triggers) and skips no-op updates. Client freezes base groups, projects desired rows (client uids honored on insert), advances the projected layout version by the same row-DML delta; settlement proof chains receipts (each `resourceVersion` must equal the next op's `baseVersion`; only the last payload matches the settled snapshot). Facade overrides: createSection (with default facet), renameSection, deleteSection (refuses occupied), deleteFacet (refuses occupied), reorderSectionFacets; `renameEntryTag` mapped onto the existing `entry.tags.set` machinery. **Facet creation deliberately keeps its pending-create local path** (see the regression note below). Integration `offline-entry-tag-layout.integration.test.ts` **3/3**.

## 09 Ordinary template/layout actions — two new atomic kinds
- `entry.tag-layout.apply` ("Apply tag layout"): the source Entry's frozen tag→Facet placements become the type's standard; server conflict-checks the frozen placements then runs `applyEntryTagLayout`; settlement verifies from the fresh snapshot that no peer entry of the type holds a moved tag on a different Facet, plus durable ACK. Projection moves peer assignments for cold reads.
- `entry.layout-template.apply` ("Save as template"): rebuilds the type's groups under fresh client UUIDs and relinks every assignment by (section, facet) name key **before** the old rows go — `entry_tags.facet_id` is `ON DELETE RESTRICT`, which is why the online implementation relinks first. Old sections are renamed aside for the unique-name index, exactly like the server rebuild. Receipts chain like 08; the last payload is verified against the settled snapshot.
- Facade overrides return honest offline response DTOs (counts from the projection; `backupPath: null`, doctor fields neutral — the online route's own backup/doctor artifacts are connection-bound).
- Integration `offline-entry-layout-template.integration.test.ts` **3/3**.

## 10 Occupied cover / existing media replacement
Staged cover uploads may declare `replace: true` (shared metadata schema, `StagedMediaUpload`, transport metadata). The server media replay accepts the swap only when the frozen `expectedCoverRef` still matches the live cover — otherwise the row fails visibly (`media-state-conflict`) instead of sticking; the settlement rides the standard position-checked media receipt with the byte-identity fetch. A queued cover still refuses a second cover. Preview replacement stays refused. Integration `offline-entry-media-replace.integration.test.ts` **3/3** (real 1×1 PNG fixtures; the settlement's global-fetch byte check is served from the app in the test shell).

## 11 Quick create then immediate edit
`updateEntry`/`assignEntryTag`/`moveEntryTag`/`removeEntryTag` detect a queued create by its local negative id and route to the existing pending machinery (`enqueueOfflinePendingEntryMetadata` / `...PendingEntryTags` / `...PendingEntryTagCreate` for new vocabulary). Projection fix: pending metadata patches never applied to the projected pending row (the base snapshot never held it) — `snapshotWithOverlays` now patches projected create rows too. `GalleryApp.vue`'s offline create branch no longer throws `advancedEditingRequiresConnection`: it queues the create and opens the projected pending entry straight into edit mode. Integration `offline-create-then-edit.integration.test.ts` **1/1**.

## 12 Internal review — gates and the regressions found and fixed
- **Regression 1 (found by the review, fixed)**: my first 08 pass branched the `createFacet` facade override into the layout op for saved sections; that hijacked the pending-Entry composition flow, which requires staged facets to ride `entry.facet.create` under the parent create (16 deterministic failures in `new-entry-facet-flow.integration.test.ts`, bisected against the pre-session file). Reverted to the pending path — facet creation was never an offline gap; lane 08's scope was delete/reorder. A duplicate of the branch survived the first revert and was removed in a second sweep.
- **Regression 2 (found by the review, fixed)**: two projection-parity defects surfaced once `createFacet` returned to the pending path. (a) the pending `entry.facet.create` projection did not advance the owning layout's `syncVersion`, while the server trigger bumps it once per insert — the next queued layout original froze a stale base and conflicted at replay; the projection now mirrors the bump. (b) that projection computed the staged facet's `sortOrder` as `max(siblings)+1`, while the `entry.facet.create` replay inserts at **sort_order 0 unconditionally** — the projection now mirrors the replay so a later layout original's frozen base exists on the server. The layout settlement's receipt chain was also relaxed from exact equality to monotonicity, because non-layout queued kinds legitimately bump the layout version between layout originals; the exact end-state anchor remains the settled-snapshot comparison.
- Full web integration: **27 files, 220/220**. Full server integration: 654 tests, **653 passed / 1 failed**. Five of the six pre-existing failures were stale schema-version pins (`42` baked in before migration 043 landed in lane 04 — the maintenance duty the memory note describes) and were bumped to 43; the delta test's other failure was the unjournaled-table premise broken by 043's journaling. **One inherited failure remains** (`delta-payload.integration.test.ts` "materializes every populated SQL payload array…": the two UPDATE statements it relies on to be unjournaled now produce one journal row on a populated library — measured; both `taxonomy_aliases` and `gallery_settings` were checked). Re-selecting the unjournaled table requires re-reading the current sync contract and belongs to the next sync-native lane; the file is left byte-original.
- The combined default `vitest run` (everything at 3 workers) shows additional mounted-test failures that do not reproduce when the same files run standalone or in the integration-only full run — CPU-contention timing of `settle()` loops, consistent with the repo's known full-run flakiness.
- `native-valid-kind-acceptance.test.ts`: this coverage test requires a fixture per replay kind and **was already failing before this batch** (inherited missing fixtures: `collection.common-tag.add`, `collection.delete`, `entry.authors.convert-to-multi`, `gallery.partition.set` — other lanes' kinds). This batch added fixtures for **its own four kinds** (`entry.merge`, `entry.tag-layout.set`, `entry.tag-layout.apply`, `entry.layout-template.apply`), all passing per-kind; the inherited four-kind gap is left untouched, keeping the failure delta at zero. `native-worker-authority-contract.test.ts` carries the same inherited gap.
- Shared/server/web typecheck exit 0; owned-surface ESLint 0 errors (1 pre-existing warning). Native: conversion 3/3, merge 2/2, and both classes re-ran **after** the shared contract grew to 34 kinds, verifying the generated `NativeMutationContract`.
- All 12 board rows are now code-complete; **no APK was built** (user will run unified acceptance).

## Pre-edit checkpoints
Full-byte backups of every touched file under `.hermes/tmp/offline-takeover/checkpoint/` (`*.before-06a/06b/07`, `offline-api.ts.current`, `BackgroundTransferWorker.java.before-debug` — the latter reverted byte-identically after debug use).

## Device acceptance session 1 — fresh-type layout gap fixed (2026-10-11)
First real-device gestures caught a lane-08 design gap: a fresh Gallery type (探店/菜谱 — no Section ever) has no `entry_tag_layouts` row and offline layout editing failed closed, while online the first-create trigger materializes the row. Fix: the first layout original mints its identity at version 1 over an empty base (`payload.entryType` optional; server replay creates the row, refuses foreign/duplicate types; client projection synthesizes it; new groups project under deterministic `localCollectionId` — the test caught a counter-vs-hash local-id mismatch too). Fresh-type cell 4/4; web integration 221/221; v49 rebuilt in place (SHA `0e691aed88c45b0120531db0ff56e4647d610905206ab9c7ccb3c4d6a09b85c8`, signer unchanged), installed via adb, new bundle confirmed running. Also root-caused remotely: a stale desktop server process (capabilities missing the new flags) fail-closed the phone correctly — fixed by the user's tray restart.

## Device acceptance session 2 — the "references a queued object" gap class (2026-10-11, r2)
The user's three device reports were one class: an offline gesture that must resolve an object which exists only in the *projected* state (raw snapshot + queued operations), resolved against the raw snapshot instead and failed closed with a "save it online first" message. Four fixes, then a sweep for siblings.

- **A — `createFacet` under a queued Section** (`enqueueOfflineFacet`): the owning Section was looked up in `active.snapshot.payload.tagGroups`, which never holds a Section created offline. Now resolved from `snapshotWithOverlays(...)` (minted `syncUid` is stable) with a synthesized layout row for a type whose `entry_tag_layouts` row does not exist yet. This is the report the user saw as "Save this section online and update the offline copy before creating a facet".
- **B — queue planner** (`sync-mutation-plan.ts`): a `entry.facet.create`/`entry.tags.set` naming a group that only exists inside a queued `entry.tag-layout.set` payload now depends on that original, so it can never be replayed before the group it hangs off.
- **C — tags placed in a queued Facet**: the client emits the facet's stable `facetUid` (new `queuedLayoutFacetUid`), and the server's `entry.tags.set` value resolver falls back to `tag_groups.sync_uid` when the id map has not seen the Facet yet.
- **D — layout settlement proof**: a sibling `entry.facet.create` applied in the same ordered replay legitimately adds a group and one layout revision, so the expected end state is the last payload **plus** every applied facet-create of that type, and the layout revision is a floor (`>=`) rather than an equality. Without this the whole six-op chain stayed `pending` with `lastError: null` (the settlement threw before the durable ACK), which is what the new cell measured.

**The sweep** (one read-only audit of every offline mutation entry point in `offline-api.ts`): every Section/Facet/Tag/Author/Collection/rating-slot/Directory path resolves through the projection — the taxonomy class is closed by A–D. The remaining raw lookups were all **Entry-by-numeric-id**, i.e. acting on a *queued Entry* (offline-created, projected with a negative local id). The facade's ordinary editor is what a create opens (lane 11), so these were reachable; measured, all six threw:
`recordEntryView`, `likeEntry`, `addViewLaterEntry`, `setEntryRating`, `linkEntryAuthor`, `createEntryContent` — all "Entry is unavailable in the offline copy". Also missing: `renameEntryTag` (no pending route), `unlinkEntryAuthor`, and the content update/delete/reorder trio.

- **E — the designed families now have their doors**: `renameEntryTag`, `linkEntryAuthor`/`unlinkEntryAuthor` and the four Content gestures route to the pending machinery (`enqueueOfflinePendingEntryTags` / `...PendingEntryAuthors` / `...PendingEntryContents` / `...PendingEntryContent`) that already existed and was already reachable from the SearchPage pending list. Rating / View later / usage needed no new protocol: `entry.usage` already carries base 0, and rating/View later only needed the entry resolved through the projection **and** a base frozen on the real server revision.
- **Version arithmetic, measured not guessed** (`entryServerAdvances`): receipts from a real replay give the per-kind bump — `entry.create` 1; `entry.update` 1; `entry.contents.set` 1 (measured for edit, delete *and* reorder); `entry.content.append` 1; `entry.rating.set` 1; `entry.usage` 1; `entry.authors.set` one per changed row; `entry.tags.set` one per changed row (a rename is a delete + insert, so **2**). `entry.view-later.set` is the only op checked for an **exact** revision match, so it is the one that must count pending commands too. `entryVersionDelta` (which documents that a pending command predicts 0) is deliberately left alone; the new helper is used only by `enqueueEntryViewLater`/`enqueueEntryRating`, so the four inherited "excludes pending X from legacy revision prediction" tests keep passing.
- **Two projection defects surfaced by the new cells**: appended Content was not in the projection at all (the editor read back a shorter list), and a Content rewritten by `entry.contents.set` lost the presentation id a queued create had given it (so an edit addressed by that id could not find its row). Both fixed in `snapshotWithOverlays`.
- New integration cell `offline-pending-entry-gestures.integration.test.ts`: one queued Entry, then rename-tag → link-author → add-content → set-rating → View later → like → view; asserts the queued kind sequence, the frozen bases, then settles every op and reads the **SQL** back (tag name, producer link, content, stars, View-later membership, like count).

### Two stale test premises (measured, then corrected)
- `delta-payload.integration.test.ts` "…materializes every populated SQL payload array…": it relied on `UPDATE gallery_settings SET nsfw=0` being unjournaled, but migration **043** (`gallery_partition_sync`, untracked/in-flight) adds `settings_partition_revision_update` + `partition_scope_journal`, so an nsfw change is now a journaled partition revision. Isolated probe: alias update 1→1, nsfw update 1→2. The statement now keeps only the alias change, which is the test's actual premise. (This supersedes the earlier "left byte-original / belongs to the next sync-native lane" note — the cause was identified by measurement.)
- `existing-entry-media.test.ts` "…rejects … and occupied cover": lane 10 deliberately made a settled cover a **declared replacement** (the API-layer half of checklist B11), so the third case now queues with `replace: true` + `expectedCoverRef:'/occupied'` instead of rejecting. Only a *pending* cover still refuses, which the same file's other cell covers.
- `native-valid-kind-acceptance.test.ts` / `native-worker-authority-contract.test.ts`: the inherited four-kind fixture gap is now **closed** (added `collection.common-tag.add`, `collection.delete`, `entry.authors.convert-to-multi`, `gallery.partition.set` shapes derived from their schemas) — the earlier note that it was left untouched is superseded. Both files green.

### r2 gates and package
Web integration **877/877** (128 files), default suite **1267/1267** (108 files), shared/server/web typecheck exit 0, `eslint .` **0 errors**. v49 rebuilt in place: `DIAGNOSTIC_BUILD` → `0.0.49-c3-offline-parity-r2`, fresh bundle `index-DA0cCSak.js` verified inside the APK, signer unchanged (`1035333c…fdf41`, same as v43–v49), same package/permissions, SHA-256 `c8bcb2e0d28d61d9e4e5ce90b25dd9196074bdbdcac294d8268f3e2c8aa9b4e1`. `adb install -r` over the existing app (data preserved); the running WebView was read back through CDP and serves `https://localhost/assets/index-DA0cCSak.js`.

## Device acceptance session 3 — creating an Author on a queued Entry (2026-10-11, r3)
The user reported "离线是创建作者失败" with the device connected. Read straight off the phone (adb + CDP):
- The editor's error banner held a raw zod issue array: `path: ["payload","parentCreateOpId"], message: "Pending Entry Author creation requires zero baseVersion and a parent create UUID; legacy versions must not have a parent"`.
- The outbox held **12 ops and no Author op at all** — so the call threw before queueing, and nothing was left to inspect.
- Every author capability meta on the phone was `'1'` (`offlineStandaloneAuthorCreate`, `offlineAuthorCreate`, `offlinePendingEntryAuthors`, …) and the live desktop advertises them all, so this was not a capability fail-closed.

**Root cause**: `linkEntryAuthorByName` was the one Author door the session-2 sweep missed — it has its own inline `enqueue` closure and never calls the numeric-id methods that were fixed there. On a *queued* Entry the projected row carries `syncVersion: 0`, and `entryVersionDelta(entry.create)` is 0 by design, so `enqueueEntryAuthorCreate` froze `baseVersion 0` **without** a parent — an envelope the shared schema rejects. The same closure's existing-name branch (`enqueueEntryAuthors`) would have produced the same shape.

**Fix**: `linkEntryAuthorByName` now detects the queued Entry first and uses the parent-bound machinery the pending Author editor already had — `enqueueOfflinePendingEntryAuthorCreate` for a new name (create-and-link in one command), `enqueueOfflinePendingEntryAuthors` for an existing one. New integration cell in `offline-pending-entry-gestures.integration.test.ts` (new name → `entry.author.create-and-link`; existing name → `entry.authors.set`; both `baseVersion 0` with the create as parent; projection shows both names; after flush the SQL `entry_producers` join reads both back).

**Verified on the device** (not only in the harness): r3 built and installed (`DIAGNOSTIC_BUILD` → `0.0.49-c3-offline-parity-r3`, bundle `index-8TlY8FdS.js`, signer `1035333c…fdf41`, SHA-256 `b51558981f6c594ee2e3a5c88c884e30a01f7616203cbf3884cadcfb878225e1`), then the gesture was driven through the real DOM: open the queued 探店 entry → 编辑 → `+ 作者` → type a new name → blur. The name appears in the 作者 section, the pending count rises, and the outbox now holds `entry.author.create-and-link` with `baseVersion 0` + a parent and `lastError: null`. No error banner. The standalone `createAuthor` path (a different envelope, `producer.create` with base 0 and no parent) was checked too and is already covered by `offline-author-parity.integration.test.ts`.

**Gate note**: `delta-payload.integration.test.ts`'s `utf8-*` cases (6–17 MB payloads, ~2 s standalone) began timing out at the 5 s default during a saturated full-suite run while passing standalone; they now declare a 60 s timeout. Full integration **878/878**, default suite **1274/1274**, typecheck 0, `eslint .` 0.

## Device acceptance session 4 — "everything needs the network" (2026-10-11, r4)
The user reported `conversion needs a server-synced entry` and concluded the offline work was never done ("从 b 开始，每一步都没有做 … 每一步都需要联网"). That conclusion is **half right and the important half is the reason**: the batch's features are implemented and work offline, but only on **works that already exist on the desktop**. The user was running the whole B list on the work that B1 creates *offline*, and a subset of gestures refuses there. The checklist never said which work each item needs. So this session produced a measured inventory instead of a guess.

### The inventory (measured, not reasoned): every ordinary gesture × a queued Entry
New `apps/web/tests/offline-queued-entry-inventory.integration.test.ts` calls each gesture against a queued (offline-created) Entry in a real facade + real server, and asserts the outcome. Before this round the refusals were: `convertEntryAuthors`, `applyEntryTagLayout` (a raw zod leak: `baseVersion` 0), `updateEntryContent` / `deleteEntryContent` / `reorderEntryContents`, `uploadEntryMedia`, `setEntryMediaOrder`, `deleteEntry`, `mergeAuthorEntries`.

| gesture | on a queued Entry |
|---|---|
| updateEntry, recordEntryView, likeEntry, add/removeViewLaterEntry | works |
| assignEntryTag, moveEntryTag, renameEntryTag, removeEntryTag | works |
| linkEntryAuthorByName (new and existing), linkEntryAuthor, unlinkEntryAuthor | works |
| setEntryRating, createEntryRatingSlot, reorderEntryRatingSlots, deleteEntryRatingSlot | works |
| createEntryContent, updateEntryContent, reorderEntryContents, deleteEntryContent | works |
| createSection/Facet/layout apply, applyEntryLayoutTemplate, applyEntryTagLayout | works |
| addCollectionEntry | works |
| **convertEntryAuthors** | **fixed this round** |
| uploadEntryMedia, setEntryMediaOrder | refuses, now with an actionable message: a staged image addresses a server-side position, so the work must sync first (its composer already carries the initial Cover/Previews, which upload with the create) |
| deleteEntry | refuses by design: the queued originals must be reconciled (or discarded explicitly) so nothing typed offline is lost silently — message rewritten from the jargon "must be reconciled before ordinary deletion" |
| mergeAuthorEntries | refuses: both works must exist before their Author lists can be merged |

### Fixed this round
- **`convertEntryAuthors` on a queued Entry** (the user's report). A work that has never reached the server has no Author versions or work lists to freeze, so the gesture now degenerates to exactly what it means there: ensure the `multiple author` Author exists offline (`enqueueOfflinePendingEntryAuthorCreate` when it does not) and make it the Entry's only Author (`enqueueOfflinePendingEntryAuthors`). Verified on the device: the user's own queued work with 3 Authors → the author area now reads `multiple author`, the queue holds `entry.author.create-and-link` ×3 plus `entry.authors.set` (base 0, parent, no error).
- **`applyEntryTagLayout`** built `baseVersion: source.syncVersion`, which is 0 for a queued Entry — the shared schema rejected it with a raw zod array in the UI. The frozen base now counts every queued op that will advance the source first (`entryServerAdvances`), which also makes the settled case correct when the Entry has queued work.
- **Content presentation ids were unstable** (a regression I introduced in r2 while making appended Content visible): the projection handed rows created by `entry.contents.set` a *counter* id, so a row that a queued create had projected with `localCollectionId(uid)` got a different id on the next projection call, and an edit addressed by the id it was just given could no longer find its row ("Entry Content could not be updated"). One deterministic `contentIdFor(uid)` now covers create/append/contents.set rows, and the counter is gone.
- **`uploadEntryMedia`'s refusal** for a queued Entry was "Existing Entry is unavailable in the offline copy"; it now says what to do.
- **`deleteEntry`'s refusal** was "Pending Entry creation must be reconciled before ordinary deletion"; it now reads "This work was created offline and is still pending; let it sync before deleting it". An attempted discard implementation was written and then **reverted**: `offline-entry-delete.integration.test.ts` encodes the deliberate design that a queued create is never silently discarded, and it was right — overriding it would risk losing work typed offline.

### Settled-entry paths are unaffected
Every lane's own suite still passes (multi-author conversion, work merge, tag layout, layout template, media replacement, collections, author directories, rating classes). Full integration **882/882** (129 files), default suite **1277/1277** (110 files), shared/server/web typecheck exit 0, `eslint .` 0 errors.

### r4 package
`DIAGNOSTIC_BUILD` → `0.0.49-c3-offline-parity-r4`, bundle `index-DXwDfSnb.js`, signer unchanged (`1035333c…fdf41`), SHA-256 `4f853fcd11b2e926a1e2876c2e40e1085bd601afbb676bf5a464db006792f007`, `adb install -r` over the existing app. The running WebView serves the r4 bundle.

## Device acceptance session 5 — "every step needs the network", round two (2026-10-11, r7)
The user hit `Sync the queued work on both Entries before merging them` and repeated the demand: check **every** remaining step, no more offline gestures that insist on being online first. Read off the device: the merge dialog held **two works that were both created offline** (测测 and Casa Vostra, both 探店), so this was the queued-Entry case again, not a settled pair.

### The refusals that were still real, and what each became
| gesture | before | now |
|---|---|---|
| merge two works, either with queued work or created offline | `Sync the queued work on both Entries before merging them` | **queues and settles.** `referencedEntityKeys` now names the absorbed Entry so the planner replays every command on it first; both frozen revisions count what those commands will add (`entryServerAdvances`); the settlement's revision check is a floor and the owner proofs read a merged result |
| link an Author created offline onto an existing work | `Sync the newly created Author before linking it to another Entry` | **queues and settles** — the guard was redundant: `enqueueEntryAuthors` already carries the create as `producerCreates` under the cross-Entry capability (this is checklist B4's gesture) |
| the absorbed work has a staged image | (new guard I added, then replaced) | the image is **kept while the merge is only queued** and cleaned up once the merge lands — cancelling must never lose it |
| delete a queued work | `Pending Entry creation must be reconciled before ordinary deletion` | refused by design, message now actionable |
| media add / order on a queued work | `Existing Entry is unavailable in the offline copy` | refused (a staged image addresses a server-side position), message now actionable |
| edit a work that a pending conversion or merge touches | `Sync the atomic … before editing its owners` | unchanged: the conversion/merge is atomic over its owners and the absorbed work is about to disappear |

### Fixed this round
- **`entry.merge` over queued work** (the user's report): `sync-mutation-plan.ts` `referencedEntityKeys` returns `entry:<absorbUid>`, which the planner's existing `refs.includes(...)` rule turns into a dependency on every earlier command owning the absorbed Entry; `entry.merge` joined `advancesEntryVersion` (it bumps the kept Entry); `enqueueEntryMerge` drops its blanket refusal and freezes `baseVersion`/`absorbVersion` as *projected revision + the advances those queued commands will add*; the merge settlement accepts a revision **floor** (a later queued command legitimately bumps the kept Entry).
- **Merge-aware snapshot proofs**: the four owner-scoped verifications after a replay (pending Content timeline, pending metadata, pending Author set, pending Tag set) now skip an Entry an applied merge absorbed, and read the kept Entry's result as a **superset** — a merge adds the absorbed work's tags/authors/contents, so deep equality could never hold. Without this the whole merge replay stayed pending with `lastError: null`.
- **Media replay skips an absorbed Entry**, so a staged image is never uploaded for a work the merge removes; the absorbed work's staged rows are removed only **after** the merge's own journal proof, so a queued-but-not-yet-synced merge keeps them.
- **`linkEntryAuthorByName`** dropped its redundant "sync the newly created Author first" guard (B4's gesture now works).
- **My own test fixture was dropping the URL query string**, so every snapshot fetch lost `?media=thumbnails`; the server remembered the baseline with a different media mode and the delta always fell back to a full snapshot **without an acknowledgement** — which is why the first merge attempts died at `needs durable ACK and own journal`. Both of my new fixtures now pass the query string, so the delta/ACK path is really exercised.

### Device verification (r7)
Built and installed (`0.0.49-c3-offline-parity-r7`, bundle `index-D3o_XVVs.js`, SHA-256 `7c22fc0cc96957b31d1bf17efe490bf80ab6032f443b1296926643f9155600fc`, signer unchanged). The user's own merge was driven through the real DOM (Author page → 编辑 → 合并作品 → select both → 合并并删除重复作品 → confirm): no error, and the queue now ends with `entry.merge` `baseVersion 11 / absorbVersion 8`, all **8** of the absorbed work's commands ahead of it, the absorbed work gone from the author page, and its 4.5 MB staged cover **still staged** (it is only dropped once the merge lands). The merge was left queued — it is the gesture the user was trying to perform.

### Gates
Full integration **884/884** (129 files), default suite **1277/1277** (110 files), shared/server/web typecheck exit 0, `eslint .` 0 errors.

## Device acceptance session 6 — the Author editor's Save (2026-10-11, r8)
The user reported that **Save in the Author edit mode errors**, and observed that edit mode already has a **Done** at the top, so the Save below looks redundant and could go. Both were right, and for different reasons.

**The error** (measured from the code path, matching the user's report): `enqueueProducerProfileUpdate` resolved the frozen Author from an overlay of **`producer.create` ops only**. The user's Author (测试a1) had been created offline by an Entry's `entry.author.create-and-link`, so the overlay never contained it and the save failed with "Author is unavailable in the offline copy or is missing stable identity/version". Fixes:
- the overlay now includes `entry.author.create-and-link` (the two shapes an offline Author arrives in);
- the **projection** applies a queued `producer.update` to an Author that a create-and-link projected — the patch pass runs before that Author exists, so its own profile saves were silently dropped (the base snapshot never held the row);
- the **planner** now makes any `producer`-owned command depend on the `entry.author.create-and-link` that owns that Producer identity, so a profile save can never replay before its Author exists.

**The redundant button**: edit mode has two exits — the toolbar's Done (`finishAuthorEdit`, which only closed the editor) and the form's Save (`saveAuthor`). That made Done a trap: type a name, press Done, lose it. Done is now the single commit: it saves the basics first and only then closes, and a **refused save keeps the editor open** with the typed values and the message intact. The visible Save button is gone (the form keeps `@submit.prevent="saveAuthor"`, so Enter still commits). `authorBasicsDirty()` skips the call when nothing changed.

New coverage: `author-page.test.ts` (Done commits the basics; a refused save keeps the editor open; no submit button remains) and a new cell in `offline-queued-entry-inventory.integration.test.ts` (edit the profile of an Author created offline → `producer.update` queued after its create, projection renamed, and the SQL row renamed/occupied after settlement).

Gates: integration **885/885** (129 files), default suite **1279/1279** (110 files), typecheck 0, `eslint .` 0 errors.

Package: `0.0.49-c3-offline-parity-r8`, bundle `index-C3VXet5o.js`, SHA-256 `223e39ac26dae06d268ebeb6dc208c7d0477d720f8b582992fc345abe896dfde`. Installed with `adb install -r` once the phone was reconnected, and **verified on the device**: the offline-created Author (测试a1) opened in edit mode shows **no submit button**, renaming it to 测试a1改 with occupation 厨师 and pressing **完成** produced no error, closed the editor and updated the page, and the queue gained `producer.update` with `baseVersion 1` (its create-and-link's revision) and `lastError: null`. The probe's edit was then removed from the queue so the Author keeps its original name.

## Device acceptance session 7 — "deleting a tag is blocked again" (2026-10-11, r9)
The user reported that **deleting a tag was refused with a "sync first" message**, and asked (for the third time) for a complete check rather than one report at a time. Read from the code, the cause was **mine**: session 5 left a queued `entry.merge` in their queue, and `enqueueDurably` refused *any* operation touching either work of a queued merge — so every edit on the kept work (a tag delete included) was refused with `Sync the atomic Entry merge before editing its owners`.

### The sweep that should have come first
New `offline-blocked-owner-sweep.integration.test.ts` builds each "queued original" state and runs **all eight basic gestures** (rename the work, assign/rename/delete a tag, set a rating, add Content, View later, Like) against the affected work, asserting the whole set:

| state | before | now |
|---|---|---|
| a queued merge, on the **kept** work | every gesture refused | **all eight work** |
| a queued merge, on the **absorbed** work | refused | still refused (it is about to disappear) |
| a queued **conversion**, on the converted work | **every gesture refused** | **all eight work** |
| a queued conversion, on another work of that Author | worked | works |
| a linked Author queued for deletion | worked | works |
| a work queued for deletion, on itself | refused | still refused (with a reason) |

### Fixed
- **Merge owner guard**: only the **absorbed** work is off limits; the kept work stays fully editable (the planner replays that work after the merge and the merge's own revision is a floor, so both settle in order). Stacking a second merge on the same pair is still refused — each merge freezes both works.
- **Conversion owner guard**: it refused everything on the converted work. Now only the **frozen Author set** is off limits — `entry.authors.set`, `entry.author.create-and-link`, another conversion, another merge — while title/tags/rating/Content/View later/Like on that work all queue normally. The conversion's own entry bump is now counted for later versioned edits (`entryServerAdvances`: **measured 2 Authors → +3**, the whole Author set is replaced by the target).
- The old merge test's expectation ("editing the kept work is refused") was updated to the intended behaviour: the kept work edits, the absorbed one and a stacked merge refuse.

Gates: integration **889/889** (130 files), default suite **1279/1279** (110 files), typecheck 0, `eslint .` 0 errors.

Package: `0.0.49-c3-offline-parity-r9`, bundle `index-DXn_YWTp.js`, SHA-256 `41b6721055f4f96fd2873dab3890103c66376d4ef5ff8719fa89b9e34111fc07`. Installed with `adb install -r` once the phone reappeared, and **the reported gesture was verified on the device**: on the kept work of the queued merge (the offline-created 探店 work), pressing a Tag chip's **×** removed it with **no error**, and the queue gained `entry.tags.set` listing the remaining tags, positioned **after** the queued `entry.merge` — exactly the ordering the fix relies on. The probe's edit was then removed from the queue so the Tag is back and the work is unchanged.

## Device acceptance session 8 — creating a Tag did nothing, and everything is slow (2026-10-11, r10)
Two reports: (a) typing a Tag name and confirming did nothing; (b) every gesture takes about a second to take effect.

### (a) The Tag creation — root cause read off the device
The page's own diagnostics held it: `lastMutationDiagnostic` = `entry-tags-set`, `result: "error"`, `errorName: "ZodError"`, `errorMessage` naming **`payload.tags[0].facetId` — "expected number to be >0"`. So the command could not even be expressed, and the refusal rendered at the top of the page while the person was looking at the Facet — the same "report a failure where the action is" trap as the import review.

Reproduced in the harness (a Tag into the **default Facet of an offline-created Section**), which exposed **two** defects behind it:
- the client addressed a Facet by `facetId` unless it could find its `entry.facet.create`; the default Facet of a queued Section comes from a **layout original**, so it fell through to a *local negative id* the schema rejects. One rule now covers every case: a Facet is addressed by its **stable uid unless it is a settled row of the saved copy**.
- the shared schema demanded a `facetCreates` entry for **every** referenced facet uid, which a layout-queued Facet can never have. The rule now requires only that a *declared* dependency is referenced (and is someone else's op). The tag half of that rule is unchanged.
- the client's dependency loop also demanded a create op for that uid; a layout-queued Facet is now recognised (the planner already orders the command after its original).

### (b) The latency
Measured first: a full-size library read is **21 ms** in the harness (6 209 works), so the phone's **1 561 ms** (`lastLocalLoadMs` in the device diagnostics) is not the parse. Two real costs were removed:
- **The projection is memoised** per (saved copy, queued work) pair. Every gesture asked for it three to six times — once per guard, once per helper — and each call walked the whole library.
- **A read could mutate the saved copy.** `snapshotWithOverlays` returns the saved snapshot itself when there is no queued work, and the staged-media pass wrote object URLs into those entries — so a read dirtied the copy every other reader shares. It now takes its own copies. (This also explains a stale-snapshot replay failure that appeared when the parse was briefly cached: the cached object had been mutated.)

A parse cache was written and then **reverted**: the parse is not the bottleneck, and caching the parsed object only makes that shared-mutation hazard reachable from more places.

Gates: integration **890/890** (130 files), default suite **1279/1279** (110 files), shared/server/web typecheck exit 0, `eslint .` 0 errors.

Package: `0.0.49-c3-offline-parity-r10`, bundle `index-Dl3R1csR.js`, SHA-256 `1ce64a3cbae89c0a932d3ba57c8b3a1cd4fc6ad6ca09e1741e4f4d49a0d4e19b`. **Built, not installed — the phone went away again; the latency change still needs a device re-measure.**

## Device acceptance session 9 — the Tag fix verified, and where the second really went (2026-10-11, r16)
### The Tag creation, verified on the device
r11/r16: a Tag typed into **every** Facet of the offline-created work (a settled Facet, an offline-created Facet, and the default Facet of an offline-created Section) now lands with **no error** on all three. The remaining device error had a second cause the harness had not reproduced: that work's layout had last been rewritten by a **queued `entry.layout-template.apply`**, whose groups carry fresh uids — so the client's dependency loop (which only knew `entry.tag-layout.set`) refused it, and the planner's "the layout original owns the group identity" rule did not cover the template op either. Both now handle any op that carries a `groups` payload, and the client only refuses a **blocked** create rather than a missing one (a Facet owned by a layout original has no create to declare).

### The latency: measured, then fixed where it actually was
The device's own diagnostics were extended with per-phase timings of the library load, which turned the guesswork into numbers:

| phase | before (r13) | after (r16) |
|---|---|---|
| queued work read | 4 ms | 7 ms |
| saved copy (cached) | 3 ms | 7 ms |
| **projection** | **1098 ms** | **332 ms** |
| staged media | 2 ms | 2 ms |
| library build | 4 ms | 4 ms |
| **whole gesture** (tap → visible) | 1414–2212 ms | **349–855 ms** |

The projection was the entire cost, and inside it the per-section marks showed the sections themselves were cheap (~320 ms total): the missing ~800 ms was **`structuredClone` of the whole saved copy, once per queued layout original**. That queue holds five layout originals plus a layout template, so every read paid ~190 ms five times over. Both `applyTagLayoutProjection` and `applyMergeProjection` now copy only the arrays they actually change.

Also in this round: the schema validation of the saved copy is cached per stored text and every caller gets its own clone (measured: 643 ms parse+validate versus 190 ms copy) — the earlier freeze-based version was rejected because it broke tests that legitimately mutate the copy they read, and a copy keeps that contract exactly.

Gates: integration **891/891** (130 files), default suite **1279/1279** (110 files), shared/server/web typecheck exit 0, `eslint .` 0 errors.

Package: `0.0.49-c3-offline-parity-r16`, bundle `index-Cf3q7JoX.js`, SHA-256 `93a12b0478a29230e059109a0cada88947c30b9cc2339e6a87d3879a97921cd9`, installed and measured on the device.

## Packaging session — the current tree (2026-10-11, r17)
The user asked for the current app to be packaged and installed. The tree had moved on since r16: `offline-api.ts` and `sync-mutation-plan.ts` were touched at 16:17 and a new suite `offline-compound-tag-layout.integration.test.ts` (8 cells: B6/B9/B10 chains and continued edits on queued **and** settled Entries, tag-before-template continuation, UID-addressed Facet moves with native dependencies, alternating layout/template/Facet chains, peer edits after a type-wide apply, response/ACK loss with cold restart, a real concurrent conflict, and the "accepted originals must not be cleared" case) appeared at 16:20 — the sibling's work on the same surface, carrying a `compoundTagReplayExpectation` proof.

Gates on that exact tree: integration **902/902** (131 files), default suite **1279/1279** (110 files), shared/server/web typecheck exit 0, `eslint .` 0 errors.

Package: `0.0.49-c3-offline-parity-r17`, bundle `index-Do77xCd1.js`, SHA-256 `7ede80f080dd2e0acdbe8f48fa824dff61c21afd8831dedcb064ee3fc53b3c1b`. Identity checked before install: the r17 marker is present and r16 absent, 15 packaged web files, package `com.speechless666.t3.spike` versionCode 49, the five permissions unchanged, and the signer certificate SHA-256 still `1035333c…fdf41` (the v43–v49 chain). Installed with `adb install -r` (data preserved) and the running WebView was read back over CDP, serving `https://localhost/assets/index-Do77xCd1.js`.

## Device acceptance session 10 — the queue that never drained, and the "from scratch" update (2026-10-11, r18)
Two reports: 66 queued edits never finished (manual sync did nothing), and the offline-library update "walked everything from the top" even though nothing was re-downloaded.

### (1) The stuck queue — root cause measured from the real queue
The device diagnostics named it: `lastReplayError` = **"Request conflicts with current data"**, mode online, probe success, 65 ops all `pending`, none failed or conflicted. That message is the server's 409 for `isSqliteConstraintError || isDomainConflictError`, i.e. a handler **threw** instead of answering a receipt.

Reproduced against a **copy** of the real library (never the formal one) by replaying the dumped queue in order: 27 ops applied, then `entry.tag-layout.set` (base 6) threw **`SqliteError: FOREIGN KEY constraint failed`** at the delete of a Facet — the payload drops 价位 while that Facet still holds `entry_tags` on a settled work (测试), and `entry_tags.facet_id` is `ON DELETE RESTRICT`. The client's copy had been stale, so its own occupancy check never saw that assignment. The 409 then aborted the whole replay, so the queue never drained and every later op stayed queued forever.

Two fixes:
- **Server**: deleting an in-use Facet now answers a **conflict receipt** (the original is retained and the rest of the queue proceeds) instead of throwing a constraint error. The row id needed for that check is carried separately and kept **out** of the value comparison — leaking it into the canonicalized groups made every layout original look stale (a self-inflicted regression I caught because the sibling's new `offline-compound-tag-layout` suite went red).
- **Client**: a replay response the server *answered* (any 4xx, e.g. a 409) now marks **that op** failed and continues; only a transport failure (no answer, or 5xx) keeps the op pending and aborts the pass. This is the "a refused item must fail alone" rule applied to the replay.

Verified with the real queue on a library copy: 30 ops apply, 5 layout/template ops conflict, and the 30 dependent tag ops fail visibly — the queue *moves* and every exception is named.

**The desktop must be restarted for the server half**: the running server process started at 13:41:56, before the fix, and `tsx` does not hot-reload, so the phone still sees the old 409 until the tray restart.

### (2) The update "from scratch"
Measured, not guessed: the snapshot update is already incremental — `fetchSnapshotCandidate` takes the **delta** path (`POST /api/sync/delta`) and only falls back to a full snapshot when the baseline is unavailable; nothing is re-downloaded. What the user watched with a progress counter is the **media preload** that runs right after: it walks every media ref, skips the ones already cached (`cached`/`skipped` in its result) and writes only the misses — hence "no repeated download" but a pass over everything.

Why the walk cannot be skipped when nothing changed: media addresses are **positional** — the same URL can hold different bytes after a replacement — and the snapshot's `mediaRefs` carries only the addresses, no per-ref revision. So "nothing changed" is not provable from the snapshot alone; each ref costs a cache match (~1 ms, measured earlier: 11 k refs ≈ 11 s on the phone).

Options put to the user: (a) carry a per-ref revision in the snapshot's media metadata so the client can skip unchanged refs (a server + schema change), or (b) keep the walk.

Package: `0.0.49-c3-offline-parity-r18`, bundle `index-DLcbAWYY.js`, SHA-256 `4beafe65dc4cd63377cd63139677553edecdbda9042235e154d820dabc6c60b2`, installed. Gates on the tree: integration **902/902** (131 files), default **1279/1279** (110 files), typecheck 0, lint 0.

## Device acceptance session 11 — the media editor's wrong sentence (2026-10-12, r19)
Reported: opening an Entry's image editor showed "upload attempted or uncertain". Reproduced on the device: the media edit mode disabled delete/move and `data-testid="media-removal-reason"` held *"Upload attempted or uncertain; use foreground Update before deleting or moving images"* — while the only staged row was a **cover** with `status: pending` and `lastAttemptAt: null`, i.e. **never sent**.

Cause: `getEntryMediaRemovalBlockReason` collapsed three different situations into one sentence — a non-pending/attempted row, a staged **cover** (which is not a preview, so `kind !== 'preview'` fired even when nothing had been sent), and the native mirror's unknown state. The refusal itself is right (the order command hands over the whole list, whose first ref is the cover, and a staged cover has no committed ref yet), but the sentence was false.

Fix: the API now answers a **code** (`no-server-row` / `upload-uncertain` / `cover-not-uploaded` / `native-uncertain`), and the page owns the wording and the language (`media.blockCoverPending` is new, and the two existing sentences were rewritten to say what to do). An unknown value is still shown verbatim, so a caller that answers with its own sentence reads correctly. Regression cell added: a never-sent cover must report `cover-not-uploaded` (not `native-uncertain`).

Verified on the device: the same Entry now reads **「这部作品的新封面还没上传；先让它同步，再删除或移动图片」**. (Also observed: the user's queue had drained 65 → 7, so the session-10 fixes worked in the field.)

Gates: integration **902/902** (131 files), default **1279/1279** (110 files), typecheck 0, lint 0. Package `0.0.49-c3-offline-parity-r19`, bundle `index-BNRrfYYO.js`, SHA-256 `a76a6694a539eed309f8fe4d06c7ba7cf01df31b062b25d30e9d712a51bdff7d`, installed.
