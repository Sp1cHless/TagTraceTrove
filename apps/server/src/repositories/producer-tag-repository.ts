import { normalizeTag } from '@t3/shared';
import { authorHasNsfwWorks, listNsfwGalleryTypes } from './partition-repository.js';
import { rankSearchResults } from './search-ranking.js';
import type { T3Database } from '../database/connection.js';

export interface AssignProducerTagInput {
  producerId: number;
  name: string;
}

export interface RenameProducerTagInput extends AssignProducerTagInput {
  tagId: number;
}

export interface ProducerTagAssignment {
  tagId: number;
  name: string;
  normalizedName: string;
}

export interface FindProducersInput {
  ownTagIds?: number[];
  relatedEntryTagIds?: number[];
}

export interface ProducerSummary {
  id: number;
  name: string;
  covers: string[];
  /** Dominant Entry type (Gallery) of the Author's works; null with no works. */
  galleryType: string | null;
  /** Derived from the Author's works' usage rows (sum of views / max date). */
  viewCount: number;
  likeCount: number;
  lastViewedAt: string | null;
  /** Derived: any work of the Author sits in an NSFW Gallery. */
  nsfw: boolean;
}

export interface AuthorFilterOptions {
  authorTags: Array<{ tagId: number; name: string }>;
  workTags: Array<{ tagId: number; name: string }>;
}

export interface ListAuthorFilterOptionsInput {
  entryType?: string;
  includeNsfw?: boolean;
}

/**
 * The Entry type with the most works for one Producer — the Author's home
 * Gallery badge. Tie-breaks by type name for stability.
 */
export function galleryTypeForProducer(
  database: T3Database,
  producerId: number,
): string | null {
  const row = database.prepare(`
    SELECT entry.type AS entry_type
    FROM entry_producers AS relation
    JOIN entries AS entry ON entry.id = relation.entry_id
    WHERE relation.producer_id = ?
    GROUP BY entry.type
    ORDER BY COUNT(*) DESC, entry.type COLLATE NOCASE
    LIMIT 1
  `).get(producerId) as { entry_type: string } | undefined;
  return row?.entry_type ?? null;
}

interface ProducerTagRow {
  id: number;
  name: string;
  normalized_name: string;
}

function displayTagName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function assignProducerTag(
  database: T3Database,
  input: AssignProducerTagInput,
): ProducerTagAssignment {
  const name = displayTagName(input.name);
  const normalizedName = normalizeTag(name);
  if (normalizedName === '') {
    throw new Error('producer tag name cannot be empty');
  }

  return database.transaction(() => {
    database.prepare(`
      INSERT INTO producer_tags (name, normalized_name)
      VALUES (?, ?)
      ON CONFLICT(normalized_name) DO NOTHING
    `).run(name, normalizedName);
    const tag = database.prepare(`
      SELECT id, name, normalized_name
      FROM producer_tags
      WHERE normalized_name = ?
    `).get(normalizedName) as ProducerTagRow;
    database.prepare(`
      INSERT INTO producer_tag_assignments (producer_id, tag_id)
      VALUES (?, ?)
    `).run(input.producerId, tag.id);
    return {
      tagId: tag.id,
      name: tag.name,
      normalizedName: tag.normalized_name,
    };
  })();
}

export function removeProducerTag(
  database: T3Database,
  producerId: number,
  tagId: number,
): void {
  const result = database.prepare(`
    DELETE FROM producer_tag_assignments
    WHERE producer_id = ? AND tag_id = ?
  `).run(producerId, tagId);
  if (result.changes === 0) {
    throw new Error('producer tag assignment not found');
  }
}

