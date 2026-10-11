import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexedDB } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi, type GalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
const serverModule = async (path: string) => { const target = `../../server/src/${path}.js`; return import(/* @vite-ignore */ target); };

it('duration survives actual facade, cold IDB, HTTP replay loss, SQL disjoint edits and snapshot cleanup', async () => {
  const { createMigratedMemoryDatabase } = await serverModule('database/testing');
  const { createEntry, updateEntry } = await serverModule('repositories/entry-repository');
  const { createApiApp } = await serverModule('http/app');
  const { buildSyncSnapshot } = await serverModule('sync/sync-service');
  const db = createMigratedMemoryDatabase();
  const root = mkdtempSync(join(tmpdir(), 't3-duration-'));
  const name = `duration-${randomUUID()}`;
  let store = createIndexedDbOfflineStore({ indexedDB, databaseName: name });
  try {
    const entry = createEntry(db, { title: 'Duration', type: 'comic', durationSeconds: 470, pageCount: 2 });
    const app = createApiApp(db, { assetRoot: root });
    let lose = true;
    const bodies: string[] = [];
    const client = createApiClient({ baseUrl: 'http://isolated/api', fetch: async (input, init) => {
      const path = new URL(String(input)).pathname + new URL(String(input)).search;
      const response = await app.request(path, init);
      if (path.includes('/sync/operations')) {
        bodies.push(String(init?.body));
        if (lose && response.ok) { lose = false; throw new TypeError('committed response lost'); }
      }
      return response;
    } });
    const online = createGalleryApi(client);
    await store.writeGeneration(1, JSON.stringify(buildSyncSnapshot(db)));
    await store.writeMeta('activeGeneration', '1');
    let api = createOfflineAwareGalleryApi(online, store, { clientId: 'duration-phone', randomUUID });
    await api.getSyncCapabilities({ replay: false });
    await api.preferOfflineSnapshot!();
    expect((await api.getEntry(entry.id)).durationSeconds).toBe(470);
    await api.updateEntry(entry.id, { durationSeconds: 0 });
    const original = (await store.list())[0]!;
    expect(original.baseValues).toEqual({ durationSeconds: 470 });
    updateEntry(db, entry.id, { pageCount: 7 });
    store.close(); store = createIndexedDbOfflineStore({ indexedDB, databaseName: name });
    api = createOfflineAwareGalleryApi(online, store, { clientId: 'duration-phone', randomUUID });
    await api.preferOfflineSnapshot!();
    expect((await api.getEntry(entry.id)).durationSeconds).toBe(0);
    await api.flushOfflineOutbox!();
    expect(await store.list()).toHaveLength(1);
    await api.flushOfflineOutbox!();
    expect(await store.list()).toEqual([]);
    expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
    expect(db.prepare('SELECT duration_seconds, page_count FROM entries WHERE id=?').get(entry.id)).toEqual({ duration_seconds: 0, page_count: 7 });
    await api.preferOfflineSnapshot!();
    await api.updateEntry(entry.id, { durationSeconds: null });
    await api.flushOfflineOutbox!();
    expect(db.prepare('SELECT duration_seconds FROM entries WHERE id=?').pluck().get(entry.id)).toBeNull();
    expect(await store.list()).toEqual([]);
  } finally { store.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
