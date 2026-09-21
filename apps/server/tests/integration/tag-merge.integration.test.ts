import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntryContent } from '../../src/repositories/entry-content-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import {
  assignEntryTag,
} from '../../src/repositories/entry-tag-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { assignProducerTag } from '../../src/repositories/producer-tag-repository.js';
import { deleteTag, mergeTag, TagMergeError } from '../../src/repositories/tag-merge-repository.js';

describe('tag merge repository', () => {
  it('re-points every assignment to the kept tag and deletes the merged tags', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'comic', name: 'Basics' });
      const entryA = createEntry(database, { title: 'Work A', type: 'comic' });
      const entryB = createEntry(database, { title: 'Work B', type: 'comic' });
      const kept = assignEntryTag(database, { entryId: entryA.id, facetId: section.defaultFacetId, name: '魔法少女' });
      const merged = assignEntryTag(database, { entryId: entryB.id, facetId: section.defaultFacetId, name: '魔法少女?标签重复' });

      const result = mergeTag(database, {
        vocabulary: 'entry',
        keptTagId: kept.tagId,
        mergedTagIds: [merged.tagId],
      });

      expect(result).toEqual({
        keptTagId: kept.tagId,
        movedAssignments: 1,
        skippedDuplicates: 0,
        deletedTags: 1,
      });
      // Work B now carries the kept tag; the merged tag row is gone.
      expect(database.prepare(`
        SELECT COUNT(*) FROM entry_tags WHERE tag_id = ?
      `).pluck().get(merged.tagId)).toBe(0);
      expect(database.prepare(`
        SELECT COUNT(*) FROM tags WHERE id = ?
      `).pluck().get(merged.tagId)).toBe(0);
      const workBTags = database.prepare(`
        SELECT t.name FROM entry_tags AS a JOIN tags AS t ON t.id = a.tag_id
        WHERE a.entry_id = ?
      `).all(entryB.id) as Array<{ name: string }>;
      expect(workBTags).toEqual([{ name: '魔法少女' }]);
    } finally {
      database.close();
    }
  });

  it('drops duplicates when the entry already carries the kept tag (kept wins)', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'comic', name: 'Basics' });
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      const kept = assignEntryTag(database, { entryId: entry.id, facetId: section.defaultFacetId, name: '校园' });
      const merged = assignEntryTag(database, { entryId: entry.id, facetId: section.defaultFacetId, name: '学校' });

      const result = mergeTag(database, {
        vocabulary: 'entry',
        keptTagId: kept.tagId,
        mergedTagIds: [merged.tagId],
      });

      // The (entry, tag) pair already existed, so the move is a duplicate skip.
      expect(result.skippedDuplicates).toBe(1);
      expect(result.movedAssignments).toBe(0);
      const rows = database.prepare(`
        SELECT t.name FROM entry_tags AS a JOIN tags AS t ON t.id = a.tag_id WHERE a.entry_id = ?
      `).all(entry.id) as Array<{ name: string }>;
      expect(rows).toEqual([{ name: '校园' }]);
      expect(database.prepare('SELECT COUNT(*) FROM tags').pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it('merges producer tags through the same path', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const author = createProducer(database, { name: 'Author' });
      const kept = assignProducerTag(database, { producerId: author.id, name: '主要作品' });
      const merged = assignProducerTag(database, { producerId: author.id, name: '主要作品?' });

      const result = mergeTag(database, {
        vocabulary: 'producer',
        keptTagId: kept.tagId,
        mergedTagIds: [merged.tagId],
      });
      // The producer already carried the kept tag, so the merged assignment
      // is a duplicate skip (identical to the entry-vocabulary rule).
      expect(result.skippedDuplicates).toBe(1);
      expect(result.movedAssignments).toBe(0);
      expect(database.prepare('SELECT COUNT(*) FROM producer_tags').pluck().get()).toBe(1);
      const names = database.prepare(`
        SELECT t.name FROM producer_tag_assignments AS a
        JOIN producer_tags AS t ON t.id = a.tag_id WHERE a.producer_id = ?
      `).all(author.id) as Array<{ name: string }>;
      expect(names).toEqual([{ name: '主要作品' }]);
    } finally {
      database.close();
    }
  });

  it('rejects unknown tags and kept-inside-merged shapes with zero writes', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'comic', name: 'Basics' });
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      const tag = assignEntryTag(database, { entryId: entry.id, facetId: section.defaultFacetId, name: '校园' });

      expect(() => mergeTag(database, {
        vocabulary: 'entry', keptTagId: tag.tagId, mergedTagIds: [999_999],
      })).toThrow(TagMergeError);
      expect(() => mergeTag(database, {
        vocabulary: 'entry', keptTagId: tag.tagId, mergedTagIds: [tag.tagId],
      })).toThrow(TagMergeError);
      // Nothing changed.
      expect(database.prepare('SELECT COUNT(*) FROM tags').pluck().get()).toBe(1);
      expect(database.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it('rolls back everything when the transaction fails mid-way', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'comic', name: 'Basics' });
      const entryA = createEntry(database, { title: 'Work A', type: 'comic' });
      const entryB = createEntry(database, { title: 'Work B', type: 'comic' });
      const kept = assignEntryTag(database, { entryId: entryA.id, facetId: section.defaultFacetId, name: '魔法少女' });
      const merged = assignEntryTag(database, { entryId: entryB.id, facetId: section.defaultFacetId, name: '魔法少女?标签重复' });

      expect(() => mergeTag(database, {
        vocabulary: 'entry', keptTagId: kept.tagId, mergedTagIds: [merged.tagId],
      }, { injectFailure: () => { throw new Error('injected'); } })).toThrow('injected');

      // Merged assignment and tag row both survive.
      expect(database.prepare(`
        SELECT COUNT(*) FROM entry_tags WHERE tag_id = ?
      `).pluck().get(merged.tagId)).toBe(1);
      expect(database.prepare(`
        SELECT COUNT(*) FROM tags WHERE id = ?
      `).pluck().get(merged.tagId)).toBe(1);
    } finally {
      database.close();
    }
  });

  it('leaves unrelated data (contents, producers, sections) untouched', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'comic', name: 'Basics' });
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      const author = createProducer(database, { name: 'Author' });
      linkEntryProducer(database, entry.id, author.id);
      createEntryContent(database, { entryId: entry.id, contentType: 'note', content: 'x', sortOrder: 0 });
      const kept = assignEntryTag(database, { entryId: entry.id, facetId: section.defaultFacetId, name: 'A' });
      const merged = assignEntryTag(database, { entryId: entry.id, facetId: section.defaultFacetId, name: 'B' });

      mergeTag(database, { vocabulary: 'entry', keptTagId: kept.tagId, mergedTagIds: [merged.tagId] });

      expect(database.prepare('SELECT COUNT(*) FROM entry_contents').pluck().get()).toBe(1);
      expect(database.prepare('SELECT COUNT(*) FROM entry_producers').pluck().get()).toBe(1);
      expect(database.prepare('SELECT COUNT(*) FROM tag_groups').pluck().get()).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });
});

