import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import { insertLegacyEntry, createTempFileDatabase } from '../../src/database/testing.js';
import {
  createEntryContent,
  updateEntryContent,
} from '../../src/repositories/entry-content-repository.js';

const sourceMigrationsDirectory = fileURLToPath(
  new URL('../../src/database/migrations/', import.meta.url),
);
const cleanupDirectories: string[] = [];

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('sync foundation migration', () => {
  it('upgrades populated v15 data and journals later Entry and Content changes', () => {
    const migrationDirectory = mkdtempSync(join(tmpdir(), 't3-sync-foundation-migrations-'));
    cleanupDirectories.push(migrationDirectory);
    const migrationNames = readdirSync(sourceMigrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name));
    for (const name of migrationNames.filter((name) => Number.parseInt(name, 10) <= 15)) {
      copyFileSync(join(sourceMigrationsDirectory, name), join(migrationDirectory, name));
    }
    const temp = createTempFileDatabase();

    try {
      expect(applyAllMigrations(temp.database, migrationDirectory).currentVersion).toBe(15);
      temp.database.prepare(`
        INSERT INTO entries (title, type, upload_date) VALUES (?, ?, ?)
      `).run('Preserved Entry', 'comic', '2026-09-14');
      const preservedEntryId = Number(temp.database.prepare('SELECT id FROM entries').pluck().get());
      temp.database.prepare(`
        INSERT INTO entry_contents (entry_id, content_type, content, sort_order)
        VALUES (?, 'Source URL', 'https://example.test/preserved', 0)
      `).run(preservedEntryId);
      const before = temp.database.prepare(`
        SELECT entry.title, entry.type, entry.upload_date, content.content_type, content.content
        FROM entries AS entry
        JOIN entry_contents AS content ON content.entry_id = entry.id
        WHERE entry.id = ?
      `).get(preservedEntryId);

      const migration16 = migrationNames.find((name) => name.startsWith('016_'))!;
      copyFileSync(join(sourceMigrationsDirectory, migration16), join(migrationDirectory, migration16));
      expect(applyAllMigrations(temp.database, migrationDirectory)).toEqual({
        applied: [16],
        currentVersion: 16,
      });

      expect(temp.database.prepare(`
        SELECT entry.title, entry.type, entry.upload_date, content.content_type, content.content
        FROM entries AS entry
        JOIN entry_contents AS content ON content.entry_id = entry.id
        WHERE entry.id = ?
      `).get(preservedEntryId)).toEqual(before);
      const preserved = temp.database.prepare(`
        SELECT entry.sync_uid AS entryUid, entry.sync_version AS entryVersion,
               content.sync_uid AS contentUid, content.sync_version AS contentVersion
        FROM entries AS entry
        JOIN entry_contents AS content ON content.entry_id = entry.id
        WHERE entry.id = ?
      `).get(preservedEntryId) as {
        entryUid: string;
        entryVersion: number;
        contentUid: string;
        contentVersion: number;
      };
      expect(preserved.entryUid).toMatch(/^[0-9a-f-]{36}$/u);
      expect(preserved.contentUid).toMatch(/^[0-9a-f-]{36}$/u);
      expect(preserved.entryUid).not.toBe(preserved.contentUid);
      expect([preserved.entryVersion, preserved.contentVersion]).toEqual([1, 1]);
      expect(temp.database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(0);
      expect(temp.database.prepare('SELECT COUNT(*) FROM sync_tombstones').pluck().get()).toBe(0);

      const entry = insertLegacyEntry(temp.database, { title: 'Queued Edit', type: 'comic' });
      const content = createEntryContent(temp.database, {
        entryId: entry.id,
        contentType: 'note',
        content: 'Before',
      });
      // Written against the schema of this version: the current writer names every column an Entry
      // has today, and v16 predates several of them. The journaling this test is about lives in the
      // table's triggers, so an ordinary UPDATE exercises it exactly as the repository path would.
      temp.database.prepare('UPDATE entries SET title = ? WHERE id = ?').run('Applied Edit', entry.id);
      updateEntryContent(temp.database, content.id, { content: 'After' });

      const liveResources = temp.database.prepare(`
        SELECT sync_uid AS uid, sync_version AS version FROM entries WHERE id = ?
        UNION ALL
        SELECT sync_uid AS uid, sync_version AS version FROM entry_contents WHERE id = ?
      `).all(entry.id, content.id) as Array<{ uid: string; version: number }>;
      expect(liveResources.map((row) => row.version)).toEqual([2, 2]);
      const entryUid = liveResources[0]!.uid;
      const contentUid = liveResources[1]!.uid;
      expect(() => temp.database.prepare('UPDATE entries SET sync_uid = ? WHERE id = ?')
        .run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', entry.id))
        .toThrow('entry sync_uid is immutable');

      temp.database.prepare('DELETE FROM entry_contents WHERE id = ?').run(content.id);
      temp.database.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);

      const changes = temp.database.prepare(`
        SELECT seq, entity_kind AS entityKind, entity_uid AS entityUid,
               change_kind AS changeKind, resource_version AS resourceVersion
        FROM sync_changes ORDER BY seq
      `).all() as Array<{
        seq: number;
        entityKind: string;
        entityUid: string;
        changeKind: string;
        resourceVersion: number;
      }>;
      expect(changes.map((change) => [change.seq, change.entityKind, change.changeKind, change.resourceVersion]))
        .toEqual([
          [1, 'entry', 'create', 1],
          [2, 'entry_content', 'create', 1],
          [3, 'entry', 'update', 2],
          [4, 'entry_content', 'update', 2],
          [5, 'entry_content', 'delete', 3],
          [6, 'entry', 'delete', 3],
        ]);
      expect(temp.database.prepare(`
        SELECT entity_kind AS entityKind, entity_uid AS entityUid,
               deleted_version AS deletedVersion, change_seq AS changeSeq
        FROM sync_tombstones ORDER BY change_seq
      `).all()).toEqual([
        { entityKind: 'entry_content', entityUid: contentUid, deletedVersion: 3, changeSeq: 5 },
        { entityKind: 'entry', entityUid: entryUid, deletedVersion: 3, changeSeq: 6 },
      ]);

      const cascadeEntry = insertLegacyEntry(temp.database, { title: 'Cascade parent', type: 'comic' });
      const cascadeContent = createEntryContent(temp.database, {
        entryId: cascadeEntry.id,
        contentType: 'note',
        content: 'Cascade child',
      });
      const cascadeEntryUid = String(temp.database.prepare(
        'SELECT sync_uid FROM entries WHERE id = ?',
      ).pluck().get(cascadeEntry.id));
      const cascadeContentUid = String(temp.database.prepare(
        'SELECT sync_uid FROM entry_contents WHERE id = ?',
      ).pluck().get(cascadeContent.id));
      const beforeCascadeSeq = Number(temp.database.prepare(
        'SELECT MAX(seq) FROM sync_changes',
      ).pluck().get());
      temp.database.prepare('DELETE FROM entries WHERE id = ?').run(cascadeEntry.id);
      const cascadeChanges = temp.database.prepare(`
        SELECT seq, entity_kind AS entityKind, entity_uid AS entityUid,
               change_kind AS changeKind, resource_version AS resourceVersion
        FROM sync_changes WHERE seq > ? ORDER BY seq
      `).all(beforeCascadeSeq) as Array<{
        seq: number;
        entityKind: string;
        entityUid: string;
        changeKind: string;
        resourceVersion: number;
      }>;
      expect(cascadeChanges.map((change) => [
        change.entityKind, change.entityUid, change.changeKind, change.resourceVersion,
      ])).toEqual([
        ['entry_content', cascadeContentUid, 'delete', 2],
        ['entry', cascadeEntryUid, 'delete', 2],
      ]);
      expect(temp.database.prepare(`
        SELECT entity_kind AS entityKind, entity_uid AS entityUid,
               deleted_version AS deletedVersion, change_seq AS changeSeq
        FROM sync_tombstones WHERE change_seq > ? ORDER BY change_seq
      `).all(beforeCascadeSeq)).toEqual([
        { entityKind: 'entry_content', entityUid: cascadeContentUid, deletedVersion: 2, changeSeq: beforeCascadeSeq + 1 },
        { entityKind: 'entry', entityUid: cascadeEntryUid, deletedVersion: 2, changeSeq: beforeCascadeSeq + 2 },
      ]);

      temp.database.prepare(`
        INSERT INTO sync_operation_receipts (op_id, request_hash, result_json, server_seq)
        VALUES (?, ?, ?, ?)
      `).run('33333333-3333-4333-8333-333333333333', 'sha256:request', '{"status":"applied"}', 6);
      expect(() => temp.database.prepare(`
        INSERT INTO sync_operation_receipts (op_id, request_hash, result_json, server_seq)
        VALUES (?, ?, ?, ?)
      `).run('33333333-3333-4333-8333-333333333333', 'sha256:changed', '{"status":"conflict"}', 6))
        .toThrow();

      const changesBeforeRollback = Number(
        temp.database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get(),
      );
      const rolledBack = temp.database.transaction(() => {
        const doomed = insertLegacyEntry(temp.database, { title: 'Rolled Back', type: 'comic' });
        createEntryContent(temp.database, {
          entryId: doomed.id,
          contentType: 'note',
          content: 'must not survive',
        });
        throw new Error('rollback probe');
      });
      expect(rolledBack).toThrow('rollback probe');
      expect(temp.database.prepare("SELECT COUNT(*) FROM entries WHERE title = 'Rolled Back'").pluck().get()).toBe(0);
      expect(temp.database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(changesBeforeRollback);

      expect(inspectDatabase(temp.database)).toEqual({ ok: true, issues: [] });

      temp.database.exec('DROP TRIGGER entries_sync_uid_immutable');
      temp.database.prepare('UPDATE entries SET sync_uid = NULL WHERE id = ?').run(preservedEntryId);
      expect(inspectDatabase(temp.database)).toEqual({
        ok: false,
        issues: [`missing sync identity: entries ${preservedEntryId}`],
      });
    } finally {
      temp.cleanup();
    }
  });

  it('preserves existing journal sequence and tombstones when adding Producer sync identity', () => {
    const migrationDirectory = mkdtempSync(join(tmpdir(), 't3-producer-sync-migration-'));
    cleanupDirectories.push(migrationDirectory);
    const migrationNames = readdirSync(sourceMigrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name));
    for (const name of migrationNames.filter((name) => Number.parseInt(name, 10) <= 24)) {
      copyFileSync(join(sourceMigrationsDirectory, name), join(migrationDirectory, name));
    }
    const temp = createTempFileDatabase();

    try {
      expect(applyAllMigrations(temp.database, migrationDirectory).currentVersion).toBe(24);
      const producerId = Number(temp.database.prepare(
        'INSERT INTO producers (name) VALUES (?)',
      ).run('Preserved Author').lastInsertRowid);
      const entryId = Number(temp.database.prepare(
        'INSERT INTO entries (title, type) VALUES (?, ?)',
      ).run('Preserved Entry', 'comic').lastInsertRowid);
      const contentId = Number(temp.database.prepare(`
        INSERT INTO entry_contents (entry_id, content_type, content, sort_order)
        VALUES (?, 'note', 'to delete', 0)
      `).run(entryId).lastInsertRowid);
      temp.database.prepare('DELETE FROM entry_contents WHERE id = ?').run(contentId);

      const currentSequence = Number(temp.database.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'sync_changes'",
      ).pluck().get());
      const sequenceWatermark = currentSequence + 50;
      temp.database.prepare(`
        INSERT INTO sync_changes (
          seq, entity_kind, entity_uid, change_kind, resource_version, record_json
        ) VALUES (?, 'entry', 'deleted-high-water-test', 'update', 1, NULL)
      `).run(sequenceWatermark);
      temp.database.prepare('DELETE FROM sync_changes WHERE seq = ?').run(sequenceWatermark);

      const priorChanges = temp.database.prepare(`
        SELECT seq, entity_kind AS entityKind, entity_uid AS entityUid,
               change_kind AS changeKind, resource_version AS resourceVersion, record_json AS recordJson
        FROM sync_changes ORDER BY seq
      `).all();
      const priorTombstones = temp.database.prepare(`
        SELECT entity_kind AS entityKind, entity_uid AS entityUid,
               deleted_version AS deletedVersion, change_seq AS changeSeq
        FROM sync_tombstones ORDER BY change_seq
      `).all();
      expect(priorChanges.length).toBeGreaterThan(0);
      expect(priorTombstones.length).toBe(1);

      const migration25 = migrationNames.find((name) => name.startsWith('025_'))!;
      copyFileSync(join(sourceMigrationsDirectory, migration25), join(migrationDirectory, migration25));
      expect(applyAllMigrations(temp.database, migrationDirectory)).toEqual({
        applied: [25],
        currentVersion: 25,
      });
      expect(temp.database.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'sync_changes'",
      ).pluck().get()).toBe(sequenceWatermark);

      expect(temp.database.prepare(`
        SELECT seq, entity_kind AS entityKind, entity_uid AS entityUid,
               change_kind AS changeKind, resource_version AS resourceVersion, record_json AS recordJson
        FROM sync_changes ORDER BY seq
      `).all()).toEqual(priorChanges);
      expect(temp.database.prepare(`
        SELECT entity_kind AS entityKind, entity_uid AS entityUid,
               deleted_version AS deletedVersion, change_seq AS changeSeq
        FROM sync_tombstones ORDER BY change_seq
      `).all()).toEqual(priorTombstones);
      const producer = temp.database.prepare(`
        SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?
      `).get(producerId) as { syncUid: string; syncVersion: number };
      expect(producer.syncUid).toMatch(/^[0-9a-f-]{36}$/u);
      expect(producer.syncVersion).toBe(1);

      temp.database.prepare(`
        INSERT INTO view_later_producers (producer_id, position) VALUES (?, 0)
      `).run(producerId);
      expect(temp.database.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(producerId))
        .toBe(2);
      expect(temp.database.prepare('SELECT MAX(seq) FROM sync_changes').pluck().get())
        .toBeGreaterThan(sequenceWatermark);
      expect(temp.database.prepare(`
        SELECT entity_kind AS entityKind, entity_uid AS entityUid,
               change_kind AS changeKind, resource_version AS resourceVersion
        FROM sync_changes ORDER BY seq DESC LIMIT 1
      `).get()).toEqual({
        entityKind: 'producer',
        entityUid: producer.syncUid,
        changeKind: 'update',
        resourceVersion: 2,
      });
      temp.database.prepare('DELETE FROM producers WHERE id = ?').run(producerId);
      expect(temp.database.prepare(`
        SELECT entity_kind AS entityKind, entity_uid AS entityUid,
               deleted_version AS deletedVersion
        FROM sync_tombstones WHERE entity_kind = 'producer'
      `).get()).toEqual({
        entityKind: 'producer',
        entityUid: producer.syncUid,
        deletedVersion: 3,
      });
      expect(temp.database.pragma('foreign_key_check')).toEqual([]);
      expect(inspectDatabase(temp.database)).toEqual({ ok: true, issues: [] });
    } finally {
      temp.cleanup();
    }
  });
});
