import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';
import {
  createEntry,
  getEntryDetail,
  updateEntry,
} from '../../src/repositories/entry-repository.js';

describe('entry repository', () => {
  it('creates and partially updates an entry', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const created = createEntry(database, {
        title: '  Example Game  ',
        type: ' game ',
        coverRef: 'cover.webp',
      });

      expect(created).toEqual({
        id: expect.any(Number),
        title: 'Example Game',
        type: 'game',
        coverRef: 'cover.webp',
        previewRef: null,
        previewRefs: [],
        uploadDate: null,
        pageCount: null,
      });
      expect(updateEntry(database, created.id, {
        title: 'Updated Game',
        coverRef: null,
        previewRef: 'preview.webp',
        uploadDate: '2026-08-30',
      })).toEqual({
        id: created.id,
        title: 'Updated Game',
        type: 'game',
        coverRef: null,
        previewRef: 'preview.webp',
        previewRefs: ['preview.webp'],
        uploadDate: '2026-08-30',
        pageCount: null,
      });
      expect(getEntryDetail(database, created.id)?.title).toBe('Updated Game');
    } finally {
      database.close();
    }
  });

  it('returns the complete entry page hierarchy with layout-independent content', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const basic = createSection(database, {
        entryType: 'game',
        name: 'Basic information',
        sortOrder: 0,
      });
      const character = createFacet(database, {
        sectionId: basic.id,
        name: 'Character',
        sortOrder: 1,
      });
      const review = createSection(database, {
        entryType: 'game',
        name: 'Review',
        sortOrder: 1,
      });
      database.exec(`
        INSERT INTO entries (id, title, type, cover_ref)
        VALUES (1, 'Example Game', 'game', 'cover.webp');
        INSERT INTO producers (id, name, content)
        VALUES (1, 'Example Creator', 'Important creator note');
        INSERT INTO entry_producers (entry_id, producer_id) VALUES (1, 1);
        INSERT INTO entry_contents (id, entry_id, content_type, content, sort_order) VALUES
          (2, 1, 'source url', 'https://example.test/game', 2),
          (1, 1, 'short review', 'Good', 1);
      `);
      const characterTag = assignEntryTag(database, {
        entryId: 1,
        facetId: character.id,
        name: 'Amiya',
      });
      const reviewTag = assignEntryTag(database, {
        entryId: 1,
        facetId: review.defaultFacetId,
        name: 'Favorite',
      });

      expect(getEntryDetail(database, 1)).toEqual({
        id: 1,
        title: 'Example Game',
        type: 'game',
        coverRef: 'cover.webp',
        previewRef: null,
        previewRefs: [],
        uploadDate: null,
        pageCount: null,
        producers: [
          {
            id: 1,
            name: 'Example Creator',
            occupation: null,
            artworkRef: null,
            content: 'Important creator note',
          },
        ],
        sections: [
          {
            id: basic.id,
            name: 'Basic information',
            sortOrder: 0,
            facets: [
              {
                id: basic.defaultFacetId,
                name: '',
                sortOrder: 0,
                tags: [],
              },
              {
                id: character.id,
                name: 'Character',
                sortOrder: 1,
                tags: [
                  {
                    id: characterTag.tagId,
                    name: 'Amiya',
                    normalizedName: 'amiya',
                  },
                ],
              },
            ],
          },
          {
            id: review.id,
            name: 'Review',
            sortOrder: 1,
            facets: [
              {
                id: review.defaultFacetId,
                name: '',
                sortOrder: 0,
                tags: [
                  {
                    id: reviewTag.tagId,
                    name: 'Favorite',
                    normalizedName: 'favorite',
                  },
                ],
              },
            ],
          },
        ],
        contents: [
          { id: 1, contentType: 'short review', content: 'Good', sortOrder: 1 },
          {
            id: 2,
            contentType: 'source url',
            content: 'https://example.test/game',
            sortOrder: 2,
          },
        ],
      });
    } finally {
      database.close();
    }
  });

  it('returns null for a missing entry', () => {
    const database = createMigratedMemoryDatabase();

    try {
      expect(getEntryDetail(database, 999)).toBeNull();
    } finally {
      database.close();
    }
  });

  it('rejects empty names and updates to missing entries', () => {
    const database = createMigratedMemoryDatabase();

    try {
      expect(() => createEntry(database, { title: '  ', type: 'game' }))
        .toThrow('entry title cannot be empty');
      expect(() => createEntry(database, { title: 'Example', type: '  ' }))
        .toThrow('entry type cannot be empty');
      expect(() => updateEntry(database, 999, { title: 'Missing' }))
        .toThrow('entry not found');
    } finally {
      database.close();
    }
  });
});
