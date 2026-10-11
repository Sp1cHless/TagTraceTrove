import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { syncReplayOperationSchema, syncSnapshotSchema, type SyncSnapshot } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { getSyncIdentity, buildSyncCapabilities, buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { createApiApp } from '../../src/http/app.js';

const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
function setup() {
  const db = createMigratedMemoryDatabase(); databases.push(db);
  createEntry(db, { title: 'Seed', type: 'comic' });
  const section = createSection(db, { entryType: 'comic', name: 'Tags' });
  const second = createSection(db, { entryType: 'comic', name: 'Other' });
  db.prepare('INSERT INTO tags (name, normalized_name) VALUES (?, ?)').run('Known', 'known');
  const envelope = { clientId: 'test', ...getSyncIdentity(db), entityKind: 'entry', entityUid: randomUUID(), clientCreatedAt: '2026-09-25T00:00:00Z' };
  const parentId = randomUUID();
  const create = syncReplayOperationSchema.parse({ ...envelope, opId: parentId, operationKind: 'entry.create', baseVersion: 0, baseValues: {}, payload: { title: 'Pending', type: 'comic', uploadDate: null, pageCount: null, ratings: [], viewLater: false } });
  const op = (base: {name: string; facetId: number}[] = [], desired = [{ name: 'Known', facetId: section.defaultFacetId }]) => syncReplayOperationSchema.parse({ ...envelope, opId: randomUUID(), operationKind: 'entry.tags.set', baseVersion: 0, baseValues: { tags: base }, payload: { tags: desired, parentCreateOpId: parentId } });
  return { db, section, second, create, op };
}
it('reconciles the real client add move remove chain with interleaved Content after a committed Tag response is lost', async () => {
  const { db, section, second } = setup();
  // Runtime bridge keeps Web source out of server tsconfig.rootDir.
  const modules = ['../../../web/src/offline/offline-api.js', '../../../web/src/offline/snapshot-store.js',
    '../../../web/src/offline/outbox-store.js', '../../../web/src/offline/media-outbox-store.js'];
  const [facade, snapshots, outboxes, media] = await Promise.all(modules.map(path => import(path)));
  const snapshotStore = snapshots.createMemorySnapshotStore();
  const outbox = outboxes.createMemoryOutboxStore();
  const store = { ...snapshotStore, ...outbox,
    ...media.createMemoryMediaOutboxStore((operation: Parameters<typeof replaySyncOperation>[1]) => outbox.enqueue(operation)) };
  await store.writeGeneration(1, JSON.stringify(buildSyncSnapshot(db)));
  await store.writeMeta(snapshots.ACTIVE_GENERATION_KEY, '1');
  const sent: Array<{ opId: string; kind: string; body: string }> = [];
  let lost = false;
  const online = {
    getSyncCapabilities: async () => buildSyncCapabilities(db, 'pending-tag-flow-test'),
    replaySyncOperation: async (operation: Parameters<typeof replaySyncOperation>[1]) => {
      sent.push({ opId: operation.opId, kind: operation.operationKind, body: JSON.stringify(operation) });
      const result = replaySyncOperation(db, operation);
      if (!lost && operation.operationKind === 'entry.tags.set') {
        lost = true; throw new TypeError('committed Tag response lost');
      }
      return result;
    },
    fetchSyncSnapshot: async () => buildSyncSnapshot(db),
  };
  const options = { clientId: 'pending-tag-client', randomUUID };
  const api = facade.createOfflineAwareGalleryApi(online, store, options);
  await api.getSyncCapabilities({ replay: false });
  const created = await api.enqueueOfflineEntryCreate({ title: 'Tag flow', type: 'comic', uploadDate: null,
    pageCount: null, ratings: [], viewLater: false, coverFile: null, previewFile: null,
    contents: [{ contentType: 'Notes', content: 'initial' }] });
  const editor = await api.getPendingOfflineEntryTagOptions(created.localKey);
  expect(editor.facets.find((facet: { id: number }) => facet.id === section.defaultFacetId)?.name).toBe('Tags');
  expect(editor.facets.find((facet: { id: number }) => facet.id === second.defaultFacetId)?.name).toBe('Other');
  await api.enqueueOfflinePendingEntryTags(created.localKey, [{ name: 'Known', facetId: section.defaultFacetId }]);
  await api.enqueueOfflinePendingEntryContent(created.localKey, { contentType: 'Notes', content: 'later' });
  await api.enqueueOfflinePendingEntryTags(created.localKey, [{ name: 'Known', facetId: second.defaultFacetId }]);
  await api.enqueueOfflinePendingEntryTags(created.localKey, []);
  await api.enqueueOfflinePendingEntryTags(created.localKey, [{ name: 'Known', facetId: section.defaultFacetId }]);
  const original = await store.list();
  const parentPayload = structuredClone(original[0].payload);
  await api.flushOfflineOutbox();
  expect(await store.list()).toHaveLength(original.length);
  expect((await store.list())[0].payload).toEqual(parentPayload);
  const restarted = facade.createOfflineAwareGalleryApi(online, store, options);
  await restarted.flushOfflineOutbox();
  expect(await store.list()).toEqual([]);
  const entityUid = created.localKey.slice(6);
  const entryId = Number(db.prepare('SELECT id FROM entries WHERE sync_uid = ?').pluck().get(entityUid));
  expect(db.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?').pluck().get(entityUid)).toBe(1);
  expect(db.prepare(`SELECT tag.name, assignment.facet_id AS facetId FROM entry_tags AS assignment
    JOIN tags AS tag ON tag.id = assignment.tag_id WHERE assignment.entry_id = ?`).all(entryId))
    .toEqual([{ name: 'Known', facetId: section.defaultFacetId }]);
  expect(db.prepare('SELECT content FROM entry_contents WHERE entry_id = ? ORDER BY sort_order').pluck().all(entryId))
    .toEqual(['initial', 'later']);
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(original.length);
  const retries = sent.filter(row => row.opId === original[1].opId);
  expect(retries).toHaveLength(2);
  expect(retries[0]?.body).toBe(retries[1]?.body);
  const active = await snapshots.readActiveSnapshot(store) as { snapshot: SyncSnapshot } | null;
  expect(active?.snapshot.payload.entries.find(entry => entry.syncUid === entityUid)?.id).toBe(entryId);
  expect(active?.snapshot.payload.entryTags.filter(row => row.entryId === entryId)).toHaveLength(1);
});

it('leaves precreate unreceipted and retries with verified parent identity', () => {
  const { db, create, op } = setup(); const operation = op();
  expect(replaySyncOperation(db, operation).status).toBe('failed');
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(0);
  const parent = replaySyncOperation(db, create);
  expect(parent.status).toBe('applied');
  expect(replaySyncOperation(db, operation)).toMatchObject({ status: 'applied', entityId: parent.status === 'applied' ? parent.entityId : -1 });
});

it('rejects unknown vocabulary for the whole pending set', () => {
  const { db, create, op, section } = setup(); replaySyncOperation(db, create);
  const before = db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get();
  expect(replaySyncOperation(db, op([], [{ name: 'Known', facetId: section.defaultFacetId }, { name: 'Unknown', facetId: section.defaultFacetId }]))).toMatchObject({ status: 'failed', errorCode: 'invalid-tag-data' });
  expect(db.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(0);
  expect(db.prepare('SELECT COUNT(*) FROM tags').pluck().get()).toBe(1);
  expect(db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(before);
});

it('advertises pending tags only alongside supported mutations and entry tags', () => {
  const { db } = setup(); const flags = buildSyncCapabilities(db, 'test').featureFlags;
  expect(flags.offlinePendingEntryTags).toBe(true);
  expect(flags.offlineMutations && flags.offlineEntryTags).toBe(true);
});

it('does not pad pending convergent revisions against an arbitrarily large captured base', () => {
  const { db, create, op, section } = setup(); const parent = replaySyncOperation(db, create);
  if (parent.status !== 'applied') throw new Error('create failed');
  const id = parent.entityId!;
  const desired = [{ name: 'Known', facetId: section.defaultFacetId }];
  expect(replaySyncOperation(db, op([], desired)).status).toBe('applied');
  const version = db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(id);
  const base = Array.from({length: 10}, (_, i) => ({ name: `Old${i}`, facetId: section.defaultFacetId }));
  expect(replaySyncOperation(db, op(base, desired))).toMatchObject({ status: 'applied', entityId: id, resourceVersion: version });
  expect(db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(id)).toBe(version);
});

it('applies add move remove, merges disjoint metadata and preserves exact receipts', () => {
  const { db, create, op, section, second } = setup(); const parent = replaySyncOperation(db, create);
  if (parent.status !== 'applied') throw new Error('create failed');
  const id = parent.entityId!; const tags = [{ name: 'Known', facetId: section.defaultFacetId }];
  db.prepare('UPDATE entries SET title = ? WHERE id = ?').run('Concurrent title', id);
  const operation = op([], tags); const first = replaySyncOperation(db, operation);
  expect(first).toMatchObject({ status: 'applied', entityId: id });
  expect(replaySyncOperation(db, operation)).toEqual(first);
  expect(replaySyncOperation(db, syncReplayOperationSchema.parse({ ...operation, payload: { ...operation.payload, tags: [{ name: 'Known', facetId: second.defaultFacetId }] } }))).toMatchObject({ status: 'failed', errorCode: 'operation-id-collision' });
  const moved = [{ name: 'Known', facetId: second.defaultFacetId }];
  expect(replaySyncOperation(db, op(tags, moved)).status).toBe('applied');
  expect(db.prepare('SELECT facet_id FROM entry_tags WHERE entry_id = ?').pluck().get(id)).toBe(second.defaultFacetId);
  expect(replaySyncOperation(db, op(moved, [])).status).toBe('applied');
  expect(db.prepare('SELECT COUNT(*) FROM entry_tags WHERE entry_id = ?').pluck().get(id)).toBe(0);
  expect(db.prepare('SELECT title FROM entries WHERE id = ?').pluck().get(id)).toBe('Concurrent title');
});
it('rejects wrong parent and UID without changing tags', () => {
  const { db, create, op } = setup(); replaySyncOperation(db, create);
  const operation = op();
  for (const wrong of [ { ...operation, payload: { ...operation.payload, parentCreateOpId: randomUUID() } }, { ...operation, entityUid: randomUUID() } ]) {
    expect(replaySyncOperation(db, syncReplayOperationSchema.parse(wrong)).status).toBe('failed');
  }
  expect(db.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(0);
});
it('rejects mismatched applied receipt numeric identity', () => {
  const { db, create, op } = setup(); replaySyncOperation(db, create);
  db.prepare("UPDATE sync_operation_receipts SET result_json = json_set(result_json, '$.entityId', 1) WHERE op_id = ?").run(create.opId);
  expect(replaySyncOperation(db, op())).toMatchObject({ status: 'failed', errorCode: 'invalid-tag-data' });
  expect(db.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(0);
});
it('conflicts on divergent assignment set without overwriting it', () => {
  const { db, create, op, section, second } = setup(); replaySyncOperation(db, create);
  const tags = [{ name: 'Known', facetId: section.defaultFacetId }];
  replaySyncOperation(db, op([], tags));
  expect(replaySyncOperation(db, op([], [{ name: 'Known', facetId: second.defaultFacetId }]))).toMatchObject({ status: 'conflict', currentValues: { tags } });
});
it('rejects invalid owner-type facet before mutating any assignment', () => {
  const { db, create, op } = setup(); replaySyncOperation(db, create);
  const wrong = createSection(db, { entryType: 'game', name: 'Wrong' });
  expect(replaySyncOperation(db, op([], [{ name: 'Known', facetId: wrong.defaultFacetId }]))).toMatchObject({ status: 'failed', errorCode: 'invalid-tag-data' });
  expect(db.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(0);
});
it.each(['INSERT', 'UPDATE'])('rolls back all assignment owner journal receipt changes on %s failure', (kind) => {
  const { db, create, op, section, second } = setup(); const parent = replaySyncOperation(db, create);
  if (parent.status !== 'applied') throw new Error('create failed');
  const id = parent.entityId!;
  const tags = [{ name: 'Known', facetId: section.defaultFacetId }];
  if (kind === 'UPDATE') replaySyncOperation(db, op([], tags));
  const before = db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get();
  const version = db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(id);
  db.exec(`CREATE TRIGGER fail_pending BEFORE ${kind} ON entry_tags BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`);
  const operation = kind === 'INSERT' ? op() : op(tags, [{ name: 'Known', facetId: second.defaultFacetId }]);
  expect(() => replaySyncOperation(db, operation)).toThrow('forced failure');
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(0);
  expect(db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(before);
  expect(db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(id)).toBe(version);
  expect(db.prepare('SELECT facet_id FROM entry_tags WHERE entry_id = ?').pluck().all(id)).toEqual(kind === 'INSERT' ? [] : [section.defaultFacetId]);
});

it('snapshots authoritative existing tag rows and reconciled Entry UUID', async () => {
  const { db, create, op, section } = setup(); const parent = replaySyncOperation(db, create);
  if (parent.status !== 'applied') throw new Error('create failed');
  replaySyncOperation(db, op());
  const snapshot = syncSnapshotSchema.parse(await (await createApiApp(db).request('/api/sync/snapshot?media=none')).json());
  expect(snapshot.payload.entries).toContainEqual(expect.objectContaining({ id: parent.entityId, syncUid: create.entityUid }));
  const tagId = db.prepare('SELECT id FROM tags WHERE normalized_name = ?').pluck().get('known');
  expect(snapshot.payload.tags).toContainEqual(expect.objectContaining({ id: tagId, name: 'Known' }));
  expect(snapshot.payload.entryTags).toContainEqual(expect.objectContaining({ entryId: parent.entityId, tagId, facetId: section.defaultFacetId }));
});
it('restores earlier removals and inserts when a later insert aborts', () => {
  const { db, create, op, section } = setup(); const parent = replaySyncOperation(db, create);
  if (parent.status !== 'applied') throw new Error('create failed');
  const tags = [{ name: 'Known', facetId: section.defaultFacetId }]; replaySyncOperation(db, op([], tags));
  db.exec("INSERT INTO tags(name, normalized_name) VALUES ('Alpha', 'alpha'), ('Zulu', 'zulu'); CREATE TRIGGER fail_later BEFORE INSERT ON entry_tags WHEN NEW.tag_id = (SELECT id FROM tags WHERE normalized_name = 'zulu') BEGIN SELECT RAISE(ABORT, 'later failure'); END;");
  const before = db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get();
  const operation = op(tags, [{name:'Alpha', facetId:section.defaultFacetId}, {name:'Zulu', facetId:section.defaultFacetId}]);
  expect(() => replaySyncOperation(db, operation)).toThrow('later failure');
  expect(db.prepare('SELECT tags.name FROM entry_tags JOIN tags ON tags.id = entry_tags.tag_id WHERE entry_id = ?').pluck().all(parent.entityId)).toEqual(['Known']);
  expect(db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(before);
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(0);
});
