import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type T3Database } from './connection.js';
import { applyAllMigrations } from './migrations.js';

export interface TempFileDatabase {
  database: T3Database;
  path: string;
  cleanup: () => void;
}

export function createMemoryDatabase(): T3Database {
  return openDatabase(':memory:');
}

export function createMigratedMemoryDatabase(): T3Database {
  const database = createMemoryDatabase();
  applyAllMigrations(database);
  return database;
}

/**
 * Populate a database whose schema is older than today's, for the incremental-migration fixtures.
 *
 * Those fixtures apply migrations one version at a time and need something in the database while
 * they do it — a work for a later migration to adopt, re-key, or prune. `createEntry` cannot serve
 * them: it names every column an Entry has *today*, and a schema from before one of those columns
 * existed rejects the statement outright. This writes the two columns an Entry has always had, so
 * such a fixture keeps meaning "a work that existed at that version" rather than "a work written by
 * the current build".
 */
export function insertLegacyEntry(
  database: T3Database,
  input: { title: string; type: string },
): { id: number } {
  const result = database.prepare('INSERT INTO entries (title, type) VALUES (?, ?)')
    .run(input.title, input.type);
  return { id: Number(result.lastInsertRowid) };
}

/**
 * The same, for the link between a work and an Author.
 *
 * `linkEntryProducer` also anchors the Author's Gallery (`producers.gallery_anchor`, added by
 * `039`), which a schema older than that migration has no column for — so these fixtures write the
 * link alone. The anchor is a fact about today's model, not about the Work–Author link itself.
 */
export function linkLegacyEntryProducer(
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

export function createTempFileDatabase(): TempFileDatabase {
  const directory = mkdtempSync(join(tmpdir(), 't3-db-test-'));
  const path = join(directory, 'library.db');
  const database = openDatabase(path);

  return {
    database,
    path,
    cleanup: () => {
      if (database.open) {
        database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
