import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import {
  addEntryToAuthorDirectory,
  createAuthorDirectory,
  listAuthorDirectories,
  removeEntryFromAuthorDirectory,
  updateAuthorDirectory,
} from '../../src/repositories/author-directory-repository.js';

describe('author directory repository', () => {
  it('creates presentation-only directories from linked works and updates their metadata', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const author = createProducer(database, { name: 'Author' });
      const first = createEntry(database, { title: 'First', type: 'manga', coverRef: 'first.webp' });
      const second = createEntry(database, { title: 'Second', type: 'manga', coverRef: 'second.webp' });
      linkEntryProducer(database, first.id, author.id);
      linkEntryProducer(database, second.id, author.id);

      const directory = createAuthorDirectory(database, {
        producerId: author.id,
        title: 'New Directory',
        entryIds: [first.id, second.id],
      });
      expect(directory).toMatchObject({
        producerId: author.id,
        title: 'New Directory',
        description: '',
        entries: [
          { id: first.id, title: 'First', type: 'manga', coverRef: 'first.webp' },
          { id: second.id, title: 'Second', type: 'manga', coverRef: 'second.webp' },
        ],
      });

      expect(updateAuthorDirectory(database, directory.id, {
        title: 'Early work',
        description: 'The first two works.',
      })).toMatchObject({
        title: 'Early work',
        description: 'The first two works.',
      });
      expect(listAuthorDirectories(database, author.id)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('moves one linked work between directories and keeps one membership per author', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const author = createProducer(database, { name: 'Author' });
      const work = createEntry(database, { title: 'Work', type: 'game' });
      linkEntryProducer(database, work.id, author.id);
      const first = createAuthorDirectory(database, {
        producerId: author.id,
        title: 'First',
        entryIds: [work.id],
      });
      const second = createAuthorDirectory(database, {
        producerId: author.id,
        title: 'Second',
      });

      addEntryToAuthorDirectory(database, {
        producerId: author.id,
        directoryId: second.id,
        entryId: work.id,
      });

      expect(listAuthorDirectories(database, author.id)).toEqual([
        expect.objectContaining({ id: first.id, entries: [] }),
        expect.objectContaining({ id: second.id, entries: [expect.objectContaining({ id: work.id })] }),
      ]);

      expect(removeEntryFromAuthorDirectory(database, {
        producerId: author.id,
        directoryId: second.id,
        entryId: work.id,
      })).toEqual(expect.objectContaining({ id: second.id, entries: [] }));
    } finally {
      database.close();
    }
  });

  it('rejects unlinked works and cross-author directory membership', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const firstAuthor = createProducer(database, { name: 'First Author' });
      const secondAuthor = createProducer(database, { name: 'Second Author' });
      const work = createEntry(database, { title: 'Work', type: 'game' });
      linkEntryProducer(database, work.id, firstAuthor.id);
      const directory = createAuthorDirectory(database, {
        producerId: secondAuthor.id,
        title: 'Other Author',
      });

      expect(() => addEntryToAuthorDirectory(database, {
        producerId: secondAuthor.id,
        directoryId: directory.id,
        entryId: work.id,
      })).toThrow();
      expect(() => createAuthorDirectory(database, {
        producerId: secondAuthor.id,
        title: 'Invalid',
        entryIds: [work.id],
      })).toThrow();
    } finally {
      database.close();
    }
  });
});
