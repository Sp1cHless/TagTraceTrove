# T3 online/offline parity audit — current v44 tree

## Scope / baseline

User asks for research first, not implementation. Target: non-server-siteprobe product operations should work offline; every genuinely unsupported operation must be labelled and locally blocked with `not available under offline`, rather than trying the server and surfacing transport errors.

Read-only source audit. Production SQLite/assets/default servers were neither read nor touched. No builds, migrations, APK/version/code changes. Frozen v44 manifest: 498 source/config files independently matched before inspection. Existing dirty tree is the baseline, not HEAD. Scratch probes live in Windows Temp.

## Evidence already independently verified

1. Offline facade inherits online object by spread (`apps/web/src/offline/offline-api.ts:4264-4265`); unoverridden service methods still use online client. Shorthand closures/conditional spreads and real UI routing must be traced before declaring an operation unsupported: `createEntry` inheritance alone does not prove Quick import unsupported because the shell can enqueue directly.
2. Actual production API/client/facade, memory store, synthetic existing test snapshot, explicitly offline state, throw-only injected `fetchImplementation`, no actual network: `C:/Users/hzy/AppData/Local/Temp/t3-offline-audit-probe.mts` and JSON. Latest 16 samples: two local reads succeed with zero fetch invocations; fourteen enter injected fetch (this is a deliberately gap-focused sample, not a support percentage).
   - Local: listGalleries, getEntry(existing).
   - Fetch invoked: getEntry(absent locally), deleteEntry, deleteAuthor, deleteCollection, listTemplates, listLayout, listRatingSlots, listContentKinds, listSourceLibrary, listAuthorAliasGroups, planTitleShortening, deleteTag, renameEntryTag, mergeTag.
   - Absent Entry eventually returns a local not-found error after a failed fetch; it still unnecessarily attempted transport. Others propagate the injected transport failure. This is facade evidence, not proof that every corresponding UI handler is clickable offline.
3. `withFallback` catches both local-load and offline-read errors then tries online (`offline-api.ts:1560-1610`). Valid local data reads avoid network; a missing entity can still enter it. Require separate local-domain/data-unavailable versus uncertain connectivity handling.
4. Snapshot payload (`packages/shared/src/schemas/sync.ts:1251-1282`) carries ordinary subjects/tags/layouts/ratings/collections/directories but not template definitions, author alias groups, source-library/job resources. New local reads for those need real data coverage, not only a message replacement.
5. Source maintenance is a distinct server pipeline, not solely an Import siteprobe path: `apps/server/src/source-maintenance/job-manager.ts:24-30,61-75`; live catalog providers call external fetch in `catalogs/index.ts:11-16`. Saved-record/manual operations and server network-job control must be separated. Homepage adapter recognition itself is pure parsing/registry matching (`adapter-registry.ts:61-92`), although the present App invokes a server route for it.
6. Recovery/synchronization and missing-media acquisition necessarily require connectivity; these are not offline editing gaps. Background connection recovery is intentional (`apps/web/src/main.ts:66-98`) and must not be disabled by a blanket API transport prohibition.
7. Cached-only media limitation: `LazyCardImage.vue:50-76` uses object URLs when cached; cache miss falls back to the source URL, without a guaranteed local offline-unavailable state.
8. Some inherited methods are already guarded at real callers: sidebar counts (`GalleryApp.vue:2794-2807`) skip the online endpoint offline. Conversely Content editor choices (`GalleryApp.vue:2332-2344`) invoke inherited listContentKinds and fall back to built-ins after error: ordinary editing can work but still makes avoidable requests.
9. Exact requested message not found in current web/native application sources. Existing feature-specific offline warnings do not establish a uniform popup/guard policy.
10. Prior phase boundary differs from new complete-parity target: `CURRENT.md:89`, `docs/offline-completion-status.md:116-118` explicitly exclude entity delete/merge, taxonomy/templates, new Gallery/type, Import/Source batches and occupied-cover replacement. Earlier phase completion is not full online/offline feature parity.

## UI coverage

Parent-confirmed caller chains:

