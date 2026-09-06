import {
  normalizeTag,
  type RatingFilterCondition,
  type RatingSort,
  type UsageFilterCondition,
  type UsageSort,
} from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { listRatingSlots, type RatingSlotRecord } from './rating-repository.js';
import { rankSearchResults } from './search-ranking.js';
import { buildUsageFilterClauses } from './usage-repository.js';

export interface AssignEntryTagInput {
  entryId: number;
  facetId: number;
  name: string;
}

export interface EntryTagAssignment {
  tagId: number;
  name: string;
  normalizedName: string;
  facetId: number;
}

export interface MoveEntryTagInput {
  entryId: number;
  tagId: number;
  targetFacetId: number;
}

export interface RenameEntryTagInput {
  entryId: number;
  tagId: number;
  name: string;
}

export interface EntryTagFilter {
  entryType?: string | undefined;
  includeTagIds?: number[];
  excludeTagIds?: number[];
}

export interface FacetFilterTagOption {
  tagId: number;
  name: string;
}

export interface FacetFilterAuthorOption {
  authorId: number;
  name: string;
}

export interface FacetFilterOption {
  facetId: number;
  facetName: string;
  sectionName: string;
  tags: FacetFilterTagOption[];
}

export interface FacetFilterOptionsResult {
  entryType: string;
  facets: FacetFilterOption[];
  allTags: FacetFilterTagOption[];
  authors: FacetFilterAuthorOption[];
  ratingSlots: RatingSlotRecord[];
}

export interface FacetFilterConditionInput {
  /** null = match the tags in ANY facet (the "all tags" row). */
  facetId: number | null;
  tagIds: number[];
}

export interface FacetFilterEntriesInput {
  entryType: string;
  conditions: FacetFilterConditionInput[];
  /** Authors OR within the list and AND with every tag condition. */
  authorIds: number[];
  /** Rating conditions AND with every tag row and the author list. */
  ratingConditions?: RatingFilterCondition[];
  /** Optional single-slot rating sort (high to low, unrated sinks). */
  ratingSort?: RatingSort | null;
  /** Usage (view tracking) conditions AND with everything above. */
  usageConditions?: UsageFilterCondition[];
  /** Optional usage sort; wins over ratingSort when both are present. */
  usageSort?: UsageSort | null;
}

export interface EntryTagLayoutApplyResult {
  entryType: string;
  entriesAffected: number;
  tagsMoved: number;
  entriesScanned: number;
}

export interface EntrySummary {
  id: number;
  title: string;
  type: string;
  coverRef: string | null;
  previewRef: string | null;
  previewRefs: string[];
  uploadDate: string | null;
  pageCount: number | null;
  viewCount: number;
  likeCount: number;
  lastViewedAt: string | null;
}

function parseSummaryPreviewRefs(previewRefs: string | null, previewRef: string | null): string[] {
  if (previewRefs) {
    try {
      const parsed: unknown = JSON.parse(previewRefs);
      if (Array.isArray(parsed)) {
        const refs = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
        if (refs.length > 0) return refs;
      }
    } catch {
      // fall through
    }
  }
  return previewRef ? [previewRef] : [];
}

export interface EntryTagUsage {
  id: number;
  name: string;
  normalizedName: string;
  entryCount: number;
}

interface TagRow {
  id: number;
  name: string;
  normalized_name: string;
}

interface AssignmentRow {
  tag_id: number;
  name: string;
  normalized_name: string;
  facet_id: number;
}

