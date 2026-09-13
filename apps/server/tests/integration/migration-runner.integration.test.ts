import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import { createMemoryDatabase, createTempFileDatabase } from '../../src/database/testing.js';

const sourceMigration = fileURLToPath(
  new URL('../../src/database/migrations/001_initial.sql', import.meta.url),
);
const sourceMigrationsDirectory = fileURLToPath(
  new URL('../../src/database/migrations/', import.meta.url),
);

describe('migration runner', () => {
  it('applies each migration once and records its checksum', () => {
    const database = createMemoryDatabase();

    try {
      expect(applyAllMigrations(database)).toEqual({ applied: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], currentVersion: 15 });
      expect(applyAllMigrations(database)).toEqual({ applied: [], currentVersion: 15 });
      expect(database.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(15);
      const sourceTables = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'source_%'
        ORDER BY name
      `).pluck().all();
      expect(sourceTables).toEqual([
        'source_maintenance_items',
        'source_maintenance_runs',
        'source_statuses',
      ]);
      const indexes = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'idx_entries_page_%'
        ORDER BY name
      `).pluck().all();
      expect(indexes).toEqual([
        'idx_entries_page_date',
        'idx_entries_page_title',
      ]);
    } finally {
      database.close();
    }
  });

  it('upgrades a populated temporary file database from 12 to 13 without changing data', () => {
    const directory = mkdtempSync(join(tmpdir(), 't3-migrations-12-to-13-'));
    const temp = createTempFileDatabase();
    try {
      const migrationNames = readdirSync(sourceMigrationsDirectory)
        .filter((name) => /^\d+_.+\.sql$/u.test(name));
      for (const name of migrationNames.filter((name) => Number.parseInt(name, 10) <= 12)) {
        copyFileSync(join(sourceMigrationsDirectory, name), join(directory, name));
      }
      expect(applyAllMigrations(temp.database, directory).currentVersion).toBe(12);
      temp.database.prepare('INSERT INTO entries (title, type, upload_date) VALUES (?, ?, ?)')
        .run('Preserved', 'comic', '2026-09-08');
      const entryId = Number(temp.database.prepare('SELECT id FROM entries').pluck().get());
      temp.database.prepare('INSERT INTO entry_usage (entry_id, view_count, like_count) VALUES (?, ?, ?)')
        .run(entryId, 7, 3);
      const before = temp.database.prepare(`
        SELECT entry.title, entry.type, entry.upload_date, usage.view_count, usage.like_count
        FROM entries AS entry
        JOIN entry_usage AS usage ON usage.entry_id = entry.id
      `).get();

      const migration13 = migrationNames.find((name) => name.startsWith('013_'))!;
      copyFileSync(join(sourceMigrationsDirectory, migration13), join(directory, migration13));
      expect(applyAllMigrations(temp.database, directory)).toEqual({ applied: [13], currentVersion: 13 });
      expect(temp.database.prepare(`
        SELECT entry.title, entry.type, entry.upload_date, usage.view_count, usage.like_count
        FROM entries AS entry
        JOIN entry_usage AS usage ON usage.entry_id = entry.id
      `).get()).toEqual(before);
      expect(inspectDatabase(temp.database)).toEqual({ ok: true, issues: [] });
      expect(temp.database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'idx_entries_page_%'
        ORDER BY name
      `).pluck().all()).toEqual(['idx_entries_page_date', 'idx_entries_page_title']);
    } finally {
      temp.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('upgrades a populated temporary file database from 13 to 14 without changing data', () => {
    const directory = mkdtempSync(join(tmpdir(), 't3-migrations-13-to-14-'));
    const temp = createTempFileDatabase();
    try {
      const migrationNames = readdirSync(sourceMigrationsDirectory)
        .filter((name) => /^\d+_.+\.sql$/u.test(name));
      for (const name of migrationNames.filter((name) => Number.parseInt(name, 10) <= 13)) {
        copyFileSync(join(sourceMigrationsDirectory, name), join(directory, name));
      }
      expect(applyAllMigrations(temp.database, directory).currentVersion).toBe(13);
      temp.database.prepare('INSERT INTO entries (title, type, upload_date) VALUES (?, ?, ?)')
        .run('Preserved', 'comic', '2026-09-08');
      const entryId = Number(temp.database.prepare('SELECT id FROM entries').pluck().get());
      temp.database.prepare('INSERT INTO entry_contents (entry_id, content_type, content, sort_order) VALUES (?, ?, ?, ?)')
        .run(entryId, 'Source URL', 'https://example.test/preserved', 0);
      const before = temp.database.prepare(`
        SELECT entry.title, entry.type, content.content
        FROM entries AS entry
        JOIN entry_contents AS content ON content.entry_id = entry.id
      `).get();

      const migration14 = migrationNames.find((name) => name.startsWith('014_'))!;
      copyFileSync(join(sourceMigrationsDirectory, migration14), join(directory, migration14));
      expect(applyAllMigrations(temp.database, directory)).toEqual({ applied: [14], currentVersion: 14 });
      // The new tables start empty and the old Content rows stay byte-identical.
      expect(temp.database.prepare('SELECT COUNT(*) FROM source_statuses').pluck().get()).toBe(0);
      expect(temp.database.prepare('SELECT COUNT(*) FROM source_maintenance_runs').pluck().get()).toBe(0);
      expect(temp.database.prepare(`
        SELECT entry.title, entry.type, content.content
        FROM entries AS entry
        JOIN entry_contents AS content ON content.entry_id = entry.id
      `).get()).toEqual(before);
      expect(inspectDatabase(temp.database)).toEqual({ ok: true, issues: [] });
    } finally {
      temp.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a changed migration that was already applied', () => {
    const directory = mkdtempSync(join(tmpdir(), 't3-migrations-'));
    const database = createMemoryDatabase();

    try {
      const migrationPath = join(directory, '001_initial.sql');
      writeFileSync(migrationPath, readFileSync(sourceMigration, 'utf8'));
      applyAllMigrations(database, directory);
      writeFileSync(migrationPath, `${readFileSync(migrationPath, 'utf8')}\n-- changed\n`);

      expect(() => applyAllMigrations(database, directory)).toThrow('checksum mismatch');
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts an applied migration after checkout changes only its line endings', () => {
    const directory = mkdtempSync(join(tmpdir(), 't3-migration-line-endings-'));
    const database = createMemoryDatabase();

    try {
      const migrationPath = join(directory, '001_line_endings.sql');
      const lfSql = '-- portable migration\nCREATE TABLE portable (id INTEGER PRIMARY KEY);\n';
      writeFileSync(migrationPath, lfSql);
      expect(applyAllMigrations(database, directory)).toEqual({ applied: [1], currentVersion: 1 });

      writeFileSync(migrationPath, lfSql.replace(/\n/gu, String.fromCharCode(13, 10)));
      expect(applyAllMigrations(database, directory)).toEqual({ applied: [], currentVersion: 1 });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
