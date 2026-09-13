import type { T3Database } from '../database/connection.js';
import {
  listAuthorDirectories,
  type AuthorDirectoryRecord,
  type AuthorWorkSummary,
} from './author-directory-repository.js';
import { listProducerTags, galleryTypeForProducer, type ProducerTagAssignment } from './producer-tag-repository.js';
import { listProducerRatings, type RatingRowRecord } from './rating-repository.js';
import { getProducerUsage } from './usage-repository.js';

export interface ProducerRecord {
  id: number;
  name: string;
  occupation: string | null;
  artworkRef: string | null;
  content: string | null;
}

export interface AuthorDetail extends ProducerRecord {
  /** Dominant Entry type (Gallery) of the Author's works; null with no works. */
  galleryType: string | null;
  tags: ProducerTagAssignment[];
  looseEntries: AuthorWorkSummary[];
  directories: AuthorDirectoryRecord[];
  looseEntryCount?: number | undefined;
  workTypes?: string[] | undefined;
  workCoverRefs?: string[] | undefined;
  ratings: RatingRowRecord[];
  usage: { viewCount: number; lastViewedAt: string | null };
}

export interface CreateProducerInput {
  name: string;
  occupation?: string | null | undefined;
  artworkRef?: string | null | undefined;
  content?: string | null | undefined;
}

export interface UpdateProducerInput {
  name?: string | undefined;
  occupation?: string | null | undefined;
  artworkRef?: string | null | undefined;
  content?: string | null | undefined;
}

interface ProducerRow {
  id: number;
  name: string;
  occupation: string | null;
  artwork_ref: string | null;
  content: string | null;
}

interface AuthorWorkRow {
  id: number;
  title: string;
  type: string;
  cover_ref: string | null;
  view_count: number;
  like_count: number;
  last_viewed_at: string | null;
}

function getProducer(database: T3Database, producerId: number): ProducerRecord | null {
  const row = database.prepare(`
    SELECT id, name, occupation, artwork_ref, content
    FROM producers
    WHERE id = ?
  `).get(producerId) as ProducerRow | undefined;
  return row ? {
    id: row.id,
    name: row.name,
    occupation: row.occupation,
    artworkRef: row.artwork_ref,
    content: row.content,
  } : null;
}

/** Finds a Producer by its canonical displayed name, ignoring case. */
export function findProducerIdByName(
  database: T3Database,
  name: string,
): number | undefined {
  const trimmed = name.trim();
  if (trimmed === '') return undefined;
  return database.prepare(`
    SELECT id
    FROM producers
    WHERE name = ? COLLATE NOCASE
    ORDER BY id
    LIMIT 1
  `).pluck().get(trimmed) as number | undefined;
}