function cleanDisplayName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function assignEntryTag(
  database: T3Database,
  input: AssignEntryTagInput,
): EntryTagAssignment {
  const name = cleanDisplayName(input.name);
  const normalizedName = normalizeTag(name);
  if (normalizedName === '') {
    throw new Error('tag name cannot be empty');
  }

  return database.transaction(() => {
    database.prepare(`
      INSERT INTO tags (name, normalized_name)
      VALUES (?, ?)
      ON CONFLICT(normalized_name) DO NOTHING
    `).run(name, normalizedName);

    const tag = database.prepare(`
      SELECT id, name, normalized_name
      FROM tags
      WHERE normalized_name = ?
    `).get(normalizedName) as TagRow;

    database.prepare(`
      INSERT INTO entry_tags (entry_id, tag_id, facet_id)
      VALUES (?, ?, ?)
    `).run(input.entryId, tag.id, input.facetId);

    return {
      tagId: tag.id,
      name: tag.name,
      normalizedName: tag.normalized_name,
      facetId: input.facetId,
    };
  })();
}

export function moveEntryTag(database: T3Database, input: MoveEntryTagInput): void {
  const result = database.prepare(`
    UPDATE entry_tags
    SET facet_id = ?
    WHERE entry_id = ? AND tag_id = ?
  `).run(input.targetFacetId, input.entryId, input.tagId);
  if (result.changes === 0) {
    throw new Error('entry tag assignment not found');
  }
}

export function renameEntryTag(
  database: T3Database,
  input: RenameEntryTagInput,
): EntryTagAssignment {
  const name = cleanDisplayName(input.name);
  const normalizedName = normalizeTag(name);
  if (normalizedName === '') {
    throw new Error('tag name cannot be empty');
  }

  return database.transaction(() => {
    const assignment = database.prepare(`
      SELECT facet_id
      FROM entry_tags
      WHERE entry_id = ? AND tag_id = ?
    `).get(input.entryId, input.tagId) as { facet_id: number } | undefined;
    if (!assignment) {
      throw new Error('entry tag assignment not found');
    }

    database.prepare(`
      INSERT INTO tags (name, normalized_name)
      VALUES (?, ?)
      ON CONFLICT(normalized_name) DO NOTHING
    `).run(name, normalizedName);
    const tag = database.prepare(`
      SELECT id, name, normalized_name
      FROM tags
      WHERE normalized_name = ?
    `).get(normalizedName) as TagRow;

    database.prepare(`
      UPDATE entry_tags
      SET tag_id = ?
      WHERE entry_id = ? AND tag_id = ?
    `).run(tag.id, input.entryId, input.tagId);

    return {
      tagId: tag.id,
      name: tag.name,
      normalizedName: tag.normalized_name,
      facetId: assignment.facet_id,
    };
  })();
}

export function removeEntryTag(database: T3Database, entryId: number, tagId: number): void {
  const result = database.prepare(`
    DELETE FROM entry_tags
    WHERE entry_id = ? AND tag_id = ?
  `).run(entryId, tagId);
  if (result.changes === 0) {
    throw new Error('entry tag assignment not found');
  }
}

export function listEntryTags(
  database: T3Database,
  entryId: number,
): EntryTagAssignment[] {
  const rows = database.prepare(`
    SELECT
      tag.id AS tag_id,
      tag.name,
      tag.normalized_name,
      assignment.facet_id
    FROM entry_tags AS assignment
    JOIN tags AS tag ON tag.id = assignment.tag_id
    WHERE assignment.entry_id = ?
    ORDER BY tag.normalized_name, tag.id
  `).all(entryId) as AssignmentRow[];

  return rows.map((row) => ({
    tagId: row.tag_id,
    name: row.name,
    normalizedName: row.normalized_name,
    facetId: row.facet_id,
  }));
}

export function listEntryTagsForType(
  database: T3Database,
  entryType: string,
): EntryTagUsage[] {
  const rows = database.prepare(`
    SELECT
      tag.id,
      tag.name,
      tag.normalized_name,
      COUNT(DISTINCT assignment.entry_id) AS entry_count
    FROM entry_tags AS assignment
    JOIN tags AS tag ON tag.id = assignment.tag_id
    JOIN entries AS entry ON entry.id = assignment.entry_id
    WHERE entry.type = ?
    GROUP BY tag.id, tag.name, tag.normalized_name
    ORDER BY entry_count DESC, tag.normalized_name, tag.id
  `).all(entryType.trim()) as Array<{
    id: number;
    name: string;
    normalized_name: string;
    entry_count: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    entryCount: row.entry_count,
  }));
}

