import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase, createTempFileDatabase } from '../../src/database/testing.js';
import { openDatabase, type T3Database } from '../../src/database/connection.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createApiApp } from '../../src/http/app.js';
import {
  createEntryContent,
  deleteEntryContent,
} from '../../src/repositories/entry-content-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createRatingSlot, setEntryRating } from '../../src/repositories/rating-repository.js';
import { setGalleryPartition } from '../../src/repositories/partition-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { getSyncIdentity, rotateSyncEpoch } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import {
  syncMediaUploadResultSchema,
  syncReplayOperationSchema,
  syncReplayResultSchema,
  syncSnapshotSchema,
} from '@t3/shared';

const databases: T3Database[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function seed(database: T3Database): void {
  const author = createProducer(database, { name: 'Hypergryph' });
  const entry = createEntry(database, { title: 'Endfield', type: 'game' });
  linkEntryProducer(database, entry.id, author.id);
  createEntryContent(database, {
    entryId: entry.id,
    contentType: 'Source URL',
    content: 'https://hitomi.la/g/1.html',
    sortOrder: 0,
  });
  setGalleryPartition(database, 'game', true);
  database.prepare(`
    UPDATE entries
    SET cover_ref = ?, preview_ref = ?, preview_refs = ?
    WHERE title = ?
  `).run(
    'assets/game/endfield/cover.jpg',
    'assets/game/endfield/preview.jpg',
    JSON.stringify([
      'assets/game/endfield/page-1.jpg',
      'assets/game/endfield/page-2.jpg',
    ]),
    'Endfield',
  );
}

describe('offline sync service and routes', () => {
  it('exposes stable capabilities with a persistent library identity', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const app = createApiApp(database);

    const first = await app.request('/api/sync/capabilities');
    expect(first.status).toBe(200);
    const capabilities = await first.json() as {
      libraryId: string;
      syncEpoch: string;
      sqliteSchemaVersion: number;
      snapshotFormatVersion: number;
      featureFlags: Record<string, boolean>;
    };
    expect(capabilities.sqliteSchemaVersion).toBe(24);
    expect(capabilities.snapshotFormatVersion).toBe(2);
    expect(capabilities.featureFlags).toMatchObject({
      offlineMutations: true,
      offlineEntryUpdate: true,
      offlineEntryCreate: true,
      offlineMediaUpload: true,
      offlineUsageEvents: true,
      offlineEntryViewLater: true,
      offlineEntryRating: true,
    });
    expect(getSyncIdentity(database).libraryId).toBe(capabilities.libraryId);

    const second = await app.request('/api/sync/capabilities');
    expect((await second.json() as { libraryId: string }).libraryId).toBe(capabilities.libraryId);
  });

  it('replays View and Like events exactly once and journals each applied event', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const entry = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion
      FROM entries WHERE title = 'Endfield'
    `).get() as { id: number; syncUid: string; syncVersion: number };
    const beforeSeq = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());
    const base = {
      clientId: 'android-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry' as const,
      entityUid: entry.syncUid,
      operationKind: 'entry.usage' as const,
      baseVersion: 0 as const,
      baseValues: {},
      clientCreatedAt: '2026-09-20T12:00:00.000Z',
    };
    const view = syncReplayOperationSchema.parse({
      ...base,
      opId: '12121212-1212-4212-8212-121212121212',
      payload: { event: 'view' },
    });

    const firstView = replaySyncOperation(database, view);
    expect(firstView).toMatchObject({
      opId: view.opId,
      status: 'applied',
      resourceVersion: entry.syncVersion + 1,
    });
    expect(firstView.status === 'applied' ? firstView.serverSeq : -1).toBeGreaterThan(beforeSeq);
    expect(database.prepare(`
      SELECT view_count AS viewCount, like_count AS likeCount, last_viewed_at AS lastViewedAt
      FROM entry_usage WHERE entry_id = ?
    `).get(entry.id)).toEqual({
      viewCount: 1,
      likeCount: 0,
      lastViewedAt: '2026-09-20T12:00:00.000Z',
    });

    expect(replaySyncOperation(database, view)).toEqual(firstView);
    expect(database.prepare('SELECT view_count FROM entry_usage WHERE entry_id = ?').pluck().get(entry.id)).toBe(1);
    expect(replaySyncOperation(database, syncReplayOperationSchema.parse({
      ...view,
      payload: { event: 'like' },
    }))).toMatchObject({ status: 'failed', errorCode: 'operation-id-collision' });

    const like = syncReplayOperationSchema.parse({
      ...base,
      opId: '34343434-3434-4434-8434-343434343434',
      payload: { event: 'like' },
    });
    const firstLike = replaySyncOperation(database, like);
    expect(firstLike).toMatchObject({ status: 'applied', resourceVersion: entry.syncVersion + 2 });
    expect(replaySyncOperation(database, like)).toEqual(firstLike);
    expect(database.prepare(`
      SELECT view_count AS viewCount, like_count AS likeCount
      FROM entry_usage WHERE entry_id = ?
    `).get(entry.id)).toEqual({ viewCount: 1, likeCount: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id IN (?, ?)
    `).pluck().get(view.opId, like.opId)).toBe(2);
  });

  it('replays Entry View later desired state in order and conflicts on a stale non-convergent revision', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const entry = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion
      FROM entries WHERE title = 'Endfield'
    `).get() as { id: number; syncUid: string; syncVersion: number };
    const makeOperation = (
      opId: string,
      baseVersion: number,
      present: boolean,
      desired: boolean,
    ) => syncReplayOperationSchema.parse({
      opId,
      clientId: 'android-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry',
      entityUid: entry.syncUid,
      operationKind: 'entry.view-later.set',
      baseVersion,
      baseValues: { present },
      payload: { present: desired },
      clientCreatedAt: '2026-09-20T12:00:00.000Z',
    });

    const add = makeOperation(
      '81818181-8181-4181-8181-818181818181',
      entry.syncVersion,
      false,
      true,
    );
    const added = replaySyncOperation(database, add);
    expect(added).toMatchObject({ status: 'applied', resourceVersion: entry.syncVersion + 1 });
    expect(replaySyncOperation(database, add)).toEqual(added);
    expect(database.prepare(`
      SELECT entry_id FROM view_later_entries WHERE entry_id = ?
    `).pluck().get(entry.id)).toBe(entry.id);

    const convergent = makeOperation(
      '82828282-8282-4282-8282-828282828282',
      entry.syncVersion,
      false,
      true,
    );
    expect(replaySyncOperation(database, convergent)).toMatchObject({
      status: 'applied',
      resourceVersion: entry.syncVersion + 1,
    });

    const remove = makeOperation(
      '83838383-8383-4383-8383-838383838383',
      entry.syncVersion + 1,
      true,
      false,
    );
    expect(replaySyncOperation(database, remove)).toMatchObject({
      status: 'applied',
      resourceVersion: entry.syncVersion + 2,
    });
    expect(database.prepare(`
      SELECT COUNT(*) FROM view_later_entries WHERE entry_id = ?
    `).pluck().get(entry.id)).toBe(0);

    database.prepare(`
      UPDATE entries SET title = title || ' changed online' WHERE id = ?
    `).run(entry.id);
    const staleAdd = makeOperation(
      '84848484-8484-4484-8484-848484848484',
      entry.syncVersion + 2,
      false,
      true,
    );
    expect(replaySyncOperation(database, staleAdd)).toMatchObject({
      status: 'conflict',
      currentVersion: entry.syncVersion + 3,
      currentValues: { present: false },
    });
    expect(database.prepare(`
      SELECT COUNT(*) FROM view_later_entries WHERE entry_id = ?
    `).pluck().get(entry.id)).toBe(0);
  });

  it('replays Entry rating desired state exactly once, merges disjoint revisions, and exposes conflicts', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const entry = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion
      FROM entries WHERE title = 'Endfield'
    `).get() as { id: number; syncUid: string; syncVersion: number };
    const slot = createRatingSlot(database, { kind: 'entry', entryType: 'game', name: 'Quality' });
    const slotUid = database.prepare('SELECT sync_uid FROM rating_slots WHERE id = ?')
      .pluck().get(slot.id) as string;
    const makeOperation = (
      opId: string,
      baseVersion: number,
      baseStars: number | null,
      stars: number | null,
    ) => syncReplayOperationSchema.parse({
      opId,
      clientId: 'android-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry',
      entityUid: entry.syncUid,
      operationKind: 'entry.rating.set',
      baseVersion,
      baseValues: { slotUid, stars: baseStars },
      payload: { slotUid, stars },
      clientCreatedAt: '2026-09-21T12:00:00.000Z',
    });

    const initial = makeOperation(
      '91919191-9191-4191-8191-919191919191', entry.syncVersion, null, 4.5,
    );
    const applied = replaySyncOperation(database, initial);
    expect(applied).toMatchObject({ status: 'applied', resourceVersion: entry.syncVersion + 1 });
    expect(replaySyncOperation(database, initial)).toEqual(applied);
    expect(database.prepare(`
      SELECT stars FROM entry_rating_values WHERE entry_id = ? AND slot_id = ?
    `).pluck().get(entry.id, slot.id)).toBe(4.5);

    const convergent = makeOperation(
      '92929292-9292-4292-8292-929292929292', entry.syncVersion, null, 4.5,
    );
    expect(replaySyncOperation(database, convergent)).toMatchObject({
      status: 'applied', resourceVersion: entry.syncVersion + 1,
    });

    database.prepare(`UPDATE entries SET title = title || ' online' WHERE id = ?`).run(entry.id);
    const disjoint = makeOperation(
      '93939393-9393-4393-8393-939393939393', entry.syncVersion + 1, 4.5, 5,
    );
    expect(replaySyncOperation(database, disjoint)).toMatchObject({
      status: 'applied', resourceVersion: entry.syncVersion + 3,
    });

    const beforeOnlineRating = entry.syncVersion + 3;
    setEntryRating(database, { entryId: entry.id, slotId: slot.id, stars: 3 });
    expect(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id))
      .toBe(beforeOnlineRating + 1);
    const conflict = makeOperation(
      '94949494-9494-4494-8494-949494949494', beforeOnlineRating, 5, 4,
    );
    expect(replaySyncOperation(database, conflict)).toMatchObject({
      status: 'conflict',
      currentVersion: beforeOnlineRating + 1,
      currentValues: { slotUid, stars: 3 },
    });
    expect(database.prepare(`
      SELECT stars FROM entry_rating_values WHERE entry_id = ? AND slot_id = ?
    `).pluck().get(entry.id, slot.id)).toBe(3);

    const wrongBaseAtCurrentVersion = makeOperation(
      '96969696-9696-4696-8696-969696969696', beforeOnlineRating + 1, 5, null,
    );
    expect(replaySyncOperation(database, wrongBaseAtCurrentVersion)).toMatchObject({
      status: 'conflict',
      currentVersion: beforeOnlineRating + 1,
      currentValues: { slotUid, stars: 3 },
    });

    database.prepare('DELETE FROM rating_slots WHERE id = ?').run(slot.id);
    const replacement = createRatingSlot(database, {
      kind: 'entry', entryType: 'game', name: 'Story',
    });
    expect(replacement.id).toBe(slot.id);
    expect(database.prepare('SELECT sync_uid FROM rating_slots WHERE id = ?').pluck().get(replacement.id))
      .not.toBe(slotUid);
    const missingSlot = makeOperation(
      '95959595-9595-4595-8595-959595959595', beforeOnlineRating + 1, 3, 4,
    );
    expect(replaySyncOperation(database, missingSlot)).toMatchObject({
      status: 'failed', errorCode: 'invalid-rating',
    });
    expect(database.prepare(`
      SELECT COUNT(*) FROM entry_rating_values WHERE entry_id = ? AND slot_id = ?
    `).pluck().get(entry.id, replacement.id)).toBe(0);
  });

  it('creates one offline Entry idempotently with atomic ratings and View later state', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const ratingSlot = createRatingSlot(database, { kind: 'entry', entryType: 'game', name: 'Quality' });
    const identity = getSyncIdentity(database);
    const app = createApiApp(database);
    const operation = syncReplayOperationSchema.parse({
      opId: '55555555-5555-4555-8555-555555555555',
      clientId: 'test-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry',
      entityUid: '66666666-6666-4666-8666-666666666666',
      operationKind: 'entry.create',
      baseVersion: 0,
      baseValues: {},
      payload: {
        title: 'Offline-created Entry',
        type: 'game',
        uploadDate: '2026-09-19',
        pageCount: 42,
        ratings: [{ slotId: ratingSlot.id, stars: 4.5 }],
        viewLater: true,
      },
      clientCreatedAt: '2026-09-19T12:00:00.000Z',
    });
    const apply = async (body: unknown) => {
      const response = await app.request('/api/sync/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return syncReplayResultSchema.parse(await response.json());
    };

    const first = await apply(operation);
    expect(first).toMatchObject({
      opId: operation.opId,
      status: 'applied',
      resourceVersion: 1,
    });
    expect(first.status === 'applied' ? first.entityId : undefined).toEqual(expect.any(Number));
    expect(await apply(operation)).toEqual(first);

    const created = database.prepare(`
      SELECT id, sync_uid AS syncUid, title, type, upload_date AS uploadDate, page_count AS pageCount
      FROM entries WHERE sync_uid = ?
    `).get(operation.entityUid) as {
      id: number; syncUid: string; title: string; type: string; uploadDate: string; pageCount: number;
    };
    expect(created).toMatchObject({
      syncUid: operation.entityUid,
      title: 'Offline-created Entry',
      type: 'game',
      uploadDate: '2026-09-19',
      pageCount: 42,
    });
    expect(database.prepare('SELECT stars FROM entry_rating_values WHERE entry_id = ? AND slot_id = ?')
      .pluck().get(created.id, ratingSlot.id)).toBe(4.5);
    expect(database.prepare('SELECT COUNT(*) FROM view_later_entries WHERE entry_id = ?')
      .pluck().get(created.id)).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?')
      .pluck().get(operation.entityUid)).toBe(1);

    const distinct = await apply({
      ...operation,
      opId: '77777777-7777-4777-8777-777777777777',
      entityUid: '88888888-8888-4888-8888-888888888888',
      payload: { ...operation.payload, ratings: [], viewLater: false },
    });
    expect(distinct.status).toBe('applied');
    expect(database.prepare('SELECT COUNT(*) FROM entries WHERE title = ?')
      .pluck().get('Offline-created Entry')).toBe(2);

    const invalid = await apply({
      ...operation,
      opId: '99999999-9999-4999-8999-999999999999',
      entityUid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      payload: { ...operation.payload, type: 'new-offline-gallery', ratings: [] },
    });
    expect(invalid).toMatchObject({ status: 'failed', errorCode: 'invalid-create' });
    expect(database.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?')
      .pluck().get('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(0);
  });

  it('uploads staged media idempotently and rejects hash, MIME, identity, collision, and replacement errors', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const assetRoot = mkdtempSync(join(tmpdir(), 't3-sync-media-'));
    directories.push(assetRoot);
    const createOperation = syncReplayOperationSchema.parse({
      opId: 'abababab-1111-4222-8333-444444444444',
      clientId: '99999999-8888-4777-8666-555555555555',
      clientCreatedAt: '2026-09-19T12:00:00.000Z',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry',
      entityUid: 'abababab-abab-4bab-8bab-abababababab',
      operationKind: 'entry.create',
      baseVersion: 0,
      baseValues: {},
      payload: {
        title: 'Offline media target',
        type: 'game',
        uploadDate: null,
        pageCount: null,
        ratings: [],
        viewLater: false,
      },
    });
    const createResult = replaySyncOperation(database, createOperation);
    expect(createResult.status).toBe('applied');
    const entryId = createResult.status === 'applied' ? createResult.entityId! : -1;
    const app = createApiApp(database, { assetRoot });
    const png = await sharp({
      create: { width: 4, height: 3, channels: 4, background: '#336699ff' },
    }).png().toBuffer();
    const sha256 = createHash('sha256').update(png).digest('hex');
    const metadata = {
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entryUid: 'abababab-abab-4bab-8bab-abababababab',
      kind: 'cover',
      ordinal: 0,
      mimeType: 'image/png',
      byteLength: png.byteLength,
      sha256,
    } as const;
    const upload = async (uploadId: string, value: unknown, bytes = png) => {
      const form = new FormData();
      form.set('metadata', JSON.stringify(value));
      form.set('file', new File([new Uint8Array([...bytes])], 'cover.png', { type: 'image/png' }));
      return app.request(`/api/sync/media/${uploadId}`, { method: 'PUT', body: form });
    };

    const uploadId = '12121212-1212-4212-8212-121212121212';
    createEntry(database, {
      title: 'Online media target',
      type: 'game',
      syncUid: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
    });
    const existingEntryResponse = await upload(
      '10101010-2020-4030-8040-505050505050',
      { ...metadata, entryUid: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd' },
    );
    expect(existingEntryResponse.status).toBe(409);
    const staleIdentityResponse = await upload(
      '11111111-2222-4333-8444-555555555555',
      { ...metadata, syncEpoch: 'restored-epoch' },
    );
    expect(staleIdentityResponse.status).toBe(409);
    const firstResponse = await upload(uploadId, metadata);
    expect(firstResponse.status).toBe(200);
    const first = syncMediaUploadResultSchema.parse(await firstResponse.json());
    expect(first).toMatchObject({ uploadId, status: 'applied', entityId: entryId });
    expect(existsSync(join(assetRoot, 'entries', String(entryId), 'cover.png'))).toBe(true);
    expect(existsSync(join(
      assetRoot,
      'entries',
      String(entryId),
      'thumbnails',
      `cover.${sha256.slice(0, 16)}.webp`,
    ))).toBe(true);

    const retryResponse = await upload(uploadId, metadata);
    expect(retryResponse.status).toBe(200);
    expect(syncMediaUploadResultSchema.parse(await retryResponse.json())).toEqual(first);
    expect(database.prepare('SELECT COUNT(*) FROM sync_media_upload_receipts').pluck().get()).toBe(1);

    const collisionResponse = await upload(uploadId, { ...metadata, byteLength: png.byteLength + 1 });
    expect(collisionResponse.status).toBe(409);

    const wrongHashResponse = await upload(
      '13131313-1313-4313-8313-131313131313',
      { ...metadata, kind: 'preview', sha256: '0'.repeat(64) },
    );
    expect(wrongHashResponse.status).toBe(400);

    const wrongMimeResponse = await upload(
      '14141414-1414-4414-8414-141414141414',
      { ...metadata, kind: 'preview', mimeType: 'image/jpeg' },
    );
    expect(wrongMimeResponse.status).toBe(400);

    const occupiedResponse = await upload(
      '15151515-1515-4515-8515-151515151515',
      metadata,
    );
    expect(occupiedResponse.status).toBe(409);
    expect(database.prepare('SELECT cover_ref FROM entries WHERE id = ?').pluck().get(entryId))
      .toBe(first.relativeRef);

    database.exec(`
      CREATE TRIGGER test_block_media_receipt
      BEFORE INSERT ON sync_media_upload_receipts
      BEGIN
        SELECT RAISE(ABORT, 'media receipt insert blocked');
      END;
    `);
    const failedPreview = await upload(
      '17171717-1717-4717-8717-171717171717',
      { ...metadata, kind: 'preview' },
    );
    expect(failedPreview.status).toBe(409);
    expect(database.prepare('SELECT preview_refs FROM entries WHERE id = ?').pluck().get(entryId))
      .toBe('[]');
    expect(existsSync(join(assetRoot, 'entries', String(entryId), 'preview.png'))).toBe(false);
    expect(existsSync(join(
      assetRoot, 'entries', String(entryId), 'thumbnails', `preview.${sha256.slice(0, 16)}.webp`,
    ))).toBe(false);
  });

  it('replays one Entry patch idempotently and reports field conflicts', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const app = createApiApp(database);
    const identity = getSyncIdentity(database);
    const resource = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion
      FROM entries WHERE title = 'Endfield'
    `).get() as { syncUid: string; syncVersion: number };
    const operation = {
      opId: '11111111-1111-4111-8111-111111111111',
      clientId: 'test-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry',
      entityUid: resource.syncUid,
      operationKind: 'entry.update',
      baseVersion: resource.syncVersion,
      baseValues: { title: 'Endfield' },
      payload: { title: 'Offline title' },
      clientCreatedAt: '2026-09-14T12:00:00.000Z',
    } as const;

    const apply = async (body: unknown) => {
      const response = await app.request('/api/sync/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return syncReplayResultSchema.parse(await response.json());
    };

    expect(await apply(operation)).toEqual({
      opId: operation.opId,
      status: 'applied',
      resourceVersion: 3,
      serverSeq: 4,
    });
    expect(await apply(operation)).toEqual({
      opId: operation.opId,
      status: 'applied',
      resourceVersion: 3,
      serverSeq: 4,
    });
    expect(database.prepare('SELECT title FROM entries WHERE sync_uid = ?').pluck().get(resource.syncUid))
      .toBe('Offline title');
    expect(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(4);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(1);

    expect(await apply({ ...operation, payload: { title: 'Changed reuse' } })).toMatchObject({
      opId: operation.opId,
      status: 'failed',
      errorCode: 'operation-id-collision',
    });
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(1);

    expect(await apply({
      ...operation,
      opId: '22222222-2222-4222-8222-222222222222',
      payload: { title: 'Conflicting title' },
    })).toEqual({
      opId: '22222222-2222-4222-8222-222222222222',
      status: 'conflict',
      currentVersion: 3,
      currentValues: { title: 'Offline title' },
      serverSeq: 4,
    });
    expect(database.prepare('SELECT title FROM entries WHERE sync_uid = ?').pluck().get(resource.syncUid))
      .toBe('Offline title');

    expect(await apply({
      ...operation,
      opId: '33333333-3333-4333-8333-333333333333',
      baseValues: { pageCount: null },
      payload: { pageCount: 24 },
    })).toEqual({
      opId: '33333333-3333-4333-8333-333333333333',
      status: 'applied',
      resourceVersion: 4,
      serverSeq: 5,
    });
    expect(database.prepare('SELECT page_count FROM entries WHERE sync_uid = ?').pluck().get(resource.syncUid))
      .toBe(24);
  });

  it('rolls back the Entry and journal when receipt persistence fails', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const resource = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion
      FROM entries WHERE title = 'Endfield'
    `).get() as { syncUid: string; syncVersion: number };
    const operation = syncReplayOperationSchema.parse({
      opId: '44444444-4444-4444-8444-444444444444',
      clientId: 'test-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry',
      entityUid: resource.syncUid,
      operationKind: 'entry.update',
      baseVersion: resource.syncVersion,
      baseValues: { title: 'Endfield' },
      payload: { title: 'Must roll back' },
      clientCreatedAt: '2026-09-14T12:00:00.000Z',
    });
    database.exec(`
      CREATE TRIGGER test_block_sync_receipt
      BEFORE INSERT ON sync_operation_receipts
      BEGIN
        SELECT RAISE(ABORT, 'receipt insert blocked');
      END;
    `);

    expect(() => replaySyncOperation(database, operation)).toThrow('receipt insert blocked');
    expect(database.prepare(`
      SELECT title, sync_version AS syncVersion FROM entries WHERE sync_uid = ?
    `).get(resource.syncUid)).toEqual({ title: 'Endfield', syncVersion: resource.syncVersion });
    expect(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(3);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(0);
  });

  it('rolls back rating, Entry revision, and journal when receipt persistence fails', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const resource = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion
      FROM entries WHERE title = 'Endfield'
    `).get() as { id: number; syncUid: string; syncVersion: number };
    const slot = createRatingSlot(database, { kind: 'entry', entryType: 'game', name: 'Quality' });
    const slotUid = database.prepare('SELECT sync_uid FROM rating_slots WHERE id = ?')
      .pluck().get(slot.id) as string;
    const operation = syncReplayOperationSchema.parse({
      opId: '45454545-4545-4545-8545-454545454545',
      clientId: 'test-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry',
      entityUid: resource.syncUid,
      operationKind: 'entry.rating.set',
      baseVersion: resource.syncVersion,
      baseValues: { slotUid, stars: null },
      payload: { slotUid, stars: 4.5 },
      clientCreatedAt: '2026-09-21T12:00:00.000Z',
    });
    const beforeChanges = Number(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get());
    database.exec(`
      CREATE TRIGGER test_block_rating_receipt
      BEFORE INSERT ON sync_operation_receipts
      BEGIN
        SELECT RAISE(ABORT, 'rating receipt insert blocked');
      END;
    `);

    expect(() => replaySyncOperation(database, operation)).toThrow('rating receipt insert blocked');
    expect(database.prepare(`
      SELECT COUNT(*) FROM entry_rating_values WHERE entry_id = ? AND slot_id = ?
    `).pluck().get(resource.id, slot.id)).toBe(0);
    expect(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(resource.id))
      .toBe(resource.syncVersion);
    expect(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(beforeChanges);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(0);
  });

  it('rolls back usage and its journal change when receipt persistence fails', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const resource = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion
      FROM entries WHERE title = 'Endfield'
    `).get() as { id: number; syncUid: string; syncVersion: number };
    const operation = syncReplayOperationSchema.parse({
      opId: '46464646-4646-4646-8646-464646464646',
      clientId: 'test-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry',
      entityUid: resource.syncUid,
      operationKind: 'entry.usage',
      baseVersion: 0,
      baseValues: {},
      payload: { event: 'view' },
      clientCreatedAt: '2026-09-20T12:00:00.000Z',
    });
    database.exec(`
      CREATE TRIGGER test_block_usage_receipt
      BEFORE INSERT ON sync_operation_receipts
      BEGIN
        SELECT RAISE(ABORT, 'usage receipt insert blocked');
      END;
    `);

    expect(() => replaySyncOperation(database, operation)).toThrow('usage receipt insert blocked');
    expect(database.prepare('SELECT COUNT(*) FROM entry_usage WHERE entry_id = ?')
      .pluck().get(resource.id)).toBe(0);
    expect(database.prepare('SELECT sync_version FROM entries WHERE id = ?')
      .pluck().get(resource.id)).toBe(resource.syncVersion);
    expect(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(3);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(0);
  });

  it('rolls back an offline create and its registry when receipt persistence fails', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const operation = syncReplayOperationSchema.parse({
      opId: '45454545-4545-4545-8545-454545454545',
      clientId: 'test-client',
      clientCreatedAt: '2026-09-19T12:00:00.000Z',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry',
      entityUid: '56565656-5656-4656-8656-565656565656',
      operationKind: 'entry.create',
      baseVersion: 0,
      baseValues: {},
      payload: {
        title: 'Must not exist', type: 'game', uploadDate: null, pageCount: null,
        ratings: [], viewLater: false,
      },
    });
    database.exec(`
      CREATE TRIGGER test_block_create_receipt
      BEFORE INSERT ON sync_operation_receipts
      BEGIN
        SELECT RAISE(ABORT, 'create receipt insert blocked');
      END;
    `);

    expect(() => replaySyncOperation(database, operation)).toThrow('create receipt insert blocked');
    expect(database.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?')
      .pluck().get(operation.entityUid)).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(3);
    expect(database.prepare('SELECT COUNT(*) FROM sync_offline_created_entries').pluck().get()).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(0);
  });

  it('keeps receipts, journal and tombstones across a server restart', () => {
    const temp = createTempFileDatabase();
    directories.push(dirname(temp.path));
    databases.push(temp.database);
    applyAllMigrations(temp.database);
    seed(temp.database);
    const identity = getSyncIdentity(temp.database);
    const resource = temp.database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion
      FROM entries WHERE title = 'Endfield'
    `).get() as { syncUid: string; syncVersion: number };
    const content = temp.database.prepare(`
      SELECT id, sync_uid AS syncUid FROM entry_contents ORDER BY id
    `).get() as { id: number; syncUid: string };
    const operation = syncReplayOperationSchema.parse({
      opId: '55555555-5555-4555-8555-555555555555',
      clientId: 'test-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry',
      entityUid: resource.syncUid,
      operationKind: 'entry.update',
      baseVersion: resource.syncVersion,
      baseValues: { title: 'Endfield' },
      payload: { title: 'Survived the restart' },
      clientCreatedAt: '2026-09-14T12:00:00.000Z',
    });

    const applied = replaySyncOperation(temp.database, operation);
    expect(applied).toEqual({
      opId: operation.opId,
      status: 'applied',
      resourceVersion: 3,
      serverSeq: 4,
    });
    // A later delete leaves a tombstone, so the journal high-water mark moves on
    // without the receipt following it.
    deleteEntryContent(temp.database, content.id);

    // Server shutdown: the connection closes and the next start opens the same file.
    temp.database.close();
    const reopened = openDatabase(temp.path);
    databases.push(reopened);
    applyAllMigrations(reopened);

    // The library identity is stable, so a paired client is not forced to resnapshot.
    expect(getSyncIdentity(reopened)).toEqual(identity);

    // The retry is answered from the durable receipt: the ORIGINAL resource
    // version and server sequence come back, not a recomputed pair.
    expect(replaySyncOperation(reopened, operation)).toEqual(applied);
    expect(reopened.prepare(`
      SELECT title, sync_version AS syncVersion FROM entries WHERE sync_uid = ?
    `).get(resource.syncUid)).toEqual({ title: 'Survived the restart', syncVersion: 3 });
    expect(reopened.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(5);
    expect(reopened.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(1);
    expect(reopened.prepare(`
      SELECT entity_kind AS entityKind, entity_uid AS entityUid,
             deleted_version AS deletedVersion, change_seq AS changeSeq
      FROM sync_tombstones
    `).all()).toEqual([{
      entityKind: 'entry_content',
      entityUid: content.syncUid,
      deletedVersion: 2,
      changeSeq: 5,
    }]);
  });

  it('captures the snapshot atomically and bumps the seq monotonically', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const app = createApiApp(database);

    const firstResponse = await app.request('/api/sync/snapshot?media=thumbnails');
    expect(firstResponse.status).toBe(200);
    const first = syncSnapshotSchema.parse(await firstResponse.json());
    expect(first.header.snapshotSeq).toBe(1);
    expect(first.header.changeSeq).toBe(3);
    expect(first.header.counts).toEqual({
      entries: 1, producers: 1, entryContents: 1, entryTags: 0, collections: 0,
    });
    expect(first.payload.entries[0]).toMatchObject({
      title: 'Endfield',
      type: 'game',
      syncUid: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      syncVersion: 2,
    });
    expect(first.payload.entryContents[0]).toMatchObject({
      contentType: 'Source URL',
      syncUid: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      syncVersion: 1,
    });
    expect(first.payload.gallerySettings).toEqual([{ entryType: 'game', nsfw: true }]);
    expect(first.payload.mediaRefs).toEqual([
      'assets/game/endfield/cover.jpg',
      'assets/game/endfield/page-1.jpg',
      'assets/game/endfield/page-2.jpg',
      'assets/game/endfield/preview.jpg',
    ]);

    // Unchanged data → identical payload bytes, but a bumped snapshot seq.
    const second = syncSnapshotSchema.parse(await (await app.request('/api/sync/snapshot?media=thumbnails')).json());
    expect(second.header.snapshotSeq).toBe(2);
    expect(second.header.changeSeq).toBe(3);
    expect(second.payload).toEqual(first.payload);

    // A write between snapshots is visible in the next generation.
    createEntry(database, { title: 'Hades II', type: 'game' });
    const third = syncSnapshotSchema.parse(await (await app.request('/api/sync/snapshot?media=thumbnails')).json());
    expect(third.header.snapshotSeq).toBe(3);
    expect(third.header.changeSeq).toBe(4);
    expect(third.header.counts.entries).toBe(2);

    const metadataOnly = syncSnapshotSchema.parse(
      await (await app.request('/api/sync/snapshot?media=none')).json(),
    );
    expect(metadataOnly.payload.mediaRefs).toEqual([]);
  });

  it('preserves offline browse ordering and taxonomy alias rows', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const second = createEntry(database, { title: 'Endfield II', type: 'game' });
    const producer = database.prepare(`SELECT id FROM producers WHERE name = 'Hypergryph'`).get() as { id: number };
    linkEntryProducer(database, second.id, producer.id);
    const directoryId = Number(database.prepare(`
      INSERT INTO author_directories (producer_id, title, sort_order) VALUES (?, 'Main', 0)
    `).run(producer.id).lastInsertRowid);
    database.prepare(`
      INSERT INTO author_directory_entries (directory_id, producer_id, entry_id, sort_order)
      VALUES (?, ?, ?, 7)
    `).run(directoryId, producer.id, second.id);
    const collectionId = Number(database.prepare(`
      INSERT INTO collections (kind, title) VALUES ('entry', 'Series')
    `).run().lastInsertRowid);
    database.prepare(`
      INSERT INTO collection_entries (collection_id, entry_id, created_at)
      VALUES (?, ?, '2026-01-01T00:00:00Z'), (?, ?, '2026-01-02T00:00:00Z')
    `).run(collectionId, second.id, collectionId, 1);
    database.prepare(`
      INSERT INTO taxonomy_aliases (
        vocabulary, partition, alias_name, normalized_alias,
        canonical_name, normalized_canonical
      ) VALUES ('producer', 'authors', 'HG', 'hg', 'Hypergryph', 'hypergryph')
    `).run();

    const app = createApiApp(database);
    const snapshot = await (await app.request('/api/sync/snapshot?media=none')).json() as {
      payload: {
        authorDirectoryEntries: Array<{ entryId: number; sortOrder?: number }>;
        collectionMembers: Array<{ entryId?: number; position: number }>;
        taxonomyAliases?: Array<{ aliasName: string; canonicalName: string }>;
      };
    };

    expect(snapshot.payload.authorDirectoryEntries).toContainEqual(expect.objectContaining({
      entryId: second.id,
      sortOrder: 7,
    }));
    expect(snapshot.payload.collectionMembers.map((member) => [member.entryId, member.position]))
      .toEqual([[second.id, 0], [1, 1]]);
    expect(snapshot.payload.taxonomyAliases).toContainEqual(expect.objectContaining({
      aliasName: 'HG',
      canonicalName: 'Hypergryph',
    }));
  });

  it('rotates the sync epoch on restore so stale clients resnapshot', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const app = createApiApp(database);

    const before = (await (await app.request('/api/sync/capabilities')).json() as { syncEpoch: string; libraryId: string }).syncEpoch;
    const after = rotateSyncEpoch(database);
    expect(after).not.toBe(before);
    expect((await (await app.request('/api/sync/capabilities')).json() as { syncEpoch: string }).syncEpoch).toBe(after);
  });

});
