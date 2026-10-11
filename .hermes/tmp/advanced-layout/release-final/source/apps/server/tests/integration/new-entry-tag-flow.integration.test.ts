import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { upsertTaxonomyAlias } from '../../src/repositories/taxonomy-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';
import { buildSyncCapabilities, buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { createNodeSqliteMemoryDatabase } from './node-sqlite-adapter.js';

async function fixture() {
  const db = createNodeSqliteMemoryDatabase(); applyAllMigrations(db);
  const entry = createEntry(db, { title: 'Seed', type: 'comic' });
  const section = createSection(db, { entryType: 'comic', name: 'Tags' });
  const facet = createFacet(db, { sectionId: section.id, name: 'Theme' });
  const paths = ['../../../web/src/offline/offline-api.js', '../../../web/src/offline/indexeddb-snapshot-store.js', '../../../web/src/offline/snapshot-store.js', '../../../web/node_modules/fake-indexeddb/build/esm/index.js'];
  const [facade, indexed, snapshots, fake] = await Promise.all(paths.map(path => import(path)));
  const factory = new fake.IDBFactory(), databaseName = randomUUID();
  let store = indexed.createIndexedDbOfflineStore({ indexedDB: factory, databaseName });
  await store.writeGeneration(1, JSON.stringify(buildSyncSnapshot(db))); await store.writeMeta(snapshots.ACTIVE_GENERATION_KEY, '1');
  const sent: Array<{ opId: string; body: string }> = [];
  const online = { getSyncCapabilities: async () => buildSyncCapabilities(db, 'test'), fetchSyncSnapshot: async () => buildSyncSnapshot(db),
    replaySyncOperation: async (op: Parameters<typeof replaySyncOperation>[1]) => { sent.push({ opId: op.opId, body: JSON.stringify(op) }); return replaySyncOperation(db, op); } };
  const options = { clientId: 'tag-flow', randomUUID };
  let api = facade.createOfflineAwareGalleryApi(online, store, options); await api.getSyncCapabilities({ replay: false });
  return { db, entry, facet, sent, online, get store() { return store; }, get api() { return api; },
    reopen() { store.close(); store = indexed.createIndexedDbOfflineStore({ indexedDB: factory, databaseName }); api = facade.createOfflineAwareGalleryApi(online, store, options); },
    close() { store.close(); db.close(); } };
}

it.each(['pending', 'synced', 'canonical-reuse', 'alias-reuse', 'canonical-origin-reuse'])('real SQL %s new Tag response loss cold IDB reopen exact retry remove readd and covered cleanup', async kind => {
  const f = await fixture();
  try {
    const pending = kind !== 'synced';
    const local = pending ? await f.api.enqueueOfflineEntryCreate({ title: 'Draft', type: 'comic', uploadDate: null, pageCount: null, ratings: [], viewLater: false, coverFile: null, previewFile: null }) : null;
    // Canonical Tag appears remotely after the offline snapshot; the queued UUID
    // legitimately differs from the existing canonical Tag's persisted UUID.
    const name = kind === 'alias-reuse' ? 'Old School' : 'School Life';
    if (kind === 'alias-reuse') upsertTaxonomyAlias(f.db, { vocabulary: 'entry', alias: name, canonicalName: 'School Life' });
    if (kind === 'canonical-reuse' || kind === 'alias-reuse') f.db.prepare('INSERT INTO tags (name, normalized_name) VALUES (?, ?)').run('School Life', 'school life');
    if (local) await f.api.enqueueOfflinePendingEntryTagCreate(local.localKey, name, f.facet.id);
    else await f.api.assignEntryTag(f.entry.id, { name: 'School Life', facetId: f.facet.id });
    const rows = await f.store.list(), origin = rows.find((row: {operationKind: string}) => row.operationKind === 'entry.tag.create');
    if (kind === 'canonical-origin-reuse') {
      const remote = { ...origin, opId: randomUUID(), entityUid: randomUUID(), clientId: 'other-client' };
      expect(replaySyncOperation(f.db, remote).status).toBe('applied');
    }
    const transport = f.online.replaySyncOperation; let lost = false;
    f.online.replaySyncOperation = async op => { const result = await transport(op); if (!lost && op.operationKind === 'entry.tag.create') { lost = true; throw new TypeError('committed response lost'); } return result; };
    await f.api.flushOfflineOutbox(); expect(await f.store.list()).toHaveLength(rows.length);
    f.reopen();
    if (local) { await f.api.enqueueOfflinePendingEntryTags(local.localKey, []); await f.api.enqueueOfflinePendingEntryTagCreate(local.localKey, name, f.facet.id); }
    else {
      const detail = await f.api.getEntry(f.entry.id);
      const tag = detail.sections.flatMap((section: {facets: Array<{tags: Array<{id: number; name: string}>}>}) => section.facets.flatMap(facet => facet.tags)).find((tag: {name: string}) => tag.name === 'School Life');
      await f.api.removeEntryTag(f.entry.id, tag.id); await f.api.assignEntryTag(f.entry.id, { name: 'School Life', facetId: f.facet.id });
    }
    await f.api.flushOfflineOutbox(); expect(await f.store.list()).toEqual([]);
    const retries = f.sent.filter(row => row.opId === origin.opId); expect(retries).toHaveLength(2); expect(retries[0]?.body).toBe(retries[1]?.body);
    const ownerId = local ? f.db.prepare('SELECT id FROM entries WHERE sync_uid=?').pluck().get(local.localKey.slice(6)) : f.entry.id;
    expect(f.db.prepare('SELECT COUNT(*) FROM entry_tags WHERE entry_id=?').pluck().get(ownerId)).toBe(1);
    expect(f.db.prepare('SELECT COUNT(*) FROM tags WHERE normalized_name=?').pluck().get('school life')).toBe(1);
    if (kind === 'canonical-origin-reuse') {
      expect(f.db.prepare('SELECT COUNT(*) FROM sync_offline_created_entry_tags').pluck().get()).toBe(2);
      const receipt = JSON.parse(f.db.prepare('SELECT result_json FROM sync_operation_receipts WHERE op_id=?').pluck().get(origin.opId) as string);
      expect(receipt).toMatchObject({ status: 'applied', opId: origin.opId, entityId: f.db.prepare('SELECT id FROM tags WHERE normalized_name=?').pluck().get('school life') });
    }
    if (kind === 'canonical-reuse' || kind === 'canonical-origin-reuse') expect(f.db.prepare('SELECT sync_uid FROM tags WHERE normalized_name=?').pluck().get('school life')).not.toBe(origin.entityUid);
  } finally { f.close(); }
});

it('keeps the global source Tag while a pending peer uses it after intentional source removal', async () => {
  const f = await fixture();
  try {
    await f.api.assignEntryTag(f.entry.id, { name: 'Shared New', facetId: f.facet.id });
    const peer = await f.api.enqueueOfflineEntryCreate({ title: 'Peer', type: 'comic', uploadDate: null, pageCount: null, ratings: [], viewLater: false, coverFile: null, previewFile: null });
    await f.api.enqueueOfflinePendingEntryTagCreate(peer.localKey, 'Shared New', f.facet.id);
    const detail = await f.api.getEntry(f.entry.id);
    const tag = detail.sections.flatMap((section: {facets: Array<{tags: Array<{id: number; name: string}>}>}) => section.facets.flatMap(facet => facet.tags)).find((tag: {name: string}) => tag.name === 'Shared New');
    await f.api.removeEntryTag(f.entry.id, tag.id);
    expect((await f.store.list()).filter((row: {operationKind: string}) => row.operationKind === 'entry.tag.create')).toHaveLength(1);
    f.reopen(); await f.api.flushOfflineOutbox(); expect(await f.store.list()).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) FROM entry_tags WHERE entry_id=?').pluck().get(f.entry.id)).toBe(0);
    const peerId = f.db.prepare('SELECT id FROM entries WHERE sync_uid=?').pluck().get(peer.localKey.slice(6));
    expect(f.db.prepare('SELECT COUNT(*) FROM entry_tags WHERE entry_id=?').pluck().get(peerId)).toBe(1);
    expect(f.db.prepare('SELECT COUNT(*) FROM tags WHERE normalized_name=?').pluck().get('shared new')).toBe(1);
  } finally { f.close(); }
});

