import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { T3Database } from './connection.js';

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

interface MigrationFile extends AppliedMigration {
  sql: string;
}

const defaultMigrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));

function loadMigrations(directory: string): MigrationFile[] {
  const migrations = readdirSync(directory)
    .filter((name) => /^\d+_[^/\\]+\.sql$/.test(name))
    .map((name) => {
      const version = Number.parseInt(name.split('_', 1)[0] ?? '', 10);
      const sql = readFileSync(join(directory, name), 'utf8');
      return {
        version,
        name,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    })
    .sort((left, right) => left.version - right.version);

  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`duplicate migration version ${migration.version}`);
    }
    versions.add(migration.version);
  }

  return migrations;
}

export function applyAllMigrations(
  database: T3Database,
  directory = defaultMigrationsDirectory,
): MigrationResult {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedRows = database
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as AppliedMigration[];
  const appliedByVersion = new Map(appliedRows.map((migration) => [migration.version, migration]));
  const migrations = loadMigrations(directory);
  const applied: number[] = [];

  for (const migration of migrations) {
    const existing = appliedByVersion.get(migration.version);
    if (existing) {
      if (existing.name !== migration.name || existing.checksum !== migration.checksum) {
        throw new Error(`migration ${migration.version} checksum mismatch`);
      }
      continue;
    }

    database.transaction(() => {
      database.exec(migration.sql);
      database.prepare(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, migration.checksum);
    })();
    applied.push(migration.version);
  }

  const currentVersion = database
    .prepare('SELECT COALESCE(MAX(version), 0) FROM schema_migrations')
    .pluck()
    .get() as number;

  return { applied, currentVersion };
}
