import { z } from 'zod';
import { syncSnapshotHeaderSchema } from './sync.js';

/** Complete serialized-snapshot splice, NOT the partial owner journal.
 * UTF-16 offsets refer to canonical JSON emitted by the snapshot schema.
 * The final strict snapshot/count/checksum verification is mandatory.
 */
export const syncDeltaRequestSchema = z.strictObject({
  libraryId: z.string().min(1), syncEpoch: z.string().min(1),
  protocolVersion: z.literal(1), clientId: z.string().min(1).max(200),
  media: z.enum(['none', 'thumbnails']), baseChecksum: z.string().min(1),
  baseChangeSeq: z.number().int().nonnegative(),
  token: z.string().uuid().optional(), offset: z.number().int().nonnegative().default(0),
});
export const syncDeltaPageSchema = z.strictObject({
  version: z.literal(1), token: z.string().uuid(), baseChecksum: z.string().min(1),
  target: syncSnapshotHeaderSchema,
  prefix: z.number().int().nonnegative(), remove: z.number().int().nonnegative(),
  insertLength: z.number().int().nonnegative().max(48 * 1024 * 1024),
  offset: z.number().int().nonnegative(), chunk: z.string().max(16384),
  done: z.boolean(),
});
export type SyncDeltaRequest = z.input<typeof syncDeltaRequestSchema>;
export type SyncDeltaPage = z.infer<typeof syncDeltaPageSchema>;