it('real SQL source insertion failure rolls back the Tag and holds all dependent assignments', async () => {
  const f = await fixture();
  try {
    await f.api.assignEntryTag(f.entry.id, { name: 'Broken', facetId: f.facet.id });
    f.db.exec("CREATE TRIGGER fail_new_tag BEFORE INSERT ON tags WHEN NEW.normalized_name='broken' BEGIN SELECT RAISE(ABORT, 'forced source failure'); END");
    await f.api.flushOfflineOutbox();
    expect(f.sent.map(row => JSON.parse(row.body).operationKind)).toEqual(['entry.tag.create']);
    expect(f.db.prepare('SELECT COUNT(*) FROM tags WHERE normalized_name=?').pluck().get('broken')).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) FROM entry_tags WHERE entry_id=?').pluck().get(f.entry.id)).toBe(0);
    expect(await f.store.list()).toHaveLength(2);
  } finally { f.close(); }
});

it.each(['numeric', 'opId'])('rejects an applied Tag receipt with wrong %s identity before cleanup', async wrong => {
  const f = await fixture();
  try {
    await f.api.assignEntryTag(f.entry.id, { name: 'School Life', facetId: f.facet.id });
    const transport = f.online.replaySyncOperation;
    f.online.replaySyncOperation = async op => { const result = await transport(op); return op.operationKind === 'entry.tag.create' ? { ...result, ...(wrong === 'numeric' ? { entityId: 99999 } : { opId: randomUUID() }) } : result; };
    await f.api.flushOfflineOutbox(); expect(await f.store.list()).toHaveLength(2);
  } finally { f.close(); }
});