/** Same usage counts, but across every Gallery (random-tag picking). */
export function listEntryTagsGlobally(database: T3Database): EntryTagUsage[] {
  const rows = database.prepare(`
    SELECT
      tag.id,
      tag.name,
      tag.normalized_name,
      COUNT(DISTINCT assignment.entry_id) AS entry_count
    FROM entry_tags AS assignment
    JOIN tags AS tag ON tag.id = assignment.tag_id
    GROUP BY tag.id, tag.name, tag.normalized_name
    ORDER BY entry_count DESC, tag.normalized_name, tag.id
  `).all() as Array<{
    id: number;
    name: string;
    normalized_name: string;
    entry_count: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    entryCount: row.entry_count,
  }));
}

// Shared summary projection for both plain tag search and facet-filtered
// search, so entry lists stay lean and identical in shape.
const entrySummarySelect = `
    SELECT
      entry.id,
      entry.title,
      entry.type,
      entry.cover_ref AS coverRef,
      entry.preview_ref AS previewRef,
      entry.preview_refs AS previewRefs,
      entry.upload_date AS uploadDate,
      entry.page_count AS pageCount,
      COALESCE(entry_usage.view_count, 0) AS viewCount,
      COALESCE(entry_usage.like_count, 0) AS likeCount,
      entry_usage.last_viewed_at AS lastViewedAt
    FROM entries AS entry
    LEFT JOIN entry_usage AS entry_usage ON entry_usage.entry_id = entry.id
  `;

function mapEntrySummaryRows(rows: unknown[]): EntrySummary[] {
  return (rows as Array<Omit<EntrySummary, 'previewRefs'> & { previewRefs: string | null }>).map((summary) => ({
    id: summary.id,
    title: summary.title,
    type: summary.type,
    coverRef: summary.coverRef,
    previewRef: summary.previewRef,
    previewRefs: parseSummaryPreviewRefs(summary.previewRefs, summary.previewRef),
    uploadDate: summary.uploadDate,
    pageCount: summary.pageCount,
    viewCount: summary.viewCount,
    likeCount: summary.likeCount,
    lastViewedAt: summary.lastViewedAt,
  }));
}

export function findEntriesByTags(
  database: T3Database,
  filter: EntryTagFilter,
): EntrySummary[] {
  const includeTagIds = [...new Set(filter.includeTagIds ?? [])];
  const excludeTagIds = [...new Set(filter.excludeTagIds ?? [])];
  const clauses: string[] = [];
  const parameters: Array<string | number> = [];

  if (filter.entryType !== undefined) {
    clauses.push('entry.type = ?');
    parameters.push(filter.entryType.trim());
  }

  if (includeTagIds.length > 0) {
    const placeholders = includeTagIds.map(() => '?').join(', ');
    clauses.push(`(
      SELECT COUNT(DISTINCT assignment.tag_id)
      FROM entry_tags AS assignment
      WHERE assignment.entry_id = entry.id
        AND assignment.tag_id IN (${placeholders})
    ) = ?`);
    parameters.push(...includeTagIds, includeTagIds.length);
  }

  if (excludeTagIds.length > 0) {
    const placeholders = excludeTagIds.map(() => '?').join(', ');
    clauses.push(`NOT EXISTS (
      SELECT 1
      FROM entry_tags AS assignment
      WHERE assignment.entry_id = entry.id
        AND assignment.tag_id IN (${placeholders})
    )`);
    parameters.push(...excludeTagIds);
  }

  return mapEntrySummaryRows(database.prepare(`
    ${entrySummarySelect}
    ${clauses.length > 0 ? `WHERE ${clauses.join('\n      AND ')}` : ''}
    ORDER BY entry.title COLLATE NOCASE, entry.id
  `).all(...parameters));
}

