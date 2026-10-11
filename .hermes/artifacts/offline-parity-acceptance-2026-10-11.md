# Offline-side acceptance — 2026-10-11

## Gates at acceptance time
- Full integration suites (web + server, one run): **874 tests, 873 passed, 1 failed** — the single failure is the inherited `delta-payload.integration.test.ts` item documented below (not a feature gap).
- Shared/server/web typecheck exit 0; owned-surface ESLint 0 errors.
- Native JVM: conversion 3/3, merge 2/2 (real Worker/native SQLite/pinned TLS), contract regenerated at 34 kinds.
- Board lanes 01–12 all code-complete; packaging deliberately deferred (user runs unified acceptance).

## Offline-provided (matrix, from the shipped facade + capability flags)

**Reads** — full offline parity from the saved snapshot plus queued-op projection: Home/Galleries/Gallery card lists, Entry detail (sections/facets/tags/contents/media refs), Author pages, Collections, Search, View later, Recent, Random, filter options (facets/authors/ratings), navigation counts, Entry sources.

**Writes (durable queue → canonical replay → receipt → durable ACK → cleanup; cold reopen, exact retry, response/ACK-loss settlement, export/atomic restore, native Worker policy):**
- Entry: edit metadata (title/dates/page count/duration), delete, merge (07), multi-author conversion incl. no-op and dependent continuations (06), tags assign/move/remove/rename + new vocabulary/facets, contents set/append/reorder, ratings + slot delete, usage/view-later, media upload (incl. **occupied-cover replacement**, 10) + order, offline create (quick, with initial contents/media/author) and **create-then-immediately-edit** (11).
- Layout: Section create/rename/delete, Facet delete/reorder (08), apply-tag-layout + save-as-template rebuild (09).
- Authors: delete, profile, tags, self + works ratings, gallery anchor, directories, author create (+ directory seed), cross-entry reuse.
- Collections: create/rename/NSFW/order/membership (entries + authors), delete, bulk common-tag.
- Gallery: new type, SFW/NSFW partition, order.

## NOT provided offline

**Excluded by user scope decision (not gaps):**
1. The whole Advanced-functions page (tag dictionary/merge, alias groups, title shortening, producer merge plan/execute, source maintenance, System page backup/restore/settings, Templates management tab).
2. The SiteProbe Import pipeline end to end (folder/metadata-JSON/batch import previews and commits, siteprobe panel and runs) — including `applyCommonTemplate`/`applyCommonTemplateRatingSlots`, which only the import preview's "use common template" door calls, and `createTemporaryCollection` (batch-review filing).
3. Standalone +Author page (the online product has no such entry point; create-by-name and link-to-Entry remain available offline).
4. Advanced producer merge.

**Capability boundary (current offline limits, fail closed with visible local errors):**
5. Preview (media) replacement — only the cover can replace an occupied slot; previews append/delete/reorder only.
6. Pending-Entry initial content rows cannot be edited after the create (append/delete/reorder of staged rows); saved-entry content is fully editable.
7. A template applied to a Gallery that already has one is refused, not merged (template copy semantics).
8. Field-level conflict merge editor does not exist (visible conflict + original retained + explicit discard is the model).
9. Pure-browser PWA client — optional path, not delivered.

**Connectivity-inherent (cannot complete offline by design):** pairing/revocation, explicit reconnect/sync, refreshing metadata, downloading absent media.

## Remaining non-code items
1. Unified on-device acceptance (grouped register: QR/WebView/Keystore, background OS behavior, cold launch, compound edits, IME — accumulated across lanes, none of this batch's features device-verified).
2. Packaging/release (no APK for this batch; stable release signing decision still open).
3. Inherited engineering debt, recorded: `delta-payload` test premise broken by 043 journaling (needs unjournaled-table re-selection); 4 legacy kinds missing native-valid-kind fixtures (other lanes); null-uploadDate default-sort tie-order divergence (title-asc parity only); lane-04 markerless legacy eligibility UNKNOWN; noCopy portable restore unsupported.

## Packaging (2026-10-11)
**v49** `0.0.49-c3-offline-parity`, versionCode 49, `spikes/001-android-webview-shell/T3-v49-offline-parity.apk`, SHA-256 `5c15231246c38cec9445ab3b2a04f0f7c4e6dabe7967ad94a22f89bee7bb8760`. aapt/apksigner/web-byte/marker/permission checks all green (manifest `.hermes/tmp/offline-takeover/release-v49/manifest.json`); signer identical to v43–v48. No device attached at build time — install and on-device behavior UNVERIFIED. Remaining items 1–2 above narrow to: install over the existing app and run the on-device register.

## Device acceptance session 1 (2026-10-11, device WGM77LVKD6RW9XZX via USB/CDP)

Two real-device findings, both root-caused and fixed the same session:
1. **"Tag layout editing is not available under offline"** — the desktop server process predated the batch (started 10-10 19:44), so its capabilities response lacked `offlineEntryTagLayout`/`offlineEntryMerge`; the phone correctly fail-closed. Fixed by the user restarting the desktop from the tray (verified: capabilities now advertise both, schemaVersion 43).
2. **"Refresh this offline copy before editing the tag layout; stable layout identity is missing"** — a genuine design gap in lane 08 found by the first real gesture: a **fresh Gallery type with no Section/Facet ever** has no `entry_tag_layouts` row, and my offline path required it to pre-exist, while online the first-create trigger materializes it. Fixed: the first layout original mints the identity at version 1 over an empty base (optional `payload.entryType`; server replay creates the row when absent and refuses a foreign/duplicate type; client projection synthesizes the row and — a second defect the test caught — new groups project under deterministic `localCollectionId`, matching what `createSection` returned). Fresh-type integration cell added: create → cold read → settle → rename offline → chain-settle (4/4).

Rebuilt v49 in place (same versionCode 49, new SHA-256 `0e691aed88c45b0120531db0ff56e4647d610905206ab9c7ccb3c4d6a09b85c8`, signer unchanged), full identity re-verified, installed over the app via adb (data preserved: the queued 探店 create intact), cold-started and confirmed running the new bundle. Remaining for the user: retry the gesture offline (edit the 探店 entry → create the first Section → rename → reconnect).
