import { afterEach, describe, expect, it } from 'vitest';
import { COVER_TEXT_BUDGET } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntryContent } from '../../src/repositories/entry-content-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';

const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function coverTextOf(
  app: ReturnType<typeof createApiApp>,
  entryType: string,
): Promise<Record<string, string | null>> {
  const response = await app.request('/api/entries/query?coverText=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entryType,
      conditions: [],
      authorIds: [],
      ratingConditions: [],
      ratingSort: null,
      usageConditions: [],
      usageSort: null,
      sort: 'title-asc',
      page: 1,
      pageSize: 50,
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { items: Array<{ title: string; coverText?: string | null }> };
  return Object.fromEntries(body.items.map((item) => [item.title, item.coverText ?? null]));
}

/**
 * The default cover is read through the route the Gallery grid uses, not from the repository alone:
 * the list a card is built from is the parsed response, so a field the schema would reject is only
 * proven absent here.
 */
describe('entry cover text', () => {
  it('quotes the work’s own Content, and only falls back to its Tags', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const section = createSection(database, { entryType: 'comic', name: '基本信息' });
    const facet = createFacet(database, { sectionId: section.id, name: '作品' });

    // Its only Content is the address an import wrote.
    const addressOnly = createEntry(database, { title: 'Address only', type: 'comic' }).id;
    createEntryContent(database, { entryId: addressOnly, contentType: 'Source URL', content: 'https://example.com/works/1' });
    assignEntryTag(database, { entryId: addressOnly, facetId: facet.id, name: 'Lighthouse' });
    assignEntryTag(database, { entryId: addressOnly, facetId: facet.id, name: 'Drama' });

    // A description, written under whatever kind the person chose, and added after the address.
    const described = createEntry(database, { title: 'Described', type: 'comic' }).id;
    createEntryContent(database, { entryId: described, contentType: 'Source URL', content: 'https://example.com/works/2' });
    createEntryContent(database, { entryId: described, contentType: '简介', content: '一个关于灯塔看守人的安静故事。' });
    createEntryContent(database, { entryId: described, contentType: '评价', content: 'never wins — a later row' });
    assignEntryTag(database, { entryId: described, facetId: facet.id, name: 'Quiet' });

    // A kind that is not the built-in one but holds nothing but an address.
    const strayAddress = createEntry(database, { title: 'Stray address', type: 'comic' }).id;
    createEntryContent(database, { entryId: strayAddress, contentType: '作品地址', content: 'https://example.com/works/3' });
    assignEntryTag(database, { entryId: strayAddress, facetId: facet.id, name: '已完结' });

    // Nothing readable at all: the card keeps the title's first letter.
    createEntry(database, { title: 'Bare', type: 'comic' });
    // A work with a cover never needed the text, and does not get one.
    createEntry(database, { title: 'Covered', type: 'comic', coverRef: '/api/assets/entries/9/cover.webp' });

    await expect(coverTextOf(app, 'comic')).resolves.toEqual({
      // Inside one Facet the work's page lists its tags by name, so the card quotes that order.
      'Address only': 'Drama · Lighthouse',
      'Described': '一个关于灯塔看守人的安静故事。',
      'Stray address': '已完结',
      'Bare': null,
      'Covered': null,
    });
  });

  it('cuts what it quotes to what a cover holds', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const entryId = createEntry(database, { title: 'Long', type: 'comic' }).id;
    createEntryContent(database, { entryId, contentType: 'description', content: '字'.repeat(200) });

    const { Long: text } = await coverTextOf(app, 'comic');
    expect(text).toHaveLength(COVER_TEXT_BUDGET.cjk + 1);
    expect(text?.endsWith('…')).toBe(true);
  });

  it('quotes the text on a searched page too, which reads the same projection', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const entryId = createEntry(database, { title: 'Findable', type: 'comic' }).id;
    createEntryContent(database, { entryId, contentType: 'description', content: 'Only the description' });

    const response = await app.request('/api/entries/query?coverText=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchQuery: 'Findable', conditions: [], authorIds: [], ratingConditions: [], ratingSort: null, usageConditions: [], usageSort: null, page: 1, pageSize: 10 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ title: string; coverText?: string | null }> };
    expect(body.items).toEqual([expect.objectContaining({ title: 'Findable', coverText: 'Only the description' })]);
  });
});
