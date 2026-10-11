import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createMemoryOutboxStore, createPendingSyncOperation } from '../src/offline/outbox-store.js';

const identity = { clientId: 'client', libraryId: 'library', syncEpoch: 'epoch' };

it('serializes vocabulary dependency enqueue against cleanup across two IndexedDB instances', async () => {
  const indexedDB = new IDBFactory();
  const a = createIndexedDbOfflineStore({ indexedDB, databaseName: 'tag-race' });
  const b = createIndexedDbOfflineStore({ indexedDB, databaseName: 'tag-race' });
  try {
    await Promise.all([a.list(), b.list()]);
    const first = chain();
    await a.enqueue(first.tag); await a.enqueue(first.facet);
    await Promise.all([b.enqueue(first.child), a.removeApplied([first.tag.opId, first.facet.opId])]);
    expect((await a.list()).map(row => row.opId)).toEqual([first.tag.opId, first.facet.opId, first.child.opId]);
    await a.removeApplied([first.tag.opId, first.facet.opId, first.child.opId]);
    const second = chain();
    await a.enqueue(second.tag); await a.enqueue(second.facet);
    const results = await Promise.allSettled([a.removeApplied([second.tag.opId, second.facet.opId]), b.enqueue(second.child)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(await b.list()).toEqual([]);
  } finally { a.close(); b.close(); }
});
const tagUid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const facetUid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
function chain() {
  const tag = createPendingSyncOperation({ ...identity, entityKind: 'entry_tag', entityUid: tagUid,
    operationKind: 'entry.tag.create', baseVersion: 0, baseValues: {}, payload: { name: 'School Life' } });
  const facet = createPendingSyncOperation({ ...identity, entityKind: 'entry_facet', entityUid: facetUid,
    operationKind: 'entry.facet.create', baseVersion: 1, baseValues: {}, payload: {} });
  const child = createPendingSyncOperation({ ...identity, entityKind: 'entry', entityUid: 'entry',
    operationKind: 'entry.tags.set', baseVersion: 1, baseValues: { tags: [] }, payload: {
      tags: [{ name: 'School Life', tagUid, facetUid }], tagCreates: [{ tagUid, createOpId: tag.opId }],
      facetCreates: [{ facetUid, createOpId: facet.opId }] } });
  return { tag, facet, child };
}

it.each(['memory', 'indexeddb'] as const)('%s retains covered vocabulary origins while another owner has an uncovered dependent set', async kind => {
  const idb = kind === 'indexeddb' ? createIndexedDbOfflineStore({ indexedDB: new IDBFactory(), databaseName: 'tag-retention' }) : null;
  const store = idb ?? createMemoryOutboxStore();
  try {
    const { tag, facet, child } = chain();
    await store.enqueue(tag); await store.enqueue(facet); await store.enqueue(child);
    await store.removeApplied([tag.opId, facet.opId]);
    expect((await store.list()).map(row => row.opId)).toEqual([tag.opId, facet.opId, child.opId]);
    await store.removeApplied([tag.opId, facet.opId, child.opId]);
    expect(await store.list()).toEqual([]);
  } finally { idb?.close(); }
});