export function renameProducerTag(
  database: T3Database,
  input: RenameProducerTagInput,
): ProducerTagAssignment {
  const name = displayTagName(input.name);
  const normalizedName = normalizeTag(name);
  if (normalizedName === '') throw new Error('producer tag name cannot be empty');

  return database.transaction(() => {
    const assignment = database.prepare(`
      SELECT 1
      FROM producer_tag_assignments
      WHERE producer_id = ? AND tag_id = ?
    `).get(input.producerId, input.tagId);
    if (!assignment) throw new Error('producer tag assignment not found');
    database.prepare(`
      INSERT INTO producer_tags (name, normalized_name)
      VALUES (?, ?)
      ON CONFLICT(normalized_name) DO NOTHING
    `).run(name, normalizedName);
    const target = database.prepare(`
      SELECT id, name, normalized_name
      FROM producer_tags
      WHERE normalized_name = ?
    `).get(normalizedName) as ProducerTagRow;
    if (target.id !== input.tagId) {
      database.prepare(`
        DELETE FROM producer_tag_assignments
        WHERE producer_id = ? AND tag_id = ?
      `).run(input.producerId, input.tagId);
      database.prepare(`
        INSERT INTO producer_tag_assignments (producer_id, tag_id)
        VALUES (?, ?)
        ON CONFLICT(producer_id, tag_id) DO NOTHING
      `).run(input.producerId, target.id);
    }
    return {
      tagId: target.id,
      name: target.name,
      normalizedName: target.normalized_name,
    };
  })();
}

export function listProducerTags(
  database: T3Database,
  producerId: number,
): ProducerTagAssignment[] {
  const rows = database.prepare(`
    SELECT tag.id, tag.name, tag.normalized_name
    FROM producer_tag_assignments AS assignment
    JOIN producer_tags AS tag ON tag.id = assignment.tag_id
    WHERE assignment.producer_id = ?
    ORDER BY tag.normalized_name, tag.id
  `).all(producerId) as ProducerTagRow[];
  return rows.map((row) => ({
    tagId: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
  }));
}

export function listAuthorFilterOptions(
  database: T3Database,
  input: ListAuthorFilterOptionsInput = {},
): AuthorFilterOptions {
  const eligibleProducerIds = findProducers(database)
    .filter((author) => (input.includeNsfw ?? true) || !author.nsfw)
    .filter((author) => input.entryType === undefined || author.galleryType === input.entryType)
    .map((author) => author.id);
  if (eligibleProducerIds.length === 0) return { authorTags: [], workTags: [] };
  const placeholders = eligibleProducerIds.map(() => '?').join(', ');
  const authorTags = database.prepare(`
    SELECT DISTINCT tag.id AS tag_id, tag.name
    FROM producer_tag_assignments AS assignment
    JOIN producer_tags AS tag ON tag.id = assignment.tag_id
    WHERE assignment.producer_id IN (${placeholders})
    ORDER BY tag.normalized_name, tag.id
  `).all(...eligibleProducerIds) as Array<{ tag_id: number; name: string }>;
  const workTags = database.prepare(`
    SELECT DISTINCT tag.id AS tag_id, tag.name
    FROM entry_producers AS relation
    JOIN entry_tags AS assignment ON assignment.entry_id = relation.entry_id
    JOIN tags AS tag ON tag.id = assignment.tag_id
    WHERE relation.producer_id IN (${placeholders})
    ORDER BY tag.normalized_name, tag.id
  `).all(...eligibleProducerIds) as Array<{ tag_id: number; name: string }>;
  return {
    authorTags: authorTags.map((tag) => ({ tagId: tag.tag_id, name: tag.name })),
    workTags: workTags.map((tag) => ({ tagId: tag.tag_id, name: tag.name })),
  };
}

