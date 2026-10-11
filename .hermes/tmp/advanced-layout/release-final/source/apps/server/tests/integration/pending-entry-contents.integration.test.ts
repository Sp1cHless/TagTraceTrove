import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { syncReplayOperationSchema, syncSnapshotSchema } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import type { T3Database } from '../../src/database/connection.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { getSyncIdentity, buildSyncCapabilities } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { createApiApp } from '../../src/http/app.js';

const databases: T3Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = createMigratedMemoryDatabase(); databases.push(db);
  createEntry(db, { title: 'Seed', type: 'game' });
  const envelope = { clientId: 'client', ...getSyncIdentity(db), entityKind: 'entry', entityUid: randomUUID(), clientCreatedAt: '2026-09-28T12:00:00.000Z' };
  const row = { syncUid: randomUUID(), contentType: 'Note', content: 'initial', sortOrder: 0 };
  const create = syncReplayOperationSchema.parse({ ...envelope, opId: randomUUID(), operationKind: 'entry.create', baseVersion: 0, baseValues: {}, payload: { title: 'New', type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false, contents: [row] } });
  const set = (base = [row], desired = [{ ...row, content: 'edited' }]) => syncReplayOperationSchema.parse({ ...envelope, opId: randomUUID(), operationKind: 'entry.contents.set', baseVersion: 0, baseValues: { contents: base }, payload: { parentCreateOpId: create.opId, contents: desired } });
  return { db, create, row, set };
}
it('preserves authoritative snapshot row identity and actual write journal deltas', async () => {
  const { db, create, row, set } = setup(); const created = replaySyncOperation(db, create);
  if (created.status !== 'applied') throw new Error('create failed');
  const before = Number(db.prepare('SELECT MAX(seq) FROM sync_changes').pluck().get());
  const id = db.prepare('SELECT id FROM entry_contents WHERE sync_uid = ?').pluck().get(row.syncUid);
  const result = replaySyncOperation(db, set());
  expect(result).toMatchObject({ status: 'applied', resourceVersion: Number(created.resourceVersion) + 1 });
  expect(db.prepare('SELECT entity_kind AS kind, change_kind AS operation FROM sync_changes WHERE seq > ? ORDER BY seq').all(before)).toEqual([
    { kind: 'entry_content', operation: 'update' }, { kind: 'entry', operation: 'update' },
  ]);
  const snapshot = syncSnapshotSchema.parse(await (await createApiApp(db).request('/api/sync/snapshot?media=none')).json());
  expect(snapshot.payload.entryContents).toContainEqual(expect.objectContaining({ id, entryId: created.entityId, syncUid: row.syncUid, content: 'edited' }));
});
it('rejects borrowed and unknown captured UUIDs without deleting current rows', () => {
  const { db, create, row, set } = setup(); replaySyncOperation(db, create);
  const borrowed = { ...row, syncUid: randomUUID() };
  db.prepare('INSERT INTO entry_contents (entry_id, sync_uid, content_type, content, sort_order) VALUES (1, ?, ?, ?, 0)').run(borrowed.syncUid, 'Note', 'other');
  for (const uid of [borrowed.syncUid, randomUUID()]) {
    const forged = { ...row, syncUid: uid };
    expect(replaySyncOperation(db, set([row, forged], [{ ...forged, content: 'rebinding' }])).status).not.toBe('applied');
  }
  expect(db.prepare('SELECT content FROM entry_contents WHERE sync_uid = ?').pluck().get(row.syncUid)).toBe('initial');
  expect(db.prepare('SELECT entry_id FROM entry_contents WHERE sync_uid = ?').pluck().get(borrowed.syncUid)).toBe(1);
});
it('advertises pending Content support independently', () => {
  const { db } = setup();
  expect(buildSyncCapabilities(db, 'test').featureFlags.offlinePendingEntryContents).toBe(true);
});
it('leaves a preparent operation unreceipted and retries after create', () => {
  const { db, create, set } = setup(); const operation = set();
  expect(replaySyncOperation(db, operation).status).toBe('failed');
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(0);
  replaySyncOperation(db, create);
  expect(replaySyncOperation(db, operation).status).toBe('applied');
});
it('rejects pending desired rows not captured in the complete baseline', () => {
  const { db, create, row, set } = setup(); replaySyncOperation(db, create);
  expect(replaySyncOperation(db, set([row], [{ ...row, syncUid: randomUUID() }]))).toMatchObject({ status: 'failed', errorCode: 'invalid-content' });
  expect(db.prepare('SELECT COUNT(*) FROM entry_contents').pluck().get()).toBe(1);
});
it('converges without owner revision or journal padding', () => {
  const { db, create, row, set } = setup(); replaySyncOperation(db, create);
  const operation = set(); replaySyncOperation(db, operation);
  const before = db.prepare('SELECT MAX(seq) FROM sync_changes').pluck().get();
  const version = db.prepare('SELECT sync_version FROM entries WHERE sync_uid = ?').pluck().get(create.entityUid);
  expect(replaySyncOperation(db, set([row], [{ ...row, content: 'edited' }]))).toMatchObject({ status: 'applied', resourceVersion: version });
  expect(db.prepare('SELECT MAX(seq) FROM sync_changes').pluck().get()).toBe(before);
});
it('edits an initial pending Content row in place with explicit owner identity', () => {
  const { db, create, row, set } = setup();
  const created = replaySyncOperation(db, create);
  expect(created.status).toBe('applied');
  const before = db.prepare('SELECT id FROM entry_contents WHERE sync_uid = ?').pluck().get(row.syncUid);
  const result = replaySyncOperation(db, set());
  expect(result).toMatchObject({ status: 'applied', entityId: created.status === 'applied' ? created.entityId : -1 });
  expect(db.prepare('SELECT id, content FROM entry_contents WHERE sync_uid = ?').get(row.syncUid)).toEqual({ id: before, content: 'edited' });
});
it('removes all rows across repeated sets and preserves immutable create retry', () => {
  const { db, create, row, set } = setup(); const original = JSON.stringify(create);
  const created = replaySyncOperation(db, create);
  const edited = { ...row, content: 'edited' };
  expect(replaySyncOperation(db, set()).status).toBe('applied');
  const remove = set([edited], []); const result = replaySyncOperation(db, remove);
  expect(result.status).toBe('applied'); expect(replaySyncOperation(db, remove)).toEqual(result);
  expect(db.prepare('SELECT COUNT(*) FROM entry_contents').pluck().get()).toBe(0);
  expect(replaySyncOperation(db, create)).toEqual(created); expect(JSON.stringify(create)).toBe(original);
  const collision = syncReplayOperationSchema.parse({ ...remove, baseValues: { contents: [row] } });
  expect(replaySyncOperation(db, collision)).toMatchObject({ status: 'failed', errorCode: 'operation-id-collision' });
});
it.each(['add', 'edit', 'delete'])('conflicts with unobserved Content %s without altering it', change => {
  const { db, create, row, set } = setup(); const created = replaySyncOperation(db, create);
  if (created.status !== 'applied') throw new Error('create failed');
  if (change === 'add') db.prepare('INSERT INTO entry_contents (entry_id, content_type, content, sort_order) VALUES (?, ?, ?, 1)').run(created.entityId, 'Note', 'concurrent');
  if (change === 'edit') db.prepare('UPDATE entry_contents SET content = ? WHERE sync_uid = ?').run('concurrent', row.syncUid);
  if (change === 'delete') db.prepare('DELETE FROM entry_contents WHERE sync_uid = ?').run(row.syncUid);
  const before = db.prepare('SELECT * FROM entry_contents').all();
  expect(replaySyncOperation(db, set()).status).toBe('conflict');
  expect(db.prepare('SELECT * FROM entry_contents').all()).toEqual(before);
});
it('merges disjoint metadata and edits then removes an already replayed appended row', () => {
  const { db, create, row, set } = setup(); const created = replaySyncOperation(db, create);
  if (created.status !== 'applied') throw new Error('create failed');
  const appended = { ...row, syncUid: randomUUID(), content: 'appended', sortOrder: 1 };
  const append = syncReplayOperationSchema.parse({ ...create, opId: randomUUID(), operationKind: 'entry.content.append', baseValues: {}, payload: { parentCreateOpId: create.opId, content: { syncUid: appended.syncUid, contentType: appended.contentType, content: appended.content } } });
  expect(replaySyncOperation(db, append).status).toBe('applied');
  expect(replaySyncOperation(db, set()).status).toBe('conflict');
  db.prepare('UPDATE entries SET title = ? WHERE id = ?').run('concurrent title', created.entityId);
  const changed = { ...appended, content: 'updated appended' };
  expect(replaySyncOperation(db, set([row, appended], [row, changed])).status).toBe('applied');
  expect(replaySyncOperation(db, set([row, changed], [row])).status).toBe('applied');
  expect(db.prepare('SELECT title FROM entries WHERE id = ?').pluck().get(created.entityId)).toBe('concurrent title');
});
it('rejects wrong parent and tampered numeric create identity', () => {
  const { db, create, set } = setup(); replaySyncOperation(db, create);
  const operation = set();
  if (operation.operationKind !== 'entry.contents.set') throw new Error('set expected');
  const wrong = syncReplayOperationSchema.parse({ ...operation, payload: { ...operation.payload, parentCreateOpId: randomUUID() } });
  expect(replaySyncOperation(db, wrong).status).toBe('failed');
  const receipt = JSON.parse(String(db.prepare('SELECT result_json FROM sync_operation_receipts WHERE op_id = ?').pluck().get(create.opId))) as Record<string, unknown>;
  db.prepare('UPDATE sync_operation_receipts SET result_json = ? WHERE op_id = ?').run(JSON.stringify({ ...receipt, entityId: 1 }), create.opId);
  expect(replaySyncOperation(db, operation)).toMatchObject({ status: 'failed', errorCode: 'invalid-content' });
});
it('rolls back row identities, owner version, journal and receipt when receipt persistence fails', () => {
  const { db, create, set } = setup(); replaySyncOperation(db, create);
  const rows = db.prepare('SELECT * FROM entry_contents').all();
  const owner = db.prepare('SELECT * FROM entries').all();
  const journal = db.prepare('SELECT * FROM sync_changes').all();
  db.exec("CREATE TRIGGER fail_set_receipt BEFORE INSERT ON sync_operation_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;");
  const operation = set(); expect(() => replaySyncOperation(db, operation)).toThrow('receipt failure');
  expect(db.prepare('SELECT * FROM entry_contents').all()).toEqual(rows);
  expect(db.prepare('SELECT * FROM entries').all()).toEqual(owner);
  expect(db.prepare('SELECT * FROM sync_changes').all()).toEqual(journal);
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(0);
});