/**
 * Aggregates the facet→tag options available for facet filtering within one
 * Entry type. Only NAMED facets appear as filter rows; tags sitting in an
 * unnamed default facet are still reachable through `allTags`. A tag that
 * lives under several facets in different Entries appears under each of those
 * facets (deliberately not deduplicated) — layouts can be inconsistent across
 * Entries and the filter must let the user match either placement. When
 * `authorId` is given, the aggregation is scoped to that Author's works (the
 * Author page filter), and `authors` then contains that Author alone.
 */
export function listFacetFilterOptions(
  database: T3Database,
  entryType: string,
  authorId: number | null = null,
): FacetFilterOptionsResult {
  const type = entryType.trim();
  const authorClause = authorId === null
    ? ''
    : `AND EXISTS (
      SELECT 1 FROM entry_producers AS author_link
      WHERE author_link.entry_id = entry.id AND author_link.producer_id = ?
    )`;
  const authorParameter = authorId === null ? [] : [authorId];
  const rows = database.prepare(`
    SELECT
      section.id AS section_id,
      section.name AS section_name,
      section.sort_order AS section_sort_order,
      facet.id AS facet_id,
      facet.name AS facet_name,
      facet.sort_order AS facet_sort_order,
      tag.id AS tag_id,
      tag.name AS tag_name
    FROM entry_tags AS assignment
    JOIN entries AS entry ON entry.id = assignment.entry_id
    JOIN tag_groups AS facet ON facet.id = assignment.facet_id
    JOIN tag_groups AS section ON section.id = facet.parent_id
    JOIN tags AS tag ON tag.id = assignment.tag_id
    WHERE entry.type = ?
      ${authorClause}
    GROUP BY facet.id, tag.id
    ORDER BY section.sort_order, section.id, facet.sort_order, facet.id,
      tag.name COLLATE NOCASE, tag.id
  `).all(type, ...authorParameter) as Array<{
    section_name: string;
    facet_id: number;
    facet_name: string;
    tag_id: number;
    tag_name: string;
  }>;

  const facets = new Map<number, FacetFilterOption>();
  const allTags = new Map<number, FacetFilterTagOption>();
  for (const row of rows) {
    const option = { tagId: row.tag_id, name: row.tag_name };
    allTags.set(row.tag_id, option);
    if (row.facet_name.trim() === '') continue;
    let facet = facets.get(row.facet_id);
    if (!facet) {
      facet = {
        facetId: row.facet_id,
        facetName: row.facet_name,
        sectionName: row.section_name,
        tags: [],
      };
      facets.set(row.facet_id, facet);
    }
    facet.tags.push(option);
  }

  return {
    entryType: type,
    facets: [...facets.values()],
    allTags: [...allTags.values()]
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })),
    authors: listFacetFilterAuthors(database, type, authorId),
    ratingSlots: listRatingSlots(database, 'entry', type),
  };
}

function listFacetFilterAuthors(
  database: T3Database,
  entryType: string,
  authorId: number | null = null,
): FacetFilterAuthorOption[] {
  const authorClause = authorId === null
    ? ''
    : `AND EXISTS (
      SELECT 1 FROM entry_producers AS author_link
      WHERE author_link.entry_id = entry.id AND author_link.producer_id = ?
    )`;
  const authorParameter = authorId === null ? [] : [authorId];
  const rows = database.prepare(`
    SELECT DISTINCT producer.id AS author_id, producer.name AS author_name
    FROM entry_producers AS link
    JOIN producers AS producer ON producer.id = link.producer_id
    JOIN entries AS entry ON entry.id = link.entry_id
    WHERE entry.type = ?
      ${authorClause}
    ORDER BY producer.name COLLATE NOCASE, producer.id
  `).all(entryType, ...authorParameter) as Array<{ author_id: number; author_name: string }>;
  return rows.map((row) => ({ authorId: row.author_id, name: row.author_name }));
}

