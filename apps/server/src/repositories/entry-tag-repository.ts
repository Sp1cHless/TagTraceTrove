import { normalizeTag } from '@t3/shared';
import type { T3Database } from '../database/connection.js';

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
      entry.page_count AS pageCount
    FROM entries AS entry
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

  return mapEntrySummaryRows(database.prepare(`
    ${entrySummarySelect}
    WHERE ${clauses.join('\n      AND ')}
    ORDER BY entry.title COLLATE NOCASE, entry.id
  `).all(...parameters));
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
