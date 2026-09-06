import { z } from 'zod';
import { normalizeTag } from '../normalize/tag.js';

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

export const usageInfoSchema = z.strictObject({
  viewCount: z.number().int().min(0),
  likeCount: z.number().int().min(0),
  /** ISO 8601 UTC timestamp of the most recent view; null = never viewed. */
  lastViewedAt: nullableTextSchema,
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

export const ratingSubjectKindSchema = z.enum(['entry', 'producer']);

export const ratingSlotSchema = z.strictObject({
  id: apiIdSchema,
  name: requiredTextSchema,
  sortOrder: sortOrderSchema,
});

/**
 * One displayed rating line: the shared slot name plus the subject's stars.
 * `stars` null = the slot exists on the card but is unrated (never zero).
 */
export const ratingRowSchema = z.strictObject({
  slotId: apiIdSchema,
  name: requiredTextSchema,
  stars: z.number().min(0.5).max(5).multipleOf(0.5).nullable(),
});

export const createRatingSlotRequestSchema = z.strictObject({
  name: requiredTextSchema,
});

export const setRatingRequestSchema = z.strictObject({
  slotId: apiIdSchema,
  stars: z.number().min(0.5).max(5).multipleOf(0.5).nullable(),
});


export const entryDetailResponseSchema = entryRecordSchema.extend({
  producers: z.array(entryDetailProducerSchema),
  sections: z.array(entryDetailSectionSchema),
  contents: z.array(entryDetailContentSchema),
  ratings: z.array(ratingRowSchema),
  usage: usageInfoSchema,
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
  // Shared rating slots of the type (rating filter/sort options).
  ratingSlots: z.array(ratingSlotSchema).default([]),
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

/** Mirrors the Content/Facet reorder contract: every slot exactly once. */
export const reorderRatingSlotsRequestSchema = z.strictObject({
  orderedSlotIds: uniqueIdArraySchema,
});

export const ratingFilterOperatorSchema = z.enum(['eq', 'gt', 'lt', 'unrated']);

export const ratingFilterConditionSchema = z.strictObject({
  slotId: apiIdSchema,
  operator: ratingFilterOperatorSchema,
  stars: z.number().min(0.5).max(5).multipleOf(0.5).nullable(),
}).refine(
  (condition) => (condition.operator === 'unrated' ? condition.stars === null : condition.stars !== null),
  { message: 'unrated takes no stars; every other operator requires stars' },
);

export const ratingSortSchema = z.strictObject({
  slotId: apiIdSchema,
  // Ratings sort from high to low; unrated entries sink to the bottom.
  direction: z.literal('desc'),
});

export const usageFieldSchema = z.enum(['views', 'lastViewed', 'likes']);

export const usageFilterConditionSchema = z.strictObject({
  field: usageFieldSchema,
  operator: z.enum(['eq', 'gt', 'lt']),
  // views: non-negative integer; lastViewed: UTC date (yyyy-mm-dd).
  value: z.union([z.number().int().min(0), z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)]),
}).refine(
  (condition) => (condition.field === 'views' ? typeof condition.value === 'number' : typeof condition.value === 'string'),
  { message: 'views takes a count, lastViewed takes a yyyy-mm-dd date' },
);

export const usageSortSchema = z.strictObject({
  field: usageFieldSchema,
  direction: z.enum(['desc', 'asc']),
});

export const facetFilterEntriesRequestSchema = z.strictObject({
  entryType: requiredTextSchema,
  // Empty when filtering by Author(s) only.
  conditions: z.array(facetFilterConditionSchema).default([]),
  // Author conditions OR within the list and AND with every tag row.
  authorIds: uniqueIdArraySchema.default([]),
  // Rating conditions AND with every tag row and the author list.
  ratingConditions: z.array(ratingFilterConditionSchema).default([]),
  // Optional single-slot rating sort; null keeps the default order.
  ratingSort: ratingSortSchema.nullable().default(null),
  // Usage (view tracking) conditions AND with everything above.
  usageConditions: z.array(usageFilterConditionSchema).default([]),
  // Optional usage sort (view count / last view date); null keeps the default.
  usageSort: usageSortSchema.nullable().default(null),
});

export const entryTypeQuerySchema = z.strictObject({
  entryType: requiredTextSchema.optional(),
});

export const ratingSlotsQuerySchema = z.strictObject({
  entryType: requiredTextSchema,
});

export const collectionKindSchema = z.enum(['entry', 'producer']);

export const collectionEntryMemberSchema = z.strictObject({
  id: apiIdSchema,
  title: requiredTextSchema,
  type: requiredTextSchema,
  coverRef: nullableTextSchema,
  previewRefs: z.array(requiredTextSchema).default([]),
});

export const collectionProducerMemberSchema = z.strictObject({
  id: apiIdSchema,
  name: requiredTextSchema,
  covers: z.array(z.string()).default([]),
});

export interface CollectionRecordDto {
  id: number;
  kind: 'entry' | 'producer';
  title: string;
  description: string;
  nsfw: boolean;
  sortOrder: number;
  children: CollectionRecordDto[];
  entries: Array<{ id: number; title: string; type: string; coverRef: string | null; previewRefs: string[] }>;
  producers: Array<{ id: number; name: string; covers: string[] }>;
}

export const collectionRecordSchema: z.ZodType<CollectionRecordDto> = z.lazy(() => z.strictObject({
  id: apiIdSchema,
  kind: collectionKindSchema,
  title: requiredTextSchema,
  description: z.string(),
  nsfw: z.boolean(),
  sortOrder: sortOrderSchema,
  children: z.array(collectionRecordSchema),
  entries: z.array(collectionEntryMemberSchema),
  producers: z.array(collectionProducerMemberSchema),
}));

export const createCollectionRequestSchema = z.strictObject({
  kind: collectionKindSchema,
  title: requiredTextSchema,
  description: z.string().optional(),
  parentId: apiIdSchema.optional(),
});

export const updateCollectionRequestSchema = z.strictObject({
  title: requiredTextSchema.optional(),
  description: z.string().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one collection field is required',
});

export const reorderCollectionsRequestSchema = z.strictObject({
  orderedCollectionIds: uniqueIdArraySchema,
});

export const searchScopeSchema = z.enum(['entries', 'tags', 'producers']);

export const searchQuerySchema = z.strictObject({
  q: requiredTextSchema,
  entryType: requiredTextSchema.optional(),
});

export const tagSearchQuerySchema = z.strictObject({
  q: requiredTextSchema,
  includeNsfw: z.enum(['true', 'false']).optional(),
});

/** Tag search returns the vocabulary hit plus where it is used. */
export const tagSearchHitSchema = z.strictObject({
  tagId: apiIdSchema,
  name: requiredTextSchema,
  normalizedName: requiredTextSchema,
  entryCount: z.number().int().min(0),
});

export const unassignedTagSuggestionSchema = z.strictObject({
  facetId: apiIdSchema,
  facetName: requiredTextSchema,
  count: apiIdSchema,
});

export const unassignedTagItemSchema = z.strictObject({
  tagId: apiIdSchema,
  tagName: requiredTextSchema,
  // Entries carrying this tag in the unnamed default Facet (the ones to move).
  entryCount: apiIdSchema,
  // Where the OTHER entries of this type keep this tag, if anywhere.
  suggestion: unassignedTagSuggestionSchema.nullable(),
});

export const unassignedTagGroupSchema = z.strictObject({
  entryType: requiredTextSchema,
  facets: z.array(z.strictObject({
    facetId: apiIdSchema,
    facetName: requiredTextSchema,
  })),
  tags: z.array(unassignedTagItemSchema),
});

export const unassignedTagGroupsResponseSchema = z.array(unassignedTagGroupSchema);

export const unassignedTagMoveRequestSchema = z.strictObject({
  entryType: requiredTextSchema,
  tagId: apiIdSchema,
  targetFacetId: apiIdSchema,
});

export const unassignedTagMoveResponseSchema = z.strictObject({
  entryType: requiredTextSchema,
  tagId: apiIdSchema,
  moved: apiIdSchema,
  targetFacetId: apiIdSchema,
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
  viewCount: z.number().int().min(0),
  likeCount: z.number().int().min(0),
  lastViewedAt: nullableTextSchema,
});

export const gallerySummarySchema = z.strictObject({
  type: requiredTextSchema,
  entryCount: z.number().int().positive(),
  // Whole-Gallery SFW/NSFW partition; Authors inherit from their works.
  nsfw: z.boolean(),
});

export const galleryPartitionRequestSchema = z.strictObject({
  nsfw: z.boolean(),
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
  viewCount: z.number().int().min(0),
  likeCount: z.number().int().min(0),
  lastViewedAt: nullableTextSchema,
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
  ratings: z.array(ratingRowSchema),
  usage: usageInfoSchema,
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

export const authorFilterOptionsResponseSchema = z.strictObject({
  authorTags: z.array(facetFilterOptionTagSchema),
  workTags: z.array(facetFilterOptionTagSchema),
});

export const authorFilterOptionsQuerySchema = z.strictObject({
  entryType: requiredTextSchema.optional(),
  includeNsfw: z.enum(['true', 'false']).optional().default('true'),
});

export const producerSummarySchema = z.strictObject({
  id: apiIdSchema,
  name: requiredTextSchema,
  covers: z.array(z.string()).default([]),
  // The Author's dominant Gallery (Entry type with the most works); null when
  // the Author has no works. Derived, never stored on the producer row.
  galleryType: nullableTextSchema,
  // Derived from the Author's works' usage rows (sum / max).
  viewCount: z.number().int().min(0),
  likeCount: z.number().int().min(0),
  lastViewedAt: nullableTextSchema,
  // Derived: any work of the Author sits in an NSFW Gallery.
  nsfw: z.boolean(),
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

/** One author alias group: a display name plus every spelling that maps to it. */
export const authorAliasGroupSchema = z.strictObject({
  canonicalName: requiredTextSchema,
  aliases: z.array(z.strictObject({
    id: apiIdSchema,
    name: requiredTextSchema,
  })),
  producerId: apiIdSchema.nullable(),
  producerName: requiredTextSchema.nullable(),
});

export const authorAliasGroupsResponseSchema = z.strictObject({
  groups: authorAliasGroupSchema.array(),
});

export const saveAuthorAliasGroupRequestSchema = z.strictObject({
  displayName: requiredTextSchema,
  tagNames: requiredTextSchema.array().min(1).max(64),
}).superRefine((value, issue) => {
  // Duplicate spellings must fail loudly (400), not silently drop one name;
  // spellings equal to the display name are harmless and dropped server-side.
  const seen = new Set<string>();
  for (const tagName of value.tagNames) {
    const normalized = normalizeTag(tagName);
    if (seen.has(normalized)) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tagNames'],
        message: `duplicate author tag name: ${tagName}`,
      });
      return;
    }
    seen.add(normalized);
  }
});

export const saveAuthorAliasGroupResponseSchema = z.strictObject({
  group: authorAliasGroupSchema,
  merge: producerMergeResponseSchema,
});

export const templateFileSummarySchema = z.strictObject({
  templatePath: nullableTextSchema,
  tagLayoutPath: nullableTextSchema,
});

// Loose on purpose: these two responses gain fields (e.g. templateFiles) as
// the template feature evolves, and the server and the browser bundle are
// versioned together only as tightly as the user's cache allows. Unknown
// keys must never break an apply that actually succeeded.
export const layoutTemplateApplyResponseSchema = z.object({
  entryType: z.string(),
  entriesAffected: mergeWorkCountSchema,
  tagsRelinked: mergeWorkCountSchema,
  orphansMoved: mergeWorkCountSchema,
  sectionsRecreated: mergeWorkCountSchema,
  backupPath: z.string().nullable(),
  foreignKeyCheckPass: z.boolean(),
  doctorPass: z.boolean(),
  doctorIssues: z.array(z.string()),
  templateFiles: templateFileSummarySchema.nullable().default(null),
});
export type LayoutTemplateApplyResponse = z.infer<typeof layoutTemplateApplyResponseSchema>;

export const tagLayoutApplyResponseSchema = z.object({
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
  templateFiles: templateFileSummarySchema.nullable().default(null),
});
export type TagLayoutApplyResponse = z.infer<typeof tagLayoutApplyResponseSchema>;

const pathIdSchema = z.coerce.number().int().positive();
export const entryIdParamsSchema = z.strictObject({ entryId: pathIdSchema });
export const entryTypeParamsSchema = z.strictObject({ entryType: requiredTextSchema });
export const producerIdParamsSchema = z.strictObject({ producerId: pathIdSchema });
export const collectionIdParamsSchema = z.strictObject({ collectionId: pathIdSchema });
export const numberIdListSchema = z.array(z.number().int());

export const templateSummarySchema = z.strictObject({
  entryType: requiredTextSchema,
  // Real layouts always contain the unnamed default Facet (name '') and tags
  // parked in it — these strings may be empty and the UI hides them.
  sections: z.array(z.strictObject({
    name: z.string(),
    facets: z.array(z.string()),
  })),
  mappings: z.array(z.strictObject({
    tag: requiredTextSchema,
    section: z.string(),
    facet: z.string(),
  })),
  templatePath: requiredTextSchema,
  tagLayoutPath: requiredTextSchema,
  templateExists: z.boolean(),
  tagLayoutExists: z.boolean(),
});
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
export type RatingSubjectKind = z.infer<typeof ratingSubjectKindSchema>;
export type RatingSlotDto = z.infer<typeof ratingSlotSchema>;
export type RatingRow = z.infer<typeof ratingRowSchema>;
export type CreateRatingSlotRequest = z.infer<typeof createRatingSlotRequestSchema>;
export type SetRatingRequest = z.infer<typeof setRatingRequestSchema>;
export type ReorderRatingSlotsRequest = z.infer<typeof reorderRatingSlotsRequestSchema>;
export type GallerySummary = z.infer<typeof gallerySummarySchema>;
export type GalleryPartitionRequest = z.infer<typeof galleryPartitionRequestSchema>;
export type SearchScope = z.infer<typeof searchScopeSchema>;
export type TagSearchHit = z.infer<typeof tagSearchHitSchema>;
export type TemplateSummary = z.infer<typeof templateSummarySchema>;
export type CollectionKind = z.infer<typeof collectionKindSchema>;
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
export type RatingFilterOperator = z.infer<typeof ratingFilterOperatorSchema>;
export type RatingFilterCondition = z.infer<typeof ratingFilterConditionSchema>;
export type RatingSort = z.infer<typeof ratingSortSchema>;
export type UsageInfo = z.infer<typeof usageInfoSchema>;
export type UsageField = z.infer<typeof usageFieldSchema>;
export type UsageFilterCondition = z.infer<typeof usageFilterConditionSchema>;
export type UsageSort = z.infer<typeof usageSortSchema>;
export type UnassignedTagGroups = z.infer<typeof unassignedTagGroupsResponseSchema>;
export type UnassignedTagGroup = z.infer<typeof unassignedTagGroupSchema>;
export type UnassignedTagItem = z.infer<typeof unassignedTagItemSchema>;
export type UnassignedTagMoveRequest = z.infer<typeof unassignedTagMoveRequestSchema>;
export type UnassignedTagMoveResponse = z.infer<typeof unassignedTagMoveResponseSchema>;
export type CreateEntryContentRequest = z.infer<typeof createEntryContentRequestSchema>;
export type UpdateEntryContentRequest = z.infer<typeof updateEntryContentRequestSchema>;
export type ProducerRecordDto = z.infer<typeof producerRecordSchema>;
export type CreateProducerRequest = z.infer<typeof createProducerRequestSchema>;
export type UpdateProducerRequest = z.infer<typeof updateProducerRequestSchema>;
export type FindProducersQuery = z.infer<typeof findProducersQuerySchema>;
export type AuthorFilterOptions = z.infer<typeof authorFilterOptionsResponseSchema>;
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
export type AuthorAliasGroup = z.infer<typeof authorAliasGroupSchema>;
export type AuthorAliasGroupsResponse = z.infer<typeof authorAliasGroupsResponseSchema>;
export type SaveAuthorAliasGroupRequest = z.infer<typeof saveAuthorAliasGroupRequestSchema>;
export type SaveAuthorAliasGroupResponse = z.infer<typeof saveAuthorAliasGroupResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
