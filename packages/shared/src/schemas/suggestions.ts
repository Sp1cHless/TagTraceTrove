import { z } from 'zod';
import { normalizeTag } from '../normalize/tag.js';

const apiIdSchema = z.number().int().positive();
const exclusionIdsSchema = z.array(apiIdSchema)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'IDs must be unique' });
const queryExclusionIdsSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  if (value.trim() === '') return [];
  return value.split(',').map((part) => Number(part.trim()));
}, exclusionIdsSchema);
const activeQuerySchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => normalizeTag(value) !== '', { message: 'Query must contain a visible character' });
const suggestionLimitSchema = z.coerce.number().int().min(1).max(20).optional().default(20);

const suggestionQueryBaseSchema = z.strictObject({
  q: activeQuerySchema,
  limit: suggestionLimitSchema,
  excludeIds: queryExclusionIdsSchema.optional().default([]),
});

export const suggestionVocabularySchema = z.enum(['entry', 'producer']);

export const tagSuggestionQuerySchema = suggestionQueryBaseSchema.extend({
  vocabulary: suggestionVocabularySchema,
  entryType: z.string().trim().min(1).max(200).optional(),
  facetId: z.coerce.number().int().positive().optional(),
});

export const producerSuggestionQuerySchema = suggestionQueryBaseSchema;

export const relationSuggestionSchema = z.strictObject({
  id: apiIdSchema,
  name: z.string().trim().min(1),
  matchedAlias: z.string().trim().min(1).optional(),
  sameContextUsageCount: z.number().int().nonnegative(),
  totalUsageCount: z.number().int().nonnegative(),
});

export const relationSuggestionResponseSchema = z.array(relationSuggestionSchema)
  .max(20)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    { message: 'Suggestion IDs must be unique' },
  );

export type SuggestionVocabulary = z.infer<typeof suggestionVocabularySchema>;
export type TagSuggestionQuery = z.infer<typeof tagSuggestionQuerySchema>;
export type ProducerSuggestionQuery = z.infer<typeof producerSuggestionQuerySchema>;
/** Client-facing input variants: defaults (limit) are applied server-side. */
export type TagSuggestionQueryInput = z.input<typeof tagSuggestionQuerySchema>;
export type ProducerSuggestionQueryInput = z.input<typeof producerSuggestionQuerySchema>;
export type RelationSuggestion = z.infer<typeof relationSuggestionSchema>;
export type RelationSuggestionDto = RelationSuggestion;
export type RelationSuggestionCandidate = Omit<RelationSuggestion, 'matchedAlias'> & {
  aliases?: readonly string[];
};