export function getAuthorDetail(
  database: T3Database,
  producerId: number,
  options: { compact?: boolean } = {},
): AuthorDetail | null {
  const producer = getProducer(database, producerId);
  if (!producer) return null;
  const compact = options.compact === true;
  const looseEntries = compact ? [] : database.prepare(`
    SELECT entry.id, entry.title, entry.type, entry.cover_ref,
      COALESCE(usage.view_count, 0) AS view_count,
      COALESCE(usage.like_count, 0) AS like_count,
      usage.last_viewed_at AS last_viewed_at
    FROM entry_producers AS relation
    JOIN entries AS entry ON entry.id = relation.entry_id
    LEFT JOIN entry_usage AS usage ON usage.entry_id = entry.id
    LEFT JOIN author_directory_entries AS membership
      ON membership.producer_id = relation.producer_id
     AND membership.entry_id = relation.entry_id
    WHERE relation.producer_id = ?
      AND membership.entry_id IS NULL
    ORDER BY entry.title COLLATE NOCASE, entry.id
  `).all(producerId) as AuthorWorkRow[];
  const mappedLooseEntries = looseEntries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    type: entry.type,
    coverRef: entry.cover_ref,
    viewCount: entry.view_count,
    likeCount: entry.like_count,
    lastViewedAt: entry.last_viewed_at,
  }));
  const looseEntryCount = compact ? Number(database.prepare(`
    SELECT COUNT(*)
    FROM entry_producers AS relation
    LEFT JOIN author_directory_entries AS membership
      ON membership.producer_id = relation.producer_id
     AND membership.entry_id = relation.entry_id
    WHERE relation.producer_id = ? AND membership.entry_id IS NULL
  `).pluck().get(producerId)) : undefined;
  const workTypes = compact ? database.prepare(`
    SELECT DISTINCT entry.type
    FROM entry_producers AS relation
    JOIN entries AS entry ON entry.id = relation.entry_id
    WHERE relation.producer_id = ?
    ORDER BY entry.type COLLATE NOCASE
  `).pluck().all(producerId) as string[] : undefined;
  const workCoverRefs = compact ? (database.prepare(`
    SELECT entry.cover_ref
    FROM entry_producers AS relation
    JOIN entries AS entry ON entry.id = relation.entry_id
    WHERE relation.producer_id = ? AND entry.cover_ref IS NOT NULL
    ORDER BY entry.id
    LIMIT 4
  `).pluck().all(producerId) as string[]) : undefined;
  return {
    ...producer,
    galleryType: galleryTypeForProducer(database, producerId),
    tags: listProducerTags(database, producerId),
    looseEntries: compact ? [] : mappedLooseEntries,
    directories: listAuthorDirectories(database, producerId, compact ? 4 : undefined),
    ...(compact ? {
      looseEntryCount,
      workTypes,
      workCoverRefs,
    } : {}),
    ratings: listProducerRatings(database, producerId),
    usage: getProducerUsage(database, producerId),
  };
}

export function createProducer(
  database: T3Database,
  input: CreateProducerInput,
): ProducerRecord {
  const name = input.name.trim();
  if (name === '') {
    throw new Error('producer name cannot be empty');
  }

  const result = database.prepare(`
    INSERT INTO producers (name, occupation, artwork_ref, content)
    VALUES (?, ?, ?, ?)
  `).run(
    name,
    input.occupation ?? null,
    input.artworkRef ?? null,
    input.content ?? null,
  );
  return getProducer(database, Number(result.lastInsertRowid)) as ProducerRecord;
}

export function updateProducer(
  database: T3Database,
  producerId: number,
  input: UpdateProducerInput,
): ProducerRecord {
  if (!getProducer(database, producerId)) {
    throw new Error('producer not found');
  }

  const assignments: string[] = [];
  const values: Array<string | null> = [];
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name === '') {
      throw new Error('producer name cannot be empty');
    }
    assignments.push('name = ?');
    values.push(name);
  }
  if (Object.hasOwn(input, 'occupation')) {
    assignments.push('occupation = ?');
    values.push(input.occupation ?? null);
  }
  if (Object.hasOwn(input, 'artworkRef')) {
    assignments.push('artwork_ref = ?');
    values.push(input.artworkRef ?? null);
  }
  if (Object.hasOwn(input, 'content')) {
    assignments.push('content = ?');
    values.push(input.content ?? null);
  }

  if (assignments.length > 0) {
    database.prepare(`
      UPDATE producers
      SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...values, producerId);
  }

  return getProducer(database, producerId) as ProducerRecord;
}

export function linkEntryProducer(
  database: T3Database,
  entryId: number,
  producerId: number,
): void {
  database.prepare(`
    INSERT INTO entry_producers (entry_id, producer_id)
    VALUES (?, ?)
    ON CONFLICT(entry_id, producer_id) DO NOTHING
  `).run(entryId, producerId);
}

export function unlinkEntryProducer(
  database: T3Database,
  entryId: number,
  producerId: number,
): void {
  database.prepare(`
    DELETE FROM entry_producers
    WHERE entry_id = ? AND producer_id = ?
  `).run(entryId, producerId);
}

export function deleteProducer(database: T3Database, producerId: number): void {
  const result = database.prepare('DELETE FROM producers WHERE id = ?').run(producerId);
  if (result.changes === 0) {
    throw new Error('producer not found');
  }
}
