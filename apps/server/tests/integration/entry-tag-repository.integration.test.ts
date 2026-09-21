import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { deleteEntry } from '../../src/repositories/entry-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';
import { suggestTags } from '../../src/repositories/suggestion-repository.js';
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

  it('moves an assignment without duplicating it and drops the Tag with its last use', () => {
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
      // Nothing carries it any more: the vocabulary row goes with the assignment.
      expect(database.prepare('SELECT COUNT(*) FROM tags').pluck().get()).toBe(0);
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
      })).toEqual([{ id: 1, title: 'One', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null }]);
      expect(findEntriesByTags(database, {
        entryType: 'game',
        includeTagIds: [action.tagId],
        excludeTagIds: [favorite.tagId],
      })).toEqual([{ id: 2, title: 'Two', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null }]);
      expect(findEntriesByTags(database, {
        entryType: 'game',
        includeTagIds: [action.tagId, action.tagId],
      })).toEqual([
        { id: 1, title: 'One', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null },
        { id: 2, title: 'Two', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null },
      ]);
      expect(findEntriesByTags(database, { entryType: 'game' })).toEqual([
        { id: 1, title: 'One', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null },
        { id: 2, title: 'Two', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null },
      ]);
      expect(findEntriesByTags(database, { includeTagIds: [action.tagId] })).toEqual([
        { id: 1, title: 'One', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null },
        { id: 3, title: 'Other Type', type: 'manga', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null },
        { id: 2, title: 'Two', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null },
      ]);
    } finally {
      database.close();
    }
  });

  it('re-adding a tag the Entry already carries lands on the Facet it was typed into', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'game', name: 'Basic' });
      const otherSection = createSection(database, { entryType: 'game', name: 'Extra' });
      database.exec(`INSERT INTO entries (id, title, type) VALUES (1, 'Work', 'game');`);
      const first = assignEntryTag(database, {
        entryId: 1, facetId: section.defaultFacetId, name: 'Action',
      });

      // Same request twice: no conflict, and the same tag row comes back.
      const again = assignEntryTag(database, {
        entryId: 1, facetId: section.defaultFacetId, name: 'Action',
      });
      expect(again.tagId).toBe(first.tagId);
      expect(listEntryTags(database, 1)).toHaveLength(1);

      // Typed into another Facet: the tag moves there rather than failing.
      const moved = assignEntryTag(database, {
        entryId: 1, facetId: otherSection.defaultFacetId, name: 'Action',
      });
      expect(moved.facetId).toBe(otherSection.defaultFacetId);
      expect(listEntryTags(database, 1)).toEqual([
        expect.objectContaining({ tagId: first.tagId, facetId: otherSection.defaultFacetId }),
      ]);
    } finally {
      database.close();
    }
  });

  it('deletes a tag once nothing carries it any more', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'game', name: 'Basic' });
      const otherSection = createSection(database, { entryType: 'game', name: 'Extra' });
      database.exec(`
        INSERT INTO entries (id, title, type) VALUES
          (1, 'First', 'game'),
          (2, 'Second', 'game');
      `);
      const tag = assignEntryTag(database, {
        entryId: 1, facetId: section.defaultFacetId, name: 'Typo',
      });
      assignEntryTag(database, { entryId: 2, facetId: section.defaultFacetId, name: 'Typo' });
      const tagExists = (): boolean => database.prepare(
        'SELECT COUNT(*) FROM tags WHERE id = ?',
      ).pluck().get(tag.tagId) !== 0;

      // Another work still carries it: removing one assignment keeps the row.
      removeEntryTag(database, 1, tag.tagId);
      expect(tagExists()).toBe(true);
      expect(suggestTags(database, {
        vocabulary: 'entry', q: 'Typo', limit: 20, excludeIds: [],
      })).toHaveLength(1);

      // The last one goes: the row goes with it, so it cannot be suggested again.
      removeEntryTag(database, 2, tag.tagId);
      expect(tagExists()).toBe(false);
      expect(suggestTags(database, {
        vocabulary: 'entry', q: 'Typo', limit: 20, excludeIds: [],
      })).toEqual([]);

      // Deleting the work it was the only carrier of does the same.
      const second = assignEntryTag(database, {
        entryId: 1, facetId: otherSection.defaultFacetId, name: 'Typo',
      });
      deleteEntry(database, 1);
      expect(database.prepare('SELECT COUNT(*) FROM tags WHERE id = ?').pluck().get(second.tagId))
        .toBe(0);
      expect(listEntryTags(database, 2)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
