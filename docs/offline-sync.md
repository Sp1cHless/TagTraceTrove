# Offline library / sync / replay board

Authoritative consolidation of the T³ offline-capable subsystem: the read-only
snapshot, the durable outbox and media outbox, replay/conflict/idempotency, the
media cache, the settings/System surfaces, and the change-feed status. This is
the detailed board; `docs/architecture.md` remains the domain
authority for the shared API boundary, and `docs/mobile.md` covers the
mobile/responsive/device side.

It absorbs the version-by-version churn of `offline-completion-status.md`,
`offline-validation-checklist.md`, `offline-gallery-preview-progress.md`,
`v49-device-acceptance-checklist.md` and the offline release notes formerly in
`CURRENT.md`; durable facts from those files are folded in below. The retired source
documents are archived byte-identically under `.hermes/archive/docs-pre-consolidation/`.

---

## 1. Scope & where it lives in code

The offline subsystem lets the same web UI (desktop browser, Android WebView,
and optionally a pure-browser PWA) read a saved copy when the desktop server is
unreachable and, within a bounded allowlist, edit it durably and replay those
edits when the server returns. The server is always authoritative; the offline
copy is a cache plus a queue.

Online card-display extensions are negotiated independently of this queue: `coverText=1` opts into text covers and
`includeTags=1` opts into the library-tag mapping catalog. Frozen 1.0.14 clients keep the original response shapes.
Migration 044's `gallery_settings.card_layout` is excluded from snapshots and partition journal records; its API calls
go straight to the server. A running offline session keeps a layout already loaded, while a cold offline session uses
the vertical default. Saved snapshot entries retain their original cover placeholder; pending local works can derive
text covers from their own Content/tags with the shared helper.

Web client (`apps/web/src/offline/`):

| File | Role |
|---|---|
| `offline-library.ts` | derives Gallery/Entry/Author/facet/Collection/usage/View-later DTOs from the active snapshot |
| `offline-api.ts` | the `GalleryApi` facade: snapshot-first reads, offline mutation allowlist, projection, replay planning (~5,400 lines) |
| `offline-sync.ts` | download/install a snapshot, capability/format gating (`SUPPORTED_SNAPSHOT_FORMAT_VERSION = 2`) |
| `snapshot-store.ts` | snapshot state/validation, active-generation pointer moves, in-memory parsed-generation cache |
| `indexeddb-snapshot-store.ts` | the real `t3-offline` IndexedDB database (`DATABASE_VERSION = 3`) |
| `memory-offline-store.ts` | in-memory store for tests |
| `outbox-store.ts` | durable pending-operation envelopes, `opId` identity |
| `media-outbox-store.ts` | staged media uploads (`uploadId`, `entryUid`) |
| `local-final-state.ts` | editable local drafts vs immutable submitted originals |
| `sync-mutation-plan.ts` | ordered native mutation plan |
| `snapshot-delta.ts` | incremental delta request/validation |
| `offline-media.ts`, `offline-media-task.ts`, `cache-names.ts`, `cached-media-response.ts`, `cached-media-object-urls.ts` | media preload, cache sharding, application-level cache path |
| `native-background-transfer.ts` | Android WorkManager handoff |
| `pending-work-export.ts`, `pending-work-restore.ts` | private forensic export and atomic restore |
| `connection-recovery.ts` | failed-probe backoff and reconnect |
| `automatic-sync.ts` | verified-reconnect auto replay + copy update |
| `client-identity.ts`, `native-shell-library-id.ts` | client identity, cached shell libraryId |
| `entry-multi-author.ts`, `collection-common-tag.ts`, `collection-delete.ts`, `random-id.ts` | specific operation helpers |
| `native-shell-service-worker.ts` | retires a stale PWA Service Worker inside the Capacitor shell |

Service Worker: `apps/web/src/sw/service-worker.ts` (`SW_VERSION = 't3-shell-v7'`).

Server: `apps/server/src/sync/` (`sync-service.ts` builds capabilities and the
snapshot; replay/change-feed/receipts). HTTP routes are registered in
`apps/server/src/http/app.ts`:

- `GET /api/sync/capabilities`
- `GET /api/sync/snapshot`
- `POST /api/sync/delta`
- `GET /api/sync/changes`
- `POST /api/sync/ack`
- `POST /api/sync/replay`
- `PUT /api/sync/media/:uploadId`
- pairing: `/api/pairing/claim`, `/status`, `/recover`, `/offer`, `/revoke`, `/forget` (`apps/server/src/http/paired-server.ts`, `secure-pairing.ts`)

Schema lives in `apps/server/src/database/migrations/` (see §2, §3).

---

## 2. Sync identity / epoch / snapshot

### Identity and epoch

- Migration `015_sync_metadata.sql` adds sync identity. The table stays empty at
  migration time: the server **lazily seeds row 1 with a fresh random
  `libraryId`** on first access. **Backup restore rotates `sync_epoch` (never
  `library_id`)**, so change sequences from a restore point can never be
  confused with the live one.
- Capabilities carry `libraryId`, `syncEpoch`, `sqliteSchemaVersion`,
  `snapshotFormatVersion`, `syncProtocolVersion`, `serverBuild` and
  `featureFlags`.
- `SNAPSHOT_FORMAT_VERSION = 2`, `SYNC_PROTOCOL_VERSION = 1`
  (`apps/server/src/sync/sync-service.ts`).

### Snapshot format

Snapshot format v2 includes Entry/Content/Producer and Producer Tag sync
identities, shared rating-layout UUID/version rows, Collection UUID/version
rows, stable Author Directory UUIDs, and an atomic `changeSeq` high-water mark.
The shared parser keeps these additions optional so persisted format-v1/v2
generations remain readable after an app upgrade. Each generation carries a
**checksum**.

### IndexedDB `t3-offline`

Database name `t3-offline`, `DATABASE_VERSION = 3`. Object stores:

- v1 — `snapshotGenerations` and `meta`.
- v2 (C2 infrastructure slice) — adds an independent `outbox` store
  (`keyPath: 'sequence'`, `autoIncrement: true`, unique index on `opId`).
