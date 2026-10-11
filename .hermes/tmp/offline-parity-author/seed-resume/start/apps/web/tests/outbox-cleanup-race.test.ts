import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createMemoryOutboxStore, createPendingSyncOperation, type OutboxStore } from '../src/offline/outbox-store.js';

function operations() {
  const parent = createPendingSyncOperation({ clientId: 'client', libraryId: 'library', syncEpoch: 'epoch', entityKind: 'entry', entityUid: 'entry', operationKind: 'entry.create', baseVersion: 0, baseValues: {}, payload: {} });
  const child = createPendingSyncOperation({ ...parent, operationKind: 'entry.tags.set', payload: { parentCreateOpId: parent.opId, tags: [] } });
  return { parent, child };
}

it.each(['memory', 'indexeddb'] as const)('%s refuses a child whose parent was cleaned before enqueue', async kind => {
  const idb = kind === 'indexeddb' ? createIndexedDbOfflineStore({ indexedDB: new IDBFactory(), databaseName: 'late-child' }) : null;
  const store: OutboxStore = idb ?? createMemoryOutboxStore();
  try {
    const { parent, child } = operations();
    await store.enqueue(parent);
    await store.removeApplied([parent.opId]);
    await expect(store.enqueue(child)).rejects.toThrow(/parent.*missing/i);
    expect(await store.list()).toEqual([]);
  } finally { idb?.close(); }
});

it('serializes child enqueue and applied cleanup across two IndexedDB instances in both orders', async () => {
  const indexedDB = new IDBFactory();
  const a = createIndexedDbOfflineStore({ indexedDB, databaseName: 'shared' });
  const b = createIndexedDbOfflineStore({ indexedDB, databaseName: 'shared' });
  try {
    await Promise.all([a.list(), b.list()]);
    const { parent, child } = operations();
    await a.enqueue(parent);
    await Promise.all([b.enqueue(child), a.removeApplied([parent.opId])]);
    expect((await a.list()).map(row => row.opId)).toEqual([parent.opId, child.opId]);
    await a.removeApplied([parent.opId, child.opId]);
    expect(await b.list()).toEqual([]);
    const second = operations();
    await a.enqueue(second.parent);
    const results = await Promise.allSettled([a.removeApplied([second.parent.opId]), b.enqueue(second.child)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(await b.list()).toEqual([]);
  } finally { a.close(); b.close(); }
});
