import { z } from 'zod';

export const apiIdSchema = z.number().int().positive();
const requiredTextSchema = z.string().trim().min(1);
const nullableTextSchema = z.string().nullable();
const sortOrderSchema = z.number().int();

export const entryRecordSchema = z.strictObject({
  id: apiIdSchema,
  title: requiredTextSchema,
  type: requiredTextSchema,
  coverRef: nullableTextSchema,
  previewRef: nullableTextSchema,
  previewRefs: z.array(requiredTextSchema),
  uploadDate: nullableTextSchema,
  pageCount: z.number().int().nullable(),
});

export const createEntryRequestSchema = z.strictObject({
  title: requiredTextSchema,
  type: requiredTextSchema,
  coverRef: nullableTextSchema.optional(),
  previewRef: nullableTextSchema.optional(),
  uploadDate: nullableTextSchema.optional(),
  pageCount: z.number().int().optional(),
});

export const updateEntryRequestSchema = createEntryRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one entry field is required',
  });

export const entryDetailTagSchema = z.strictObject({
  id: apiIdSchema,
  name: requiredTextSchema,
  normalizedName: requiredTextSchema,
});

export const entryDetailFacetSchema = z.strictObject({
  id: apiIdSchema,
  name: z.string(),
  sortOrder: sortOrderSchema,
  tags: z.array(entryDetailTagSchema),
});

export const entryDetailSectionSchema = z.strictObject({
  id: apiIdSchema,
  name: requiredTextSchema,
  sortOrder: sortOrderSchema,
  facets: z.array(entryDetailFacetSchema),
});

export const entryDetailProducerSchema = z.strictObject({
  id: apiIdSchema,
  name: requiredTextSchema,
  occupation: nullableTextSchema,
  artworkRef: nullableTextSchema,
  content: nullableTextSchema,
});

export const entryDetailContentSchema = z.strictObject({
  id: apiIdSchema,
  contentType: requiredTextSchema,
  content: z.string(),
  sortOrder: sortOrderSchema,
});

export const entryDetailResponseSchema = entryRecordSchema.extend({
  producers: z.array(entryDetailProducerSchema),
  sections: z.array(entryDetailSectionSchema),
  contents: z.array(entryDetailContentSchema),
});

export const createSectionRequestSchema = z.strictObject({
  entryType: requiredTextSchema,
  name: requiredTextSchema,
  sortOrder: sortOrderSchema.optional(),
});

export const createSectionResponseSchema = z.strictObject({
  id: apiIdSchema,
  entryType: requiredTextSchema,
  name: requiredTextSchema,
  sortOrder: sortOrderSchema,
  defaultFacetId: apiIdSchema,
});

export const createFacetRequestSchema = z.strictObject({
  sectionId: apiIdSchema,
  name: requiredTextSchema,
  sortOrder: sortOrderSchema.optional(),
});

export const createFacetResponseSchema = z.strictObject({
  id: apiIdSchema,
  sectionId: apiIdSchema,
  name: requiredTextSchema,
  sortOrder: sortOrderSchema,
});

export const renameTagGroupRequestSchema = z.strictObject({
  name: requiredTextSchema,
});

export const reorderTagGroupRequestSchema = z.strictObject({
  sortOrder: sortOrderSchema,
});

export const layoutResponseSchema = z.array(entryDetailSectionSchema.omit({
  facets: true,
}).extend({
  facets: z.array(entryDetailFacetSchema.omit({ tags: true })),
}));

export const assignEntryTagRequestSchema = z.strictObject({
  facetId: apiIdSchema,
  name: requiredTextSchema,
});

export const entryTagAssignmentSchema = z.strictObject({
  tagId: apiIdSchema,
  name: requiredTextSchema,
  normalizedName: requiredTextSchema,
  facetId: apiIdSchema,
});

export const entryTagUsageSchema = z.strictObject({
  id: apiIdSchema,
  name: requiredTextSchema,
  normalizedName: requiredTextSchema,
  entryCount: z.number().int().positive(),
});

export const moveEntryTagRequestSchema = z.strictObject({
  targetFacetId: apiIdSchema,
});

