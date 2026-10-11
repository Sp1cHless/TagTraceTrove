import type { T3Database } from '../database/connection.js';

/**
 * The order the sidebar lists Galleries in.
 *
 * A Gallery is a projection of `entries.type`, so it has no row of its own and the list used to fall
 * back to the alphabet — stable, but not the person's order: measured on a real library with seven
 * galleries, the two used every day sat wherever their spelling put them and there was no way to move
 * one. This is that order, stored sparsely per type.
 *
 * The write is the **whole list**, not a pair of neighbours, and that is deliberate: a swap of two
 * rows leaves every other Gallery in the alphabet, which is an order nobody can predict from looking
 * at it. Writing all of them makes the order total, and a Gallery created later simply has no row and
 * sorts after the ones that do.
 */
export function listGalleryOrder(database: T3Database): string[] {
  return database.prepare(`
    SELECT entry_type
    FROM gallery_order
    ORDER BY sort_order, entry_type COLLATE NOCASE
  `).pluck().all() as string[];
}

/** Writes the order as given, in one transaction: the list a person sees becomes the list stored. */
export function setGalleryOrder(database: T3Database, entryTypes: string[]): string[] {
  const types: string[] = [];
  for (const raw of entryTypes) {
    const type = raw.trim();
    // One Gallery appears once, and an empty name is not a Gallery: a list that repeats or empties
    // itself would be written as an order with a hole in it.
    if (type === '' || types.includes(type)) {
      throw new Error(`Gallery order must name each Gallery once: ${JSON.stringify(raw)}`);
    }
    types.push(type);
  }
  return database.transaction(() => {
    database.prepare('DELETE FROM gallery_order').run();
    const insert = database.prepare(
      'INSERT INTO gallery_order (entry_type, sort_order) VALUES (?, ?)',
    );
    types.forEach((type, index) => insert.run(type, index));
    database.prepare('UPDATE gallery_order_scope SET sync_version=sync_version+1 WHERE id=1').run();
    return types;
  })();
}