/**
 * Filters Entries of one type by facet conditions. Within one condition the
 * Entry must carry EVERY listed tag id under the chosen Facet (AND — more
 * tags always narrow the result); all conditions must match (AND across
 * rows); `facetId: null` matches the tags in any facet (the "all tags" row).
 * `authorIds` OR within the list and AND with every tag condition. Returns
 * the same lean summaries as `findEntriesByTags`.
 */
export function findEntriesByFacetFilters(
  database: T3Database,
  input: FacetFilterEntriesInput,
): EntrySummary[] {
  const clauses: string[] = ['entry.type = ?'];
  const parameters: Array<string | number> = [input.entryType.trim()];

  for (const condition of input.conditions) {
    const uniqueTagIds = [...new Set(condition.tagIds)];
    const tagPlaceholders = uniqueTagIds.map(() => '?').join(', ');
    const facetClause = condition.facetId === null
      ? ''
      : 'AND assignment.facet_id = ?';
    clauses.push(`(
      SELECT COUNT(DISTINCT assignment.tag_id)
      FROM entry_tags AS assignment
      WHERE assignment.entry_id = entry.id
        AND assignment.tag_id IN (${tagPlaceholders})
        ${facetClause}
    ) = ${uniqueTagIds.length}`);
    parameters.push(...uniqueTagIds);
    if (condition.facetId !== null) {
      parameters.push(condition.facetId);
    }
  }

  const uniqueAuthorIds = [...new Set(input.authorIds ?? [])];
  if (uniqueAuthorIds.length > 0) {
    const authorPlaceholders = uniqueAuthorIds.map(() => '?').join(', ');
    clauses.push(`EXISTS (
      SELECT 1 FROM entry_producers AS link
      WHERE link.entry_id = entry.id
        AND link.producer_id IN (${authorPlaceholders})
    )`);
    parameters.push(...uniqueAuthorIds);
  }

  // Rating conditions narrow within the type's shared slots: eq/gt/lt compare
  // the given stars (an unrated NULL never satisfies a comparison), unrated
  // matches entries whose slot has no value yet.
  for (const condition of input.ratingConditions ?? []) {
    requireRatingSlot(database, condition.slotId, input.entryType.trim());
    if (condition.operator === 'unrated') {
      clauses.push(`NOT EXISTS (
        SELECT 1 FROM entry_rating_values AS rating
        WHERE rating.entry_id = entry.id
          AND rating.slot_id = ?
          AND rating.stars IS NOT NULL
      )`);
      parameters.push(condition.slotId);
      continue;
    }
    const comparison = condition.operator === 'eq' ? '=' : condition.operator === 'gt' ? '>' : '<';
    clauses.push(`EXISTS (
      SELECT 1 FROM entry_rating_values AS rating
      WHERE rating.entry_id = entry.id
        AND rating.slot_id = ?
        AND rating.stars ${comparison} ?
    )`);
    // The schema refine guarantees stars is non-null for eq/gt/lt.
    parameters.push(condition.slotId, condition.stars as number);
  }

  // Rating sort: high to low with unrated sinking below every rated entry.
  const ratingSort = input.ratingSort ?? null;
  let ratingSortJoin = '';
  let orderClause = 'ORDER BY entry.title COLLATE NOCASE, entry.id';
  if (ratingSort) {
    requireRatingSlot(database, ratingSort.slotId, input.entryType.trim());
    ratingSortJoin = 'LEFT JOIN entry_rating_values AS rating_sort\n      ON rating_sort.entry_id = entry.id AND rating_sort.slot_id = ?';
    orderClause = 'ORDER BY (rating_sort.stars IS NULL) ASC, rating_sort.stars DESC, entry.title COLLATE NOCASE, entry.id';
  }

  // Usage conditions and sort (usage sort wins over the rating sort).
  const usageClauses = buildUsageFilterClauses(
    database,
    input.usageConditions ?? [],
    input.usageSort ?? null,
  );
  if (usageClauses.sql) {
    clauses.push(usageClauses.sql);
    parameters.push(...usageClauses.parameters);
  }
  if (input.usageSort) {
    orderClause = usageClauses.orderSql;
  }

  return mapEntrySummaryRows(database.prepare(`
    ${entrySummarySelect}
    ${ratingSortJoin}
    WHERE ${clauses.join('\n      AND ')}
    ${orderClause}
  `).all(...(ratingSort ? [ratingSort.slotId, ...parameters] : parameters)));
}

