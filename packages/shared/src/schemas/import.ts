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
  tags: z.array(importTagSchema).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  sources: z.array(importSourceSchema).optional(),
  body: z.string().optional(),
});

export const importBatchSchema = z.object({
  source: z.string().trim().min(1),
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

export const importCommitMappingSchema = z.strictObject({
  entryType: z.string().trim().min(1),
  canonicalTagFacetId: z.number().int().positive(),
  sourceContentType: z.string().trim().min(1),
  externalKeyContentType: z.string().trim().min(1),
  bodyContentType: z.string().trim().min(1).optional(),
  fieldMappings: z.record(z.string(), importFieldMappingSchema).default({}),
  ignoredFields: z.array(z.string().trim().min(1))
    .refine((fields) => new Set(fields).size === fields.length, {
      message: 'Ignored fields must be unique',
    })
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
  createdProducerCount: z.number().int().nonnegative(),
  producerLinkCount: z.number().int().nonnegative(),
  tagAssignmentCount: z.number().int().nonnegative(),
  contentCount: z.number().int().nonnegative(),
});

export type ImportTag = z.infer<typeof importTagSchema>;
export type ImportSource = z.infer<typeof importSourceSchema>;
export type ImportEntry = z.infer<typeof importEntrySchema>;
export type ImportBatch = z.infer<typeof importBatchSchema>;
export type ImportFieldMapping = z.infer<typeof importFieldMappingSchema>;
export type ImportCommitMapping = z.infer<typeof importCommitMappingSchema>;
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export type ImportCommitResult = z.infer<typeof importCommitResultSchema>;