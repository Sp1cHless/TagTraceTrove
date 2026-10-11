# Final finite board — partial GREEN, remaining blockers explicit

## Outcome
Same-Entry deletion during asynchronous upload hashing is repaired with permanent real caller RED→GREEN on both IndexedDB and unified Memory. Wrong/missing/HTTP-failed asset-byte retention is permanent first-GREEN defense. This is NOT full Preview acceptance or release clearance: deletion-only snapshot/byte cleanup defense and authenticated/native byte-fetch caller evidence remain open.

## Owned changes (targeted patches only)
- `apps/web/src/offline/media-outbox-store.ts`: mandatory `operations` capture identity; canonical operation fingerprint plus status/attempt/error in causal list order. Undefined/missing identity cannot bypass validation. Existing snapshot/revision/media/capability validation remains.
- `apps/web/src/offline/indexeddb-snapshot-store.ts`: OUTBOX added to the SAME readwrite stage transaction as active snapshot/meta/media; getAll operation identities revalidated before Blob add. A mismatch aborts, leaving no orphan Blob.
- `apps/web/src/offline/memory-offline-store.ts`: operation validation and media publish happen synchronously in the same tick, no intervening await.
- `apps/web/src/offline/offline-api.ts`: captured operation identity passed after hashing; rejection asks for renewed review. No existing/uncertain request, UUID, body or digest is rewritten. Shared guard field also supplied by existing cancellation caller; cancellation implementation itself unchanged.
- `apps/web/tests/existing-entry-media-vertical.test.ts`: permanent dual-adapter hash/deletion race and wrong-byte/404/503 asset defenses using actual ephemeral TCP HTTP, migrated temporary SQLite, temporary assets and production facade/store.
- `apps/web/tests/existing-entry-media.test.ts`, `native-settings-facade.test.ts`: explicit empty operation capture in direct stage fixtures (new mandatory contract). Existing media/snapshot race checks retained.

## Actual evidence
- `.hermes/tmp/preview-final-atomic-red.log`: permanent race 2 FAIL (Memory + IDB), 18 skipped, staging incorrectly returned successful null error. Real behavioral RED, not collection/fixture error.
- `.hermes/tmp/preview-final-atomic-green.log`: 26/26 across 2 files PASS after guard repair.
- `.hermes/tmp/preview-final-focused.log`: FINAL 216/216, 8 files PASS (existing-entry-media vertical + unit, pending-work restore + atomic, indexeddb snapshot, offline-api, native handoff, native settings facade).
- `.hermes/tmp/preview-final-web-typecheck.log`: FINAL PASS, empty.
- `.hermes/tmp/preview-final-server-typecheck.log`: FINAL PASS, empty.
- `.hermes/tmp/preview-final-lint.log`: FINAL all 7 modified source/test files PASS, empty.
- `.hermes/tmp/preview-final-diffcheck.log`: PASS; only pre-existing Git LF→CRLF notices from dirty worktree.
Initial web typecheck found mandatory-guard fixture arguments and Memory/native union narrowing issues; both corrected and final gates rerun GREEN. Patch tool's automated single-file check repeatedly used invalid MSYS TS filename (TS6053); the actual project typecheck above is authoritative.

Wrong-byte/404/503 tests all passed on their first production run: **first-GREEN defense**, no invented RED. Each asserts canonical upload identity/hash/preconditions and exact Blob bytes retained, an actual asset HTTP request reached, no ACK, no verifiedReplayProjection and no snapshot activation. Existing correctly checksummed media-omitting delta test also passes in the final suite; that is uploaded-media coverage, not deletion-only general coverage.

## Full-byte preservation / scope review
- `.hermes/tmp/preview-final-safe/start/`: complete read_bytes pre-edit files, initial manifest; native-settings fixture additionally preserved in that directory before editing.
- `.hermes/tmp/preview-final-safe/green/manifest.json`: all 7 modified source/test full bytes, SHA256/byte counts and corresponding start hashes.
- `.hermes/tmp/preview-final-own.diff`: diff against those actual initial bytes; inspected, no unrelated production deletion or rewrite.
- Current offline-api SHA256: `66d87078e721fe3299f3d479f24c2b7f8de1f80b4ea67ed1233c771180f7b95f` (314376 bytes, still 5521 lines).
- Starting offline-api matches parent supplied `db32644ae53fa3b6210944dc81f7c4d5293e649e217926dcadb148c9cb25ea30`.
Server/media, native production, auth, schemas, parent CURRENT/board/shared handoff, integration config untouched. No formal DB/assets/default server, fullroot, JVM suite, build/APK, deployment, commit, reset/stash or restoration from historical checkpoints.

## Remaining exact blockers / unclosed acceptance
1. **Deletion-only complete snapshot / survivor-byte cleanup defense is NOT closed here.** Existing deletion response-loss→cold retry→ACK-loss tests pass, including actual on-disk survivor bytes, but those do not prove refusal of a valid checksummed newer snapshot whose retained media is incomplete/wrong. Production pre-activation applied-media byte verifier (`offline-api.ts` 3975–3995) iterates `appliedMedia`, not deletion-only `entry.media.set`; no new deletion-only malformed-success tracer was retained or claimed. Need the scoped real caller fixture: queue deletion retaining distinct-color original; serve valid checksummed incomplete delta / wrong actual survivor bytes; assert no verified projection/activation/ACK/cleanup and original operation/cache retained; then correct snapshot+durable ACK permits cleanup. Do not infer defect RED from this inspection alone.
2. **Authenticated/native raw-byte caller seam remains UNVERIFIED, not an unavailable API claim.** Current proof uses global `fetch(online.assetUrl(expectedRef),{cache:'no-store'})`; `ApiClient.request` is JSON-only and supplied fetchImplementation is not used by that proof. Android `prepare-web.mjs` lines 21–44 overrides fetch for canonical `https://localhost/api/*`, routes path+query through `T3PairedTransport.request`, decodes returned base64 into raw Response bytes. `PairedTransportPlugin.request` invokes existing PinnedLanTransport with private state.token; MainActivity intercepts asset GET likewise. Thus native infrastructure does have a byte-capable route; do NOT add a bypass or claim it cannot do bytes. This session did not exercise production verifier→actual bootstrap/adapter→authenticated real isolated listener or verify canonical URL/Authorization/raw bytes through that chain. Public ephemeral desktop tests prove none of that. Need existing secure-pairing setup + actual bridge/adapter caller test; device WebView interception remains a separate device boundary. No unapproved server accessed or speculative auth/native core edit made.

Stop at verified finite slice. Parent can review the narrow guard diff and consolidate gates, but cannot mark the whole requested finite board or release complete until the two remaining acceptance seams above are resolved.
