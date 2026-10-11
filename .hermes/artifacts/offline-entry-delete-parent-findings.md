# Parent release gate: online deletion without an offline snapshot

Status: ACTUAL DEFECT RED, pending repair; Entry-delete row cannot be accepted while this probe fails.

Parent performed an isolated read-only production probe after the first worker stopped; no production/test file was changed. New continuation writer remains sole source/test owner. This is not a server/network setup failure.

## Actual execution

Command:
`/c/Users/hzy/AppData/Local/hermes/node/node.exe --import file:///D:/Project/TagTraceTrove/node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/loader.mjs .hermes/tmp/offline-parity-parent-probe/online-no-copy.mts`

Result: exit 1, assertion `Ordinary online deletion must not require a downloaded offline copy` failed. Real isolated application HTTP successfully returned `/api/sync/capabilities` and `/api/entries/1`; memory offline store had active=null. Actual delete rejected locally with `Entry deletion needs a saved stable identity; refresh this offline copy` from offline-api.ts deleteEntry.

The probe uses actual createMigratedMemoryDatabase/createApiApp/createGalleryApi/createOfflineAwareGalleryApi, a disposable Entry and an explicit temporary assetRoot. Its SQL/assets are always closed/removed in finally. No formal DB/assets/default service access and no invented API responses. Application HTTP is not TCP/device evidence.

## Required closure

Retain ordinary connected desktop/mobile behavior without requiring Download offline copy. Also cover an online Entry newly created since an older installed snapshot (missing owner in that snapshot). Obtain trustworthy current online identity/capabilities where appropriate without discarding original queued causal envelopes, synthesizing unknown base state, downloading all media, or regressing known-offline no-HTTP behavior. Keep uncertain deletion exact UUID/body semantics. Translate to a repository TDD regression under the sole writer, repair, and rerun this exact parent-owned probe before Entry-delete completion.

No parent code repair was performed during the successor's source ownership. This finding is a remaining gate, not a claim that the current successor's eventual patch still fails.


Resolved boundary: parent-stage/checkpoint/manifest.json records the finite matrix GREEN. Unmodified online-no-copy.mts prints ONLINE_NO_COPY_PASS; stale-copy new-object regression passes. Current full root 1237/1237, integration 694/694 incl. 22 delete cases; types/affected lint/diff and isolated Vite build PASS. Historical REDs below/above remain evidence, not current blockers. Author writer deleg_ef363483 now active; no deployment/APK/cache clearing.
