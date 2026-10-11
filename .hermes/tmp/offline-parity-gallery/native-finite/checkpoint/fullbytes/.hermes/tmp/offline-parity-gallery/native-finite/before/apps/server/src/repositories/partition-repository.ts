import type { T3Database } from '../database/connection.js';

/**
 * Whole-Gallery partition: every Entry of one type shares SFW/NSFW. The
 * partition row is created lazily on first toggle (default SFW). Author
 * partitioning is derived: an Author with any work in an NSFW Gallery is an
 * NSFW Author.
 */
export function isNsfwGallery(database: T3Database, entryType: string): boolean {
  const row = database.prepare(
    'SELECT nsfw FROM gallery_settings WHERE entry_type = ?',
  ).get(entryType) as { nsfw: number } | undefined;
  return row?.nsfw === 1;
}

export function setGalleryPartition(
  database: T3Database,
  entryType: string,
  nsfw: boolean,
): void {
  database.prepare(`
    INSERT INTO gallery_settings (entry_type, nsfw) VALUES (?, ?)
    ON CONFLICT (entry_type) DO UPDATE SET nsfw = excluded.nsfw
  `).run(entryType, nsfw ? 1 : 0);
}

/**
 * One aggregate query: the set of Gallery types currently marked NSFW. The
 * caller keeps the visibility switch (show NSFW) out of the database.
 */
export function listNsfwGalleryTypes(database: T3Database): Set<string> {
  const rows = database.prepare(
    'SELECT entry_type FROM gallery_settings WHERE nsfw = 1',
  ).all() as Array<{ entry_type: string }>;
  return new Set(rows.map((row) => row.entry_type));
}

/**
 * Derives Author partitioning: true when ANY work of the Author sits in an
 * NSFW Gallery.
 */
export function authorHasNsfwWorks(
  database: T3Database,
  producerId: number,
  nsfwTypes: Set<string>,
): boolean {
  if (nsfwTypes.size === 0) return false;
  const rows = database.prepare(`
    SELECT DISTINCT entry.type AS type
    FROM entry_producers AS relation
    JOIN entries AS entry ON entry.id = relation.entry_id
    WHERE relation.producer_id = ?
  `).all(producerId) as Array<{ type: string }>;
  return rows.some((row) => nsfwTypes.has(row.type));
}

export interface NavigationCounts {
  authors: number;
  viewLaterEntries: number;
  viewLaterAuthors: number;
}

/**
 * The Authors page only ever lists an Author that holds at least one work, so the
 * sidebar counts the same universe — a work-less row is not a visible Author.
 */
const AUTHOR_HAS_WORK = `EXISTS (
  SELECT 1 FROM entry_producers AS visible_relation
  WHERE visible_relation.producer_id = producer.id
)`;

/** Author is NSFW when any of their works sits in an NSFW Gallery. */
const NSFW_AUTHOR = `EXISTS (
  SELECT 1
  FROM entry_producers AS relation
  JOIN entries AS entry ON entry.id = relation.entry_id
  JOIN gallery_settings AS partition ON partition.entry_type = entry.type
  WHERE relation.producer_id = producer.id AND partition.nsfw = 1
)`;

/**
 * The sidebar's counts under the current visibility boundary. One query set owns
 * "how many are visible", so no surface has to re-derive the partition rules and
 * drift from them — the numbers here always match what those pages can list.
 * Saved subjects whose row is gone are not counted, because they cannot be shown.
 */
export function readNavigationCounts(
  database: T3Database,
  options: { includeNsfw?: boolean } = {},
): NavigationCounts {
  const includeNsfw = options.includeNsfw !== false;
  const count = (sql: string): number => Number(database.prepare(sql).pluck().get());
  const hiddenEntry = includeNsfw
    ? ''
    : `AND NOT EXISTS (
        SELECT 1 FROM gallery_settings AS partition
        WHERE partition.entry_type = entry.type AND partition.nsfw = 1
      )`;

  const authors = includeNsfw
    ? count(`SELECT COUNT(*) FROM producers AS producer WHERE ${AUTHOR_HAS_WORK}`)
    : count(`SELECT COUNT(*) FROM producers AS producer
        WHERE ${AUTHOR_HAS_WORK} AND NOT ${NSFW_AUTHOR}`);
  const viewLaterEntries = count(`
    SELECT COUNT(*)
    FROM view_later_entries AS saved
    JOIN entries AS entry ON entry.id = saved.entry_id
    ${hiddenEntry}
  `);
  const viewLaterAuthors = count(`
    SELECT COUNT(*)
    FROM view_later_producers AS saved
    JOIN producers AS producer ON producer.id = saved.producer_id
    WHERE ${AUTHOR_HAS_WORK} ${includeNsfw ? '' : `AND NOT ${NSFW_AUTHOR}`}
  `);

  return { authors, viewLaterEntries, viewLaterAuthors };
}
