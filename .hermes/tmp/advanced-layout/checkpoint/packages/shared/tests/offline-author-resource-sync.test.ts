import { describe, expect, it } from 'vitest';
import { syncReplayOperationSchema } from '@t3/shared';

const client = {
  opId: '11111111-1111-4111-8111-111111111111',
  clientId: 'offline-test-client',
  libraryId: '22222222-2222-4222-8222-222222222222',
  syncEpoch: 'epoch-test',
  clientCreatedAt: '2026-09-23T12:00:00.000Z',
};
const producerUid = '33333333-3333-4333-8333-333333333333';
const collectionUid = '44444444-4444-4444-8444-444444444444';
const layoutUid = '55555555-5555-4555-8555-555555555555';
const slotA = '66666666-6666-4666-8666-666666666666';
const slotB = '77777777-7777-4777-8777-777777777777';
const dirA = '88888888-8888-4888-8888-888888888888';
const entryA = '99999999-9999-4999-8999-999999999999';

function operation(input: Record<string, unknown>) {
  return syncReplayOperationSchema.safeParse({ ...client, ...input });
}

describe('offline Author resource replay contracts', () => {
  it('accepts rating slot creation and stable-UID reordering', () => {
    const create = operation({
      entityKind: 'rating_layout', entityUid: layoutUid,
      operationKind: 'rating-layout.slots.set', baseVersion: 3,
      baseValues: { slots: [{ syncUid: slotA, name: 'Taste', sortOrder: 0 }] },
      payload: { slots: [
        { syncUid: slotA, name: 'Taste', sortOrder: 0 },
        { syncUid: slotB, name: 'Craft', sortOrder: 1 },
      ] },
    });
    expect(create.success).toBe(true);

    const reorder = operation({
      entityKind: 'rating_layout', entityUid: layoutUid,
      operationKind: 'rating-layout.slots.set', baseVersion: 4,
      baseValues: { slots: [
        { syncUid: slotA, name: 'Taste', sortOrder: 0 },
        { syncUid: slotB, name: 'Craft', sortOrder: 1 },
      ] },
      payload: { slots: [
        { syncUid: slotB, name: 'Craft', sortOrder: 0 },
        { syncUid: slotA, name: 'Taste', sortOrder: 1 },
      ] },
    });
    expect(reorder.success).toBe(true);
  });

  it('rejects destructive slot changes, duplicate identities, non-append creation, and no-op layouts', () => {
    const base = {
      entityKind: 'rating_layout', entityUid: layoutUid,
      operationKind: 'rating-layout.slots.set', baseVersion: 3,
      baseValues: { slots: [
        { syncUid: slotA, name: 'Taste', sortOrder: 0 },
        { syncUid: slotB, name: 'Craft', sortOrder: 1 },
      ] },
    };
    expect(operation({ ...base, payload: { slots: [
      { syncUid: slotA, name: 'Taste', sortOrder: 0 },
    ] } }).success).toBe(false);
    expect(operation({ ...base, payload: { slots: [
      { syncUid: slotA, name: 'Renamed', sortOrder: 0 },
      { syncUid: slotB, name: 'Craft', sortOrder: 1 },
    ] } }).success).toBe(false);
    expect(operation({ ...base, payload: { slots: [
      { syncUid: slotA, name: 'Taste', sortOrder: 0 },
      { syncUid: slotA, name: 'Craft', sortOrder: 1 },
    ] } }).success).toBe(false);
    expect(operation({ ...base, payload: { slots: [
      { syncUid: slotA, name: 'Taste', sortOrder: 0 },
      { syncUid: slotB, name: 'Craft', sortOrder: 1 },
      { syncUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'More', sortOrder: 4 },
    ] } }).success).toBe(false);
    expect(operation({ ...base, payload: base.baseValues }).success).toBe(false);
  });

  it('accepts only a single Collection-owned Author-membership transition', () => {
    const valid = operation({
      entityKind: 'collection', entityUid: collectionUid,
      operationKind: 'collection.producer.set', baseVersion: 2,
      baseValues: { producerUid, present: false },
      payload: { producerUid, present: true },
    });
    expect(valid.success).toBe(true);
    expect(operation({
      entityKind: 'collection', entityUid: collectionUid,
      operationKind: 'collection.producer.set', baseVersion: 2,
      baseValues: { producerUid, present: false },
      payload: { producerUid: entryA, present: true },
    }).success).toBe(false);
    expect(operation({
      entityKind: 'collection', entityUid: collectionUid,
      operationKind: 'collection.producer.set', baseVersion: 2,
      baseValues: { producerUid, present: true },
      payload: { producerUid, present: true },
    }).success).toBe(false);
  });

  it('accepts only one Collection-owned Entry membership transition', () => {
    const valid = operation({
      entityKind: 'collection', entityUid: collectionUid,
      operationKind: 'collection.entry.set', baseVersion: 2,
      baseValues: { entryUid: entryA, present: false },
      payload: { entryUid: entryA, present: true },
    });
    expect(valid.success).toBe(true);
    expect(operation({
      entityKind: 'collection', entityUid: collectionUid,
      operationKind: 'collection.entry.set', baseVersion: 2,
      baseValues: { entryUid: entryA, present: false },
      payload: { entryUid: dirA, present: true },
    }).success).toBe(false);
    expect(operation({
      entityKind: 'collection', entityUid: collectionUid,
      operationKind: 'collection.entry.set', baseVersion: 2,
      baseValues: { entryUid: entryA, present: true },
      payload: { entryUid: entryA, present: true },
    }).success).toBe(false);
  });

  it('accepts a new Collection with client-stable identity and only valid parent scope', () => {
    const valid = operation({
      entityKind: 'collection', entityUid: collectionUid,
      operationKind: 'collection.create', baseVersion: 0, baseValues: {},
      payload: {
        kind: 'entry', title: 'Offline shelf', description: '', nsfw: false,
        parentUid: null, galleryType: 'comic',
      },
    });
    expect(valid.success).toBe(true);
    expect(operation({
      entityKind: 'collection', entityUid: collectionUid,
      operationKind: 'collection.create', baseVersion: 0, baseValues: {},
      payload: {
        kind: 'producer', title: 'Authors', description: '', nsfw: false,
        parentUid: collectionUid, galleryType: null,
      },
    }).success).toBe(false);
  });

  it('accepts Collection metadata changes with one captured owner state', () => {
    const valid = operation({
      entityKind: 'collection', entityUid: collectionUid,
      operationKind: 'collection.update', baseVersion: 2,
      baseValues: { title: 'Shelf', description: '', nsfw: false },
      payload: { title: 'Favorites', description: 'Curated', nsfw: true },
    });
    expect(valid.success).toBe(true);
    expect(operation({
      entityKind: 'collection', entityUid: collectionUid,
      operationKind: 'collection.update', baseVersion: 2,
      baseValues: { title: 'Shelf' },
      payload: { title: 'Favorites' },
    }).success).toBe(true);
    expect(operation({
      entityKind: 'collection', entityUid: collectionUid,
      operationKind: 'collection.update', baseVersion: 2,
      baseValues: { title: 'Shelf' },
      payload: { description: 'Curated' },
    }).success).toBe(false);
    expect(operation({
      entityKind: 'collection', entityUid: collectionUid,
      operationKind: 'collection.update', baseVersion: 2,
      baseValues: { title: 'Shelf', description: '', nsfw: false },
      payload: { title: 'Shelf', description: '', nsfw: false },
    }).success).toBe(false);
  });

  it('accepts a whole top-level Collection reorder with a complete version vector', () => {
    const secondCollectionUid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const valid = operation({
      entityKind: 'collection_order', entityUid: '00000000-0000-4000-8000-000000000001',
      operationKind: 'collection.order.set', baseVersion: 3,
      baseValues: { kind: 'entry', collections: [
        { syncUid: collectionUid, syncVersion: 1, sortOrder: 0 },
        { syncUid: secondCollectionUid, syncVersion: 2, sortOrder: 1 },
      ] },
      payload: { kind: 'entry', orderedCollectionUids: [secondCollectionUid, collectionUid] },
    });
    expect(valid.success).toBe(true);
    expect(operation({
      entityKind: 'collection_order', entityUid: '00000000-0000-4000-8000-000000000001',
      operationKind: 'collection.order.set', baseVersion: 3,
      baseValues: { kind: 'entry', collections: [
        { syncUid: collectionUid, syncVersion: 1, sortOrder: 0 },
        { syncUid: secondCollectionUid, syncVersion: 2, sortOrder: 1 },
      ] },
      payload: { kind: 'entry', orderedCollectionUids: [collectionUid, secondCollectionUid] },
    }).success).toBe(false);
  });

  it('accepts Directory creation with stable Entry identities, but rejects duplicates and deletion', () => {
    const valid = operation({
      entityKind: 'author_directory_set', entityUid: producerUid,
      operationKind: 'author.directories.set', baseVersion: 5,
      baseValues: { directories: [] },
      payload: { directories: [{
        syncUid: dirA, title: 'Grouped works', description: '', sortOrder: 0,
        entries: [{ syncUid: entryA, sortOrder: 0 }],
      }] },
    });
    expect(valid.success).toBe(true);

    const secondDirectoryUid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(operation({
      entityKind: 'author_directory_set', entityUid: producerUid,
      operationKind: 'author.directories.set', baseVersion: 5,
      baseValues: { directories: [] },
      payload: { directories: [
        { syncUid: dirA, title: 'A', description: '', sortOrder: 0, entries: [{ syncUid: entryA, sortOrder: 0 }] },
        { syncUid: secondDirectoryUid, title: 'B', description: '', sortOrder: 1, entries: [{ syncUid: entryA, sortOrder: 0 }] },
      ] },
    }).success).toBe(false);

    expect(operation({
      entityKind: 'author_directory_set', entityUid: producerUid,
      operationKind: 'author.directories.set', baseVersion: 6,
      baseValues: { directories: [{
        syncUid: dirA, title: 'A', description: '', sortOrder: 0, entries: [],
      }] },
      payload: { directories: [] },
    }).success).toBe(false);
  });

  it('accepts Entry-owned desired Author links and rejects duplicates/no-op states', () => {
    const secondProducerUid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const valid = operation({
      entityKind: 'entry', entityUid: entryA,
      operationKind: 'entry.authors.set', baseVersion: 3,
      baseValues: { producerUids: [producerUid] },
      payload: { producerUids: [secondProducerUid] },
    });
    expect(valid.success).toBe(true);
    expect(operation({
      entityKind: 'entry', entityUid: entryA,
      operationKind: 'entry.authors.set', baseVersion: 3,
      baseValues: { producerUids: [producerUid] },
      payload: { producerUids: [producerUid, producerUid] },
    }).success).toBe(false);
    expect(operation({
      entityKind: 'entry', entityUid: entryA,
      operationKind: 'entry.authors.set', baseVersion: 3,
      baseValues: { producerUids: [producerUid] },
      payload: { producerUids: [producerUid] },
    }).success).toBe(false);
    expect(operation({
      entityKind: 'entry', entityUid: entryA,
      operationKind: 'entry.authors.set', baseVersion: 3,
      baseValues: { producerUids: [producerUid] },
      payload: { producerUids: [] },
    }).success).toBe(true);
  });
});
