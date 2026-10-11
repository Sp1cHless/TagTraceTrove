import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { setGalleryPartition } from '../../src/repositories/partition-repository.js';
import {
  assignEntryTag,
  searchEntriesByTitle,
  searchEntryTags,
} from '../../src/repositories/entry-tag-repository.js';
import { searchProducersByName } from '../../src/repositories/producer-tag-repository.js';
import {
  importTaxonomyAliases,
  upsertTaxonomyAlias,
} from '../../src/repositories/taxonomy-repository.js';

type TestDatabase = ReturnType<typeof createMigratedMemoryDatabase>;
const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('global search', () => {
  it('finds an Entry title with one nearby typo while treating wildcard characters literally', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    createEntry(database, { title: 'Arknights: Endfield', type: 'game' });
    createEntry(database, { title: '100% Orange Juice', type: 'game' });
    createEntry(database, { title: 'Other Work', type: 'comic' });

    expect(searchEntriesByTitle(database, 'endfeld').map((entry) => entry.title))
      .toEqual(['Arknights: Endfield']);
    expect(searchEntriesByTitle(database, '%').map((entry) => entry.title))
      .toEqual(['100% Orange Juice']);
  });

  it('applies the same typo-tolerant ranking to Entry Tags and Authors', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const section = createSection(database, { entryType: 'game', name: 'Basic' });
    const first = createEntry(database, { title: 'First', type: 'game' });
    const second = createEntry(database, { title: 'Second', type: 'game' });
    assignEntryTag(database, { entryId: first.id, facetId: section.defaultFacetId, name: 'Cyberpunk' });
    assignEntryTag(database, { entryId: second.id, facetId: section.defaultFacetId, name: 'Cyberpunk' });
    const producer = createProducer(database, { name: 'Hypergryph' });
    linkEntryProducer(database, first.id, producer.id);

    expect(searchEntryTags(database, 'cyberpnk')).toEqual([
      expect.objectContaining({ name: 'Cyberpunk', entryCount: 2 }),
    ]);
    expect(searchProducersByName(database, 'hypergrph').map((producer) => producer.name))
      .toEqual(['Hypergryph']);
  });

  it('hides tags used only by NSFW Galleries when search is in SFW mode', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const safeSection = createSection(database, { entryType: 'comic', name: 'Basic' });
    const nsfwSection = createSection(database, { entryType: 'hentai', name: 'Basic' });
    const safeEntry = createEntry(database, { title: 'Safe work', type: 'comic' });
    const nsfwEntry = createEntry(database, { title: 'Private work', type: 'hentai' });
    setGalleryPartition(database, 'hentai', true);
    assignEntryTag(database, { entryId: safeEntry.id, facetId: safeSection.defaultFacetId, name: 'Shared tag' });
    assignEntryTag(database, { entryId: nsfwEntry.id, facetId: nsfwSection.defaultFacetId, name: 'Shared tag' });
    assignEntryTag(database, { entryId: nsfwEntry.id, facetId: nsfwSection.defaultFacetId, name: 'Private tag' });

    expect(searchEntryTags(database, 'Private tag', false)).toEqual([]);
    expect(searchEntryTags(database, 'Private tag', true)).toEqual([
      expect.objectContaining({ name: 'Private tag', entryCount: 1 }),
    ]);
    expect(searchEntryTags(database, 'Shared tag', false)).toEqual([
      expect.objectContaining({ name: 'Shared tag', entryCount: 1 }),
    ]);

    const app = createApiApp(database);
    const [safeResponse, allResponse] = await Promise.all([
      app.request('/api/search/tags?q=Private%20tag&includeNsfw=false'),
      app.request('/api/search/tags?q=Private%20tag&includeNsfw=true'),
    ]);
    await expect(safeResponse.json()).resolves.toEqual([]);
    await expect(allResponse.json()).resolves.toEqual([
      expect.objectContaining({ name: 'Private tag', entryCount: 1 }),
    ]);
  });

  it('exposes all three scopes through validated HTTP endpoints', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const section = createSection(database, { entryType: 'game', name: 'Basic' });
    const entry = createEntry(database, { title: 'Arknights: Endfield', type: 'game' });
    assignEntryTag(database, { entryId: entry.id, facetId: section.defaultFacetId, name: 'Cyberpunk' });
    const producer = createProducer(database, { name: 'Hypergryph' });
    linkEntryProducer(database, entry.id, producer.id);
    const app = createApiApp(database);

    const postJson = (path: string, body: unknown) => app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const [entries, tags, producers, invalid] = await Promise.all([
      postJson('/api/entries/query', { conditions: [], searchQuery: 'endfeld' }),
      app.request('/api/search/tags?q=cyberpnk'),
      postJson('/api/producers/query', {
        ownTagIds: [],
        relatedEntryTagIds: [],
        includeNsfw: true,
        sort: 'relevance',
        searchQuery: 'hypergrph',
      }),
      postJson('/api/entries/query', { conditions: [], searchQuery: '' }),
    ]);

    expect(entries.status).toBe(200);
    expect(tags.status).toBe(200);
    expect(producers.status).toBe(200);
    expect(invalid.status).toBe(400);
    await expect(entries.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ title: 'Arknights: Endfield' })],
      total: 1,
    });
    await expect(tags.json()).resolves.toEqual([expect.objectContaining({ name: 'Cyberpunk', entryCount: 1 })]);
    await expect(producers.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'Hypergryph' })],
      total: 1,
    });
  });

  it('finds an author through a recorded alias spelling', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const author = createProducer(database, { name: '石恵' });
    const work = createEntry(database, { title: 'Some work', type: 'comic' });
    linkEntryProducer(database, work.id, author.id);
    upsertTaxonomyAlias(database, {
      vocabulary: 'producer',
      alias: 'ishikei',
      canonicalName: '石恵',
    });
    // A placeholder row (imported spelling, canonical not filled in yet) belongs
    // to no author and must not make one findable. The manual upsert refuses an
    // empty canonical, so it arrives through the batch import path.
    importTaxonomyAliases(database, [
      { vocabulary: 'producer', partition: 'authors', alias: 'notyet', canonicalName: '' },
    ]);

    const search = (searchQuery: string) => app.request('/api/producers/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ownTagIds: [],
        relatedEntryTagIds: [],
        includeNsfw: true,
        sort: 'relevance',
        searchQuery,
      }),
    });

    // The alias resolves to the author, and the card still shows their own name.
    await expect((await search('ishikei')).json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: author.id, name: '石恵' })],
      total: 1,
    });
    // A typo in the alias spelling is tolerated like any other name.
    await expect((await search('ishikeii')).json()).resolves.toMatchObject({ total: 1 });
    await expect((await search('notyet')).json()).resolves.toMatchObject({ total: 0 });
    await expect((await search('unrelated')).json()).resolves.toMatchObject({ total: 0 });
  });
});