/**
 * Ranked global title search. The local library is small enough to score in
 * memory, keeping punctuation literal while allowing bounded typo tolerance.
 * Optional entryType restricts the search to one Gallery.
 */
export function searchEntriesByTitle(
  database: T3Database,
  query: string,
  entryType: string | null = null,
): EntrySummary[] {
  const clause = entryType === null ? '' : 'WHERE entry.type = ?';
  const parameters = entryType === null ? [] : [entryType];
  const entries = mapEntrySummaryRows(database.prepare(`
    ${entrySummarySelect}
    ${clause}
    ORDER BY entry.title COLLATE NOCASE, entry.id
  `).all(...parameters));
  return rankSearchResults(entries, query, (entry) => entry.title);
}

/** Ranked search over Entry Tags, optionally limited to SFW Gallery usage. */
export function searchEntryTags(
  database: T3Database,
  query: string,
  includeNsfw = true,
): Array<{ tagId: number; name: string; normalizedName: string; entryCount: number }> {
  const rows = database.prepare(`
    SELECT tag.id AS tag_id, tag.name AS name, tag.normalized_name AS normalized_name,
      (
        SELECT COUNT(*)
        FROM entry_tags AS assignment
        JOIN entries AS entry ON entry.id = assignment.entry_id
        LEFT JOIN gallery_settings AS gallery ON gallery.entry_type = entry.type
        WHERE assignment.tag_id = tag.id
          AND (? = 1 OR COALESCE(gallery.nsfw, 0) = 0)
      ) AS entry_count
    FROM tags AS tag
    ORDER BY tag.name COLLATE NOCASE, tag.id
  `).all(includeNsfw ? 1 : 0) as Array<{ tag_id: number; name: string; normalized_name: string; entry_count: number }>;
  const hits = rows
    .map((row) => ({
      tagId: row.tag_id,
      name: row.name,
      normalizedName: row.normalized_name,
      entryCount: row.entry_count,
    }))
    .filter((hit) => includeNsfw || hit.entryCount > 0);
  return rankSearchResults(hits, query, (hit) => hit.name);
}

function requireRatingSlot(
  database: T3Database,
  slotId: number,
  entryType: string,
): void {
  const row = database.prepare(`
    SELECT 1
    FROM rating_slots
    WHERE id = ? AND subject_kind = 'entry' AND entry_type = ?
  `).get(slotId, entryType);
  if (!row) {
    throw new Error(
      `cannot filter: rating slot ${slotId} does not belong to the entry Gallery "${entryType}"`,
    );
  }
}

/**
 * Applies the source Entry's tag placement as the standard for every OTHER
 * Entry of the same type: each tag the source carries is moved, in any peer
 * Entry that has the same tag under a different Facet, onto the source's
 * Facet. Peers that do not carry the tag are untouched; tags the source does
 * not carry are never relocated. The layout is shared per type, so the source
 * Facet always exists for every peer — nothing is skipped as a structural
 * conflict, and the source Entry itself is never modified.
 */
