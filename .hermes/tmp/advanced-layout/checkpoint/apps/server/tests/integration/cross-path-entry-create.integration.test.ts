import { afterEach, describe, expect, it } from 'vitest';
import { syncReplayOperationSchema } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { createEntry, deleteEntry } from '../../src/repositories/entry-repository.js';
import type { T3Database } from '../../src/database/connection.js';

const databases: T3Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const entryUid = '11111111-1111-4111-8111-111111111111';
const opId = '22222222-2222-4222-8222-222222222222';
const contentUid = '33333333-3333-4333-8333-333333333333';
function setup() {
  const database = createMigratedMemoryDatabase(); databases.push(database);
  const app = createApiApp(database);
  const post = (body: Record<string, unknown>) => app.request('/api/entries', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const operation = syncReplayOperationSchema.parse({
    ...getSyncIdentity(database), clientId: 'client', opId, entityKind: 'entry', entityUid: entryUid,
    clientCreatedAt: '2026-09-28T12:00:00.000Z', operationKind: 'entry.create', baseVersion: 0,
    baseValues: {}, payload: { title: 'New', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: true, contents: [{ syncUid: contentUid, contentType: 'Note', content: 'draft', sortOrder: 0 }] },
  });
  if (operation.operationKind !== 'entry.create') throw new Error('Invalid create fixture');
  return { database, app, post, operation };
}

describe('cross-path online Entry create claim', () => {
  it('atomically adopts a committed POST on exact offline retry, applying its offline-only data once', async () => {
    const { database, post, operation } = setup();
    const response = await post({ title: 'New', type: 'game', syncUid: entryUid });
    expect(response.status).toBe(201);
    const created = await response.json() as { id: number };
    const result = replaySyncOperation(database, operation);
    expect(result).toMatchObject({ status: 'applied', entityId: created.id });
    expect(replaySyncOperation(database, operation)).toEqual(result);
    expect(database.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?').pluck().get(entryUid)).toBe(1);
    expect(database.prepare('SELECT content FROM entry_contents WHERE sync_uid = ?').pluck().get(contentUid)).toBe('draft');
    expect(database.prepare('SELECT COUNT(*) FROM view_later_entries WHERE entry_id = ?').pluck().get(created.id)).toBe(1);
    expect(database.prepare('SELECT create_op_id FROM sync_offline_created_entries WHERE entry_uid = ?').pluck().get(entryUid)).toBe(opId);
  });
  it('does not resurrect a deleted claimed Entry when the same online POST is retried', async () => {
    const { database, post } = setup();
    const body = { title: 'New', type: 'game', syncUid: entryUid };
    const first = await (await post(body)).json() as { id: number };
    deleteEntry(database, first.id);
    expect(database.prepare("SELECT COUNT(*) FROM sync_tombstones WHERE entity_kind = 'entry' AND entity_uid = ?")
      .pluck().get(entryUid)).toBe(1);
    expect((await post(body)).status).toBe(409);
    expect(database.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?').pluck().get(entryUid)).toBe(0);
  });
  it('does not resurrect a deleted online Entry through an offline fallback either', async () => {
    const { database, post, operation } = setup();
    createEntry(database, { title: 'Retain Gallery', type: 'game' });
    const first = await (await post({ title: 'New', type: 'game', syncUid: entryUid })).json() as { id: number };
    deleteEntry(database, first.id);
    expect(replaySyncOperation(database, operation)).toMatchObject({
      status: 'failed', errorCode: 'entity-already-exists',
    });
    expect(database.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?').pluck().get(entryUid)).toBe(0);
  });
  it('rolls back the online Entry when its claim insert fails', async () => {
    const { database, post } = setup();
    database.exec(`CREATE TRIGGER reject_claim BEFORE INSERT ON sync_online_entry_creates
      BEGIN SELECT RAISE(ABORT, 'claim insert failed'); END;`);
    expect((await post({ title: 'New', type: 'game', syncUid: entryUid })).status).toBe(409);
    expect(database.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?').pluck().get(entryUid)).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM sync_online_entry_creates WHERE entry_uid = ?')
      .pluck().get(entryUid)).toBe(0);
  });
  it('rolls back an adoption and leaves the claim unused when Content insert fails', async () => {
    const { database, post, operation } = setup();
    expect((await post({ title: 'New', type: 'game', syncUid: entryUid })).status).toBe(201);
    database.exec(`CREATE TRIGGER reject_content BEFORE INSERT ON entry_contents
      BEGIN SELECT RAISE(ABORT, 'content insert failed'); END;`);
    expect(() => replaySyncOperation(database, operation)).toThrow('content insert failed');
    expect(database.prepare('SELECT adopted_op_id FROM sync_online_entry_creates WHERE entry_uid = ?')
      .pluck().get(entryUid)).toBeNull();
    expect(database.prepare('SELECT COUNT(*) FROM sync_offline_created_entries WHERE entry_uid = ?')
      .pluck().get(entryUid)).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(opId)).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM entry_contents WHERE sync_uid = ?').pluck().get(contentUid)).toBe(0);
  });
  it('refuses to adopt a claim after the online Entry was edited by another client', async () => {
    const { database, post, operation } = setup();
    const created = await post({ title: 'New', type: 'game', syncUid: entryUid });
    expect(created.status).toBe(201);
    database.prepare('UPDATE entries SET title = ? WHERE sync_uid = ?').run('Peer edit', entryUid);
    expect(replaySyncOperation(database, operation)).toMatchObject({
      status: 'failed', errorCode: 'entity-already-exists',
    });
    expect(database.prepare('SELECT COUNT(*) FROM entry_contents WHERE sync_uid = ?').pluck().get(contentUid)).toBe(0);
    expect(database.prepare('SELECT adopted_op_id FROM sync_online_entry_creates WHERE entry_uid = ?')
      .pluck().get(entryUid)).toBeNull();
  });
  it('returns the existing identity for an exact POST retry, but rejects changed metadata or an unrelated UID collision', async () => {
    const { database, post, operation } = setup();
    const body = { title: 'New', type: 'game', syncUid: entryUid };
    const first = await post(body);
    expect(first.status).toBe(201);
    const existing = await first.json() as { id: number };
    const retry = await post(body);
    expect(retry.status).toBe(200);
    expect((await retry.json() as { id: number }).id).toBe(existing.id);
    expect((await post({ ...body, title: 'Changed' })).status).toBe(409);
    expect(database.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(1);
    const changed = { ...operation, opId: '44444444-4444-4444-8444-444444444444', payload: { ...operation.payload, title: 'Changed' } };
    expect(replaySyncOperation(database, syncReplayOperationSchema.parse(changed))).toMatchObject({ status: 'failed' });
    expect(replaySyncOperation(database, operation)).toMatchObject({ status: 'applied', entityId: existing.id });
    const second = { ...operation, opId: '55555555-5555-4555-8555-555555555555' };
    expect(replaySyncOperation(database, syncReplayOperationSchema.parse(second))).toMatchObject({ status: 'failed' });
    expect(database.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(1);
  });
});
