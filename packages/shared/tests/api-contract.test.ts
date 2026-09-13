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
  entryPageQueryRequestSchema,
  findEntriesQuerySchema,
  findProducersQuerySchema,
  importCommitMappingSchema,
  importCommitResultSchema,
  moveEntryTagRequestSchema,
  ratingSortSchema,
  reorderEntryContentsRequestSchema,
  reorderSectionFacetsRequestSchema,
  relationSuggestionResponseSchema,
  producerSuggestionQuerySchema,
  tagSuggestionQuerySchema,
  taxonomyAliasSchema,
  upsertTaxonomyAliasRequestSchema,
  updateEntryRequestSchema,
  updateProducerRequestSchema,
  commitSourceMaintenanceResponseSchema,
  createSourceMaintenanceRunRequestSchema,
  sourceCandidateSchema,
  sourceMaintenanceItemPageQuerySchema,
  sourceMaintenanceItemPatchSchema,
  sourceMaintenanceRunRecordSchema,
  sourceStatusPatchSchema,
  sourceLibraryRecordSchema,
} from '../src/index.js';

describe('entry API contracts', () => {
  it('accepts numeric likes filters and rejects date values for count fields', () => {
    const base = { entryType: 'game' };
    expect(entryPageQueryRequestSchema.safeParse({
      ...base,
      usageConditions: [{ field: 'likes', operator: 'gt', value: 2 }],
    }).success).toBe(true);
    expect(entryPageQueryRequestSchema.safeParse({
      ...base,
      usageConditions: [{ field: 'likes', operator: 'gt', value: '2026-09-08' }],
    }).success).toBe(false);
    expect(entryPageQueryRequestSchema.safeParse({
      ...base,
      usageConditions: [{ field: 'views', operator: 'gt', value: '2026-09-08' }],
    }).success).toBe(false);
  });

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
        entryCount: 1,
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

describe('import rating contracts', () => {
  it('carries reviewed Author ratings into the commit and reports their count', () => {
    const mapping = importCommitMappingSchema.parse({
      entryType: 'Comic',
      canonicalTagFacetId: 11,
      sourceContentType: 'Source URL',
      externalKeyContentType: 'External Key',
      authorRatings: [{ name: ' Example Author ', slotName: ' 画风精美 ', stars: 4 }],
    });
    expect(mapping.authorRatings).toEqual([
      { name: 'Example Author', slotName: '画风精美', stars: 4 },
    ]);
    // Imports that review no Author rating stay valid without the field.
    expect(importCommitMappingSchema.parse({
      entryType: 'Comic',
      canonicalTagFacetId: 11,
      sourceContentType: 'Source URL',
      externalKeyContentType: 'External Key',
    }).authorRatings).toEqual([]);

    for (const invalid of [
      { name: '', slotName: '画风精美', stars: 4 },
      { name: 'Example Author', slotName: '', stars: 4 },
      { name: 'Example Author', slotName: '画风精美', stars: 0 },
      { name: 'Example Author', slotName: '画风精美', stars: 4.25 },
    ]) {
      expect(importCommitMappingSchema.safeParse({
        entryType: 'Comic',
        canonicalTagFacetId: 11,
        sourceContentType: 'Source URL',
        externalKeyContentType: 'External Key',
        authorRatings: [invalid],
      }).success).toBe(false);
    }

    const result = importCommitResultSchema.parse({
      entries: [],
      entryCount: 0,
      skippedExistingEntryCount: 0,
      createdProducerCount: 0,
      producerLinkCount: 0,
      tagAssignmentCount: 0,
      contentCount: 0,
      authorRatingCount: 2,
      warnings: [],
    });
    expect(result.authorRatingCount).toBe(2);
  });

  it('defaults the rating sort to the work rating and keeps the Author fallback opt-in', () => {
    expect(ratingSortSchema.parse({ slotId: 7, direction: 'desc' })).toEqual({
      slotId: 7,
      direction: 'desc',
      applyAuthorRating: false,
    });
    expect(ratingSortSchema.parse({
      slotId: 7,
      direction: 'desc',
      applyAuthorRating: true,
    }).applyAuthorRating).toBe(true);
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

describe('relation suggestion API contracts', () => {
  it('normalizes a bounded Tag suggestion query and parses URL query values', () => {
    expect(tagSuggestionQuerySchema.parse({
      vocabulary: 'entry',
      q: '  校园  ',
      limit: '20',
      excludeIds: '1, 2',
      entryType: ' Comic ',
      facetId: '7',
    })).toEqual({
      vocabulary: 'entry',
      q: '校园',
      limit: 20,
      excludeIds: [1, 2],
      entryType: 'Comic',
      facetId: 7,
    });

    for (const invalid of [
      { vocabulary: 'entry', q: '' },
      { vocabulary: 'entry', q: '　' },
      { vocabulary: 'entry', q: 'x'.repeat(201) },
      { vocabulary: 'entry', q: '校', limit: 0 },
      { vocabulary: 'entry', q: '校', limit: 21 },
      { vocabulary: 'entry', q: '校', excludeIds: '1,1' },
      { vocabulary: 'entry', q: '校', excludeIds: Array.from({ length: 101 }, (_, index) => index + 1) },
      { vocabulary: 'author', q: '校' },
    ]) {
      expect(tagSuggestionQuerySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('keeps Producer identity queries separate and validates strict suggestion DTOs', () => {
    expect(producerSuggestionQuerySchema.parse({ q: '  blue box ', excludeIds: '' }))
      .toEqual({ q: 'blue box', limit: 20, excludeIds: [] });

    expect(relationSuggestionResponseSchema.parse([{
      id: 3,
      name: '青色之箱',
      matchedAlias: 'Blue Box',
      sameContextUsageCount: 1,
      totalUsageCount: 4,
    }])).toHaveLength(1);
    expect(relationSuggestionResponseSchema.safeParse([{
      id: 3,
      name: '青色之箱',
      sameContextUsageCount: -1,
      totalUsageCount: 4,
    }]).success).toBe(false);
    expect(relationSuggestionResponseSchema.safeParse([{
      id: 3,
      name: '青色之箱',
      sameContextUsageCount: 1,
      totalUsageCount: 4,
      leaked: true,
    }]).success).toBe(false);
    expect(relationSuggestionResponseSchema.safeParse(Array.from({ length: 21 }, (_, index) => ({
      id: index + 1,
      name: `Suggestion ${index + 1}`,
      sameContextUsageCount: 0,
      totalUsageCount: 0,
    }))).success).toBe(false);
    expect(relationSuggestionResponseSchema.safeParse([
      { id: 3, name: 'First', sameContextUsageCount: 0, totalUsageCount: 0 },
      { id: 3, name: 'Duplicate', sameContextUsageCount: 0, totalUsageCount: 0 },
    ]).success).toBe(false);

    for (const invalid of [
      { q: 'school', excludeIds: '0' },
      { q: 'school', excludeIds: '-1' },
      { q: 'school', excludeIds: 'not-a-number' },
      { q: 'school', excludeIds: '1,01' },
      { q: 'school', unknown: 'field' },
    ]) {
      expect(producerSuggestionQuerySchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('source maintenance API contracts', () => {
  it('accepts a valid status patch and library record with the status overlay', () => {
    expect(sourceStatusPatchSchema.safeParse({ state: 'invalid', note: 'moved' }).success).toBe(true);
    expect(sourceStatusPatchSchema.safeParse({ state: 'deleted' }).success).toBe(false);
    expect(sourceStatusPatchSchema.safeParse({}).success).toBe(false);
    expect(sourceLibraryRecordSchema.safeParse({
      sourceKey: 'known:hitomi',
      sourceName: 'Hitomi',
      hosts: ['hitomi.la'],
      entryCount: 3,
      entryUrlCount: 3,
      state: 'invalid',
      statusNote: null,
    }).success).toBe(true);
    expect(sourceLibraryRecordSchema.safeParse({
      sourceKey: 'known:hitomi',
      sourceName: 'Hitomi',
      hosts: ['hitomi.la'],
      entryCount: 3,
      entryUrlCount: 3,
      state: 'gone',
      statusNote: null,
    }).success).toBe(false);
  });

  it('locks run creation to an origin source, a registered adapter and the invalid checkbox', () => {
    expect(createSourceMaintenanceRunRequestSchema.safeParse({
      originSourceKey: 'known:hitomi',
      adapterKey: 'fake',
      targetHomepage: 'https://fake.test/',
      markOriginInvalid: true,
    }).success).toBe(true);
    expect(createSourceMaintenanceRunRequestSchema.safeParse({
      originSourceKey: 'known:hitomi',
      adapterKey: 'fake',
      markOriginInvalid: 'yes',
    }).success).toBe(false);
    expect(createSourceMaintenanceRunRequestSchema.safeParse({
      originSourceKey: '',
      adapterKey: 'fake',
      markOriginInvalid: false,
    }).success).toBe(false);
  });

  it('keeps candidates explainable with a band and reasons, without trusting free-form evidence', () => {
    const candidate = {
      url: 'https://fake.test/work/1',
      title: 'Blue Box',
      band: 'exact-safe',
      reasons: ['normalized title equals trusted title'],
      adapterEvidence: { query: 'blue box' },
    };
    expect(sourceCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(sourceCandidateSchema.safeParse({ ...candidate, band: 'excellent' }).success).toBe(false);
    expect(sourceCandidateSchema.safeParse({ ...candidate, reasons: [] }).success).toBe(true);
    expect(sourceCandidateSchema.safeParse({ ...candidate, url: 'not a url limit ok' }).success).toBe(true);
    expect(sourceCandidateSchema.safeParse({ ...candidate, extra: true }).success).toBe(false);
  });

  it('derives run records with bounded counts and strict status', () => {
    const run = {
      id: 1,
      originSourceKey: 'known:hitomi',
      adapterKey: 'fake',
      targetOrigin: 'https://fake.test',
      status: 'review',
      markOriginInvalid: false,
      counts: { total: 2, processed: 2, matched: 1, ambiguous: 1, noMatch: 0, errors: 0 },
      createdAt: '2026-09-13T00:00:00Z',
      updatedAt: '2026-09-13T00:00:00Z',
    };
    expect(sourceMaintenanceRunRecordSchema.safeParse(run).success).toBe(true);
    expect(sourceMaintenanceRunRecordSchema.safeParse({ ...run, status: 'queued' }).success).toBe(false);
    expect(sourceMaintenanceRunRecordSchema.safeParse({ ...run, counts: { ...run.counts, errors: -1 } }).success).toBe(false);
  });

  it('bounds item pages and accepts explicit decision patches only', () => {
    expect(sourceMaintenanceItemPageQuerySchema.safeParse({}).success).toBe(true);
    expect(sourceMaintenanceItemPageQuerySchema.safeParse({ page: 2, pageSize: 50, state: 'pending' }).success).toBe(true);
    expect(sourceMaintenanceItemPageQuerySchema.safeParse({ pageSize: 500 }).success).toBe(false);
    expect(sourceMaintenanceItemPageQuerySchema.safeParse({ state: 'weird' }).success).toBe(false);
    expect(sourceMaintenanceItemPatchSchema.safeParse({ decision: 'accept', selectedUrl: 'https://fake.test/work/1' }).success).toBe(true);
    expect(sourceMaintenanceItemPatchSchema.safeParse({ decision: 'maybe' }).success).toBe(false);
    expect(sourceMaintenanceItemPatchSchema.safeParse({ note: 'x' }).success).toBe(false);
  });

  it('shapes the commit response around counts, invalid marking and the backup path', () => {
    expect(commitSourceMaintenanceResponseSchema.safeParse({
      runId: 1,
      status: 'committed',
      createdCount: 2,
      skippedCount: 1,
      unresolvedCount: 3,
      originMarkedInvalid: true,
      backupDir: 'C:/tmp/backups/backup-1',
    }).success).toBe(true);
    expect(commitSourceMaintenanceResponseSchema.safeParse({
      runId: 1,
      status: 'committed',
      createdCount: 0,
      skippedCount: 0,
      unresolvedCount: 0,
      originMarkedInvalid: true,
    }).success).toBe(false);
  });
});
