import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import {
  assignEntryTag,
  listUnassignedTags,
  moveUnassignedTagToFacet,
} from '../../src/repositories/entry-tag-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';

type TestDatabase = ReturnType<typeof createMigratedMemoryDatabase>;

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

interface Layout {
  defaultFacetId: number;
  seriesId: number;
  charactersId: number;
}

function createLayout(database: TestDatabase, entryType: string): Layout {
  const basic = createSection(database, { entryType, name: 'Basic Information' });
  const series = createFacet(database, { sectionId: basic.id, name: 'Series' });
  const characters = createFacet(database, { sectionId: basic.id, name: 'Characters' });
  return {
    defaultFacetId: basic.defaultFacetId,
    seriesId: series.id,
    charactersId: characters.id,
  };
}

function tagId(database: TestDatabase, name: string): number {
  return database.prepare('SELECT id FROM tags WHERE name = ?').pluck().get(name) as number;
}

function facetOf(database: TestDatabase, entryId: number, tagName: string): string {
  return database.prepare(`
    SELECT tag_groups.name AS facetName
    FROM entry_tags
    JOIN tag_groups ON tag_groups.id = entry_tags.facet_id
    JOIN tags ON tags.id = entry_tags.tag_id
    WHERE entry_tags.entry_id = ? AND tags.name = ?
  `).pluck().get(entryId, tagName) as string;
}

/**
 * Comic: A carries X+Z in the default (unnamed) Facet; B carries X under
 * Series; C carries X in the default too. Hentai: H carries X in ITS default.
 * → comic unassigned: X (2 entries, suggestion Series ×1), Z (1, no
 *   suggestion). hentai unassigned: X (1, no suggestion).
 */
function seed(database: TestDatabase) {
  const comic = createLayout(database, 'comic');
  const hentai = createLayout(database, 'hentai');
  const entryA = createEntry(database, { title: 'Comic A', type: 'comic' }).id;
  const entryB = createEntry(database, { title: 'Comic B', type: 'comic' }).id;
  const entryC = createEntry(database, { title: 'Comic C', type: 'comic' }).id;
  const entryH = createEntry(database, { title: 'Hentai H', type: 'hentai' }).id;

  assignEntryTag(database, { entryId: entryA, facetId: comic.defaultFacetId, name: 'X' });
  assignEntryTag(database, { entryId: entryA, facetId: comic.defaultFacetId, name: 'Z' });
  assignEntryTag(database, { entryId: entryB, facetId: comic.seriesId, name: 'X' });
  assignEntryTag(database, { entryId: entryC, facetId: comic.defaultFacetId, name: 'X' });
  assignEntryTag(database, { entryId: entryH, facetId: hentai.defaultFacetId, name: 'X' });

  return { comic, entryA, entryB, entryC };
}

describe('listUnassignedTags', () => {
  it('groups unassigned tags per type with named-facet targets and majority suggestions', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { comic } = seed(database);

    const groups = listUnassignedTags(database);
    expect(groups.map((group) => group.entryType)).toEqual(['comic', 'hentai']);

    const comicGroup = groups[0]!;
    expect(comicGroup.facets.map((facet) => facet.facetName)).toEqual(['Series', 'Characters']);
    const byName = new Map(comicGroup.tags.map((tag) => [tag.tagName, tag]));

    expect(byName.get('X')).toMatchObject({
      entryCount: 2,
      suggestion: { facetName: 'Series', count: 1, facetId: comic.seriesId },
    });
    expect(byName.get('Z')).toMatchObject({ entryCount: 1, suggestion: null });

    const hentaiGroup = groups[1]!;
    expect(hentaiGroup.tags).toEqual([
      expect.objectContaining({ tagName: 'X', entryCount: 1, suggestion: null }),
    ]);
    expect(hentaiGroup.facets.map((facet) => facet.facetName)).toEqual(['Series', 'Characters']);
  });

  it('returns an empty list when everything is classified', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const comic = createLayout(database, 'comic');
    const entry = createEntry(database, { title: 'Sorted', type: 'comic' }).id;
    assignEntryTag(database, { entryId: entry, facetId: comic.seriesId, name: 'X' });

    expect(listUnassignedTags(database)).toEqual([]);
  });
});