- Entry delete: button `GalleryApp.vue:4125-4133`, unguarded confirmation handler `1340-1347`, inherited API; errors are surfaced directly. Author delete: `AuthorPage.vue:1572-1581,868-879`. Collection delete: `CollectionsPage.vue:1142-1149,626-637`. These are not only unused inherited methods.
- Templates tab auto-loads commonTemplate/listTemplates and rating slots without an offline check (`AdvancedEditingPage.vue:642-668`); list failure writes the underlying message to page error.
- CORRECTION after verifying the actual child binding: GalleryApp passes online to AdvancedEditingPage, but AdvancedEditingPage:748-752 forwards it only to OfflineLibrarySettings, NOT SourceMaintenancePanel. SourceMaintenancePanel:67-75 loads remote sources on mount; 94-110 continues remote status polling without an offline guard. The earlier inference of Source maintenance protection was wrong.
- Content editor opens a remote kind-choice lookup but falls back to built-ins (`GalleryApp.vue:2332-2344`); ordinary local content editing and avoidable lookup HTTP must not be conflated.
- An inherited-method Vue callsite inventory is saved in Windows Temp; membership is not a missing-guard verdict. Ordinary-page reader `deleg_c19e0fd1` has stopped without writes; parent read its complete summary and independently verified these additional chains:
  - Standalone Author create (`GalleryApp.vue:3215-3231`) directly calls inherited createAuthor; by-name creation linked to an Entry is a different supported operation.
  - Entry shared rating-slot deletion (`GalleryApp.vue:1326-1336`) uses inherited deleteEntryRatingSlot; the separate Author rating-slot deletion override does not cover this caller.
  - Collection common/bulk tag (`CollectionsPage.vue:595-615`) calls inherited addCollectionTag with no offline guard.
  - Author merge selection immediately loads two online source lists before confirmation (`AuthorPage.vue:1228-1253`); the final merge request is not the only stage needing guarding.
  - Media-order override calls entryMediaRefsOf before its offline check (`offline-api.ts:4424-4426`); that helper can invoke online.getEntry for a missing local row (`1349-1359`). Existing normal-case offline support remains valid, but does not prove strict zero-request behavior for stale/missing detail.
- Source URL as ordinary Entry Content, Author Directory CRUD and ordinary Collection CRUD have local/outbox paths; do not wrongly label these entire feature groups online-only. Read support includes Home/recent/random/search through local list/query overrides, conditional on usable matching snapshot.
- Advanced/import/settings reader deleg_1380e9ac has stopped without writes; parent read the full summary and independently verified Source-panel binding/load/poll, file-upload preview, sync/reconnect and pairing callers. Both delegated scopes are now consolidated below.

The UI conclusions here are source traces, not a newly executed full UI/phone interaction sweep. No claim of exhaustive state-combination parity is made.

## Recommended product boundary (not implemented)

- Truly connected: server siteprobe flows; current server-side Source search jobs and their controls; pairing/reconnect/sync/new metadata or missing-media downloads. External links can require Internet without requiring the desktop server.
- Product parity gaps: non-network management/bulk operations excluded by the old phase boundary; should be tracked as unfinished local/outbox support, not permanently relabelled as inherently online.
- Uniform UI availability plus handler AND facade preflight. Known offline unsupported actions invoke no online service method; show exact requested message. Skip online-only automatic loads/polling as well as button handlers.
- Distinguish supported-but-missing snapshot/capability/cache resources from unsupported operations; explain what must be updated while preserving cached data and pending work. Never clear/redownload as a default remedy.
- Preserve startup unknown/recovery semantics, exact immutable retries, ownership, native authenticated transport and current cache reuse.

No fixes are claimed by this audit. API probes do not establish real Android UI, process survival or physical-device behavior.


## Consolidated advanced/import/settings coverage

Evidence is relative to apps/web/src unless stated otherwise. These are traced call chains, not new GUI/device executions.

