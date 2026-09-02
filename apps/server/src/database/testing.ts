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
