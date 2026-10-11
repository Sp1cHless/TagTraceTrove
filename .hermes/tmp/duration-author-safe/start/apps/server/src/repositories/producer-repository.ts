import { normalizeTag } from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { toSimplified } from '../taxonomy/simplify.js';
import {
  listAuthorDirectories,
  type AuthorDirectoryRecord,
  type AuthorWorkSummary,
} from './author-directory-repository.js';
import {
  galleryTypeForProducer,
  listProducerTags,
  pruneUnusedProducerTags,
  type ProducerTagAssignment,
} from './producer-tag-repository.js';
import { listAuthorSelfRatings, listProducerRatings, type RatingRowRecord } from './rating-repository.js';
import { getProducerUsage } from './usage-repository.js';
import { resolveTaxonomyName } from './taxonomy-repository.js';

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
  /** The author's own dimensions; never inherited by a work. */
  authorSelfRatings: RatingRowRecord[];
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
    // The author's own dimensions, beside the works summary rather than mixed into it: they describe
    // the person or the studio, and no work ever inherits them.
    authorSelfRatings: listAuthorSelfRatings(database, producerId),
    usage: getProducerUsage(database, producerId),
  };
}

export function createProducer(
  database: T3Database,
  input: CreateProducerInput,
): ProducerRecord {
  // Simplified, like every other name the library stores: a site that spells its authors in
  // Traditional must not create a second author beside the one an import already made.
  const name = toSimplified(input.name.trim());
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
    const name = toSimplified(input.name.trim());
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
  // Deliberately does NOT touch `producers.gallery_anchor`. Freezing the anchor here would make an
  // Author's Gallery depend on which work happened to be linked first — two Authors with the same
  // works could show different badges — and the derivation still answers for an Author that has no
  // anchor. Anchoring is a stored fact `039` filled for every existing Author and a person can set
  // explicitly; an Author created since then keeps deriving until they do.
  database.prepare(`
    INSERT INTO entry_producers (entry_id, producer_id)
    VALUES (?, ?)
    ON CONFLICT(entry_id, producer_id) DO NOTHING
  `).run(entryId, producerId);
}

export interface LinkedEntryAuthor {
  entryId: number;
  producerId: number;
  producerName: string;
  /** true when no existing author matched and a new one had to be created. */
  created: boolean;
  /** The typed spelling when it resolved through the author dictionary. */
  matchedAlias?: string;
}

/** Display form of a typed author name: NFKC, trimmed, single spaces, and the
 * original casing kept so the stored name reads the way the user typed it. */
function authorDisplayForm(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

/** Finds an existing Producer by its normalized name (NFKC, lower, collapsed
 * whitespace), so "Yuki", "yuki" and "YUki " all resolve to one author. */
function findProducerIdByNormalizedName(database: T3Database, name: string): number | undefined {
  const normalized = normalizeTag(name);
  if (normalized === '') return undefined;
  const rows = database.prepare('SELECT id, name FROM producers ORDER BY id').all() as Array<{
    id: number;
    name: string;
  }>;
  return rows.find((row) => normalizeTag(row.name) === normalized)?.id;
}

/**
 * "Save author" that never duplicates: the typed name is resolved against
 * existing Authors (exact name, then the author dictionary's alias graph) and
 * the match is linked; only a genuinely new name creates a Producer. This is
 * what the Entry editor's "+ Author" and "Link Author" both end up doing, so
 * a name that already exists can no longer spawn a second author row.
 */
export function linkOrCreateEntryAuthor(
  database: T3Database,
  entryId: number,
  rawName: string,
): LinkedEntryAuthor {
  const name = authorDisplayForm(rawName);
  if (name === '') throw new Error('Author name cannot be empty');

  const canonical = resolveTaxonomyName(database, 'producer', name);
  const candidates = canonical === name ? [name] : [name, canonical];

  for (const candidate of candidates) {
    const existingId = findProducerIdByName(database, candidate)
      ?? findProducerIdByNormalizedName(database, candidate);
    if (existingId !== undefined) {
      linkEntryProducer(database, entryId, existingId);
      const producer = getProducer(database, existingId) as ProducerRecord;
      return {
        entryId,
        producerId: existingId,
        producerName: producer.name,
        created: false,
        ...(canonical === name ? {} : { matchedAlias: name }),
      };
    }
  }

  const created = createProducer(database, { name: canonical });
  linkEntryProducer(database, entryId, created.id);
  return {
    entryId,
    producerId: created.id,
    producerName: created.name,
    created: true,
    ...(canonical === name ? {} : { matchedAlias: name }),
  };
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
  pruneWorklessProducers(database, [producerId]);
}

/**
 * An Author exists to hold works, and every import carries its Author info with
 * the work, so an Author left holding none is residue. Every path that can take
 * an Author's last work away calls this: unlinking, deleting or merging an Entry,
 * and an Author merge that leaves a keeper blank. A named set is passed rather
 * than sweeping the table, so an Author someone just created by hand — one that
 * never had a work yet — is not silently deleted.
 */
export function pruneWorklessProducers(database: T3Database, producerIds: number[]): number {
  const unique = [...new Set(producerIds)];
  if (unique.length === 0) return 0;
  const placeholders = unique.map(() => '?').join(', ');
  const tagStatement = database.prepare(
    'SELECT tag_id AS tagId FROM producer_tag_assignments WHERE producer_id = ?',
  ).pluck();
  const heldTagIds = unique.flatMap((producerId) => tagStatement.all(producerId) as number[]);
  const result = database.prepare(`
    DELETE FROM producers
    WHERE id IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1 FROM entry_producers WHERE entry_producers.producer_id = producers.id
      )
  `).run(...unique);
  // The Tags those Authors were carrying follow the same rule as the work side.
  if (heldTagIds.length > 0) pruneUnusedProducerTags(database, heldTagIds);
  return result.changes;
}

export function deleteProducer(database: T3Database, producerId: number): void {
  database.transaction(() => {
    const heldTagIds = database.prepare(
      'SELECT tag_id AS tagId FROM producer_tag_assignments WHERE producer_id = ?',
    ).pluck().all(producerId) as number[];
    const result = database.prepare('DELETE FROM producers WHERE id = ?').run(producerId);
    if (result.changes === 0) {
      throw new Error('producer not found');
    }
    pruneUnusedProducerTags(database, heldTagIds);
  })();
}