| Operation | Current offline behavior / gap | Evidence |
|---|---|---|
| Tags dictionaries/candidates | Local matching snapshot reads | AdvancedEditingPage.vue:159-165,412-418; offline/offline-api.ts:5633-5636,5662-5665 |
| Taxonomy mapping, no-mapping, deletion, JSON dictionary import | Local JSON parse but remote write, missing guard | AdvancedEditingPage.vue:168-196,213-222,263-284; api/gallery.ts:934-953 |
| Import site dictionaries | Requires server-side siteprobe files; still missing guard | AdvancedEditingPage.vue:228-241; api/gallery.ts:940-942 |
| Tag vocabulary merge/delete | Online-only implementation, missing guard | AdvancedEditingPage.vue:390-406,440-453; api/gallery.ts:1318-1327 |
| Author alias groups and producer merge | Remote group loading on tab entry; plan/execute remote; missing guard | AdvancedEditingPage.vue:477-522,574-605,671-672; api/gallery.ts:955-973 |
| Templates read/apply and title shortening | Remote automatic load/plan/execute; missing guard | AdvancedEditingPage.vue:316-348,642-668; api/gallery.ts:976-985,1330-1334 |
| Source maintenance | Network search/control intrinsic server jobs; record review/commit also currently remote, not adapted; mount/poll missing guard | SourceMaintenancePanel.vue:67-110,121-182; api/gallery.ts:1008-1009,1082-1124 |
| Quick ordinary manual creation and selected local image/source-text | Local outbox path conditional on matching saved Gallery/snapshot/capability | GalleryApp.vue:3064-3074; AddEntryPage.vue:1265-1288 |
| Quick fetch from URL | Correct button annotation/disable plus handler preflight | AddEntryPage.vue:178-180,624-632,1409 |
| Quick create and enter template editor | Local fail-closed in submit, but option not pre-labelled/disabled | GalleryApp.vue:3064-3066; AddEntryPage.vue:1296-1298,1555-1564 |
| File/folder/metadata JSON/batch import | Upload preview and commit still server-based; no offline preflight, even for client-selected files | AddEntryPage.vue:699-713,784-792,1109-1126,1176-1200; api/gallery.ts:799-824 |
| Import review/template setup | Remote commit/apply/setup, missing guard | AddEntryPage.vue:292-337,1004-1014; api/gallery.ts:821-839 |
| Advanced import and Rules | Server siteprobe workflows; page-entry sites/runs and requests missing guard | components/AdvancedImportPanel.vue:140-143,252-291,374-400; components/RuleBuilderPanel.vue:191,276,302,381-394 |
| Download/update/check edit support | UI offline-disabled; handlers lack equivalent preflight | components/OfflineLibrarySettings.vue:148-160,203-207,308,365 |
| Sync now | Intentional explicit reconnect probe followed by replay/snapshot download; not a local sync capability or a missing guard to blanket-block | components/OfflineLibrarySettings.vue:216-219,317; apps/web/tests/offline-library-settings.test.ts:106-124 |
| Pending-work export/restore, persistence, safe cache clearing | Local paths; clearing protects unsynced work | components/OfflineLibrarySettings.vue:54-80,118-122,222-271; offline/offline-api.ts:4680-4698 |
| Native transfer resume | Native preflight and preservation rules; not proven fully offline scheduling | components/OfflineLibrarySettings.vue:31-37,333-334; offline/native-background-transfer.ts:142-146 |
| Pairing/device/revoke/recovery | Desktop connectivity needed, no online guard in component; native pair promise feedback not proven here | components/SecurePairingSettings.vue:22-59,65-84 |
| Local NSFW display/page-size/theme preferences | Local state, distinct from Gallery partition mutation | stores/preferences.ts:22-24,162-164,203-205; GalleryApp.vue:3499-3523 |

## Contract classification

- Old phase exclusions are explicit in docs/relation-source-maintenance-offline-plan.md:1219-1229 and docs/offline-completion-status.md:117. They explain implementation scope but do not satisfy the user's full-parity target.
- The source-verified zero-request guard for Quick URL fetch is an aligned positive example. Advanced siteprobe, Rules, Source workflow and pairing need equivalent availability handling without disabling intentional reconnect/sync probes.
- Manual dictionary/file JSON import is not necessarily network-dependent computation, despite its current server implementation. It belongs in the adaptation backlog if the user's target includes local-file imports.
- Source URL/Content edits are already local; independent Source-library data and server job workflow must be treated separately.
- Existing native/cache/outbox paths are conditional, and old/missing capability metadata must remain fail-closed. UI notices need to distinguish unavailable operation, missing data/bytes, missing capability and ordinary validation errors.

## Final verification

Both reader scopes returned without source writes. Parent scratch facade probe executed successfully after signature corrections: 16 cases, 14 fetch-function invocations intercepted locally; no network I/O. These were intentionally selected positive/gap samples, not a support percentage or exhaustive GUI test count.

Final confirmation PASS: all 498 frozen source/config hashes unchanged, and final dirty status exactly equals the audit-start status. No formal DB/assets/service access, production/test/migration changes or APK build was performed. New evidence files and temporary scripts only; real Android interactions remain unverified.
