import { z } from 'zod';

/**
 * Read-only offline sync contracts (plan §24). The snapshot is one atomic
 * generation: header + all read-model tables + counts + checksum, captured in
 * a single SQLite transaction. Media travels as a ref manifest, never as
 * blobs inside the snapshot.
 */

const apiIdSchema = z.number().int().positive();
const syncUidSchema = z.string().uuid();
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

const syncEntryPatchValuesSchema = z.strictObject({
  title: z.string().trim().min(1).optional(),
  uploadDate: z.string().nullable().optional(),
  pageCount: z.number().int().nonnegative().nullable().optional(),
});

const syncReplayBaseShape = {
  opId: z.string().uuid(),
  clientId: z.string().trim().min(1),
  libraryId: z.string().trim().min(1),
  syncEpoch: z.string().trim().min(1),
  entityKind: z.literal('entry'),
  entityUid: z.string().uuid(),
  clientCreatedAt: isoText,
} as const;

const syncEntryUpdateOperationSchema = z.strictObject({
  ...syncReplayBaseShape,
  operationKind: z.literal('entry.update'),
  baseVersion: z.number().int().positive(),
  baseValues: syncEntryPatchValuesSchema,
  payload: syncEntryPatchValuesSchema,
}).superRefine((operation, context) => {
  const payloadKeys = Object.keys(operation.payload).sort();
  const baseKeys = Object.keys(operation.baseValues).sort();
  if (payloadKeys.length === 0) {
    context.addIssue({ code: 'custom', path: ['payload'], message: 'payload must change at least one field' });
  }
  if (payloadKeys.join('\0') !== baseKeys.join('\0')) {
    context.addIssue({
      code: 'custom',
      path: ['baseValues'],
      message: 'baseValues must contain exactly the patched fields',
    });
  }
});

const syncEntryCreatePayloadSchema = z.strictObject({
  title: z.string().trim().min(1),
  type: z.string().trim().min(1),
  uploadDate: z.string().nullable(),
  pageCount: z.number().int().nonnegative().nullable(),
  ratings: z.array(z.strictObject({
    slotId: apiIdSchema,
    stars: z.number().min(0.5).max(5).multipleOf(0.5),
  })).max(100),
  viewLater: z.boolean(),
});

const syncEntryCreateOperationSchema = z.strictObject({
  ...syncReplayBaseShape,
  operationKind: z.literal('entry.create'),
  baseVersion: z.literal(0),
  baseValues: z.strictObject({}),
  payload: syncEntryCreatePayloadSchema,
});

const syncEntryUsageOperationSchema = z.strictObject({
  ...syncReplayBaseShape,
  clientCreatedAt: z.iso.datetime({ offset: true }),
  operationKind: z.literal('entry.usage'),
  baseVersion: z.literal(0),
  baseValues: z.strictObject({}),
  payload: z.strictObject({
    event: z.enum(['view', 'like']),
  }),
});

const syncEntryViewLaterOperationSchema = z.strictObject({
  ...syncReplayBaseShape,
  operationKind: z.literal('entry.view-later.set'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({ present: z.boolean() }),
  payload: z.strictObject({ present: z.boolean() }),
}).superRefine((operation, context) => {
  if (operation.baseValues.present === operation.payload.present) {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'present'],
      message: 'desired membership must differ from the base membership',
    });
  }
});

const syncRatingValueSchema = z.number().min(0.5).max(5).multipleOf(0.5).nullable();

const syncEntryRatingOperationSchema = z.strictObject({
  ...syncReplayBaseShape,
  operationKind: z.literal('entry.rating.set'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({
    slotUid: syncUidSchema,
    stars: syncRatingValueSchema,
  }),
  payload: z.strictObject({
    slotUid: syncUidSchema,
    stars: syncRatingValueSchema,
  }),
}).superRefine((operation, context) => {
  if (operation.baseValues.slotUid !== operation.payload.slotUid) {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'slotUid'],
      message: 'rating slot cannot change within one desired-state operation',
    });
  }
  if (operation.baseValues.stars === operation.payload.stars) {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'stars'],
      message: 'desired rating must differ from the base rating',
    });
  }
});

