import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { buildSyncCapabilities, buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
it('reconciles disjoint metadata patches with Author Tag Content and a lost committed response', async () => {
  const db = createMigratedMemoryDatabase(); databases.push(db);
  createEntry(db, { title: 'Seed', type: 'comic' });
  const section = createSection(db, { entryType: 'comic', name: 'Tags' });
  db.prepare('INSERT INTO tags (name, normalized_name) VALUES (?, ?)').run('Known', 'known');
  const authorUid = randomUUID();
  const authorId = Number(db.prepare('INSERT INTO producers (name, sync_uid) VALUES (?, ?)').run('Alice', authorUid).lastInsertRowid);
  const modules = ['../../../web/src/offline/offline-api.js', '../../../web/src/offline/snapshot-store.js',
    '../../../web/src/offline/outbox-store.js', '../../../web/src/offline/media-outbox-store.js'];
  const [facade, snapshots, outboxes, media] = await Promise.all(modules.map(path => import(path)));
  const snapshotStore = snapshots.createMemorySnapshotStore();
  const outbox = outboxes.createMemoryOutboxStore();
  const store = { ...snapshotStore, ...outbox,
    ...media.createMemoryMediaOutboxStore((operation: Parameters<typeof replaySyncOperation>[1]) => outbox.enqueue(operation)) };
  await store.writeGeneration(1, JSON.stringify(buildSyncSnapshot(db)));
  await store.writeMeta(snapshots.ACTIVE_GENERATION_KEY, '1');
  let lost = false;
  const sent: Array<{ opId: string; body: string }> = [];
  const online = {
    getSyncCapabilities: async () => buildSyncCapabilities(db, 'pending-metadata-flow-test'),
    replaySyncOperation: async (operation: Parameters<typeof replaySyncOperation>[1]) => {
      sent.push({ opId: operation.opId, body: JSON.stringify(operation) });
      const result = replaySyncOperation(db, operation);
      if (!lost && operation.operationKind === 'entry.update') {
        lost = true; throw new TypeError('committed metadata response lost');
      }
      return result;
    },
    fetchSyncSnapshot: async () => buildSyncSnapshot(db),
  };
  const options = { clientId: 'pending-metadata-client', randomUUID };
  const api = facade.createOfflineAwareGalleryApi(online, store, options);
  await api.getSyncCapabilities({ replay: false });
  const created = await api.enqueueOfflineEntryCreate({ title: 'Metadata flow', type: 'comic', uploadDate: null,
    pageCount: null, ratings: [], viewLater: false, coverFile: null, previewFile: null,
    contents: [{ contentType: 'Notes', content: 'initial' }] });
  await api.enqueueOfflinePendingEntryMetadata(created.localKey, { title: 'Metadata first', uploadDate: null, pageCount: null });
  await api.enqueueOfflinePendingEntryMetadata(created.localKey, { title: 'Metadata first', uploadDate: '2026-10-01', pageCount: 12 });
  await api.enqueueOfflinePendingEntryAuthors(created.localKey, [authorUid]);
  await api.enqueueOfflinePendingEntryTags(created.localKey, [{ name: 'Known', facetId: section.defaultFacetId }]);
  await api.enqueueOfflinePendingEntryContent(created.localKey, { contentType: 'Notes', content: 'later' });
  await api.enqueueOfflinePendingEntryMetadata(created.localKey, { title: 'Metadata last', uploadDate: '2026-10-01', pageCount: 12 });
  const original = await store.list();
  const parentPayload = structuredClone(original[0].payload);
  expect(original[1].baseValues).toEqual({ title: 'Metadata flow' });
  expect(original[2].baseValues).toEqual({ uploadDate: null, pageCount: null });
  await api.flushOfflineOutbox();
  expect(await store.list()).toHaveLength(original.length);
  expect((await store.list())[0].payload).toEqual(parentPayload);
  const restarted = facade.createOfflineAwareGalleryApi(online, store, options);
  expect((await restarted.listPendingOfflineEntryCreates())[0]).toMatchObject({ title: 'Metadata last', uploadDate: '2026-10-01', pageCount: 12 });
  await restarted.flushOfflineOutbox();
  expect(await store.list()).toEqual([]);
  const entityUid = created.localKey.slice(6);
  const actual = db.prepare('SELECT id, title, upload_date AS uploadDate, page_count AS pageCount FROM entries WHERE sync_uid = ?').get(entityUid) as { id: number; title: string; uploadDate: string | null; pageCount: number | null };
  expect(actual).toMatchObject({ title: 'Metadata last', uploadDate: '2026-10-01', pageCount: 12 });
  expect(db.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?').pluck().get(entityUid)).toBe(1);
  expect(db.prepare('SELECT producer_id FROM entry_producers WHERE entry_id = ?').pluck().all(actual.id)).toEqual([authorId]);
  expect(db.prepare('SELECT facet_id FROM entry_tags WHERE entry_id = ?').pluck().all(actual.id)).toEqual([section.defaultFacetId]);
  expect(db.prepare('SELECT content FROM entry_contents WHERE entry_id = ? ORDER BY sort_order').pluck().all(actual.id)).toEqual(['initial', 'later']);
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(original.length);
  const retries = sent.filter(row => row.opId === original[1].opId);
  expect(retries).toHaveLength(2);
  expect(retries[0]?.body).toBe(retries[1]?.body);
});
