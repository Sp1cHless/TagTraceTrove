import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry, getEntryDetail } from '../../src/repositories/entry-repository.js';
import {
  convertEntryAuthorsToMultiAuthor,
  MULTI_AUTHOR_PRODUCER_NAME,
} from '../../src/repositories/entry-multi-author-repository.js';
import { findProducers } from '../../src/repositories/producer-tag-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';

describe('multi-author conversion integration', () => {
  it('credits the work to the multi-author Author alone, keeping Author rows but hiding empty ones', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const anthology = createEntry(database, { title: 'Anthology 45', type: 'comic' });
      const solo = createProducer(database, { name: 'Solo Contributor' });
      const other = createProducer(database, { name: 'Other Contributor' });
      const established = createProducer(database, { name: 'Established Author' });
      const establishedWork = createEntry(database, { title: 'Established Work', type: 'comic' });
      linkEntryProducer(database, anthology.id, solo.id);
      linkEntryProducer(database, anthology.id, other.id);
      linkEntryProducer(database, anthology.id, established.id);
      linkEntryProducer(database, establishedWork.id, established.id);

      const result = convertEntryAuthorsToMultiAuthor(database, anthology.id);

      expect(result.multiAuthorName).toBe(MULTI_AUTHOR_PRODUCER_NAME);
      // Who "deserves" to stay is deliberately not judged: every Author goes.
      expect(result.convertedAuthors.map((author) => author.name)).toEqual([
        'Established Author',
        'Other Contributor',
        'Solo Contributor',
      ]);

      const detail = getEntryDetail(database, anthology.id);
      expect(detail?.producers.map((producer) => producer.name)).toEqual([
        MULTI_AUTHOR_PRODUCER_NAME,
      ]);
      expect(detail?.producers.map((producer) => producer.entryCount)).toEqual([1]);

      // The Author rows are kept; only the links are gone. An Author left with
      // no work disappears from the Author list, an Author with their own work
      // stays visible without this anthology.
      const visible = findProducers(database).map((producer) => producer.name);
      expect(visible).toEqual(['Established Author', MULTI_AUTHOR_PRODUCER_NAME]);
      const establishedWorks = database.prepare(`
        SELECT entry_id FROM entry_producers WHERE producer_id = ?
      `).pluck().all(established.id);
      expect(establishedWorks).toEqual([establishedWork.id]);
      const stillStored = database.prepare(
        'SELECT COUNT(*) FROM producers WHERE name IN (?, ?)',
      ).pluck().get('Solo Contributor', 'Other Contributor');
      expect(stillStored).toBe(2);
    } finally {
      database.close();
    }
  });

  it('reuses one multi-author Author across conversions', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const first = createEntry(database, { title: 'First anthology', type: 'comic' });
      const second = createEntry(database, { title: 'Second anthology', type: 'comic' });
      for (const [entry, name] of [[first, 'Contributor A'], [second, 'Contributor B']] as const) {
        const author = createProducer(database, { name });
        linkEntryProducer(database, entry.id, author.id);
        linkEntryProducer(database, entry.id, createProducer(database, { name: `${name} Partner` }).id);
      }

      const firstResult = convertEntryAuthorsToMultiAuthor(database, first.id);
      const secondResult = convertEntryAuthorsToMultiAuthor(database, second.id);

      expect(secondResult.multiAuthorId).toBe(firstResult.multiAuthorId);
      const multiAuthorRows = database.prepare(
        'SELECT COUNT(*) FROM producers WHERE name = ?',
      ).pluck().get(MULTI_AUTHOR_PRODUCER_NAME);
      expect(multiAuthorRows).toBe(1);

      // Every contributor is in the anthology only, so the Entry is already in
      // its final state and a second pass reports nothing to convert.
      const repeated = convertEntryAuthorsToMultiAuthor(database, first.id);
      expect(repeated.convertedAuthors).toEqual([]);
      expect(repeated.multiAuthorId).toBe(firstResult.multiAuthorId);
      expect(getEntryDetail(database, first.id)?.producers.map((producer) => producer.name))
        .toEqual([MULTI_AUTHOR_PRODUCER_NAME]);
    } finally {
      database.close();
    }
  });

  it('treats an already converted work as a no-op instead of a conflict', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const anthology = createEntry(database, { title: 'Anthology', type: 'comic' });
      const first = createProducer(database, { name: 'First Contributor' });
      const second = createProducer(database, { name: 'Second Contributor' });
      linkEntryProducer(database, anthology.id, first.id);
      linkEntryProducer(database, anthology.id, second.id);

      const initial = convertEntryAuthorsToMultiAuthor(database, anthology.id);
      expect(initial.convertedAuthors).toHaveLength(2);

      // Repeating the click must not fail: the work already carries only the
      // multi-author Author, which is exactly the requested end state.
      const repeated = convertEntryAuthorsToMultiAuthor(database, anthology.id);
      expect(repeated).toMatchObject({
        entryId: anthology.id,
        multiAuthorId: initial.multiAuthorId,
        convertedAuthors: [],
      });
      expect(getEntryDetail(database, anthology.id)?.producers.map((producer) => producer.name))
        .toEqual([MULTI_AUTHOR_PRODUCER_NAME]);

      // A work with a single real Author is still refused.
      const solo = createEntry(database, { title: 'Solo work', type: 'comic' });
      linkEntryProducer(database, solo.id, first.id);
      expect(() => convertEntryAuthorsToMultiAuthor(database, solo.id)).toThrow(
        /Entry with several Authors/u,
      );
      expect(getEntryDetail(database, solo.id)?.producers.map((producer) => producer.name))
        .toEqual(['First Contributor']);
    } finally {
      database.close();
    }
  });

  it('refuses single-Author works and writes nothing on failure', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const soloWork = createEntry(database, { title: 'Solo work', type: 'comic' });
      const soloAuthor = createProducer(database, { name: 'Only Author' });
      linkEntryProducer(database, soloWork.id, soloAuthor.id);

      expect(() => convertEntryAuthorsToMultiAuthor(database, soloWork.id)).toThrow(
        /Entry with several Authors/u,
      );
      expect(() => convertEntryAuthorsToMultiAuthor(database, 9_999)).toThrow(/Entry not found/u);
      expect(getEntryDetail(database, soloWork.id)?.producers.map((producer) => producer.name))
        .toEqual(['Only Author']);
      expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it('absorbs the Authors that are added to an already converted work', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const mixed = createEntry(database, { title: 'Mixed work', type: 'comic' });
      const lonely = createProducer(database, { name: 'Lonely Contributor' });
      const established = createProducer(database, { name: 'Established Author' });
      const establishedWork = createEntry(database, { title: 'Established Work', type: 'comic' });
      linkEntryProducer(database, mixed.id, lonely.id);
      linkEntryProducer(database, mixed.id, established.id);
      linkEntryProducer(database, establishedWork.id, established.id);

      const result = convertEntryAuthorsToMultiAuthor(database, mixed.id);

      expect(result.convertedAuthors.map((author) => author.name)).toEqual([
        'Established Author',
        'Lonely Contributor',
      ]);
      expect(getEntryDetail(database, mixed.id)?.producers.map((producer) => producer.name)).toEqual([
        MULTI_AUTHOR_PRODUCER_NAME,
      ]);

      // A later import adds another credited Author to this work; converting
      // again absorbs it too and never absorbs the multi-author Author itself.
      const latecomer = createProducer(database, { name: 'Late Author' });
      linkEntryProducer(database, mixed.id, latecomer.id);
      const again = convertEntryAuthorsToMultiAuthor(database, mixed.id);

      expect(again.convertedAuthors.map((author) => author.name)).toEqual(['Late Author']);
      expect(again.multiAuthorId).toBe(result.multiAuthorId);
      expect(getEntryDetail(database, mixed.id)?.producers.map((producer) => producer.name)).toEqual([
        MULTI_AUTHOR_PRODUCER_NAME,
      ]);
      expect(database.prepare('SELECT COUNT(*) FROM producers WHERE name = ?').pluck().get(
        MULTI_AUTHOR_PRODUCER_NAME,
      )).toBe(1);
    } finally {
      database.close();
    }
  });
});
