import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { syncReplayOperationSchema, syncReplayResultSchema } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';

it('atomically converts with a frozen creation UID, scoped prune and immutable exact-retry DTO', async () => {
  const db = createMigratedMemoryDatabase();
  const root = mkdtempSync(join(tmpdir(), 't3-canonical-conversion-'));
  try {
    const app = createApiApp(db, { dataDir: root, assetRoot: join(root, 'assets') });
    const entry = createEntry(db, { title: 'Anthology', type: 'comic' });
    const peer = createEntry(db, { title: 'Other work', type: 'comic' });
    const solo = createProducer(db, { name: 'A Solo' });
    const established = createProducer(db, { name: 'B Established' });
    const unrelated = createProducer(db, { name: 'Unrelated workless' });
    linkEntryProducer(db, entry.id, solo.id);
    linkEntryProducer(db, entry.id, established.id);
    linkEntryProducer(db, peer.id, established.id);
    const authors = [solo, established].map(author => ({
      producerUid: String(db.prepare('SELECT sync_uid FROM producers WHERE id = ?').pluck().get(author.id)),
      name: author.name,
      version: Number(db.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(author.id)),
      workUids: db.prepare('SELECT e.sync_uid FROM entry_producers ep JOIN entries e ON e.id = ep.entry_id WHERE ep.producer_id = ? ORDER BY e.sync_uid').pluck().all(author.id),
    }));
    const targetUid = randomUUID();
    const operation = {
      ...getSyncIdentity(db), opId: randomUUID(), clientId: 'canonical-conversion', entityKind: 'entry',
      entityUid: String(db.prepare('SELECT sync_uid FROM entries WHERE id = ?').pluck().get(entry.id)),
      clientCreatedAt: '2026-10-10T00:00:00Z', operationKind: 'entry.authors.convert-to-multi',
      baseVersion: Number(db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id)),
      baseValues: { authors, target: null }, payload: { targetUid },
    };
    const replay = async (body = operation) => {
      const response = await app.request('/api/sync/replay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return syncReplayResultSchema.parse(await response.json());
    };
    const result = await replay();
    expect(result.status).toBe('applied');
    const targetId = Number(db.prepare('SELECT id FROM producers WHERE sync_uid = ?').pluck().get(targetUid));
    expect(result).toMatchObject({ conversion: { entryId: entry.id, multiAuthorId: targetId, multiAuthorName: 'multiple author', convertedAuthors: [{ id: solo.id, name: solo.name }, { id: established.id, name: established.name }] } });
    expect(db.prepare('SELECT producer_id FROM entry_producers WHERE entry_id = ?').pluck().all(entry.id)).toEqual([targetId]);
    expect(db.prepare('SELECT COUNT(*) FROM producers WHERE id = ?').pluck().get(solo.id)).toBe(0);
    expect(db.prepare('SELECT entry_id FROM entry_producers WHERE producer_id = ?').pluck().all(established.id)).toEqual([peer.id]);
    expect(db.prepare('SELECT COUNT(*) FROM producers WHERE id = ?').pluck().get(unrelated.id)).toBe(1);
    const seq = db.prepare('SELECT MAX(seq) FROM sync_changes').pluck().get();
    expect(await replay()).toEqual(result);
    expect(db.prepare('SELECT MAX(seq) FROM sync_changes').pluck().get()).toBe(seq);
    expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(1);
    expect(await replay({ ...operation, payload: { targetUid: randomUUID() } })).toMatchObject({ status: 'failed', errorCode: 'operation-id-collision' });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

function fixture(reuse = false) {
  const db = createMigratedMemoryDatabase();
  const entry = createEntry(db, { title: 'Conversion', type: 'comic' });
  const authors = ['A', 'B'].map(name => createProducer(db, { name }));
  authors.forEach(author => linkEntryProducer(db, entry.id, author.id));
  const target = reuse ? createProducer(db, { name: 'MULTIPLE AUTHOR' }) : undefined;
  const targetUid = target ? String(db.prepare('SELECT sync_uid FROM producers WHERE id = ?').pluck().get(target.id)) : randomUUID();
  const entryUid = String(db.prepare('SELECT sync_uid FROM entries WHERE id = ?').pluck().get(entry.id));
  const operation = syncReplayOperationSchema.parse({ ...getSyncIdentity(db), opId: randomUUID(), clientId: 'canonical-finite',
    entityKind: 'entry', entityUid: entryUid, clientCreatedAt: '2026-10-10T00:00:00Z', operationKind: 'entry.authors.convert-to-multi',
    baseVersion: Number(db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id)),
    baseValues: { authors: authors.map(author => ({ name: author.name,
      producerUid: String(db.prepare('SELECT sync_uid FROM producers WHERE id = ?').pluck().get(author.id)),
      version: Number(db.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(author.id)), workUids: [entryUid],
    })), target: target ? { producerUid: targetUid, version: 1 } : null }, payload: { targetUid },
  });
  return { db, entry, authors, target, targetUid, operation };
}
function businessState(db: ReturnType<typeof createMigratedMemoryDatabase>) {
  return ['entries', 'producers', 'entry_producers', 'sync_changes', 'sync_tombstones', 'sync_offline_created_producers']
    .map(table => db.prepare(`SELECT * FROM ${table}`).all());
}
it('reuses the earliest SQLite NOCASE target without replacing its identity', () => {
  const { db, operation, target, targetUid } = fixture(true);
  try {
    createProducer(db, { name: 'multiple author' });
    const result = replaySyncOperation(db, operation);
    expect(result).toMatchObject({ status: 'applied', conversion: { multiAuthorId: target?.id, multiAuthorName: 'multiple author' } });
    expect(db.prepare('SELECT sync_uid FROM producers WHERE id = ?').pluck().get(target?.id)).toBe(targetUid);
    expect(db.prepare("SELECT COUNT(*) FROM producers WHERE name = 'multiple author' COLLATE NOCASE").pluck().get()).toBe(2);
  } finally { db.close(); }
});
it('rolls back target credits prune journals tombstones origin and receipt when receipt SQL aborts', () => {
  const { db, operation } = fixture();
  try {
    const before = businessState(db);
    db.exec("CREATE TRIGGER block_conversion_receipt BEFORE INSERT ON sync_operation_receipts BEGIN SELECT RAISE(ABORT, 'conversion receipt blocked'); END;");
    expect(() => replaySyncOperation(db, operation)).toThrow('conversion receipt blocked');
    expect(businessState(db)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(0);
  } finally { db.close(); }
});
it.each(['author-version', 'other-work', 'target-race', 'foreign-target-uid'] as const)('fails closed atomically on %s', race => {
  const { db, entry, authors, operation, targetUid } = fixture();
  try {
    if (race === 'author-version') db.prepare('UPDATE producers SET name = ? WHERE id = ?').run('Changed', authors[0]?.id);
    if (race === 'other-work') linkEntryProducer(db, createEntry(db, { title: 'Raced peer', type: 'comic' }).id, authors[0]!.id);
    if (race === 'target-race') createProducer(db, { name: 'Multiple Author' });
    if (race === 'foreign-target-uid') db.prepare('INSERT INTO producers (name, sync_uid) VALUES (?, ?)').run('Not a target', targetUid);
    const before = businessState(db);
    expect(replaySyncOperation(db, operation)).toMatchObject({ status: 'conflict' });
    expect(businessState(db)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) FROM entry_producers WHERE entry_id = ?').pluck().get(entry.id)).toBe(2);
  } finally { db.close(); }
});

it('holds unsupported schema capability without migrating or mutating business rows', () => {
  const { db, operation } = fixture();
  try {
    db.prepare('DELETE FROM schema_migrations WHERE version = 43').run();
    const before = businessState(db);
    expect(replaySyncOperation(db, operation)).toMatchObject({ status: 'failed', errorCode: 'invalid-author-data' });
    expect(businessState(db)).toEqual(before);
    expect(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()).toBe(42);
    expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(0);
  } finally { db.close(); }
});