/** Case-insensitive substring search over Author names. */
export function searchProducersByName(
  database: T3Database,
  query: string,
): ProducerSummary[] {
  const rows = database.prepare(`
    SELECT producer.id, producer.name
    FROM producers AS producer
    ORDER BY producer.name COLLATE NOCASE, producer.id
  `).all() as Array<{ id: number; name: string }>;
  const coverStatement = database.prepare(`
    SELECT entry.cover_ref
    FROM entries AS entry
    JOIN entry_producers AS relation ON relation.entry_id = entry.id
    WHERE relation.producer_id = ? AND entry.cover_ref IS NOT NULL
    ORDER BY entry.id ASC
    LIMIT 4
  `);
  const usageRows = database.prepare(`
    SELECT relation.producer_id AS producer_id,
           SUM(usage.view_count) AS view_count,
           SUM(usage.like_count) AS like_count,
           MAX(usage.last_viewed_at) AS last_viewed_at
    FROM entry_producers AS relation
    JOIN entry_usage AS usage ON usage.entry_id = relation.entry_id
    GROUP BY relation.producer_id
  `).all() as Array<{ producer_id: number; view_count: number | null; like_count: number | null; last_viewed_at: string | null }>;
  const usageByProducer = new Map(usageRows.map((row) => [row.producer_id, row]));
  const nsfwTypes = listNsfwGalleryTypes(database);
  return rankSearchResults(rows, query, (row) => row.name).map((row) => {
    const usage = usageByProducer.get(row.id);
    return {
      ...row,
      covers: (coverStatement.all(row.id) as Array<{ cover_ref: string }>)
        .map((entry) => entry.cover_ref),
      galleryType: galleryTypeForProducer(database, row.id),
      viewCount: usage?.view_count ?? 0,
      likeCount: usage?.like_count ?? 0,
      lastViewedAt: usage?.last_viewed_at ?? null,
      nsfw: authorHasNsfwWorks(database, row.id, nsfwTypes),
    };
  });
}

export function findProducers(
  database: T3Database,
  input: FindProducersInput = {},
): ProducerSummary[] {
  const ownTagIds = [...new Set(input.ownTagIds ?? [])];
  const relatedEntryTagIds = [...new Set(input.relatedEntryTagIds ?? [])];
  const clauses: string[] = [];
  const values: number[] = [];

  if (ownTagIds.length > 0) {
    clauses.push(`(
      SELECT COUNT(DISTINCT assignment.tag_id)
      FROM producer_tag_assignments AS assignment
      WHERE assignment.producer_id = producer.id
        AND assignment.tag_id IN (${ownTagIds.map(() => '?').join(', ')})
    ) = ?`);
    values.push(...ownTagIds, ownTagIds.length);
  }
  if (relatedEntryTagIds.length > 0) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM entry_producers AS relation
      JOIN entry_tags AS entry_tag ON entry_tag.entry_id = relation.entry_id
      WHERE relation.producer_id = producer.id
        AND entry_tag.tag_id IN (${relatedEntryTagIds.map(() => '?').join(', ')})
      GROUP BY relation.entry_id
      HAVING COUNT(DISTINCT entry_tag.tag_id) = ?
    )`);
    values.push(...relatedEntryTagIds, relatedEntryTagIds.length);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = database.prepare(`
    SELECT producer.id, producer.name
    FROM producers AS producer
    ${where}
    ORDER BY producer.name COLLATE NOCASE, producer.id
  `).all(...values) as Array<{ id: number; name: string }>;
  const coverStatement = database.prepare(`
    SELECT entry.cover_ref
    FROM entries AS entry
    JOIN entry_producers AS relation ON relation.entry_id = entry.id
    WHERE relation.producer_id = ? AND entry.cover_ref IS NOT NULL
    ORDER BY entry.id ASC
    LIMIT 4
  `);
  // One aggregate query for every Author's derived usage (views sum, last view max).
  const usageRows = database.prepare(`
    SELECT relation.producer_id AS producer_id,
           SUM(usage.view_count) AS view_count,
           SUM(usage.like_count) AS like_count,
           MAX(usage.last_viewed_at) AS last_viewed_at
    FROM entry_producers AS relation
    JOIN entry_usage AS usage ON usage.entry_id = relation.entry_id
    GROUP BY relation.producer_id
  `).all() as Array<{ producer_id: number; view_count: number | null; like_count: number | null; last_viewed_at: string | null }>;
  const usageByProducer = new Map(usageRows.map((row) => [row.producer_id, row]));

  const nsfwTypes = listNsfwGalleryTypes(database);
  return rows.map((row) => {
    const usage = usageByProducer.get(row.id);
    return {
      ...row,
      covers: (coverStatement.all(row.id) as Array<{ cover_ref: string }>)
        .map((entry) => entry.cover_ref),
      galleryType: galleryTypeForProducer(database, row.id),
      viewCount: usage?.view_count ?? 0,
      likeCount: usage?.like_count ?? 0,
      lastViewedAt: usage?.last_viewed_at ?? null,
      nsfw: authorHasNsfwWorks(database, row.id, nsfwTypes),
    };
  });
}
