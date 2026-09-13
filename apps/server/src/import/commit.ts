import {
  importBatchSchema,
  importCommitMappingSchema,
  normalizeTag,
  type ImportBatch,
  type ImportCommitMapping,
  type ImportEntry,
  type ImportFieldMapping,
} from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { createEntry, type EntryRecord } from '../repositories/entry-repository.js';
import { assignEntryTag } from '../repositories/entry-tag-repository.js';
import { createEntryContent } from '../repositories/entry-content-repository.js';
import {
  createProducer,
  findProducerIdByName,
  linkEntryProducer,
  type ProducerRecord,
} from '../repositories/producer-repository.js';
import {
  createProducerRatingSlot,
  findRatingSlotId,
  setProducerRating,
} from '../repositories/rating-repository.js';
import { resolveTaxonomyName } from '../repositories/taxonomy-repository.js';
import { majorityFacetForTag } from '../repositories/template-export.js';

export interface ImportCommitEntryResult {
  entryId: number;
  title: string;
  externalKey?: string;
}

export interface ImportCommitResult {
  entries: ImportCommitEntryResult[];
  entryCount: number;
  skippedExistingEntryCount: number;
  createdProducerCount: number;
  producerLinkCount: number;
  tagAssignmentCount: number;
  contentCount: number;
  authorRatingCount: number;
  /** Non-fatal source quirks resolved during the commit, e.g. one tag name
   *  arriving for two Facets of the same Entry. Empty when nothing was skipped. */
  warnings: string[];
}

interface PendingTag {
  name: string;
  facetId: number;
}

function normalizeName(value: string): string {
  return normalizeTag(value);
}

