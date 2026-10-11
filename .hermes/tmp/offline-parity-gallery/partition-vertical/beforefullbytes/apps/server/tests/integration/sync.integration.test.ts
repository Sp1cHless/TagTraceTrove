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
  updateEntryContent,
} from '../../src/repositories/entry-content-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createProducerRatingSlot, createRatingSlot, setEntryRating, setProducerRating } from '../../src/repositories/rating-repository.js';
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
  // Schema 42 journals the independent Directory-set INSERT before the Producer.
  expect(database.prepare(`SELECT seq, entity_kind AS kind, change_kind AS changeKind,
    resource_version AS version FROM sync_changes ORDER BY seq`).all()).toEqual([
    {seq: 1, kind: 'author_directory_set', changeKind: 'create', version: 1},
    {seq: 2, kind: 'producer', changeKind: 'create', version: 1},
    {seq: 3, kind: 'entry', changeKind: 'create', version: 1},
    {seq: 4, kind: 'entry', changeKind: 'update', version: 2},
    {seq: 5, kind: 'entry_content', changeKind: 'create', version: 1},
    {seq: 6, kind: 'entry', changeKind: 'update', version: 3},
  ]);
}

describe('offline sync service and routes', () => {
  it('pages durable changes and persists bounded acknowledgement across reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 't3-feed-'));
    directories.push(directory);
    const path = join(directory, 'feed.db');
    const database = openDatabase(path);
    databases.push(database);
    applyAllMigrations(database);
    const identity = getSyncIdentity(database);
    const query = new URLSearchParams({ ...identity, protocolVersion: '1', clientId: 'phone', afterSeq: '0', limit: '1' });
    const entry = createEntry(database, { title: 'Feed', type: 'game' });
    database.prepare('UPDATE entries SET title = ? WHERE id = ?').run('Edited', entry.id);
    database.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);
    const app = createApiApp(database);
    const response = await app.request(`/api/sync/changes?${query}`);
    expect(response.status).toBe(200);
    const page = await response.json() as { changes: Array<{ seq: number; changeKind: string }>; nextSeq: number; highWaterSeq: number };
    expect(page.changes.map((change) => change.changeKind)).toEqual(['create']);
    expect(page.highWaterSeq).toBeGreaterThan(page.nextSeq);
    const ack = { ...identity, protocolVersion: 1, clientId: 'phone', cursorSeq: page.nextSeq };
    expect((await app.request('/api/sync/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ack) })).status).toBe(200);
    const beyond = await app.request('/api/sync/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...ack, cursorSeq: page.highWaterSeq }) });
    expect(beyond.status).toBe(409);
    database.close();
    const reopened = openDatabase(path);
    databases.push(reopened);
    const resumed = await (await createApiApp(reopened).request(`/api/sync/changes?${new URLSearchParams({ ...identity, protocolVersion: '1', clientId: 'phone', afterSeq: String(page.nextSeq), limit: '10' })}`)).json() as { ackSeq: number; changes: Array<{ changeKind: string; record: unknown }> };
    expect(resumed.ackSeq).toBe(page.nextSeq);
    expect(resumed.changes.map((change) => change.changeKind)).toEqual(['update', 'delete']);
    expect(resumed.changes[1]?.record).toBeNull();
  });

  it('rejects a cursor skipped past the last served page and rejects mismatched identity', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const identity = getSyncIdentity(database);
    createEntry(database, { title: 'One', type: 'game' });
    createEntry(database, { title: 'Two', type: 'game' });
    const app = createApiApp(database);
    const base = { ...identity, protocolVersion: '1', clientId: 'phone', limit: '1' };
    const first = await (await app.request(`/api/sync/changes?${new URLSearchParams({ ...base, afterSeq: '0' })}`)).json() as { nextSeq: number; highWaterSeq: number };
    expect(first.highWaterSeq).toBeGreaterThan(first.nextSeq);
    const skipped = await app.request(`/api/sync/changes?${new URLSearchParams({ ...base, afterSeq: String(first.highWaterSeq) })}`);
    expect(skipped.status).toBe(409);
    const wrong = await app.request(`/api/sync/changes?${new URLSearchParams({ ...base, libraryId: 'other', afterSeq: '0' })}`);
    expect(wrong.status).toBe(409);
    const protocol = await app.request(`/api/sync/changes?${new URLSearchParams({ ...base, protocolVersion: '2', afterSeq: '0' })}`);
    expect(protocol.status).toBe(409);
  });

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
    expect(capabilities.sqliteSchemaVersion).toBe(42);
    expect(capabilities.snapshotFormatVersion).toBe(2);
    expect(capabilities.featureFlags).toMatchObject({
      offlineMutations: true,
      offlineEntryUpdate: true,
      offlineEntryCreate: true,
      onlineEntryCreateClaim: true,
      onlineEntryCreateCommand: true,
      offlineEntryInitialContents: true,
      offlineMediaUpload: true,
      offlineMediaMultiplePreviews: true,
      offlineUsageEvents: true,
      offlineEntryViewLater: true,
      offlineEntryRating: true,
      offlineEntryContents: true,
      offlineProducerViewLater: true,
      offlineProducerRating: true,
      offlineProducerProfile: true,
      offlineProducerTags: true,
      offlineRatingSlotLayout: true,
      offlineCollectionProducerMembership: true,
      offlineAuthorDirectories: true,
      offlineEntryAuthors: true,
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

  it('replays Producer rating desired state with owner revisions and detects concurrent value changes', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const author = createProducer(database, { name: 'Rated author' });
    const work = createEntry(database, { title: 'Rated work', type: 'game' });
    linkEntryProducer(database, work.id, author.id);
    const slot = createProducerRatingSlot(database, { producerId: author.id, name: 'Taste' });
    const identity = getSyncIdentity(database);
    const producer = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?
    `).get(author.id) as { id: number; syncUid: string; syncVersion: number };
    const slotUid = database.prepare('SELECT sync_uid FROM rating_slots WHERE id = ?').pluck().get(slot.id) as string;
    const beforeSeq = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());
    const makeOperation = (opId: string, baseVersion: number, baseStars: number | null, stars: number | null) =>
      syncReplayOperationSchema.parse({
        opId, clientId: 'android-client', libraryId: identity.libraryId, syncEpoch: identity.syncEpoch,
        entityKind: 'producer', entityUid: producer.syncUid, operationKind: 'producer.rating.set',
        baseVersion, baseValues: { slotUid, stars: baseStars }, payload: { slotUid, stars },
        clientCreatedAt: '2026-09-23T12:00:00.000Z',
      });

    const set = makeOperation('a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', producer.syncVersion, null, 3.5);
    const result = replaySyncOperation(database, set);
    expect(result).toMatchObject({ status: 'applied', resourceVersion: producer.syncVersion + 1 });
    expect(result.status === 'applied' ? result.serverSeq : 0).toBeGreaterThan(beforeSeq);
    expect(replaySyncOperation(database, set)).toEqual(result);
    expect(database.prepare('SELECT stars FROM producer_rating_values WHERE producer_id = ? AND slot_id = ?').pluck().get(author.id, slot.id)).toBe(3.5);
    expect(database.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(author.id)).toBe(producer.syncVersion + 1);

    setProducerRating(database, { producerId: author.id, slotId: slot.id, stars: 2.5 });
    expect(replaySyncOperation(database, makeOperation(
      'a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2', producer.syncVersion + 1, 3.5, null,
    ))).toMatchObject({
      status: 'conflict', currentVersion: producer.syncVersion + 2,
      currentValues: { slotUid, stars: 2.5 },
    });
  });

  it('rolls back Producer rating, owner revision, and journal when receipt persistence fails', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const author = createProducer(database, { name: 'Atomic rated author' });
    const work = createEntry(database, { title: 'Atomic rated work', type: 'game' });
    linkEntryProducer(database, work.id, author.id);
    const slot = createProducerRatingSlot(database, { producerId: author.id, name: 'Taste' });
    const identity = getSyncIdentity(database);
    const producer = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?
    `).get(author.id) as { id: number; syncUid: string; syncVersion: number };
    const slotUid = database.prepare('SELECT sync_uid FROM rating_slots WHERE id = ?').pluck().get(slot.id) as string;
    const operation = syncReplayOperationSchema.parse({
      opId: 'a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3', clientId: 'android-client',
      libraryId: identity.libraryId, syncEpoch: identity.syncEpoch,
      entityKind: 'producer', entityUid: producer.syncUid, operationKind: 'producer.rating.set',
      baseVersion: producer.syncVersion, baseValues: { slotUid, stars: null },
      payload: { slotUid, stars: 4.5 }, clientCreatedAt: '2026-09-23T12:00:00.000Z',
    });
    const beforeChanges = Number(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get());
    database.exec(`
      CREATE TRIGGER test_block_producer_rating_receipt
      BEFORE INSERT ON sync_operation_receipts
      BEGIN SELECT RAISE(ABORT, 'producer rating receipt insert blocked'); END;
    `);
    expect(() => replaySyncOperation(database, operation)).toThrow('producer rating receipt insert blocked');
    expect(database.prepare('SELECT COUNT(*) FROM producer_rating_values WHERE producer_id = ? AND slot_id = ?').pluck().get(author.id, slot.id)).toBe(0);
    expect(database.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(author.id)).toBe(producer.syncVersion);
    expect(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(beforeChanges);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)).toBe(0);
  });

  it('accepts a Producer View later desired-state operation with a stable Producer identity', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const author = createProducer(database, { name: 'Offline author' });
    const identity = getSyncIdentity(database);
    const row = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?
    `).get(author.id) as { syncUid: string; syncVersion: number };
    const operation = syncReplayOperationSchema.parse({
      opId: '91919191-9191-4191-8191-919191919191',
      clientId: 'android-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'producer',
      entityUid: row.syncUid,
      operationKind: 'producer.view-later.set',
      baseVersion: row.syncVersion,
      baseValues: { present: false },
      payload: { present: true },
      clientCreatedAt: '2026-09-20T12:00:00.000Z',
    });
    expect(operation).toMatchObject({ entityKind: 'producer', operationKind: 'producer.view-later.set' });
  });

  it('replays Producer View later desired state idempotently and conflicts on concurrent membership changes', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const author = createProducer(database, { name: 'Replay author' });
    const identity = getSyncIdentity(database);
    const producer = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?
    `).get(author.id) as { id: number; syncUid: string; syncVersion: number };
    const beforeSeq = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());
    const makeOperation = (opId: string, version: number, from: boolean, to: boolean, entityUid = producer.syncUid) =>
      syncReplayOperationSchema.parse({
        opId,
        clientId: 'android-client',
        libraryId: identity.libraryId,
        syncEpoch: identity.syncEpoch,
        entityKind: 'producer',
        entityUid,
        operationKind: 'producer.view-later.set',
        baseVersion: version,
        baseValues: { present: from },
        payload: { present: to },
        clientCreatedAt: '2026-09-20T12:00:00.000Z',
      });
    const add = makeOperation('92929292-9292-4292-8292-929292929292', producer.syncVersion, false, true);
    const added = replaySyncOperation(database, add);
    expect(added).toMatchObject({ status: 'applied', resourceVersion: producer.syncVersion + 1 });
    expect(added.status === 'applied' ? added.serverSeq : 0).toBeGreaterThan(beforeSeq);
    expect(replaySyncOperation(database, add)).toEqual(added);
    expect(database.prepare('SELECT producer_id FROM view_later_producers WHERE producer_id = ?').pluck().get(producer.id)).toBe(producer.id);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(add.opId)).toBe(1);

    const second = makeOperation('93939393-9393-4393-8393-939393939393', producer.syncVersion, false, true);
    expect(replaySyncOperation(database, second)).toMatchObject({ status: 'applied', resourceVersion: producer.syncVersion + 1 });
    const remove = makeOperation('94949494-9494-4494-8494-949494949494', producer.syncVersion + 1, true, false);
    expect(replaySyncOperation(database, remove)).toMatchObject({ status: 'applied', resourceVersion: producer.syncVersion + 2 });
    database.prepare('UPDATE producers SET name = name || ? WHERE id = ?').run(' changed', producer.id);
    const staleAdd = makeOperation('95959595-9595-4595-8595-959595959595', producer.syncVersion + 2, false, true);
    expect(replaySyncOperation(database, staleAdd)).toMatchObject({
      status: 'conflict', currentVersion: producer.syncVersion + 3, currentValues: { present: false },
    });
    expect(replaySyncOperation(database, makeOperation(
      '96969696-9696-4696-8696-969696969696', producer.syncVersion, false, true,
      '97979797-9797-4797-8797-979797979797',
    ))).toMatchObject({ status: 'failed', errorCode: 'entity-not-found' });
    expect(database.prepare('SELECT COUNT(*) FROM sync_changes WHERE entity_kind = ?').pluck().get('producer')).toBeGreaterThan(0);
  });

  it('replays Producer profile patches through the shared Author revision and conflicts on the same field', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const author = createProducer(database, { name: 'Profile Author' });
    const identity = getSyncIdentity(database);
    const producer = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion, occupation, content
      FROM producers WHERE id = ?
    `).get(author.id) as { id: number; syncUid: string; syncVersion: number; occupation: string | null; content: string | null };
    const makeOperation = (opId: string, baseVersion: number, field: 'occupation' | 'artworkRef', baseValue: string | null, value: string | null) => syncReplayOperationSchema.parse({
      opId,
      clientId: 'android-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'producer',
      entityUid: producer.syncUid,
      operationKind: 'producer.update',
      baseVersion,
      baseValues: { [field]: baseValue },
      payload: { [field]: value },
      clientCreatedAt: '2026-09-23T12:00:00.000Z',
    });

    const occupation = makeOperation('a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', producer.syncVersion, 'occupation', null, 'Illustrator');
    const appliedOccupation = replaySyncOperation(database, occupation);
    expect(appliedOccupation).toMatchObject({ status: 'applied', resourceVersion: producer.syncVersion + 1 });
    expect(replaySyncOperation(database, occupation)).toEqual(appliedOccupation);

    database.prepare('UPDATE producers SET content = ? WHERE id = ?').run('Concurrent note', producer.id);
    const artwork = makeOperation('a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2', producer.syncVersion, 'artworkRef', null, 'assets/authors/profile.png');
    expect(replaySyncOperation(database, artwork)).toMatchObject({ status: 'applied', resourceVersion: producer.syncVersion + 3 });

    const conflict = makeOperation('a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3', producer.syncVersion, 'occupation', null, 'Writer');
    expect(replaySyncOperation(database, conflict)).toMatchObject({
      status: 'conflict', currentVersion: producer.syncVersion + 3,
      currentValues: { occupation: 'Illustrator' },
    });
    expect(database.prepare('SELECT occupation, artwork_ref AS artworkRef, content FROM producers WHERE id = ?').get(producer.id))
      .toEqual({ occupation: 'Illustrator', artworkRef: 'assets/authors/profile.png', content: 'Concurrent note' });
  });

  it('replays Producer tag desired states with stable identities and exact per-assignment revisions', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const author = createProducer(database, { name: 'Tag Author' });
    const identity = getSyncIdentity(database);
    database.prepare('INSERT INTO producer_tags (name, normalized_name) VALUES (?, ?)').run('Existing Tag', 'existing tag');
    const existing = database.prepare('SELECT id, sync_uid AS syncUid, name FROM producer_tags WHERE normalized_name = ?')
      .get('existing tag') as { id: number; syncUid: string; name: string };
    database.prepare('INSERT INTO producer_tag_assignments (producer_id, tag_id) VALUES (?, ?)').run(author.id, existing.id);
    const producer = database.prepare('SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?')
      .get(author.id) as { syncUid: string; syncVersion: number };
    const baseTags = [{ syncUid: existing.syncUid, name: existing.name }];
    const newTag = { syncUid: 'b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4', name: 'New Tag' };
    const makeOperation = (opId: string, baseVersion: number, before: typeof baseTags, after: typeof baseTags) => syncReplayOperationSchema.parse({
      opId,
      clientId: 'android-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'producer',
      entityUid: producer.syncUid,
      operationKind: 'producer.tags.set',
      baseVersion,
      baseValues: { tags: before },
      payload: { tags: after },
      clientCreatedAt: '2026-09-23T12:00:00.000Z',
    });

    const add = makeOperation('b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1', producer.syncVersion, baseTags, [
      ...baseTags, newTag,
    ].sort((left, right) => left.syncUid < right.syncUid ? -1 : 1));
    const added = replaySyncOperation(database, add);
    expect(added).toMatchObject({ status: 'applied', resourceVersion: producer.syncVersion + 1 });
    expect(replaySyncOperation(database, add)).toEqual(added);
    expect(database.prepare(`
      SELECT producer_tag.sync_uid AS syncUid, producer_tag.name
      FROM producer_tag_assignments AS assignment
      JOIN producer_tags AS producer_tag ON producer_tag.id = assignment.tag_id
      WHERE assignment.producer_id = ? ORDER BY producer_tag.sync_uid
    `).all(author.id)).toEqual([
      ...baseTags, newTag,
    ].sort((left, right) => left.syncUid < right.syncUid ? -1 : 1));

    const removeAll = makeOperation('b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2', producer.syncVersion + 1,
      [...baseTags, newTag].sort((left, right) => left.syncUid < right.syncUid ? -1 : 1), []);
    expect(replaySyncOperation(database, removeAll)).toMatchObject({
      status: 'applied', resourceVersion: producer.syncVersion + 3,
    });
    expect(database.prepare('SELECT COUNT(*) FROM producer_tag_assignments WHERE producer_id = ?').pluck().get(author.id)).toBe(0);
  });

  it('replays the full Author-owned operation family with exact cross-operation Producer versions', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const author = createProducer(database, { name: 'Mixed Author' });
    const work = createEntry(database, { title: 'Mixed Author work', type: 'game' });
    linkEntryProducer(database, work.id, author.id);
    const slot = createProducerRatingSlot(database, { producerId: author.id, name: 'Quality' });
    const identity = getSyncIdentity(database);
    const producer = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?
    `).get(author.id) as { syncUid: string; syncVersion: number };
    const slotUid = database.prepare('SELECT sync_uid FROM rating_slots WHERE id = ?')
      .pluck().get(slot.id) as string;
    const makeOperation = (opId: string, operationKind: string, baseVersion: number, baseValues: unknown, payload: unknown) => syncReplayOperationSchema.parse({
      opId,
      clientId: 'android-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'producer',
      entityUid: producer.syncUid,
      operationKind,
      baseVersion,
      baseValues,
      payload,
      clientCreatedAt: '2026-09-23T12:00:00.000Z',
    });
    const profile = makeOperation('c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1', 'producer.update',
      producer.syncVersion, { occupation: null }, { occupation: 'Writer' });
    const tagSet = makeOperation('c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2', 'producer.tags.set',
      producer.syncVersion + 1, { tags: [] }, { tags: [
        { syncUid: 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1', name: 'Writer   A' },
        { syncUid: 'd2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2', name: 'Writer B' }
      ] });
    const rating = makeOperation('c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3', 'producer.rating.set',
      producer.syncVersion + 3, { slotUid, stars: null }, { slotUid, stars: 4.5 });
    const viewLater = makeOperation('c4c4c4c4-c4c4-44c4-84c4-c4c4c4c4c4c4', 'producer.view-later.set',
      producer.syncVersion + 4, { present: false }, { present: true });

    expect(replaySyncOperation(database, profile)).toMatchObject({ status: 'applied', resourceVersion: 2 });
    expect(replaySyncOperation(database, tagSet)).toMatchObject({ status: 'applied', resourceVersion: 4 });
    expect(replaySyncOperation(database, rating)).toMatchObject({ status: 'applied', resourceVersion: 5 });
    expect(replaySyncOperation(database, viewLater)).toMatchObject({ status: 'applied', resourceVersion: 6 });
    expect(database.prepare('SELECT occupation, sync_version AS syncVersion FROM producers WHERE id = ?')
      .get(author.id)).toMatchObject({ occupation: 'Writer', syncVersion: 6 });
    expect(database.prepare('SELECT COUNT(*) FROM producer_tag_assignments WHERE producer_id = ?')
      .pluck().get(author.id)).toBe(2);
    expect(database.prepare('SELECT name FROM producer_tags ORDER BY normalized_name')
      .pluck().all()).toEqual(['Writer A', 'Writer B']);
    expect(database.prepare('SELECT stars FROM producer_rating_values WHERE producer_id = ? AND slot_id = ?')
      .pluck().get(author.id, slot.id)).toBe(4.5);
    expect(database.prepare('SELECT COUNT(*) FROM view_later_producers WHERE producer_id = ?')
      .pluck().get(author.id)).toBe(1);
  });

  it('fails closed when an offline Author tag name collides with a different server identity', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const author = createProducer(database, { name: 'Tag Collision Author' });
    const identity = getSyncIdentity(database);
    database.prepare('INSERT INTO producer_tags (name, normalized_name) VALUES (?, ?)')
      .run('Shared Tag', 'shared tag');
    const producer = database.prepare('SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?')
      .get(author.id) as { syncUid: string; syncVersion: number };
    const operation = syncReplayOperationSchema.parse({
      opId: 'b7b7b7b7-b7b7-47b7-87b7-b7b7b7b7b7b7',
      clientId: 'android-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'producer',
      entityUid: producer.syncUid,
      operationKind: 'producer.tags.set',
      baseVersion: producer.syncVersion,
      baseValues: { tags: [] },
      payload: { tags: [{ syncUid: 'b8b8b8b8-b8b8-48b8-88b8-b8b8b8b8b8b8', name: 'Shared Tag' }] },
      clientCreatedAt: '2026-09-23T12:00:00.000Z',
    });

    expect(replaySyncOperation(database, operation)).toMatchObject({
      status: 'failed', errorCode: 'invalid-author-data',
    });
    expect(database.prepare('SELECT COUNT(*) FROM producer_tag_assignments WHERE producer_id = ?')
      .pluck().get(author.id)).toBe(0);
    expect(database.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(author.id))
      .toBe(producer.syncVersion);
  });

  it('rolls back Producer Tag membership, vocabulary, revision, and journal if receipt persistence fails', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const author = createProducer(database, { name: 'Atomic Tag Author' });
    const identity = getSyncIdentity(database);
    database.prepare('INSERT INTO producer_tags (name, normalized_name) VALUES (?, ?)').run('Old Tag', 'old tag');
    const oldTag = database.prepare('SELECT id, sync_uid AS syncUid, name FROM producer_tags WHERE normalized_name = ?')
      .get('old tag') as { id: number; syncUid: string; name: string };
    database.prepare('INSERT INTO producer_tag_assignments (producer_id, tag_id) VALUES (?, ?)')
      .run(author.id, oldTag.id);
    const producer = database.prepare('SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?')
      .get(author.id) as { syncUid: string; syncVersion: number };
    const operation = syncReplayOperationSchema.parse({
      opId: 'b3b3b3b3-b3b3-43b3-83b3-b3b3b3b3b3b3',
      clientId: 'android-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'producer',
      entityUid: producer.syncUid,
      operationKind: 'producer.tags.set',
      baseVersion: producer.syncVersion,
      baseValues: { tags: [{ syncUid: oldTag.syncUid, name: oldTag.name }] },
      payload: { tags: [{ syncUid: 'b5b5b5b5-b5b5-45b5-85b5-b5b5b5b5b5b5', name: 'New Tag' }] },
      clientCreatedAt: '2026-09-23T12:00:00.000Z',
    });
    const beforeChanges = Number(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get());
    database.exec(`
      CREATE TRIGGER test_block_producer_tag_receipt
      BEFORE INSERT ON sync_operation_receipts
      BEGIN
        SELECT RAISE(ABORT, 'producer tag receipt insert blocked');
      END;
    `);

    expect(() => replaySyncOperation(database, operation)).toThrow('producer tag receipt insert blocked');
    expect(database.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(author.id))
      .toBe(producer.syncVersion);
    expect(database.prepare('SELECT COUNT(*) FROM producer_tag_assignments WHERE producer_id = ? AND tag_id = ?')
      .pluck().get(author.id, oldTag.id)).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM producer_tags WHERE sync_uid = ?').pluck()
      .get('b5b5b5b5-b5b5-45b5-85b5-b5b5b5b5b5b5')).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(beforeChanges);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?')
      .pluck().get(operation.opId)).toBe(0);
  });

  it('rolls back Producer membership and journal when receipt persistence fails', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const author = createProducer(database, { name: 'Atomic Author' });
    const identity = getSyncIdentity(database);
    const producer = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?
    `).get(author.id) as { id: number; syncUid: string; syncVersion: number };
    const operation = syncReplayOperationSchema.parse({
      opId: '98989898-9898-4989-8989-989898989898',
      clientId: 'android-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'producer',
      entityUid: producer.syncUid,
      operationKind: 'producer.view-later.set',
      baseVersion: producer.syncVersion,
      baseValues: { present: false },
      payload: { present: true },
      clientCreatedAt: '2026-09-23T12:00:00.000Z',
    });
    const beforeChanges = Number(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get());
    database.exec(`
      CREATE TRIGGER test_block_producer_receipt
      BEFORE INSERT ON sync_operation_receipts
      BEGIN
        SELECT RAISE(ABORT, 'producer receipt insert blocked');
      END;
    `);

    expect(() => replaySyncOperation(database, operation)).toThrow('producer receipt insert blocked');
    expect(database.prepare(
      'SELECT COUNT(*) FROM view_later_producers WHERE producer_id = ?',
    ).pluck().get(producer.id)).toBe(0);
    expect(database.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(producer.id))
      .toBe(producer.syncVersion);
    expect(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(beforeChanges);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?')
      .pluck().get(operation.opId)).toBe(0);
  });

  it('replays Entry Author desired sets with exact revisions and durable retries', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const entry = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion
      FROM entries WHERE title = 'Endfield'
    `).get() as { id: number; syncUid: string; syncVersion: number };
    const authors = database.prepare(`
      SELECT producer.sync_uid AS syncUid
      FROM entry_producers AS relation
      JOIN producers AS producer ON producer.id = relation.producer_id
      WHERE relation.entry_id = ? ORDER BY producer.sync_uid
    `).all(entry.id) as Array<{ syncUid: string }>;
    const originalUid = authors[0]!.syncUid;
    const addedAuthor = createProducer(database, { name: 'Offline linked Author' });
    const addedUid = database.prepare('SELECT sync_uid FROM producers WHERE id = ?')
      .pluck().get(addedAuthor.id) as string;
    const baseline = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());
    const makeOperation = (opId: string, baseVersion: number, before: string[], after: string[]) =>
      syncReplayOperationSchema.parse({
        opId, clientId: 'android-client', libraryId: identity.libraryId,
        syncEpoch: identity.syncEpoch, entityKind: 'entry', entityUid: entry.syncUid,
        operationKind: 'entry.authors.set', baseVersion,
        baseValues: { producerUids: before }, payload: { producerUids: after },
        clientCreatedAt: '2026-09-24T12:00:00.000Z',
      });
    const add = makeOperation('a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', entry.syncVersion,
      [originalUid], [originalUid, addedUid].sort());

    const appliedAdd = replaySyncOperation(database, add);
    expect(appliedAdd).toMatchObject({ status: 'applied', resourceVersion: entry.syncVersion + 1 });
    expect(appliedAdd.status === 'applied' ? appliedAdd.serverSeq : 0).toBeGreaterThan(baseline);
    expect(replaySyncOperation(database, add)).toEqual(appliedAdd);

    const remove = makeOperation('a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2', entry.syncVersion + 1,
      [originalUid, addedUid].sort(), [originalUid]);
    expect(replaySyncOperation(database, remove)).toMatchObject({
      status: 'applied', resourceVersion: entry.syncVersion + 2,
    });
    expect(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id))
      .toBe(entry.syncVersion + 2);
    expect(database.prepare(`
      SELECT producer.sync_uid FROM entry_producers AS relation
      JOIN producers AS producer ON producer.id = relation.producer_id
      WHERE relation.entry_id = ? ORDER BY producer.sync_uid
    `).pluck().all(entry.id)).toEqual([originalUid]);
  });

  it('conflicts when online Author links change after the offline snapshot', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const entry = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion
      FROM entries WHERE title = 'Endfield'
    `).get() as { id: number; syncUid: string; syncVersion: number };
    const originalUid = database.prepare(`
      SELECT producer.sync_uid FROM entry_producers AS relation
      JOIN producers AS producer ON producer.id = relation.producer_id
      WHERE relation.entry_id = ?
    `).pluck().get(entry.id) as string;
    const onlineAuthor = createProducer(database, { name: 'Online linked Author' });
    linkEntryProducer(database, entry.id, onlineAuthor.id);
    const onlineUid = database.prepare('SELECT sync_uid FROM producers WHERE id = ?')
      .pluck().get(onlineAuthor.id) as string;
    const offlineAuthor = createProducer(database, { name: 'Offline requested Author' });
    const offlineUid = database.prepare('SELECT sync_uid FROM producers WHERE id = ?')
      .pluck().get(offlineAuthor.id) as string;
    const operation = syncReplayOperationSchema.parse({
      opId: 'a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3',
      clientId: 'android-client', libraryId: identity.libraryId, syncEpoch: identity.syncEpoch,
      entityKind: 'entry', entityUid: entry.syncUid, operationKind: 'entry.authors.set',
      baseVersion: entry.syncVersion, baseValues: { producerUids: [originalUid] },
      payload: { producerUids: [originalUid, offlineUid].sort() },
      clientCreatedAt: '2026-09-24T12:00:00.000Z',
    });

    expect(replaySyncOperation(database, operation)).toMatchObject({
      status: 'conflict',
      currentVersion: entry.syncVersion + 1,
      currentValues: { producerUids: [originalUid, onlineUid].sort() },
    });
    expect(database.prepare('SELECT COUNT(*) FROM entry_producers WHERE entry_id = ?')
      .pluck().get(entry.id)).toBe(2);
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
    // The deleted slot's row is gone, and its identity must not come back with whatever row takes
    // its place. The rowid is not recycled here either: creating a work dimension also creates the
    // works summary's dimension of the same name, so the table's highest id belongs to that one.
    expect(replacement.id).not.toBe(slot.id);
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
    // Gallery derives from type; a previously unused type is valid Entry intent.
    expect(invalid).toMatchObject({ status: 'applied' });
    expect(database.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?')
      .pluck().get('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(1);
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

    // A PNG whose header sharp can read but whose decoder refuses (measured:
    // metadata reports 16x16, rendering fails with "pngload_buffer: libspng
    // read error"). It used to escape as an unhandled throw, which the client
    // treated as transient and retried on every probe forever; it must be a
    // client error so the upload becomes a visible failure instead.
    const undecodablePng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR42mP8z8BQz0AEYBxVSF+FjIOsMEYV0l8h46ArjFGF9FcIAF8lBQGvN0eQAAAAAElFTkSuQmCC',
      'base64',
    );
    const undecodableResponse = await upload(
      '15151515-1515-4515-8515-151515151515',
      {
        ...metadata,
        kind: 'preview',
        byteLength: undecodablePng.byteLength,
        sha256: createHash('sha256').update(undecodablePng).digest('hex'),
      },
      undecodablePng,
    );
    expect(undecodableResponse.status).toBe(400);
    expect(await undecodableResponse.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('not a supported image') },
    });

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

  it('uploads ordered distinct offline previews, retains both after exact retry, and refuses gaps', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const assetRoot = mkdtempSync(join(tmpdir(), 't3-sync-multi-preview-'));
    directories.push(assetRoot);
    const entryUid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const result = replaySyncOperation(database, syncReplayOperationSchema.parse({
      opId: 'abababab-1111-4222-8333-444444444444',
      clientId: '99999999-8888-4777-8666-555555555555',
      clientCreatedAt: '2026-09-19T12:00:00.000Z',
      libraryId: identity.libraryId, syncEpoch: identity.syncEpoch,
      entityKind: 'entry', entityUid: entryUid, operationKind: 'entry.create',
      baseVersion: 0, baseValues: {},
      payload: { title: 'Multiple previews', type: 'game', uploadDate: null,
        pageCount: null, ratings: [], viewLater: false },
    }));
    expect(result.status).toBe('applied');
    const entryId = result.status === 'applied' ? result.entityId! : -1;
    const app = createApiApp(database, { assetRoot });
    const image = await sharp({ create: { width: 4, height: 3, channels: 4,
      background: '#336699ff' } }).png().toBuffer();
    const metadata = { libraryId: identity.libraryId, syncEpoch: identity.syncEpoch,
      entryUid, kind: 'preview', mimeType: 'image/png', byteLength: image.byteLength,
      sha256: createHash('sha256').update(image).digest('hex') };
    const upload = async (id: string, ordinal: number) => {
      const form = new FormData();
      form.set('metadata', JSON.stringify({ ...metadata, ordinal }));
      form.set('file', new File([new Uint8Array(image)], 'preview.png', { type: 'image/png' }));
      return app.request(`/api/sync/media/${id}`, { method: 'PUT', body: form });
    };
    const firstId = '12121212-1212-4212-8212-121212121212';
    const secondId = '23232323-2323-4232-8232-232323232323';
    expect((await upload('34343434-3434-4434-8434-343434343434', 1)).status).toBe(409);
    expect((await upload(firstId, 0)).status).toBe(200);
    const second = await upload(secondId, 1);
    expect(second.status).toBe(200);
    expect(syncMediaUploadResultSchema.parse(await second.json()).relativeRef)
      .toBe(`/api/assets/entries/${entryId}/preview-2.png`);
    expect((await upload(secondId, 1)).status).toBe(200);
    expect((await upload('45454545-4545-4454-8454-454545454545', 0)).status).toBe(409);
    const refs = JSON.parse(database.prepare('SELECT preview_refs FROM entries WHERE sync_uid = ?')
      .pluck().get(entryUid) as string) as string[];
    expect(refs).toEqual([
      `/api/assets/entries/${entryId}/preview.png`,
      `/api/assets/entries/${entryId}/preview-2.png`,
    ]);
    expect(database.prepare('SELECT COUNT(*) FROM sync_media_upload_receipts').pluck().get()).toBe(2);
    expect(existsSync(join(assetRoot, 'entries', String(entryId), 'preview-2.png'))).toBe(true);
    const snapshotResponse = await app.request('/api/sync/snapshot?media=thumbnails');
    const snapshot = syncSnapshotSchema.parse(await snapshotResponse.json());
    expect(snapshot.payload.entries.find((entry) => entry.id === entryId)?.previewRefs).toEqual(refs);
    expect(snapshot.payload.mediaRefs).toEqual(expect.arrayContaining(refs));
    const thumbnailResponse = await app.request(`/api/thumbnails/entries/${entryId}/preview-2.png`);
    expect(thumbnailResponse.status).toBe(302);
    expect((await app.request(thumbnailResponse.headers.get('location')!)).status).toBe(200);
    // A reordered authoritative list can already own the deterministic next
    // filename: count alone must not authorize overwriting that file.
    database.prepare('UPDATE entries SET preview_ref = ?, preview_refs = ? WHERE id = ?')
      .run(refs[1], JSON.stringify([refs[1]]), entryId);
    expect((await upload('56565656-5656-4565-8565-565656565656', 1)).status).toBe(409);
    expect(database.prepare('SELECT preview_refs FROM entries WHERE id = ?').pluck().get(entryId))
      .toBe(JSON.stringify([refs[1]]));
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
      resourceVersion: 4,
      serverSeq: 7,
    });
    expect(await apply(operation)).toEqual({
      opId: operation.opId,
      status: 'applied',
      resourceVersion: 4,
      serverSeq: 7,
    });
    expect(database.prepare('SELECT title FROM entries WHERE sync_uid = ?').pluck().get(resource.syncUid))
      .toBe('Offline title');
    expect(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(7);
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
      currentVersion: 4,
      currentValues: { title: 'Offline title' },
      serverSeq: 7,
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
      resourceVersion: 5,
      serverSeq: 8,
    });
    expect(database.prepare('SELECT page_count FROM entries WHERE sync_uid = ?').pluck().get(resource.syncUid))
      .toBe(24);
  });

  it('rolls back the Entry and journal when receipt persistence fails', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const beforeJournal = database.prepare('SELECT * FROM sync_changes ORDER BY seq').all();
    const beforeSequence = database.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_changes'").get();
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
    expect(database.prepare('SELECT * FROM sync_changes ORDER BY seq').all()).toEqual(beforeJournal);
    expect(database.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_changes'").get()).toEqual(beforeSequence);
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
    const beforeJournal = database.prepare('SELECT * FROM sync_changes ORDER BY seq').all();
    const beforeSequence = database.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_changes'").get();
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
    expect(database.prepare('SELECT * FROM sync_changes ORDER BY seq').all()).toEqual(beforeJournal);
    expect(database.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_changes'").get()).toEqual(beforeSequence);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(0);
  });

  it('rolls back an offline create and its registry when receipt persistence fails', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const beforeJournal = database.prepare('SELECT * FROM sync_changes ORDER BY seq').all();
    const beforeSequence = database.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_changes'").get();
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
    expect(database.prepare('SELECT * FROM sync_changes ORDER BY seq').all()).toEqual(beforeJournal);
    expect(database.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_changes'").get()).toEqual(beforeSequence);
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
      resourceVersion: 4,
      serverSeq: 7,
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
    `).get(resource.syncUid)).toEqual({ title: 'Survived the restart', syncVersion: 4 });
    expect(reopened.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(8);
    expect(reopened.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(1);
    expect(reopened.prepare(`
      SELECT entity_kind AS entityKind, entity_uid AS entityUid,
             deleted_version AS deletedVersion, change_seq AS changeSeq
      FROM sync_tombstones
    `).all()).toEqual([{
      entityKind: 'entry_content',
      entityUid: content.syncUid,
      deletedVersion: 2,
      changeSeq: 8,
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
    expect(first.header.changeSeq).toBe(6);
    expect(first.header.counts).toEqual({
      entries: 1, producers: 1, entryContents: 1, entryTags: 0, collections: 0,
    });
    expect(first.payload.entries[0]).toMatchObject({
      title: 'Endfield',
      type: 'game',
      syncUid: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      syncVersion: 3,
    });
    expect(first.payload.producers[0]).toMatchObject({
      name: 'Hypergryph',
      syncUid: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      syncVersion: 1,
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
    expect(second.header.changeSeq).toBe(6);
    expect(second.payload).toEqual(first.payload);

    // A write between snapshots is visible in the next generation.
    createEntry(database, { title: 'Hades II', type: 'game' });
    const third = syncSnapshotSchema.parse(await (await app.request('/api/sync/snapshot?media=thumbnails')).json());
    expect(third.header.snapshotSeq).toBe(3);
    expect(third.header.changeSeq).toBe(7);
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

  it('replays an atomic Content-list change once and journals every row', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const entry = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion
      FROM entries WHERE title = 'Endfield'
    `).get() as { id: number; syncUid: string; syncVersion: number };
    const source = database.prepare(`
      SELECT sync_uid AS syncUid, content_type AS contentType, content, sort_order AS sortOrder
      FROM entry_contents WHERE entry_id = ?
    `).get(entry.id) as { syncUid: string; contentType: string; content: string; sortOrder: number };
    const contents = [
      {
        syncUid: '85858585-8585-4585-8585-858585858585',
        contentType: 'Note', content: 'offline note', sortOrder: 0,
      },
      { ...source, content: 'https://hitomi.la/g/2.html', sortOrder: 1 },
    ];
    const operation = syncReplayOperationSchema.parse({
      opId: '86868686-8686-4686-8686-868686868686',
      clientId: 'android-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry',
      entityUid: entry.syncUid,
      operationKind: 'entry.contents.set',
      baseVersion: entry.syncVersion,
      baseValues: { contents: [source] },
      payload: { contents },
      clientCreatedAt: '2026-09-23T12:00:00.000Z',
    });
    const beforeSeq = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());

    const first = replaySyncOperation(database, operation);
    expect(first).toMatchObject({
      opId: operation.opId, status: 'applied', resourceVersion: entry.syncVersion + 1,
    });
    expect(database.prepare(`
      SELECT sync_uid AS syncUid, content_type AS contentType, content, sort_order AS sortOrder
      FROM entry_contents WHERE entry_id = ? ORDER BY sort_order
    `).all(entry.id)).toEqual(contents);
    expect(first.status === 'applied' ? first.serverSeq : -1).toBeGreaterThan(beforeSeq);
    const changeCount = Number(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get());
    expect(replaySyncOperation(database, operation)).toEqual(first);
    expect(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(changeCount);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(1);
  });

  it('conflicts when server Content changed without an Entry version change', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const identity = getSyncIdentity(database);
    const entry = database.prepare(`
      SELECT id, sync_uid AS syncUid, sync_version AS syncVersion
      FROM entries WHERE title = 'Endfield'
    `).get() as { id: number; syncUid: string; syncVersion: number };
    const source = database.prepare(`
      SELECT sync_uid AS syncUid, content_type AS contentType, content, sort_order AS sortOrder
      FROM entry_contents WHERE entry_id = ?
    `).get(entry.id) as { syncUid: string; contentType: string; content: string; sortOrder: number };
    updateEntryContent(database, Number(database.prepare(
      'SELECT id FROM entry_contents WHERE entry_id = ?',
    ).pluck().get(entry.id)), { content: 'https://server.test' });
    const operation = syncReplayOperationSchema.parse({
      opId: '87878787-8787-4787-8787-878787878787',
      clientId: 'android-client',
      libraryId: identity.libraryId,
      syncEpoch: identity.syncEpoch,
      entityKind: 'entry',
      entityUid: entry.syncUid,
      operationKind: 'entry.contents.set',
      baseVersion: entry.syncVersion,
      baseValues: { contents: [source] },
      payload: { contents: [{ ...source, content: 'https://offline.test' }] },
      clientCreatedAt: '2026-09-23T12:00:00.000Z',
    });

    expect(replaySyncOperation(database, operation)).toMatchObject({
      opId: operation.opId,
      status: 'conflict',
      currentVersion: entry.syncVersion,
      currentValues: { contents: [{ ...source, content: 'https://server.test' }] },
    });
    expect(database.prepare(`SELECT content FROM entry_contents WHERE sync_uid = ?`)
      .pluck().get(source.syncUid)).toBe('https://server.test');
  });

  it('conflicts on an equal-Entry-version Content edit made online since the snapshot', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const entry = database.prepare('SELECT id, sync_uid AS syncUid, sync_version AS syncVersion FROM entries LIMIT 1')
      .get() as { id: number; syncUid: string; syncVersion: number };
    const source = database.prepare(`
      SELECT sync_uid AS syncUid, content_type AS contentType, content, sort_order AS sortOrder
      FROM entry_contents WHERE entry_id = ? ORDER BY sort_order, id
    `).all(entry.id) as Array<{ syncUid: string; contentType: string; content: string; sortOrder: number }>;
    database.prepare('UPDATE entry_contents SET content = ? WHERE sync_uid = ?')
      .run('https://server.test/current', source[0]!.syncUid);
    const identity = getSyncIdentity(database);
    const operation = syncReplayOperationSchema.parse({
      opId: '95959595-9595-4595-8595-959595959595', clientId: 'content-client',
      libraryId: identity.libraryId, syncEpoch: identity.syncEpoch, entityKind: 'entry',
      entityUid: entry.syncUid, clientCreatedAt: '2026-09-23T00:00:00.000Z',
      operationKind: 'entry.contents.set', baseVersion: entry.syncVersion,
      baseValues: { contents: source },
      payload: { contents: source.map((content) => ({ ...content, content: 'https://offline.test/edit' })) },
    });

    expect(replaySyncOperation(database, operation)).toMatchObject({
      status: 'conflict', currentVersion: entry.syncVersion,
      currentValues: { contents: [{ syncUid: source[0]!.syncUid, content: 'https://server.test/current' }] },
    });
    expect(database.prepare('SELECT content FROM entry_contents WHERE sync_uid = ?').pluck()
      .get(source[0]!.syncUid)).toBe('https://server.test/current');
    expect(Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id)))
      .toBe(entry.syncVersion);
  });

  it('advances the Entry revision for a convergent Content op before replaying its dependent edit', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const entry = database.prepare('SELECT id, sync_uid AS syncUid, sync_version AS syncVersion FROM entries LIMIT 1')
      .get() as { id: number; syncUid: string; syncVersion: number };
    const source = database.prepare(`
      SELECT sync_uid AS syncUid, content_type AS contentType, content, sort_order AS sortOrder
      FROM entry_contents WHERE entry_id = ? ORDER BY sort_order, id
    `).all(entry.id) as Array<{ syncUid: string; contentType: string; content: string; sortOrder: number }>;
    const external = source.map((content) => ({
      ...content, content: 'https://external.test/current',
    }));
    const desired = external.map((content) => ({
      ...content, content: 'https://offline.test/next',
    }));
    database.prepare('UPDATE entry_contents SET content = ? WHERE sync_uid = ?')
      .run(external[0]!.content, source[0]!.syncUid);
    const identity = getSyncIdentity(database);
    const first = syncReplayOperationSchema.parse({
      opId: '93939393-9393-4393-8393-939393939393', clientId: 'content-client',
      libraryId: identity.libraryId, syncEpoch: identity.syncEpoch, entityKind: 'entry',
      entityUid: entry.syncUid, clientCreatedAt: '2026-09-23T00:00:00.000Z',
      operationKind: 'entry.contents.set', baseVersion: entry.syncVersion,
      baseValues: { contents: source }, payload: { contents: external },
    });
    const second = syncReplayOperationSchema.parse({
      ...first, opId: '94949494-9494-4494-8494-949494949494',
      clientCreatedAt: '2026-09-23T00:00:01.000Z',
      baseVersion: entry.syncVersion + 1,
      baseValues: { contents: external }, payload: { contents: desired },
    });

    expect(replaySyncOperation(database, first)).toMatchObject({
      status: 'applied', resourceVersion: entry.syncVersion + 1,
    });
    expect(replaySyncOperation(database, second)).toMatchObject({
      status: 'applied', resourceVersion: entry.syncVersion + 2,
    });
    expect(database.prepare('SELECT content FROM entry_contents WHERE sync_uid = ?').pluck()
      .get(source[0]!.syncUid)).toBe('https://offline.test/next');
  });

  it('rolls back the Entry and all Content rows when a Content update trigger aborts', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const entry = database.prepare('SELECT id, sync_uid AS syncUid, sync_version AS syncVersion FROM entries LIMIT 1')
      .get() as { id: number; syncUid: string; syncVersion: number };
    const source = database.prepare(`
      SELECT sync_uid AS syncUid, content_type AS contentType, content, sort_order AS sortOrder
      FROM entry_contents WHERE entry_id = ? LIMIT 1
    `).get(entry.id) as { syncUid: string; contentType: string; content: string; sortOrder: number };
    const operation = syncReplayOperationSchema.parse({
      opId: '92929292-9292-4292-8292-929292929292',
      clientId: 'content-client', libraryId: getSyncIdentity(database).libraryId,
      syncEpoch: getSyncIdentity(database).syncEpoch, entityKind: 'entry',
      entityUid: entry.syncUid, clientCreatedAt: '2026-09-23T00:00:00.000Z',
      operationKind: 'entry.contents.set', baseVersion: entry.syncVersion,
      baseValues: { contents: [source] },
      payload: { contents: [{ ...source, content: `${source.content} (offline edit)` }] },
    });
    const beforeChangeCount = Number(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get());
    database.exec(`CREATE TRIGGER fail_content_update BEFORE UPDATE ON entry_contents
      BEGIN SELECT RAISE(ABORT, 'forced Content update failure'); END;`);

    expect(() => replaySyncOperation(database, operation)).toThrow('forced Content update failure');
    database.exec('DROP TRIGGER fail_content_update');
    expect(database.prepare('SELECT content FROM entry_contents WHERE sync_uid = ?').pluck().get(source.syncUid))
      .toBe(source.content);
    expect(Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id)))
      .toBe(entry.syncVersion);
    expect(Number(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get())).toBe(beforeChangeCount);
    expect(Number(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId)))
      .toBe(0);
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
