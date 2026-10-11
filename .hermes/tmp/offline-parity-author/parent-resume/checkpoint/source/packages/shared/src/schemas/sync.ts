import { z } from 'zod';
import { normalizeTag } from '../normalize/tag.js';
import { ratingSubjectKindSchema } from './api.js';

/**
 * Read-only offline sync contracts (plan §24). The snapshot is one atomic
 * generation: header + all read-model tables + counts + checksum, captured in
 * a single SQLite transaction. Media travels as a ref manifest, never as
 * blobs inside the snapshot.
 */

const apiIdSchema = z.number().int().positive();
const syncUidSchema = z.string().uuid();
const isoText = z.string().trim().min(1);

const feedIdentitySchema = z.strictObject({
  libraryId: z.string().min(1),
  syncEpoch: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  clientId: z.string().trim().min(1).max(200),
});

export const syncChangesQuerySchema = feedIdentitySchema.extend({
  afterSeq: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(200),
});
export const syncAckRequestSchema = feedIdentitySchema.extend({
  cursorSeq: z.number().int().nonnegative(),
});
export const syncChangesResponseSchema = z.strictObject({
  changes: z.array(z.strictObject({
    seq: z.number().int().positive(),
    entityKind: z.string(),
    entityUid: z.string(),
    changeKind: z.enum(['create', 'update', 'delete']),
    resourceVersion: z.number().int().positive(),
    record: z.unknown().nullable(),
  })).max(200),
  nextSeq: z.number().int().nonnegative(),
  highWaterSeq: z.number().int().nonnegative(),
  ackSeq: z.number().int().nonnegative(),
});
export const syncAckResponseSchema = z.strictObject({ ackSeq: z.number().int().nonnegative() });
export type SyncChangesQuery = z.infer<typeof syncChangesQuerySchema>;
export type SyncAckRequest = z.infer<typeof syncAckRequestSchema>;

export const syncCapabilitiesSchema = z.strictObject({
  libraryId: z.string().trim().min(1),
  syncEpoch: z.string().trim().min(1),
  sqliteSchemaVersion: z.number().int().positive(),
  snapshotFormatVersion: z.number().int().positive(),
  syncProtocolVersion: z.number().int().positive(),
  serverBuild: z.string().trim().min(1),
  featureFlags: z.record(z.string(), z.boolean()),
});

/** Bounded online identity preflight; it is not a downloaded library snapshot. */
export const syncEntryIdentitySchema = z.strictObject({
  libraryId: z.string().trim().min(1),
  syncEpoch: z.string().trim().min(1),
  id: z.number().int().positive(),
  syncUid: z.string().uuid(),
  syncVersion: z.number().int().positive(),
});
export type SyncEntryIdentity = z.infer<typeof syncEntryIdentitySchema>;

const syncEntryPatchValuesSchema = z.strictObject({
  title: z.string().trim().min(1).optional(),
  uploadDate: z.string().nullable().optional(),
  pageCount: z.number().int().nonnegative().nullable().optional(),
  durationSeconds: z.number().int().nonnegative().nullable().optional(),
});

const syncProducerPatchValuesSchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
  occupation: z.string().nullable().optional(),
  artworkRef: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  galleryAnchor: z.string().trim().min(1).nullable().optional(),
});

const syncReplayBaseShape = {
  opId: z.string().uuid(),
  clientId: z.string().trim().min(1),
  libraryId: z.string().trim().min(1),
  syncEpoch: z.string().trim().min(1),
  entityUid: z.string().uuid(),
  clientCreatedAt: isoText,
} as const;

const syncEntryReplayBaseShape = {
  ...syncReplayBaseShape,
  entityKind: z.literal('entry'),
} as const;

const syncEntryTagReplayBaseShape = {
  ...syncReplayBaseShape,
  entityKind: z.literal('entry_tag'),
} as const;

const syncEntryFacetReplayBaseShape = {
  ...syncReplayBaseShape,
  entityKind: z.literal('entry_facet'),
} as const;

const syncProducerCreateOperationSchema = z.strictObject({
  ...syncReplayBaseShape, entityKind: z.literal('producer'), operationKind: z.literal('producer.create'),
  baseVersion: z.literal(0), baseValues: z.strictObject({}),
  payload: z.strictObject({ name: z.string().trim().min(1), occupation: z.string().nullable(),
    artworkRef: z.string().nullable(), content: z.string().nullable(), directorySetUid: syncUidSchema.optional() }),
});

const syncProducerDeleteOperationSchema = z.strictObject({
  ...syncReplayBaseShape, entityKind:z.literal('producer'), operationKind:z.literal('producer.delete'),
  baseVersion:z.number().int().positive(),baseValues:z.strictObject({}),payload:z.strictObject({}),
});

const syncProducerReplayBaseShape = {
  ...syncReplayBaseShape,
  entityKind: z.literal('producer'),
} as const;

const syncCollectionReplayBaseShape = {
  ...syncReplayBaseShape,
  entityKind: z.literal('collection'),
} as const;

const syncRatingLayoutReplayBaseShape = {
  ...syncReplayBaseShape,
  entityKind: z.literal('rating_layout'),
} as const;

const syncAuthorDirectorySetReplayBaseShape = {
  ...syncReplayBaseShape,
  entityKind: z.literal('author_directory_set'),
} as const;

