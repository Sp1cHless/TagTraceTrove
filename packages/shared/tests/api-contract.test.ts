import { describe, expect, it } from 'vitest';
import {
  apiErrorResponseSchema,
  assignEntryTagRequestSchema,
  createEntryContentRequestSchema,
  createEntryRequestSchema,
  createFacetRequestSchema,
  createProducerRequestSchema,
  createSectionRequestSchema,
  entryIdParamsSchema,
  entryDetailResponseSchema,
  findEntriesQuerySchema,
  findProducersQuerySchema,
  moveEntryTagRequestSchema,
  reorderEntryContentsRequestSchema,
  reorderSectionFacetsRequestSchema,
  taxonomyAliasSchema,
  upsertTaxonomyAliasRequestSchema,
  updateEntryRequestSchema,
  updateProducerRequestSchema,
} from '../src/index.js';

describe('entry API contracts', () => {
  it('accepts entry writes and a complete hierarchical detail response', () => {
    expect(createEntryRequestSchema.parse({
      title: ' Arknights: Endfield ',
      type: 'game',
      coverRef: null,
    })).toEqual({
      title: 'Arknights: Endfield',
      type: 'game',
      coverRef: null,
    });

    expect(updateEntryRequestSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(updateEntryRequestSchema.safeParse({}).success).toBe(false);

    const detail = entryDetailResponseSchema.parse({
      id: 1,
      title: 'Arknights: Endfield',
      type: 'game',
      coverRef: null,
      previewRef: null,
      previewRefs: [],
      uploadDate: null,
      pageCount: null,
      producers: [{
        id: 2,
        name: 'Hypergryph',
        occupation: 'Developer',
        artworkRef: null,
        content: null,
      }],
      sections: [{
        id: 3,
        name: '评价',
        sortOrder: 0,
        facets: [{
          id: 4,
          name: '',
          sortOrder: 0,
          tags: [{ id: 5, name: '喜欢', normalizedName: '喜欢' }],
        }],
      }],
      contents: [{ id: 6, contentType: 'short review', content: '不错', sortOrder: 0 }],
      ratings: [{ slotId: 7, name: '画质', stars: 4.5 }, { slotId: 8, name: '剧情', stars: null }],
      usage: { viewCount: 3, likeCount: 5, lastViewedAt: '2026-09-04T10:00:00Z' },
    });

    expect(detail.sections[0]?.facets[0]?.name).toBe('');
  });
});

describe('layout, tag, and content API contracts', () => {
  it('validates mutation boundaries and tag filters', () => {
    expect(createSectionRequestSchema.parse({
      entryType: ' game ',
      name: ' 基本信息 ',
    })).toEqual({ entryType: 'game', name: '基本信息' });
    expect(createFacetRequestSchema.safeParse({ sectionId: 0, name: '角色' }).success).toBe(false);

    expect(assignEntryTagRequestSchema.parse({ facetId: 4, name: ' School   Life ' }))
      .toEqual({ facetId: 4, name: 'School   Life' });
    expect(moveEntryTagRequestSchema.safeParse({ targetFacetId: -1 }).success).toBe(false);

    expect(findEntriesQuerySchema.parse({
      entryType: 'game',
      includeTagIds: [1, 2],
      excludeTagIds: [],
    })).toEqual({ entryType: 'game', includeTagIds: [1, 2], excludeTagIds: [] });
    expect(findEntriesQuerySchema.parse({
      entryType: 'game',
      includeTagIds: '1,2',
      excludeTagIds: '3',
    })).toEqual({ entryType: 'game', includeTagIds: [1, 2], excludeTagIds: [3] });
    expect(findEntriesQuerySchema.parse({ includeTagIds: '1' })).toEqual({
      includeTagIds: [1],
      excludeTagIds: [],
    });

    expect(createEntryContentRequestSchema.parse({
      contentType: ' source url ',
      content: 'https://example.test',
    }).contentType).toBe('source url');
    expect(reorderEntryContentsRequestSchema.safeParse({ orderedContentIds: [1, 1] }).success)
      .toBe(false);
    expect(reorderSectionFacetsRequestSchema.safeParse({ orderedFacetIds: [1, 2] }).success)
      .toBe(true);
    expect(reorderSectionFacetsRequestSchema.safeParse({ orderedFacetIds: [1, 1] }).success)
      .toBe(false);
  });
});

describe('producer and common API contracts', () => {
  it('validates producer writes, searches, path IDs, and errors', () => {
    expect(createProducerRequestSchema.parse({ name: ' Hypergryph ', content: null }))
      .toEqual({ name: 'Hypergryph', content: null });
    expect(updateProducerRequestSchema.safeParse({}).success).toBe(false);

    expect(findProducersQuerySchema.parse({ ownTagIds: [2], relatedEntryTagIds: [5] }))
      .toEqual({ ownTagIds: [2], relatedEntryTagIds: [5] });
    expect(findProducersQuerySchema.parse({ ownTagIds: '2', relatedEntryTagIds: '5,8' }))
      .toEqual({ ownTagIds: [2], relatedEntryTagIds: [5, 8] });
    expect(findProducersQuerySchema.safeParse({ ownTagIds: [2, 2] }).success).toBe(false);

    expect(entryIdParamsSchema.parse({ entryId: '42' })).toEqual({ entryId: 42 });
    expect(entryIdParamsSchema.safeParse({ entryId: '0' }).success).toBe(false);

    expect(apiErrorResponseSchema.parse({
      error: { code: 'NOT_FOUND', message: 'Entry not found' },
    }).error.code).toBe('NOT_FOUND');
  });
});

describe('taxonomy API contracts', () => {
  it('keeps generic Entry and Producer alias vocabularies explicit', () => {
    expect(upsertTaxonomyAliasRequestSchema.parse({
      vocabulary: 'entry',
      alias: ' Bob ',
      canonicalName: ' 鲍勃 ',
    })).toEqual({ vocabulary: 'entry', alias: 'Bob', canonicalName: '鲍勃' });
    expect(upsertTaxonomyAliasRequestSchema.safeParse({
      vocabulary: 'author', alias: 'Bob', canonicalName: '鲍勃',
    }).success).toBe(false);
    expect(taxonomyAliasSchema.parse({
      id: 1,
      vocabulary: 'producer',
      alias: 'Circle',
      normalizedAlias: 'circle',
      canonicalName: '社团',
      normalizedCanonical: '社团',
    }).vocabulary).toBe('producer');
  });
});