export function applyEntryTagLayout(
  database: T3Database,
  sourceEntryId: number,
): EntryTagLayoutApplyResult {
  const entry = database.prepare('SELECT id, type FROM entries WHERE id = ?')
    .get(sourceEntryId) as { id: number; type: string } | undefined;
  if (!entry) {
    throw new Error('entry not found');
  }
  const entryType = entry.type.trim();

  return database.transaction(() => {
    const assignments = database.prepare(`
      SELECT tag_id, facet_id
      FROM entry_tags
      WHERE entry_id = ?
    `).all(sourceEntryId) as Array<{ tag_id: number; facet_id: number }>;

    const entriesScanned = database.prepare(
      'SELECT COUNT(*) AS n FROM entries WHERE type = ? AND id <> ?',
    ).get(entryType, sourceEntryId) as { n: number };

    if (assignments.length === 0) {
      return {
        entryType,
        entriesAffected: 0,
        tagsMoved: 0,
        entriesScanned: entriesScanned.n,
      };
    }

    const peersClause = 'entry_id IN (SELECT id FROM entries WHERE type = ? AND id <> ?)';
    const selectMisplaced = database.prepare(
      `SELECT DISTINCT entry_id
       FROM entry_tags
       WHERE tag_id = ? AND facet_id <> ? AND ${peersClause}`,
    );
    const syncTag = database.prepare(
      `UPDATE entry_tags SET facet_id = ?
       WHERE tag_id = ? AND facet_id <> ? AND ${peersClause}`,
    );

    const affectedEntries = new Set<number>();
    let tagsMoved = 0;
    for (const assignment of assignments) {
      const misplaced = selectMisplaced.all(
        assignment.tag_id,
        assignment.facet_id,
        entryType,
        sourceEntryId,
      ) as Array<{ entry_id: number }>;
      if (misplaced.length === 0) continue;
      for (const row of misplaced) {
        affectedEntries.add(row.entry_id);
      }
      tagsMoved += syncTag.run(
        assignment.facet_id,
        assignment.tag_id,
        assignment.facet_id,
        entryType,
        sourceEntryId,
      ).changes;
    }

    return {
      entryType,
      entriesAffected: affectedEntries.size,
      tagsMoved,
      entriesScanned: entriesScanned.n,
    };
  })();
}

// ---------------------------------------------------------------------------
// Unassigned-tag cleanup (tags sitting in a type's unnamed default Facet)
// ---------------------------------------------------------------------------

export interface UnassignedTagSuggestion {
  facetId: number;
  facetName: string;
  count: number;
}

export interface UnassignedTagItem {
  tagId: number;
  tagName: string;
  /** Entries carrying this tag in the unnamed default Facet (the ones to move). */
  entryCount: number;
  /** Where the OTHER entries of this type keep this tag, if anywhere. */
  suggestion: UnassignedTagSuggestion | null;
}

export interface UnassignedTagGroup {
  entryType: string;
  /** Named Facets of this type, the valid move targets. */
  facets: Array<{ facetId: number; facetName: string }>;
  tags: UnassignedTagItem[];
}

/**
 * Every type's tags that still sit in the unnamed default Facet ("未分类").
 * The tag vocabulary is global and Facets belong to one type, so grouping is
 * per type: the same tag name may be unassigned in one type and classified in
 * another, and each type's move targets are its own named Facets. Each item
 * carries a suggestion = the named Facet where the REST of this type's
 * entries keep that tag (majority by entry count).
 */