function requireStringValues(field: string, value: unknown, destination: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Import field "${field}" must be an array of strings when mapped to ${destination}`);
  }

  const values = value
    .map((item) => item.normalize('NFKC').trim().replace(/\s+/gu, ' '))
    .filter((item) => item !== '');
  return [...new Map(values.map((item) => [normalizeName(item), item])).values()];
}

function assertFacet(database: T3Database, facetId: number, entryType: string): void {
  const exists = database.prepare(`
    SELECT 1
    FROM tag_groups
    WHERE id = ? AND group_kind = 'facet' AND entry_type = ?
  `).get(facetId, entryType);
  if (!exists) {
    throw new Error(`Facet ${facetId} does not belong to Entry type "${entryType}"`);
  }
}

function assertProducer(database: T3Database, producerId: number): void {
  if (!database.prepare('SELECT 1 FROM producers WHERE id = ?').get(producerId)) {
    throw new Error(`Mapped Producer ${producerId} does not exist`);
  }
}

function assertReviewedFields(batch: ImportBatch, mapping: ImportCommitMapping): void {
  const ignoredFields = new Set(mapping.ignoredFields);
  for (const entry of batch.entries) {
    for (const field of Object.keys(entry.fields ?? {})) {
      if (!(field in mapping.fieldMappings) && !ignoredFields.has(field)) {
        throw new Error(`Import field "${field}" has no reviewed mapping`);
      }
    }
    if (entry.body !== undefined && mapping.bodyContentType === undefined) {
      throw new Error('Import Entry body has no reviewed Content mapping');
    }
  }
}

function partitionImportEntries(
  database: T3Database,
  batch: ImportBatch,
  mapping: ImportCommitMapping,
): { entriesToImport: ImportEntry[]; skippedExistingEntryCount: number } {
  const batchSourceUrls = new Set<string>();
  const existingSourceUrls = new Set(
    (database.prepare('SELECT content FROM entry_contents WHERE content_type = ?')
      .all(mapping.sourceContentType) as Array<{ content: string }>)
      .map((row) => row.content),
  );

  const entriesToImport: ImportEntry[] = [];
  let skippedExistingEntryCount = 0;
  for (const entry of batch.entries) {
    const primarySource = entry.sources?.find((source) => source.url) ?? entry.sources?.[0];
    if (primarySource?.url) {
      if (batchSourceUrls.has(primarySource.url)) {
        throw new Error(`Duplicate source URL in Import batch: ${primarySource.url}`);
      }
      batchSourceUrls.add(primarySource.url);
      if (existingSourceUrls.has(primarySource.url)) {
        skippedExistingEntryCount += 1;
        continue;
      }
    }
    entriesToImport.push(entry);
  }
  return { entriesToImport, skippedExistingEntryCount };
}

function createEntryRecord(
  database: T3Database,
  entry: ImportEntry,
  entryType: string,
): EntryRecord {
  return createEntry(database, {
    title: entry.title,
    type: entryType,
    uploadDate: entry.uploadDate,
    pageCount: entry.pageCount,
  });
}

/** Human label for a Facet: its name, else its Section's name, else `#id`. */
function facetLabel(database: T3Database, facetId: number): string {
  const row = database.prepare(`
    SELECT COALESCE(NULLIF(trim(facet.name), ''), NULLIF(trim(section.name), ''), '#' || facet.id) AS label
    FROM tag_groups AS facet
    LEFT JOIN tag_groups AS section ON section.id = facet.parent_id
    WHERE facet.id = ?
  `).get(facetId) as { label: string } | undefined;
  return row?.label ?? `#${facetId}`;
}

function collectTags(
  database: T3Database,
  entry: ImportEntry,
  mapping: ImportCommitMapping,
  warnings: string[],
): PendingTag[] {
  const tags = new Map<string, PendingTag>();
  const addTag = (name: string, fallbackFacetId: number): void => {
    const resolvedName = resolveTaxonomyName(database, 'entry', name);
    const key = normalizeName(resolvedName);
    // The saved gallery tag layout wins: a tag that already has an established
    // placement in this Gallery goes straight there; only unseen tags fall
    // back to the reviewed mapping (default position).
    const layoutFacet = majorityFacetForTag(database, mapping.entryType, resolvedName);
    const facetId = layoutFacet?.facetId ?? fallbackFacetId;
    const previous = tags.get(key);
    if (previous) {
      // One tag cannot sit in two Facets of the same Entry, and a source can
      // name the same thing as both a series and a character (a collection of
      // several series lists "Goblin Slayer" in both fields). The first
      // placement wins and the skipped one is reported, because refusing the
      // whole import over it would be far worse than one placement choice.
      if (previous.facetId !== facetId) {
        warnings.push(
          `Tag "${resolvedName}" arrived for both "${facetLabel(database, previous.facetId)}" `
          + `and "${facetLabel(database, facetId)}" in one Entry; kept the first placement`,
        );
      }
      return;
    }
    tags.set(key, { name: resolvedName, facetId });
  };

  for (const tag of entry.tags ?? []) {
    addTag(tag.name, mapping.canonicalTagFacetId);
  }
  for (const [field, value] of Object.entries(entry.fields ?? {})) {
    const fieldMapping = mapping.fieldMappings[field];
    if (fieldMapping?.kind === 'tag') {
      for (const name of requireStringValues(field, value, 'Tags')) {
        addTag(name, fieldMapping.facetId);
      }
    }
  }
  return [...tags.values()];
}

const ORIGINAL_SERIES_TAG = 'Original';

/**
 * A work whose meta carries no series at all is almost always an original
 * standalone piece: auto-assign "Original" under the Gallery's Series facet
 * so it does not sit unfiled. Skipped when the Gallery has no Series facet or
 * the entry already carries any series tag.
 */
function originalSeriesTag(
  database: T3Database,
  entryType: string,
  assigned: PendingTag[],
): PendingTag | null {
  const facets = database.prepare(`
    SELECT id, name FROM tag_groups
    WHERE group_kind = 'facet' AND entry_type = ?
  `).all(entryType) as Array<{ id: number; name: string }>;
  const seriesFacetId = facets.find((facet) => normalizeName(facet.name) === 'series')?.id;
  if (seriesFacetId === undefined) return null;
  if (assigned.some((tag) => tag.facetId === seriesFacetId)) return null;
  return { name: ORIGINAL_SERIES_TAG, facetId: seriesFacetId };
}

function buildExistingProducerMap(
  database: T3Database,
  fieldMappings: Record<string, ImportFieldMapping>,
): Map<string, number> {
  const producers = new Map<string, number>();
  for (const fieldMapping of Object.values(fieldMappings)) {
    if (fieldMapping.kind !== 'producer') {
      continue;
    }
    for (const [name, producerId] of Object.entries(fieldMapping.existingProducerIds)) {
      // Resolve the reviewed name too: a stale mapping keyed by an alias
      // spelling ('bob') must still match the canonical producer ('鲍勃').
      const key = normalizeName(resolveTaxonomyName(database, 'producer', name));
      const previous = producers.get(key);
      if (previous !== undefined && previous !== producerId) {
        throw new Error(`Producer "${name}" is mapped to multiple existing Producer IDs`);
      }
      assertProducer(database, producerId);
      producers.set(key, producerId);
    }
  }
  return producers;
}

/**
 * Records the Author ratings reviewed alongside one import. The reviewed
 * dimension must already exist as an Entry slot of the import Gallery; the
 * Author's own dimension is mirrored from it by name, which is what lets a
 * rating sort fall back to the Author value for the same dimension.
 *
 * Runs inside the commit transaction and after the Entries were linked, so a
 * freshly created Author already has the works that give them a Gallery.
 */
function applyAuthorRatings(
  database: T3Database,
  mapping: ImportCommitMapping,
  knownProducers: Map<string, number>,
): number {
  let authorRatingCount = 0;
  for (const rating of mapping.authorRatings) {
    const canonicalName = resolveTaxonomyName(database, 'producer', rating.name);
    const producerId = knownProducers.get(normalizeName(canonicalName))
      ?? findProducerIdByName(database, canonicalName);
    if (producerId === undefined) {
      throw new Error(
        `Import author rating "${rating.name}" is not an Author of this import`,
      );
    }
    if (findRatingSlotId(database, 'entry', mapping.entryType, rating.slotName) === undefined) {
      throw new Error(
        `Import author rating "${rating.slotName}" is not a rating dimension of Gallery "${mapping.entryType}"`,
      );
    }
    const slot = createProducerRatingSlot(database, { producerId, name: rating.slotName });
    setProducerRating(database, { producerId, slotId: slot.id, stars: rating.stars });
    authorRatingCount += 1;
  }
  return authorRatingCount;
}

export function commitImportBatch(
  database: T3Database,
  rawBatch: ImportBatch,
  rawMapping: ImportCommitMapping,
): ImportCommitResult {
  const batch = importBatchSchema.parse(rawBatch);
  const mapping = importCommitMappingSchema.parse(rawMapping);

  return database.transaction(() => {
    assertReviewedFields(batch, mapping);
    const { entriesToImport, skippedExistingEntryCount } = partitionImportEntries(database, batch, mapping);
    assertFacet(database, mapping.canonicalTagFacetId, mapping.entryType);
    for (const fieldMapping of Object.values(mapping.fieldMappings)) {
      if (fieldMapping.kind === 'tag') {
        assertFacet(database, fieldMapping.facetId, mapping.entryType);
      }
    }

    const knownProducers = buildExistingProducerMap(database, mapping.fieldMappings);
    const createdProducerIds = new Set<number>();
    const results: ImportCommitEntryResult[] = [];
    let producerLinkCount = 0;
    let tagAssignmentCount = 0;
    let contentCount = 0;
    const warnings: string[] = [];

    for (const entry of entriesToImport) {
      const createdEntry = createEntryRecord(database, entry, mapping.entryType);
      results.push({
        entryId: createdEntry.id,
        title: createdEntry.title,
        ...(entry.externalKey === undefined ? {} : { externalKey: entry.externalKey }),
      });

      const collectedTags = collectTags(database, entry, mapping, warnings);
      for (const tag of collectedTags) {
        assignEntryTag(database, {
          entryId: createdEntry.id,
          facetId: tag.facetId,
          name: tag.name,
        });
        tagAssignmentCount += 1;
      }

      const original = originalSeriesTag(database, mapping.entryType, collectedTags);
      if (original !== null) {
        assignEntryTag(database, {
          entryId: createdEntry.id,
          facetId: original.facetId,
          name: original.name,
        });
        tagAssignmentCount += 1;
      }

      const linkedProducerIds = new Set<number>();
      for (const [field, value] of Object.entries(entry.fields ?? {})) {
        const fieldMapping = mapping.fieldMappings[field];
        if (fieldMapping?.kind !== 'producer') {
          continue;
        }
        for (const name of requireStringValues(field, value, 'Producers')) {
          // Producer names resolve through the 'producer' taxonomy vocabulary,
          // exactly like Entry tags resolve through 'entry': an imported alias
          // ('bob') links to / creates the canonical author ('鲍勃'), so
          // dictionary-driven merges survive future imports of any spelling.
          const canonicalName = resolveTaxonomyName(database, 'producer', name);
          const key = normalizeName(canonicalName);
          let producerId = knownProducers.get(key);
          if (producerId === undefined) {
            // The dictionary already resolved this spelling to a canonical
            // author, so an author under that name is linked to rather than
            // duplicated: importing a work credited to `冷泉` must land on the
            // existing 和泉, whether or not the review preselected it.
            const canonicalMatch = findProducerIdByName(database, canonicalName);
            if (canonicalMatch !== undefined) {
              producerId = canonicalMatch;
              knownProducers.set(key, producerId);
            }
          }
          if (producerId === undefined) {
            if (!fieldMapping.createUnmatched) {
              throw new Error(
                `Producer "${name}" (resolves to "${canonicalName}") has no user-reviewed match`,
              );
            }
            const producer: ProducerRecord = createProducer(database, { name: canonicalName });
            producerId = producer.id;
            knownProducers.set(key, producerId);
            createdProducerIds.add(producerId);
          }
          if (!linkedProducerIds.has(producerId)) {
            linkEntryProducer(database, createdEntry.id, producerId);
            linkedProducerIds.add(producerId);
            producerLinkCount += 1;
          }
        }
      }

      let sortOrder = 0;
      const addContent = (contentType: string, content: string): void => {
        createEntryContent(database, {
          entryId: createdEntry.id,
          contentType,
          content,
          sortOrder,
        });
        sortOrder += 1;
        contentCount += 1;
      };

      const primarySource = entry.sources?.find((source) => source.url) ?? entry.sources?.[0];
      if (primarySource?.url) {
        addContent(mapping.sourceContentType, primarySource.url);
      }
    }

    const authorRatingCount = applyAuthorRatings(database, mapping, knownProducers);

    return {
      entries: results,
      entryCount: results.length,
      skippedExistingEntryCount,
      createdProducerCount: createdProducerIds.size,
      producerLinkCount,
      tagAssignmentCount,
      contentCount,
      authorRatingCount,
      warnings,
    };
  })();
}