export const renameEntryTagRequestSchema = z.strictObject({
  name: requiredTextSchema,
});

const idArraySchema = z.array(apiIdSchema);
const uniqueIdArraySchema = idArraySchema.refine(
  (ids) => new Set(ids).size === ids.length,
  { message: 'IDs must be unique' },
);
const queryIdArraySchema = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.trim() === '') {
    return [];
  }
  return value.split(',').map((part) => Number(part.trim()));
}, uniqueIdArraySchema);

export const findEntriesQuerySchema = z.strictObject({
  entryType: requiredTextSchema.optional(),
  includeTagIds: queryIdArraySchema.optional().default([]),
  excludeTagIds: queryIdArraySchema.optional().default([]),
});

export const facetFilterOptionTagSchema = z.strictObject({
  tagId: apiIdSchema,
  name: requiredTextSchema,
});

export const facetFilterAuthorOptionSchema = z.strictObject({
  authorId: apiIdSchema,
  name: requiredTextSchema,
});

export const facetFilterOptionSchema = z.strictObject({
  facetId: apiIdSchema,
  facetName: requiredTextSchema,
  sectionName: requiredTextSchema,
  tags: z.array(facetFilterOptionTagSchema),
});

export const facetFilterOptionsResponseSchema = z.strictObject({
  entryType: requiredTextSchema,
  facets: z.array(facetFilterOptionSchema),
  allTags: z.array(facetFilterOptionTagSchema),
  // Producers linked to Entries of this type (Author filter options).
  authors: z.array(facetFilterAuthorOptionSchema),
});

export const facetFilterConditionSchema = z.strictObject({
  // null = match the tags in ANY facet (the "all tags" row). Within one row
  // the Entry must carry EVERY tag id under the chosen Facet (AND); different
  // rows are also ANDed. Selecting the same tag in two rows is pointless and
  // is rejected by the UI, not by this schema.
  facetId: apiIdSchema.nullable(),
  tagIds: uniqueIdArraySchema,
}).refine((value) => value.tagIds.length > 0, {
  message: 'At least one tag id is required',
});

export const facetFilterEntriesRequestSchema = z.strictObject({
  entryType: requiredTextSchema,
  // Empty when filtering by Author(s) only.
  conditions: z.array(facetFilterConditionSchema).default([]),
  // Author conditions OR within the list and AND with every tag row.
  authorIds: uniqueIdArraySchema.default([]),
});

export const entryTypeQuerySchema = z.strictObject({
  entryType: requiredTextSchema,
});

export const entrySummarySchema = z.strictObject({
  id: apiIdSchema,
  title: requiredTextSchema,
  type: requiredTextSchema,
  coverRef: nullableTextSchema,
  previewRef: nullableTextSchema,
  previewRefs: z.array(requiredTextSchema),
  uploadDate: nullableTextSchema,
  pageCount: z.number().int().nullable(),
});

export const gallerySummarySchema = z.strictObject({
  type: requiredTextSchema,
  entryCount: z.number().int().positive(),
});

export const createEntryContentRequestSchema = z.strictObject({
  contentType: requiredTextSchema,
  content: z.string(),
  sortOrder: sortOrderSchema.optional(),
});

export const updateEntryContentRequestSchema = createEntryContentRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one content field is required',
  });

export const entryContentRecordSchema = entryDetailContentSchema.extend({
  entryId: apiIdSchema,
});

export const reorderEntryContentsRequestSchema = z.strictObject({
  orderedContentIds: uniqueIdArraySchema,
});

export const reorderSectionFacetsRequestSchema = z.strictObject({
  orderedFacetIds: uniqueIdArraySchema,
});

export const producerRecordSchema = z.strictObject({
  id: apiIdSchema,
  name: requiredTextSchema,
  occupation: nullableTextSchema,
  artworkRef: nullableTextSchema,
  content: nullableTextSchema,
});

export const createProducerRequestSchema = z.strictObject({
  name: requiredTextSchema,
  occupation: nullableTextSchema.optional(),
  artworkRef: nullableTextSchema.optional(),
  content: nullableTextSchema.optional(),
});