- v3 (C3) — adds `mediaOutbox` (`keyPath: 'uploadId'`, non-unique index
  `entryUid`). The create operation and its cover/preview Blobs are inserted in
  one cross-store transaction.

Snapshot generations and the durable Outbox use separate stores, so snapshot
generation pruning cannot delete queued intent. The v1 upgrade preserves active
snapshot data; snapshot generation pruning and **Clear Offline Library leave
queued operations and staged media untouched**. An upgrade blocked by another T3
tab fails explicitly (`Offline storage upgrade is blocked by another T3 tab`).

### Installing a generation

- `activeGeneration` moves only after **checksum/schema/count validation**. A
  pointer-write failure leaves the previous generation active; old-generation
  cleanup is best-effort.
- The parsed active generation is cached in memory keyed by
  `(revision + activeGeneration)` (see §6, §7); any snapshot write moves one of
  those tiny meta keys, so the cache self-invalidates.
- `READ-08`-class guarantees: a Download/Update checksum/quota/interruption
  failure leaves the old generation usable and Outbox/Blobs unchanged; the
  normal path keeps active + previous; Clear and epoch rotation do not revive
  old tasks.
- **Clear is blocked while edits or media are queued.** An epoch change cannot
  replace the active snapshot while work is pending.
- Multi-instance/multi-tab: an older install must not publish over a newer
  state; an ABA write (same generation/bytes), a device-identity change and an
  epoch replacement all have to lose to the latest enqueue.

### Mismatches

- `library-mismatch` (wrong library) and `epoch-mismatch` (restored DB rotated
  the epoch) fail closed and surface a banner; original work is retained and the
  user is given an action, not silent deletion (`SAFE-04`, `DELTA-08`).
- A queued envelope the running build can no longer express is **marked failed,
  not dropped**, and does not stop unrelated Entries from syncing.

---

## 3. Offline mutation allowlist & operation kinds

Every offline mutation is gated at **enqueue and replay**. Global
`offlineMutations` must be on, plus the specific flag. Flags not listed with a
schema condition are always `true` in a current server.

Capability flags (`apps/server/src/sync/sync-service.ts`,
`buildSyncCapabilities`):

| Flag | Condition |
|---|---|
| `readOnlySnapshot` | always |
| `completeSnapshotDelta` | schema ≥ 31 |
| `offlineMutations` | always |
| `offlineEntryUpdate` | always |
| `offlineEntryDelete` | schema ≥ 16 |
| `offlineEntryMerge` | always |
| `offlineEntryTagLayout` | always |
| `offlinePendingEntryMetadata` | schema ≥ 23 |
| `offlineEntryCreate` | always |
| `offlineEntryNewType` | always |
| `onlineEntryCreateClaim` | schema ≥ 32 |
| `onlineEntryCreateCommand` | schema ≥ 32 |
| `offlineEntryInitialContents` | always |
| `offlineEntryContentAppend` | `OFFLINE_ENTRY_CONTENT_APPEND_ENABLED` (true) |
| `offlineMediaUpload` | always |
| `existingEntryMedia` | always |
| `offlineMediaMultiplePreviews` | always |
| `offlineUsageEvents` | always |
| `offlineEntryViewLater` | always |
| `offlineEntryRating` | always |
| `offlineEntryContents` | always |
| `offlinePendingEntryContents` | schema ≥ 23 |
| `offlineProducerViewLater` | always |
| `offlineProducerRating` | always |
| `offlineEntryDuration` | schema ≥ 38 |
| `offlineRatingSlotDelete` | schema ≥ 39 |
| `offlineProducerProfile` | always |
| `offlineProducerTags` | always |
| `offlineRatingSlotLayout` | always |
| `offlineCollectionProducerMembership` | always |
| `offlineCollectionManagement` | always |
| `offlineCollectionDelete` | schema ≥ 37 |
| `offlineCollectionCommonTag` | schema ≥ 37 |
| `offlineGalleryPartition` | schema ≥ 43 |
| `offlineGalleryPartitionOrigins` | schema ≥ 43 |
| `offlineGalleryOrder` | schema ≥ 37 |
| `offlineAuthorSelfRatings` | schema ≥ 39 |
| `offlineAuthorDirectories` | always |
| `offlineEntryAuthors` | always |
| `offlinePendingEntryAuthors` | schema ≥ 29 |
| `offlinePendingEntryAuthorCreate` | schema ≥ 29 |
| `offlineCrossEntryPendingAuthors` | schema ≥ 33 |
| `offlineAuthorCreate` | schema ≥ 29 |
| `offlineEntryMultiAuthorConversion` | schema ≥ 43 |
| `offlineStandaloneAuthorCreate` | schema ≥ 33 |
| `offlineStandaloneAuthorDirectorySeed` | schema ≥ 42 |
| `offlineAuthorDelete` | schema ≥ 33 |
| `offlineEntryTags` | schema ≥ 30 |
| `offlinePendingEntryTags` | schema ≥ 30 |
| `offlineEntryTagVocabulary` | schema ≥ 34 |
| `offlineEntryMediaOrder` | schema ≥ 36 |
| `offlineEntryFacetCreate` | schema ≥ 34 |
| `offlinePendingEntryTagCreation` | schema ≥ 34 |

`POST /api/sync/replay` accepts strict operation kinds (shared schema
`packages/shared/src/schemas/sync.ts`):

`entry.update`, `entry.create`, `entry.delete`, `entry.merge`,
`entry.usage`, `entry.view-later.set`, `entry.rating.set`,
`entry.contents.set`, `entry.content.append`, `entry.tags.set`,
`entry.authors.set`, `entry.authors.convert-to-multi`,
`entry.author.create-and-link`, `entry.tag.create`, `entry.facet.create`,
`entry.tag-layout.set`, `entry.tag-layout.apply`, `entry.layout-template.apply`,
`entry.media.set`, `producer.create`, `producer.delete`,
`producer.view-later.set`, `producer.rating.set`, `producer.update`,
`producer.tags.set`, `rating-layout.slots.set`, `author.directories.set`,
`collection.create`, `collection.update`, `collection.entry.set`,
`collection.producer.set`, `collection.order.set`, `collection.delete`,
`collection.common-tag.add`.

