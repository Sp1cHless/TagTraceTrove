import { afterEach, describe, expect, it } from 'vitest';
import { entryPageQueryRequestSchema, entryPageResponseSchema, entrySummarySchema, taxonomyAliasSchema } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntryContent } from '../../src/repositories/entry-content-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { upsertTaxonomyAlias } from '../../src/repositories/taxonomy-repository.js';

const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

// The two response additions are absent from the strict schemas frozen into the 1.0.14 APK.
const installedEntrySchema = entrySummarySchema.omit({ coverText: true });
const installedAliasSchema = taxonomyAliasSchema.omit({ tagId: true });

describe('released app and current desktop sharing one API', () => {
  it('keeps old entry lists parseable while the current client receives cover text, including search', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const work = createEntry(database, { title: 'A paper', type: 'paper' });
    createEntryContent(database, { entryId: work.id, contentType: 'Abstract', content: 'The complete abstract.' });
    const app = createApiApp(database);
    for (const search of [{}, { searchQuery: 'paper' }]) {
      const query = entryPageQueryRequestSchema.parse({ entryType: 'paper', conditions: [], ...search });
      const legacy = await app.request('/api/entries/query', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query),
      });
      expect(legacy.status).toBe(200);
      const page = await legacy.json();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).not.toHaveProperty('coverText');
      expect(installedEntrySchema.array().safeParse(page.items).success).toBe(true);
      const current = await app.request('/api/entries/query?coverText=1', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query),
      });
      expect(current.status).toBe(200);
      expect(entryPageResponseSchema.parse(await current.json()).items[0]?.coverText).toBe('The complete abstract.');
    }
  });

  it('keeps old alias lists unchanged while the current client sees unmapped library tags', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const section = createSection(database, { entryType: 'paper', name: 'Tags' });
    const work = createEntry(database, { title: 'A paper', type: 'paper' });
    assignEntryTag(database, { entryId: work.id, facetId: section.defaultFacetId, name: 'Unmapped keyword' });
    upsertTaxonomyAlias(database, { vocabulary: 'entry', alias: 'youth', canonicalName: '青春' });
    const app = createApiApp(database);
    const legacy = await app.request('/api/taxonomy-aliases?vocabulary=entry');
    expect(legacy.status).toBe(200);
    const aliases = await legacy.json();
    expect(aliases).toHaveLength(1);
    expect(installedAliasSchema.array().safeParse(aliases).success).toBe(true);
    const current = await app.request('/api/taxonomy-aliases?vocabulary=entry&includeTags=1');
    expect(current.status).toBe(200);
    const catalog = taxonomyAliasSchema.array().parse(await current.json());
    expect(catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ alias: 'Unmapped keyword', canonicalName: '', tagId: expect.any(Number) }),
      expect.objectContaining({ alias: 'youth', canonicalName: '青春' }),
    ]));
  });
});