const syncEntryDeleteOperationSchema = z.strictObject({
  ...syncEntryReplayBaseShape,
  operationKind: z.literal('entry.delete'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({}),
  payload: z.strictObject({}),
});

const syncEntryUpdateOperationSchema = z.strictObject({
  ...syncEntryReplayBaseShape,
  operationKind: z.literal('entry.update'),
  baseVersion: z.number().int().nonnegative(),
  baseValues: syncEntryPatchValuesSchema,
  payload: syncEntryPatchValuesSchema.extend({ parentCreateOpId: syncUidSchema.optional() }),
}).superRefine((operation, context) => {
  if ((operation.baseVersion === 0) !== (operation.payload.parentCreateOpId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['payload', 'parentCreateOpId'], message: 'Pending Entry metadata requires zero baseVersion and a parent create UUID; legacy versions must not have a parent' });
  }
  const payloadKeys = Object.keys(operation.payload).filter(key => key !== 'parentCreateOpId').sort();
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

const syncEntryCreateRatingSchema = z.strictObject({
  slotId: apiIdSchema.optional(),
  slotUid: syncUidSchema.optional(),
  stars: z.number().min(0.5).max(5).multipleOf(0.5),
}).superRefine((rating, context) => {
  if (rating.slotId === undefined && rating.slotUid === undefined) {
    context.addIssue({ code: 'custom', path: ['slotUid'], message: 'Entry create ratings require a stable slot identity' });
  }
  if (rating.slotId !== undefined && rating.slotUid !== undefined) {
    context.addIssue({ code: 'custom', path: ['slotId'], message: 'Specify either slotId or slotUid, not both' });
  }
});

const syncEntryCreatePayloadSchema = z.strictObject({
  title: z.string().trim().min(1),
  type: z.string().trim().min(1),
  uploadDate: z.string().nullable(),
  pageCount: z.number().int().nonnegative().nullable(),
  durationSeconds: z.number().int().nonnegative().nullable().optional(),
  ratings: z.array(syncEntryCreateRatingSchema).max(100),
  viewLater: z.boolean(),
  /** Omitted by older clients; the original operation remains immutable after enqueue. */
  contents: z.array(z.strictObject({
    syncUid: syncUidSchema,
    contentType: z.string().trim().min(1),
    content: z.string().trim().min(1),
    sortOrder: z.number().int().nonnegative(),
  })).max(100).optional(),
});

const syncEntryCreateOperationSchema = z.strictObject({
  ...syncEntryReplayBaseShape,
  operationKind: z.literal('entry.create'),
  baseVersion: z.literal(0),
  baseValues: z.strictObject({}),
  payload: syncEntryCreatePayloadSchema,
}).superRefine((operation, context) => {
  const contentUids = new Set<string>();
  operation.payload.contents?.forEach((content, index) => {
    if (contentUids.has(content.syncUid)) {
      context.addIssue({ code: 'custom', path: ['payload', 'contents', index, 'syncUid'], message: 'Content UUID must be unique within the create operation' });
    }
    contentUids.add(content.syncUid);
  });
  const seen = new Set<string>();
  operation.payload.ratings.forEach((rating, index) => {
    const identity = rating.slotUid ?? `id:${rating.slotId}`;
    if (seen.has(identity)) {
      context.addIssue({ code: 'custom', path: ['payload', 'ratings', index], message: 'A rating slot may only appear once' });
    }
    seen.add(identity);
  });
});

const syncEntryUsageOperationSchema = z.strictObject({
  ...syncEntryReplayBaseShape,
  clientCreatedAt: z.iso.datetime({ offset: true }),
  operationKind: z.literal('entry.usage'),
  baseVersion: z.literal(0),
  baseValues: z.strictObject({}),
  payload: z.strictObject({
    event: z.enum(['view', 'like']),
  }),
});

const syncEntryViewLaterOperationSchema = z.strictObject({
  ...syncEntryReplayBaseShape,
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
  ...syncEntryReplayBaseShape,
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

const syncEntryAuthorsOperationSchema = z.strictObject({
  ...syncEntryReplayBaseShape,
  operationKind: z.literal('entry.authors.set'),
  baseVersion: z.number().int().nonnegative(),
  baseValues: z.strictObject({ producerUids: z.array(syncUidSchema).max(20_000) }),
  payload: z.strictObject({ producerUids: z.array(syncUidSchema).max(20_000), parentCreateOpId: z.string().uuid().optional(), producerCreates: z.array(z.strictObject({ producerUid: syncUidSchema, createOpId: syncUidSchema })).min(1).max(20_000).optional() }),
}).superRefine((operation, context) => {
  if ((operation.baseVersion === 0) !== (operation.payload.parentCreateOpId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['payload', 'parentCreateOpId'], message: 'Pending Entry Authors require zero baseVersion and a parent create UUID; legacy versions must not have a parent' });
  }
  const dependencies = operation.payload.producerCreates ?? [];
  if (new Set(dependencies.map(row => row.producerUid.toLowerCase())).size !== dependencies.length || dependencies.some(row => row.createOpId.toLowerCase() === operation.opId.toLowerCase() || ![...operation.baseValues.producerUids, ...operation.payload.producerUids].map(uid => uid.toLowerCase()).includes(row.producerUid.toLowerCase()))) {
    context.addIssue({code: 'custom', path: ['payload', 'producerCreates'], message: 'Invalid Producer creation dependencies'});
  }
  for (const [field, producerUids] of [
    ['baseValues', operation.baseValues.producerUids],
    ['payload', operation.payload.producerUids],
  ] as const) {
    const seen = new Set<string>();
    producerUids.forEach((uid, index) => {
      if (seen.has(uid.toLowerCase())) {
        context.addIssue({ code: 'custom', path: [field, 'producerUids', index], message: 'Author identity may only appear once' });
      }
      seen.add(uid.toLowerCase());
    });
  }
  const base = operation.baseValues.producerUids.map(uid => uid.toLowerCase()).sort();
  const desired = operation.payload.producerUids.map(uid => uid.toLowerCase()).sort();
  if (JSON.stringify(base) === JSON.stringify(desired)) {
    context.addIssue({ code: 'custom', path: ['payload', 'producerUids'], message: 'Desired Author links must differ from their base' });
  }
});

const syncEntryAuthorCreateAndLinkOperationSchema = z.strictObject({
  ...syncEntryReplayBaseShape,
  operationKind: z.literal('entry.author.create-and-link'),
  baseVersion: z.number().int().nonnegative(),
  baseValues: z.strictObject({ producerUids: z.array(syncUidSchema).max(20_000) }),
  payload: z.strictObject({
    producerUid: syncUidSchema,
    name: z.string().trim().min(1).max(500),
    parentCreateOpId: z.string().uuid().optional(),
  }),
}).superRefine((operation, context) => {
  if ((operation.baseVersion === 0) !== (operation.payload.parentCreateOpId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['payload', 'parentCreateOpId'], message: 'Pending Entry Author creation requires zero baseVersion and a parent create UUID; legacy versions must not have a parent' });
  }
  const values = operation.baseValues.producerUids.map(uid => uid.toLowerCase());
  if (new Set(values).size !== values.length || values.includes(operation.payload.producerUid.toLowerCase())) {
    context.addIssue({ code: 'custom', path: ['baseValues', 'producerUids'], message: 'New Author UID must not already be linked or repeated' });
  }
});

const syncEntryTagValueSchema = z.strictObject({
  name: z.string().trim().min(1).max(500),
  /** Present only while the Tag depends on a queued stable creation identity. */
  tagUid: syncUidSchema.optional(),
  facetId: apiIdSchema.optional(),
  /** Present only while the Facet depends on a queued stable creation identity. */
  facetUid: syncUidSchema.optional(),
}).superRefine((tag, context) => {
  if ((tag.facetId === undefined) === (tag.facetUid === undefined)) {
    context.addIssue({
      code: 'custom', path: ['facetUid'],
      message: 'Specify exactly one numeric or stable Facet identity',
    });
  }
});
const syncEntryTagListSchema = z.array(syncEntryTagValueSchema).max(20_000);
const syncEntryTagCreateDependencySchema = z.strictObject({
  tagUid: syncUidSchema,
  createOpId: syncUidSchema,
});
const syncEntryFacetCreateDependencySchema = z.strictObject({
  facetUid: syncUidSchema,
  createOpId: syncUidSchema,
});

const syncEntryTagCreateOperationSchema = z.strictObject({
  ...syncEntryTagReplayBaseShape,
  operationKind: z.literal('entry.tag.create'),
  baseVersion: z.literal(0),
  baseValues: z.strictObject({}),
  payload: z.strictObject({ name: z.string().trim().min(1).max(500) }),
});

const syncEntryFacetCreateOperationSchema = z.strictObject({
  ...syncEntryFacetReplayBaseShape,
  operationKind: z.literal('entry.facet.create'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({
    entryType: z.string().trim().min(1).max(500),
    sectionUid: syncUidSchema,
  }),
  payload: z.strictObject({
    entryType: z.string().trim().min(1).max(500),
    sectionUid: syncUidSchema,
    name: z.string().trim().min(1).max(500),
  }),
}).superRefine((operation, context) => {
  if (operation.baseValues.entryType !== operation.payload.entryType
    || operation.baseValues.sectionUid.toLowerCase() !== operation.payload.sectionUid.toLowerCase()) {
    context.addIssue({
      code: 'custom', path: ['payload'],
      message: 'Facet creation cannot change its captured Gallery or Section identity',
    });
  }
  if (operation.entityUid.toLowerCase() === operation.payload.sectionUid.toLowerCase()) {
    context.addIssue({ code: 'custom', path: ['entityUid'], message: 'Facet and Section identities must differ' });
  }
});

const syncEntryTagsOperationSchema = z.strictObject({
  ...syncEntryReplayBaseShape,
  operationKind: z.literal('entry.tags.set'),
  baseVersion: z.number().int().nonnegative(),
  baseValues: z.strictObject({ tags: syncEntryTagListSchema }),
  payload: z.strictObject({
    tags: syncEntryTagListSchema,
    parentCreateOpId: z.string().uuid().optional(),
    tagCreates: z.array(syncEntryTagCreateDependencySchema).min(1).max(20_000).optional(),
    facetCreates: z.array(syncEntryFacetCreateDependencySchema).min(1).max(20_000).optional(),
  }),
}).superRefine((operation, context) => {
  if ((operation.baseVersion === 0) !== (operation.payload.parentCreateOpId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['payload', 'parentCreateOpId'], message: 'Pending Entry Tags require zero baseVersion and a parent create UUID; legacy versions must not have a parent' });
  }
  for (const field of ['baseValues', 'payload'] as const) {
    const seen = new Set<string>();
    operation[field].tags.forEach((tag, index) => {
      const normalized = normalizeTag(tag.name);
      if (!normalized || seen.has(normalized)) {
        context.addIssue({ code: 'custom', path: [field, 'tags', index], message: 'Tag names must be unique and nonempty after normalization' });
      }
      seen.add(normalized);
    });
  }
  const referencedTagUids = new Set([...operation.baseValues.tags, ...operation.payload.tags]
    .flatMap((tag) => tag.tagUid === undefined ? [] : [tag.tagUid.toLowerCase()]));
  const referencedFacetUids = new Set([...operation.baseValues.tags, ...operation.payload.tags]
    .flatMap((tag) => tag.facetUid === undefined ? [] : [tag.facetUid.toLowerCase()]));
  const tagDependencies = operation.payload.tagCreates ?? [];
  const facetDependencies = operation.payload.facetCreates ?? [];
  if (new Set(tagDependencies.map((row) => row.tagUid.toLowerCase())).size !== tagDependencies.length
    || tagDependencies.some((row) => row.createOpId.toLowerCase() === operation.opId.toLowerCase())
    || tagDependencies.some((row) => !referencedTagUids.has(row.tagUid.toLowerCase()))
    || tagDependencies.length !== referencedTagUids.size) {
    context.addIssue({ code: 'custom', path: ['payload', 'tagCreates'], message: 'Invalid Entry Tag creation dependencies' });
  }
  if (new Set(facetDependencies.map((row) => row.facetUid.toLowerCase())).size !== facetDependencies.length
    || facetDependencies.some((row) => row.createOpId.toLowerCase() === operation.opId.toLowerCase())
    || facetDependencies.some((row) => !referencedFacetUids.has(row.facetUid.toLowerCase()))
    || facetDependencies.length !== referencedFacetUids.size) {
    context.addIssue({ code: 'custom', path: ['payload', 'facetCreates'], message: 'Invalid Facet creation dependencies' });
  }
  if (JSON.stringify(operation.baseValues.tags) === JSON.stringify(operation.payload.tags)) {
    context.addIssue({ code: 'custom', path: ['payload', 'tags'], message: 'Desired Entry Tag assignments must differ from their base' });
  }
});

const syncProducerViewLaterOperationSchema = z.strictObject({
  ...syncProducerReplayBaseShape,
  operationKind: z.literal('producer.view-later.set'),
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

const syncContentValueSchema = z.strictObject({
  syncUid: syncUidSchema,
  contentType: z.string().trim().min(1),
  content: z.string(),
  sortOrder: z.number().int().nonnegative(),
});

/** A single new Content row dependent on the original, immutable Entry create. */
const syncEntryContentAppendOperationSchema = z.strictObject({
  ...syncEntryReplayBaseShape,
  operationKind: z.literal('entry.content.append'),
  baseVersion: z.literal(0),
  baseValues: z.strictObject({}),
  payload: z.strictObject({
    parentCreateOpId: z.string().uuid(),
    content: z.strictObject({
      syncUid: syncUidSchema,
      contentType: z.string().trim().min(1),
      content: z.string().trim().min(1),
    }),
  }),
}).refine((operation) => operation.opId !== operation.payload.parentCreateOpId, {
  path: ['payload', 'parentCreateOpId'], message: 'Append cannot depend on itself',
});

/** A media reference as it is stored on the Entry: /api/assets/entries/<id>/<fileName>. */
const syncEntryMediaRefSchema = z.string().trim().min(1).max(512);

/**
 * The Entry's whole media list in its display order — cover first, then the
 * previews. One operation covers delete (a shorter list), reorder (the same
 * refs in another order) and both at once; the server moves and renames the
 * files so the first image really is `cover.*` afterwards.
 */
const syncEntryMediaOperationSchema = z.strictObject({
  ...syncEntryReplayBaseShape,
  operationKind: z.literal('entry.media.set'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({ refs: z.array(syncEntryMediaRefSchema).max(33) }),
  payload: z.strictObject({ refs: z.array(syncEntryMediaRefSchema).max(33) }),
}).superRefine((operation, context) => {
  for (const [field, refs] of [
    ['baseValues', operation.baseValues.refs],
    ['payload', operation.payload.refs],
  ] as const) {
    if (new Set(refs).size !== refs.length) {
      context.addIssue({
        code: 'custom', path: [field, 'refs'],
        message: 'A media reference may only appear once',
      });
    }
  }
  if (JSON.stringify(operation.baseValues.refs) === JSON.stringify(operation.payload.refs)) {
    context.addIssue({
      code: 'custom', path: ['payload', 'refs'],
      message: 'desired media order must differ from its base',
    });
  }
});

const syncEntryContentsOperationSchema = z.strictObject({
  ...syncEntryReplayBaseShape,
  operationKind: z.literal('entry.contents.set'),
  baseVersion: z.number().int().nonnegative(),
  baseValues: z.strictObject({ contents: z.array(syncContentValueSchema).max(500) }),
  payload: z.strictObject({ contents: z.array(syncContentValueSchema).max(500), parentCreateOpId: syncUidSchema.optional() }),
}).superRefine((operation, context) => {
  if ((operation.baseVersion === 0) !== (operation.payload.parentCreateOpId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['payload', 'parentCreateOpId'], message: 'Pending Content requires zero baseVersion and a parent create UUID; legacy versions must not have a parent' });
  }
  for (const [field, contents] of [
    ['baseValues', operation.baseValues.contents],
    ['payload', operation.payload.contents],
  ] as const) {
    const seen = new Set<string>();
    contents.forEach((content, index) => {
      if (operation.baseVersion === 0 && content.content.trim().length === 0) {
        context.addIssue({ code: 'custom', path: [field, 'contents', index, 'content'], message: 'Pending Content text must not be empty' });
      }
      if (seen.has(content.syncUid)) {
        context.addIssue({
          code: 'custom', path: [field, 'contents', index, 'syncUid'],
          message: 'Content identity may only appear once',
        });
      }
      seen.add(content.syncUid);
    });
  }
  operation.payload.contents.forEach((content, index) => {
    const previous = operation.payload.contents[index - 1];
    if (previous !== undefined && content.sortOrder < previous.sortOrder) {
      context.addIssue({
        code: 'custom', path: ['payload', 'contents', index, 'sortOrder'],
        message: 'Desired Content rows must be ordered by sort order',
      });
    }
  });
  if (JSON.stringify(operation.baseValues.contents) === JSON.stringify(operation.payload.contents)) {
    context.addIssue({
      code: 'custom', path: ['payload', 'contents'],
      message: 'desired Content list must differ from its base',
    });
  }
});

const syncProducerRatingOperationSchema = z.strictObject({
  ...syncProducerReplayBaseShape,
  operationKind: z.literal('producer.rating.set'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({
    slotUid: syncUidSchema,
    stars: syncRatingValueSchema,
  }),
  payload: z.strictObject({
    subjectKind: z.enum(['producer', 'author_self']).optional(),
    slotUid: syncUidSchema,
    stars: syncRatingValueSchema,
  }),
}).superRefine((operation, context) => {
  if (operation.baseValues.slotUid !== operation.payload.slotUid) {
    context.addIssue({
      code: 'custom', path: ['payload', 'slotUid'],
      message: 'rating slot cannot change within one desired-state operation',
    });
  }
  if (operation.baseValues.stars === operation.payload.stars) {
    context.addIssue({
      code: 'custom', path: ['payload', 'stars'],
      message: 'desired rating must differ from the base rating',
    });
  }
});
const syncProducerTagValueSchema = z.strictObject({
  syncUid: syncUidSchema,
  name: z.string().trim().min(1),
});
const syncProducerTagListSchema = z.array(syncProducerTagValueSchema).max(500);

const syncProducerUpdateOperationSchema = z.strictObject({
  ...syncProducerReplayBaseShape,
  operationKind: z.literal('producer.update'),
  baseVersion: z.number().int().positive(),
  baseValues: syncProducerPatchValuesSchema,
  payload: syncProducerPatchValuesSchema,
}).superRefine((operation, context) => {
  const payloadKeys = Object.keys(operation.payload).sort();
  const baseKeys = Object.keys(operation.baseValues).sort();
  if (payloadKeys.length === 0) {
    context.addIssue({ code: 'custom', path: ['payload'], message: 'payload must change at least one field' });
  }
  if (payloadKeys.join('\0') !== baseKeys.join('\0')) {
    context.addIssue({ code: 'custom', path: ['baseValues'], message: 'baseValues must contain exactly the patched fields' });
  }
});

const syncProducerTagsOperationSchema = z.strictObject({
  ...syncProducerReplayBaseShape,
  operationKind: z.literal('producer.tags.set'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({ tags: syncProducerTagListSchema }),
  payload: z.strictObject({ tags: syncProducerTagListSchema }),
}).superRefine((operation, context) => {
  for (const [field, tags] of [
    ['baseValues', operation.baseValues.tags],
    ['payload', operation.payload.tags],
  ] as const) {
    const seenUids = new Set<string>();
    const seenNames = new Set<string>();
    tags.forEach((tag, index) => {
      const normalizedName = normalizeTag(tag.name);
      if (seenUids.has(tag.syncUid)) {
        context.addIssue({ code: 'custom', path: [field, 'tags', index, 'syncUid'], message: 'Tag identity may only appear once' });
      }
      if (seenNames.has(normalizedName)) {
        context.addIssue({ code: 'custom', path: [field, 'tags', index, 'name'], message: 'Tag names must be unique' });
      }
      seenUids.add(tag.syncUid);
      seenNames.add(normalizedName);
      const previous = tags[index - 1];
      if (previous !== undefined && previous.syncUid >= tag.syncUid) {
        context.addIssue({ code: 'custom', path: [field, 'tags', index, 'syncUid'], message: 'Tags must be ordered by stable identity' });
      }
    });
  }
  const baseByUid = new Map(operation.baseValues.tags.map((tag) => [tag.syncUid, tag.name]));
  operation.payload.tags.forEach((tag, index) => {
    const baseName = baseByUid.get(tag.syncUid);
    if (baseName !== undefined && baseName !== tag.name) {
      context.addIssue({ code: 'custom', path: ['payload', 'tags', index, 'name'], message: 'Tag identity cannot be renamed in place' });
    }
  });
  if (JSON.stringify(operation.baseValues.tags) === JSON.stringify(operation.payload.tags)) {
    context.addIssue({ code: 'custom', path: ['payload', 'tags'], message: 'desired tags must differ from their base' });
  }
});

const syncRatingLayoutSlotValueSchema = z.strictObject({
  syncUid: syncUidSchema,
  name: z.string().trim().min(1).max(200),
  sortOrder: z.number().int().nonnegative(),
});
const syncRatingLayoutSlotsSchema = z.array(syncRatingLayoutSlotValueSchema).max(500);

const syncRatingLayoutSlotsOperationSchema = z.strictObject({
  ...syncRatingLayoutReplayBaseShape,
  operationKind: z.literal('rating-layout.slots.set'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({ slots: syncRatingLayoutSlotsSchema }),
  payload: z.strictObject({ slots: syncRatingLayoutSlotsSchema,
    deletedSlotUids: z.array(syncUidSchema).max(1).optional(),
    subjectKind: ratingSubjectKindSchema.optional(),
  }),
}).superRefine((operation, context) => {
  const validateList = (field: 'baseValues' | 'payload', slots: typeof operation.payload.slots) => {
    const seenUids = new Set<string>();
    const seenOrders = new Set<number>();
    slots.forEach((slot, index) => {
      if (seenUids.has(slot.syncUid)) {
        context.addIssue({ code: 'custom', path: [field, 'slots', index, 'syncUid'], message: 'Slot identity may only appear once' });
      }
      if (seenOrders.has(slot.sortOrder)) {
        context.addIssue({ code: 'custom', path: [field, 'slots', index, 'sortOrder'], message: 'Slot order must be unique' });
      }
      if (index > 0 && slots[index - 1]!.sortOrder > slot.sortOrder) {
        context.addIssue({ code: 'custom', path: [field, 'slots', index, 'sortOrder'], message: 'Slots must be ordered by sort order' });
      }
      seenUids.add(slot.syncUid);
      seenOrders.add(slot.sortOrder);
    });
  };
  validateList('baseValues', operation.baseValues.slots);
  validateList('payload', operation.payload.slots);

  const desiredByUid = new Map(operation.payload.slots.map((slot) => [slot.syncUid, slot]));
  for (const [index, baseSlot] of operation.baseValues.slots.entries()) {
    const desiredSlot = desiredByUid.get(baseSlot.syncUid);
    if (!desiredSlot) {
      if (!operation.payload.deletedSlotUids?.includes(baseSlot.syncUid)) context.addIssue({ code: 'custom', path: ['payload', 'slots'], message: 'Existing rating slots cannot be deleted without an explicit deletion' });
      continue;
    }
    if (desiredSlot.name !== baseSlot.name) {
      context.addIssue({ code: 'custom', path: ['payload', 'slots', index, 'name'], message: 'Rating slot names cannot be changed in place' });
    }
  }
  for (const uid of operation.payload.deletedSlotUids ?? []) {
    if (!operation.baseValues.slots.some(slot => slot.syncUid === uid) || desiredByUid.has(uid)) context.addIssue({ code: 'custom', path: ['payload', 'deletedSlotUids'], message: 'Deletion must identify an existing removed slot' });
  }
  const baseUids = new Set(operation.baseValues.slots.map((slot) => slot.syncUid));
  const added = operation.payload.slots.filter((slot) => !baseUids.has(slot.syncUid));
  if (added.length > 1) {
    context.addIssue({ code: 'custom', path: ['payload', 'slots'], message: 'Create at most one rating slot per operation' });
  }
  if (added.length === 1) {
    const lastOrder = Math.max(-1, ...operation.baseValues.slots.map((slot) => slot.sortOrder));
    if (added[0]!.sortOrder !== lastOrder + 1) {
      context.addIssue({ code: 'custom', path: ['payload', 'slots'], message: 'A created rating slot must append to the layout' });
    }
  }
  if (JSON.stringify(operation.baseValues.slots) === JSON.stringify(operation.payload.slots)) {
    context.addIssue({ code: 'custom', path: ['payload', 'slots'], message: 'Desired rating slot layout must differ from its base' });
  }
});

const syncProducerDirectoryEntryValueSchema = z.strictObject({
  syncUid: syncUidSchema,
  sortOrder: z.number().int().nonnegative(),
});
const syncProducerDirectoryValueSchema = z.strictObject({
  syncUid: syncUidSchema,
  title: z.string().trim().min(1),
  description: z.string(),
  sortOrder: z.number().int().nonnegative(),
  entries: z.array(syncProducerDirectoryEntryValueSchema).max(20_000),
});
const syncProducerDirectoryListSchema = z.array(syncProducerDirectoryValueSchema).max(2_000);

const syncAuthorDirectoriesOperationSchema = z.strictObject({
  ...syncAuthorDirectorySetReplayBaseShape,
  operationKind: z.literal('author.directories.set'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({ directories: syncProducerDirectoryListSchema }),
  payload: z.strictObject({ directories: syncProducerDirectoryListSchema, producerCreates: z.array(z.strictObject({producerUid: syncUidSchema, createOpId: syncUidSchema})).length(1).optional() }),
}).superRefine((operation, context) => {
  const validateDirectories = (field: 'baseValues' | 'payload', directories: typeof operation.payload.directories) => {
    const directoryUids = new Set<string>();
    const directoryOrders = new Set<number>();
    const entryUids = new Set<string>();
    directories.forEach((directory, index) => {
      if (directoryUids.has(directory.syncUid)) {
        context.addIssue({ code: 'custom', path: [field, 'directories', index, 'syncUid'], message: 'Directory identity may only appear once' });
      }
      if (directoryOrders.has(directory.sortOrder)) {
        context.addIssue({ code: 'custom', path: [field, 'directories', index, 'sortOrder'], message: 'Directory order must be unique' });
      }
      if (index > 0 && directories[index - 1]!.sortOrder > directory.sortOrder) {
        context.addIssue({ code: 'custom', path: [field, 'directories', index, 'sortOrder'], message: 'Directories must be ordered by sort order' });
      }
      directoryUids.add(directory.syncUid);
      directoryOrders.add(directory.sortOrder);
      const entryOrders = new Set<number>();
      directory.entries.forEach((entry, entryIndex) => {
        if (entryUids.has(entry.syncUid)) {
          context.addIssue({ code: 'custom', path: [field, 'directories', index, 'entries', entryIndex, 'syncUid'], message: 'An Entry may belong to at most one Directory per Producer' });
        }
        if (entryOrders.has(entry.sortOrder)) {
          context.addIssue({ code: 'custom', path: [field, 'directories', index, 'entries', entryIndex, 'sortOrder'], message: 'Entry order must be unique within a Directory' });
        }
        if (entryIndex > 0 && directory.entries[entryIndex - 1]!.sortOrder > entry.sortOrder) {
          context.addIssue({ code: 'custom', path: [field, 'directories', index, 'entries', entryIndex, 'sortOrder'], message: 'Directory Entries must be ordered by sort order' });
        }
        entryUids.add(entry.syncUid);
        entryOrders.add(entry.sortOrder);
      });
    });
  };
  validateDirectories('baseValues', operation.baseValues.directories);
  validateDirectories('payload', operation.payload.directories);
  const desiredByUid = new Map(operation.payload.directories.map((directory) => [directory.syncUid, directory]));
  for (const directory of operation.baseValues.directories) {
    if (!desiredByUid.has(directory.syncUid)) {
      context.addIssue({ code: 'custom', path: ['payload', 'directories'], message: 'Existing Directories cannot be deleted by this operation' });
    }
  }
  if (JSON.stringify(operation.baseValues.directories) === JSON.stringify(operation.payload.directories)) {
    context.addIssue({ code: 'custom', path: ['payload', 'directories'], message: 'Desired Directory state must differ from its base' });
  }
});

const syncCollectionCreateOperationSchema = z.strictObject({
  ...syncCollectionReplayBaseShape,
  operationKind: z.literal('collection.create'),
  baseVersion: z.literal(0),
  baseValues: z.strictObject({}),
  payload: z.strictObject({
    kind: z.enum(['entry', 'producer']),
    title: z.string().trim().min(1).max(500),
    description: z.string().max(20_000),
    nsfw: z.boolean(),
    parentUid: syncUidSchema.nullable(),
    galleryType: z.string().nullable(),
  }),
}).superRefine((operation, context) => {
  if (operation.payload.kind === 'producer'
    && (operation.payload.parentUid !== null || operation.payload.galleryType !== null)) {
    context.addIssue({ code: 'custom', path: ['payload'], message: 'Author Collections cannot have a parent or Gallery scope' });
  }
});

/** Stable synthetic outbox identities for root Collection order scopes (not DB rows). */
export const COLLECTION_ORDER_SCOPE_UIDS = {
  entry: '00000000-0000-4000-8000-000000000001',
  producer: '00000000-0000-4000-8000-000000000002',
} as const;

const syncCollectionOrderReplayBaseShape = {
  ...syncReplayBaseShape,
  entityKind: z.literal('collection_order'),
} as const;

const syncCollectionMetadataValuesSchema = z.strictObject({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20_000).optional(),
  nsfw: z.boolean().optional(),
}).superRefine((values, context) => {
  if (Object.keys(values).length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Collection metadata patches must include a field' });
  }
});

const syncCollectionUpdateOperationSchema = z.strictObject({
  ...syncCollectionReplayBaseShape,
  entityKind: z.literal('collection'),
  operationKind: z.literal('collection.update'),
  baseVersion: z.number().int().positive(),
  baseValues: syncCollectionMetadataValuesSchema,
  payload: syncCollectionMetadataValuesSchema,
}).superRefine((operation, context) => {
  const keys = ['title', 'description', 'nsfw'] as const;
  const changedFields = keys.filter((key) => operation.baseValues[key] !== operation.payload[key]);
  const mismatchedFields = keys.filter((key) => (
    (operation.baseValues[key] === undefined) !== (operation.payload[key] === undefined)
  ));
  if (mismatchedFields.length > 0) {
    context.addIssue({ code: 'custom', path: ['payload'], message: 'Base and desired Collection fields must match' });
  }
  if (changedFields.length === 0) {
    context.addIssue({ code: 'custom', path: ['payload'], message: 'Desired Collection values must differ from their base' });
  }
});

const syncCollectionOrderMemberSchema = z.strictObject({
  syncUid: syncUidSchema,
  syncVersion: z.number().int().positive(),
  sortOrder: z.number().int().nonnegative(),
});

const syncCollectionOrderOperationSchema = z.strictObject({
  ...syncCollectionOrderReplayBaseShape,
  operationKind: z.literal('collection.order.set'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({
    kind: z.enum(['entry', 'producer']),
    collections: z.array(syncCollectionOrderMemberSchema).max(500),
  }),
  payload: z.strictObject({
    kind: z.enum(['entry', 'producer']),
    orderedCollectionUids: z.array(syncUidSchema).max(500),
  }),
}).superRefine((operation, context) => {
  const members = operation.baseValues.collections;
  const baseUids = members.map((member) => member.syncUid);
  const desiredUids = operation.payload.orderedCollectionUids;
  const expectedScopeUid = COLLECTION_ORDER_SCOPE_UIDS[operation.payload.kind];
  if (operation.entityUid !== expectedScopeUid) {
    context.addIssue({ code: 'custom', path: ['entityUid'], message: 'Collection order scope identity does not match its kind' });
  }
  if (operation.baseValues.kind !== operation.payload.kind) {
    context.addIssue({ code: 'custom', path: ['payload', 'kind'], message: 'Collection kind cannot change within an order operation' });
  }
  if (new Set(baseUids).size !== baseUids.length || new Set(desiredUids).size !== desiredUids.length
    || baseUids.length !== desiredUids.length || baseUids.some((uid) => !desiredUids.includes(uid))) {
    context.addIssue({ code: 'custom', path: ['payload', 'orderedCollectionUids'], message: 'Reorder must contain every current Collection exactly once' });
  }
  if (members.some((member, index) => index > 0 && members[index - 1]!.sortOrder > member.sortOrder)) {
    context.addIssue({ code: 'custom', path: ['baseValues', 'collections'], message: 'Base Collections must be in current sort order' });
  }
  if (members.reduce((sum, member) => sum + member.syncVersion, 0) !== operation.baseVersion) {
    context.addIssue({ code: 'custom', path: ['baseVersion'], message: 'Order baseVersion must equal the captured Collection version sum' });
  }
  if (JSON.stringify(baseUids) === JSON.stringify(desiredUids)) {
    context.addIssue({ code: 'custom', path: ['payload', 'orderedCollectionUids'], message: 'Desired order must differ from its base' });
  }
});

const syncCollectionEntryMembershipOperationSchema = z.strictObject({
  ...syncCollectionReplayBaseShape,
  operationKind: z.literal('collection.entry.set'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({ entryUid: syncUidSchema, present: z.boolean() }),
  payload: z.strictObject({ entryUid: syncUidSchema, present: z.boolean() }),
}).superRefine((operation, context) => {
  if (operation.baseValues.entryUid !== operation.payload.entryUid) {
    context.addIssue({ code: 'custom', path: ['payload', 'entryUid'], message: 'Entry identity cannot change within a membership operation' });
  }
  if (operation.baseValues.present === operation.payload.present) {
    context.addIssue({ code: 'custom', path: ['payload', 'present'], message: 'Desired membership must differ from its base' });
  }
});

const syncCollectionProducerMembershipOperationSchema = z.strictObject({
  ...syncCollectionReplayBaseShape,
  operationKind: z.literal('collection.producer.set'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({ producerUid: syncUidSchema, present: z.boolean() }),
  payload: z.strictObject({ producerUid: syncUidSchema, present: z.boolean() }),
}).superRefine((operation, context) => {
  if (operation.baseValues.producerUid !== operation.payload.producerUid) {
    context.addIssue({ code: 'custom', path: ['payload', 'producerUid'], message: 'Producer identity cannot change within a membership operation' });
  }
  if (operation.baseValues.present === operation.payload.present) {
    context.addIssue({ code: 'custom', path: ['payload', 'present'], message: 'Desired membership must differ from its base' });
  }
});

export const GALLERY_ORDER_SCOPE_UID = '00000000-0000-4000-8000-000000000037';
const galleryOrderValuesSchema = z.strictObject({ orderedTypes: z.array(z.string().trim().min(1)).max(500) });
const syncGalleryOrderOperationSchema = z.strictObject({
  ...syncReplayBaseShape, entityKind: z.literal('gallery_order'), entityUid: z.literal(GALLERY_ORDER_SCOPE_UID),
  operationKind: z.literal('gallery.order.set'), baseVersion: z.number().int().positive(),
  baseValues: galleryOrderValuesSchema, payload: galleryOrderValuesSchema,
}).superRefine((operation, context) => {
  const base = operation.baseValues.orderedTypes, desired = operation.payload.orderedTypes;
  if (new Set(base).size !== base.length || new Set(desired).size !== desired.length
    || base.length !== desired.length || base.some(type => !desired.includes(type))
    || JSON.stringify(base) === JSON.stringify(desired)) {
    context.addIssue({ code: 'custom', path: ['payload'], message: 'Gallery order must reorder every current Gallery exactly once' });
  }
});

export const syncReplayOperationSchema = z.union([
  syncGalleryOrderOperationSchema,
  syncEntryUpdateOperationSchema,
  syncEntryDeleteOperationSchema,
  syncEntryCreateOperationSchema,
  syncEntryContentAppendOperationSchema,
  syncEntryUsageOperationSchema,
  syncEntryViewLaterOperationSchema,
  syncEntryRatingOperationSchema,
  syncEntryAuthorsOperationSchema,
  syncEntryAuthorCreateAndLinkOperationSchema,
  syncEntryTagCreateOperationSchema,
  syncEntryFacetCreateOperationSchema,
  syncEntryTagsOperationSchema,
  syncEntryContentsOperationSchema,
  syncProducerViewLaterOperationSchema,
  syncProducerRatingOperationSchema,
  syncProducerDeleteOperationSchema,
  syncProducerCreateOperationSchema,
  syncProducerUpdateOperationSchema,
  syncProducerTagsOperationSchema,
  syncRatingLayoutSlotsOperationSchema,
  syncAuthorDirectoriesOperationSchema,
  syncCollectionCreateOperationSchema,
  syncCollectionEntryMembershipOperationSchema,
  syncCollectionOrderOperationSchema,
  syncCollectionProducerMembershipOperationSchema,
  syncCollectionUpdateOperationSchema,
]);

/**
 * What /api/sync/replay accepts: every synchronous operation plus the media
 * order, which the server applies outside the replay transaction because it
 * moves files.
 */
export const syncReplayRequestSchema = z.union([
  syncReplayOperationSchema,
  syncEntryMediaOperationSchema,
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
      galleryOrderValuesSchema,
      syncEntryPatchValuesSchema,
      syncProducerPatchValuesSchema,
      z.strictObject({ producerUids: z.array(syncUidSchema).max(20_000) }),
      z.strictObject({ present: z.boolean() }),
      z.strictObject({ slotUid: syncUidSchema, stars: syncRatingValueSchema }),
      z.strictObject({ tags: syncProducerTagListSchema }),
      z.strictObject({ tags: syncEntryTagListSchema }),
      z.strictObject({ contents: z.array(syncContentValueSchema).max(500) }),
      z.strictObject({ refs: z.array(syncEntryMediaRefSchema).max(33) }),
      z.strictObject({ slots: syncRatingLayoutSlotsSchema }),
      z.strictObject({ directories: syncProducerDirectoryListSchema }),
      syncCollectionMetadataValuesSchema,
      z.strictObject({
        kind: z.enum(['entry', 'producer']),
        collections: z.array(syncCollectionOrderMemberSchema).max(500),
      }),
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
      'invalid-collection-data',
      'invalid-rating',
      'invalid-content',
      'invalid-author-data',
      'invalid-tag-data',
      'invalid-media',
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
export type SyncReplayRequest = z.infer<typeof syncReplayRequestSchema>;
export type SyncEntryMediaOperation = Extract<SyncReplayRequest, { operationKind: 'entry.media.set' }>;
export type SyncReplayResult = z.infer<typeof syncReplayResultSchema>;

export const syncMediaUploadMetadataSchema = z.strictObject({
  /** Negotiated existingEntryMedia protocol only; omission retains create-origin authorization. */
  existingEntry: z.strictObject({
    expectedCoverRef: z.string().nullable(),
    expectedPreviewRefs: z.array(z.string()).max(32),
  }).optional(),
  libraryId: z.string().uuid(),
  syncEpoch: z.string().trim().min(1),
  entryUid: z.string().uuid(),
  kind: z.enum(['cover', 'preview']),
  ordinal: z.number().int().nonnegative().max(31),
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
  durationSeconds: z.number().int().nonnegative().nullable().optional(),
  uploadDate: z.string().nullable(),
  createdAt: isoText,
  updatedAt: isoText,
});

export const syncProducerRowSchema = z.strictObject({
  id: apiIdSchema,
  /** Optional for already-installed pre-v25 snapshot generations. */
  syncUid: z.string().uuid().optional(),
  syncVersion: z.number().int().positive().optional(),
  name: z.string(),
  occupation: z.string().nullable(),
  artworkRef: z.string().nullable(),
  content: z.string().nullable(),
  galleryAnchor: z.string().nullable().optional(),
});

export const syncEntryProducerRowSchema = z.strictObject({
  entryId: apiIdSchema,
  producerId: apiIdSchema,
});

export const syncTagRowSchema = z.strictObject({
  id: apiIdSchema,
  /** Optional so pre-migration-34 snapshot generations remain readable. */
  syncUid: syncUidSchema.optional(),
  name: z.string(),
  normalizedName: z.string(),
});

export const syncTagGroupRowSchema = z.strictObject({
  id: apiIdSchema,
  /** Optional so pre-migration-34 snapshot generations remain readable. */
  syncUid: syncUidSchema.optional(),
  entryType: z.string(),
  name: z.string(),
  groupKind: z.enum(['section', 'facet']),
  parentId: z.number().int().nullable(),
  sortOrder: z.number().int(),
});

export const syncEntryTagLayoutRowSchema = z.strictObject({
  entryType: z.string().trim().min(1),
  syncUid: syncUidSchema,
  syncVersion: z.number().int().positive(),
});

export const syncEntryTagRowSchema = z.strictObject({
  entryId: apiIdSchema,
  tagId: apiIdSchema,
  facetId: apiIdSchema,
});

export const syncProducerTagRowSchema = z.strictObject({
  id: apiIdSchema,
  /** Optional so older format-2 snapshots remain readable; offline edits require it. */
  syncUid: syncUidSchema.optional(),
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
  subjectKind: ratingSubjectKindSchema,
  entryType: z.string(),
  name: z.string(),
  sortOrder: z.number().int(),
});

export const syncRatingSlotLayoutRowSchema = z.strictObject({
  syncUid: syncUidSchema,
  syncVersion: z.number().int().positive(),
  subjectKind: ratingSubjectKindSchema,
  entryType: z.string(),
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
  /** Optional so pre-migration-28 v2 generations remain readable. */
  syncUid: syncUidSchema.optional(),
  syncVersion: z.number().int().positive().optional(),
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

export const syncAuthorDirectorySetRowSchema = z.strictObject({
  producerId: apiIdSchema,
  syncUid: syncUidSchema,
  syncVersion: z.number().int().positive(),
});

export const syncAuthorDirectoryRowSchema = z.strictObject({
  id: apiIdSchema,
  /** Optional so pre-migration-28 v2 generations remain readable. */
  syncUid: syncUidSchema.optional(),
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
  /** Optional for installed format-2 snapshots created before migration 034. */
  entryTagLayouts: z.array(syncEntryTagLayoutRowSchema).optional(),
  entryTags: z.array(syncEntryTagRowSchema),
  producerTags: z.array(syncProducerTagRowSchema),
  producerTagAssignments: z.array(syncProducerTagAssignmentRowSchema),
  taxonomyAliases: z.array(syncTaxonomyAliasRowSchema).optional(),
  entryContents: z.array(syncEntryContentRowSchema),
  ratingSlots: z.array(syncRatingSlotRowSchema),
  /** Optional for persisted v2 generations created before the shared-layout resource. */
  ratingLayouts: z.array(syncRatingSlotLayoutRowSchema).optional(),
  entryRatingValues: z.array(syncEntryRatingValueRowSchema),
  producerRatingValues: z.array(syncProducerRatingValueRowSchema),
  collections: z.array(syncCollectionRowSchema),
  collectionMembers: z.array(syncCollectionMemberRowSchema),
  authorDirectories: z.array(syncAuthorDirectoryRowSchema),
  /** Optional for persisted v2 snapshots from before migration 028. */
  authorDirectorySets: z.array(syncAuthorDirectorySetRowSchema).optional(),
  authorDirectoryEntries: z.array(syncAuthorDirectoryEntryRowSchema),
  entryUsage: z.array(syncUsageRowSchema),
  viewLaterEntries: z.array(syncViewLaterRowSchema),
  viewLaterProducers: z.array(syncViewLaterRowSchema),
  galleryOrder: z.strictObject({ syncUid: syncUidSchema, syncVersion: z.number().int().positive(), orderedTypes: z.array(z.string().min(1)) }).optional(),
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
