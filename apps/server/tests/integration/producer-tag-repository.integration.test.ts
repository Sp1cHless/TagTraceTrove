import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import {
  assignProducerTag,
  findProducers,
  listProducerTags,
  renameProducerTag,
  removeProducerTag,
} from '../../src/repositories/producer-tag-repository.js';

describe('producer tag repository', () => {
  it('normalizes producer tags in a vocabulary separate from entry tags', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const producer = createProducer(database, { name: 'Creator' });
      const section = createSection(database, { entryType: 'game', name: 'Basic' });
      const entry = createEntry(database, { title: 'Work', type: 'game' });
      const entryTag = assignEntryTag(database, {
        entryId: entry.id,
        facetId: section.defaultFacetId,
        name: '  Favorite  ',
      });
      const producerTag = assignProducerTag(database, {
        producerId: producer.id,
        name: ' favorite ',
      });
      const secondProducer = createProducer(database, { name: 'Second Creator' });
      const reusedTag = assignProducerTag(database, {
        producerId: secondProducer.id,
        name: '  FAVORITE  ',
      });

      expect(producerTag.normalizedName).toBe(entryTag.normalizedName);
      expect(reusedTag.tagId).toBe(producerTag.tagId);
      expect(listProducerTags(database, producer.id)).toEqual([
        {
          tagId: producerTag.tagId,
          name: 'favorite',
          normalizedName: 'favorite',
        },
      ]);
      expect(database.prepare('SELECT COUNT(*) FROM tags').pluck().get()).toBe(1);
      expect(database.prepare('SELECT COUNT(*) FROM producer_tags').pluck().get()).toBe(1);

      removeProducerTag(database, producer.id, producerTag.tagId);
      expect(listProducerTags(database, producer.id)).toEqual([]);
      expect(listProducerTags(database, secondProducer.id)).toHaveLength(1);
      expect(database.prepare('SELECT COUNT(*) FROM producer_tags').pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it('renames one Author Tag assignment without changing shared uses', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const first = createProducer(database, { name: 'First' });
      const second = createProducer(database, { name: 'Second' });
      const shared = assignProducerTag(database, { producerId: first.id, name: 'Artist' });
      assignProducerTag(database, { producerId: second.id, name: 'Artist' });

      expect(renameProducerTag(database, {
        producerId: first.id,
        tagId: shared.tagId,
        name: 'Illustrator',
      })).toMatchObject({ name: 'Illustrator', normalizedName: 'illustrator' });
      expect(listProducerTags(database, second.id)).toEqual([
        expect.objectContaining({ name: 'Artist', normalizedName: 'artist' }),
      ]);
    } finally {
      database.close();
    }
  });

  it('finds producers by own tags and one work containing every selected work tag', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const section = createSection(database, { entryType: 'game', name: 'Basic' });
      const firstProducer = createProducer(database, { name: 'First Creator' });
      const secondProducer = createProducer(database, { name: 'Second Creator' });
      const firstWork = createEntry(database, { title: 'Action Work', type: 'game' });
      const secondWork = createEntry(database, { title: 'Favorite Work', type: 'game' });
      const thirdWork = createEntry(database, { title: 'Other Action Work', type: 'game' });
      linkEntryProducer(database, firstWork.id, firstProducer.id);
      linkEntryProducer(database, secondWork.id, firstProducer.id);
      linkEntryProducer(database, thirdWork.id, secondProducer.id);

      const action = assignEntryTag(database, {
        entryId: firstWork.id,
        facetId: section.defaultFacetId,
        name: 'Action',
      });
      const favorite = assignEntryTag(database, {
        entryId: secondWork.id,
        facetId: section.defaultFacetId,
        name: 'Favorite',
      });
      assignEntryTag(database, {
        entryId: thirdWork.id,
        facetId: section.defaultFacetId,
        name: 'Action',
      });
      const featured = assignProducerTag(database, {
        producerId: firstProducer.id,
        name: 'Featured',
      });

      expect(findProducers(database, {
        relatedEntryTagIds: [action.tagId, favorite.tagId],
      })).toEqual([]);

      assignEntryTag(database, {
        entryId: firstWork.id,
        facetId: section.defaultFacetId,
        name: 'Favorite',
      });
      expect(findProducers(database, {
        relatedEntryTagIds: [action.tagId, favorite.tagId],
      })).toEqual([{ id: firstProducer.id, name: 'First Creator', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false }]);
      expect(findProducers(database, {
        ownTagIds: [featured.tagId],
      })).toEqual([{ id: firstProducer.id, name: 'First Creator', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false }]);
      expect(findProducers(database, {
        ownTagIds: [featured.tagId],
        relatedEntryTagIds: [action.tagId, favorite.tagId],
      })).toEqual([{ id: firstProducer.id, name: 'First Creator', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false }]);
    } finally {
      database.close();
    }
  });

  it('rolls back a new vocabulary tag when the producer is missing', () => {
    const database = createMigratedMemoryDatabase();

    try {
      expect(() => assignProducerTag(database, {
        producerId: 999,
        name: 'Orphan tag',
      })).toThrow('FOREIGN KEY constraint failed');
      expect(database.prepare('SELECT COUNT(*) FROM producer_tags').pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });
});
