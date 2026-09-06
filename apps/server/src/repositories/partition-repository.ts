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