export const syncReplayOperationSchema = z.union([
  syncEntryUpdateOperationSchema,
  syncEntryCreateOperationSchema,
  syncEntryUsageOperationSchema,
  syncEntryViewLaterOperationSchema,
  syncEntryRatingOperationSchema,
]);

export const syncReplayResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    opId: z.string().uuid(),
    status: z.literal('applied'),
    resourceVersion: z.number().int().positive(),
    serverSeq: z.number().int().nonnegative(),
    entityId: apiIdSchema.optional(),
  }),
  z.strictObject({
    opId: z.string().uuid(),
    status: z.literal('conflict'),
    currentVersion: z.number().int().nonnegative(),
    currentValues: z.union([
      syncEntryPatchValuesSchema,
      z.strictObject({ present: z.boolean() }),
      z.strictObject({ slotUid: syncUidSchema, stars: syncRatingValueSchema }),
    ]),
    serverSeq: z.number().int().nonnegative(),
  }),
  z.strictObject({
    opId: z.string().uuid(),
    status: z.literal('failed'),
    errorCode: z.enum([
      'operation-id-collision',
      'entity-not-found',
      'entity-already-exists',
      'invalid-create',
      'invalid-rating',
    ]),
    detail: z.string(),
  }),
  z.strictObject({
    opId: z.string().uuid(),
    status: z.literal('resnapshot-required'),
    reason: z.enum(['library-mismatch', 'epoch-mismatch']),
  }),
]);

export type SyncReplayOperation = z.infer<typeof syncReplayOperationSchema>;
export type SyncReplayResult = z.infer<typeof syncReplayResultSchema>;

export const syncMediaUploadMetadataSchema = z.strictObject({
  libraryId: z.string().uuid(),
  syncEpoch: z.string().trim().min(1),
  entryUid: z.string().uuid(),
  kind: z.enum(['cover', 'preview']),
  ordinal: z.literal(0),
  mimeType: z.enum(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']),
  byteLength: z.number().int().positive().max(20 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const syncMediaUploadResultSchema = z.strictObject({
  uploadId: z.string().uuid(),
  status: z.literal('applied'),
  entityId: apiIdSchema,
  relativeRef: z.string().trim().min(1),
  resourceVersion: z.number().int().positive(),
  serverSeq: z.number().int().nonnegative(),
});

export type SyncMediaUploadMetadata = z.infer<typeof syncMediaUploadMetadataSchema>;
export type SyncMediaUploadResult = z.infer<typeof syncMediaUploadResultSchema>;

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
  /** Absent only on persisted snapshot-format v1 generations. */
  changeSeq: z.number().int().nonnegative().optional(),
  generatedAt: isoText,
  sqliteSchemaVersion: z.number().int().positive(),
  snapshotFormatVersion: z.number().int().positive(),
  counts: syncSnapshotCountsSchema,
  checksum: z.string().trim().min(1),
});

export const syncEntryRowSchema = z.strictObject({
  id: apiIdSchema,
  /** Added in snapshot format v2; optional keeps existing v1 generations readable. */
  syncUid: z.string().uuid().optional(),
  syncVersion: z.number().int().positive().optional(),
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
  /** Added in snapshot format v2; optional keeps existing v1 generations readable. */
  syncUid: z.string().uuid().optional(),
  syncVersion: z.number().int().positive().optional(),
  contentType: z.string(),
  content: z.string(),
  sortOrder: z.number().int(),
});

export const syncRatingSlotRowSchema = z.strictObject({
  id: apiIdSchema,
  /** Optional only so installed schema-v2 snapshots from before migration 24 remain readable. */
  syncUid: syncUidSchema.optional(),
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
  /** Added with the Gallery scope; absent rows read as unfiled. */
  galleryType: z.string().nullable().optional(),
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
