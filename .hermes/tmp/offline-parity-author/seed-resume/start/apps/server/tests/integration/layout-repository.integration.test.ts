import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import {
  createFacet,
  createSection,
  deleteFacet,
  deleteSection,
  listLayout,
  renameTagGroup,
  reorderSectionFacets,
  reorderTagGroup,
} from '../../src/repositories/layout-repository.js';

describe('layout repository', () => {
  it('creates a section and its unnamed default facet atomically', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const created = createSection(database, {
        entryType: 'game',
        name: 'Basic information',
        sortOrder: 2,
      });

      expect(created).toEqual({
        id: expect.any(Number),
        entryType: 'game',
        name: 'Basic information',
        sortOrder: 2,
        defaultFacetId: expect.any(Number),
      });
      expect(listLayout(database, 'game')).toEqual([
        {
          id: created.id,
          name: 'Basic information',
          sortOrder: 2,
          facets: [
            {
              id: created.defaultFacetId,
              name: '',
              sortOrder: 0,
            },
          ],
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('rolls back the section when its default facet cannot be created', () => {
    const database = createMigratedMemoryDatabase();

    try {
      database.exec(`
        CREATE TRIGGER test_reject_default_facet
        BEFORE INSERT ON tag_groups
        WHEN NEW.group_kind = 'facet' AND NEW.name = ''
        BEGIN
          SELECT RAISE(ABORT, 'test rejection');
        END;
      `);

      expect(() => createSection(database, {
        entryType: 'game',
        name: 'Basic information',
      })).toThrow('test rejection');
      expect(database.prepare('SELECT COUNT(*) FROM tag_groups').pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it('creates, renames, and orders sections and facets', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const laterSection = createSection(database, {
        entryType: 'game',
        name: 'Review',
        sortOrder: 5,
      });
      const earlierSection = createSection(database, {
        entryType: 'game',
        name: 'Basic',
        sortOrder: 1,
      });
      const namedFacet = createFacet(database, {
        sectionId: earlierSection.id,
        name: 'Character',
        sortOrder: 3,
      });

      renameTagGroup(database, namedFacet.id, 'Characters');
      reorderTagGroup(database, namedFacet.id, -1);
      reorderTagGroup(database, laterSection.id, 0);

      expect(listLayout(database, 'game')).toEqual([
        {
          id: laterSection.id,
          name: 'Review',
          sortOrder: 0,
          facets: [
            { id: laterSection.defaultFacetId, name: '', sortOrder: 0 },
          ],
        },
        {
          id: earlierSection.id,
          name: 'Basic',
          sortOrder: 1,
          facets: [
            { id: namedFacet.id, name: 'Characters', sortOrder: -1 },
            { id: earlierSection.defaultFacetId, name: '', sortOrder: 0 },
          ],
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('protects default facets and layouts that still contain assigned tags', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const section = createSection(database, { entryType: 'game', name: 'Basic' });
      const removableFacet = createFacet(database, { sectionId: section.id, name: 'Empty' });

      expect(() => deleteFacet(database, section.defaultFacetId)).toThrow(
        'cannot delete the default facet',
      );
      deleteFacet(database, removableFacet.id);

      database.exec(`
        INSERT INTO entries (id, title, type) VALUES (1, 'Example', 'game');
        INSERT INTO tags (id, name, normalized_name) VALUES (1, 'Favorite', 'favorite');
        INSERT INTO entry_tags (entry_id, tag_id, facet_id)
        VALUES (1, 1, ${section.defaultFacetId});
      `);

      expect(() => deleteSection(database, section.id)).toThrow(
        'cannot delete a section that contains assigned tags',
      );
      expect(listLayout(database, 'game')).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('moves a deleted Facet\'s tags to the unassigned default before removing it', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const basic = createSection(database, { entryType: 'comic', name: 'Basic Information' });
      const series = createFacet(database, { sectionId: basic.id, name: 'Series' });
      const tags = createSection(database, { entryType: 'comic', name: 'Tags' });
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      assignEntryTag(database, { entryId: entry.id, facetId: series.id, name: 'Azur Lane' });

      deleteFacet(database, series.id);

      const layout = listLayout(database, 'comic');
      expect(layout.flatMap((section) => section.facets.map((facet) => facet.name)))
        .toEqual(['', '']); // unnamed defaults only
      const hanging = database.prepare(`
        SELECT COUNT(*) AS n FROM entry_tags WHERE facet_id = ?
      `).get(tags.defaultFacetId) as { n: number };
      expect(hanging.n).toBe(1);
    } finally {
      database.close();
    }
  });

  it('reorders the facets of one section into the requested order', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const section = createSection(database, { entryType: 'game', name: 'Basic' });
      const character = createFacet(database, { sectionId: section.id, name: 'Character' });
      const series = createFacet(database, { sectionId: section.id, name: 'Series' });
      const type = createFacet(database, { sectionId: section.id, name: 'Type' });

      reorderSectionFacets(database, section.id, [
        section.defaultFacetId,
        type.id,
        series.id,
        character.id,
      ]);

      expect(listLayout(database, 'game')[0]!.facets.map((facet) => facet.name))
        .toEqual(['', 'Type', 'Series', 'Character']);
    } finally {
      database.close();
    }
  });

  it('rejects a facet reorder that omits or repeats a facet id', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const section = createSection(database, { entryType: 'game', name: 'Basic' });
      const character = createFacet(database, { sectionId: section.id, name: 'Character' });

      expect(() => reorderSectionFacets(database, section.id, [
        section.defaultFacetId,
      ])).toThrow('facet reorder must include every facet for the section exactly once');
      expect(() => reorderSectionFacets(database, section.id, [
        section.defaultFacetId,
        character.id,
        character.id,
      ])).toThrow('facet reorder must include every facet for the section exactly once');
    } finally {
      database.close();
    }
  });
});
