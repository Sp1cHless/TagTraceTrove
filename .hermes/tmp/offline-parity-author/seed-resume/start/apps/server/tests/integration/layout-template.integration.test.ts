import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import {
  applyLayoutTemplate,
  createFacet,
  createSection,
  listLayout,
} from '../../src/repositories/layout-repository.js';

function createComicLayout(database: ReturnType<typeof createMigratedMemoryDatabase>) {
  const basic = createSection(database, { entryType: 'comic', name: 'Basic Information' });
  const series = createFacet(database, { sectionId: basic.id, name: 'Series' });
  const characters = createFacet(database, { sectionId: basic.id, name: 'Characters' });
  const language = createFacet(database, { sectionId: basic.id, name: 'Language' });
  const tags = createSection(database, { entryType: 'comic', name: 'Tags' });
  return { basic, series, characters, language, tags };
}

function createComicEntry(
  database: ReturnType<typeof createMigratedMemoryDatabase>,
  title: string,
): number {
  return createEntry(database, { title, type: 'comic' }).id;
}

describe('applyLayoutTemplate', () => {
  it('rebuilds the type layout and relinks every tag by matching facet name', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const { series, language, tags } = createComicLayout(database);
      const entryOne = createComicEntry(database, 'Work one');
      assignEntryTag(database, { entryId: entryOne, facetId: series.id, name: 'Azur Lane' });
      assignEntryTag(database, { entryId: entryOne, facetId: language.id, name: '中文' });
      assignEntryTag(database, { entryId: entryOne, facetId: tags.defaultFacetId, name: 'Favorite' });
      const entryTwo = createComicEntry(database, 'Work two');
      assignEntryTag(database, { entryId: entryTwo, facetId: series.id, name: 'GFL' });
      assignEntryTag(database, { entryId: entryTwo, facetId: tags.defaultFacetId, name: 'Plan to read' });

      const oldLayout = listLayout(database, 'comic');
      const oldFacetIds = new Set(oldLayout.flatMap((section) => section.facets.map((f) => f.id)));

      const result = applyLayoutTemplate(database, entryOne);
      expect(result).toMatchObject({
        entryType: 'comic',
        entriesAffected: 2,
        tagsRelinked: 5,
        orphansMoved: 0,
        sectionsRecreated: 2,
      });

      const rebuilt = listLayout(database, 'comic');
      expect(rebuilt.map((section) => section.name)).toEqual(['Basic Information', 'Tags']);
      const rebuiltFacetIds = new Set(rebuilt.flatMap((section) => section.facets.map((f) => f.id)));
      expect(rebuiltFacetIds.size).toBeGreaterThan(0);
      for (const oldId of oldFacetIds) {
        expect(rebuiltFacetIds.has(oldId)).toBe(false);
      }

      // Every assignment now points at a rebuilt facet of the same name.
      const assignments = database.prepare(`
        SELECT entry_tags.entry_id, entry_tags.tag_id, facet.name AS facet_name
        FROM entry_tags
        JOIN tag_groups AS facet ON facet.id = entry_tags.facet_id
        JOIN entries ON entries.id = entry_tags.entry_id
        WHERE entries.type = 'comic'
        ORDER BY entry_tags.entry_id, facet_name
      `).all() as Array<{ entry_id: number; facet_name: string }>;
      const byEntry = new Map<number, string[]>();
      for (const row of assignments) {
        const names = byEntry.get(row.entry_id) ?? [];
        names.push(row.facet_name);
        byEntry.set(row.entry_id, names);
      }
      expect(byEntry.get(entryOne)?.sort()).toEqual(['', 'Language', 'Series']);
      expect(byEntry.get(entryTwo)?.sort()).toEqual(['', 'Series']);

      expect(database.pragma('foreign_key_check')).toEqual([]);
      expect(inspectDatabase(database).ok).toBe(true);

      // Applying again is idempotent: no orphan moves, tags stay matched.
      const second = applyLayoutTemplate(database, entryOne);
      expect(second.orphansMoved).toBe(0);
      expect(second.tagsRelinked).toBe(5);
    } finally {
      database.close();
    }
  });

  it('collapses duplicate facet spellings inside one section and merges their tags', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const basic = createSection(database, { entryType: 'comic', name: 'Basic Information' });
      const upper = createFacet(database, { sectionId: basic.id, name: 'Characters' });
      const lower = createFacet(database, { sectionId: basic.id, name: 'characters' });
      createSection(database, { entryType: 'comic', name: 'Tags' });

      const entryOne = createComicEntry(database, 'Work one');
      const entryTwo = createComicEntry(database, 'Work two');
      assignEntryTag(database, { entryId: entryOne, facetId: upper.id, name: 'Honolulu' });
      assignEntryTag(database, { entryId: entryTwo, facetId: lower.id, name: '陈' });

      const result = applyLayoutTemplate(database, entryOne);
      expect(result.orphansMoved).toBe(0);
      expect(result.tagsRelinked).toBe(2);

      const rebuilt = listLayout(database, 'comic');
      const basicSection = rebuilt.find((section) => section.name === 'Basic Information')!;
      expect(basicSection.facets.filter((facet) => facet.name !== '').map((f) => f.name))
        .toEqual(['Characters']);

      const charactersFacetId = basicSection.facets.find((facet) => facet.name === 'Characters')!.id;
      const hanging = database.prepare(`
        SELECT COUNT(*) AS n FROM entry_tags WHERE facet_id = ?
      `).get(charactersFacetId) as { n: number };
      expect(hanging.n).toBe(2);
    } finally {
      database.close();
    }
  });

  it('keeps template facets without tags empty and rejects missing entries or layouts', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const { basic } = createComicLayout(database);
      createFacet(database, { sectionId: basic.id, name: 'Publisher' });
      const entryOne = createComicEntry(database, 'Work one');

      const result = applyLayoutTemplate(database, entryOne);
      expect(result.orphansMoved).toBe(0);

      const rebuilt = listLayout(database, 'comic');
      const publisher = rebuilt
        .find((section) => section.name === 'Basic Information')!
        .facets.find((facet) => facet.name === 'Publisher');
      expect(publisher).toBeDefined();
      const publisherTags = database.prepare(
        'SELECT COUNT(*) AS n FROM entry_tags WHERE facet_id = ?',
      ).get(publisher!.id) as { n: number };
      expect(publisherTags.n).toBe(0);

      expect(() => applyLayoutTemplate(database, 9999)).toThrow('entry not found');

      const orphanTypeEntry = createEntry(database, { title: 'No layout work', type: 'novel' });
      expect(() => applyLayoutTemplate(database, orphanTypeEntry.id))
        .toThrow('no layout exists');
    } finally {
      database.close();
    }
  });
});
