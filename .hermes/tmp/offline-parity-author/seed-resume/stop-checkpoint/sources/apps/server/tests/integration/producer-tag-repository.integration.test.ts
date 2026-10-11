import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import {
  createProducerRatingSlot,
  createRatingSlot,
  setProducerRating,
} from '../../src/repositories/rating-repository.js';
import {
  assignProducerTag,
  findProducers,
  listAuthorFilterOptions,
  listProducerTags,
  queryProducerPage,
  renameProducerTag,
  removeProducerTag,
  searchProducersByName,
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

  it('filters and orders the Author list by the Author’s own rating', () => {
    // The Author list's rating is the Author's OWN class — what their works inherit is a question
    // about a work. Adding a rating puts the highest first, and the list's own sort control then
    // decides the order within one rating, including `random`.
    const database = createMigratedMemoryDatabase();
    const five = createProducer(database, { name: 'Five' });
    const two = createProducer(database, { name: 'Two' });
    const unrated = createProducer(database, { name: 'Unrated' });
    for (const [title, producer] of [['A', five], ['B', two], ['C', unrated]] as const) {
      linkEntryProducer(database, createEntry(database, { title, type: 'comic' }).id, producer.id);
    }
    const charisma = createRatingSlot(database, {
      kind: 'author_self', entryType: 'comic', name: 'Charisma',
    });
    setProducerRating(database, { producerId: five.id, slotId: charisma.id, stars: 5 });
    setProducerRating(database, { producerId: two.id, slotId: charisma.id, stars: 2 });

    const page = (input: Record<string, unknown>) => queryProducerPage(database, {
      ownTagIds: [],
      relatedEntryTagIds: [],
      includeNsfw: true,
      sort: 'name-asc',
      page: 1,
      pageSize: 10,
      ...input,
    } as never);
    const names = (input: Record<string, unknown>) => page(input).items.map((item) => item.name);

    // Ordered by the rating: 5, then 2, then the one that has no value (it sinks, as unrated does
    // everywhere else). Within one rating the list's sort decides — here `name-asc`.
    expect(names({ ratingSort: { slotId: charisma.id, direction: 'desc' } }))
      .toEqual(['Five', 'Two', 'Unrated']);
    // Filtered: `> 3` is only the five, and `unrated` is only the Author who has no value.
    expect(names({ ratingConditions: [{ slotId: charisma.id, operator: 'gt', stars: 3 }] }))
      .toEqual(['Five']);
    expect(names({ ratingConditions: [{ slotId: charisma.id, operator: 'unrated', stars: null }] }))
      .toEqual(['Unrated']);
    // The two combine: the filter narrows, the rating orders what is left.
    expect(names({
      ratingConditions: [{ slotId: charisma.id, operator: 'gt', stars: 1 }],
      ratingSort: { slotId: charisma.id, direction: 'desc' },
    })).toEqual(['Five', 'Two']);
    // Both the number and the total follow the filter.
    expect(page({ ratingConditions: [{ slotId: charisma.id, operator: 'gt', stars: 3 }] }).total).toBe(1);
    // The list's own control decides the order within one rating — `random` included, which is what
    // orders works of the same stars. Two Authors at the same rating both survive it, and the seed
    // makes the answer stable, exactly as it does for the other sorts.
    const shuffled = names({ ratingSort: { slotId: charisma.id, direction: 'desc' }, sort: 'random', randomSeed: 7 });
    expect([...shuffled].sort()).toEqual(['Five', 'Two', 'Unrated']);
    expect(names({ ratingSort: { slotId: charisma.id, direction: 'desc' }, sort: 'random', randomSeed: 7 }))
      .toEqual(shuffled);

    // The works summary is not an Author-list dimension: it is refused rather than answered with
    // nothing, which is what a silent empty list would look like.
    const summary = createProducerRatingSlot(database, { producerId: five.id, name: 'Charisma' });
    expect(() => page({ ratingSort: { slotId: summary.id, direction: 'desc' } }))
      .toThrow(/not an Author's own rating dimension/u);

    // The options are the Authors' own dimensions of the Galleries these Authors belong to — NOT only
    // the ones somebody has been rated on yet. Measured on a real library: two dimensions existed and
    // nobody was rated on them, so the whole filter button disappeared and it read as a missing
    // feature. A dimension just created is exactly the one a person wants to filter by.
    const fresh = createRatingSlot(database, { kind: 'author_self', entryType: 'comic', name: 'Fresh' });
    const elsewhere = createRatingSlot(database, { kind: 'author_self', entryType: 'manga', name: 'Elsewhere' });
    expect(listAuthorFilterOptions(database).ratingSlots).toEqual([
      { id: charisma.id, name: 'Charisma', sortOrder: 0, entryType: 'comic' },
      { id: fresh.id, name: 'Fresh', sortOrder: 1, entryType: 'comic' },
    ]);
    // Neither the works summary nor another Gallery's dimension belongs in this list.
    expect(listAuthorFilterOptions(database).ratingSlots.map((slot) => slot.id))
      .not.toContain(elsewhere.id);
    expect(listAuthorFilterOptions(database).ratingSlots.map((slot) => slot.id))
      .not.toContain(summary.id);
    expect(unrated.id).toBeGreaterThan(0);
  });

  it('hides Authors with no works from every searchable producer result without deleting them', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const emptyProducer = createProducer(database, { name: 'Empty Creator' });
      const linkedProducer = createProducer(database, { name: 'Linked Creator' });
      const work = createEntry(database, { title: 'Only Work', type: 'game' });
      linkEntryProducer(database, work.id, linkedProducer.id);

      expect(findProducers(database).map((producer) => producer.id)).toEqual([linkedProducer.id]);
      expect(searchProducersByName(database, 'creator').map((producer) => producer.id))
        .toEqual([linkedProducer.id]);
      expect(queryProducerPage(database, {
        ownTagIds: [],
        relatedEntryTagIds: [],
        includeNsfw: true,
        sort: 'name-asc',
        page: 1,
        pageSize: 30,
      })).toMatchObject({
        items: [expect.objectContaining({ id: linkedProducer.id })],
        total: 1,
      });

      database.prepare('DELETE FROM entries WHERE id = ?').run(work.id);

      expect(findProducers(database)).toEqual([]);
      expect(searchProducersByName(database, 'creator')).toEqual([]);
      expect(queryProducerPage(database, {
        ownTagIds: [],
        relatedEntryTagIds: [],
        includeNsfw: true,
        sort: 'name-asc',
        page: 1,
        pageSize: 30,
      })).toMatchObject({ items: [], total: 0 });
      expect(database.prepare('SELECT id FROM producers ORDER BY id').all()).toEqual([
        { id: emptyProducer.id },
        { id: linkedProducer.id },
      ]);
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
