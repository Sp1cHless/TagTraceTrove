import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { commitImportBatch } from '../../src/import/commit.js';
import { getEntryDetail } from '../../src/repositories/entry-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { createProducer } from '../../src/repositories/producer-repository.js';
import { upsertTaxonomyAlias } from '../../src/repositories/taxonomy-repository.js';

describe('commitImportBatch', () => {
  it('maps one canonical Entry into repositories inside a reviewed mapping', () => {
    const database = createMigratedMemoryDatabase();
    const canonicalSection = createSection(database, { entryType: 'comic', name: '分类' });
    const characterSection = createSection(database, { entryType: 'comic', name: '角色' });

    const result = commitImportBatch(database, {
      source: 'example.test',
      warnings: [],
      entries: [{
        externalKey: 'example.test:42',
        title: 'Example comic',
        cover: 'items/42/cover.webp',
        tags: [{ name: 'Full Color', sourceField: 'tags' }],
        fields: {
          authors: ['Example Author'],
          characters: ['Example Character'],
          language: { code: 'en', name: 'English' },
          works: ['Example Series'],
        },
        sources: [{ label: 'Original', url: 'https://example.test/items/42' }],
        body: 'Imported note',
      }],
    }, {
      entryType: 'comic',
      canonicalTagFacetId: canonicalSection.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      bodyContentType: 'body',
      fieldMappings: {
        authors: {
          kind: 'producer',
          createUnmatched: true,
          existingProducerIds: {},
        },
        characters: { kind: 'tag', facetId: characterSection.defaultFacetId },
        language: { kind: 'content', contentType: 'language' },
      },
      ignoredFields: ['works'],
    });

    expect(result).toEqual({
      entries: [{ entryId: 1, externalKey: 'example.test:42', title: 'Example comic' }],
      entryCount: 1,
      createdProducerCount: 1,
      producerLinkCount: 1,
      tagAssignmentCount: 2,
      contentCount: 1,
    });

    expect(getEntryDetail(database, 1)).toMatchObject({
      title: 'Example comic',
      type: 'comic',
      coverRef: null,
      producers: [{ name: 'Example Author' }],
      sections: [
        { name: '分类', facets: [{ tags: [{ name: 'Full Color' }] }] },
        { name: '角色', facets: [{ tags: [{ name: 'Example Character' }] }] },
      ],
      contents: [
        { contentType: 'source url', content: 'https://example.test/items/42', sortOrder: 0 },
      ],
    });

    database.close();
  });

  it('uses only user-reviewed existing Producer matches', () => {
    const database = createMigratedMemoryDatabase();
    const section = createSection(database, { entryType: 'comic', name: '分类' });
    const producer = createProducer(database, { name: 'Reviewed Producer' });

    const result = commitImportBatch(database, {
      source: 'example.test',
      warnings: [],
      entries: [{
        title: 'Mapped work',
        fields: { authors: ['Source Author'] },
      }],
    }, {
      entryType: 'comic',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {
        authors: {
          kind: 'producer',
          createUnmatched: false,
          existingProducerIds: { 'Source Author': producer.id },
        },
      },
      ignoredFields: [],
    });

    expect(result.createdProducerCount).toBe(0);
    expect(result.producerLinkCount).toBe(1);
    expect(getEntryDetail(database, result.entries[0]!.entryId)?.producers).toEqual([
      expect.objectContaining({ id: producer.id, name: 'Reviewed Producer' }),
    ]);
    database.close();
  });

  it('rolls back all writes when a later Entry cannot satisfy its Producer mapping', () => {
    const database = createMigratedMemoryDatabase();
    const section = createSection(database, { entryType: 'comic', name: '分类' });
    const mapping = {
      entryType: 'comic',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {
        authors: {
          kind: 'producer' as const,
          createUnmatched: false,
          existingProducerIds: {},
        },
      },
      ignoredFields: [],
    };

    expect(() => commitImportBatch(database, {
      source: 'example.test',
      warnings: [],
      entries: [
        {
          externalKey: 'example.test:first',
          title: 'First work',
          tags: [{ name: 'Imported' }],
        },
        {
          externalKey: 'example.test:second',
          title: 'Second work',
          fields: { authors: ['Needs review'] },
        },
      ],
    }, mapping)).toThrow('has no user-reviewed match');

    expect(database.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM entry_contents').pluck().get()).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(0);
    database.close();
  });

  it('rejects a source URL that was already imported without adding another Entry', () => {
    const database = createMigratedMemoryDatabase();
    const section = createSection(database, { entryType: 'comic', name: '分类' });
    const mapping = {
      entryType: 'comic',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {},
      ignoredFields: [],
    };
    const batch = {
      source: 'example.test',
      warnings: [],
      entries: [{
        externalKey: 'example.test:42',
        title: 'First title',
        sources: [{ label: 'example.test', url: 'https://example.test/items/42' }],
      }],
    };

    commitImportBatch(database, batch, mapping);
    expect(() => commitImportBatch(database, {
      ...batch,
      entries: [{
        externalKey: 'example.test:99',
        title: 'Different title',
        sources: [{ label: 'example.test', url: 'https://example.test/items/42' }],
      }],
    }, mapping)).toThrow('Source URL has already been imported');
    expect(database.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(1);
    database.close();
  });

  it('allows duplicate titles for the same Entry type when the source URL differs', () => {
    const database = createMigratedMemoryDatabase();
    const section = createSection(database, { entryType: 'comic', name: '分类' });
    const mapping = {
      entryType: 'comic',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {},
      ignoredFields: [],
    };

    const first = commitImportBatch(database, {
      source: 'example.test',
      warnings: [],
      entries: [{ title: 'Same title', sources: [{ label: 'a', url: 'https://a.test/1' }] }],
    }, mapping);
    expect(first.entryCount).toBe(1);

    const second = commitImportBatch(database, {
      source: 'example.test',
      warnings: [],
      entries: [{ title: 'Same title', sources: [{ label: 'a', url: 'https://a.test/2' }] }],
    }, mapping);
    expect(second.entryCount).toBe(1);

    expect(database.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(2);
    database.close();
  });

  it('resolves imported author names through the producer taxonomy dictionary', () => {
    const database = createMigratedMemoryDatabase();
    const section = createSection(database, { entryType: 'comic', name: '分类' });
    upsertTaxonomyAlias(database, {
      vocabulary: 'producer',
      alias: 'bob',
      canonicalName: '鲍勃',
    });
    const mapping = {
      entryType: 'comic',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {
        authors: {
          kind: 'producer' as const,
          createUnmatched: true,
          existingProducerIds: {},
        },
      },
      ignoredFields: [],
    };

    // An alias spelling with no canonical producer yet creates the canonical name.
    const created = commitImportBatch(database, {
      source: 'example.test',
      warnings: [],
      entries: [{
        title: 'Created work',
        fields: { authors: ['bob'] },
        sources: [{ label: 'example.test', url: 'https://example.test/1' }],
      }],
    }, mapping);
    expect(created.createdProducerCount).toBe(1);
    const createdProducers = database.prepare('SELECT id, name FROM producers').all() as Array<{
      id: number;
      name: string;
    }>;
    expect(createdProducers).toEqual([{ id: 1, name: '鲍勃' }]);
    expect(getEntryDetail(database, created.entries[0]!.entryId)?.producers)
      .toEqual([expect.objectContaining({ id: 1, name: '鲍勃' })]);

    // A later import of the alias spelling links to the existing canonical
    // producer instead of creating another row — reviewed by either spelling.
    const linked = commitImportBatch(database, {
      source: 'example.test',
      warnings: [],
      entries: [{
        title: 'Linked work',
        fields: { authors: ['Bob'] },
        sources: [{ label: 'example.test', url: 'https://example.test/2' }],
      }],
    }, {
      ...mapping,
      fieldMappings: {
        authors: {
          kind: 'producer',
          createUnmatched: false,
          existingProducerIds: { 'bob': 1 },
        },
      },
    });
    expect(linked.createdProducerCount).toBe(0);
    expect(linked.producerLinkCount).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(1);
    database.close();
  });
});
