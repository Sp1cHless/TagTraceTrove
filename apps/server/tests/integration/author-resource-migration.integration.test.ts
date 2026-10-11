import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import { createTempFileDatabase } from '../../src/database/testing.js';

const sourceMigrationsDirectory = fileURLToPath(
  new URL('../../src/database/migrations/', import.meta.url),
);
const cleanupDirectories: string[] = [];

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Author resource sync migration 028', () => {
  it('backfills stable owner identities without changing prior journal history or sequence high-water', () => {
    const migrationDirectory = mkdtempSync(join(tmpdir(), 't3-author-resource-sync-'));
    cleanupDirectories.push(migrationDirectory);
    const migrationNames = readdirSync(sourceMigrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name));
    for (const name of migrationNames.filter((name) => Number.parseInt(name, 10) <= 27)) {
      copyFileSync(join(sourceMigrationsDirectory, name), join(migrationDirectory, name));
    }
    const temp = createTempFileDatabase();

    try {
      expect(applyAllMigrations(temp.database, migrationDirectory).currentVersion).toBe(27);
      const producerId = Number(temp.database.prepare(
        'INSERT INTO producers (name) VALUES (?)',
      ).run('Preserved Author').lastInsertRowid);
      const entryId = Number(temp.database.prepare(
        'INSERT INTO entries (title, type, upload_date) VALUES (?, ?, ?)',
      ).run('Tombstoned work', 'comic', '2026-09-01').lastInsertRowid);
      temp.database.prepare(
        'INSERT INTO entries (title, type, upload_date) VALUES (?, ?, ?)',
      ).run('Live work', 'comic', '2026-09-02');
      const directoryId = Number(temp.database.prepare(`
        INSERT INTO author_directories (producer_id, title, description, sort_order)
        VALUES (?, 'Existing folder', '', 0)
      `).run(producerId).lastInsertRowid);
      const collectionId = Number(temp.database.prepare(
        'INSERT INTO collections (kind, title) VALUES (?, ?)',
      ).run('producer', 'Existing favorites').lastInsertRowid);
      temp.database.prepare(
        'INSERT INTO collection_producers (collection_id, producer_id) VALUES (?, ?)',
      ).run(collectionId, producerId);
      temp.database.prepare(`
        INSERT INTO rating_slots (subject_kind, entry_type, name, sort_order, sync_uid)
        VALUES ('producer', 'comic', 'Existing slot', 0, '12345678-1234-4234-8234-123456789abc')
      `).run();
      temp.database.prepare('DELETE FROM entries WHERE id = ?').run(entryId);

      const beforeSeq = Number(temp.database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes')
        .pluck().get());
      const beforeSequenceHighWater = Number(temp.database.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'sync_changes'",
      ).pluck().get());
      const beforeChanges = temp.database.prepare(`
        SELECT seq, entity_kind AS entityKind, entity_uid AS entityUid, change_kind AS changeKind,
               resource_version AS resourceVersion, record_json AS recordJson, changed_at AS changedAt
        FROM sync_changes ORDER BY seq
      `).all();
      const beforeTombstones = temp.database.prepare(`
        SELECT entity_kind AS entityKind, entity_uid AS entityUid,
               deleted_version AS deletedVersion, change_seq AS changeSeq, deleted_at AS deletedAt
        FROM sync_tombstones ORDER BY change_seq
      `).all();

      const migration28 = migrationNames.find((name) => name.startsWith('028_'))!;
      copyFileSync(join(sourceMigrationsDirectory, migration28), join(migrationDirectory, migration28));
      expect(applyAllMigrations(temp.database, migrationDirectory)).toEqual({
        applied: [28],
        currentVersion: 28,
      });

      expect(temp.database.prepare('SELECT sync_uid FROM collections WHERE id = ?')
        .pluck().get(collectionId)).toMatch(/^[0-9a-f-]{36}$/u);
      expect(temp.database.prepare('SELECT sync_version FROM collections WHERE id = ?')
        .pluck().get(collectionId)).toBe(1);
      expect(temp.database.prepare('SELECT sync_uid FROM author_directories WHERE id = ?')
        .pluck().get(directoryId)).toMatch(/^[0-9a-f-]{36}$/u);
      const directorySet = temp.database.prepare(`
        SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM author_directory_sets WHERE producer_id = ?
      `).get(producerId) as { syncUid: string; syncVersion: number };
      expect(directorySet.syncUid).toMatch(/^[0-9a-f-]{36}$/u);
      expect(directorySet.syncVersion).toBe(1);
      expect(temp.database.prepare(`
        SELECT COUNT(*) FROM rating_slot_layouts
        WHERE (subject_kind, entry_type) IN (('entry', 'comic'), ('producer', 'comic'))
      `).pluck().get()).toBe(2);
      expect(temp.database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get())
        .toBe(beforeSeq);
      expect(temp.database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sync_changes'").pluck().get())
        .toBe(beforeSequenceHighWater);
      expect(temp.database.prepare(`
        SELECT seq, entity_kind AS entityKind, entity_uid AS entityUid, change_kind AS changeKind,
               resource_version AS resourceVersion, record_json AS recordJson, changed_at AS changedAt
        FROM sync_changes ORDER BY seq
      `).all()).toEqual(beforeChanges);
      expect(temp.database.prepare(`
        SELECT entity_kind AS entityKind, entity_uid AS entityUid,
               deleted_version AS deletedVersion, change_seq AS changeSeq, deleted_at AS deletedAt
        FROM sync_tombstones ORDER BY change_seq
      `).all()).toEqual(beforeTombstones);
      expect(temp.database.pragma('foreign_key_check')).toEqual([]);
      expect(inspectDatabase(temp.database)).toEqual({ ok: true, issues: [] });
    } finally {
      temp.cleanup();
    }
  });
});
