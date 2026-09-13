import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createProducer } from '../../src/repositories/producer-repository.js';
import {
  addCollectionEntry,
  addCollectionProducer,
  createCollection,
  createCollectionFromEntries,
  deleteCollection,
  getCollection,
  listCollectionIdsForEntry,
  listCollectionIdsForProducer,
  listCollections,
  reorderCollections,
  setCollectionNsfw,
  updateCollection,
} from '../../src/repositories/collection-repository.js';

type TestDatabase = ReturnType<typeof createMigratedMemoryDatabase>;

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('temporary collection from a batch import', () => {
  it('numbers each saved batch 临时, 临时2, 临时3 and files every Entry', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const first = createEntry(database, { title: 'First batch work', type: 'comic' });
    const second = createEntry(database, { title: 'Second batch work', type: 'comic' });
    const third = createEntry(database, { title: 'Third batch work', type: 'comic' });

    const one = createCollectionFromEntries(database, [first.id, second.id]);
    expect(one).toEqual({ collectionId: one.collectionId, title: '临时', entryCount: 2 });
    const two = createCollectionFromEntries(database, [third.id]);
    expect(two.title).toBe('临时2');
    const three = createCollectionFromEntries(database, [third.id]);
    expect(three.title).toBe('临时3');

    // Each saved batch is its own Collection, and the members are the Entries.
    const titles = listCollections(database, 'entry').map((collection) => collection.title);
    expect(titles).toEqual(['临时', '临时2', '临时3']);
    expect(getCollection(database, one.collectionId)?.entries.map((entry) => entry.id))
      .toEqual([first.id, second.id]);
    // Repeating an id inside one request does not duplicate the member.
    expect(createCollectionFromEntries(database, [first.id, first.id]).entryCount).toBe(1);

    database.close();
  });

  it('skips Entries that no longer exist instead of failing the whole save', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const work = createEntry(database, { title: 'Still here', type: 'comic' });

    const saved = createCollectionFromEntries(database, [work.id, 9_999]);

    expect(saved.entryCount).toBe(1);
    expect(getCollection(database, saved.collectionId)?.entries.map((entry) => entry.id))
      .toEqual([work.id]);
    database.close();
  });
});

describe('collections (real SQL)', () => {
  it('creates entry collections with one nesting level, membership, and derived covers', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const work = createEntry(database, { title: 'Member Work', type: 'comic' });

    const parent = createCollection(database, { kind: 'entry', title: 'Series X' });
    const child = createCollection(database, {
      kind: 'entry', title: 'Season 1', parentId: parent.id,
    });
    addCollectionEntry(database, child.id, work.id);

    const listed = listCollections(database, 'entry');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.children).toHaveLength(1);
    expect(listed[0]!.children[0]!.entries[0]!.title).toBe('Member Work');

    // Two nesting levels are rejected.
    expect(() => createCollection(database, {
      kind: 'entry', title: 'Deep', parentId: child.id,
    })).toThrow(/one level/);

    // Membership is idempotent and reported for the add-to menu.
    addCollectionEntry(database, child.id, work.id);
    expect(listCollectionIdsForEntry(database, work.id)).toEqual([child.id]);

    // The flattened lookup finds nested collections too.
    expect(getCollection(database, child.id)?.title).toBe('Season 1');

    // Deleting a parent cascades to its children.
    deleteCollection(database, parent.id);
    expect(listCollections(database, 'entry')).toEqual([]);
    expect(listCollectionIdsForEntry(database, work.id)).toEqual([]);
  });

  it('manages producer collections, titles, nsfw, and ordering', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const author = createProducer(database, { name: 'Favourite Author' });

    const first = createCollection(database, { kind: 'producer', title: 'Studios' });
    const second = createCollection(database, { kind: 'producer', title: 'Artists' });
    addCollectionProducer(database, first.id, author.id);

    expect(listCollectionIdsForProducer(database, author.id)).toEqual([first.id]);

    updateCollection(database, first.id, { title: 'Favourite Studios', description: 'Go-to studios' });
    const updated = getCollection(database, first.id)!;
    expect(updated.title).toBe('Favourite Studios');
    expect(updated.description).toBe('Go-to studios');
    expect(updated.producers[0]!.name).toBe('Favourite Author');

    setCollectionNsfw(database, second.id, true);
    expect(getCollection(database, second.id)!.nsfw).toBe(true);

    reorderCollections(database, 'producer', [second.id, first.id]);
    expect(listCollections(database, 'producer').map((record) => record.id))
      .toEqual([second.id, first.id]);
    expect(() => reorderCollections(database, 'producer', [first.id]))
      .toThrow(/exactly once/);
  });

  it('saves a batch import into a numbered temporary Collection through HTTP', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const first = createEntry(database, { title: 'Batch one', type: 'comic' });
    const second = createEntry(database, { title: 'Batch two', type: 'comic' });
    const app = createApiApp(database);
    const save = (entryIds: number[]) => app.request('/api/collections/temporary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryIds }),
    });

    const saved = await save([first.id, second.id]);
    expect(saved.status).toBe(201);
    await expect(saved.json()).resolves.toEqual({
      collectionId: expect.any(Number),
      title: '临时',
      entryCount: 2,
    });
    // A second batch is numbered, never merged into the first.
    await expect((await save([first.id])).json()).resolves.toMatchObject({ title: '临时2' });
    expect(listCollections(database, 'entry').map((collection) => collection.title))
      .toEqual(['临时', '临时2']);

    // An empty id list is a validation error, not an empty Collection.
    expect((await save([])).status).toBe(400);
    database.close();
  });

  it('exposes collection CRUD through HTTP routes', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const work = createEntry(database, { title: 'Routed Work', type: 'comic' });
    const app = createApiApp(database);

    const created = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'entry', title: 'Read list' }),
    });
    expect(created.status).toBe(201);
    const collection = await created.json() as { id: number };

    const membership = await app.request(`/api/collections/${collection.id}/entries/${work.id}`, {
      method: 'PUT',
    });
    expect(membership.status).toBe(200);

    const detail = await app.request('/api/collections?kind=entry&compact=true&includeNsfw=true');
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual([
      expect.objectContaining({
        id: collection.id,
        title: 'Read list',
        entryCount: 1,
        entries: [expect.objectContaining({ id: work.id, title: 'Routed Work' })],
      }),
    ]);

    const nsfw = await app.request(`/api/collections/${collection.id}/nsfw`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nsfw: true }),
    });
    expect(nsfw.status).toBe(200);
    const nsfwDetail = await app.request('/api/collections?kind=entry&compact=true&includeNsfw=true');
    expect((await nsfwDetail.json() as Array<{ nsfw: boolean }>)[0]).toMatchObject({ nsfw: true });

    const removal = await app.request(`/api/collections/${collection.id}/entries/${work.id}`, {
      method: 'DELETE',
    });
    expect(removal.status).toBe(200);
    expect(listCollectionIdsForEntry(database, work.id)).toEqual([]);
    expect(database.prepare('SELECT id FROM entries WHERE id = ?').get(work.id))
      .toEqual({ id: work.id });

  });
});
