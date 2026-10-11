import { afterEach, describe, expect, it } from 'vitest';
import { syncReplayOperationSchema, syncSnapshotSchema } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import type { T3Database } from '../../src/database/connection.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { getSyncIdentity, buildSyncCapabilities } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { createApiApp } from '../../src/http/app.js';

const databases: T3Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const entryUid = '22222222-2222-4222-8222-222222222222';
const contentUid = '33333333-3333-4333-8333-333333333333';
const createOpId = '11111111-1111-4111-8111-111111111111';
const appendOpId = '44444444-4444-4444-8444-444444444444';
function setup() {
  const db = createMigratedMemoryDatabase(); databases.push(db);
  createEntry(db, { title: 'Seed', type: 'game' });
  const envelope = { clientId: 'client', ...getSyncIdentity(db), entityKind: 'entry', entityUid: entryUid, clientCreatedAt: '2026-09-28T12:00:00.000Z' };
  const create = syncReplayOperationSchema.parse({ ...envelope, opId: createOpId, operationKind: 'entry.create', baseVersion: 0, baseValues: {}, payload: { title: 'New', type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false } });
  const append = () => {
    const operation = syncReplayOperationSchema.parse({ ...envelope, opId: appendOpId, operationKind: 'entry.content.append', baseVersion: 0, baseValues: {}, payload: { parentCreateOpId: createOpId, content: { syncUid: contentUid, contentType: 'Source URL', content: 'https://example.test/after' } } });
    if (operation.operationKind !== 'entry.content.append') throw new Error('Expected append operation');
    return operation;
  };
  return { db, create, append };
}
describe('causal post-create Content append', () => {
  it('advertises its own capability and accepts a strictly shaped independent operation', () => {
    const { db, append } = setup();
    expect(buildSyncCapabilities(db, 'test').featureFlags.offlineEntryContentAppend).toBe(true);
    expect(append().operationKind).toBe('entry.content.append');
    expect(syncReplayOperationSchema.safeParse({ ...append(), payload: { ...append().payload, contents: [] } }).success).toBe(false);
  });
  it('requires the successful matching create receipt, then appends without replacing initial or concurrent Content', async () => {
    const { db, create, append } = setup();
    expect(replaySyncOperation(db, append()).status).not.toBe('applied');
    const created = replaySyncOperation(db, create);
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('create failed');
    db.prepare('INSERT INTO entry_contents (entry_id, content_type, content, sort_order) VALUES (?, ?, ?, ?)').run(created.entityId, 'Note', 'concurrent', 7);
    const first = replaySyncOperation(db, append());
    expect(first.status).toBe('applied');
    expect(replaySyncOperation(db, append())).toEqual(first);
    expect(db.prepare('SELECT sync_uid AS uid, content, sort_order AS sortOrder FROM entry_contents WHERE entry_id = ? ORDER BY sort_order').all(created.entityId)).toEqual([
      expect.objectContaining({ content: 'concurrent', sortOrder: 7 }),
      { uid: contentUid, content: 'https://example.test/after', sortOrder: 8 },
    ]);
    expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id IN (?, ?)').pluck().get(createOpId, appendOpId)).toBe(2);
    const snapshot = syncSnapshotSchema.parse(await (await createApiApp(db).request('/api/sync/snapshot?media=none')).json());
    expect(snapshot.payload.entryContents).toContainEqual(expect.objectContaining({ entryId: created.entityId, syncUid: contentUid }));
  });
  it('rejects a borrowed Content UUID and changed-body op ID without writing', () => {
    const { db, create, append } = setup();
    replaySyncOperation(db, create);
    db.prepare('INSERT INTO entry_contents (entry_id, sync_uid, content_type, content, sort_order) VALUES (1, ?, ?, ?, 0)').run(contentUid, 'Note', 'other');
    const result = replaySyncOperation(db, append());
    expect(result.status).not.toBe('applied');
    expect(db.prepare('SELECT COUNT(*) FROM entry_contents WHERE sync_uid = ?').pluck().get(contentUid)).toBe(1);
    const different = syncReplayOperationSchema.parse({ ...append(), payload: { ...append().payload, content: { ...append().payload.content, content: 'changed' } } });
    expect(replaySyncOperation(db, different)).toMatchObject({ status: 'failed', errorCode: 'operation-id-collision' });
  });
  it('refuses another parent receipt even when the Entry UID exists', () => {
    const { db, create, append } = setup();
    replaySyncOperation(db, create);
    const wrong = syncReplayOperationSchema.parse({ ...append(), payload: { ...append().payload, parentCreateOpId: '55555555-5555-4555-8555-555555555555' } });
    expect(replaySyncOperation(db, wrong).status).not.toBe('applied');
    expect(db.prepare('SELECT COUNT(*) FROM entry_contents WHERE sync_uid = ?').pluck().get(contentUid)).toBe(0);
  });
  it('adopts an online-created Entry after a lost response without duplicating it or allowing identity edits', async () => {
    const { db, create } = setup();
    const response = await createApiApp(db).request('/api/entries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New', type: 'game', syncUid: entryUid }),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as { id: number };
    expect(db.prepare('SELECT sync_uid FROM entries WHERE id = ?').pluck().get(created.id)).toBe(entryUid);
    const changeIdentity = await createApiApp(db).request(`/api/entries/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncUid: '33333333-3333-4333-8333-333333333333' }),
    });
    expect(changeIdentity.status).toBe(400);
    expect(replaySyncOperation(db, create)).toMatchObject({ status: 'applied', entityId: created.id });
    expect(db.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?').pluck().get(entryUid)).toBe(1);
  });
  it('rolls back Content, journal and receipt on insert failure', () => {
    const { db, create, append } = setup(); replaySyncOperation(db, create);
    const before = db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get();
    db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON entry_contents BEGIN SELECT RAISE(ABORT, 'append failure'); END;");
    expect(() => replaySyncOperation(db, append())).toThrow('append failure');
    expect(db.prepare('SELECT COUNT(*) FROM entry_contents WHERE sync_uid = ?').pluck().get(contentUid)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(appendOpId)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(before);
  });
});