export function listUnassignedTags(database: T3Database): UnassignedTagGroup[] {
  const entryTypes = database.prepare(
    'SELECT DISTINCT type FROM entries ORDER BY type COLLATE NOCASE',
  ).all() as Array<{ type: string }>;

  const groups: UnassignedTagGroup[] = [];
  for (const { type } of entryTypes) {
    const entryType = type.trim();
    const unnamed = database.prepare(
      `SELECT id FROM tag_groups
       WHERE entry_type = ? AND group_kind = 'facet' AND name = ''
       ORDER BY id LIMIT 1`,
    ).get(entryType) as { id: number } | undefined;
    if (!unnamed) continue;

    const facetRows = database.prepare(
      `SELECT id AS facetId, name AS facetName
       FROM tag_groups
       WHERE entry_type = ? AND group_kind = 'facet' AND name <> ''
       ORDER BY sort_order, id`,
    ).all(entryType) as Array<{ facetId: number; facetName: string }>;

    const unassignedRows = database.prepare(`
      SELECT tags.id AS tagId, tags.name AS tagName, COUNT(*) AS entryCount
      FROM entry_tags AS assignment
      JOIN entries ON entries.id = assignment.entry_id
      JOIN tags ON tags.id = assignment.tag_id
      WHERE entries.type = ? AND assignment.facet_id = ?
      GROUP BY tags.id, tags.name
      ORDER BY tags.name COLLATE NOCASE
    `).all(entryType, unnamed.id) as Array<{ tagId: number; tagName: string; entryCount: number }>;

    if (unassignedRows.length === 0) continue;

    const tagIds = unassignedRows.map((row) => row.tagId);
    const placeholders = tagIds.map(() => '?').join(', ');
    const placementRows = database.prepare(`
      SELECT assignment.tag_id AS tagId, facet.id AS facetId,
             facet.name AS facetName, COUNT(*) AS count
      FROM entry_tags AS assignment
      JOIN entries ON entries.id = assignment.entry_id
      JOIN tag_groups AS facet ON facet.id = assignment.facet_id
      WHERE entries.type = ? AND facet.name <> '' AND assignment.tag_id IN (${placeholders})
      GROUP BY assignment.tag_id, facet.id, facet.name
    `).all(entryType, ...tagIds) as Array<{
      tagId: number;
      facetId: number;
      facetName: string;
      count: number;
    }>;

    const bestByTag = new Map<number, UnassignedTagSuggestion>();
    for (const row of placementRows) {
      const current = bestByTag.get(row.tagId);
      if (!current || row.count > current.count
        || (row.count === current.count && row.facetId < current.facetId)) {
        bestByTag.set(row.tagId, {
          facetId: row.facetId,
          facetName: row.facetName,
          count: row.count,
        });
      }
    }

    groups.push({
      entryType,
      facets: facetRows,
      tags: unassignedRows.map((row) => ({
        tagId: row.tagId,
        tagName: row.tagName,
        entryCount: row.entryCount,
        suggestion: bestByTag.get(row.tagId) ?? null,
      })),
    });
  }
  return groups;
}

export interface MoveUnassignedTagInput {
  entryType: string;
  tagId: number;
  targetFacetId: number;
}

export interface MoveUnassignedTagResult {
  entryType: string;
  tagId: number;
  moved: number;
  targetFacetId: number;
}

/**
 * Moves every assignment of ONE tag that sits in this type's unnamed default
 * Facet onto a named target Facet of the same type. Assignments that are
 * already classified (named Facet) are untouched; other types are never
 * touched (their unnamed Facet is a different row and their named Facets may
 * legitimately disagree). Requires the exact same type on both sides.
 */
export function moveUnassignedTagToFacet(
  database: T3Database,
  input: MoveUnassignedTagInput,
): MoveUnassignedTagResult {
  const entryType = input.entryType.trim();
  const target = database.prepare(
    `SELECT id FROM tag_groups
     WHERE entry_type = ? AND group_kind = 'facet' AND id = ?`,
  ).get(entryType, input.targetFacetId) as { id: number } | undefined;
  if (!target) {
    throw new Error(`cannot move tag into a facet of another type`);
  }

  const unnamed = database.prepare(
    `SELECT id FROM tag_groups
     WHERE entry_type = ? AND group_kind = 'facet' AND name = ''
     ORDER BY id LIMIT 1`,
  ).get(entryType) as { id: number } | undefined;
  if (!unnamed) {
    throw new Error(`type has no unnamed default facet`);
  }
  if (unnamed.id === input.targetFacetId) {
    throw new Error('cannot move tags into the unnamed default facet');
  }

  const moved = database.prepare(`
    UPDATE entry_tags SET facet_id = ?
    WHERE tag_id = ?
      AND facet_id = ?
      AND entry_id IN (SELECT id FROM entries WHERE type = ?)
  `).run(input.targetFacetId, input.tagId, unnamed.id, entryType).changes;

  return {
    entryType,
    tagId: input.tagId,
    moved,
    targetFacetId: input.targetFacetId,
  };
}
