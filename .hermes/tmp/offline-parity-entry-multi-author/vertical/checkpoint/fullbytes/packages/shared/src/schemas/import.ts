import { z } from 'zod';

const httpUrlSchema = z
  .url()
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'Expected an HTTP(S) URL',
  });

export const importTagSchema = z.object({
  name: z.string().trim().min(1),
  sourceField: z.string().trim().min(1).optional(),
});

export const importSourceSchema = z.object({
  label: z.string().trim().min(1).optional(),
  url: httpUrlSchema,
});

export const importEntrySchema = z.object({
  externalKey: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  cover: z.string().trim().min(1).optional(),
  preview: z.string().trim().min(1).optional(),
  previews: z.array(z.string().trim().min(1)).optional(),
  uploadDate: z.string().trim().min(1).optional(),
  pageCount: z.number().int().nonnegative().optional(),
  /**
   * A video's runtime in whole seconds. The export document spells it `duration` and in any of
   * `h:mm:ss` / `mm:ss` / `m:ss` / `ss` / `s`; the site-probe reader parses it there, so this
   * canonical field is already the unit the column stores.
   */
  durationSeconds: z.number().int().nonnegative().optional(),
  tags: z.array(importTagSchema).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  sources: z.array(importSourceSchema).optional(),
  body: z.string().optional(),
});

/**
 * Which site listing a batch was harvested from. The site itself is
 * `importBatch.source`, so an origin only has to name the listing: an artist
 * slug, a collection/album id, a search term. It is optional because a hand-made
 * manifest belongs to no tracked listing, and the crawl cursor it feeds is
 * simply not recorded for such a batch.
 */
export const importBatchOriginSchema = z.strictObject({
  kind: z.enum(['artist', 'folder', 'work', 'search']),
  /** Site-native identifier of the listing, stable across runs. */
  ref: z.string().trim().min(1),
  displayName: z.string().trim().min(1).optional(),
  url: httpUrlSchema.optional(),
});

export const importBatchSchema = z.object({
  source: z.string().trim().min(1),
  origin: importBatchOriginSchema.optional(),
  entries: z.array(importEntrySchema),
  warnings: z.array(z.string()).default([]),
});

const importFieldMappingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('producer'),
    createUnmatched: z.boolean(),
    existingProducerIds: z.record(z.string().trim().min(1), z.number().int().positive()),
  }),
  z.strictObject({
    kind: z.literal('tag'),
    facetId: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal('content'),
    contentType: z.string().trim().min(1),
  }),
]);

/**
 * One Author rating recorded during a review. `name` is the Author name as it
 * appears in an entry's `authors` field; `slotName` is the rating dimension,
 * which mirrors the import Gallery's Entry rating slots by name.
 */
export const importAuthorRatingSchema = z.strictObject({
  name: z.string().trim().min(1),
  slotName: z.string().trim().min(1),
  stars: z.number().min(0.5).max(5).multipleOf(0.5),
});

export const importCommitMappingSchema = z.strictObject({
  entryType: z.string().trim().min(1),
  /**
   * Where this batch's Tags go. `null` means the target Gallery has no Facet that can hold them —
   * the import review's "create your own template" path, which commits the work so its editor can
   * build the structure, and says plainly that the Tags of *this* work are lost doing so.
   */
  canonicalTagFacetId: z.number().int().positive().nullable(),
  sourceContentType: z.string().trim().min(1),
  externalKeyContentType: z.string().trim().min(1),
  bodyContentType: z.string().trim().min(1).optional(),
  fieldMappings: z.record(z.string(), importFieldMappingSchema).default({}),
  /**
   * The Author every work of this batch is credited to, typed on the review
   * page. The commit resolves it through the 'producer' vocabulary like any
   * imported name, so an existing Author (or one of their aliases) is linked
   * instead of duplicated; a name nobody holds creates the Author.
   */
  authorName: z.string().trim().min(1).optional(),
  ignoredFields: z.array(z.string().trim().min(1))
    .refine((fields) => new Set(fields).size === fields.length, {
      message: 'Ignored fields must be unique',
    })
    .default([]),
  authorRatings: z.array(importAuthorRatingSchema)
    .refine((ratings) => new Set(ratings.map((rating) => `${rating.name}\u0000${rating.slotName}`)).size
      === ratings.length, { message: 'An Author and rating dimension pair must be unique' })
    .default([]),
}).refine(
  (mapping) => mapping.ignoredFields.every((field) => !(field in mapping.fieldMappings)),
  { message: 'A field cannot be both mapped and ignored', path: ['ignoredFields'] },
);

