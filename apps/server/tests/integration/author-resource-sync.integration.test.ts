import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createCollection, addCollectionEntry } from '../../src/repositories/collection-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { createRatingSlot, listRatingSlots } from '../../src/repositories/rating-repository.js';
import { getSyncIdentity, buildSyncCapabilities, buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { syncReplayOperationSchema } from '@t3/shared';

const databases: Array<ReturnType<typeof createMigratedMemoryDatabase>> = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup() {
  const database = createMigratedMemoryDatabase();
  databases.push(database);
  const author = createProducer(database, { name: 'Author' });
  const entry = createEntry(database, { title: 'Work', type: 'comic' });
  linkEntryProducer(database, entry.id, author.id);
  const identity = getSyncIdentity(database);
  return { database, author, entry, identity };
}

function envelope(
  database: ReturnType<typeof createMigratedMemoryDatabase>,
  identity: ReturnType<typeof getSyncIdentity>,
  input: Record<string, unknown>,
) {
  return syncReplayOperationSchema.parse({
    opId: randomUUID(),
    clientId: 'offline-test-client',
    libraryId: identity.libraryId,
    syncEpoch: identity.syncEpoch,
    clientCreatedAt: '2026-09-23T12:00:00.000Z',
    ...input,
  });
}

describe('Author resource sync boundaries', () => {
  it('publishes independent rating-layout, Collection, and Entry-Author capabilities at the current schema', () => {
    const { database } = setup();
    const capabilities = buildSyncCapabilities(database, 'test');
    expect(capabilities.sqliteSchemaVersion).toBe(44);
    expect(capabilities.featureFlags).toMatchObject({
      offlineRatingSlotLayout: true,
      offlineCollectionProducerMembership: true,
      offlineAuthorDirectories: true,
      offlineStandaloneAuthorDirectorySeed: true,
      offlineEntryAuthors: true,
    });

    const snapshot = buildSyncSnapshot(database);
    expect(snapshot.payload.ratingLayouts).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectKind: 'producer', entryType: 'comic', syncVersion: 1 }),
      expect.objectContaining({ subjectKind: 'entry', entryType: 'comic', syncVersion: 1 }),
    ]));
    expect(snapshot.payload.collections).toEqual([]);
  });

  it('creates and reorders shared rating slots with layout-owned revisions and exact replay', () => {
    const { database, entry, identity } = setup();
    const layout = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion
      FROM rating_slot_layouts WHERE subject_kind = 'producer' AND entry_type = 'comic'
    `).get() as { syncUid: string; syncVersion: number };
    const first = createRatingSlot(database, { kind: 'producer', entryType: 'comic', name: 'Taste' });
    const firstUid = String(database.prepare('SELECT sync_uid FROM rating_slots WHERE id = ?')
      .pluck().get(first.id));
    const afterFirst = Number(database.prepare(
      'SELECT sync_version FROM rating_slot_layouts WHERE sync_uid = ?',
    ).pluck().get(layout.syncUid));
    expect(afterFirst).toBe(layout.syncVersion + 1);

    const secondUid = randomUUID();
    const create = envelope(database, identity, {
      entityKind: 'rating_layout',
      entityUid: layout.syncUid,
      operationKind: 'rating-layout.slots.set',
      baseVersion: afterFirst,
      baseValues: { slots: [{ syncUid: firstUid, name: 'Taste', sortOrder: 0 }] },
      payload: { slots: [
        { syncUid: firstUid, name: 'Taste', sortOrder: 0 },
        { syncUid: secondUid, name: 'Technique', sortOrder: 1 },
      ] },
    });
    const created = replaySyncOperation(database, create);
    expect(created).toMatchObject({ status: 'applied', resourceVersion: afterFirst + 1 });
    expect(replaySyncOperation(database, create)).toEqual(created);
    expect(listRatingSlots(database, 'producer', 'comic').map((slot) => slot.name))
      .toEqual(['Taste', 'Technique']);

    const slots = database.prepare(`
      SELECT sync_uid AS syncUid, name, sort_order AS sortOrder
      FROM rating_slots WHERE subject_kind = 'producer' AND entry_type = 'comic'
      ORDER BY sort_order, id
    `).all() as Array<{ syncUid: string; name: string; sortOrder: number }>;
    const reordered = envelope(database, identity, {
      entityKind: 'rating_layout',
      entityUid: layout.syncUid,
      operationKind: 'rating-layout.slots.set',
      baseVersion: afterFirst + 1,
      baseValues: { slots },
      payload: { slots: [
        { ...slots[1]!, sortOrder: 0 },
        { ...slots[0]!, sortOrder: 1 },
      ] },
    });
    const result = replaySyncOperation(database, reordered);
    expect(result).toMatchObject({ status: 'applied', resourceVersion: afterFirst + 3 });
    expect(listRatingSlots(database, 'producer', 'comic').map((slot) => slot.name))
      .toEqual(['Technique', 'Taste']);

    const unrelatedLayoutVersion = Number(database.prepare(`
      SELECT sync_version FROM rating_slot_layouts
      WHERE subject_kind = 'entry' AND entry_type = 'comic'
    `).pluck().get());
    createRatingSlot(database, { kind: 'entry', entryType: 'comic', name: 'Entry-only' });
    expect(Number(database.prepare(`
      SELECT sync_version FROM rating_slot_layouts
      WHERE subject_kind = 'entry' AND entry_type = 'comic'
    `).pluck().get())).toBe(unrelatedLayoutVersion + 1);
    expect(database.prepare('SELECT COUNT(*) FROM entries WHERE id = ?').pluck().get(entry.id)).toBe(1);
  });

  it('resolves Entry-create ratings by stable slot UID when an Entry layout is offline-created first', () => {
    const { database, identity } = setup();
    const layout = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion
      FROM rating_slot_layouts WHERE subject_kind = 'entry' AND entry_type = 'comic'
    `).get() as { syncUid: string; syncVersion: number };
    const slotUid = randomUUID();
    const layoutOperation = envelope(database, identity, {
      entityKind: 'rating_layout',
      entityUid: layout.syncUid,
      operationKind: 'rating-layout.slots.set',
      baseVersion: layout.syncVersion,
      baseValues: { slots: [] },
      payload: { slots: [{ syncUid: slotUid, name: 'Technique', sortOrder: 0 }] },
    });
    expect(replaySyncOperation(database, layoutOperation)).toMatchObject({ status: 'applied', resourceVersion: 2 });

    const newEntryUid = randomUUID();
    const create = envelope(database, identity, {
      entityKind: 'entry', entityUid: newEntryUid,
      operationKind: 'entry.create', baseVersion: 0, baseValues: {},
      payload: {
        title: 'Offline created work', type: 'comic', uploadDate: null, pageCount: null,
        ratings: [{ slotUid, stars: 4.5 }], viewLater: false,
      },
    });
    const result = replaySyncOperation(database, create);
    expect(result).toMatchObject({ status: 'applied', resourceVersion: 1 });
    const entryId = Number(database.prepare('SELECT id FROM entries WHERE sync_uid = ?').pluck().get(newEntryUid));
    expect(database.prepare('SELECT stars FROM entry_rating_values WHERE entry_id = ?').pluck().get(entryId)).toBe(4.5);
  });

  it('rejects duplicate Entry-create ratings that identify one slot by ID and UID', () => {
    const { database, identity } = setup();
    const slot = createRatingSlot(database, { kind: 'entry', entryType: 'comic', name: 'Technique' });
    const slotUid = String(database.prepare('SELECT sync_uid FROM rating_slots WHERE id = ?')
      .pluck().get(slot.id));
    const newEntryUid = randomUUID();
    const create = envelope(database, identity, {
      entityKind: 'entry', entityUid: newEntryUid,
      operationKind: 'entry.create', baseVersion: 0, baseValues: {},
      payload: {
        title: 'Duplicate rating request', type: 'comic', uploadDate: null, pageCount: null,
        ratings: [
          { slotId: slot.id, stars: 3 },
          { slotUid, stars: 4.5 },
        ],
        viewLater: false,
      },
    });

    expect(replaySyncOperation(database, create)).toMatchObject({
      status: 'failed', errorCode: 'invalid-create', detail: 'A rating slot may only appear once',
    });
    expect(database.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?').pluck().get(newEntryUid)).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM entry_rating_values').pluck().get()).toBe(0);
  });

  it('creates stable offline Collections and resolves nested parents by UID', () => {
    const { database, identity } = setup();
    const rootUid = randomUUID();
    const rootCreate = envelope(database, identity, {
      entityKind: 'collection', entityUid: rootUid,
      operationKind: 'collection.create', baseVersion: 0, baseValues: {},
      payload: {
        kind: 'entry', title: 'Offline shelf', description: 'saved offline', nsfw: false,
        parentUid: null, galleryType: 'comic',
      },
    });
    const rootResult = replaySyncOperation(database, rootCreate);
    expect(rootResult).toMatchObject({ status: 'applied', resourceVersion: 1 });
    expect(rootResult.status === 'applied' ? rootResult.entityId : null).toEqual(expect.any(Number));
    expect(replaySyncOperation(database, rootCreate)).toEqual(rootResult);
    const root = database.prepare(`
      SELECT id, kind, title, description, nsfw, parent_id AS parentId,
        gallery_type AS galleryType, sync_uid AS syncUid, sync_version AS syncVersion
      FROM collections WHERE sync_uid = ?
    `).get(rootUid) as Record<string, unknown>;
    expect(root).toMatchObject({ kind: 'entry', title: 'Offline shelf', description: 'saved offline',
      nsfw: 0, parentId: null, galleryType: 'comic', syncUid: rootUid, syncVersion: 1 });

    const childUid = randomUUID();
    const childCreate = envelope(database, identity, {
      entityKind: 'collection', entityUid: childUid,
      operationKind: 'collection.create', baseVersion: 0, baseValues: {},
      payload: {
        kind: 'entry', title: 'Nested shelf', description: '', nsfw: false,
        parentUid: rootUid, galleryType: 'comic',
      },
    });
    expect(replaySyncOperation(database, childCreate)).toMatchObject({ status: 'applied', resourceVersion: 1 });
    const child = database.prepare(`
      SELECT parent_id AS parentId, gallery_type AS galleryType, sync_uid AS syncUid
      FROM collections WHERE sync_uid = ?
    `).get(childUid) as Record<string, unknown>;
    expect(child).toEqual({ parentId: root.id, galleryType: 'comic', syncUid: childUid });
  });

  it('replays Collection Producer membership on the Collection revision, not the Producer revision', () => {
    const { database, author, identity } = setup();
    const collection = createCollection(database, { kind: 'producer', title: 'Favorites' });
    const current = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM collections WHERE id = ?
    `).get(collection.id) as { syncUid: string; syncVersion: number };
    const producer = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?
    `).get(author.id) as { syncUid: string; syncVersion: number };
    const operation = envelope(database, identity, {
      entityKind: 'collection',
      entityUid: current.syncUid,
      operationKind: 'collection.producer.set',
      baseVersion: current.syncVersion,
      baseValues: { producerUid: producer.syncUid, present: false },
      payload: { producerUid: producer.syncUid, present: true },
    });
    const result = replaySyncOperation(database, operation);
    expect(result).toMatchObject({ status: 'applied', resourceVersion: current.syncVersion + 1 });
    expect(replaySyncOperation(database, operation)).toEqual(result);
    expect(database.prepare('SELECT COUNT(*) FROM collection_producers WHERE collection_id = ? AND producer_id = ?')
      .pluck().get(collection.id, author.id)).toBe(1);
    expect(Number(database.prepare('SELECT sync_version FROM producers WHERE id = ?')
      .pluck().get(author.id))).toBe(producer.syncVersion);

    const remove = envelope(database, identity, {
      entityKind: 'collection',
      entityUid: current.syncUid,
      operationKind: 'collection.producer.set',
      baseVersion: current.syncVersion + 1,
      baseValues: { producerUid: producer.syncUid, present: true },
      payload: { producerUid: producer.syncUid, present: false },
    });
    expect(replaySyncOperation(database, remove)).toMatchObject({
      status: 'applied', resourceVersion: current.syncVersion + 2,
    });
    expect(database.prepare('SELECT COUNT(*) FROM collection_producers WHERE collection_id = ?')
      .pluck().get(collection.id)).toBe(0);
  });

  it('replays Collection Entry membership with exact Collection-owned revisions', () => {
    const { database, entry, identity } = setup();
    const collection = createCollection(database, { kind: 'entry', title: 'Reading list' });
    const current = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM collections WHERE id = ?
    `).get(collection.id) as { syncUid: string; syncVersion: number };
    const entryUid = String(database.prepare('SELECT sync_uid FROM entries WHERE id = ?')
      .pluck().get(entry.id));
    const add = envelope(database, identity, {
      entityKind: 'collection', entityUid: current.syncUid,
      operationKind: 'collection.entry.set', baseVersion: current.syncVersion,
      baseValues: { entryUid, present: false },
      payload: { entryUid, present: true },
    });

    const added = replaySyncOperation(database, add);
    expect(added).toMatchObject({ status: 'applied', resourceVersion: current.syncVersion + 1 });
    expect(replaySyncOperation(database, add)).toEqual(added);
    expect(Number(database.prepare(`
      SELECT COUNT(*) FROM collection_entries WHERE collection_id = ? AND entry_id = ?
    `).pluck().get(collection.id, entry.id))).toBe(1);

    const stale = envelope(database, identity, {
      entityKind: 'collection', entityUid: current.syncUid,
      operationKind: 'collection.entry.set', baseVersion: current.syncVersion + 2,
      baseValues: { entryUid, present: true },
      payload: { entryUid, present: false },
    });
    expect(replaySyncOperation(database, stale)).toMatchObject({ status: 'conflict' });

    const remove = envelope(database, identity, {
      entityKind: 'collection', entityUid: current.syncUid,
      operationKind: 'collection.entry.set', baseVersion: current.syncVersion + 1,
      baseValues: { entryUid, present: true },
      payload: { entryUid, present: false },
    });
    expect(replaySyncOperation(database, remove)).toMatchObject({
      status: 'applied', resourceVersion: current.syncVersion + 2,
    });
    expect(Number(database.prepare('SELECT COUNT(*) FROM collection_entries WHERE collection_id = ?')
      .pluck().get(collection.id))).toBe(0);
  });

  it('merges disjoint Collection metadata fields using the captured patch only', () => {
    const { database, identity } = setup();
    const collection = createCollection(database, { kind: 'entry', title: 'Shelf' });
    database.prepare(`
      UPDATE collections SET description = 'Changed elsewhere', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(collection.id);
    const current = database.prepare(
      'SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM collections WHERE id = ?',
    ).get(collection.id) as { syncUid: string; syncVersion: number };
    expect(current.syncVersion).toBe(2);

    const operation = envelope(database, identity, {
      entityKind: 'collection', entityUid: current.syncUid,
      operationKind: 'collection.update', baseVersion: 1,
      baseValues: { title: 'Shelf' }, payload: { title: 'Favorites' },
    });
    const result = replaySyncOperation(database, operation);
    if (result.status !== 'applied') throw new Error(`Expected applied replay, received ${result.status}`);
    expect(result.resourceVersion).toBe(3);
    expect(database.prepare(`
      SELECT title, description, sync_version AS syncVersion FROM collections WHERE id = ?
    `).get(collection.id)).toEqual({ title: 'Favorites', description: 'Changed elsewhere', syncVersion: 3 });
  });

  it('replays Collection metadata as one versioned desired state', () => {
    const { database, identity } = setup();
    const collection = createCollection(database, { kind: 'entry', title: 'Shelf' });
    const current = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion, title, description, nsfw
      FROM collections WHERE id = ?
    `).get(collection.id) as {
      syncUid: string; syncVersion: number; title: string; description: string; nsfw: number;
    };
    const operation = envelope(database, identity, {
      entityKind: 'collection', entityUid: current.syncUid,
      operationKind: 'collection.update', baseVersion: current.syncVersion,
      baseValues: { title: current.title, description: current.description, nsfw: current.nsfw === 1 },
      payload: { title: 'Favorites', description: 'Curated set', nsfw: true },
    });
    const updated = replaySyncOperation(database, operation);
    expect(updated).toMatchObject({ status: 'applied', resourceVersion: current.syncVersion + 1 });
    expect(replaySyncOperation(database, operation)).toEqual(updated);
    expect(database.prepare(`
      SELECT title, description, nsfw FROM collections WHERE id = ?
    `).get(collection.id)).toEqual({ title: 'Favorites', description: 'Curated set', nsfw: 1 });

    const stale = envelope(database, identity, {
      entityKind: 'collection', entityUid: current.syncUid,
      operationKind: 'collection.update', baseVersion: current.syncVersion,
      baseValues: { title: current.title, description: current.description, nsfw: current.nsfw === 1 },
      payload: { title: 'Competing edit', description: current.description, nsfw: false },
    });
    expect(replaySyncOperation(database, stale)).toMatchObject({ status: 'conflict' });
    expect(database.prepare('SELECT title FROM collections WHERE id = ?').pluck().get(collection.id))
      .toBe('Favorites');
  });

  it('reorders the complete Collection scope atomically with per-Collection revision deltas', () => {
    const { database, identity } = setup();
    const collections = ['First', 'Middle', 'Last'].map((title) => (
      createCollection(database, { kind: 'entry', title })
    ));
    const base = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion, sort_order AS sortOrder
      FROM collections WHERE kind = 'entry' AND parent_id IS NULL ORDER BY sort_order, id
    `).all() as Array<{ syncUid: string; syncVersion: number; sortOrder: number }>;
    const byTitleUid = new Map(collections.map((row) => [row.title, String(database.prepare(
      'SELECT sync_uid FROM collections WHERE id = ?',
    ).pluck().get(row.id))]));
    const baseVersion = base.reduce((sum, row) => sum + row.syncVersion, 0);
    const desired = [byTitleUid.get('Last')!, byTitleUid.get('Middle')!, byTitleUid.get('First')!];
    const operation = envelope(database, identity, {
      entityKind: 'collection_order', entityUid: '00000000-0000-4000-8000-000000000001',
      operationKind: 'collection.order.set', baseVersion,
      baseValues: { kind: 'entry', collections: base },
      payload: { kind: 'entry', orderedCollectionUids: desired },
    });
    const changedCount = desired.reduce((count, uid, index) => (
      count + (base[index]?.syncUid === uid ? 0 : 1)
    ), 0);
    const result = replaySyncOperation(database, operation);
    expect(result).toMatchObject({ status: 'applied', resourceVersion: baseVersion + changedCount });
    expect(replaySyncOperation(database, operation)).toEqual(result);
    expect(database.prepare(`
      SELECT sync_uid AS syncUid FROM collections
      WHERE kind = 'entry' AND parent_id IS NULL ORDER BY sort_order, id
    `).all()).toEqual(desired.map((syncUid) => ({ syncUid })));
    expect(Number(database.prepare(`
      SELECT SUM(sync_version) FROM collections WHERE kind = 'entry' AND parent_id IS NULL
    `).pluck().get())).toBe(baseVersion + changedCount);

    const conflict = envelope(database, identity, {
      entityKind: 'collection_order', entityUid: '00000000-0000-4000-8000-000000000001',
      operationKind: 'collection.order.set', baseVersion,
      baseValues: { kind: 'entry', collections: base },
      payload: { kind: 'entry', orderedCollectionUids: [desired[1]!, desired[2]!, desired[0]!] },
    });
    expect(replaySyncOperation(database, conflict)).toMatchObject({ status: 'conflict' });
  });

  it('replays Directory creation and Entry membership atomically on the Directory-set revision, independent of the Producer revision', () => {
    const { database, author, entry, identity } = setup();
    const producer = database.prepare(`
      SELECT sync_version AS syncVersion FROM producers WHERE id = ?
    `).get(author.id) as { syncVersion: number };
    const directorySet = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion
      FROM author_directory_sets WHERE producer_id = ?
    `).get(author.id) as { syncUid: string; syncVersion: number };
    const entryUid = String(database.prepare('SELECT sync_uid FROM entries WHERE id = ?')
      .pluck().get(entry.id));
    const directoryUid = randomUUID();
    const operation = envelope(database, identity, {
      entityKind: 'author_directory_set',
      entityUid: directorySet.syncUid,
      operationKind: 'author.directories.set',
      baseVersion: directorySet.syncVersion,
      baseValues: { directories: [] },
      payload: { directories: [{
        syncUid: directoryUid,
        title: 'Selected works',
        description: '',
        sortOrder: 0,
        entries: [{ syncUid: entryUid, sortOrder: 0 }],
      }] },
    });
    const result = replaySyncOperation(database, operation);
    expect(result).toMatchObject({ status: 'applied', resourceVersion: directorySet.syncVersion + 2 });
    expect(replaySyncOperation(database, operation)).toEqual(result);
    expect(database.prepare(`
      SELECT directory.sync_uid AS directoryUid, entry.sync_uid AS entryUid
      FROM author_directory_entries AS membership
      JOIN author_directories AS directory ON directory.id = membership.directory_id
      JOIN entries AS entry ON entry.id = membership.entry_id
      WHERE membership.producer_id = ?
    `).get(author.id)).toEqual({ directoryUid, entryUid });

    const stale = envelope(database, identity, {
      entityKind: 'author_directory_set',
      entityUid: directorySet.syncUid,
      operationKind: 'author.directories.set',
      baseVersion: directorySet.syncVersion,
      baseValues: { directories: [] },
      payload: { directories: [{
        syncUid: randomUUID(), title: 'Conflicting directory', description: '', sortOrder: 0, entries: [],
      }] },
    });
    expect(replaySyncOperation(database, stale)).toMatchObject({ status: 'conflict' });
    expect(database.prepare('SELECT COUNT(*) FROM author_directories WHERE producer_id = ?')
      .pluck().get(author.id)).toBe(1);

    const invalid = envelope(database, identity, {
      entityKind: 'author_directory_set',
      entityUid: directorySet.syncUid,
      operationKind: 'author.directories.set',
      baseVersion: directorySet.syncVersion + 2,
      baseValues: { directories: [{
        syncUid: directoryUid, title: 'Selected works', description: '', sortOrder: 0,
        entries: [{ syncUid: entryUid, sortOrder: 0 }],
      }] },
      payload: { directories: [{
        syncUid: directoryUid, title: 'Selected works', description: '', sortOrder: 0,
        entries: [{ syncUid: randomUUID(), sortOrder: 0 }],
      }] },
    });
    const beforeVersion = Number(database.prepare('SELECT sync_version FROM author_directory_sets WHERE producer_id = ?')
      .pluck().get(author.id));
    expect(replaySyncOperation(database, invalid)).toMatchObject({ status: 'failed' });
    expect(Number(database.prepare('SELECT sync_version FROM author_directory_sets WHERE producer_id = ?')
      .pluck().get(author.id))).toBe(beforeVersion);
    expect(Number(database.prepare('SELECT sync_version FROM producers WHERE id = ?')
      .pluck().get(author.id))).toBe(producer.syncVersion);
  });

  it('journals online Entry-Author relationship writes and replays desired link sets atomically', () => {
    const { database, author, entry, identity } = setup();
    const secondAuthor = createProducer(database, { name: 'Second author' });
    const thirdAuthor = createProducer(database, { name: 'Third author' });
    const entryUid = String(database.prepare('SELECT sync_uid FROM entries WHERE id = ?').pluck().get(entry.id));
    const authorUid = String(database.prepare('SELECT sync_uid FROM producers WHERE id = ?').pluck().get(author.id));
    const secondUid = String(database.prepare('SELECT sync_uid FROM producers WHERE id = ?').pluck().get(secondAuthor.id));
    const thirdUid = String(database.prepare('SELECT sync_uid FROM producers WHERE id = ?').pluck().get(thirdAuthor.id));
    const initialVersion = Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id));

    linkEntryProducer(database, entry.id, secondAuthor.id);
    expect(Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id)))
      .toBe(initialVersion + 1);
    const linkedVersion = initialVersion + 1;
    const addThird = envelope(database, identity, {
      entityKind: 'entry', entityUid: entryUid, operationKind: 'entry.authors.set',
      baseVersion: linkedVersion,
      baseValues: { producerUids: [authorUid, secondUid] },
      payload: { producerUids: [authorUid, secondUid, thirdUid] },
    });
    const applied = replaySyncOperation(database, addThird);
    expect(applied).toMatchObject({ status: 'applied', resourceVersion: linkedVersion + 1 });
    expect(replaySyncOperation(database, addThird)).toEqual(applied);
    const convergent = envelope(database, identity, {
      entityKind: 'entry', entityUid: entryUid, operationKind: 'entry.authors.set',
      baseVersion: linkedVersion,
      baseValues: { producerUids: [authorUid, secondUid] },
      payload: { producerUids: [authorUid, secondUid, thirdUid] },
    });
    expect(replaySyncOperation(database, convergent)).toMatchObject({
      status: 'applied', resourceVersion: linkedVersion + 1,
    });
    const dependent = envelope(database, identity, {
      entityKind: 'entry', entityUid: entryUid, operationKind: 'entry.view-later.set',
      baseVersion: linkedVersion + 1, baseValues: { present: false }, payload: { present: true },
    });
    expect(replaySyncOperation(database, dependent)).toMatchObject({
      status: 'applied', resourceVersion: linkedVersion + 2,
    });
    expect(database.prepare(`
      SELECT producer.sync_uid AS syncUid FROM entry_producers AS relation
      JOIN producers AS producer ON producer.id = relation.producer_id
      WHERE relation.entry_id = ? ORDER BY producer.sync_uid
    `).all(entry.id)).toEqual([
      { syncUid: authorUid }, { syncUid: secondUid }, { syncUid: thirdUid },
    ].sort((left, right) => left.syncUid.localeCompare(right.syncUid)));

    const stale = envelope(database, identity, {
      entityKind: 'entry', entityUid: entryUid, operationKind: 'entry.authors.set',
      baseVersion: linkedVersion,
      baseValues: { producerUids: [authorUid, secondUid] },
      payload: { producerUids: [authorUid] },
    });
    expect(replaySyncOperation(database, stale)).toMatchObject({ status: 'conflict' });
    expect(database.prepare('SELECT COUNT(*) FROM entry_producers WHERE entry_id = ?').pluck().get(entry.id)).toBe(3);

    const invalid = envelope(database, identity, {
      entityKind: 'entry', entityUid: entryUid, operationKind: 'entry.authors.set',
      baseVersion: linkedVersion + 2,
      baseValues: { producerUids: [authorUid, secondUid, thirdUid] },
      payload: { producerUids: [authorUid, secondUid, randomUUID()] },
    });
    expect(replaySyncOperation(database, invalid)).toMatchObject({
      status: 'failed', errorCode: 'invalid-author-data',
    });
    database.prepare('DELETE FROM entry_producers WHERE entry_id = ? AND producer_id = ?')
      .run(entry.id, secondAuthor.id);
    expect(Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id)))
      .toBe(linkedVersion + 3);
  });

  it('increments Collection revision for its other membership owner and reports stable Directory identities', () => {
    const { database, author, entry } = setup();
    const collection = createCollection(database, { kind: 'entry', title: 'Works' });
    const collectionVersion = Number(database.prepare('SELECT sync_version FROM collections WHERE id = ?')
      .pluck().get(collection.id));
    addCollectionEntry(database, collection.id, entry.id);
    expect(Number(database.prepare('SELECT sync_version FROM collections WHERE id = ?')
      .pluck().get(collection.id))).toBe(collectionVersion + 1);

    const producerVersionBeforeDirectory = Number(database.prepare('SELECT sync_version FROM producers WHERE id = ?')
      .pluck().get(author.id));
    const directorySetVersionBeforeDirectory = Number(database.prepare(
      'SELECT sync_version FROM author_directory_sets WHERE producer_id = ?',
    ).pluck().get(author.id));
    const directoryId = Number(database.prepare(`
      INSERT INTO author_directories (producer_id, title, description, sort_order)
      VALUES (?, 'Existing', '', 0)
    `).run(author.id).lastInsertRowid);
    const directoryUid = String(database.prepare('SELECT sync_uid FROM author_directories WHERE id = ?')
      .pluck().get(directoryId));
    expect(directoryUid).toMatch(/^[0-9a-f-]{36}$/u);
    expect(Number(database.prepare('SELECT sync_version FROM author_directory_sets WHERE producer_id = ?')
      .pluck().get(author.id))).toBe(directorySetVersionBeforeDirectory + 1);
    expect(Number(database.prepare('SELECT sync_version FROM producers WHERE id = ?')
      .pluck().get(author.id))).toBe(producerVersionBeforeDirectory);
  });
});
