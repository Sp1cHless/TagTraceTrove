import type { GalleryApi } from '../api/gallery.js';
import type { OfflineApiState } from './offline-api.js';
import { downloadOfflineSnapshot } from './offline-sync.js';
import { readSnapshotMediaMode } from './client-identity.js';
import { readActiveSnapshot, type SnapshotStore } from './snapshot-store.js';
import { startMediaPreload } from './offline-media-task.js';

/** Verified reconnection: settle local writes before advancing the saved copy.
 * Failed updates stay due and retry on the next successful heartbeat. */
export function createAutomaticOfflineSync(options: {
  api: GalleryApi; store: SnapshotStore; state: OfflineApiState;
}) {
  let running: Promise<void> | null = null;
  let refreshDue = false;
  return (wasOffline: boolean): Promise<void> => {
    refreshDue ||= wasOffline;
    if (running) return running;
    running = (async () => {
      try {
        const hasWork = (options.state.pendingCount ?? 0) > 0;
        if (!refreshDue && !hasWork) return;
        const active = await readActiveSnapshot(options.store);
        options.state.automaticSyncPhase = 'syncing';
        options.state.lastAutomaticSyncError = null;
        await options.api.flushOfflineOutbox?.();
        if (options.state.lastReplayError || (options.state.conflictCount ?? 0) > 0 || (options.state.failedCount ?? 0) > 0) {
          throw new Error(options.state.lastReplayError ?? 'Some local edits need review');
        }
        // First download remains user-directed; a reconnect updates an existing copy only.
        if (!active) { refreshDue = false; return; }
        if (!refreshDue) return;
        options.state.automaticSyncPhase = 'updating';
        const capabilities = await options.api.getSyncCapabilities({ replay: false });
        const result = await downloadOfflineSnapshot({ api: options.api, store: options.store,
          media: await readSnapshotMediaMode(options.store), capabilities });
        if (!result.ok) throw new Error(result.detail);
        refreshDue = false;
        options.state.lastAutomaticSyncAt = new Date().toISOString();
        options.state.offlineCopyRevision = result.active.revision ?? String(result.active.generationId);
        if (typeof globalThis.caches !== 'undefined') {
          void startMediaPreload({ store: options.store, assetUrl: options.api.assetUrl,
            cacheStorage: globalThis.caches }).catch(() => undefined);
        }
      } catch (cause) {
        options.state.lastAutomaticSyncError = cause instanceof Error ? cause.message : String(cause);
      } finally {
        options.state.automaticSyncPhase = null;
      }
    })().finally(() => { running = null; });
    return running;
  };
}