export const updateProducerRequestSchema = createProducerRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one producer field is required',
  });

export const assignProducerTagRequestSchema = z.strictObject({
  name: requiredTextSchema,
});

export const renameProducerTagRequestSchema = z.strictObject({
  name: requiredTextSchema,
});

export const producerTagAssignmentSchema = z.strictObject({
  tagId: apiIdSchema,
  name: requiredTextSchema,
  normalizedName: requiredTextSchema,
});

export const authorWorkSummarySchema = z.strictObject({
  id: apiIdSchema,
  title: requiredTextSchema,
  type: requiredTextSchema,
  coverRef: nullableTextSchema,
});

export const authorDirectorySchema = z.strictObject({
  id: apiIdSchema,
  producerId: apiIdSchema,
  title: requiredTextSchema,
  description: z.string(),
  sortOrder: sortOrderSchema,
  entries: z.array(authorWorkSummarySchema),
});

export const authorDetailResponseSchema = producerRecordSchema.extend({
  galleryType: nullableTextSchema,
  tags: z.array(producerTagAssignmentSchema),
  looseEntries: z.array(authorWorkSummarySchema),
  directories: z.array(authorDirectorySchema),
});

export const createAuthorDirectoryRequestSchema = z.strictObject({
  title: requiredTextSchema,
  description: z.string().optional(),
  entryIds: uniqueIdArraySchema.optional(),
});

export const updateAuthorDirectoryRequestSchema = z.strictObject({
  title: requiredTextSchema.optional(),
  description: z.string().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one author directory field is required',
});

export const findProducersQuerySchema = z.strictObject({
  ownTagIds: queryIdArraySchema.optional().default([]),
  relatedEntryTagIds: queryIdArraySchema.optional().default([]),
});

export const producerSummarySchema = z.strictObject({
  id: apiIdSchema,
  name: requiredTextSchema,
  covers: z.array(z.string()).default([]),
  // The Author's dominant Gallery (Entry type with the most works); null when
  // the Author has no works. Derived, never stored on the producer row.
  galleryType: nullableTextSchema,
});

export const taxonomyVocabularySchema = z.enum(['entry', 'producer']);

/**
 * Dictionary partition label mirroring the tag taxonomy buckets, e.g.
 * `series`, `characters`, `types`, `tags` (entry vocabulary) or `authors`
 * (producer vocabulary). `''` = unpartitioned (legacy rows).
 */
export const taxonomyPartitionSchema = z.string().trim().max(64).default('');

/** A canonical name may be empty on placeholder rows imported from a dictionary. */
export const taxonomyCanonicalSchema = z.string().trim();

export const taxonomyAliasSchema = z.strictObject({
  id: apiIdSchema,
  vocabulary: taxonomyVocabularySchema,
  partition: taxonomyPartitionSchema,
  alias: requiredTextSchema,
  normalizedAlias: requiredTextSchema,
  canonicalName: taxonomyCanonicalSchema,
  normalizedCanonical: taxonomyCanonicalSchema,
});

export const upsertTaxonomyAliasRequestSchema = z.strictObject({
  vocabulary: taxonomyVocabularySchema,
  partition: z.string().trim().max(64).optional(),
  alias: requiredTextSchema,
  canonicalName: requiredTextSchema,
});

/** Imported dictionary rows may carry an empty canonical name (placeholder). */
export const taxonomyImportAliasSchema = z.strictObject({
  vocabulary: taxonomyVocabularySchema,
  partition: z.string().trim().max(64).optional(),
  alias: requiredTextSchema,
  canonicalName: taxonomyCanonicalSchema,
});
export const importTaxonomyAliasesRequestSchema = z.strictObject({
  aliases: taxonomyImportAliasSchema.array().min(1).max(10_000),
});

export const taxonomyAliasesQuerySchema = z.strictObject({
  vocabulary: taxonomyVocabularySchema.optional(),
});

const mergeWorkCountSchema = z.number().int().nonnegative();

