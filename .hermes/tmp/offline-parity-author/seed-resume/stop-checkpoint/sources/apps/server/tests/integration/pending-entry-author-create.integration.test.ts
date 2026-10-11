import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { syncReplayOperationSchema } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';

const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function setup() {
  const db = createMigratedMemoryDatabase(); databases.push(db);
  createEntry(db, { title: 'Seed', type: 'comic' });
  const envelope = { clientId: 'pending-author-create', ...getSyncIdentity(db), entityKind: 'entry', entityUid: randomUUID(), clientCreatedAt: '2026-09-25T00:00:00Z' };
  const parentId = randomUUID();
  const parent = syncReplayOperationSchema.parse({ ...envelope, opId: parentId, operationKind: 'entry.create', baseVersion: 0, baseValues: {}, payload: { title: 'Pending', type: 'comic', uploadDate: null, pageCount: null, ratings: [], viewLater: false } });
  const producerUid = randomUUID();
  const child = syncReplayOperationSchema.parse({ ...envelope, opId: randomUUID(), operationKind: 'entry.author.create-and-link', baseVersion: 0, baseValues: { producerUids: [] }, payload: { producerUid, name: 'New Author', parentCreateOpId: parentId } });
  return { db, parent, child, producerUid };
}
it('validates pending-only parent envelopes and preserves positive legacy envelopes', () => {
  const { child } = setup();
  expect(syncReplayOperationSchema.safeParse({ ...child, payload: { producerUid: randomUUID(), name: 'Legacy' } }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...child, baseVersion: 1 }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...child, baseVersion: 1, payload: { producerUid: randomUUID(), name: 'Legacy' } }).success).toBe(true);
});
it('checks parent UID and receipt numeric owner before writing a Producer', () => {
  const { db, parent, child } = setup();
  replaySyncOperation(db, parent);
  const wrongUid = syncReplayOperationSchema.parse({ ...child, entityUid: randomUUID() });
  expect(replaySyncOperation(db, wrongUid)).toMatchObject({ status: 'failed', errorCode: 'entity-not-found' });
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(child.opId)).toBe(0);
  db.prepare("UPDATE sync_operation_receipts SET result_json = json_set(result_json, '$.entityId', 1) WHERE op_id = ?").run(parent.opId);
  expect(replaySyncOperation(db, child)).toMatchObject({ status: 'failed', errorCode: 'invalid-author-data' });
  expect(db.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(0);
});
it('merges disjoint metadata but conflicts on an unseen Author link', () => {
  const { db, parent, child } = setup();
  const created = replaySyncOperation(db, parent);
  if (created.status !== 'applied') throw new Error('parent failed');
  db.prepare('UPDATE entries SET title = ? WHERE id = ?').run('Concurrent title', created.entityId);
  expect(replaySyncOperation(db, child).status).toBe('applied');
  const next = syncReplayOperationSchema.parse({ ...child, opId: randomUUID(), payload: { ...child.payload, producerUid: randomUUID(), name: 'Other' } });
  expect(replaySyncOperation(db, next)).toMatchObject({ status: 'conflict' });
  expect(db.prepare('SELECT title FROM entries WHERE id = ?').pluck().get(created.entityId)).toBe('Concurrent title');
  expect(db.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(1);
});
it.each(['name', 'alias'] as const)('never silently retargets a pending typed %s collision', kind => {
  const { db, parent, child } = setup(); replaySyncOperation(db, parent);
  if (kind === 'name') db.prepare('INSERT INTO producers(name, sync_uid) VALUES (?, ?)').run('ＮＥＷ AUTHOR', randomUUID());
  else db.prepare(`INSERT INTO taxonomy_aliases(vocabulary, partition, alias_name, normalized_alias, canonical_name, normalized_canonical) VALUES ('producer', 'authors', 'New Author', 'new author', 'Canonical', 'canonical')`).run();
  expect(replaySyncOperation(db, child).status).toBe('conflict');
  expect(db.prepare('SELECT COUNT(*) FROM entry_producers').pluck().get()).toBe(0);
});
it('rolls back pending Producer link revision journal and receipt on a receipt failure', () => {
  const { db, parent, child } = setup(); const created = replaySyncOperation(db, parent);
  if (created.status !== 'applied') throw new Error('parent failed');
  const before = db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get();
  const version = db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(created.entityId);
  db.exec("CREATE TRIGGER block_pending_author_receipt BEFORE INSERT ON sync_operation_receipts BEGIN SELECT RAISE(ABORT, 'receipt blocked'); END;");
  expect(() => replaySyncOperation(db, child)).toThrow('receipt blocked');
  expect(db.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(0);
  expect(db.prepare('SELECT COUNT(*) FROM entry_producers').pluck().get()).toBe(0);
  expect(db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(before);
  expect(db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(created.entityId)).toBe(version);
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(child.opId)).toBe(0);
});
it('pending new Author waits unreceipted for its parent then creates one stable Producer and supports unlink/relink', () => {
  const { db, parent, child, producerUid } = setup();
  expect(replaySyncOperation(db, child)).toMatchObject({ status: 'failed', errorCode: 'entity-not-found' });
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(child.opId)).toBe(0);
  const created = replaySyncOperation(db, parent);
  expect(created.status).toBe('applied');
  const linked = replaySyncOperation(db, child);
  expect(linked.status).toBe('applied');
  expect(replaySyncOperation(db, child)).toEqual(linked);
  expect(replaySyncOperation(db, syncReplayOperationSchema.parse({ ...child, payload: { ...child.payload, name: 'Changed retry body' } }))).toMatchObject({ status: 'failed', errorCode: 'operation-id-collision' });
  const producerId = db.prepare('SELECT id FROM producers WHERE sync_uid = ?').pluck().get(producerUid);
  expect(linked).toMatchObject({ entityId: producerId });
  const set = (base: string[], desired: string[]) => syncReplayOperationSchema.parse({ ...parent, opId: randomUUID(), operationKind: 'entry.authors.set', baseValues: { producerUids: base }, payload: { producerUids: desired, parentCreateOpId: parent.opId } });
  expect(replaySyncOperation(db, set([producerUid], [])).status).toBe('applied');
  expect(db.prepare('SELECT COUNT(*) FROM entry_producers').pluck().get()).toBe(0);
  expect(replaySyncOperation(db, set([], [producerUid])).status).toBe('applied');
  expect(db.prepare('SELECT COUNT(*) FROM producers WHERE sync_uid = ?').pluck().get(producerUid)).toBe(1);
  expect(db.prepare('SELECT COUNT(*) FROM entry_producers').pluck().get()).toBe(1);
});
