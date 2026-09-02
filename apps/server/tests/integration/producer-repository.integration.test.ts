import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createAuthorDirectory } from '../../src/repositories/author-directory-repository.js';
import { createEntry, getEntryDetail } from '../../src/repositories/entry-repository.js';
import {
  createProducer,
  deleteProducer,
  getAuthorDetail,
  linkEntryProducer,
  unlinkEntryProducer,
  updateProducer,
} from '../../src/repositories/producer-repository.js';
import { assignProducerTag } from '../../src/repositories/producer-tag-repository.js';

describe('producer repository', () => {
  it('creates and partially updates a simple producer', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const created = createProducer(database, {
        name: '  Example Creator  ',
        occupation: 'Artist',
        content: 'Initial note',
      });
      expect(created).toEqual({
        id: expect.any(Number),
        name: 'Example Creator',
        occupation: 'Artist',
        artworkRef: null,
        content: 'Initial note',
      });
      expect(updateProducer(database, created.id, {
        occupation: null,
        artworkRef: 'creator.webp',
        content: 'Updated note',
      })).toEqual({
        id: created.id,
        name: 'Example Creator',
        occupation: null,
        artworkRef: 'creator.webp',
        content: 'Updated note',
      });
    } finally {
      database.close();
    }
  });

  it('links and unlinks an entry and producer idempotently', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const entry = createEntry(database, { title: 'Example', type: 'game' });
      const producer = createProducer(database, { name: 'Creator' });

      linkEntryProducer(database, entry.id, producer.id);
      linkEntryProducer(database, entry.id, producer.id);
      expect(getEntryDetail(database, entry.id)?.producers).toEqual([
        {
          id: producer.id,
          name: 'Creator',
          occupation: null,
          artworkRef: null,
          content: null,
        },
      ]);

      unlinkEntryProducer(database, entry.id, producer.id);
      unlinkEntryProducer(database, entry.id, producer.id);
      expect(getEntryDetail(database, entry.id)?.producers).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('composes Author details from own Tags, loose works, and Directories', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const author = createProducer(database, {
        name: 'Creator',
        occupation: 'Artist',
        content: 'Important note',
      });
      const grouped = createEntry(database, {
        title: 'Grouped Work',
        type: 'manga',
        coverRef: 'grouped.webp',
      });
      const loose = createEntry(database, {
        title: 'Loose Work',
        type: 'game',
        coverRef: 'loose.webp',
      });
      linkEntryProducer(database, grouped.id, author.id);
      linkEntryProducer(database, loose.id, author.id);
      const tag = assignProducerTag(database, { producerId: author.id, name: 'Illustrator' });
      const directory = createAuthorDirectory(database, {
        producerId: author.id,
        title: 'Manga',
        entryIds: [grouped.id],
      });

      expect(getAuthorDetail(database, author.id)).toEqual({
        ...author,
        galleryType: 'game',
        tags: [{ tagId: tag.tagId, name: 'Illustrator', normalizedName: 'illustrator' }],
        looseEntries: [{
          id: loose.id,
          title: 'Loose Work',
          type: 'game',
          coverRef: 'loose.webp',
        }],
        directories: [expect.objectContaining({
          id: directory.id,
          title: 'Manga',
          entries: [expect.objectContaining({ id: grouped.id })],
        })],
      });
      expect(getAuthorDetail(database, 999)).toBeNull();
    } finally {
      database.close();
    }
  });

  it('rejects empty names and updates to missing producers', () => {
    const database = createMigratedMemoryDatabase();

    try {
      expect(() => createProducer(database, { name: '  ' }))
        .toThrow('producer name cannot be empty');
      expect(() => updateProducer(database, 999, { name: 'Missing' }))
        .toThrow('producer not found');
    } finally {
      database.close();
    }
  });

  it('deletes a producer while keeping its Entries and clearing the author link', () => {
    const database = createMigratedMemoryDatabase();

    try {
      const producer = createProducer(database, { name: 'To Delete' });
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      linkEntryProducer(database, entry.id, producer.id);
      createAuthorDirectory(database, {
        producerId: producer.id,
        title: 'Dir',
        entryIds: [entry.id],
      });

      deleteProducer(database, producer.id);

      expect(database.prepare('SELECT COUNT(*) FROM producers WHERE id = ?').pluck().get(producer.id)).toBe(0);
      expect(database.prepare('SELECT COUNT(*) FROM entry_producers WHERE producer_id = ?').pluck().get(producer.id)).toBe(0);
      expect(database.prepare('SELECT COUNT(*) FROM author_directories WHERE producer_id = ?').pluck().get(producer.id)).toBe(0);
      expect(database.prepare('SELECT title FROM entries WHERE id = ?').pluck().get(entry.id)).toBe('Work');
      expect(getEntryDetail(database, entry.id)?.producers).toEqual([]);
    } finally {
      database.close();
    }
  });
});
