import { z } from 'zod';

/**
 * Read-only offline sync contracts (plan §24). The snapshot is one atomic
 * generation: header + all read-model tables + counts + checksum, captured in
 * a single SQLite transaction. Media travels as a ref manifest, never as
 * blobs inside the snapshot.
 */

const apiIdSchema = z.number().int().positive();
const isoText = z.string().trim().min(1);

export const syncCapabilitiesSchema = z.strictObject({
  libraryId: z.string().trim().min(1),
  syncEpoch: z.string().trim().min(1),
  sqliteSchemaVersion: z.number().int().positive(),
  snapshotFormatVersion: z.number().int().positive(),
  syncProtocolVersion: z.number().int().positive(),
  serverBuild: z.string().trim().min(1),
  featureFlags: z.record(z.string(), z.boolean()),
});

export const syncSnapshotCountsSchema = z.strictObject({
  entries: z.number().int().nonnegative(),
  producers: z.number().int().nonnegative(),
  entryContents: z.number().int().nonnegative(),
  entryTags: z.number().int().nonnegative(),
  collections: z.number().int().nonnegative(),
});

export const syncSnapshotHeaderSchema = z.strictObject({
  libraryId: z.string().trim().min(1),
  syncEpoch: z.string().trim().min(1),
  snapshotSeq: z.number().int().nonnegative(),
  generatedAt: isoText,
  sqliteSchemaVersion: z.number().int().positive(),
  snapshotFormatVersion: z.number().int().positive(),
  counts: syncSnapshotCountsSchema,
  checksum: z.string().trim().min(1),
});

export const syncEntryRowSchema = z.strictObject({
  id: apiIdSchema,
  title: z.string(),
  type: z.string(),
  coverRef: z.string().nullable(),
  previewRef: z.string().nullable(),
  previewRefs: z.array(z.string()),
  pageCount: z.number().int().nullable(),
  uploadDate: z.string().nullable(),
  createdAt: isoText,
  updatedAt: isoText,
});

export const syncProducerRowSchema = z.strictObject({
  id: apiIdSchema,
  name: z.string(),
  occupation: z.string().nullable(),
  artworkRef: z.string().nullable(),
  content: z.string().nullable(),
});

export const syncEntryProducerRowSchema = z.strictObject({
  entryId: apiIdSchema,
  producerId: apiIdSchema,
});

export const syncTagRowSchema = z.strictObject({
  id: apiIdSchema,
  name: z.string(),
  normalizedName: z.string(),
});

export const syncTagGroupRowSchema = z.strictObject({
  id: apiIdSchema,
  entryType: z.string(),
  name: z.string(),
  groupKind: z.enum(['section', 'facet']),
  parentId: z.number().int().nullable(),
  sortOrder: z.number().int(),
});

export const syncEntryTagRowSchema = z.strictObject({
  entryId: apiIdSchema,
  tagId: apiIdSchema,
  facetId: apiIdSchema,
});

export const syncProducerTagRowSchema = z.strictObject({
  id: apiIdSchema,
  name: z.string(),
  normalizedName: z.string(),
});

export const syncProducerTagAssignmentRowSchema = z.strictObject({
  producerId: apiIdSchema,
  tagId: apiIdSchema,
});

export const syncTaxonomyAliasRowSchema = z.strictObject({
  id: apiIdSchema,
  vocabulary: z.enum(['entry', 'producer']),
  partition: z.string(),
  aliasName: z.string(),
  normalizedAlias: z.string(),
  canonicalName: z.string(),
  normalizedCanonical: z.string(),
});

export const syncEntryContentRowSchema = z.strictObject({
  id: apiIdSchema,
  entryId: apiIdSchema,
  contentType: z.string(),
  content: z.string(),
  sortOrder: z.number().int(),
});

export const syncRatingSlotRowSchema = z.strictObject({
  id: apiIdSchema,
  subjectKind: z.enum(['entry', 'producer']),
  entryType: z.string(),
  name: z.string(),
  sortOrder: z.number().int(),
});

