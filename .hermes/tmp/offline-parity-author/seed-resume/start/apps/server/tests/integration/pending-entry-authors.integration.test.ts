import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { syncReplayOperationSchema } from '@t3/shared';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { getSyncIdentity, buildSyncCapabilities, buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function setup() {
  const db = createMigratedMemoryDatabase(); databases.push(db);
  createEntry(db, { title: 'Seed', type: 'comic' });
  const authors = [randomUUID(), randomUUID(), randomUUID()].sort();
  for (const uid of authors) db.prepare('INSERT INTO producers(name, sync_uid) VALUES (?, ?)').run(uid, uid);
  const envelope = { clientId: 'test', ...getSyncIdentity(db), entityKind: 'entry', entityUid: randomUUID(), clientCreatedAt: '2026-09-25T00:00:00Z' };
  const parentId = randomUUID();
  const create = syncReplayOperationSchema.parse({ ...envelope, opId: parentId, operationKind: 'entry.create', baseVersion: 0, baseValues: {}, payload: { title: 'Pending', type: 'comic', uploadDate: null, pageCount: null, ratings: [], viewLater: false } });
  const op = (base: string[] = [], desired: string[] = [authors[0]!]) => syncReplayOperationSchema.parse({ ...envelope, opId: randomUUID(), operationKind: 'entry.authors.set', baseVersion: 0, baseValues: { producerUids: base }, payload: { producerUids: desired, parentCreateOpId: parentId } });
  return { db, authors, create, op };
}
it('pending convergence keeps current revision without legacy padding', () => {
  const { db, create, op, authors } = setup(); const parent = replaySyncOperation(db, create);
  if (parent.status !== 'applied') throw new Error('create failed');
  replaySyncOperation(db, op());
  const version = db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(parent.entityId);
  const before = db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get();
  expect(replaySyncOperation(db, op(Array.from({ length: 10 }, () => randomUUID()), [authors[0]!]))).toMatchObject({ status: 'applied', entityId: parent.entityId, resourceVersion: version });
  expect(db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(before);
});
it('precreate remains unreceipted then retries against the applied parent identity', () => {
  const { db, create, op } = setup(); const operation = op();
  expect(replaySyncOperation(db, operation).status).toBe('failed');
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(0);
  const parent = replaySyncOperation(db, create);
  expect(parent.status).toBe('applied');
  expect(replaySyncOperation(db, operation)).toMatchObject({ status: 'applied', entityId: parent.status === 'applied' ? parent.entityId : -1 });
});

it('advertises pending Authors alongside global and existing Author support', () => {
  const { db } = setup(); const flags = buildSyncCapabilities(db, 'test').featureFlags;
  expect(flags.offlinePendingEntryAuthors).toBe(true);
  expect(flags.offlineMutations && flags.offlineEntryAuthors).toBe(true);
});

it('add remove chain merges metadata, preserves receipts and snapshots canonical identities', () => {
  const { db, create, op, authors } = setup(); const parent = replaySyncOperation(db, create);
  if (parent.status !== 'applied') throw new Error('create failed');
  const id = parent.entityId!;
  db.prepare('UPDATE entries SET title = ? WHERE id = ?').run('Concurrent', id);
  const operation = op(); const first = replaySyncOperation(db, operation);
  expect(first).toMatchObject({ status: 'applied', entityId: id });
  expect(replaySyncOperation(db, operation)).toEqual(first);
  expect(replaySyncOperation(db, syncReplayOperationSchema.parse({ ...operation, payload: { ...operation.payload, producerUids: [authors[1]!] } }))).toMatchObject({ status: 'failed', errorCode: 'operation-id-collision' });
  expect(replaySyncOperation(db, op([authors[0]!], authors.slice(0, 2))).status).toBe('applied');
  expect(replaySyncOperation(db, op(authors.slice(0, 2), [authors[1]!])).status).toBe('applied');
  const snapshot = buildSyncSnapshot(db);
  expect(snapshot.payload.entries).toContainEqual(expect.objectContaining({ id, syncUid: create.entityUid, title: 'Concurrent' }));
  const producer = snapshot.payload.producers.find(row => row.syncUid === authors[1])!;
  expect(snapshot.payload.entryProducers.filter(row => row.entryId === id)).toEqual([{ entryId: id, producerId: producer.id }]);
});
it('wrong parent UID and receipt numeric ID refuse changes', () => {
  const { db, create, op } = setup(); replaySyncOperation(db, create); const operation = op();
  for (const wrong of [{ ...operation, entityUid: randomUUID() }, { ...operation, payload: { ...operation.payload, parentCreateOpId: randomUUID() } }]) {
    expect(replaySyncOperation(db, syncReplayOperationSchema.parse(wrong)).status).toBe('failed');
  }
  db.prepare("UPDATE sync_operation_receipts SET result_json = json_set(result_json, '$.entityId', 1) WHERE op_id = ?").run(create.opId);
  expect(replaySyncOperation(db, operation)).toMatchObject({ status: 'failed', errorCode: 'invalid-author-data' });
  expect(db.prepare('SELECT COUNT(*) FROM entry_producers').pluck().get()).toBe(0);
});
it.each(['unknown', 'deleted'])('refuses the whole desired set containing an %s Author before removal', kind => {
  const { db, create, op, authors } = setup(); replaySyncOperation(db, create); replaySyncOperation(db, op());
  let missing = randomUUID();
  if (kind === 'deleted') { missing = authors[2]!; db.prepare('DELETE FROM producers WHERE sync_uid = ?').run(missing); }
  const before = db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get();
  expect(replaySyncOperation(db, op([authors[0]!], [authors[1]!, missing]))).toMatchObject({ status: 'failed', errorCode: 'invalid-author-data' });
  expect(db.prepare('SELECT COUNT(*) FROM entry_producers').pluck().get()).toBe(1);
  expect(db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(before);
});
it('complete base divergence conflicts without overwriting canonical links', () => {
  const { db, create, op, authors } = setup(); replaySyncOperation(db, create); replaySyncOperation(db, op());
  expect(replaySyncOperation(db, op([], [authors[1]!]))).toMatchObject({ status: 'conflict', currentValues: { producerUids: [authors[0]!] } });
});
it('later SQL insert abort restores earlier removal addition journal revision and receipt', () => {
  const { db, create, op, authors } = setup(); const parent = replaySyncOperation(db, create);
  if (parent.status !== 'applied') throw new Error('create failed');
  replaySyncOperation(db, op());
  const before = db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get();
  const version = db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(parent.entityId);
  const failingId = db.prepare('SELECT id FROM producers WHERE sync_uid = ?').pluck().get(authors[2]);
  db.exec("CREATE TRIGGER fail_later BEFORE INSERT ON entry_producers WHEN NEW.producer_id = " + String(failingId) + " BEGIN SELECT RAISE(ABORT, 'later failure'); END;");
  const operation = op([authors[0]!], authors.slice(1));
  expect(() => replaySyncOperation(db, operation)).toThrow('later failure');
  expect(db.prepare('SELECT sync_uid FROM producers JOIN entry_producers ON producer_id = producers.id').pluck().all()).toEqual([authors[0]]);
  expect(db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(before);
  expect(db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(parent.entityId)).toBe(version);
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(0);
});
