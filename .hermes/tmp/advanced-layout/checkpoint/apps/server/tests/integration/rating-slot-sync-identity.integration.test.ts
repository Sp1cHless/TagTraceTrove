import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createTempFileDatabase } from '../../src/database/testing.js';
import { createRatingSlot } from '../../src/repositories/rating-repository.js';

const sourceMigrationsDirectory = fileURLToPath(
  new URL('../../src/database/migrations/', import.meta.url),
);
const cleanupDirectories: string[] = [];

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('rating slot sync identity migration', () => {
  it('backfills immutable UIDs and never identifies a replacement slot as the deleted slot', () => {
    const migrationDirectory = mkdtempSync(join(tmpdir(), 't3-rating-slot-sync-'));
    cleanupDirectories.push(migrationDirectory);
    const migrationNames = readdirSync(sourceMigrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name));
    for (const name of migrationNames.filter((name) => Number.parseInt(name, 10) <= 23)) {
      copyFileSync(join(sourceMigrationsDirectory, name), join(migrationDirectory, name));
    }
    const temp = createTempFileDatabase();

    try {
      expect(applyAllMigrations(temp.database, migrationDirectory).currentVersion).toBe(23);
      temp.database.prepare(`
        INSERT INTO rating_slots (subject_kind, entry_type, name, sort_order)
        VALUES ('entry', 'game', 'Quality', 0)
      `).run();
      const oldId = Number(temp.database.prepare('SELECT id FROM rating_slots').pluck().get());

      const migration24 = migrationNames.find((name) => name.startsWith('024_'))!;
      expect(migration24).toBeTruthy();
      copyFileSync(join(sourceMigrationsDirectory, migration24), join(migrationDirectory, migration24));
      expect(applyAllMigrations(temp.database, migrationDirectory)).toEqual({
        applied: [24], currentVersion: 24,
      });
      const oldUid = temp.database.prepare('SELECT sync_uid FROM rating_slots WHERE id = ?')
        .pluck().get(oldId) as string;
      expect(oldUid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
      expect(() => temp.database.prepare('UPDATE rating_slots SET sync_uid = ? WHERE id = ?')
        .run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', oldId))
        .toThrow('rating slot sync_uid is immutable');

      temp.database.prepare('DELETE FROM rating_slots WHERE id = ?').run(oldId);
      const replacement = createRatingSlot(temp.database, {
        kind: 'entry', entryType: 'game', name: 'Story',
      });
      const replacementRow = temp.database.prepare(`
        SELECT id, sync_uid AS syncUid FROM rating_slots WHERE id = ?
      `).get(replacement.id) as { id: number; syncUid: string };
      expect(replacementRow.id).toBe(oldId);
      expect(replacementRow.syncUid).toMatch(/^[0-9a-f-]{36}$/u);
      expect(replacementRow.syncUid).not.toBe(oldUid);
    } finally {
      temp.cleanup();
    }
  });
});
