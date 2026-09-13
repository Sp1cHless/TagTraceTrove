import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { assignProducerTag } from '../../src/repositories/producer-tag-repository.js';
import { suggestProducers, suggestTags } from '../../src/repositories/suggestion-repository.js';
import { upsertTaxonomyAlias } from '../../src/repositories/taxonomy-repository.js';

describe('relation suggestion repository', () => {
  it('keeps Entry and Producer Tag vocabularies separate and never admits fuzzy leakage', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'comic', name: 'Basic' });
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      const campus = assignEntryTag(database, {
        entryId: entry.id,
        facetId: section.defaultFacetId,
        name: '校园',
      });
      assignEntryTag(database, {
        entryId: entry.id,
        facetId: section.defaultFacetId,
        name: '校服',
      });
      const producer = createProducer(database, { name: 'Creator' });
      const producerTag = assignProducerTag(database, {
        producerId: producer.id,
        name: '校园社团',
      });

      expect(suggestTags(database, {
        vocabulary: 'entry', q: '校园', limit: 20, excludeIds: [],
      })).toEqual([expect.objectContaining({ id: campus.tagId, name: '校园' })]);
      expect(suggestTags(database, {
        vocabulary: 'producer', q: '校园', limit: 20, excludeIds: [],
      })).toEqual([expect.objectContaining({ id: producerTag.tagId, name: '校园社团' })]);
    } finally {
      database.close();
    }
  });

  it('uses only aliases allowed for each relation namespace and includes workless Authors', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'comic', name: 'Basic' });
      const entry = createEntry(database, { title: 'Blue work', type: 'comic' });
      const blueBox = assignEntryTag(database, {
        entryId: entry.id,
        facetId: section.defaultFacetId,
        name: '青色之箱',
      });
      upsertTaxonomyAlias(database, {
        vocabulary: 'entry', partition: 'series', alias: 'Blue Box', canonicalName: '青色之箱',
      });

      const author = createProducer(database, { name: '石恵' });
      upsertTaxonomyAlias(database, {
        vocabulary: 'producer', partition: 'authors', alias: 'Ishikei', canonicalName: '石恵',
      });
      const taggedProducer = createProducer(database, { name: 'Tagged' });
      const circle = assignProducerTag(database, { producerId: taggedProducer.id, name: '社团' });
      upsertTaxonomyAlias(database, {
        vocabulary: 'producer', partition: 'types', alias: 'Circle', canonicalName: '社团',
      });

      expect(suggestTags(database, {
        vocabulary: 'entry', q: 'blue b', limit: 20, excludeIds: [],
      })).toEqual([{
        id: blueBox.tagId,
        name: '青色之箱',
        matchedAlias: 'Blue Box',
        sameContextUsageCount: 0,
        totalUsageCount: 1,
      }]);
      expect(suggestProducers(database, { q: 'ishikei', limit: 20, excludeIds: [] }))
        .toEqual([{
          id: author.id,
          name: '石恵',
          matchedAlias: 'Ishikei',
          sameContextUsageCount: 0,
          totalUsageCount: 0,
        }]);
      expect(suggestTags(database, {
        vocabulary: 'producer', q: 'ishikei', limit: 20, excludeIds: [],
      })).toEqual([]);
      expect(suggestTags(database, {
        vocabulary: 'producer', q: 'circle', limit: 20, excludeIds: [],
      })).toEqual([expect.objectContaining({ id: circle.tagId, matchedAlias: 'Circle' })]);
    } finally {
      database.close();
    }
  });

  it('computes context and total usage independently before deterministic ranking', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const comicSection = createSection(database, { entryType: 'comic', name: 'Basic' });
      const gameSection = createSection(database, { entryType: 'game', name: 'Basic' });
      const comicOne = createEntry(database, { title: 'Comic One', type: 'comic' });
      const comicTwo = createEntry(database, { title: 'Comic Two', type: 'comic' });
      const games = Array.from({ length: 4 }, (_, index) => createEntry(database, {
        title: `Game ${index + 1}`,
        type: 'game',
      }));
      const schoolLife = assignEntryTag(database, {
        entryId: comicOne.id, facetId: comicSection.defaultFacetId, name: 'School Life',
      });
      assignEntryTag(database, {
        entryId: comicTwo.id, facetId: comicSection.defaultFacetId, name: 'School Life',
      });
      const schoolUniform = assignEntryTag(database, {
        entryId: games[0]!.id, facetId: gameSection.defaultFacetId, name: 'School Uniform',
      });
      for (const game of games.slice(1)) {
        assignEntryTag(database, {
          entryId: game.id, facetId: gameSection.defaultFacetId, name: 'School Uniform',
        });
      }

      expect(suggestTags(database, {
        vocabulary: 'entry',
        q: 'school',
        limit: 20,
        excludeIds: [],
        entryType: 'comic',
      })).toEqual([
        {
          id: schoolLife.tagId,
          name: 'School Life',
          sameContextUsageCount: 2,
          totalUsageCount: 2,
        },
        {
          id: schoolUniform.tagId,
          name: 'School Uniform',
          sameContextUsageCount: 0,
          totalUsageCount: 4,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('applies exclusions before filling the hard result limit', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'comic', name: 'Basic' });
      const entry = createEntry(database, { title: 'Many tags', type: 'comic' });
      const ids = Array.from({ length: 25 }, (_, index) => assignEntryTag(database, {
        entryId: entry.id,
        facetId: section.defaultFacetId,
        name: `校${String(index + 1).padStart(2, '0')}`,
      }).tagId);

      const results = suggestTags(database, {
        vocabulary: 'entry', q: '校', limit: 20, excludeIds: ids.slice(0, 5),
      });
      expect(results).toHaveLength(20);
      expect(results.some((result) => ids.slice(0, 5).includes(result.id))).toBe(false);
    } finally {
      database.close();
    }
  });

  it('ranks Author identity by linked-work count without hiding unlinked Authors', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const unlinked = createProducer(database, { name: 'School Empty' });
      const linked = createProducer(database, { name: 'School Linked' });
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      linkEntryProducer(database, entry.id, linked.id);

      expect(suggestProducers(database, {
        q: 'school', limit: 20, excludeIds: [linked.id],
      })).toEqual([{
        id: unlinked.id,
        name: 'School Empty',
        sameContextUsageCount: 0,
        totalUsageCount: 0,
      }]);
    } finally {
      database.close();
    }
  });

  it('exposes validated bounded Tag and Author suggestion HTTP endpoints', async () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'comic', name: 'Basic' });
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      const tag = assignEntryTag(database, {
        entryId: entry.id, facetId: section.defaultFacetId, name: '校园生活',
      });
      const author = createProducer(database, { name: 'School Author' });
      const app = createApiApp(database);

      const tagResponse = await app.request(
        `/api/suggestions/tags?vocabulary=entry&q=${encodeURIComponent('校园')}&limit=10&excludeIds=999`,
      );
      expect(tagResponse.status).toBe(200);
      await expect(tagResponse.json()).resolves.toEqual([
        expect.objectContaining({ id: tag.tagId, name: '校园生活' }),
      ]);

      const authorResponse = await app.request('/api/suggestions/producers?q=school&limit=20');
      expect(authorResponse.status).toBe(200);
      await expect(authorResponse.json()).resolves.toEqual([
        expect.objectContaining({ id: author.id, name: 'School Author' }),
      ]);

      const blankResponse = await app.request('/api/suggestions/tags?vocabulary=entry&q=%E3%80%80');
      expect(blankResponse.status).toBe(400);
    } finally {
      database.close();
    }
  });
});
