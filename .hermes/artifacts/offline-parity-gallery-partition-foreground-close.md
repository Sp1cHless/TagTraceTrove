# 04 Gallery partition foreground finite close

Status: bounded foreground acceptance GREEN; source/tests STOPPED. This is not 04 DONE. No Native/05/APK/build/full-root/formal deployment or live service/database/assets changes.

## Delivered
- Genuine RED reproduced the connected no-copy refusal `Settle earlier partition before staging a different connected value`. Current connected serial true → false → true stages separate durable original UUID commands, exact predecessor retries and base revisions 1/2/3, including cold response-loss retry. No snapshot/media/legacy PUT/ACK or active-generation installation; originals stay pending until real saved-copy reconciliation.
- Exact replay binds the immutable operation receipt to the submitted original. A bounded optional `predecessorOpId` on the existing partition-context read additionally joins that receipt to its own canonical gallery_partition update journal. Strict optional `predecessor` response carries opId/owner/version/sequence/type/value. The client validates library/epoch, entire per-owner successor chain, strictly increasing own sequence and exact final current owner revision/value before staging a different value. This read does not grant feed cursor/ACK/cleanup authority or change mutation bodies. No guessed owner revisions.
- The first attempt to use ordinary `/sync/changes` failed with `Cursor was not previously served`. The bounded dedicated proof read resolves that blocker without weakening the generic feed cursor policy, replay security, receipt persistence or ACK cleanup.
- Genuine ordinary GalleryApp callback/inflight RED exposed the active hidden Gallery remaining open after its partition changed. A narrow visibility watcher clears hidden active Gallery/Entry, cached Gallery rows/count/filter options, and invalidates the outstanding Gallery request sequence. A late result cannot reinstall the hidden Gallery after refresh.

## Six finite groups and provenance
1. No-copy serial different desired values, cold response loss, original-body/fingerprint retention, bounded SQL journal proof, no library installation.
2. Foreign proof opId/UID/version/sequence/type/value/library/epoch/current revision all refuse successor; no original rewrite or queue cleanup.
3. Uncertain retry and conflicted connected predecessor cannot stage across it.
4. Held pending creator and conflicted partition block same-owner successors while an independent partition and Entry owner actually reach SQL. Global offlineMutations=false holds every original with zero replay POST. All retained fingerprints unchanged.
5. Real snapshot canonical facts → cold projection: Gallery query, searchQuery, Author filter, seeded Random, saved-ID query, rating filter, Collection member query/count/cover previews, and mixed-works Author ANY-NSFW exclusion. SFW restoration yields positive Comic matches again. Saved membership itself remains retained; visibility is a read boundary, not deletion. Zero business HTTP during cold reads/toggles.
6. Mounted ordinary GalleryApp button callback with already-visible cache and delayed Gallery sort request: hidden active Gallery cleared and late result ignored. Test uses real fake-IDB/memory SQLite facade; delayed presentation request is controlled, not a TCP/device test.

Existing partition-visibility regressions also verify selected/dealt Random NSFW removal, old in-flight Random rejection, Recently viewed/View later and Collection visibility. These are adapter-based component defenses, not newly claimed canonical SQL defects. The new mounted callback test specifically covers Gallery cached/inflight results; it is not an exhaustive every-callback/Entry-detail/Author-detail lifecycle audit.

## Actual gates
- Initial no-copy RED 0 PASS / 1 FAIL / 0 pending, expected product exception. First working tracer 1/0/0. Foreign current-revision and mounted callback product failures were also observed; initial DOM/import and async wait issues were fixture failures, not product defects.
- finite-stop.json: 6 PASS / 0 FAIL / 0 pending.
- final-sql-fixed-final.json: 133 PASS / 0 FAIL / 0 pending = inherited nearest127 plus new6, retaining type6/saved-partition6/retained6/protected Collection48 and nearest SQL61.
- final-default-final.json: 140 PASS / 0 FAIL / 0 pending, same bounded adjacent default group.
- shared/server/web vue-tsc typechecks exit0. Owned ESLint clean exit0 after removing unused copied imports. GalleryApp.vue is not configured for ESLint here; its earlier ignored-file warning is recorded, not presented as lint coverage. Vue typecheck and mounted acceptance cover the edited region.
- Scoped introduced trailing whitespace0. Complete inherited checkpoint audit: no unexpected changed path outside the five owned existing source files. All existing migrations and protected inherited Native/cache/transport/etc. files retain their inherited bytes.
- Commands/actual argv/exit/JSON/logs and pre/post SHA guards under `.hermes/tmp/offline-parity-gallery/partition-foreground-close/gates/`. Earlier failing output is preserved, not replaced with a fictional GREEN. Last nearest suites ran before removal of one unused import only; current finite6 reran afterward and lint is current.

## Compatibility and limits
- Optional predecessor response is absent for the old ordinary context call; optional query is sent only for this bounded proof lane. Original strict replay request envelopes, optional legacy receipt fields/presence, creator origins and already-attempted bodies are untouched. A server lacking bounded proof refuses a different-value successor rather than downloading the library or falling back to PUT. Existing retained legacy-capability compatibility tests remain GREEN.
- Gallery remains exact trim-type-derived from Entry.type. Dedicated scope owns only the partition overlay; no Gallery entity, phantom ID or default Facet added.
- Not verified: generated Java/native contract for this extension, Native Worker/ledger/device/WebView/OS/phone survival, complete every-kind/every-callback sweep, global gates/build/APK. New Native type/partition/origin lane and grouped platform acceptance remain required. Formal migration043 not deployed; immutable old migrations unchanged.
- Source/tests stopped at finite GREEN. Every new fixture closes IDB/database and deletes its explicitly allocated temporary data/asset root. No services started; no commit/reset/stash/checkout or successor writer.

## Files
Modified existing source: apps/web/src/offline/offline-api.ts, apps/web/src/api/gallery.ts, apps/web/src/GalleryApp.vue, apps/server/src/http/app.ts, packages/shared/src/schemas/sync.ts.
New test: apps/web/tests/offline-gallery-partition-foreground.integration.test.ts.
New report and exclusive before/gates/checkpoint artifacts as above. Inherited tests/production outside these regions preserved.