The mutation allowlist proper (what an ordinary page may do offline): Entry
title/date/page-count edits (never `Entry.type`), View/Like events, Entry and
Producer View later desired-state changes, edits to existing Entry and Author
rating values, shared Entry/Author rating-slot creation and ordering, Author
Collection membership, Author Directory metadata/membership, and the bounded
manual Entry composer create flow. **Collection management requires both the
global `offlineMutations` flag and its own `offlineCollectionManagement` flag.**

Every other mutation fails closed online. Explicitly online-only (do not queue):
destructive Entry/Author/Collection/Directory delete and merge, taxonomy
rename/Entry-type creation, complex templates/layout beyond the listed layout
ops, new Gallery/type remainder, Import/Source-maintenance batches, and
existing-media replacement (see §10).

---

## 4. Pending-work model (outbox, children, causal ordering, cleanup)

### Envelope

Pending operation envelopes carry a client-generated stable `opId`, client/
library/epoch identity, entity identity and operation kind,
`baseVersion`/`baseValues`, JSON payload and client creation time. The store
assigns a separate auto-increment insertion sequence, so **replay order does not
depend on clock precision**. Retrying an identical `opId` is a local no-op;
reusing it with different content fails closed.

`baseVersion`/`baseValues` are the optimistic revision/value the edit was
predicated on. Positive-version operations advance the owning resource
revision; zero-version child operations (`entry.create`, `entry.content.append`,
`entry.tags.set`, `entry.authors.set`, `entry.author.create-and-link`,
`entry.update` on a pending Entry) carry `baseVersion: 0` and an explicit
immutable create parent (`parentCreateOpId`).

### Children and causal ordering

- Replay preserves order per Entry while **allowing independent Entries past a
  blocked one**. Same owner's successors pause; independent owners progress
  (`EDIT-08`, `BG-07`).
- The online composer still creates the Entry before separately uploading media
  and Content; a later online failure closes the already-committed create form
  and reports the created Entry ID rather than inviting a duplicate submit.
- Pending creates are exposed to global title search through a separate local
  projection and render as non-clickable “Pending sync” cards; they **never
  receive a fake numeric ID**. The offline composer only accepts a Gallery
  already present in the installed snapshot and does not invent a numeric route
  for the temporary `local:<uuid>` identity.
- Pending scalar metadata editing uses immutable zero-version `entry.update`
  children; captured key comparison excludes the parent identity, and cleanup
  verifies the last applied desired value per field.
- Delete and membership ordering: an Entry Collection move queues the
  destination add before the source remove; Entry membership dependencies block
  the removal if the add conflicts (`EDIT-08`).
