import { randomUUID } from 'node:crypto';
import type { SyncSnapshot } from '@t3/shared';
import { listEntrySources } from '../../src/repositories/source-library-repository.js';
import { buildSyncCapabilities, buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { afterEach, describe, expect, it } from 'vitest';
import { syncReplayOperationSchema, syncSnapshotSchema } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import type { T3Database } from '../../src/database/connection.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createApiApp } from '../../src/http/app.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';

const databases: T3Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function setup() {
  const db = createMigratedMemoryDatabase();
  databases.push(db);
  createEntry(db, { title: 'Seed', type: 'game' });
  const identity = getSyncIdentity(db);
  const operation = syncReplayOperationSchema.parse({
    opId: '11111111-1111-4111-8111-111111111111', clientId: 'client',
    ...identity, entityKind: 'entry', entityUid: '22222222-2222-4222-8222-222222222222',
    clientCreatedAt: '2026-09-27T12:00:00.000Z', operationKind: 'entry.create',
    baseVersion: 0, baseValues: {}, payload: {
      title: 'New', type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false,
      contents: [{ syncUid: '33333333-3333-4333-8333-333333333333', contentType: 'Source URL', content: 'https://example.test/new', sortOrder: 0 }],
    },
  });
  if (operation.operationKind !== 'entry.create') throw new Error('Expected entry.create');
  return { db, operation };
}

describe('atomic initial offline Entry Content', () => {
  it('reconciles a durable Source and Note through a lost real-SQL create response and facade restart', async () => {
    const { db } = setup();
    // Runtime-only test bridge: do not pull Web source/import.meta.env into
    // the server TypeScript build's rootDir. All operations still run for real.
    const webModules = ['../../../web/src/offline/offline-api.js',
      '../../../web/src/offline/snapshot-store.js', '../../../web/src/offline/outbox-store.js',
      '../../../web/src/offline/media-outbox-store.js'];
    const [facade, snapshots, outboxes, mediaOutboxes] = await Promise.all(webModules.map((path) => import(path)));
    const { createOfflineAwareGalleryApi } = facade;
    const { createMemorySnapshotStore, readActiveSnapshot, ACTIVE_GENERATION_KEY } = snapshots;
    const { createMemoryOutboxStore } = outboxes;
    const { createMemoryMediaOutboxStore } = mediaOutboxes;
    const snapshotStore = createMemorySnapshotStore();
    const outbox = createMemoryOutboxStore();
    const media = createMemoryMediaOutboxStore((operation: Parameters<typeof replaySyncOperation>[1]) => outbox.enqueue(operation));
    const store = { ...snapshotStore, ...outbox, ...media };
    await store.writeGeneration(1, JSON.stringify(buildSyncSnapshot(db)));
    await store.writeMeta(ACTIVE_GENERATION_KEY, '1');
    let loseReply = true;
    const online = {
      getSyncCapabilities: async () => buildSyncCapabilities(db, 'source-test'),
      replaySyncOperation: async (operation: Parameters<typeof replaySyncOperation>[1]) => {
        const result = replaySyncOperation(db, operation);
        if (loseReply) { loseReply = false; throw new TypeError('committed create response lost'); }
        return result;
      },
      fetchSyncSnapshot: async () => buildSyncSnapshot(db),
    };
    const options = { clientId: 'source-client', randomUUID };
    const api = createOfflineAwareGalleryApi(online, store, options);
    await api.getSyncCapabilities();
    await api.enqueueOfflineEntryCreate!({
      title: 'Source with note', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: false, coverFile: null, previewFile: null,
      contents: [
        { contentType: 'Source URL', content: 'https://example.test/read#page-2' },
        { contentType: 'Notes', content: 'Preserve the next row' },
      ],
    });
    const original = await store.list();
    const uids = (original[0]!.payload as { contents: Array<{ syncUid: string }> }).contents.map((content) => content.syncUid);
    expect(new Set(uids).size).toBe(2);
    await api.flushOfflineOutbox!();
    expect(await store.list()).toHaveLength(1);
    const entryId = Number(db.prepare('SELECT id FROM entries WHERE sync_uid = ?').pluck().get(original[0]!.entityUid));
    expect(listEntrySources(db, entryId)).toMatchObject([
      { entryId, url: 'https://example.test/read', sourceKey: 'host:example.test' },
    ]);
    const restarted = createOfflineAwareGalleryApi(online, store, options);
    expect((await restarted.listPendingOfflineEntryCreates!())[0]?.contents).toEqual([
      { syncUid: uids[0], contentType: 'Source URL', content: 'https://example.test/read#page-2', sortOrder: 0 },
      { syncUid: uids[1], contentType: 'Notes', content: 'Preserve the next row', sortOrder: 1 },
    ]);
    expect((await store.list())[0]?.payload).toEqual(original[0]?.payload);
    await restarted.flushOfflineOutbox!();
    const active = await readActiveSnapshot(store) as { snapshot: SyncSnapshot } | null;
    expect(active?.snapshot.payload.entryContents.filter((content) => content.entryId === entryId)
      .map(({ syncUid, contentType, content, sortOrder }) => ({ syncUid, contentType, content, sortOrder })))
      .toEqual([
        { syncUid: uids[0], contentType: 'Source URL', content: 'https://example.test/read#page-2', sortOrder: 0 },
        { syncUid: uids[1], contentType: 'Notes', content: 'Preserve the next row', sortOrder: 1 },
      ]);
    expect(await store.list()).toEqual([]);
    expect(await restarted.listPendingOfflineEntryCreates!()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?').pluck().get(original[0]!.entityUid)).toBe(1);
    expect(listEntrySources(db, entryId)).toHaveLength(1);
  });

  it('persists the exact Content UUID before receipt and deduplicates an identical retry', () => {
    const { db, operation } = setup();
    const first = replaySyncOperation(db, operation);
    expect(first.status).toBe('applied');
    expect(replaySyncOperation(db, operation)).toEqual(first);
    expect(db.prepare('SELECT sync_uid AS syncUid, content_type AS contentType, content, sort_order AS sortOrder FROM entry_contents WHERE entry_id = ?').all(first.status === 'applied' ? first.entityId : -1))
      .toEqual(operation.payload.contents?.map(({ syncUid, contentType, content, sortOrder }) => ({ syncUid, contentType, content, sortOrder })));
    expect(db.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?').pluck().get(operation.entityUid)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(1);
  });

  it('returns the replayed Content identity through the authoritative snapshot', async () => {
    const { db, operation } = setup();
    const receipt = replaySyncOperation(db, operation);
    if (receipt.status !== 'applied') throw new Error('Expected applied create');
    const response = await createApiApp(db).request('/api/sync/snapshot?media=none');
    expect(response.status).toBe(200);
    const snapshot = syncSnapshotSchema.parse(await response.json());
    expect(snapshot.payload.entryContents).toContainEqual(expect.objectContaining({
      entryId: receipt.entityId,
      syncUid: operation.payload.contents![0]!.syncUid,
      contentType: 'Source URL',
      content: 'https://example.test/new',
      sortOrder: 0,
    }));
  });

  it('rejects a Content UUID already owned by another Entry without creating anything', () => {
    const { db, operation } = setup();
    db.prepare('INSERT INTO entry_contents (entry_id, sync_uid, content_type, content, sort_order) VALUES (1, ?, ?, ?, 0)')
      .run(operation.payload.contents![0]!.syncUid, 'Source URL', 'https://existing.test');
    const result = replaySyncOperation(db, operation);
    expect(result.status).not.toBe('applied');
    expect(db.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?').pluck().get(operation.entityUid)).toBe(0);
  });

  it('rolls back Entry, Content and receipt when a Content insert fails', () => {
    const { db, operation } = setup();
    const before = db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get();
    db.exec("CREATE TRIGGER fail_initial_content BEFORE INSERT ON entry_contents BEGIN SELECT RAISE(ABORT, 'forced initial content failure'); END;");
    expect(() => replaySyncOperation(db, operation)).toThrow('forced initial content failure');
    expect(db.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?').pluck().get(operation.entityUid)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(before);
  });
});