describe('moveUnassignedTagToFacet', () => {
  it('moves only the unassigned assignments of one tag, one type; classified and other types untouched', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { comic, entryA, entryB, entryC } = seed(database);

    const result = moveUnassignedTagToFacet(database, {
      entryType: 'comic',
      tagId: tagId(database, 'X'),
      targetFacetId: comic.seriesId,
    });

    expect(result).toMatchObject({ moved: 2, entryType: 'comic', targetFacetId: comic.seriesId });
    expect(facetOf(database, entryA, 'X')).toBe('Series');
    expect(facetOf(database, entryC, 'X')).toBe('Series');
    expect(facetOf(database, entryB, 'X')).toBe('Series'); // was already there, unchanged
    expect(facetOf(database, entryA, 'Z')).toBe(''); // still unassigned
  });

  it('leaves other entry types completely alone', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { comic } = seed(database);
    const hentaiDefault = database.prepare(
      `SELECT id FROM tag_groups
       WHERE entry_type = 'hentai' AND group_kind = 'facet' AND name = ''`,
    ).pluck().get() as number;

    moveUnassignedTagToFacet(database, {
      entryType: 'comic',
      tagId: tagId(database, 'X'),
      targetFacetId: comic.seriesId,
    });

    const hentaiCount = database.prepare(
      'SELECT COUNT(*) AS n FROM entry_tags WHERE facet_id = ? AND tag_id = ?',
    ).get(hentaiDefault, tagId(database, 'X')) as { n: number };
    expect(hentaiCount.n).toBe(1);
  });

  it('rejects a facet from another type and the unnamed default as a target', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { comic } = seed(database);
    const otherTypeFacet = database.prepare(
      `SELECT id FROM tag_groups
       WHERE entry_type = 'hentai' AND group_kind = 'facet' AND name = 'Series'`,
    ).pluck().get() as number;

    expect(() => moveUnassignedTagToFacet(database, {
      entryType: 'comic',
      tagId: tagId(database, 'X'),
      targetFacetId: otherTypeFacet,
    })).toThrow(/another type/);

    expect(() => moveUnassignedTagToFacet(database, {
      entryType: 'comic',
      tagId: tagId(database, 'X'),
      targetFacetId: comic.defaultFacetId,
    })).toThrow(/unnamed default facet/);
  });
});

describe('unassigned tag HTTP routes', () => {
  it('lists groups and moves a tag through the API', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { comic } = seed(database);
    const app = createApiApp(database);

    const listResponse = await app.request('/api/tags/unassigned');
    expect(listResponse.status).toBe(200);
    const body = await listResponse.json() as Array<{
      entryType: string;
      tags: Array<{ tagName: string; suggestion: { facetName: string } | null }>;
    }>;
    const comicGroup = body.find((group) => group.entryType === 'comic')!;
    expect(comicGroup.tags.map((tag) => tag.tagName)).toEqual(['X', 'Z']);
    expect(comicGroup.tags[0]!.suggestion?.facetName).toBe('Series');

    const moveResponse = await app.request('/api/tags/unassigned/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryType: 'comic',
        tagId: tagId(database, 'X'),
        targetFacetId: comic.seriesId,
      }),
    });
    expect(moveResponse.status).toBe(200);
    expect(await moveResponse.json()).toMatchObject({ moved: 2 });

    const refreshed = await (await app.request('/api/tags/unassigned')).json() as Array<{
      entryType: string;
      tags: Array<{ tagName: string }>;
    }>;
    expect(refreshed.find((group) => group.entryType === 'comic')!.tags.map((tag) => tag.tagName))
      .toEqual(['Z']);
  });

  it('conflicts when moving into another type facet (409)', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const app = createApiApp(database);
    const hentaiSeries = database.prepare(
      `SELECT id FROM tag_groups
       WHERE entry_type = 'hentai' AND group_kind = 'facet' AND name = 'Series'`,
    ).pluck().get() as number;

    const response = await app.request('/api/tags/unassigned/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryType: 'comic', tagId: 1, targetFacetId: hentaiSeries }),
    });
    expect(response.status).toBe(409);
  });
});
