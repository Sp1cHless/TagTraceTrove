import { fetchSnapshotCandidate, acknowledgeSnapshotCandidate, retryPendingSnapshotAck, type SnapshotDeltaApi } from './snapshot-delta.js';
import type { SyncCapabilities, SyncSnapshot } from '@t3/shared';
import { getClientIdentity, readSnapshotMediaMode, SNAPSHOT_MEDIA_KEY, type SnapshotMediaMode } from './client-identity.js';
import type { OutboxStore } from './outbox-store.js';
import type { MediaOutboxStore } from './media-outbox-store.js';
import {
  ACTIVE_GENERATION_KEY,
  applySnapshot,
  readActiveSnapshot,
  type ActiveSnapshot,
  type ApplyFailure,
  type SnapshotStore,
} from './snapshot-store.js';

const SUPPORTED_SYNC_PROTOCOL_VERSION = 1;
const SUPPORTED_SNAPSHOT_FORMAT_VERSION = 2;

export interface OfflineSyncApi extends SnapshotDeltaApi {
  getSyncCapabilities(): Promise<SyncCapabilities>;
  fetchSyncSnapshot(options?: { media: SnapshotMediaMode }): Promise<SyncSnapshot>;
}

export type OfflineDownloadResult =
  | { ok: true; status: 'updated' | 'resnapshotted'; active: ActiveSnapshot }
  | { ok: false; reason: 'library-mismatch' | 'capability-mismatch' | 'incompatible' | 'pending-work' | 'network' | 'storage' | ApplyFailure['reason']; detail: string };

export interface OfflineDownloadOptions {
  api: OfflineSyncApi;
  store: SnapshotStore;
  media?: SnapshotMediaMode;
  /** An explicit caller probe completed before its own replay/install boundary. */
  capabilities?: SyncCapabilities;
}

async function hasPendingLocalWork(store: SnapshotStore): Promise<boolean> {
  const pendingStore = store as SnapshotStore & Partial<Pick<OutboxStore, 'list'> & Pick<MediaOutboxStore, 'listMedia'>>;
  const [operations, uploads] = await Promise.all([
    pendingStore.list?.() ?? [], pendingStore.listMedia?.() ?? [],
  ]);
  return operations.length > 0 || uploads.length > 0;
}

export async function clearOfflineSnapshot(store: SnapshotStore): Promise<void> {
  if (await hasPendingLocalWork(store)) {
    throw new Error('Cannot clear the offline snapshot while unsynced edits or media are pending');
  }
  if (store.clearSnapshot) return store.clearSnapshot();
  await store.writeMeta(ACTIVE_GENERATION_KEY, '0');
  const generationIds = await store.listGenerationIds();
  await Promise.all(generationIds.map((generationId) => store.deleteGeneration(generationId)));
}

/**
 * Explicit foreground snapshot download. It never mutates server data and it
 * never queues requests in the service worker. An epoch change is an explicit
 * full-resnapshot boundary: the newly verified generation becomes active and
 * every generation from the old timeline is removed in the activation boundary.
 * The v31 journal covers only some snapshot tables and its records are not
 * snapshot-shaped. Never treat an empty feed as a complete update or ack a
 * cursor from that feed. Complete snapshot deltas use a separate frozen,
 * server-owned baseline contract and the same full-candidate verification.
 */
