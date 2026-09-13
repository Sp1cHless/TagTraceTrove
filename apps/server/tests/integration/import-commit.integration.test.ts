import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { commitImportBatch } from '../../src/import/commit.js';
import { createEntry, getEntryDetail } from '../../src/repositories/entry-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import {
  createRatingSlot,
  listProducerRatings,
} from '../../src/repositories/rating-repository.js';
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
      authorRatings: [],
    });

    expect(result).toEqual({
      entries: [{ entryId: 1, externalKey: 'example.test:42', title: 'Example comic' }],
      entryCount: 1,
      skippedExistingEntryCount: 0,
      createdProducerCount: 1,
      producerLinkCount: 1,
      tagAssignmentCount: 2,
      contentCount: 1,
      authorRatingCount: 0,
      warnings: [],
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

  it('auto-assigns Original under the Series facet when the meta has no series', () => {
    const database = createMigratedMemoryDatabase();
    const tagsSection = createSection(database, { entryType: 'comic', name: '分类' });
    const seriesSection = createSection(database, { entryType: 'comic', name: '作品' });
    const seriesFacet = createFacet(database, {
      sectionId: seriesSection.id,
      name: 'Series',
    });

    const result = commitImportBatch(database, {
      source: 'example.test',
      warnings: [],
      entries: [
        {
          externalKey: 'example.test:1',
          title: 'Has a series',
          fields: { works: ['Some Series'] },
          sources: [{ label: 'Original', url: 'https://example.test/items/1' }],
        },
        {
          externalKey: 'example.test:2',
          title: 'Original standalone',
          sources: [{ label: 'Original', url: 'https://example.test/items/2' }],
        },
      ],
    }, {
      entryType: 'comic',
      canonicalTagFacetId: tagsSection.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {
        works: { kind: 'tag', facetId: seriesFacet.id },
      },
      ignoredFields: [],
      authorRatings: [],
    });

    const withSeries = getEntryDetail(database, result.entries[0]!.entryId);
    expect(withSeries?.sections.some((section) => section.facets.some((facet) =>
      facet.tags.some((tag) => tag.name === 'Original'),
    ))).toBe(false);
    expect(withSeries?.sections.some((section) => section.facets.some((facet) =>
      facet.tags.some((tag) => tag.name === 'Some Series'),
    ))).toBe(true);

    // No series in the meta → the Original tag fills the Series facet.
    const standalone = getEntryDetail(database, result.entries[1]!.entryId);
    const seriesTags = standalone?.sections
      .flatMap((section) => section.facets)
      .filter((facet) => facet.name === 'Series')
      .flatMap((facet) => facet.tags.map((tag) => tag.name));
    expect(seriesTags).toEqual(['Original']);
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
      authorRatings: [],
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
      authorRatings: [],
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

  it('skips an already-imported source URL while committing new entries from the same author manifest', () => {
    const database = createMigratedMemoryDatabase();
    const section = createSection(database, { entryType: 'comic', name: '分类' });
    const mapping = {
      entryType: 'comic',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {},
      ignoredFields: [],
      authorRatings: [],
    };

    commitImportBatch(database, {
      source: 'example.test',
      warnings: [],
      entries: [{
        externalKey: 'example.test:42',
        title: 'Existing work',
        sources: [{ label: 'example.test', url: 'https://example.test/items/42' }],
      }],
    }, mapping);

    const result = commitImportBatch(database, {
      source: 'example.test',
      warnings: [],
      entries: [
        {
          externalKey: 'example.test:42',
          title: 'Existing work from refreshed manifest',
          sources: [{ label: 'example.test', url: 'https://example.test/items/42' }],
        },
        {
          externalKey: 'example.test:99',
          title: 'New work',
          sources: [{ label: 'example.test', url: 'https://example.test/items/99' }],
        },
      ],
    }, mapping);

    expect(result.entryCount).toBe(1);
    expect(result.skippedExistingEntryCount).toBe(1);
    expect(result.entries).toEqual([{
      entryId: expect.any(Number),
      title: 'New work',
      externalKey: 'example.test:99',
    }]);
    expect(database.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(2);
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
      authorRatings: [],
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
      authorRatings: [],
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

  it('keeps one placement when a source names the same tag as a series and a character', () => {
    const database = createMigratedMemoryDatabase();
    const basic = createSection(database, { entryType: 'comic', name: 'Basic Information' });
    const series = createFacet(database, { sectionId: basic.id, name: 'Series' });
    const characters = createFacet(database, { sectionId: basic.id, name: 'Characters' });
    const mapping = {
      entryType: 'comic',
      canonicalTagFacetId: basic.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {
        works: { kind: 'tag' as const, facetId: series.id },
        characters: { kind: 'tag' as const, facetId: characters.id },
      },
      ignoredFields: [],
      authorRatings: [],
    };

    // A multi-series collection lists one name as both a series and a character.
    const result = commitImportBatch(database, {
      source: 'hitomi.la',
      warnings: [],
      entries: [{
        externalKey: 'hitomi.la:1',
        title: 'Artist collection',
        fields: { works: ['Goblin Slayer'], characters: ['Goblin Slayer', 'Priestess'] },
        sources: [{ label: 'hitomi.la', url: 'https://hitomi.la/imageset/1.html' }],
      }],
    }, mapping);

    // The import succeeds: the first placement wins and the skipped one is reported.
    expect(result.entryCount).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Goblin Slayer');
    expect(result.warnings[0]).toContain('Series');
    expect(result.warnings[0]).toContain('Characters');
    const detail = getEntryDetail(database, 1);
    expect(detail?.sections[0]?.facets.find((facet) => facet.name === 'Series')?.tags.map((tag) => tag.name))
      .toEqual(['Goblin Slayer']);
    expect(detail?.sections[0]?.facets.find((facet) => facet.name === 'Characters')?.tags.map((tag) => tag.name))
      .toEqual(['Priestess']);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    database.close();
  });

  it('links an imported alias spelling to the author it already resolves to', () => {
    const database = createMigratedMemoryDatabase();
    const section = createSection(database, { entryType: 'comic', name: '分类' });
    const author = createProducer(database, { name: '和泉' });
    const existingWork = createEntry(database, { title: 'Existing work', type: 'comic' });
    linkEntryProducer(database, existingWork.id, author.id);
    upsertTaxonomyAlias(database, {
      vocabulary: 'producer',
      alias: '冷泉',
      canonicalName: '和泉',
    });

    // The review sends no preselected match: the dictionary alone has to be
    // enough for an alias-spelled credit to land on the existing author.
    const result = commitImportBatch(database, {
      source: 'hitomi.la',
      warnings: [],
      entries: [{
        externalKey: 'hitomi.la:1',
        title: 'Work credited to an alias spelling',
        fields: { authors: ['冷泉'] },
        sources: [{ label: 'hitomi.la', url: 'https://hitomi.la/cg/1.html' }],
      }],
    }, {
      entryType: 'comic',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'Source URL',
      externalKeyContentType: 'External Key',
      fieldMappings: {
        authors: { kind: 'producer', createUnmatched: true, existingProducerIds: {} },
      },
      ignoredFields: [],
      authorRatings: [],
    });

    expect(result.createdProducerCount).toBe(0);
    expect(result.producerLinkCount).toBe(1);
    expect(database.prepare('SELECT name FROM producers ORDER BY id').pluck().all())
      .toEqual(['和泉']);
    expect(database.prepare(`
      SELECT producer.name FROM entry_producers AS relation
      JOIN producers AS producer ON producer.id = relation.producer_id
      WHERE relation.entry_id = ?
    `).pluck().all(result.entries[0]!.entryId)).toEqual(['和泉']);
    database.close();
  });

  it('records reviewed Author ratings inside the import transaction and mirrors the dimension', () => {
    const database = createMigratedMemoryDatabase();
    const section = createSection(database, { entryType: 'Comic', name: '分类' });
    createRatingSlot(database, { kind: 'entry', entryType: 'Comic', name: '画风精美' });
    const mapping = {
      entryType: 'Comic',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {
        authors: { kind: 'producer' as const, createUnmatched: true, existingProducerIds: {} },
      },
      ignoredFields: [],
      authorRatings: [
        { name: 'Example Author', slotName: '画风精美', stars: 4 },
        { name: 'Second Author', slotName: '画风精美', stars: 2.5 },
      ],
    };

    const result = commitImportBatch(database, {
      source: 'hitomi.la',
      warnings: [],
      entries: [{
        externalKey: 'hitomi.la:1',
        title: 'Rated work',
        fields: { authors: ['Example Author', 'Second Author'] },
        sources: [{ label: 'hitomi.la', url: 'https://hitomi.la/example-1.html' }],
      }],
    }, mapping);

    expect(result.authorRatingCount).toBe(2);
    // The Author dimension is mirrored from the Gallery's Entry dimension by name.
    const authorSlots = database.prepare(
      "SELECT name FROM rating_slots WHERE subject_kind = 'producer' ORDER BY id",
    ).pluck().all();
    expect(authorSlots).toEqual(['画风精美']);
    expect(database.prepare(
      "SELECT subject_kind, entry_type FROM rating_slots WHERE name = '画风精美' ORDER BY subject_kind",
    ).all()).toEqual([
      { subject_kind: 'entry', entry_type: 'Comic' },
      { subject_kind: 'producer', entry_type: 'Comic' },
    ]);
    expect(listProducerRatings(database, 1)).toEqual([
      { slotId: expect.any(Number), name: '画风精美', stars: 4 },
    ]);
    expect(listProducerRatings(database, 2)).toEqual([
      { slotId: expect.any(Number), name: '画风精美', stars: 2.5 },
    ]);

    // Re-committing the same batch is idempotent: every Entry is skipped, yet
    // the reviewed Author ratings are upserted onto the same slots.
    const repeated = commitImportBatch(database, {
      source: 'hitomi.la',
      warnings: [],
      entries: [{
        externalKey: 'hitomi.la:1',
        title: 'Rated work',
        fields: { authors: ['Example Author', 'Second Author'] },
        sources: [{ label: 'hitomi.la', url: 'https://hitomi.la/example-1.html' }],
      }],
    }, mapping);
    expect(repeated.skippedExistingEntryCount).toBe(1);
    expect(repeated.authorRatingCount).toBe(2);
    expect(database.prepare('SELECT COUNT(*) FROM producer_rating_values').pluck().get()).toBe(2);
    expect(database.prepare('SELECT COUNT(*) FROM rating_slots').pluck().get()).toBe(2);
    expect(listProducerRatings(database, 1)).toEqual([
      { slotId: expect.any(Number), name: '画风精美', stars: 4 },
    ]);
    database.close();
  });

  it('refuses Author ratings for an Author or dimension outside the import and writes nothing', () => {
    const database = createMigratedMemoryDatabase();
    const section = createSection(database, { entryType: 'Comic', name: '分类' });
    createRatingSlot(database, { kind: 'entry', entryType: 'Comic', name: 'Quality' });
    const mapping = {
      entryType: 'Comic',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {
        authors: { kind: 'producer' as const, createUnmatched: true, existingProducerIds: {} },
      },
      ignoredFields: [],
      authorRatings: [{ name: 'Stranger', slotName: 'Quality', stars: 3 }],
    };
    const batch = {
      source: 'hitomi.la',
      warnings: [],
      entries: [{
        externalKey: 'hitomi.la:9',
        title: 'Unrelated work',
        fields: { authors: ['Example Author'] },
        sources: [{ label: 'hitomi.la', url: 'https://hitomi.la/example-9.html' }],
      }],
    };

    expect(() => commitImportBatch(database, batch, mapping)).toThrow(
      /Import author rating "Stranger" is not an Author of this import/u,
    );
    expect(database.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(0);

    expect(() => commitImportBatch(database, batch, {
      ...mapping,
      authorRatings: [{ name: 'Example Author', slotName: 'Nonexistent', stars: 3 }],
    })).toThrow(
      /Import author rating "Nonexistent" is not a rating dimension of Gallery "Comic"/u,
    );
    expect(database.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(0);
    database.close();
  });
});
