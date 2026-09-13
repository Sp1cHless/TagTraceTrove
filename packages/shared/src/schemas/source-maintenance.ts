import { z } from 'zod';

const apiIdSchema = z.number().int().positive();
const sourceKeySchema = z.string().trim().min(1).max(200);
const urlSchema = z.string().trim().min(1).max(2048);

/** Group-level annotation over a derived Source; never hides or deletes URLs. */
export const sourceInvalidStateSchema = z.enum(['active', 'invalid']);

export const sourceStatusPatchSchema = z.strictObject({
  state: sourceInvalidStateSchema,
  note: z.string().trim().max(500).optional(),
});

export const sourceStatusRecordSchema = z.strictObject({
  sourceKey: sourceKeySchema,
  state: sourceInvalidStateSchema,
  note: z.string().trim().max(500).nullable(),
  updatedAt: z.string().min(1),
});

export const sourceLibraryRecordSchema = z.strictObject({
  sourceKey: sourceKeySchema,
  sourceName: z.string().trim().min(1).max(200),
  hosts: z.array(z.string().trim().min(1)).max(100),
  entryCount: z.number().int().nonnegative(),
  entryUrlCount: z.number().int().nonnegative(),
  state: sourceInvalidStateSchema,
  statusNote: z.string().trim().max(500).nullable(),
});

export const sourceEvidenceBandSchema = z.enum([
  'exact-safe',
  'strong-review',
  'ambiguous',
  'conflict',
  'no-match',
  'error',
]);

export const sourceCandidateSchema = z.strictObject({
  url: urlSchema,
  title: z.string().trim().min(1).max(500),
  language: z.string().trim().min(1).max(50).optional(),
  creators: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  workKind: z.string().trim().min(1).max(50).optional(),
  thumbnailUrl: urlSchema.optional(),
  band: sourceEvidenceBandSchema,
  reasons: z.array(z.string().trim().min(1).max(300)).max(20),
  /** External catalog identities resolved for this candidate. */
  catalogIds: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  adapterEvidence: z.record(z.string(), z.unknown()),
});

export const sourceMaintenanceDecisionSchema = z.enum([
  'pending',
  'accept',
  'skip',
  'conflict',
  'error',
]);

export const sourceMaintenanceRunStatusSchema = z.enum([
  'draft',
  'running',
  'paused',
  'review',
  'committed',
  'cancelled',
  'failed',
]);

export const createSourceMaintenanceRunRequestSchema = z.strictObject({
  originSourceKey: sourceKeySchema,
  adapterKey: z.string().trim().min(1).max(100),
  targetHomepage: urlSchema.optional(),
  markOriginInvalid: z.boolean(),
});

export const sourceMaintenanceRunCountsSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  noMatch: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});

export const sourceMaintenanceRunRecordSchema = z.strictObject({
  id: apiIdSchema,
  originSourceKey: sourceKeySchema,
  adapterKey: z.string().trim().min(1).max(100),
  targetOrigin: z.string().trim().max(2048),
  status: sourceMaintenanceRunStatusSchema,
  markOriginInvalid: z.boolean(),
  counts: sourceMaintenanceRunCountsSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const sourceMaintenanceItemRecordSchema = z.strictObject({
  entryId: apiIdSchema,
  entryTitleSnapshot: z.string().trim().min(1).max(500),
  originUrls: z.array(urlSchema).max(50),
  queryTitles: z.array(z.string().trim().min(1).max(500)).max(6),
  candidates: z.array(sourceCandidateSchema).max(20),
  decision: sourceMaintenanceDecisionSchema,
  selectedUrl: urlSchema.nullable(),
  errorText: z.string().trim().min(1).max(500).nullable(),
  updatedAt: z.string().min(1),
});

export const sourceMaintenanceItemPatchSchema = z.strictObject({
  decision: sourceMaintenanceDecisionSchema.optional(),
  selectedUrl: urlSchema.nullable().optional(),
});

export const sourceMaintenanceItemPageQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  state: z.enum(['pending', 'accepted', 'skipped', 'unresolved', 'all']).optional().default('all'),
});

export const sourceMaintenanceItemPageResponseSchema = z.strictObject({
  run: sourceMaintenanceRunRecordSchema,
  items: z.array(sourceMaintenanceItemRecordSchema).max(100),
  total: z.number().int().nonnegative(),
});

export const commitSourceMaintenanceRequestSchema = z.strictObject({});

export const commitSourceMaintenanceResponseSchema = z.strictObject({
  runId: apiIdSchema,
  status: sourceMaintenanceRunStatusSchema,
  createdCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  originMarkedInvalid: z.boolean(),
  backupDir: z.string().trim().min(1),
});

export type SourceLibraryRecordDto = SourceLibraryRecord;
export type SourceStatusRecordDto = SourceStatusRecord;
export type SourceMaintenanceRunRecordDto = SourceMaintenanceRunRecord;
export type SourceMaintenanceItemRecordDto = SourceMaintenanceItemRecord;
export type SourceCandidateDto = SourceCandidate;
export type SourceMaintenanceItemPageQuery = z.infer<typeof sourceMaintenanceItemPageQuerySchema>;
export type SourceInvalidState = z.infer<typeof sourceInvalidStateSchema>;
export type SourceStatusPatch = z.infer<typeof sourceStatusPatchSchema>;
export type SourceStatusRecord = z.infer<typeof sourceStatusRecordSchema>;
export type SourceLibraryRecord = z.infer<typeof sourceLibraryRecordSchema>;
export type SourceEvidenceBand = z.infer<typeof sourceEvidenceBandSchema>;
export type SourceCandidate = z.infer<typeof sourceCandidateSchema>;
export type SourceMaintenanceDecision = z.infer<typeof sourceMaintenanceDecisionSchema>;
export type SourceMaintenanceRunStatus = z.infer<typeof sourceMaintenanceRunStatusSchema>;
export type CreateSourceMaintenanceRunRequest = z.infer<typeof createSourceMaintenanceRunRequestSchema>;
export type SourceMaintenanceRunCounts = z.infer<typeof sourceMaintenanceRunCountsSchema>;
export type SourceMaintenanceRunRecord = z.infer<typeof sourceMaintenanceRunRecordSchema>;
export type SourceMaintenanceItemRecord = z.infer<typeof sourceMaintenanceItemRecordSchema>;
export type SourceMaintenanceItemPatch = z.infer<typeof sourceMaintenanceItemPatchSchema>;
export type SourceMaintenanceItemStateFilter = z.infer<typeof sourceMaintenanceItemPageQuerySchema>['state'];
export type SourceMaintenanceItemPageResponse = z.infer<typeof sourceMaintenanceItemPageResponseSchema>;
export type CommitSourceMaintenanceResponse = z.infer<typeof commitSourceMaintenanceResponseSchema>;