describe('deleteTag', () => {
  const setup = () => {
    const database = createMigratedMemoryDatabase();
    const section = createSection(database, { entryType: 'comic', name: '分类' });
    // Tags attach to real works: a fresh database has no Entries, so every test
    // creates the ones it assigns to.
    const first = createEntry(database, { title: 'First', type: 'comic' });
    const second = createEntry(database, { title: 'Second', type: 'comic' });
    return { database, section, first, second };
  };

  it('removes the tag and every assignment of it, leaving other tags alone', () => {
    const { database, section, first, second } = setup();
    const doomed = assignEntryTag(database, {
      entryId: first.id, facetId: section.defaultFacetId, name: 'Doomed',
    });
    const kept = assignEntryTag(database, {
      entryId: first.id, facetId: section.defaultFacetId, name: 'Kept',
    });
    // The second work carries both as well, so a delete that only reached one work
    // would be caught here.
    assignEntryTag(database, { entryId: second.id, facetId: section.defaultFacetId, name: 'Doomed' });
    assignEntryTag(database, { entryId: second.id, facetId: section.defaultFacetId, name: 'Kept' });

    const result = deleteTag(database, { vocabulary: 'entry', tagId: doomed.tagId });

    expect(result).toEqual({
      tagId: doomed.tagId,
      tagName: 'Doomed',
      removedAssignments: 2,
      deletedTags: 1,
    });
    expect(database.prepare('SELECT DISTINCT tag_id FROM entry_tags').pluck().all())
      .toEqual([kept.tagId]);
    expect(database.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(2);
    expect(database.prepare('SELECT id FROM tags ORDER BY id').pluck().all())
      .toEqual([kept.tagId]);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    database.close();
  });

  it('refuses a tag that does not exist instead of reporting success', () => {
    const { database } = setup();
    expect(() => deleteTag(database, { vocabulary: 'entry', tagId: 4242 }))
      .toThrow(/does not exist/u);
    database.close();
  });

  it('deletes in the Author vocabulary without touching the Entry one', () => {
    const { database, section, first } = setup();
    const entryTag = assignEntryTag(database, {
      entryId: first.id, facetId: section.defaultFacetId, name: 'Shared spelling',
    });
    const producer = createProducer(database, { name: 'Someone' });
    const producerTag = assignProducerTag(database, {
      producerId: producer.id, name: 'Shared spelling',
    });

    const result = deleteTag(database, { vocabulary: 'producer', tagId: producerTag.tagId });

    expect(result.removedAssignments).toBe(1);
    // The two vocabularies are independent, so an Entry tag of the same spelling
    // must survive an Author-side delete.
    expect(database.prepare('SELECT id FROM producer_tags').pluck().all()).toEqual([]);
    expect(database.prepare('SELECT tag_id FROM entry_tags').pluck().all()).toEqual([entryTag.tagId]);
    database.close();
  });

  it('rolls back when the delete fails part-way', () => {
    const { database, section, first } = setup();
    const doomed = assignEntryTag(database, {
      entryId: first.id, facetId: section.defaultFacetId, name: 'Doomed',
    });

    expect(() => deleteTag(database, { vocabulary: 'entry', tagId: doomed.tagId }, {
      injectFailure: () => { throw new Error('injected'); },
    })).toThrow(/injected/u);

    // The tag and its assignment are both still there: nothing partial survived.
    expect(database.prepare('SELECT COUNT(*) FROM tags').pluck().get()).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(1);
    database.close();
  });
});
