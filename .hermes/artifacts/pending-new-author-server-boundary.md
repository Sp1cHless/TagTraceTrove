# Pending Entry new Author — partial implementation handoff

NOT a complete board. No new capability has been advertised or client/UI enabled.

## Owned changes
- packages/shared/src/schemas/sync.ts: existing entry.author.create-and-link accepts nonnegative baseVersion and optional UUID parentCreateOpId iff baseVersion is zero; positive legacy envelopes unchanged.
- apps/server/src/sync/replay-service.ts: explicit pending parent registry + applied receipt + UID/numeric Entry identity validation before missing-owner handling. Missing parent remains unreceipted and retryable. Reuses existing complete Author-base comparison, name/alias collision refusal, transactional Producer/link/journal/receipt path and Producer entityId response.
- apps/server/tests/integration/pending-entry-author-create.integration.test.ts: isolated real SQL fixture and seven cases.

## TDD evidence
Initial tracer failed on schema rejecting baseVersion zero and parentCreateOpId (23:18:59 test output). After shared/server implementation the create/wait/exact-retry/unlink/relink tracer passed (23:19:57). Six extra tests passed initially and are defensive regressions, not additional demonstrated RED→GREEN cycles.

## Verified closure before final retry-body assertion
- Focused SQL: 3 files / 20 tests passed (23:21:16).
- Workspace pnpm run typecheck: shared/server/web all passed.
- git diff --check: passed, only pre-existing CRLF warnings.
- Focused shared/existing pending Author facade/editor/Search: 4 files / 39 tests passed (23:21:57).
- Targeted ESLint on the three owned files: exit 0.
- Auto write/patch syntax checks incorrectly passed MSYS /d paths to Windows tsc, reporting TS6053. Actual workspace typecheck passed; do not mistake the tool-path check for a source error.

## Exact next RED (not yet added)
In apps/web/tests/offline-pending-entry-authors.test.ts or a new dedicated pending-new-Author client test, use existing setup with featureFlags offlineAuthorCreate:true and offlinePendingEntryAuthorCreate:true, and invoke api.enqueueOfflinePendingEntryAuthorCreate(localKey,'New Author'). Assert immutable original entry.create, a separate zero-version child with explicit parent, stable producerUid/name return, pending card Author projection, same-Entry option retention after unlink and later relink, and rejection of use on a different pending Entry. Method currently does not exist. Complete this RED→GREEN before starting further cases.

## Remaining implementation
- Advertise offlinePendingEntryAuthorCreate for schema >=29; persisted conjunctive global + offlineAuthorCreate + offlineEntryAuthors + offlinePendingEntryAuthors + new flag gate; diagnostics and downgrade blocking.
- Typed facade enqueue method, queue-order create/link + desired-set projection and same-owner local Author options. Outbox atomic dependent enqueue/removeApplied already recognizes generic explicit parentCreateOpId; verify with new family.
- Exclude explicit-parent create-and-link from legacy Entry revision predictions.
- Cleanup: verify Producer UID→receipt numeric ID and final APPLIED relationship timeline, not each historic create-link (unlink can intentionally remove that link). Existing cleanup currently requires every create-link relation, and will incorrectly retain a create→unlink chain.
- PendingEntryAuthorEditor explicit new-name/create-link path via actual Search callback; page-level lock, rejected draft retention, committed-refresh warning, all-family blocking.
- Real cold IndexedDB close/reopen, real SQL facade response-loss bridge, bad Producer snapshot/owner/cursor/checksum/generation and race tests.
- Main full gates/narrow review/docs and grouped final App acceptance remain separate. No formal DB/assets/default server/probe/doctor, commit/reset/stash, APK or device work performed.
