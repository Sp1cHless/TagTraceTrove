import type { SnapshotStore } from './snapshot-store.js';
import { randomUuid } from './random-id.js';
export const CLIENT_ID_KEY = 't3.offline-client-id';
const identities = new WeakMap<SnapshotStore, Promise<string>>();
/** Identity is shared with Update, replay and pending-work restore, not localStorage. */
export function getClientIdentity(store: SnapshotStore, explicit?: string, create = randomUuid): Promise<string> {
  if (explicit !== undefined) {
    const identity = store.writeMeta(CLIENT_ID_KEY, explicit).then(() => explicit);
    identities.set(store, identity); return identity;
  }
  const createIdentity = () => {
    // Read-only, one-time migration of the previous facade identity. Never mint
    // or overwrite a localStorage UUID; IndexedDB is the authority thereafter.
    try { const legacy = globalThis.localStorage?.getItem(CLIENT_ID_KEY); if (legacy) return legacy; } catch { /* unavailable on insecure/private origins */ }
    return create();
  };
  // Durable adapters serialize across tabs, and re-read an explicit peer identity change.
  if (store.getOrCreateMeta) return store.getOrCreateMeta(CLIENT_ID_KEY, createIdentity);
  let identity = identities.get(store);
  if (!identity) {
    identity = (async () => { const existing = await store.readMeta(CLIENT_ID_KEY); if (existing) return existing;
        const value = createIdentity(); await store.writeMeta(CLIENT_ID_KEY, value); return value; })();
    identities.set(store, identity);
    void identity.catch(() => identities.delete(store));
  }
  return identity;
}
export const SNAPSHOT_MEDIA_KEY = 'snapshotMediaMode';
export type SnapshotMediaMode = 'none' | 'thumbnails';
export async function readSnapshotMediaMode(store: SnapshotStore): Promise<SnapshotMediaMode> {
  return await store.readMeta(SNAPSHOT_MEDIA_KEY) === 'none' ? 'none' : 'thumbnails';
}
