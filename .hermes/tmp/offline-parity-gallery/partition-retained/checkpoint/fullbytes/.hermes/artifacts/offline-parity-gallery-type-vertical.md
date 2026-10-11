# 04 first Gallery/type vertical — foreground functional checkpoint

## Outcome and invariant
Ordinary GalleryApp → AddEntryPage manual form → existing production offline facade → one durable `entry.create` row → canonical HTTP/SQLite replay → verified snapshot/durable ACK settlement is functional. Gallery remains derived solely from Entry.type; no Gallery entity/ID/table, new migration, new operation kind or generated native contract was added.

Online authority audited: createEntry trims title/type, but does not NFKC/case-fold a manually typed type; listGalleries groups exact stored type. listLayout reads existing per-type Section/Facet rows and returns **empty layout for a fresh type**, not a manufactured default Facet. Cold layout reads now use saved canonical tagGroups and the same sortOrder/id ordering. Existing shared layout reuses authoritative numeric IDs; no fake UID/FK/initial Facet is invented. Existing template/immediate-editor and Import paths are not expanded.

## Actual finite matrix (six tests, no pending)
1. Mounted actual GalleryApp Add Entry navigation, real form input + submit, known-offline new type: zero business HTTP, one durable create, form closes, derived cold Gallery appears, empty canonical layout, real SQL + receipt + cleanup.
2. SQL response loss after commit: retained original fingerprint/UUID; full cold export/atomic restore preserves complete attempted metadata. ACK response loss retains work; cold export/restore then exact raw-body retries settle once, one receipt, no duplicate Entry.
3. Same trimmed type appended twice derives one Gallery with count2. Existing Comic type reuses its real shared layout and settles normally.
4. offlineMutations/offlineEntryCreate/offlineEntryNewType each false and truly absent: local `not available under offline` refusal, zero queue/business HTTP.
5. Downgraded new-type capability holds an attempted original, preserving fingerprint and original body, no POST.
6. Actual ordinary connected no-copy and old-copy creation uses bounded capability/replay command; no legacy POST, snapshot/media predownload. Fullwidth manually typed type is preserved, matching online trim-only semantics. No-snapshot local enqueue also refuses with zero HTTP/queue. Connected and snapshot defenses are first-GREEN coverage, not fabricated REDs.

Capabilities: server advertises offlineEntryNewType; facade persists its conjunction with general/create flags on successful probes without depending on options.state. New types require trusted active snapshot and explicit capability for local enqueue; missing support holds replay. Restore no longer treats a derived Gallery type as an independent referenced owner. Library/epoch, strict envelopes, other owners/reference validation and the existing single-IDB-transaction restore boundary remain intact.

## Genuine RED / issues
- Initial harness failure: GalleryApp requires global addEventListener/removeEventListener; fixed only the JSDOM harness. Not product RED.
- Actual ordinary caller RED: queue remained empty because facade rejected a previously unused type.
- Next actual RED exposed missing offline listLayout adapter (known-offline HTTP attempt), new-type restore rejection, required-cap refusal/absence behavior and downgrade sending. These were minimally repaired and all six are current GREEN.
- Existing SQL integration expected new type to fail; changed only that obsolete assertion to successful canonical creation. Rating validation remains unchanged.
- Web typecheck exposed callback narrowing on mutable operation; captured createdType locally. Final web typecheck PASS.
- **Broader adjacent default selection is not entirely GREEN:** 181 PASS / 1 FAIL / 0 pending. Untouched offline-api.test.ts test `does not enqueue offline Collection deletion or temporary membership imports` expects `Failed to fetch`, while current pre-existing Collection deletion implementation reports `Collection deletion is not available ...`. No unrelated03 assertion/production repair was made. Raw failed evidence retained. Do not report full default-suite PASS; parent should disposition this old Collection expectation separately.

## Final actual gates
- `gates/final-current.json`: **96 PASS / 0 FAIL / 0 pending** = new Gallery/type6 + protected03 commonTag20/delete25/ordinary3 + nearest canonical SQL42 (cross-path-entry-create + sync).
- `gates/final-default-bounded/results.json`: **84 PASS / 0 FAIL / 0 pending** (offline-library, pending-work restore pure/atomic, export, offline-sync).
- Shared/server/web types: exit0. Owned source/test ESLint exit0; final changed test ESLint exit0.
- Scoped complete pre-writer-byte diff: no added trailing whitespace. This avoids promoting unrelated pre-existing dirty git diffs as this writer's changes.
- Registered332 initial web/server/shared source/test/migration files plus the new test and changed SQL test guarded before/after gates. Exactly five production files differ from initial source inventory; all other registered source bytes remain unchanged. Full-byte manifest archives current guarded source, initial backups, RED/GREEN/gate evidence and this report, with live/saved size/SHA verification.

## Files
Production: apps/web/src/offline/{offline-api.ts,offline-library.ts,pending-work-restore.ts}; apps/server/src/sync/{replay-service.ts,sync-service.ts}.
Tests: new apps/web/tests/offline-gallery-type.integration.test.ts; targeted assertion update apps/server/tests/integration/sync.integration.test.ts.
Evidence: .hermes/tmp/offline-parity-gallery/type-vertical/ and this report. GalleryApp/AddEntryPage/API root production bytes were NOT changed.

## Safe stop / limits
Production and test writing STOPPED after this functional checkpoint. **Do not declare all04 DONE.** Gallery partition is next lane, not half-implemented here; Native new-type capability/Worker/device acceptance, templates/immediate editing, next parity items and grouped global/device release gates remain separate. Existing03 Native receipt sources were not edited; no JVM/Gradle execution. This is app.request + isolated migrated-memory SQLite and fake-IDB cold reopen proof, not TCP/Android/OS/process-survival proof.
No formal DB/assets, default server, environment credentials, APK/build/dist, version/signing/auth/pins/transport, cache clear/media redownload, migration edit or git commit/reset/stash/checkout. No follow-on writer dispatched.