export const producerMergeMemberSchema = z.strictObject({
  id: apiIdSchema,
  name: requiredTextSchema,
  workCount: mergeWorkCountSchema,
});

/**
 * One planned producer merge. `canonicalName` is non-null when a dictionary
 * mapping drives the merge (`bob` -> `鲍勃`); the keeper is renamed to it when
 * `renamed` is true. Null canonicalName = identical-name duplicate merge.
 */
export const producerMergePlanItemSchema = z.strictObject({
  canonicalName: z.string().nullable(),
  keeper: producerMergeMemberSchema,
  others: producerMergeMemberSchema.array(),
  renamed: z.boolean(),
});

export const producerMergePlanResponseSchema = z.strictObject({
  plans: producerMergePlanItemSchema.array(),
});

export const producerMergeExecutionItemSchema = z.strictObject({
  displayName: requiredTextSchema,
  canonicalName: z.string().nullable(),
  keeperId: apiIdSchema,
  keeperName: requiredTextSchema,
  absorbedProducers: mergeWorkCountSchema,
  worksRelinked: mergeWorkCountSchema,
  tagsRelinked: mergeWorkCountSchema,
  directoriesMoved: mergeWorkCountSchema,
  directoriesMerged: mergeWorkCountSchema,
  membershipsMoved: mergeWorkCountSchema,
  membershipsRemoved: mergeWorkCountSchema,
  renamedFrom: z.string().nullable(),
  renamedTo: z.string().nullable(),
});

export const producerMergeTotalsSchema = z.strictObject({
  deletedProducers: mergeWorkCountSchema,
  worksRelinked: mergeWorkCountSchema,
  tagsRelinked: mergeWorkCountSchema,
  directoriesMoved: mergeWorkCountSchema,
  directoriesMerged: mergeWorkCountSchema,
  membershipsMoved: mergeWorkCountSchema,
  membershipsRemoved: mergeWorkCountSchema,
  renamed: mergeWorkCountSchema,
});

export const producerMergeResponseSchema = z.strictObject({
  backupPath: z.string().nullable(),
  plans: producerMergeExecutionItemSchema.array(),
  totals: producerMergeTotalsSchema,
  foreignKeyCheckPass: z.boolean(),
  doctorPass: z.boolean(),
  doctorIssues: z.array(z.string()),
});

export const layoutTemplateApplyResponseSchema = z.strictObject({
  entryType: z.string(),
  entriesAffected: mergeWorkCountSchema,
  tagsRelinked: mergeWorkCountSchema,
  orphansMoved: mergeWorkCountSchema,
  sectionsRecreated: mergeWorkCountSchema,
  backupPath: z.string().nullable(),
  foreignKeyCheckPass: z.boolean(),
  doctorPass: z.boolean(),
  doctorIssues: z.array(z.string()),
});
export type LayoutTemplateApplyResponse = z.infer<typeof layoutTemplateApplyResponseSchema>;

export const tagLayoutApplyResponseSchema = z.strictObject({
  entryType: z.string(),
  // Other entries of the same type whose tag placements changed.
  entriesAffected: mergeWorkCountSchema,
  // Individual tag assignments moved onto the source Entry's Facets.
  tagsMoved: mergeWorkCountSchema,
  // Other entries of the same type that were considered.
  entriesScanned: mergeWorkCountSchema,
  backupPath: z.string().nullable(),
  foreignKeyCheckPass: z.boolean(),
  doctorPass: z.boolean(),
  doctorIssues: z.array(z.string()),
});
export type TagLayoutApplyResponse = z.infer<typeof tagLayoutApplyResponseSchema>;

const pathIdSchema = z.coerce.number().int().positive();
export const entryIdParamsSchema = z.strictObject({ entryId: pathIdSchema });
export const entryTypeParamsSchema = z.strictObject({ entryType: requiredTextSchema });
export const producerIdParamsSchema = z.strictObject({ producerId: pathIdSchema });
export const tagGroupIdParamsSchema = z.strictObject({ groupId: pathIdSchema });
export const facetIdParamsSchema = z.strictObject({ facetId: pathIdSchema });
export const sectionIdParamsSchema = z.strictObject({ sectionId: pathIdSchema });
export const tagIdParamsSchema = z.strictObject({ tagId: pathIdSchema });
export const contentIdParamsSchema = z.strictObject({ contentId: pathIdSchema });
export const authorDirectoryIdParamsSchema = z.strictObject({ directoryId: pathIdSchema });
export const taxonomyAliasIdParamsSchema = z.strictObject({ aliasId: pathIdSchema });