export async function downloadOfflineSnapshot(
  options: OfflineDownloadOptions,
): Promise<OfflineDownloadResult> {
  let activeBefore: ActiveSnapshot | null;
  let expectedRevision: string | undefined;
  try {
    if (options.store.captureSnapshot) { const captured=await options.store.captureSnapshot(); activeBefore=captured.active; expectedRevision=captured.revision; }
    else activeBefore = await readActiveSnapshot(options.store);
  } catch (cause) {
    return { ok: false, reason: 'storage', detail: cause instanceof Error ? cause.message : String(cause) };
  }
  let capabilities: SyncCapabilities;
  try {
    capabilities = options.capabilities ?? await options.api.getSyncCapabilities();
  } catch (cause) {
    return { ok: false, reason: 'network', detail: cause instanceof Error ? cause.message : String(cause) };
  }

  if (
    capabilities.syncProtocolVersion !== SUPPORTED_SYNC_PROTOCOL_VERSION
    || capabilities.snapshotFormatVersion !== SUPPORTED_SNAPSHOT_FORMAT_VERSION
    || capabilities.featureFlags.readOnlySnapshot !== true
  ) {
    return {
      ok: false,
      reason: 'incompatible',
      detail: `protocol ${capabilities.syncProtocolVersion}, snapshot ${capabilities.snapshotFormatVersion}`,
    };
  }
  if (
    activeBefore !== null
    && activeBefore.snapshot.header.libraryId !== capabilities.libraryId
  ) {
    return { ok: false, reason: 'library-mismatch', detail: capabilities.libraryId };
  }

  let incoming: SyncSnapshot;
  let candidate;
  let clientId: string;
  try {
    clientId = await getClientIdentity(options.store);
    const media = options.media ?? await readSnapshotMediaMode(options.store);
    await options.store.writeMeta(SNAPSHOT_MEDIA_KEY, media);
    await retryPendingSnapshotAck(options.api, options.store, capabilities, clientId);
    candidate = options.store.captureSnapshot && options.store.installSnapshot && options.store.compareSnapshotMeta
      ? await fetchSnapshotCandidate(options.api, activeBefore, capabilities, clientId, media)
      : {snapshot: await options.api.fetchSyncSnapshot({media})};
    incoming = candidate.snapshot;
  } catch (cause) {
    return { ok: false, reason: 'network', detail: cause instanceof Error ? cause.message : String(cause) };
  }
  if (
    incoming.header.libraryId !== capabilities.libraryId
    || incoming.header.syncEpoch !== capabilities.syncEpoch
    || incoming.header.snapshotFormatVersion !== capabilities.snapshotFormatVersion
  ) {
    return { ok: false, reason: 'capability-mismatch', detail: 'Snapshot identity changed during download' };
  }

  const epochChanged = activeBefore !== null
    && activeBefore.snapshot.header.syncEpoch !== incoming.header.syncEpoch;
  if (epochChanged) {
    try {
      if (await hasPendingLocalWork(options.store)) {
        return {
          ok: false, reason: 'pending-work',
          detail: 'The server epoch changed while local edits or media are still pending. Preserve and export pending work before replacing this snapshot.',
        };
      }
    } catch (cause) {
      return { ok: false, reason: 'storage', detail: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  let result;
  try {
    result = await applySnapshot(incoming, {
      store: options.store,
      expectedBase: activeBefore,
      expectedClientId: clientId,
      ...(expectedRevision !== undefined ? {expectedRevision} : {}),
      ...(candidate.acknowledgement ? {acknowledgement:candidate.acknowledgement} : {}),
      ...(activeBefore === null ? {} : { currentLibraryId: activeBefore.snapshot.header.libraryId }),
      ...(activeBefore === null || epochChanged ? {} : {
        currentSyncEpoch: activeBefore.snapshot.header.syncEpoch,
        currentSnapshotSeq: activeBefore.snapshot.header.snapshotSeq,
      }),
    });
  } catch (cause) {
    return { ok: false, reason: 'storage', detail: cause instanceof Error ? cause.message : String(cause) };
  }
  if (!result.ok) {
    return { ok: false, reason: result.failure.reason, detail: result.failure.detail };
  }

  let active: ActiveSnapshot | null;
  try {
    active = await readActiveSnapshot(options.store);
  } catch (cause) {
    return { ok: false, reason: 'storage', detail: cause instanceof Error ? cause.message : String(cause) };
  }
  if (active === null) {
    return { ok: false, reason: 'parse', detail: 'Activated snapshot could not be read' };
  }
  try {
    if (candidate) await acknowledgeSnapshotCandidate(options.api, options.store, candidate, result.generationId, result.revision);
  } catch (cause) {
    return {ok:false,reason:'network',detail:`Snapshot installed; acknowledgement is pending. Retry Update. ${cause instanceof Error ? cause.message : String(cause)}`};
  }
  return { ok: true, status: epochChanged ? 'resnapshotted' : 'updated', active };
}
