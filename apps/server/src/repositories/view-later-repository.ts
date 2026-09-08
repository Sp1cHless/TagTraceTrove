import type { T3Database } from '../database/connection.js';

function entryExists(database: T3Database, entryId: number): boolean {
  return Boolean(database.prepare('SELECT 1 FROM entries WHERE id = ?').get(entryId));
}

function requireEntry(database: T3Database, entryId: number): void {
  if (!entryExists(database, entryId)) {
    throw new Error('entry not found');
  }
}

function insertViewLaterEntry(database: T3Database, entryId: number): void {
  requireEntry(database, entryId);
  const nextPosition = database.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 FROM view_later_entries',
  ).pluck().get() as number;
  database.prepare(`
    INSERT INTO view_later_entries (entry_id, position)
    VALUES (?, ?)
    ON CONFLICT (entry_id) DO NOTHING
  `).run(entryId, nextPosition);
}

export function listViewLaterEntryIds(database: T3Database): number[] {
  return database.prepare(`
    SELECT entry_id
    FROM view_later_entries
    ORDER BY position, entry_id
  `).pluck().all() as number[];
}

export function addViewLaterEntry(database: T3Database, entryId: number): number[] {
  insertViewLaterEntry(database, entryId);
  return listViewLaterEntryIds(database);
}

export function mergeViewLaterEntries(database: T3Database, entryIds: number[]): number[] {
  database.transaction(() => {
    for (const entryId of new Set(entryIds)) {
      // Legacy localStorage can retain an id after its Entry was deleted.
      // A migration merge keeps every surviving membership instead of failing
      // the whole import because one stale browser-local id no longer exists.
      if (entryExists(database, entryId)) insertViewLaterEntry(database, entryId);
    }
  })();
  return listViewLaterEntryIds(database);
}

export function removeViewLaterEntry(database: T3Database, entryId: number): number[] {
  database.prepare('DELETE FROM view_later_entries WHERE entry_id = ?').run(entryId);
  return listViewLaterEntryIds(database);
}

function requireProducer(database: T3Database, producerId: number): void {
  const exists = database.prepare('SELECT 1 FROM producers WHERE id = ?').get(producerId);
  if (!exists) throw new Error('producer not found');
}

export function listViewLaterProducerIds(database: T3Database): number[] {
  return database.prepare(`
    SELECT producer_id
    FROM view_later_producers
    ORDER BY position, producer_id
  `).pluck().all() as number[];
}

export function addViewLaterProducer(database: T3Database, producerId: number): number[] {
  requireProducer(database, producerId);
  const nextPosition = database.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 FROM view_later_producers',
  ).pluck().get() as number;
  database.prepare(`
    INSERT INTO view_later_producers (producer_id, position)
    VALUES (?, ?)
    ON CONFLICT (producer_id) DO NOTHING
  `).run(producerId, nextPosition);
  return listViewLaterProducerIds(database);
}

export function removeViewLaterProducer(database: T3Database, producerId: number): number[] {
  database.prepare('DELETE FROM view_later_producers WHERE producer_id = ?').run(producerId);
  return listViewLaterProducerIds(database);
}
