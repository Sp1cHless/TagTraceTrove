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
import { mergeTag, TagMergeError } from '../../src/repositories/tag-merge-repository.js';

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
