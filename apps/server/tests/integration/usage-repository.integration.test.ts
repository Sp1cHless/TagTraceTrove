import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry, getEntryDetail } from '../../src/repositories/entry-repository.js';
import {
  createProducer,
  getAuthorDetail,
  linkEntryProducer,
} from '../../src/repositories/producer-repository.js';
import { findEntriesByFacetFilters } from '../../src/repositories/entry-tag-repository.js';
import {
  getEntryUsage,
  getProducerUsage,
  likeEntry,
  recordEntryView,
} from '../../src/repositories/usage-repository.js';

type TestDatabase = ReturnType<typeof createMigratedMemoryDatabase>;

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function createDatabase(): TestDatabase {
  const database = createMigratedMemoryDatabase();
  databases.push(database);
  return database;
}

describe('entry usage tracking (real SQL)', () => {
  it('records views lazily and composes them into the Entry detail', () => {
    const database = createDatabase();
    const entry = createEntry(database, { title: 'Viewed Work', type: 'comic' });

    expect(getEntryUsage(database, entry.id)).toEqual({
      viewCount: 0, lastViewedAt: null, likeCount: 0,
    });

    const first = recordEntryView(database, entry.id);
    const second = recordEntryView(database, entry.id);
    expect(first.viewCount).toBe(1);
    expect(second.viewCount).toBe(2);
    expect(second.lastViewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    expect(second.lastViewedAt !== null && first.lastViewedAt !== null && second.lastViewedAt >= first.lastViewedAt)
      .toBe(true);

    const detail = getEntryDetail(database, entry.id);
    expect(detail?.usage).toEqual({ viewCount: 2, likeCount: 0, lastViewedAt: second.lastViewedAt });
    expect(() => recordEntryView(database, 999)).toThrow('entry not found');
  });

  it('derives author usage from their works without storing it', () => {
    const database = createDatabase();
    const author = createProducer(database, { name: 'Viewed Author' });
    const workOne = createEntry(database, { title: 'Work One', type: 'comic' });
    const workTwo = createEntry(database, { title: 'Work Two', type: 'comic' });
    linkEntryProducer(database, workOne.id, author.id);
    linkEntryProducer(database, workTwo.id, author.id);

    expect(getProducerUsage(database, author.id)).toEqual({
      viewCount: 0, lastViewedAt: null, likeCount: 0,
    });

    recordEntryView(database, workOne.id);
    recordEntryView(database, workOne.id);
    recordEntryView(database, workTwo.id);
    const usage = getProducerUsage(database, author.id);
    expect(usage.viewCount).toBe(3);

    const detail = getAuthorDetail(database, author.id);
    expect(detail?.usage.viewCount).toBe(3);
    expect(detail?.usage.lastViewedAt).toBe(usage.lastViewedAt);

    // Deleting a work removes its usage row (CASCADE) and the derived total follows.
    database.prepare('DELETE FROM entries WHERE id = ?').run(workTwo.id);
    expect(getProducerUsage(database, author.id).viewCount).toBe(2);
  });

  it('filters and sorts entries by usage in the gallery filter', () => {
    const database = createDatabase();
    const viewedTwice = createEntry(database, { title: 'Twice', type: 'comic' }).id;
    const viewedOnce = createEntry(database, { title: 'Once', type: 'comic' }).id;
    const neverViewed = createEntry(database, { title: 'Never', type: 'comic' }).id;
    recordEntryView(database, viewedTwice);
    recordEntryView(database, viewedTwice);
    recordEntryView(database, viewedOnce);

    const ids = (usageConditions: never[] = [], usageSort: unknown = null): number[] => (
      findEntriesByFacetFilters(database, {
        entryType: 'comic',
        conditions: [],
        authorIds: [],
        usageConditions,
        usageSort: usageSort as never,
      }).map((entry) => entry.id)
    );

    expect(ids([{ field: 'views', operator: 'gt', value: 1 } as never])).toEqual([viewedTwice]);
    expect(ids([{ field: 'views', operator: 'eq', value: 1 } as never])).toEqual([viewedOnce]);
    expect(ids([{ field: 'views', operator: 'lt', value: 1 } as never])).toEqual([neverViewed]);

    // Missing rows read as date-less: only viewed entries pass a date filter.
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(ids([{ field: 'lastViewed', operator: 'gt', value: '2000-01-01' } as never]))
      .toEqual(expect.arrayContaining([viewedTwice, viewedOnce]));
    expect(ids([{ field: 'lastViewed', operator: 'gt', value: tomorrow } as never])).toEqual([]);
    expect(typeof today).toBe('string');

    // Sorts: most viewed first, never-viewed sinking in both directions.
    // Ascending reads as fewest views first — never-viewed (0) leads.
    expect(ids([], { field: 'views', direction: 'desc' }))
      .toEqual([viewedTwice, viewedOnce, neverViewed]);
    expect(ids([], { field: 'views', direction: 'asc' }))
      .toEqual([neverViewed, viewedOnce, viewedTwice]);
    expect(ids([], { field: 'lastViewed', direction: 'desc' })[0]).toBe(viewedTwice);
    // Never-viewed entries sink under date sorts in both directions; the view
    // count breaks same-second ties.
    expect(ids([], { field: 'lastViewed', direction: 'asc' })[0]).toBe(viewedOnce);
  });

  it('counts unlimited re-clickable likes and derives author totals', async () => {
    const database = createDatabase();
    const entry = createEntry(database, { title: 'Liked Work', type: 'comic' });
    const author = createProducer(database, { name: 'Liked Author' });
    linkEntryProducer(database, entry.id, author.id);

    expect(getEntryUsage(database, entry.id)).toEqual({
      viewCount: 0, lastViewedAt: null, likeCount: 0,
    });

    // Likes have no limit: each click adds one, independent of views.
    const first = likeEntry(database, entry.id);
    const second = likeEntry(database, entry.id);
    const third = likeEntry(database, entry.id);
    expect([first.likeCount, second.likeCount, third.likeCount]).toEqual([1, 2, 3]);
    expect(third.viewCount).toBe(0);
    expect(third.lastViewedAt).toBeNull();

    recordEntryView(database, entry.id);
    const mixed = getEntryUsage(database, entry.id);
    expect(mixed).toEqual({ viewCount: 1, likeCount: 3, lastViewedAt: mixed.lastViewedAt });
    expect(getProducerUsage(database, author.id).likeCount).toBe(3);

    expect(() => likeEntry(database, 999)).toThrow('entry not found');
  });

  it('filters and sorts by likes and records them through HTTP', async () => {
    const database = createDatabase();
    const liked = createEntry(database, { title: 'Liked', type: 'comic' }).id;
    const notLiked = createEntry(database, { title: 'Not Liked', type: 'comic' }).id;
    likeEntry(database, liked);
    likeEntry(database, liked);

    const ids = (usageConditions: never[] = [], usageSort: unknown = null): number[] => (
      findEntriesByFacetFilters(database, {
        entryType: 'comic',
        conditions: [],
        authorIds: [],
        usageConditions,
        usageSort: usageSort as never,
      }).map((entry) => entry.id)
    );
    expect(ids([{ field: 'likes', operator: 'gt', value: 1 } as never])).toEqual([liked]);
    expect(ids([], { field: 'likes', direction: 'desc' })).toEqual([liked, notLiked]);
    expect(ids([], { field: 'likes', direction: 'asc' })).toEqual([notLiked, liked]);

    const app = createApiApp(database);
    const response = await app.request(`/api/entries/${notLiked}/likes`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ viewCount: 0, likeCount: 1, lastViewedAt: null });
  });

  it('records views through the HTTP route', async () => {
    const database = createDatabase();
    const entry = createEntry(database, { title: 'Routed Work', type: 'comic' });
    const app = createApiApp(database);

    const response = await app.request(`/api/entries/${entry.id}/views`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = await response.json() as { viewCount: number; lastViewedAt: string | null };
    expect(body.viewCount).toBe(1);
    expect(body.lastViewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    const missing = await app.request('/api/entries/999/views', { method: 'POST' });
    expect(missing.status).toBe(404);
  });
});