export const entryProducerParamsSchema = z.strictObject({
  entryId: pathIdSchema,
  producerId: pathIdSchema,
});

export const mutationSuccessResponseSchema = z.strictObject({
  ok: z.literal(true),
});

export const apiErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL_ERROR',
]);

export const apiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: requiredTextSchema,
    details: z.unknown().optional(),
  }),
});

export type EntryRecordDto = z.infer<typeof entryRecordSchema>;
export type CreateEntryRequest = z.infer<typeof createEntryRequestSchema>;
export type UpdateEntryRequest = z.infer<typeof updateEntryRequestSchema>;
export type EntryDetailResponse = z.infer<typeof entryDetailResponseSchema>;
export type GallerySummary = z.infer<typeof gallerySummarySchema>;
export type CreateSectionRequest = z.infer<typeof createSectionRequestSchema>;
export type CreateFacetRequest = z.infer<typeof createFacetRequestSchema>;
export type AssignEntryTagRequest = z.infer<typeof assignEntryTagRequestSchema>;
export type RenameEntryTagRequest = z.infer<typeof renameEntryTagRequestSchema>;
export type FindEntriesQuery = z.infer<typeof findEntriesQuerySchema>;
export type EntryTagUsage = z.infer<typeof entryTagUsageSchema>;
export type FacetFilterOptions = z.infer<typeof facetFilterOptionsResponseSchema>;
export type FacetFilterOption = z.infer<typeof facetFilterOptionSchema>;
export type FacetFilterOptionTag = z.infer<typeof facetFilterOptionTagSchema>;
export type FacetFilterAuthorOption = z.infer<typeof facetFilterAuthorOptionSchema>;
export type FacetFilterCondition = z.infer<typeof facetFilterConditionSchema>;
export type CreateEntryContentRequest = z.infer<typeof createEntryContentRequestSchema>;
export type UpdateEntryContentRequest = z.infer<typeof updateEntryContentRequestSchema>;
export type ProducerRecordDto = z.infer<typeof producerRecordSchema>;
export type CreateProducerRequest = z.infer<typeof createProducerRequestSchema>;
export type UpdateProducerRequest = z.infer<typeof updateProducerRequestSchema>;
export type FindProducersQuery = z.infer<typeof findProducersQuerySchema>;
export type AuthorDetailResponse = z.infer<typeof authorDetailResponseSchema>;
export type AuthorDirectoryDto = z.infer<typeof authorDirectorySchema>;
export type CreateAuthorDirectoryRequest = z.infer<typeof createAuthorDirectoryRequestSchema>;
export type UpdateAuthorDirectoryRequest = z.infer<typeof updateAuthorDirectoryRequestSchema>;
export type TaxonomyVocabulary = z.infer<typeof taxonomyVocabularySchema>;
export type TaxonomyAliasDto = z.infer<typeof taxonomyAliasSchema>;
export type UpsertTaxonomyAliasRequest = z.infer<typeof upsertTaxonomyAliasRequestSchema>;
export type TaxonomyImportAlias = z.infer<typeof taxonomyImportAliasSchema>;
export type ImportTaxonomyAliasesRequest = z.infer<typeof importTaxonomyAliasesRequestSchema>;
export type ProducerMergePlanItem = z.infer<typeof producerMergePlanItemSchema>;
export type ProducerMergePlanResponse = z.infer<typeof producerMergePlanResponseSchema>;
export type ProducerMergeExecutionItem = z.infer<typeof producerMergeExecutionItemSchema>;
export type ProducerMergeTotals = z.infer<typeof producerMergeTotalsSchema>;
export type ProducerMergeResponse = z.infer<typeof producerMergeResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