export const syncEntryRatingValueRowSchema = z.strictObject({
  slotId: apiIdSchema,
  entryId: apiIdSchema,
  stars: z.number().nullable(),
});

export const syncProducerRatingValueRowSchema = z.strictObject({
  slotId: apiIdSchema,
  producerId: apiIdSchema,
  stars: z.number().nullable(),
});

export const syncCollectionRowSchema = z.strictObject({
  id: apiIdSchema,
  kind: z.enum(['entry', 'producer']),
  title: z.string(),
  description: z.string(),
  nsfw: z.boolean(),
  parentId: z.number().int().nullable(),
  sortOrder: z.number().int(),
});

export const syncCollectionMemberRowSchema = z.union([
  z.strictObject({
    collectionId: apiIdSchema,
    entryId: apiIdSchema,
    position: z.number().int().nonnegative(),
  }),
  z.strictObject({
    collectionId: apiIdSchema,
    producerId: apiIdSchema,
    position: z.number().int().nonnegative(),
  }),
]);

export const syncAuthorDirectoryRowSchema = z.strictObject({
  id: apiIdSchema,
  producerId: apiIdSchema,
  title: z.string(),
  description: z.string(),
  sortOrder: z.number().int(),
});

export const syncAuthorDirectoryEntryRowSchema = z.strictObject({
  directoryId: apiIdSchema,
  producerId: apiIdSchema,
  entryId: apiIdSchema,
  sortOrder: z.number().int(),
});

export const syncUsageRowSchema = z.strictObject({
  entryId: apiIdSchema,
  viewCount: z.number().int().nonnegative(),
  likeCount: z.number().int().nonnegative(),
  lastViewedAt: z.string().nullable(),
});

export const syncViewLaterRowSchema = z.strictObject({
  subjectId: apiIdSchema,
  position: z.number().int().nonnegative(),
});

export const syncGallerySettingRowSchema = z.strictObject({
  entryType: z.string(),
  nsfw: z.boolean(),
});

export const syncSnapshotPayloadSchema = z.strictObject({
  entries: z.array(syncEntryRowSchema),
  producers: z.array(syncProducerRowSchema),
  entryProducers: z.array(syncEntryProducerRowSchema),
  tags: z.array(syncTagRowSchema),
  tagGroups: z.array(syncTagGroupRowSchema),
  entryTags: z.array(syncEntryTagRowSchema),
  producerTags: z.array(syncProducerTagRowSchema),
  producerTagAssignments: z.array(syncProducerTagAssignmentRowSchema),
  taxonomyAliases: z.array(syncTaxonomyAliasRowSchema).optional(),
  entryContents: z.array(syncEntryContentRowSchema),
  ratingSlots: z.array(syncRatingSlotRowSchema),
  entryRatingValues: z.array(syncEntryRatingValueRowSchema),
  producerRatingValues: z.array(syncProducerRatingValueRowSchema),
  collections: z.array(syncCollectionRowSchema),
  collectionMembers: z.array(syncCollectionMemberRowSchema),
  authorDirectories: z.array(syncAuthorDirectoryRowSchema),
  authorDirectoryEntries: z.array(syncAuthorDirectoryEntryRowSchema),
  entryUsage: z.array(syncUsageRowSchema),
  viewLaterEntries: z.array(syncViewLaterRowSchema),
  viewLaterProducers: z.array(syncViewLaterRowSchema),
  gallerySettings: z.array(syncGallerySettingRowSchema),
  /** Media manifest: asset refs referenced by the rows above (no blobs). */
  mediaRefs: z.array(z.string()),
});

export const syncSnapshotSchema = z.strictObject({
  header: syncSnapshotHeaderSchema,
  payload: syncSnapshotPayloadSchema,
});

export type SyncCapabilities = z.infer<typeof syncCapabilitiesSchema>;
export type SyncSnapshot = z.infer<typeof syncSnapshotSchema>;
export type SyncSnapshotHeader = z.infer<typeof syncSnapshotHeaderSchema>;
export type SyncSnapshotPayload = z.infer<typeof syncSnapshotPayloadSchema>;
