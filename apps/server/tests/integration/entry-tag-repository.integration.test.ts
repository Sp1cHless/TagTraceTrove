import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';
import {
  assignEntryTag,
  findEntriesByTags,
  listEntryTags,
  moveEntryTag,
  renameEntryTag,
  removeEntryTag,
} from '../../src/repositories/entry-tag-repository.js';

describe('entry tag repository', () => {
  it('normalizes and reuses entry tags while keeping assignments facet-scoped', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const section = createSection(database, { entryType: 'game', name: 'Basic' });
      database.exec(`
        INSERT INTO entries (id, title, type) VALUES
          (1, 'First', 'game'),
          (2, 'Second', 'game');
      `);

      const first = assignEntryTag(database, {
        entryId: 1,
        facetId: section.defaultFacetId,
        name: '  School   Life  ',
      });
      const second = assignEntryTag(database, {
        entryId: 2,
        facetId: section.defaultFacetId,
        name: 'school life',
      });

      expect(second.tagId).toBe(first.tagId);
      expect(first.normalizedName).toBe('school life');
      expect(database.prepare('SELECT COUNT(*) FROM tags').pluck().get()).toBe(1);
      expect(listEntryTags(database, 1)).toEqual([
        {
          tagId: first.tagId,
          name: 'School Life',
          normalizedName: 'school life',
          facetId: section.defaultFacetId,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('moves and removes an assignment without duplicating or deleting the tag', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const section = createSection(database, { entryType: 'game', name: 'Basic' });
      const targetFacet = createFacet(database, {
        sectionId: section.id,
        name: 'Character',
      });
      database.exec("INSERT INTO entries (id, title, type) VALUES (1, 'First', 'game')");
      const assigned = assignEntryTag(database, {
        entryId: 1,
        facetId: section.defaultFacetId,
        name: 'Favorite',
      });

      moveEntryTag(database, {
        entryId: 1,
        tagId: assigned.tagId,
        targetFacetId: targetFacet.id,
      });
      expect(listEntryTags(database, 1)[0]?.facetId).toBe(targetFacet.id);
      expect(database.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(1);

      removeEntryTag(database, 1, assigned.tagId);
      expect(listEntryTags(database, 1)).toEqual([]);
      expect(database.prepare('SELECT COUNT(*) FROM tags').pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it('renames one Entry Tag assignment by retargeting it without changing shared uses', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const section = createSection(database, { entryType: 'game', name: 'Basic' });
      database.exec(`
        INSERT INTO entries (id, title, type) VALUES
          (1, 'First', 'game'),
          (2, 'Second', 'game');
      `);
      const shared = assignEntryTag(database, {
        entryId: 1,
        facetId: section.defaultFacetId,
        name: 'Action',
      });
      assignEntryTag(database, {
        entryId: 2,
        facetId: section.defaultFacetId,
        name: 'Action',
      });

      const renamed = renameEntryTag(database, {
        entryId: 1,
        tagId: shared.tagId,
        name: 'Action RPG',
      });

      expect(renamed.name).toBe('Action RPG');
      expect(renamed.facetId).toBe(section.defaultFacetId);
      expect(listEntryTags(database, 1)[0]?.name).toBe('Action RPG');
      expect(listEntryTags(database, 2)[0]?.name).toBe('Action');
      expect(database.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(2);
      expect(database.prepare('SELECT COUNT(*) FROM tags').pluck().get()).toBe(2);
    } finally {
      database.close();
    }
  });

  it('keeps the old facet when a move targets an incompatible facet', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const gameSection = createSection(database, { entryType: 'game', name: 'Basic' });
      const mangaSection = createSection(database, { entryType: 'manga', name: 'Basic' });
      database.exec("INSERT INTO entries (id, title, type) VALUES (1, 'First', 'game')");
      const assigned = assignEntryTag(database, {
        entryId: 1,
        facetId: gameSection.defaultFacetId,
        name: 'Favorite',
      });

      expect(() => moveEntryTag(database, {
        entryId: 1,
        tagId: assigned.tagId,
        targetFacetId: mangaSection.defaultFacetId,
      })).toThrow('entry tag must target a facet of the entry type');
      expect(listEntryTags(database, 1)[0]?.facetId).toBe(gameSection.defaultFacetId);
    } finally {
      database.close();
    }
  });

  it('rolls back a newly created tag when its facet is incompatible', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const mangaSection = createSection(database, { entryType: 'manga', name: 'Basic' });
      database.exec("INSERT INTO entries (id, title, type) VALUES (1, 'First', 'game')");

      expect(() => assignEntryTag(database, {
        entryId: 1,
        facetId: mangaSection.defaultFacetId,
        name: 'Should Roll Back',
      })).toThrow('entry tag must target a facet of the entry type');
      expect(database.prepare('SELECT COUNT(*) FROM tags').pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it('filters an entry type with include-AND and exclude semantics', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const section = createSection(database, { entryType: 'game', name: 'Basic' });
      const mangaSection = createSection(database, { entryType: 'manga', name: 'Basic' });
      database.exec(`
        INSERT INTO entries (id, title, type) VALUES
          (1, 'One', 'game'),
          (2, 'Two', 'game'),
          (3, 'Other Type', 'manga');
      `);
      const action = assignEntryTag(database, {
        entryId: 1,
        facetId: section.defaultFacetId,
        name: 'Action',
      });
      const favorite = assignEntryTag(database, {
        entryId: 1,
        facetId: section.defaultFacetId,
        name: 'Favorite',
      });
      assignEntryTag(database, {
        entryId: 2,
        facetId: section.defaultFacetId,
        name: 'Action',
      });
      assignEntryTag(database, {
        entryId: 3,
        facetId: mangaSection.defaultFacetId,
        name: 'Action',
      });

      expect(findEntriesByTags(database, {
        entryType: 'game',
        includeTagIds: [action.tagId, favorite.tagId],
      })).toEqual([{ id: 1, title: 'One', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null }]);
      expect(findEntriesByTags(database, {
        entryType: 'game',
        includeTagIds: [action.tagId],
        excludeTagIds: [favorite.tagId],
      })).toEqual([{ id: 2, title: 'Two', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null }]);
      expect(findEntriesByTags(database, {
        entryType: 'game',
        includeTagIds: [action.tagId, action.tagId],
      })).toEqual([
        { id: 1, title: 'One', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null },
        { id: 2, title: 'Two', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null },
      ]);
      expect(findEntriesByTags(database, { entryType: 'game' })).toEqual([
        { id: 1, title: 'One', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null },
        { id: 2, title: 'Two', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null },
      ]);
      expect(findEntriesByTags(database, { includeTagIds: [action.tagId] })).toEqual([
        { id: 1, title: 'One', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null },
        { id: 3, title: 'Other Type', type: 'manga', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null },
        { id: 2, title: 'Two', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null },
      ]);
    } finally {
      database.close();
    }
  });
});
