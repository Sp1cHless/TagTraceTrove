# Complete delta board — partial, NOT enabled

## Continuation observed (latest; supersedes the corresponding older pending items only)
- Strict RED→GREEN: atomic install retained 3 generations; memory + IndexedDB now prune in the activation boundary to active plus captured previous generation. Five sequential installs and actual IDB close/reopen prove `[4,5]` retained. Outbox/media stores are not pruned.
- Strict RED→GREEN: peer install between Clear pointer reset and generation enumeration was erased. IndexedDB Clear now checks pending operations/media and clears generations/pointer within the same readwrite transaction as activation/enqueue/restore. The regression exercises peer-after-Clear order; broader simultaneous orderings, null-base ABA and memory/composite-store Clear remain pending.
- Strict RED→GREEN: actual API pull → real offline facade enqueue Entry create → actual SQL replay → frozen delta covering refresh → readback ACK now works without a full refresh request. Existing causal receipt/high-water/final-owner checks retained; replay activation captures `activeBeforeReplay`. Legacy/no-delta transports retain full refresh. This is memory-store HTTP proof, NOT cold-IDB replay/reconnect or mounted Settings proof.
- 304 shared/affected Web tests passed across 22 files; 61 real SQL tests passed across five suites (delta, sync, pending metadata/new Author, new Facet flow). Scoped ESLint and `git diff --check` passed (line-ending warnings).
- Latest workspace typecheck: server/shared passed, Web blocked by unrelated `apps/web/tests/add-entry-quick.test.ts:281` listLayout fixture lacking Section id/sortOrder and Facet sortOrder. The missing common-template JSON blocker did NOT appear in this live run; no related file was created/changed by this continuation.
- Only continuation edits: `snapshot-store.ts`, `indexeddb-snapshot-store.ts`, `offline-sync.ts`, `offline-api.ts`, `snapshot-delta.test.ts`, `complete-delta.integration.test.ts`, this artifact. No capability advertisement change.
- Still unfinished: durable shared Update/feed device ID (`foreground-snapshot` remains), exact persisted request mediaMode, mounted Settings Update, genuine reconnect/cold-IDB replay and immutable lost-response retries, persisted exact install-bound lost-ACK retry, full Clear/identity/quota/abort/ABA acceptance, all-table SQL parity, frozen concurrent multi-pages/tamper/surrogate/cache expiry/restart/eviction matrix, complete gates and bounded parent review. `applySnapshot` atomic success currently reports `prunedGenerations:[]` despite actual pruning; diagnostics can be made accurate in a later tested slice. Keep capability OFF.

## Observed verticals
- Real disposable SQL → `/api/sync/snapshot` registers an actual canonical server baseline → typed `/api/sync/delta` → exact serialized-snapshot splice → strict snapshot/checksum/count verification → conditional generation activation → durable readback → `/api/sync/ack`.
- Entry update and deletion both equal the actual server full payload, with no full-snapshot network request on the successful delta leg. The test explicitly injects `completeSnapshotDelta: true`; production capabilities DO NOT advertise it.
- Separate IndexedDB instances: replacing the captured base rejects a delayed install; cold reopen preserves the winning generation. Actual behavioral RED→GREEN observed.
- No journal records are interpreted as complete payload records. No SQL schema migration is required for this server-owned bounded cache approach.

## Contract and actual model evidence
`readPayload` includes Entries, Producers, Entry–Producer edges, Tags, TagGroups, Entry tag layouts/placements, Producer tags/assignments, taxonomy aliases, Content, rating slots/layouts/Entry+Producer values, Collections/members, Author Directories/sets/members, usage, both View later orders, Gallery settings and mediaRefs. Several are not independently journaled; the old changes endpoint remains unchanged.

The new v1 contract uses a UTF-16 splice of the entire canonical schema-serialized snapshot (header and every payload table). This preserves array order and optional-property presence without inventing relational UUIDs. Page chunks are at most 16,384 code units; offsets, scope, target header, token, final length/schema/checksum and existing header counts are checked. The immutable target is read once using existing immediate SQL snapshot transaction. Subsequent page reads do not rebuild it.

Server baseline/session cache: process-local WeakMap per database, 16 combined items, 48 MiB UTF-8 cached content, five-minute expiry. Missing/restarted/evicted baselines cause full snapshot fallback; no client-supplied payload is accepted as a baseline. Target generation/cache and legacy journal cursors are different; fully serving an immutable target grants existing served-cursor ack permission, not an ack itself.

## Exact remaining acceptance / implementation
Do not advertise `completeSnapshotDelta` yet.
1. Real populated all-table SQL parity matrix, especially unjournaled taxonomy/rating/relationships/Directory+Collection order/Gallery/media and optional absence. Current real parity tracer covers Entry update/delete only.
2. Frozen multi-page concurrent-write proof; eviction/expiry/restart/cache bound and actual full fallback proof; tampered/dropped/reordered pages, invalid protocol/scope/cursor/target schema/counts/identity.
3. Delta install/ack with actual IndexedDB cold reopen; pending original Outbox envelopes, optimistic overlays and media preservation; aborted/quota/identity/Clear/peer generation races yield zero ack. The existing peer replacement test proves conditional activation only.
4. Real `offline-api.ts` pull/push/pull replay and reconnect paths still use existing full refresh. Integrate candidate fetch/conditional activation/readback acknowledgement there without weakening its causal receipt/high-water/final-owner-state checks. Actual Settings Update uses `downloadOfflineSnapshot`, but no mounted-UI delta test yet.
5. Replace the placeholder `foreground-snapshot` feed client with durable device identity; distinguish persisted media mode from current GalleryApi thumbnails convention; legacy adapters without atomic activation now explicitly take the full path (behavioral RED→GREEN); retain this gate in replay integration. Test ack-loss idempotent retry. Current candidate ack helper swallows a lost ack and permits a later valid target; exact lost-ack retry is not proved.
6. Bound/prune atomic installed generations; existing legacy apply path prunes, the new atomic path currently retains all generations. Verify clear/activation concurrency in one durable boundary, not only pointer reads.
7. Full shared contract suite, affected full web suites/SQL gates and parent read-only review before enabling advertisement. No native/background/QR/auth/device work belongs to this board.

## Verification observed
- First real SQL Entry transport test: behavioral RED at absent `/sync/delta` traffic → GREEN.
- IndexedDB delayed activation test: behavioral RED (stale install succeeded) → GREEN.
- Final focused Web + all existing shared suites: 284 passed across 19 files (new race and legacy-adapter gate, snapshot store, offline sync, IndexedDB, offline API, Gallery API, pending-work restore 60+3).
- Focused isolated SQL: 36 passed (new real vertical + existing sync 35).
- Scoped ESLint: passed.
- Workspace typecheck: latest actual run passed. Earlier supplied RuleBuilder locale blocker was not edited by this worker; it no longer appeared in this live run (possible concurrent work). Do not rewrite that unrelated file.
- `git diff --check`: passed; existing Windows line-ending warnings only.

No docs, skills, formal DB/assets, APK, commits, reset/stash, nested agents or unrelated UI sources were changed. Parent owns broader gates/review/status updates.
