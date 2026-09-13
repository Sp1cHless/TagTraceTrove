import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import {
  createEntryContent,
  deleteEntryContent,
  updateEntryContent,
} from '../../src/repositories/entry-content-repository.js';
import { createEntry, getEntryDetail } from '../../src/repositories/entry-repository.js';
import { mergeAuthorEntries } from '../../src/repositories/entry-merge-repository.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import {
  classifySourceUrl,
  extractSourceUrls,
  listEntryIdsBySourceKey,
  listEntrySources,
  listSourceLibrary,
  normalizeSourceUrl,
} from '../../src/repositories/source-library-repository.js';

describe('Entry merge and Source library integration', () => {
  it('normalizes HTTP Sources without conflating spoofed or unknown hosts', () => {
    const urls = extractSourceUrls(
      'Real https://hitomi.la/reader/a_(b), spoof https://hitomi.la.evil.test/work and mailto:user@example.com',
    );
    expect(urls).toEqual([
      'https://hitomi.la/reader/a_(b)',
      'https://hitomi.la.evil.test/work',
    ]);
    expect(classifySourceUrl(urls[0]!)).toEqual(expect.objectContaining({ sourceKey: 'known:hitomi' }));
    expect(classifySourceUrl(urls[1]!)).toEqual(expect.objectContaining({ sourceKey: 'host:hitomi.la.evil.test' }));
    expect(extractSourceUrls('https://hitomi.la/work#one https://hitomi.la/work#two'))
      .toEqual(['https://hitomi.la/work']);
    expect(classifySourceUrl(normalizeSourceUrl('https://hitomi.la./work')!))
      .toEqual(expect.objectContaining({ sourceKey: 'known:hitomi' }));
    expect(normalizeSourceUrl(`https://example.com/${'你'.repeat(1_400)}`)).toBeNull();
  });

  it('keeps the selected title Entry and copies selected sources plus the other Entry Tags', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'comic', name: 'Tags' });
      const facet = createFacet(database, { sectionId: section.id, name: 'Genre' });
      const author = createProducer(database, { name: 'Same Author' });
      const coauthor = createProducer(database, { name: 'Additional Author' });
      const keep = createEntry(database, { title: 'Preferred title', type: 'comic' });
      const absorb = createEntry(database, { title: 'Alternate title', type: 'comic' });
      linkEntryProducer(database, keep.id, author.id);
      linkEntryProducer(database, absorb.id, author.id);
      linkEntryProducer(database, absorb.id, coauthor.id);
      assignEntryTag(database, { entryId: keep.id, facetId: facet.id, name: 'Romance' });
      assignEntryTag(database, { entryId: absorb.id, facetId: facet.id, name: 'Color' });
      createEntryContent(database, {
        entryId: keep.id,
        contentType: 'Source URL',
        content: 'https://example.test/work/1',
      });
      createEntryContent(database, {
        entryId: absorb.id,
        contentType: 'Imported source',
        content: 'https://hitomi.la/reader/123.html',
      });
      createEntryContent(database, {
        entryId: absorb.id,
        contentType: 'note',
        content: 'Mirror: https://18comic.vip/album/456/ — checked manually',
      });

      const result = mergeAuthorEntries(database, {
        authorId: author.id,
        keepEntryId: keep.id,
        absorbEntryId: absorb.id,
        copyTags: true,
        sourceUrls: [
          'https://hitomi.la/reader/123.html',
          'https://18comic.vip/album/456/',
        ],
      });

      expect(result).toMatchObject({
        keptEntryId: keep.id,
        absorbedEntryId: absorb.id,
        copiedTagCount: 1,
        copiedSourceCount: 2,
      });
      expect(getEntryDetail(database, absorb.id)).toBeNull();
      const detail = getEntryDetail(database, keep.id)!;
      expect(detail.title).toBe('Preferred title');
      expect(detail.producers.map((producer) => producer.name).sort())
        .toEqual(['Additional Author', 'Same Author']);
      expect(detail.sections.flatMap((item) => item.facets).flatMap((item) => item.tags)
        .map((tag) => tag.name).sort()).toEqual(['Color', 'Romance']);
      expect(detail.contents.map((item) => item.content)).toEqual([
        'https://example.test/work/1',
        'https://hitomi.la/reader/123.html',
        'https://18comic.vip/album/456/',
      ]);
      expect(listEntrySources(database, keep.id).map((source) => source.sourceKey).sort())
        .toEqual(['host:example.test', 'known:18comic', 'known:hitomi']);
    } finally {
      database.close();
    }
  });

  it('stores the title chosen for the merge, taken from either Entry or rewritten', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const author = createProducer(database, { name: 'Same Author' });
      const keep = createEntry(database, { title: 'Preferred title', type: 'comic' });
      const absorb = createEntry(database, { title: 'Alternate title', type: 'comic' });
      linkEntryProducer(database, keep.id, author.id);
      linkEntryProducer(database, absorb.id, author.id);

      // 沿用另一条（将被删除）的标题
      const absorbedTitle = mergeAuthorEntries(database, {
        authorId: author.id,
        keepEntryId: keep.id,
        absorbEntryId: absorb.id,
        copyTags: false,
        title: 'Alternate title',
        sourceUrls: [],
      });
      expect(absorbedTitle.keptEntryId).toBe(keep.id);
      expect(getEntryDetail(database, keep.id)!.title).toBe('Alternate title');

      // 再次合并时自己改写标题，并去掉首尾空白
      const other = createEntry(database, { title: 'Third title', type: 'comic' });
      linkEntryProducer(database, other.id, author.id);
      mergeAuthorEntries(database, {
        authorId: author.id,
        keepEntryId: keep.id,
        absorbEntryId: other.id,
        copyTags: false,
        title: '  Custom merged title  ',
        sourceUrls: [],
      });
      expect(getEntryDetail(database, keep.id)!.title).toBe('Custom merged title');

      // 不传 title 时保持原样
      const third = createEntry(database, { title: 'Fourth title', type: 'comic' });
      linkEntryProducer(database, third.id, author.id);
      mergeAuthorEntries(database, {
        authorId: author.id,
        keepEntryId: keep.id,
        absorbEntryId: third.id,
        copyTags: false,
        sourceUrls: [],
      });
      expect(getEntryDetail(database, keep.id)!.title).toBe('Custom merged title');
    } finally {
      database.close();
    }
  });

  it('derives the source library from every Content body, including manually created URLs', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const first = createEntry(database, { title: 'First', type: 'comic' });
      const second = createEntry(database, { title: 'Second', type: 'manga' });
      createEntryContent(database, {
        entryId: first.id,
        contentType: 'my custom field',
        content: 'Original https://hanime1.me/watch?v=abc',
      });
      const editable = createEntryContent(database, {
        entryId: first.id,
        contentType: 'another custom field',
        content: 'Backup https://www.unknown.example/item/1.',
      });
      createEntryContent(database, {
        entryId: second.id,
        contentType: 'Source URL',
        content: 'https://hanime1.me/watch?v=xyz',
      });

      expect(listEntrySources(database, first.id)).toEqual([
        expect.objectContaining({ sourceKey: 'known:hanime1', sourceName: 'Hanime1', host: 'hanime1.me' }),
        expect.objectContaining({ sourceKey: 'host:www.unknown.example', sourceName: 'www.unknown.example', host: 'www.unknown.example' }),
      ]);
      expect(listSourceLibrary(database)).toEqual([
        expect.objectContaining({ sourceKey: 'host:www.unknown.example', entryCount: 1, entryUrlCount: 1 }),
        expect.objectContaining({ sourceKey: 'known:hanime1', entryCount: 2, entryUrlCount: 2 }),
      ]);
      expect(listEntryIdsBySourceKey(database, 'known:hanime1')).toEqual([first.id, second.id]);
      expect(extractSourceUrls('See (https://example.test/a_(b)) and https://example.test/end。'))
        .toEqual(['https://example.test/a_(b)', 'https://example.test/end']);

      updateEntryContent(database, editable.id, {
        content: 'Moved to https://replacement.example/item/1',
      });
      expect(listEntrySources(database, first.id).map((source) => source.sourceKey))
        .toEqual(['known:hanime1', 'host:replacement.example']);
      deleteEntryContent(database, editable.id);
      expect(listEntrySources(database, first.id).map((source) => source.sourceKey))
        .toEqual(['known:hanime1']);
    } finally {
      database.close();
    }
  });

  it('rejects Entries from different Galleries or without the active Author and rolls back', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const author = createProducer(database, { name: 'Author' });
      const keep = createEntry(database, { title: 'Keep', type: 'comic' });
      const otherType = createEntry(database, { title: 'Other type', type: 'manga' });
      const unlinked = createEntry(database, { title: 'Unlinked', type: 'comic' });
      linkEntryProducer(database, keep.id, author.id);
      linkEntryProducer(database, otherType.id, author.id);
      createEntryContent(database, { entryId: otherType.id, contentType: 'Source URL', content: 'https://hitomi.la/a' });

      expect(() => mergeAuthorEntries(database, {
        authorId: author.id,
        keepEntryId: keep.id,
        absorbEntryId: otherType.id,
        copyTags: true,
        sourceUrls: ['https://hitomi.la/a'],
      })).toThrow('same Gallery');
      expect(() => mergeAuthorEntries(database, {
        authorId: author.id,
        keepEntryId: keep.id,
        absorbEntryId: unlinked.id,
        copyTags: true,
        sourceUrls: [],
      })).toThrow('linked to the active Author');
      expect(getEntryDetail(database, otherType.id)?.title).toBe('Other type');
      expect(getEntryDetail(database, unlinked.id)?.title).toBe('Unlinked');
    } finally {
      database.close();
    }
  });

  it('can keep the second selected Entry and does not duplicate an existing Source URL', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const author = createProducer(database, { name: 'Author' });
      const first = createEntry(database, { title: 'First title', type: 'comic' });
      const second = createEntry(database, { title: 'Second title', type: 'comic' });
      linkEntryProducer(database, first.id, author.id);
      linkEntryProducer(database, second.id, author.id);
      for (const entry of [first, second]) {
        createEntryContent(database, {
          entryId: entry.id,
          contentType: 'Source URL',
          content: 'https://hitomi.la/reader/shared.html#page-2',
        });
      }

      const result = mergeAuthorEntries(database, {
        authorId: author.id,
        keepEntryId: second.id,
        absorbEntryId: first.id,
        copyTags: false,
        sourceUrls: ['https://hitomi.la/reader/shared.html#page-2'],
      });

      expect(result.copiedSourceCount).toBe(0);
      expect(getEntryDetail(database, first.id)).toBeNull();
      expect(getEntryDetail(database, second.id)?.title).toBe('Second title');
      expect(listEntrySources(database, second.id)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('rolls back copied Tags when creating Source Content fails inside the merge transaction', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'comic', name: 'Tags' });
      const facet = createFacet(database, { sectionId: section.id, name: 'Genre' });
      const author = createProducer(database, { name: 'Author' });
      const keep = createEntry(database, { title: 'Keep', type: 'comic' });
      const absorb = createEntry(database, { title: 'Absorb', type: 'comic' });
      linkEntryProducer(database, keep.id, author.id);
      linkEntryProducer(database, absorb.id, author.id);
      assignEntryTag(database, { entryId: absorb.id, facetId: facet.id, name: 'Copied only on success' });
      createEntryContent(database, {
        entryId: absorb.id,
        contentType: 'Source URL',
        content: 'https://hitomi.la/reader/rollback.html',
      });
      database.exec(`
        CREATE TRIGGER force_merge_content_failure
        BEFORE INSERT ON entry_contents
        WHEN NEW.entry_id = ${keep.id}
        BEGIN
          SELECT RAISE(ABORT, 'forced merge failure');
        END;
      `);

      expect(() => mergeAuthorEntries(database, {
        authorId: author.id,
        keepEntryId: keep.id,
        absorbEntryId: absorb.id,
        copyTags: true,
        sourceUrls: ['https://hitomi.la/reader/rollback.html'],
      })).toThrow('forced merge failure');

      expect(getEntryDetail(database, absorb.id)?.title).toBe('Absorb');
      expect(getEntryDetail(database, keep.id)?.sections
        .flatMap((sectionRow) => sectionRow.facets)
        .flatMap((facetRow) => facetRow.tags)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
