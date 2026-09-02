import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import {
  createEntryContent,
  deleteEntryContent,
  reorderEntryContents,
  updateEntryContent,
} from '../../src/repositories/entry-content-repository.js';
import { createEntry, getEntryDetail } from '../../src/repositories/entry-repository.js';

describe('entry content repository', () => {
  it('creates, updates, reorders, and deletes layout-independent content', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const entry = createEntry(database, { title: 'Work', type: 'game' });
      const review = createEntryContent(database, {
        entryId: entry.id,
        contentType: ' short review ',
        content: 'Initial review',
        sortOrder: 1,
      });
      const source = createEntryContent(database, {
        entryId: entry.id,
        contentType: 'source url',
        content: 'https://example.test',
        sortOrder: 0,
      });

      expect(getEntryDetail(database, entry.id)?.contents.map((item) => item.id))
        .toEqual([source.id, review.id]);
      expect(updateEntryContent(database, review.id, {
        content: 'Updated review',
      }).content).toBe('Updated review');

      reorderEntryContents(database, entry.id, [review.id, source.id]);
      expect(getEntryDetail(database, entry.id)?.contents).toEqual([
        {
          id: review.id,
          contentType: 'short review',
          content: 'Updated review',
          sortOrder: 0,
        },
        {
          id: source.id,
          contentType: 'source url',
          content: 'https://example.test',
          sortOrder: 1,
        },
      ]);

      deleteEntryContent(database, source.id);
      expect(getEntryDetail(database, entry.id)?.contents.map((item) => item.id))
        .toEqual([review.id]);
    } finally {
      database.close();
    }
  });

  it('rejects invalid reorder lists without changing existing order', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const firstEntry = createEntry(database, { title: 'First', type: 'game' });
      const secondEntry = createEntry(database, { title: 'Second', type: 'game' });
      const first = createEntryContent(database, {
        entryId: firstEntry.id,
        contentType: 'note',
        content: 'One',
        sortOrder: 0,
      });
      const second = createEntryContent(database, {
        entryId: firstEntry.id,
        contentType: 'note',
        content: 'Two',
        sortOrder: 1,
      });
      const foreign = createEntryContent(database, {
        entryId: secondEntry.id,
        contentType: 'note',
        content: 'Foreign',
      });

      expect(() => reorderEntryContents(database, firstEntry.id, [second.id, foreign.id]))
        .toThrow('content reorder must include every content item for the entry exactly once');
      expect(getEntryDetail(database, firstEntry.id)?.contents.map((item) => item.id))
        .toEqual([first.id, second.id]);
    } finally {
      database.close();
    }
  });

  it('rejects empty content types and missing content records', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const entry = createEntry(database, { title: 'Work', type: 'game' });
      expect(() => createEntryContent(database, {
        entryId: entry.id,
        contentType: '  ',
        content: 'Invalid',
      })).toThrow('content type cannot be empty');
      expect(() => updateEntryContent(database, 999, { content: 'Missing' }))
        .toThrow('entry content not found');
      expect(() => deleteEntryContent(database, 999))
        .toThrow('entry content not found');
    } finally {
      database.close();
    }
  });
});
