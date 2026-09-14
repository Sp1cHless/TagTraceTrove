import type { SyncCapabilities, SyncSnapshot } from '@t3/shared';
import {
  ACTIVE_GENERATION_KEY,
  applySnapshot,
  readActiveSnapshot,
  type ActiveSnapshot,
  type ApplyFailure,
  type SnapshotStore,
} from './snapshot-store.js';

const SUPPORTED_SYNC_PROTOCOL_VERSION = 1;
const SUPPORTED_SNAPSHOT_FORMAT_VERSION = 1;

export interface OfflineSyncApi {
  getSyncCapabilities(): Promise<SyncCapabilities>;
  fetchSyncSnapshot(): Promise<SyncSnapshot>;
}

export type OfflineDownloadResult =
  | { ok: true; status: 'updated' | 'resnapshotted'; active: ActiveSnapshot }
  | { ok: false; reason: 'library-mismatch' | 'capability-mismatch' | 'incompatible' | 'network' | 'storage' | ApplyFailure['reason']; detail: string };

export interface OfflineDownloadOptions {
  api: OfflineSyncApi;
  store: SnapshotStore;
}

export async function clearOfflineSnapshot(store: SnapshotStore): Promise<void> {
  await store.writeMeta(ACTIVE_GENERATION_KEY, '0');
  const generationIds = await store.listGenerationIds();
  await Promise.all(generationIds.map((generationId) => store.deleteGeneration(generationId)));
}

/**
 * Explicit foreground snapshot download. It never mutates server data and it
 * never queues requests in the service worker. An epoch change is an explicit
 * full-resnapshot boundary: the newly verified generation becomes active and
 * every generation from the old timeline is removed afterwards.
 */
export async function downloadOfflineSnapshot(
  options: OfflineDownloadOptions,
): Promise<OfflineDownloadResult> {
  let activeBefore: ActiveSnapshot | null;
  try {
    activeBefore = await readActiveSnapshot(options.store);
  } catch (cause) {
    return { ok: false, reason: 'storage', detail: cause instanceof Error ? cause.message : String(cause) };
  }
  let capabilities: SyncCapabilities;
  try {
    capabilities = await options.api.getSyncCapabilities();
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
  try {
    incoming = await options.api.fetchSyncSnapshot();
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
  let result;
  try {
    result = await applySnapshot(incoming, {
      store: options.store,
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

  if (epochChanged) {
    try {
      const generationIds = await options.store.listGenerationIds();
      await Promise.all(generationIds
        .filter((generationId) => generationId !== result.generationId)
        .map((generationId) => options.store.deleteGeneration(generationId)));
    } catch {
      // The new epoch is already active. Old generations are inert and may be
      // cleaned by a later successful download.
    }
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
  return { ok: true, status: epochChanged ? 'resnapshotted' : 'updated', active };
}
