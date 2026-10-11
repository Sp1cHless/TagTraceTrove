import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { buildSyncCapabilities, buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
it('reconciles removed historical appends and later appends after a lost Content-set response', async () => {
  const db = createMigratedMemoryDatabase(); databases.push(db);
  createEntry(db, { title: 'Seed', type: 'comic' });
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
    getSyncCapabilities: async () => buildSyncCapabilities(db, 'pending-contents-flow-test'),
    replaySyncOperation: async (operation: Parameters<typeof replaySyncOperation>[1]) => {
      sent.push({ opId: operation.opId, body: JSON.stringify(operation) });
      const result = replaySyncOperation(db, operation);
      if (!lost && operation.operationKind === 'entry.contents.set') {
        lost = true; throw new TypeError('committed Content response lost');
      }
      return result;
    },
    fetchSyncSnapshot: async () => buildSyncSnapshot(db),
  };
  const options = { clientId: 'pending-contents-client', randomUUID };
  const api = facade.createOfflineAwareGalleryApi(online, store, options);
  await api.getSyncCapabilities({ replay: false });
  const created = await api.enqueueOfflineEntryCreate({ title: 'Content flow', type: 'comic', uploadDate: null,
    pageCount: null, ratings: [], viewLater: false, coverFile: null, previewFile: null,
    contents: [{ contentType: 'Notes', content: 'first' }, { contentType: 'Notes', content: 'second' }] });
  await api.enqueueOfflinePendingEntryContent(created.localKey, { contentType: 'Notes', content: 'removed append' });
  let current = (await api.getPendingOfflineEntryContentOptions(created.localKey)).contents;
  const removedUid = current.find((row: { content: string }) => row.content === 'removed append')?.syncUid;
  await api.enqueueOfflinePendingEntryContents(created.localKey, current.slice(0, 2).map((row: { content: string }, index: number) => index === 0 ? { ...row, content: 'first edited' } : row));
  await api.enqueueOfflinePendingEntryContent(created.localKey, { contentType: 'Notes', content: 'later append' });
  current = (await api.getPendingOfflineEntryContentOptions(created.localKey)).contents;
  await api.enqueueOfflinePendingEntryContents(created.localKey, current.filter((row: { content: string }) => row.content !== 'second'));
  await api.enqueueOfflinePendingEntryContent(created.localKey, { contentType: 'Notes', content: 'latest append' });
  await api.enqueueOfflinePendingEntryMetadata(created.localKey, { title: 'Content final', uploadDate: null, pageCount: 0 });
  const original = await store.list();
  const parentPayload = structuredClone(original[0].payload);
  const firstSet = original.find((row: { operationKind: string }) => row.operationKind === 'entry.contents.set');
  await api.flushOfflineOutbox();
  expect(await store.list()).toHaveLength(original.length);
  expect((await store.list())[0].payload).toEqual(parentPayload);
  const restarted = facade.createOfflineAwareGalleryApi(online, store, options);
  const projected = (await restarted.listPendingOfflineEntryCreates())[0];
  expect(projected.title).toBe('Content final');
  expect(projected.contents.map((row: { content: string }) => row.content)).toEqual(['first edited', 'later append', 'latest append']);
  await restarted.flushOfflineOutbox();
  expect(await store.list()).toEqual([]);
  expect(await restarted.listPendingOfflineEntryCreates()).toEqual([]);
  const entityUid = created.localKey.slice(6);
  const actual = db.prepare('SELECT id, title, page_count AS pageCount FROM entries WHERE sync_uid = ?').get(entityUid) as { id: number; title: string; pageCount: number };
  expect(actual).toMatchObject({ title: 'Content final', pageCount: 0 });
  expect(db.prepare('SELECT content FROM entry_contents WHERE entry_id = ? ORDER BY sort_order').pluck().all(actual.id)).toEqual(['first edited', 'later append', 'latest append']);
  expect(db.prepare('SELECT COUNT(*) FROM entry_contents WHERE sync_uid = ?').pluck().get(removedUid)).toBe(0);
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(original.length);
  const retries = sent.filter(row => row.opId === firstSet.opId);
  expect(retries).toHaveLength(2);
  expect(retries[0]?.body).toBe(retries[1]?.body);
});
