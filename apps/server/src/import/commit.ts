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
import { recordCrawlObservation, recordSiteWork } from '../repositories/site-crawl-repository.js';

export interface ImportCommitEntryResult {
  entryId: number;
  title: string;
  externalKey?: string;
}

export interface ImportCommitResult {
  entries: ImportCommitEntryResult[];
  entryCount: number;
  skippedExistingEntryCount: number;
  /** The works those skipped source URLs already belong to, in batch order. */
  existingEntryIds: number[];
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

/**
 * Splits a canonical `externalKey` (`hitomi.la:3220586`) into the site identity
 * the crawl state is keyed by. A key without a separator, or one with an empty
 * half, carries no site identity and is left to URL matching alone.
 */
function parseSiteWorkRef(
  externalKey: string | undefined,
): { sourceSite: string; sourceId: string } | null {
  if (externalKey === undefined) return null;
  const separator = externalKey.indexOf(':');
  if (separator <= 0) return null;
  const sourceSite = externalKey.slice(0, separator).trim();
  const sourceId = externalKey.slice(separator + 1).trim();
  if (sourceSite === '' || sourceId === '') return null;
  return { sourceSite, sourceId };
}

function primarySourceUrl(entry: ImportEntry): string | null {
  const primarySource = entry.sources?.find((source) => source.url) ?? entry.sources?.[0];
  return primarySource?.url ?? null;
}

function entryUploadDate(database: T3Database, entryId: number): string | null {
  const row = database.prepare('SELECT upload_date FROM entries WHERE id = ?').get(entryId) as
    | { upload_date: string | null }
    | undefined;
  return row?.upload_date ?? null;
}

function partitionImportEntries(
  database: T3Database,
  batch: ImportBatch,
  mapping: ImportCommitMapping,
): {
  entriesToImport: ImportEntry[];
  skippedExistingEntryCount: number;
  /** The work this source URL already belongs to, so the caller can still record
   *  that the run carried it — a name appearing in another folder is itself data. */
  existingEntryIds: number[];
  /** Every batch work's site identity, in batch order; null when it has none. */
  siteWorkRefs: Array<{ sourceSite: string; sourceId: string } | null>;
  /** The Entry each already-known batch work resolved to. */
  knownEntryIdByEntry: Map<ImportEntry, number>;
} {
  const batchSourceUrls = new Set<string>();
  // Both maps are read once for the whole batch: the library is asked about the
  // works it holds, not about one URL at a time.
  const existingEntryBySourceUrl = new Map<string, number>(
    (database.prepare('SELECT entry_id AS entryId, content FROM entry_contents WHERE content_type = ?')
      .all(mapping.sourceContentType) as Array<{ entryId: number; content: string }>)
      .map((row) => [row.content, row.entryId]),
  );
  const existingEntryBySiteWork = new Map<string, number>(
    (database.prepare('SELECT source_id AS sourceId, entry_id AS entryId FROM site_works WHERE source_site = ?')
      .all(batch.source) as Array<{ sourceId: string; entryId: number }>)
      .map((row) => [row.sourceId, row.entryId]),
  );

  const entriesToImport: ImportEntry[] = [];
  const existingEntryIds: number[] = [];
  const siteWorkRefs: Array<{ sourceSite: string; sourceId: string } | null> = [];
  const knownEntryIdByEntry = new Map<ImportEntry, number>();
  const batchSiteWorkKeys = new Set<string>();
  let skippedExistingEntryCount = 0;

  for (const entry of batch.entries) {
    const siteWorkRef = parseSiteWorkRef(entry.externalKey);
    siteWorkRefs.push(siteWorkRef);
    // One site never lists the same work twice in one listing, so a repeated id
    // is malformed input: committing it would file two Entries under one
    // identity, and the second would silently adopt the first's site row.
    if (siteWorkRef !== null) {
      const key = `${siteWorkRef.sourceSite}\u0000${siteWorkRef.sourceId}`;
      if (batchSiteWorkKeys.has(key)) {
        throw new Error(`Duplicate work id in Import batch: ${entry.externalKey}`);
      }
      batchSiteWorkKeys.add(key);
    }

    const sourceUrl = primarySourceUrl(entry);
    if (sourceUrl !== null) {
      if (batchSourceUrls.has(sourceUrl)) {
        throw new Error(`Duplicate source URL in Import batch: ${sourceUrl}`);
      }
      batchSourceUrls.add(sourceUrl);
    }

    // The clean Source URL decides first; the retained site work id is the
    // second gate, so a source that re-spells its own URLs still lands on the
    // work the library already holds instead of duplicating it.
    const knownEntryId = (sourceUrl === null ? undefined : existingEntryBySourceUrl.get(sourceUrl))
      ?? (siteWorkRef === null || siteWorkRef.sourceSite !== batch.source
        ? undefined
        : existingEntryBySiteWork.get(siteWorkRef.sourceId));
    if (knownEntryId !== undefined) {
      skippedExistingEntryCount += 1;
      existingEntryIds.push(knownEntryId);
      knownEntryIdByEntry.set(entry, knownEntryId);
      continue;
    }
    entriesToImport.push(entry);
  }

  return {
    entriesToImport,
    skippedExistingEntryCount,
    existingEntryIds,
    siteWorkRefs,
    knownEntryIdByEntry,
  };
}

/**
 * The durable id every work the batch carried should leave behind, whether it
 * was just created or already held. Update runs depend on this: the export
 * folder is deleted after a run, so `site_works` is the only record of what the
 * library already has. Resolving the skip path too also backfills libraries
 * whose works were imported before this table existed — re-running one export
 * over an existing library records ids for everything it already contains.
 *
 * The work date prefers the export's own value and falls back to what the
 * library stored, so a cursor built from an already-held work still advances.
 */
interface ResolvedBatchSiteWork {
  sourceSite: string;
  sourceId: string;
  entryId: number;
  detailUrl: string | null;
  workDate: string | null;
}

function resolveBatchSiteWorks(
  database: T3Database,
  batch: ImportBatch,
  siteWorkRefs: Array<{ sourceSite: string; sourceId: string } | null>,
  entryIdByEntry: Map<ImportEntry, number>,
  knownEntryIdByEntry: Map<ImportEntry, number>,
): ResolvedBatchSiteWork[] {
  const resolved: ResolvedBatchSiteWork[] = [];
  for (const [index, entry] of batch.entries.entries()) {
    const siteWorkRef = siteWorkRefs[index];
    const entryId = entryIdByEntry.get(entry) ?? knownEntryIdByEntry.get(entry);
    if (siteWorkRef === null || siteWorkRef === undefined || entryId === undefined) continue;
    resolved.push({
      ...siteWorkRef,
      entryId,
      detailUrl: primarySourceUrl(entry),
      workDate: entry.uploadDate ?? entryUploadDate(database, entryId),
    });
  }
  return resolved;
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

/**
 * The credited author whose name the search keyword is, if there is one.
 *
 * Comparison is by `normalizeTag`, so a search for `kakao` matches a card that
 * credits `Kakao` — the two spellings are one author and must not become two
 * registry rows.
 */
function creditedAuthor(batch: ImportBatch, keyword: string): string | undefined {
  const wanted = normalizeTag(keyword);
  if (wanted === '') return undefined;
  for (const entry of batch.entries) {
    const value = entry.fields?.['authors'];
    if (!Array.isArray(value)) continue;
    for (const name of value) {
      if (typeof name !== 'string') continue;
      if (normalizeTag(name) === wanted) return name.trim();
    }
  }
  return undefined;
}

function entryCreditsAuthor(entry: ImportEntry, authorName: string): boolean {
  const value = entry.fields?.['authors'];
  if (!Array.isArray(value)) return false;
  return value.some((name) => typeof name === 'string'
    && normalizeTag(name) === normalizeTag(authorName));
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
    const {
      entriesToImport,
      skippedExistingEntryCount,
      existingEntryIds,
      siteWorkRefs,
      knownEntryIdByEntry,
    } = partitionImportEntries(database, batch, mapping);
    assertFacet(database, mapping.canonicalTagFacetId, mapping.entryType);
    for (const fieldMapping of Object.values(mapping.fieldMappings)) {
      if (fieldMapping.kind === 'tag') {
        assertFacet(database, fieldMapping.facetId, mapping.entryType);
      }
    }

    const knownProducers = buildExistingProducerMap(database, mapping.fieldMappings);
    const createdProducerIds = new Set<number>();
    const results: ImportCommitEntryResult[] = [];
    const entryIdByEntry = new Map<ImportEntry, number>();
    let producerLinkCount = 0;
    let tagAssignmentCount = 0;
    let contentCount = 0;
    const warnings: string[] = [];

    for (const entry of entriesToImport) {
      const createdEntry = createEntryRecord(database, entry, mapping.entryType);
      entryIdByEntry.set(entry, createdEntry.id);
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

    const siteWorks = resolveBatchSiteWorks(
      database,
      batch,
      siteWorkRefs,
      entryIdByEntry,
      knownEntryIdByEntry,
    );
    for (const work of siteWorks) {
      recordSiteWork(database, work);
    }
    if (batch.origin !== undefined) {
      // The cursor is fed by every work the run carried for this listing, known
      // ones included: "we hold hitomi work 120 of this author" is what the next
      // run skips past, and a run that found nothing new still counts as a visit.
      recordCrawlObservation(database, {
        sourceSite: batch.source,
        sourceKind: batch.origin.kind,
        sourceRef: batch.origin.ref,
        displayName: batch.origin.displayName ?? null,
        url: batch.origin.url ?? null,
        works: siteWorks
          .filter((work) => work.sourceSite === batch.source)
          .map((work) => ({ sourceId: work.sourceId, workDate: work.workDate })),
      });

      // A search whose keyword is an author's name is how a creator gets imported
      // on a site that has no author page, so the creator is also registered as
      // an author. A keyword that is not an author records nothing here on
      // purpose: the works are held either way, and their identity is `site_works`.
      if (batch.origin.kind === 'search') {
        const authorName = creditedAuthor(batch, batch.origin.ref);
        if (authorName !== undefined) {
          recordCrawlObservation(database, {
            sourceSite: batch.source,
            sourceKind: 'artist',
            // Normalised, so `kakao` and `Kakao` cannot become two registry rows;
            // the card's own spelling is kept for display.
            sourceRef: normalizeTag(authorName),
            displayName: authorName,
            url: null,
            works: batch.entries.flatMap((entry, index) => {
              const work = siteWorks[index];
              if (work === undefined || work.sourceSite !== batch.source) return [];
              if (!entryCreditsAuthor(entry, authorName)) return [];
              return [{ sourceId: work.sourceId, workDate: work.workDate }];
            }),
          });
        }
      }
    }

    const authorRatingCount = applyAuthorRatings(database, mapping, knownProducers);

    return {
      entries: results,
      entryCount: results.length,
      skippedExistingEntryCount,
      existingEntryIds,
      createdProducerCount: createdProducerIds.size,
      producerLinkCount,
      tagAssignmentCount,
      contentCount,
      authorRatingCount,
      warnings,
    };
  })();
}
