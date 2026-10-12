import { z } from 'zod';

const nullableText = z.string().nullable();
const localState = { status: z.enum(['pending', 'conflict', 'failed']), lastAttemptAt: nullableText, lastError: nullableText };
const operationSchema = z.strictObject({
  opId: z.string().uuid(), clientId: z.string().min(1), libraryId: z.string().min(1), syncEpoch: z.string().min(1),
  entityKind: z.string(), entityUid: z.string().uuid(), operationKind: z.string(), baseVersion: z.number().int().nonnegative(),
  baseValues: z.record(z.string(), z.unknown()), payload: z.record(z.string(), z.unknown()), clientCreatedAt: z.string().min(1), ...localState,
});
const mediaSchema = z.strictObject({
  uploadId: z.string().uuid(), libraryId: z.string().uuid(), syncEpoch: z.string().min(1), entryUid: z.string().uuid(),
  existingEntry: z.strictObject({expectedCoverRef:z.string().nullable(),expectedPreviewRefs:z.array(z.string()).max(32)}).optional(),
  replace:z.literal(true).optional(),
  kind: z.enum(['cover','preview']), ordinal: z.number().int().min(0).max(31),
  mimeType: z.enum(['image/avif','image/gif','image/jpeg','image/png','image/webp']),
  byteLength: z.number().int().positive().max(20 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(['pending','failed']), lastAttemptAt: nullableText, lastError: nullableText, base64: z.string(),
});
const identity={entryUid:z.string().uuid(),libraryId:z.string().uuid(),syncEpoch:z.string().min(1),clientId:z.string().min(1),revision:z.string().uuid()};
const localFinalStateSchema=z.strictObject({version:z.literal(1),drafts:z.array(z.string().uuid()).max(10000),mediaDrafts:z.array(z.string().uuid()).max(10000),
  mediaOrder:z.array(z.string().uuid()).max(10000),deferredMedia:z.array(z.string().uuid()).max(10000),derived:z.array(z.string().uuid()).max(10000).optional(),
  media:z.array(z.strictObject({...identity,baselineRefs:z.array(z.string()).max(32),baselineVersion:z.number().int().nonnegative(),
    baselineCoverRef:z.string().nullable().optional(),baselinePreviewRefs:z.array(z.string()).max(32).optional(),
    items:z.array(z.strictObject({key:z.string().min(1),ref:z.string().nullable(),uploadId:z.string().uuid().optional()})).max(10000),desired:z.array(z.string()).max(32),
    compiled:z.strictObject({opId:z.string().uuid(),revision:z.string().uuid(),refs:z.array(z.strictObject({key:z.string(),ref:z.string()})).max(32),uploaded:z.array(z.string().uuid()).max(10000)}).optional(),
  })).max(10000),deleted:z.array(z.strictObject({...identity,compiledOpId:z.string().uuid().optional()})).max(10000)});
const localMediaReceipt=z.strictObject({uploadId:z.string().uuid(),entryUid:z.string().uuid(),kind:z.enum(['cover','preview']),entityId:z.number().int().positive(),relativeRef:z.string().min(1)});
export const pendingWorkFileSchema = z.strictObject({format:z.literal('t3-pending-work-v1'),exportedAt:z.string().datetime(),
  operations:z.array(operationSchema).max(10000),media:z.array(mediaSchema).max(10000),
  localFinalState:localFinalStateSchema.optional(),localMediaReceipts:z.array(localMediaReceipt).max(10000).optional()});
