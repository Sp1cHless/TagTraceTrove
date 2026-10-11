import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { syncReplayOperationSchema } from '@t3/shared';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { getSyncIdentity, buildSyncCapabilities, buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
type Values = { title?: string; uploadDate?: string | null; pageCount?: number | null };
function setup() {
  const db = createMigratedMemoryDatabase(); databases.push(db);
  createEntry(db, { title: 'Seed', type: 'comic' });
  const envelope = { clientId: 'test', ...getSyncIdentity(db), entityKind: 'entry', entityUid: randomUUID(), clientCreatedAt: '2026-10-01T00:00:00Z' };
  const create = syncReplayOperationSchema.parse({ ...envelope, opId: randomUUID(), operationKind: 'entry.create', baseVersion: 0, baseValues: {}, payload: { title: 'Pending', type: 'comic', uploadDate: null, pageCount: null, ratings: [], viewLater: false } });
  const op = (base: Values = { title: 'Pending' }, desired: Values = { title: 'Edited' }) => {
    const operation = syncReplayOperationSchema.parse({ ...envelope, opId: randomUUID(), operationKind: 'entry.update', baseVersion: 0, baseValues: base, payload: { ...desired, parentCreateOpId: create.opId } });
    if (operation.operationKind !== 'entry.update') throw new Error('unexpected operation');
    return operation;
  };
  const parent = () => { const result = replaySyncOperation(db, create); if (result.status !== 'applied') throw new Error('parent failed'); return result.entityId!; };
  return { db, create, op, parent };
}
it('preparent remains unreceipted and exact immutable child retries after creation', () => {
  const { db, op, parent } = setup(); const operation = op();
  expect(replaySyncOperation(db, operation).status).toBe('failed');
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(0);
  const id = parent();
  expect(replaySyncOperation(db, operation)).toMatchObject({ status: 'applied', entityId: id });
});
it('pending convergence receipts current revision without writing a journal row', () => {
  const { db, op, parent } = setup(); const id = parent();
  const before = db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get();
  const version = db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(id);
  expect(replaySyncOperation(db, op({ title: 'Old captured value' }, { title: 'Pending' }))).toMatchObject({ status: 'applied', entityId: id, resourceVersion: version });
  expect(db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(before);
});

it('advertises pending metadata support', () => {
  const { db } = setup(); const flags = buildSyncCapabilities(db, 'test').featureFlags;
  expect(flags.offlinePendingEntryMetadata && flags.offlineMutations).toBe(true);
});

it('nullable metadata add change clear snapshots and immutable retries', () => {
  const { db, op, parent, create } = setup(); const id = parent();
  const operation = op({ uploadDate: null, pageCount: null }, { uploadDate: '2026-01-01', pageCount: 0 });
  const result = replaySyncOperation(db, operation);
  expect(result).toMatchObject({ status: 'applied', entityId: id });
  expect(replaySyncOperation(db, operation)).toEqual(result);
  expect(replaySyncOperation(db, syncReplayOperationSchema.parse({ ...operation, payload: { ...operation.payload, pageCount: 10 } }))).toMatchObject({ status: 'failed', errorCode: 'operation-id-collision' });
  expect(replaySyncOperation(db, op({ uploadDate: '2026-01-01', pageCount: 0 }, { uploadDate: '2026-02-01', pageCount: 20 })).status).toBe('applied');
  expect(buildSyncSnapshot(db).payload.entries).toContainEqual(expect.objectContaining({ id, syncUid: create.entityUid, uploadDate: '2026-02-01', pageCount: 20 }));
  expect(replaySyncOperation(db, op({ uploadDate: '2026-02-01', pageCount: 20 }, { uploadDate: null, pageCount: null })).status).toBe('applied');
  expect(buildSyncSnapshot(db).payload.entries).toContainEqual(expect.objectContaining({ id, uploadDate: null, pageCount: null }));
});
it('samefield divergence conflicts and disjoint metadata merges without changing relations', () => {
  const { db, op, parent } = setup(); const id = parent();
  db.prepare('UPDATE entries SET page_count = 99 WHERE id = ?').run(id);
  const producerId = Number(db.prepare("INSERT INTO producers(name) VALUES ('Concurrent')").run().lastInsertRowid);
  db.prepare('INSERT INTO entry_producers(entry_id, producer_id) VALUES (?, ?)').run(id, producerId);
  const sectionId = Number(db.prepare("INSERT INTO tag_groups(entry_type, name, group_kind, sort_order) VALUES ('comic', 'Tags', 'section', 0)").run().lastInsertRowid);
  const facetId = Number(db.prepare("INSERT INTO tag_groups(entry_type, name, group_kind, parent_id, sort_order) VALUES ('comic', 'Facet', 'facet', ?, 0)").run(sectionId).lastInsertRowid);
  const tagId = Number(db.prepare("INSERT INTO tags(name, normalized_name) VALUES ('Concurrent', 'concurrent')").run().lastInsertRowid);
  db.prepare('INSERT INTO entry_tags(entry_id, tag_id, facet_id) VALUES (?, ?, ?)').run(id, tagId, facetId);
  db.prepare("INSERT INTO entry_contents(entry_id, content_type, content, sort_order) VALUES (?, 'Text', 'Concurrent', 0)").run(id);
  const before = buildSyncSnapshot(db).payload;
  expect(replaySyncOperation(db, op()).status).toBe('applied');
  expect(replaySyncOperation(db, op({ title: 'Pending' }, { title: 'Overwrite' }))).toMatchObject({ status: 'conflict', currentValues: { title: 'Edited' } });
  const after = buildSyncSnapshot(db).payload;
  expect(after.entryProducers).toEqual(before.entryProducers); expect(after.entryTags).toEqual(before.entryTags); expect(after.entryContents).toEqual(before.entryContents);
  expect(after.entries).toContainEqual(expect.objectContaining({ id, title: 'Edited', pageCount: 99 }));
});
it('wrong parent receipt or registry identity cannot authorize metadata', () => {
  const { db, op, parent, create } = setup(); parent();
  const operation = op();
  for (const wrong of [{ ...operation, entityUid: randomUUID() }, { ...operation, payload: { ...operation.payload, parentCreateOpId: randomUUID() } }]) expect(replaySyncOperation(db, syncReplayOperationSchema.parse(wrong)).status).toBe('failed');
  db.prepare("UPDATE sync_operation_receipts SET result_json = json_set(result_json, '$.entityId', 1) WHERE op_id = ?").run(create.opId);
  expect(replaySyncOperation(db, operation)).toMatchObject({ status: 'failed', errorCode: 'invalid-create' });
  expect(buildSyncSnapshot(db).payload.entries).toContainEqual(expect.objectContaining({ syncUid: create.entityUid, title: 'Pending' }));
});
it.each(['receipt', 'journal'])('forced %s abort rolls back owner revision journal and receipt', failure => {
  const { db, op, parent } = setup(); const id = parent(); const operation = op();
  const before = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  const journal = db.prepare('SELECT * FROM sync_changes').all();
  const table = failure === 'receipt' ? 'sync_operation_receipts' : 'sync_changes';
  db.exec('CREATE TRIGGER forced_failure BEFORE INSERT ON ' + table + " BEGIN SELECT RAISE(ABORT, 'forced rollback'); END;");
  expect(() => replaySyncOperation(db, operation)).toThrow('forced rollback');
  expect(db.prepare('SELECT * FROM entries WHERE id = ?').get(id)).toEqual(before);
  expect(db.prepare('SELECT * FROM sync_changes').all()).toEqual(journal);
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(0);
});
it('legacy positive update keeps response shape and convergence conflict semantics', () => {
  const { db, op, parent } = setup(); const id = parent(); const pending = op();
  const payload = { title: 'Edited' };
  const operation = syncReplayOperationSchema.parse({ ...pending, baseVersion: 1, payload });
  expect(replaySyncOperation(db, operation)).toEqual({ opId: operation.opId, status: 'applied', resourceVersion: 2, serverSeq: Number(db.prepare('SELECT MAX(seq) FROM sync_changes').pluck().get()) });
  expect(replaySyncOperation(db, syncReplayOperationSchema.parse({ ...operation, opId: randomUUID() })).status).toBe('conflict');
  expect(db.prepare('SELECT title FROM entries WHERE id = ?').pluck().get(id)).toBe('Edited');
});
