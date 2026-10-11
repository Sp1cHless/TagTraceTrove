import { normalizeTag, type ImportBatch } from '@t3/shared';

export interface ImportPreview {
  source: string;
  entryCount: number;
  tagAssignmentCount: number;
  uniqueTagCount: number;
  entriesMissingCover: number;
  warnings: string[];
}

export function createImportPreview(batch: ImportBatch): ImportPreview {
  const tags = batch.entries.flatMap((entry) => entry.tags ?? []);

  return {
    source: batch.source,
    entryCount: batch.entries.length,
    tagAssignmentCount: tags.length,
    uniqueTagCount: new Set(tags.map((tag) => normalizeTag(tag.name))).size,
    entriesMissingCover: batch.entries.filter((entry) => !entry.cover).length,
    warnings: [...batch.warnings],
  };
}