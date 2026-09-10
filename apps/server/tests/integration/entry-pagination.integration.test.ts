import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { createRatingSlot, setEntryRating } from '../../src/repositories/rating-repository.js';
import { likeEntry } from '../../src/repositories/usage-repository.js';

const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('paged Entry query', () => {
  it('returns one SQL-sorted Gallery page and the total match count', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    createEntry(database, { title: 'Other type', type: 'manga', uploadDate: '2026-01-01' });
    for (const [title, uploadDate] of [
      ['Oldest', '2024-01-01'],
      ['Older', '2024-02-01'],
      ['Middle', '2024-03-01'],
      ['Newer', '2024-04-01'],
      ['Newest', '2024-05-01'],
    ] as const) {
      createEntry(database, { title, type: 'comic', uploadDate });
    }

    const response = await app.request('/api/entries/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryType: 'comic',
        conditions: [],
        authorIds: [],
        ratingConditions: [],
        ratingSort: null,
        usageConditions: [],
        usageSort: null,
        sort: 'date-desc',
        page: 2,
        pageSize: 2,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 5,
      page: 2,
      pageSize: 2,
      items: [
        { title: 'Middle', type: 'comic' },
        { title: 'Older', type: 'comic' },
      ],
    });
  });

  it('keeps deterministic sort boundaries, ties, null dates, and out-of-range pages stable', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    createEntry(database, { title: 'Beta', type: 'comic', uploadDate: null });
    createEntry(database, { title: 'Alpha', type: 'comic', uploadDate: '2024-01-01' });
    createEntry(database, { title: 'alpha', type: 'comic', uploadDate: '2024-01-01' });
    createEntry(database, { title: 'Zulu', type: 'comic', uploadDate: '2025-01-01' });

    const query = async (sort: string, page = 1, pageSize = 10) => {
      const response = await app.request('/api/entries/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryType: 'comic', sort, page, pageSize }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ items: Array<{ title: string }>; total: number }>;
    };

    await expect(query('date-desc')).resolves.toMatchObject({
      total: 4, items: [{ title: 'Zulu' }, { title: 'alpha' }, { title: 'Alpha' }, { title: 'Beta' }],
    });
    await expect(query('date-asc')).resolves.toMatchObject({
      total: 4, items: [{ title: 'Beta' }, { title: 'Alpha' }, { title: 'alpha' }, { title: 'Zulu' }],
    });
    await expect(query('title-asc')).resolves.toMatchObject({
      total: 4, items: [{ title: 'Alpha' }, { title: 'alpha' }, { title: 'Beta' }, { title: 'Zulu' }],
    });
    await expect(query('title-desc')).resolves.toMatchObject({
      total: 4, items: [{ title: 'Zulu' }, { title: 'Beta' }, { title: 'Alpha' }, { title: 'alpha' }],
    });
    await expect(query('date-desc', 2, 2)).resolves.toMatchObject({
      total: 4, items: [{ title: 'Alpha' }, { title: 'Beta' }],
    });
    await expect(query('date-desc', 99, 2)).resolves.toMatchObject({ total: 4, items: [] });
  });

  it('combines facet, author, rating, and likes filters before paging', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const section = createSection(database, { entryType: 'comic', name: 'Basic' });
    const facet = createFacet(database, { sectionId: section.id, name: 'Series' });
    const first = createEntry(database, { title: 'First', type: 'comic' });
    const second = createEntry(database, { title: 'Second', type: 'comic' });
    const excluded = createEntry(database, { title: 'Excluded', type: 'comic' });
    const firstTag = assignEntryTag(database, { entryId: first.id, facetId: facet.id, name: 'Shared' });
    assignEntryTag(database, { entryId: second.id, facetId: facet.id, name: 'Shared' });
    assignEntryTag(database, { entryId: excluded.id, facetId: facet.id, name: 'Other' });
    const author = createProducer(database, { name: 'Author' });
    linkEntryProducer(database, first.id, author.id);
    linkEntryProducer(database, second.id, author.id);
    const slot = createRatingSlot(database, { kind: 'entry', entryType: 'comic', name: 'Quality' });
    setEntryRating(database, { entryId: first.id, slotId: slot.id, stars: 4.5 });
    setEntryRating(database, { entryId: second.id, slotId: slot.id, stars: 5 });
    for (let index = 0; index < 5; index += 1) likeEntry(database, first.id);
    for (let index = 0; index < 3; index += 1) likeEntry(database, second.id);

    const response = await app.request('/api/entries/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryType: 'comic',
        conditions: [{ facetId: facet.id, tagIds: [firstTag.tagId] }],
        authorIds: [author.id],
        ratingConditions: [{ slotId: slot.id, operator: 'gt', stars: 4 }],
        ratingSort: { slotId: slot.id, direction: 'desc' },
        usageConditions: [{ field: 'likes', operator: 'gt', value: 2 }],
        usageSort: { field: 'likes', direction: 'desc' },
        sort: 'title-asc',
        page: 1,
        pageSize: 1,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 2,
      page: 1,
      pageSize: 1,
      items: [{ id: first.id, title: 'First', likeCount: 5 }],
    });
  });
});
