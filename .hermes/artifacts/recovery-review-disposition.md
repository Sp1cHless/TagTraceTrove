# Recovery review disposition

## Current checked source
- `apps/web/src/offline/offline-api.ts`: 5,384 lines, SHA-256 `e678ee525f133a830aff7d09688b97eaea30afe757ff40693d33c506e8731fef`.
- Complete preserved checkpoint: `.hermes/tmp/offline-api-restored-validated.ts` (byte-identical).
- Original read-only findings remain in `.hermes/tmp/recovery-compare-findings.md`; their candidate snapshot predates the parent's create/discard recovery. This disposition does not alter or misrepresent that independent report.

## Findings accounted for
1. Uncertain create identity/payload reuse: RESOLVED. Current `enqueueOfflineEntryCreate` selects `presetCreateOperation`, validates active library/epoch, preserves client/entity/operation/time and payload Content identities, and retains original slot identities. Evidence: actual delivered v40 `Te` helper, preserved in `recovery3-create-discard-evidence.json`.
2. Foreign library/epoch pending discard seeds: RESOLVED. Current predicate compares each operation with the active snapshot library/epoch without rewriting the existing dependent-chain or native-pause cleanup. Evidence: actual delivered v40 `qe` helper in the same artifact.
3. Offline media cache forgetting difference: INTENTIONAL newer fix, not incident loss. Historical assistant tool-call message 130141 explicitly removed `forgetEntryMedia` from offline/fallback enqueue paths alongside staged projection. Actual history captured in `.hermes/tmp/recovery-final-cache-history.json`. The cold-IDB/real-HTTP regression verifies surviving cache bytes and successful ACK reconciliation. Do not restore the older cache eviction.

## Actual gates
- Actual root test command without a candidate override: 1,793 tests PASS.
- Shared/server/web workspace typecheck PASS, affected ESLint PASS, whole-tree diff check PASS.
- Relevant regressions independently verified as passed in the saved actual test JSON:
- offline-aware Gallery API queues an uncertain online create command with its exact identity and staged media
- offline-aware Gallery API refuses an offline create command whose identity belongs to another library revision
- offline-aware Gallery API does not remove queued operations when the library changes; discard can take them
- offline-aware Gallery API discards pending operations from a foreign library epoch with the blocked set
- existing Entry real cold client/server media vertical renders staged preview bytes through the real facade and cold IDB without evicting surviving cache bytes, then reconciles after ACK

## Boundary
Recovery is closed with genuine history, preserved bytes, compiled-artifact behavior reconstruction, static comparison and executed tests. Original historical suffix-byte equality is NOT claimed. Preview deletion/composition/cancellation/native/cleanup acceptance remains incomplete; no new APK, formal migration, deployment or device acceptance is implied.
