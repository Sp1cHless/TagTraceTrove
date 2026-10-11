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
  kind: z.enum(['cover','preview']), ordinal: z.number().int().min(0).max(31),
  mimeType: z.enum(['image/avif','image/gif','image/jpeg','image/png','image/webp']),
  byteLength: z.number().int().positive().max(20 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(['pending','failed']), lastAttemptAt: nullableText, lastError: nullableText, base64: z.string(),
});
export const pendingWorkFileSchema = z.strictObject({format:z.literal('t3-pending-work-v1'),exportedAt:z.string().datetime(),
  operations:z.array(operationSchema).max(10000),media:z.array(mediaSchema).max(10000)});
