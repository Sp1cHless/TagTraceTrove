import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import { createMemoryDatabase, createTempFileDatabase, insertLegacyEntry } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';

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
      expect(applyAllMigrations(database)).toEqual({ applied: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44], currentVersion: 44 });
      expect(applyAllMigrations(database)).toEqual({ applied: [], currentVersion: 44 });
      expect(database.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(44);
      for (const row of database.prepare('SELECT name, checksum FROM schema_migrations').all() as Array<{name: string; checksum: string}>) {
        const sql = readFileSync(join(sourceMigrationsDirectory, row.name), 'utf8').replace(/\r\n?/gu, '\n');
        expect(row.checksum).toBe(createHash('sha256').update(sql).digest('hex'));
      }
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

  it('requires online creation claims only after migration 032 while preserving a populated v31 database', () => {
    const database = createMemoryDatabase();
    const directory = mkdtempSync(join(tmpdir(), 't3-migrations-31-to-32-'));
    try {
      const migrationNames = readdirSync(sourceMigrationsDirectory)
        .filter((name) => /^\d+_.+\.sql$/u.test(name));
      for (const name of migrationNames.filter((name) => Number.parseInt(name, 10) <= 31)) {
        copyFileSync(join(sourceMigrationsDirectory, name), join(directory, name));
      }
      expect(applyAllMigrations(database, directory).currentVersion).toBe(31);
      const entry = insertLegacyEntry(database, { title: 'Preserved', type: 'game' });
      expect(inspectDatabase(database)).toEqual({ ok: true, issues: [] });
      expect(applyAllMigrations(database)).toEqual({ applied: [32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44], currentVersion: 44 });
      expect(database.prepare('SELECT id FROM entries WHERE sync_uid = ?').pluck().get(
        database.prepare('SELECT sync_uid FROM entries WHERE id = ?').pluck().get(entry.id),
      )).toBe(entry.id);
      expect(inspectDatabase(database)).toEqual({ ok: true, issues: [] });
      database.exec('DROP TABLE sync_online_entry_creates');
      expect(inspectDatabase(database)).toMatchObject({ ok: false, issues: expect.arrayContaining([
        'missing required table: sync_online_entry_creates',
      ]) });
    } finally {
      database.close(); rmSync(directory, { recursive: true, force: true });
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

  it('assigns stable Producer Tag identities and journals assignment changes to their Producer', () => {
    const database = createMemoryDatabase();
    try {
      applyAllMigrations(database);
      const producer = createProducer(database, { name: 'Tag sync check' });
      const before = Number(database.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(producer.id));
      database.prepare('INSERT INTO producer_tags (name, normalized_name) VALUES (?, ?)').run('Illustrator', 'illustrator');
      const tag = database.prepare('SELECT id, sync_uid FROM producer_tags WHERE normalized_name = ?').get('illustrator') as { id: number; sync_uid: string };
      expect(tag.sync_uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      database.prepare('INSERT INTO producer_tag_assignments (producer_id, tag_id) VALUES (?, ?)').run(producer.id, tag.id);
      const afterInsert = Number(database.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(producer.id));
      database.prepare('DELETE FROM producer_tag_assignments WHERE producer_id = ? AND tag_id = ?').run(producer.id, tag.id);
      const afterDelete = Number(database.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(producer.id));

      expect(afterInsert).toBe(before + 1);
      expect(afterDelete).toBe(before + 2);
      const producerSyncUid = database.prepare('SELECT sync_uid FROM producers WHERE id = ?').pluck().get(producer.id);
      expect(database.prepare(`
        SELECT COUNT(*) FROM sync_changes WHERE entity_kind = 'producer' AND entity_uid = ?
      `).pluck().get(producerSyncUid)).toBe(3);
      expect(inspectDatabase(database)).toEqual({ ok: true, issues: [] });
    } finally {
      database.close();
    }
  });

  it('reports a missing Producer tag assignment journal trigger', () => {
    const database = createMemoryDatabase();
    try {
      applyAllMigrations(database);
      database.exec('DROP TRIGGER producer_tag_assignments_sync_insert');
      expect(inspectDatabase(database).issues).toContain(
        'missing required trigger: producer_tag_assignments_sync_insert',
      );
    } finally {
      database.close();
    }
  });

  it('journals every Entry–Author link change on the owning Entry revision', () => {
    const database = createMemoryDatabase();
    try {
      applyAllMigrations(database);
      const entry = createEntry(database, { title: 'Author link sync check', type: 'comic' });
      const firstAuthor = createProducer(database, { name: 'First linked Author' });
      const secondAuthor = createProducer(database, { name: 'Second linked Author' });
      const entryIdentity = database.prepare(
        'SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM entries WHERE id = ?',
      ).get(entry.id) as { syncUid: string; syncVersion: number };

      linkEntryProducer(database, entry.id, firstAuthor.id);
      const afterInsert = Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?')
        .pluck().get(entry.id));
      database.prepare('DELETE FROM entry_producers WHERE entry_id = ? AND producer_id = ?')
        .run(entry.id, firstAuthor.id);
      const afterDelete = Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?')
        .pluck().get(entry.id));
      linkEntryProducer(database, entry.id, secondAuthor.id);

      expect(afterInsert).toBe(entryIdentity.syncVersion + 1);
      expect(afterDelete).toBe(entryIdentity.syncVersion + 2);
      expect(database.prepare(`
        SELECT COUNT(*) FROM sync_changes WHERE entity_kind = 'entry' AND entity_uid = ?
      `).pluck().get(entryIdentity.syncUid)).toBe(4);
      expect(inspectDatabase(database)).toEqual({ ok: true, issues: [] });
    } finally {
      database.close();
    }
  });

  it('reports a missing Entry–Author revision trigger', () => {
    const database = createMemoryDatabase();
    try {
      applyAllMigrations(database);
      database.exec('DROP TRIGGER entry_producers_sync_insert');
      expect(inspectDatabase(database).issues).toContain(
        'missing required trigger: entry_producers_sync_insert',
      );
    } finally {
      database.close();
    }
  });

  it('reports a missing Producer rating journal trigger', () => {
    const database = createMemoryDatabase();
    try {
      applyAllMigrations(database);
      database.exec('DROP TRIGGER producer_rating_values_sync_update');
      expect(inspectDatabase(database)).toEqual({
        ok: false,
        issues: ['missing required trigger: producer_rating_values_sync_update'],
      });
    } finally {
      database.close();
    }
  });

  it('reports a Producer whose offline sync identity is missing', () => {
    const database = createMemoryDatabase();
    try {
      applyAllMigrations(database);
      const producer = createProducer(database, { name: 'Sync identity check' });
      database.exec('DROP TRIGGER producers_sync_uid_immutable');
      database.prepare('UPDATE producers SET sync_uid = NULL WHERE id = ?').run(producer.id);

      expect(inspectDatabase(database)).toEqual({
        ok: false,
        issues: [`missing sync identity: producers ${producer.id}`],
      });
    } finally {
      database.close();
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