- A blocked Author, Tag or Content child locks all related editing for that
  Entry (Search shows each child's persisted status/reason).

### Status counts and banner

Pending / conflict / failed status persists. The three counts are **disjoint**
(every non-zero category renders together); a failed op is never counted as
pending, and an automatic conflict is never disguised as resolved. The banner's
discard action removes each blocked conflict/failed edit **and every later
queued operation for that same Entry** in one IndexedDB transaction, because
those intents carry base values and predicted revisions derived from the
blocker. Earlier receipt retries and unrelated Entries remain queued.

### Cleanup — belongs to the commit, not the queue

Applied rows and Blobs are removed locally **only after a newer authoritative
snapshot covers the largest acknowledged server sequence** (`changeSeq` covers
every acknowledged `serverSeq`); refresh or freshness failure retains those
operations for exact retry. In other words, cleanup is tied to the commit
(verified covering snapshot / durable ACK), not to the enqueue.

- Receipt retries and unrelated Entries remain queued until covered.
- Atomic Outbox cleanup **retains creates with uncovered children** using the
  current rows; a dependent enqueue validates its parent in the same write
  transaction.
- Final snapshot verification folds applied create/append/set operations in
  order so intentionally removed historical appends do not strand the queue,
  while later appends are still checked.
- A covering snapshot that includes the exact Content/Tag/Author UID and Entry
  owner is required; missing identity keeps the op for an exact retry.

### Local final state (editable drafts vs immutable submissions)

`local-final-state.ts` (added 2026-10-12) stores the **earliest baseline and the
current desired result** in the existing IndexedDB metadata store:

- Compatible unsubmitted scalar/set operations coalesce; fresh Entry scalar
  edits fold into the create; reverted drafts and unused derived Tags cancel;
  only local draft revisions are rebased after reduction.
- Dependencies remain ordering boundaries; **submitted, imported and legacy
  envelopes are never inferred editable**. A submitted/uncertain/legacy command
  keeps its original; later edits are saved as a local result and compiled into
  a successor request only once the receipt and the acknowledged baseline exist.
  A queued rating is also an observation of its slot: later layout edits cannot
  merge the slot creator past that rating, preserving export/restore order.
  Facet creation likewise preserves the preceding tag-layout edit and its
  version boundary. Coalescing a fresh Gallery layout retains its `entryType`
  so the first replay can materialize the layout owner.
- Media additions, replacement, deletion and order save a persistent local
  selection on both saved and locally-created Entries. Unsubmitted,
  unobserved images can be removed without upload. Attempted/mirrored originals
  retain UUID/bytes and a later selection is compiled only after verified
  receipts and an acknowledged baseline.
  Selection writes compare the captured local revision atomically, including
  an explicitly absent intent, so hashing an image cannot overwrite a newer
  selection. Cold projection resolves stable image keys through staged bytes
  or persisted upload receipts; renamed paths require the matching installed,
  receipt-verified snapshot. Subsequent edits use the same key mapping.
- Fresh unobserved Entries can cancel with their staged bytes;
  uncertain/dependent creates retain their originals and record local deletion
  for subsequent settlement. No ordinary media-deletion gate depends on a
  server row or pending cover.
  Once a saved work has a local deletion intent, new edits and media changes
  touching it are rejected inside the same storage transaction; the deletion
  and its predecessor requests remain unchanged.
- Foreground replay freezes a capture; Android mirroring freezes bodies at
  background handoff rather than on every foreground gesture. Deferred media is
  excluded from native delivery until its canonical preconditions exist.
- Pending export/restore includes final selections and deletion intents;
  restored deferred bytes get fresh UUIDs, original request bodies remain
  unchanged, and Clear/library replacement cannot erase unsynced intents.
  Unchanged Blobs are not rewritten for scalar edits.
- Competing local `entry.create` writes for the same
  library/epoch/UID are rejected atomically in that IndexedDB transaction; the
  completion of the Outbox+media transaction is the offline create's **commit
  boundary** — a later failed pending-state refresh leaves the draft reported as
  saved with a visible warning (v30).

The focused validation family `apps/web/tests/offline-local-final-state.integration.test.ts`
is 20/20, using isolated SQL, temporary assets, fake IndexedDB, a memory adapter
and a native-bridge mock.

On 2026-10-17 the existing-entry media vertical, offline tag-layout and local
final-state regression files passed **54/54** cases, including concurrent hashing,
cold media paths, uncertain ACKs, first-layout creation and Facet ordering. These
checks used isolated SQL and temporary assets with memory/IndexedDB adapters.

---

## 5. Media / asset pipeline

### Server-side media replay

- Migration `022_sync_media_receipts.sql`: durable media upload receipts (media
  bytes stay filesystem-backed) so a lost HTTP response can be retried without
  appending or replacing media twice.
- Migration `023_sync_offline_created_entries.sql`: records which Entry UUIDs
  came from a successful offline `entry.create` replay, so the media endpoint
  **cannot mutate existing online Entries**. Media staging is intentionally
  limited to offline-created Entries.
- `PUT /api/sync/media/:uploadId` rejects existing online Entries, validates the
  actual SHA-256, MIME and image dimensions, promotes one deterministic file
  plus thumbnail, and updates the Entry reference together with the upload
  receipt — in one transaction. An exact upload retry returns the stored result;
  another request body under the same ID, or an attempt to replace an occupied
  media slot, fails closed.
- v31 `offlineMediaMultiplePreviews`: the composer stages its complete ordered
  Preview selection in the same Outbox+Blob transaction. **Cover is ordinal
  zero**; Previews append only at the next ordinal, with independent filenames
  and thumbnails. Replay explicitly sorts media by Entry, kind and ordinal
  rather than relying on IndexedDB's upload-ID key order. Missing/downgraded
  capability retains the whole multi-Preview create and its Blobs without
  sending a partial group. Metadata replay runs before dependent media; neither
  operation IDs nor upload IDs change after a lost response.
- A hard Preview failure leaves later ordinals pending; explicit discard removes
  that failed Preview and its dependent later ordinals, **not earlier Previews
  or an independent cover**.
- v32 carries the manual composer's Source URL as the first initial `Source URL`
  Content, followed by explicitly entered initial rows, matching the online
  creation order; an older server refuses the whole Content-bearing draft.
- **Occupied-cover replacement** (v49 lane 10): staged cover uploads may declare
  `replace: true`. The server media replay accepts the swap only while the
  frozen `expectedCoverRef` still matches; otherwise the row fails visibly
  instead of sticking. Single-step direct cover swap is interface-only today —
  the UI gesture is delete-then-add.

### Positional media identity & refresh

Media addresses are **positional** (cover, preview-0, preview-1 …). Two
consequences that govern behaviour:

- The media preload must re-check **each ref**; it skips a resolver only when
  both its cached redirect and immutable target exist, and revalidates new or
  `updatedAt`-changed Entry media. A per-ref revision in the snapshot would let
  it skip unchanged refs, but that is an **open question**, not done.
- Consecutive deletions: the server renumbers surviving positional refs, so a
  local second base that used the old refs would falsely conflict. Successor
  deletion envelopes predict the predecessor's server positional renames while
  the local projection preserves original cached picture identity.

### CacheStorage write cost scales with the bucket

Measured on the phone's own WebView: a CacheStorage `put` cost **4–15 ms** in a
bucket of up to 4,000 entries (105 MB) and **10.2–12.7 s** in the one holding
11,007 entries (195 MB); per-entry `delete` was just as slow; a keyed `match`
stayed at 1 ms in every size. Filling a library through one bucket crawled at
~4 images/minute (~1.6 images/minute measured).

`offline/cache-names.ts`: media addresses are hashed by **FNV-1a** into **256**
buckets (`t3-offline-media-v1-s<n>`); the pre-shard bucket `t3-offline-media-v1`
stays readable. Read order for an address is its bucket then the pre-shard
bucket, so pre-change media is not re-downloaded. `allOfflineMediaCacheNames()`
covers every bucket for Clear.

`offline-media.ts`: one-time `reshardLegacyMediaCache` **copies** legacy-bucket
entries into their address buckets (copies bytes, never re-downloads), then
deletes the old bucket; it runs at the start of `startMediaPreload`, so an
installed copy self-upgrades on next launch. On-device the migration moved
11,056 entries in ~2.5 minutes with zero re-downloads. Download rate went
1.6 → 35 (sharding) → **147 images/minute** (2,160 entries in 293 s ≈ 0.4 s/image
= the measured fetch floor). Read/write cost, migration and legacy fallback are
pinned by `apps/web/tests/offline-media-cache-shards.test.ts` (15 tests).

`offline-media-task.ts`: the walking `isCurrent` guard compares the tiny
`activeGeneration` pointer instead of rebuilding the snapshot
(`readActiveSnapshot` → `captureSnapshot` re-parsed the whole ~9.9 MB library per
media ref — the idle burn at the start of each run).

### Service Worker rules

`apps/web/src/sw/service-worker.ts` (`t3-shell-v7`) owns **transport only**; the
business snapshot never lives in the shell cache.

- The build injects the generated hashed JS/CSS URLs into the install precache;
  shell resources cache under their own keys.
- Navigation uses `/index.html` as its fallback **without overwriting that key
  with manifest responses**.
- Mutable thumbnail resolvers are **network-first**; immutable thumbnail files
  are **cache-first**; hashed build assets are cache-first.
- `networkFirst` serves cached resolver and managed-asset responses when the
  server answers **HTTP 502/503/504** (desktop-service unavailability) while
  preserving authoritative 4xx responses.
- The SW recognizes all managed `/api/assets/` routes, including Producer
  artwork.
- Mutations and business snapshots are never put in the SW shell cache.

### Application-level media cache path

Because manual testing still showed missing covers despite a complete media
cache and the transport fallback, read-only media components also resolve cached
media **before** a network request: a cached thumbnail redirect from Cache
Storage, its immutable response, and a blob URL. The lookup begins **before
viewport intersection**, so a page's local thumbnails are prepared in parallel
instead of waiting for serial network errors. A reference-counted **256-entry
session LRU** reuses both the object URL and successful-load state across
component remounts; Update and Clear invalidate the registry so changed or
deleted media cannot remain visible. This covers Gallery, Search, Author, View
Later, Collection compositions and Entry detail without depending on the current
page being SW-controlled.

### Thumbnails

Managed Entry media on card-sized surfaces goes through `entryCardMediaRef`:
`/api/thumbnails/...` resolves to a source-hash-addressed **512px WebP** with
immutable caching; a not-yet-backfilled source redirects safely to the original.
Entry detail media deliberately bypasses this helper and retains the original.
New uploads generate thumbnails immediately; `pnpm media:thumbnails` is the
resumable existing-assets backfill. Thumbnails are derived files under each
Entry's asset directory, **not database state**. A thumbnail alias is not proof
of a verified original; stale-generation tasks stop before publishing subsequent
cache aliases, but cross-tab writes have no atomic Clear fence.

### Background transfer

Foreground media preload saves the chosen mode (metadata only, thumbnails, or
explicit originals) and retries missing bytes on next launch or after a verified
foreground reconnect; **a killed process does not keep transferring in the OS
background**. A changed saved choice queues its new foreground task after an
obsolete in-flight task settles. Android's private WebView library is excluded
from automatic OS backup/device transfer in the v24 shell build.

---

## 6. Conflict / idempotency / replay rules

### Journal foundation

Migration `016_sync_foundation.sql` is the C2 server foundation: Entries and
Entry Contents receive immutable UUID transport identities (`sync_uid`) and
monotonic resource versions. SQLite triggers journal their create/update/delete
lifecycle in `sync_changes` and retain deletion cursors in `sync_tombstones`;
because triggers participate in the caller's transaction, **failed mutations
cannot leave ghost journal records**. `sync_operation_receipts` is the durable
idempotency store. Existing rows are backfilled before triggers are installed,
preserving business data without inventing historical changes. Database Doctor
checks the new identities and unique indexes.

Journal-adding migrations afterwards (each preserves prior sequences,
tombstones and FK relationships):

| Migration | Adds |
|---|---|
| `015_sync_metadata` | library/epoch identity |
| `016_sync_foundation` | Entry/Content sync UIDs, versions, `sync_changes`/`sync_tombstones`, `sync_operation_receipts`, Doctor checks |
| `022_sync_media_receipts` | durable media upload receipts |
| `023_sync_offline_created_entries` | origin registry: offline-created Entries only, for media staging |
| `024_rating_slot_sync_identity` | permanent `sync_uid` per rating slot (numeric `slotId` stays local DB identity, never the offline op identity) |
| `025_producer_view_later_sync` | Producer immutable transport identity + revision; expands journal entity allowlist |
| `026_producer_rating_sync` | Producer rating values share the Producer revision (DB trigger) |
| `027_producer_tags_sync` | shared Producer-tag vocabulary stable offline identities |
| `028_author_resource_sync` | Collection + shared rating-layout resources, stable Directory UIDs, Producer revision journaling for directory metadata/membership; expands journal kinds |
| `029_entry_author_links_sync` | journals every `entry_producers` insert/delete as an Entry revision |
| `030_entry_tags_sync` | journals every `entry_tags` insert/update/delete on the owning Entry version chain; gates `offlineEntryTags` |
| `031_sync_change_feed_ack` | paged identity/epoch/protocol-bound change-feed, tombstones, persisted bounded served/ack cursor (see §9) |
| `032_online_entry_create_claims` | client-assigned online Entry UID must prove its original create request before offline replay can adopt it |
| `033_offline_producer_origins` | causal identity registry; receipts contain numeric results, not entity kinds; Producer creation identity (origin op/client/library/epoch, canonical UID/numeric identity, applied receipt opId) |
| `034_offline_entry_tag_vocabulary` | stable Entry Tag/Section/Facet transport identity + shared per-type layout revision |
| `035_entry_vocabulary_plural_origins` | distinct immutable creation envelopes may converge on one canonical entity; keeps creation UUID/op identity and scope |
| `036_gallery_order` | versioned library-wide Gallery order scope (sparse, per type) |
| `037_gallery_order_sync` | independent library-wide Gallery order revision; preserves journal high-water mark |
| `038_entry_duration` | Entry `duration_seconds` (peer of `page_count`) |
| `039_rating_classes_and_author_anchor` | three rating classes + stored Author Gallery anchor |
| `040_entry_rating_layout_triggers` | restores two `entries` triggers dropped/renamed around 039 |
| `041_works_summary_follows_gallery` | brings existing Galleries' works summary in step with work dimensions |
| `042_standalone_author_directory_seed` | standalone creates may pre-supply an independent Directory-set identity |
| `043_gallery_partition_sync` | dedicated per-type partition overlay revision (Gallery stays derived from `entries.type`) |

### Replay transaction

Receipt lookup/hash validation, base-value conflict checks, the owning mutation,
trigger-maintained journal write and receipt insert **share one SQLite
transaction**. An exact retry returns the stored result; an `opId` collision or
a stale edited field fails closed.

- `entry.create`: the client-generated Entry UUID is permanent, `baseVersion` is
  zero, SQLite creates the numeric ID. Metadata, optional initial Content rows
  with stable UUIDs, selected ratings and initial View Later membership commit
  with the receipt in one transaction. Content-bearing creates require the
  refreshed server's `offlineEntryInitialContents` at queue and replay time; old
  create envelopes without Content remain valid. **The server never
  deduplicates by title.**
- `entry.content.append` (v26) is a distinct immutable op keyed to the original
  create op ID and permanent Entry UUID (`baseVersion: 0`, one new Content
  UUID/type/text); it does not rewrite the create or perform a pre-authoritative
  whole-list replace. Gated by `offlineMutations` + `offlineEntryContentAppend`.
- `entry.tags.set` (v35) is a desired-set op with `baseVersion: 0` and
  `parentCreateOpId`; only existing canonical Tags and same-Gallery Facets from
  the installed snapshot. Requires `offlineMutations`, `offlineEntryTags`,
  `offlinePendingEntryTags`.
- `entry.authors.set` (v36) links/removes existing Authors with
  `baseVersion: 0` and `parentCreateOpId`; requires `offlineMutations`,
  Entry-Author support and `offlinePendingEntryAuthors`. Whole-set refusal of
  unknown/deleted Authors.
- `entry.author.create-and-link` (zero-version, explicit create parent): one
  Entry-owned operation with a client-generated stable Producer UID, optimistic
  Entry base values, alias/name collision checks, atomic Producer/link/receipt
  insertion and an offline negative-ID projection. Requires schema 29 and the
  global / Author-create / Entry-Author / pending-Author / pending-new-Author
  conjunction. Cross-Entry links to a still-pending Author use optional
  `producerCreates` dependencies on `entry.authors.set`; migration 033 stores
  Producer creation identity so validation checks origin op/client/library/epoch,
  canonical UID/numeric identity and applied receipt opId — **not numeric
  coincidence**.
- `entry.contents.set`: capability-gated full ordered-list desired state keyed
  by the owning Entry UID. Snapshot Content UUIDs preserve row identity; new
  rows get client UUIDs and temporary client-local IDs until a refreshed
  snapshot supplies server IDs. One atomic replay can add/edit/delete/reorder;
  it compares the complete base list even when the Entry revision is unchanged,
  so concurrent online Content edits conflict rather than being silently
  overwritten. A convergent list consumes one predicted Entry revision so later
  queued operations stay causally ordered. `offlineEntryContents` gates queueing
  and diagnostics; no migration (016 already assigns Content sync UIDs).
- `entry.rating.set { slotUid, stars }`: `stars` is a final nullable half-step
  value, not a delta. Migration 024 gives every slot a permanent `sync_uid`.
  Rating ops share the owning Entry revision chain with scalar edits, usage and
  View Later. Replay treats an already-matching value as convergent,
  auto-merges across unrelated Entry revision changes when the slot value still
  matches `baseValues`, and emits a visible conflict when that value changed. A
  removed or wrong-Gallery slot becomes an explicit `invalid-rating` failure
  rather than a guessed write. `offlineEntryRating` gates queueing.
- `entry.usage` / `entry.view-later.set`: offline View and Like are **unique
  events** — the stable operation ID is the event identity, so a lost response
  can never increment an aggregate twice. Entry View later is an explicit
  `{ present: boolean }` desired state, never a toggle. Consecutive add/remove
  predict the shared Entry revision in insertion order, project membership
  locally, and converge without reversing state on retry.
- `producer.*`, `rating-layout.slots.set`, `collection.*`,
  `author.directories.set`: Producer, Directory-set, Collection and
  rating-layout operations each have their own owner chains. Producer
  profile/tag/rating share one offline edit block. Migration 028 gives
  rating-layout/Collection stable identity/version boundaries and a stable
  Author Directory-set UUID/version independent of the Producer profile. The
  Directory-set revision covers all Directory metadata and Entry membership as
  one aggregate so moves commit atomically. Collection management (including one
  nested Entry-folder level) and complete top-level sibling reorders
  (`collection.order.set` compare-and-swaps the whole UID/order/revision vector).

### Online create claim (schema 32)

- Each online POST gets a client Entry UUID carried into its transport-failure
  offline fallback. On schema 32 the online create atomically stores the Entry
  and its request fingerprint/version claim; an identical POST retry returns the
  existing ID, but changed metadata returns 409.
- A matching, unconsumed claim lets offline `entry.create` **adopt** the existing
  Entry and add its initial Content, ratings and View Later with the create
  receipt/mapping in one SQLite transaction; unrelated UID collisions or edited
  Entries fail closed (`CREATE-09`).
- The v28+ client probes `onlineEntryCreateClaim` before each online manual
  create: a legacy server receives a no-UID POST, and an uncertain legacy
  response keeps the draft visible **without** an offline fallback. If the probe
  itself fails before any POST, the ordinary offline enqueue may proceed
  (`CREATE-10`).
- A kill before durable enqueue still lacks a persistent shared intent; v29
  retains the same Entry UID across retries while the original composer stays
  open even if Outbox persistence failed, and blocks a no-UID retry if that
  server downgraded. Reopening the composer starts a new intent
  (`CREATE-11`).

### Conflict, convergence and fail-alone

- A same-field desktop peer update produces a **visible conflict** (which Entry,
  which field); a different field merges. Membership as desired state is
  idempotent; a rating version conflict is never a silent overwrite (`SAFE-01`).
- `resnapshot-required` / `library-mismatch` / `epoch-mismatch` retain work and
  require a fresh authoritative snapshot.
- **A refused item must fail alone.** A *server-answered* refusal (any status
  code) marks that one row failed and the drain continues; only a transport
  failure aborts the pass. The server classifies an undecodable image as 400
  (not 500), and an in-use Facet as a conflict receipt. The client no longer
  lets one rejected media upload interrupt the entire replay (previously: pending
  8, failed 0, and the good cover never even attempted, because media sorts by
  `entryUid` and the rejected row blocked the queue).
- Idempotency: same `opId`/`uploadUUID` same body returns the original receipt;
  different body is refused (`SAFE-03`). An untrusted / extra-field / wrong-opId
  native receipt does not release successors (`SAFE-05`); raw JSON retention is
  not canonical-cleanup proof.

---

## 7. Read fallback & projection

`apps/web/src/offline/offline-library.ts` derives Gallery, Entry, Author, facet,
Collection, usage and View-later DTOs from the active snapshot. The online
Gallery API remains authoritative; the offline repository engages when supported
core reads fail, and a visible banner (“Viewing the saved offline copy…” /
`正在查看离线副本…`) marks the fallback.

- C1.1 keeps supported reads **snapshot-first after the first transport
  failure**, caches the parsed active generation in memory, and returns to
  online-first after a successful sync-capability or snapshot request.
- **Offline reads must not queue behind the capability probe.** The old
  `PairedTransportPlugin.status` ran on the same single native thread, so an
  offline read could wait for the probe's 8 s connection timeout; measured
  open-entry 7674 ms while the probe was in flight vs 313–543 ms without it. v40
  moved `status` to an independent single-thread executor (same scenario
  253 ms) and shortened the probe connection timeout 8 s → 2 s. Offline reads
  also stopped asking native for `libraryId` on every read (measured 6 calls per
  read) via a cached `createShellLibraryIdSource`, invalidated on
  focus/online/visible.
- The offline wrapper is typed as `GalleryApi` and spreads the online
  implementation, but individual overrides **silently narrow the accepted
  signature** (they take only the parameters they use). A caller option that the
  offline branch does not accept is dropped rather than rejected — treat
  omitted-parameter behaviour as intentional, not as honoring the option.
- C1.1 added snapshot adapters for Author pages and filters, Author View Later,
  Random Authors/Tags, Tag search, producer Collections, taxonomy aliases and
  author-scoped Entry filters. Collection projection reapplies the
  whole-Gallery hideable boundary; offline-created top-level Entry Collections retain
  the Gallery type supplied by their page, and a nested folder inherits its
  parent's Gallery type.
- Offline-created Collections retain deterministic, presentation-only
  **negative IDs** across restarts and partial replay. While their create op is
  queued, related edits stay in the Outbox even after a capability probe
  switches reads online. After an authoritative snapshot covers the replay
  receipt, the facade resolves their stable UUID to the server ID and notifies an
  open Collections page to refresh its active selection. The hideable display filter
  never narrows the full top-level Collection order vector sent to the server, so
  siblings hidden by that boundary keep their place when visible siblings move.
- The offline composer's `local:<uuid>` identity never gets a fake numeric
  route; pending creates render as non-clickable “Pending sync” cards.
- `v33` exposes the persisted create-operation reason in the local pending Entry
  DTO and distinguishes failed/conflict cards from ordinary Pending sync;
  `v34` extends the pending-card read model to later Content-append operations —
  read-model/UI status reporting only, not new retry/conflict-resolution/media
  semantics.

### Connection recovery

`offline/connection-recovery.ts` retries a **failed** probe with a short backoff
(500 ms → 1 s → 2 s → 4 s, then stays at the cap; the slow offline poll remains
as a safety net). A success resets the backoff, and a retry that fires while the
previous request is still settling reschedules itself. Measured: a page went
offline 5.3 s after the server was killed and, before this change, could only
look again on the 15 s offline poll (up to 15 s recovery); after the change it
recovered **771 ms** after the server answered. A successful capability response
is the only authority for coming back online; a stalled native request may take
much longer to reject, so the code warns promptly but does not stack more native
probes until the original settles.

`offline/automatic-sync.ts` (r22): a verified reconnect coalesces into
**automatic local replay first, then updating the existing saved copy**. The
first download remains explicit/user-directed. Failed updates stay due and retry
on the next successful heartbeat; idle heartbeats do not re-download. Progress/
error banners contain information only and disappear on success. The offline
update is already incremental (delta, no re-download); the pass a user watches
is the media preload, which must re-check each ref (see §5).

---

## 8. Settings / System page / diagnostics

### Offline library settings

Settings exposes an explicit **Download/Update offline-library** action. It
requests `media=thumbnails`, installs the metadata generation, and best-effort
prefetches the deterministic media manifest into the durable media cache. Media
modes: metadata only, thumbnails, or explicit originals (selected originals are
saved across restarts; a thumbnail alias is not proof of a verified original).
Settings reports processed/total progress so metadata readiness is not mistaken
for media completion.

As of r22, Sync now, pending-work export/restore and manual
support/persistence/native-resume controls are **removed** from the settings UI;
support and storage checks run automatically, and diagnostics/copy plus
blocked-edit review live at the bottom of Offline library. Reports include full
cached capability flags, snapshot header/ACK, local intentions, media/outbox
errors, native transfer status and storage/cache information.

The offline library was moved out of quick settings into the Advanced-function /
Advanced-editing page. `OfflineLibrarySettings.vue` is the surface.

- Storage: an explicit storage estimate and `persist()` request; clearing is
  blocked while edits or media are queued. Storage pressure never auto-deletes
  Outbox/Blob (`PRIV-01`).
- Foreground-only: a killed process does not keep transferring in the OS
  background; preload is resumable but a KILL/force-stop does not continue
  (BG-05/BG-06 — no boot receiver, no resident foreground service).

### Desktop System page

`apps/server/src/http/system-routes.ts` (registered from `app.ts`; option
`systemLogPath`) adds:

- `GET /api/system/diagnostics` — tail of the launcher's own log file, plus
  paths, backup count, settings and any staged restore.
- `GET/PUT /api/system/settings`.
- `GET/POST /api/system/backups`; `GET/DELETE /api/system/backups/:name` (a
  backup downloads as the database file itself).
- `POST /api/system/restore`.

Backups use better-sqlite3's online `backup()`, so the app keeps serving while
one is taken. A restore is **staged, not swapped**: the live database is open,
and replacing its file underneath — with a stale WAL beside it — is how a
library gets corrupted. The upload is validated read-only as a real T³ library,
kept in `<dataDir>/restore-staged/`, and applied by `applyStagedRestore` at the
next start **before** the database is opened, which first copies the library it
replaces into `backups/`. The page therefore says “close the desktop from the
tray and open it again” and never claims the library is already restored.

`autoAllowMobileConnection` lives in `<dataDir>/t3-settings.json` (default on,
written atomically, unreadable file falls back to the default) because the
**launcher** must read it before the server exists:
`LauncherPolicy.AutoAllowMobileConnection` / `SystemSettingsPath` and
`ApplyServerEnvironment(..., autoAllowMobileConnection)` skip the pairing
advertisement when off, and `server-cli.ts` refuses the secure listener for the
same setting.

Web: the System tab is last in `AdvancedEditingPage.vue` and talks to
`/api/system/*` directly through `system-api.ts` rather than through
`GalleryApi`, so the library interface and its offline facade stay untouched.
`client-errors.ts` (installed from `main.ts`) keeps the last **40** uncaught
errors, rejections and `console.error`s, and the page shows the server log,
those client errors and the page's own facts as one copyable report. The tab row
is `overflow-x: auto` with `min-width: 0` and non-shrinking buttons; title
shortening is now a `.advanced-subcard` inside the Templates card (its
`data-testid="advanced-titles"` kept, its tab removed).

Diagnostics-facing principle: **Report a failure where the action is.** When an
offline gesture is refused, the refusal is shown against that gesture with an
actionable reason (e.g. v49 r19 answers with a code —
`no-server-row` / `upload-uncertain` / `cover-not-uploaded` / `native-uncertain`
— and the page owns the wording), not only in a distant diagnostics dump.

### Export / restore

A private forensic JSON export of queued edits/media is capped at **64 MiB** with
**no automatic import**; the serialized pending-work file limit is 96 MiB and the
decoded-media aggregate limit is 64 MiB. Restore entry is preview → explicit
confirm; no automatic network replay. Same client/library/epoch only; a package
with an incomplete original creation parent fails closed (file receipt / numeric
ID / UUID coincidence cannot prove identity). Repeated import is idempotent and
does not reset live rows' status/attempt/receipt/lease. A whole-package restore
keeps UUIDs, original envelope/body hash, Blob bytes and upload preconditions/
dependency order unchanged across cold reopen.

---

## 9. Change feed (server) — status

Migration `031_sync_change_feed_ack.sql` adds a paged, identity/epoch/protocol-
bound server change-feed, tombstones, and a persisted bounded served/ack cursor.
A served bound is recorded before acknowledging; journal entries and tombstones
are **never pruned by acknowledgement**.

The Web API layer can request and validate a page but **deliberately does not apply it or send an
ack**: not all snapshot entities have complete journal records (some are null/partial), so an empty
feed does not establish that a full snapshot is unchanged. Offline Update therefore verifies and
installs an authoritative full snapshot.

`DELTA-01`-class contract: the current server advertises a real
`completeSnapshotDelta`; the first Download is full, later Updates delta with no
injected flag. An explicit unavailable (server restart / session expiry /
baseline eviction) falls back to a verified full snapshot; drop / reorder /
corrupt pages / scope mismatch are refused, never silently masked. The durable
shared client UUID is stable across Update/replay/cold start; media mode
none/thumbnails is exact; the journal cursor is never used as `snapshotSeq`.

### r25 settlement fixes (2026-10-12, device-verified)

USB testing exposed three settlement defects, all now fixed:

1. Full snapshot fallback lacked a reacquired durable ACK for
   `entry.tag-layout.apply`; replay now reacquires ACK for **every kind**.
2. Older accepted cover uploads were incorrectly required to survive later cover
   replacements; accepted cover/order successors are evaluated by **receipt
   sequence**.
3. The desktop delta cache evicted all baselines before any sessions, so a full
   cache could immediately evict a newly fetched recovery baseline; server cache
   eviction now compares age across sessions and baselines.

On-device, existing phone work settled **12 → 0**, operations/media/local media
and deletion intents all zero, no conflicts/failures/errors; real Wi-Fi
disconnect/reconnect drove offline → syncing → updating → online, advanced saved
generations 29 → 31, and removed the banner; a 12-second idle observation kept
generation/update time unchanged.

---

## 10. Scope boundaries (by design)

These are deliberate boundaries of the offline model, not missing coverage:

- **Existing-media replacement is online-only.** Empty-cover fill and preview append are not
  replacement. The v49 lane-10 staged `replace: true` cover swap exists at the interface/planner
  level; the UI gesture is delete-then-add.
- **Destructive and bulk operations are online-only**: destructive
  Entry/Author/Collection/Directory delete, merge (except the bounded offline merge op), taxonomy,
  complex templates/layout beyond the listed layout ops, new Gallery/type remainder, and
  Import/Source-maintenance batches.
- **Conflict handling is visible, not auto-merged**: a per-field "keep local / re-baseline" editor
  is not part of the model; the user sees the conflict with keep-original-work and explicit discard.
- **The client is the native APK.** A pure-browser trusted-HTTPS PWA is not a required second
  client.
- **No boot auto-start, resident foreground service, infinite background survival, or
  post-force-stop execution.** The finite WorkManager extension does not introduce them.

### Evidence locations

- `apps/web/tests/*.integration.test.ts` — offline integration families
  (local-final-state 20/20, compound-tag-layout 11/11, media-cache-shards 15,
  pending-work-restore, etc.).
- `apps/server/src/database/probe.ts` (`db:probe`) and `db:doctor` validate the
  sync identities/receipts/journal when the v16+ columns are present.
- `.hermes/artifacts/` — per-slice implementation/verification JSON (release
  evidence, not proof of evolving source).
