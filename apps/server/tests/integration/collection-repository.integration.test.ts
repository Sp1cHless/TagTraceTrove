import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createProducer } from '../../src/repositories/producer-repository.js';
import {
  addCollectionEntry,
  addCollectionProducer,
  createCollection,
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

  });
});
