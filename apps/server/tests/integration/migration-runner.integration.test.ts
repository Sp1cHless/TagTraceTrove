import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createMemoryDatabase } from '../../src/database/testing.js';

const sourceMigration = fileURLToPath(
  new URL('../../src/database/migrations/001_initial.sql', import.meta.url),
);

describe('migration runner', () => {
  it('applies each migration once and records its checksum', () => {
    const database = createMemoryDatabase();

    try {
      expect(applyAllMigrations(database)).toEqual({ applied: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], currentVersion: 12 });
      expect(applyAllMigrations(database)).toEqual({ applied: [], currentVersion: 12 });
      expect(database.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(12);
    } finally {
      database.close();
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
});