export const importPreviewSchema = z.strictObject({
  batch: importBatchSchema,
  source: z.string(),
  entryCount: z.number().int().nonnegative(),
  tagAssignmentCount: z.number().int().nonnegative(),
  uniqueTagCount: z.number().int().nonnegative(),
  entriesMissingCover: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export const importCommitRequestSchema = z.strictObject({
  batch: importBatchSchema,
  mapping: importCommitMappingSchema,
});

export const importCommitResultSchema = z.strictObject({
  entries: z.array(z.strictObject({
    entryId: z.number().int().positive(),
    title: z.string(),
    externalKey: z.string().optional(),
  })),
  entryCount: z.number().int().nonnegative(),
  skippedExistingEntryCount: z.number().int().nonnegative(),
  /** The works those skipped source URLs already belong to, in batch order. */
  existingEntryIds: z.array(z.number().int().positive()),
  /**
   * The batch's works that were already in the library, each paired with the Entry it belongs to,
   * in batch order.
   *
   * `entries` carries what was created; this carries the rest, so a caller that has to reach *every*
   * work of the batch — the media half of an import, above all — can pair each batch work with its
   * Entry without deciding for itself which is which. Deciding that outside is how the two drift
   * apart: the rule reads the clean Source URL *and* the retained site work id, and it lives in one
   * place on purpose.
   */
  skippedExisting: z.array(z.strictObject({
    entryId: z.number().int().positive(),
    title: z.string(),
    externalKey: z.string().optional(),
  })).optional(),
  createdProducerCount: z.number().int().nonnegative(),
  producerLinkCount: z.number().int().nonnegative(),
  tagAssignmentCount: z.number().int().nonnegative(),
  contentCount: z.number().int().nonnegative(),
  authorRatingCount: z.number().int().nonnegative(),
  // Non-fatal source quirks resolved while committing; empty when nothing was
  // skipped (e.g. one tag name arriving for two Facets of the same Entry).
  warnings: z.array(z.string()),
  /**
   * Set only by the server-side import (`/api/imports/commit-path`), which ingests the export's
   * media straight from disk because the browser never holds those files. Counted, and every
   * failure is named in `mediaWarnings` rather than swallowed: an import once produced 53 records
   * whose covers were claimed and 20 of which were not on disk, and the export looked complete.
   */
  mediaStoredCount: z.number().int().nonnegative().optional(),
  /**
   * Pictures the export listed twice: a site that publishes the cover inside the same container as
   * its previews. The first of them *is* the cover, so it is stored once — twice would put the same
   * picture on two layers of the Entry's stack.
   */
  mediaDuplicateCount: z.number().int().nonnegative().optional(),
  /**
   * Pictures an already-known work was *missing* and that this import filled in.
   *
   * A commit has two halves — the transaction, then the files — and only the first is atomic, so a
   * commit cut between them leaves a work in the library with none (or some) of its pictures. The
   * work is then skipped by every later import of the same export, so without this the pictures never
   * arrive; with it, importing the same export again heals the work and says how much it healed.
   */
  mediaRepairedCount: z.number().int().nonnegative().optional(),
  mediaWarnings: z.array(z.string()).optional(),
});

export type ImportTag = z.infer<typeof importTagSchema>;
export type ImportSource = z.infer<typeof importSourceSchema>;
export type ImportEntry = z.infer<typeof importEntrySchema>;
export type ImportBatchOrigin = z.infer<typeof importBatchOriginSchema>;
export type ImportBatch = z.infer<typeof importBatchSchema>;
export type ImportFieldMapping = z.infer<typeof importFieldMappingSchema>;
export type ImportAuthorRating = z.infer<typeof importAuthorRatingSchema>;
export type ImportCommitMapping = z.infer<typeof importCommitMappingSchema>;
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export type ImportCommitResult = z.infer<typeof importCommitResultSchema>;