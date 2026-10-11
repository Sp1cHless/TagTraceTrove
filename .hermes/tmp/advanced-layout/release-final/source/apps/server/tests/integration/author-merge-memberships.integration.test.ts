import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import {
  createMigratedMemoryDatabase,
  createTempFileDatabase,
  insertLegacyEntry,
  linkLegacyEntryProducer,
} from '../../src/database/testing.js';
import type { T3Database } from '../../src/database/connection.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import {
  addCollectionProducer,
  createCollection,
  listCollections,
} from '../../src/repositories/collection-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import {
  addViewLaterProducer,
  listViewLaterProducerIds,
} from '../../src/repositories/view-later-repository.js';
import { executeProducerMerges, planProducerMerges } from '../../src/import/merge-producers.js';

const sourceMigrationsDirectory = fileURLToPath(
  new URL('../../src/database/migrations/', import.meta.url),
);
const cleanupDirectories: string[] = [];

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function orphanCount(database: T3Database, table: string): number {
  return Number(database.prepare(`
    SELECT COUNT(*) FROM ${table} AS link
    LEFT JOIN producers AS producer ON producer.id = link.producer_id
    WHERE producer.id IS NULL
  `).pluck().get());
}

function mergeDuplicateAuthors(database: T3Database): number {
  const plans = planProducerMerges(database);
  database.pragma('foreign_keys = OFF');
  try {
    executeProducerMerges(database, plans);
  } finally {
    database.pragma('foreign_keys = ON');
  }
  return plans.length;
}

describe('author merge memberships', () => {
  it('hands Collection and View later memberships to the surviving Author', () => {
    const database = createMigratedMemoryDatabase();
    const first = createProducer(database, { name: 'Twin Author' });
    const second = createProducer(database, { name: 'Twin Author' });
    const work = createEntry(database, { title: 'Twin work', type: 'comic' });
    linkEntryProducer(database, work.id, second.id);
    const shelf = createCollection(database, { kind: 'producer', title: 'Twin shelf' });
    addCollectionProducer(database, shelf.id, first.id);
    addViewLaterProducer(database, first.id);

    expect(mergeDuplicateAuthors(database)).toBe(1);

    const survivorId = database.prepare(
      "SELECT id FROM producers WHERE name = 'Twin Author'",
    ).pluck().get() as number;
    expect([first.id, second.id]).toContain(survivorId);
    // Nothing dangles, and both curated lists followed the Author that survived.
    expect(orphanCount(database, 'collection_producers')).toBe(0);
    expect(orphanCount(database, 'view_later_producers')).toBe(0);
    const shelfMembers = listCollections(database, 'producer')[0]?.producers.map((row) => row.id);
    expect(shelfMembers).toEqual([survivorId]);
    expect(listViewLaterProducerIds(database)).toEqual([survivorId]);
    expect(inspectDatabase(database).ok).toBe(true);
    database.close();
  });

  it('moves one Author Directory-set owner and all Directory memberships to the surviving Author', () => {
    const database = createMigratedMemoryDatabase();
    const first = createProducer(database, { name: 'Directory twin' });
    const second = createProducer(database, { name: 'Directory twin' });
    const firstWork = createEntry(database, { title: 'First work', type: 'comic' });
    const secondWork = createEntry(database, { title: 'Second work', type: 'comic' });
    linkEntryProducer(database, firstWork.id, first.id);
    linkEntryProducer(database, secondWork.id, second.id);
    const firstDirectoryId = Number(database.prepare(`
      INSERT INTO author_directories (producer_id, title, description, sort_order)
      VALUES (?, 'First folder', '', 0)
    `).run(first.id).lastInsertRowid);
    database.prepare(`
      INSERT INTO author_directory_entries (directory_id, producer_id, entry_id, sort_order)
      VALUES (?, ?, ?, 0)
    `).run(firstDirectoryId, first.id, firstWork.id);
    const secondDirectoryId = Number(database.prepare(`
      INSERT INTO author_directories (producer_id, title, description, sort_order)
      VALUES (?, 'Second folder', '', 0)
    `).run(second.id).lastInsertRowid);
    database.prepare(`
      INSERT INTO author_directory_entries (directory_id, producer_id, entry_id, sort_order)
      VALUES (?, ?, ?, 0)
    `).run(secondDirectoryId, second.id, secondWork.id);
    const setUids = new Map(database.prepare(`
      SELECT producer_id AS producerId, sync_uid AS syncUid FROM author_directory_sets
      WHERE producer_id IN (?, ?)
    `).all(first.id, second.id).map((row) => {
      const value = row as { producerId: number; syncUid: string };
      return [value.producerId, value.syncUid] as const;
    }));
    const directoryUids = [firstDirectoryId, secondDirectoryId].map((id) => String(database.prepare(
      'SELECT sync_uid FROM author_directories WHERE id = ?',
    ).pluck().get(id)));

    expect(mergeDuplicateAuthors(database)).toBe(1);
    const survivorId = Number(database.prepare(
      "SELECT id FROM producers WHERE name = 'Directory twin'",
    ).pluck().get());
    const survivorSet = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion
      FROM author_directory_sets WHERE producer_id = ?
    `).get(survivorId) as { syncUid: string; syncVersion: number };
    const tombstonedSetUid = setUids.get(survivorId === first.id ? second.id : first.id);
    expect(survivorSet.syncUid).toBe(setUids.get(survivorId));
    expect(database.prepare('SELECT COUNT(*) FROM author_directory_sets').pluck().get()).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM author_directories WHERE producer_id = ?')
      .pluck().get(survivorId)).toBe(2);
    expect(database.prepare(`
      SELECT COUNT(*) FROM author_directory_entries WHERE producer_id = ?
    `).pluck().get(survivorId)).toBe(2);
    expect(database.prepare(`
      SELECT COUNT(*) FROM author_directories WHERE producer_id = ? AND sync_uid IN (?, ?)
    `).pluck().get(survivorId, directoryUids[0], directoryUids[1])).toBe(2);
    expect(database.prepare(`
      SELECT COUNT(*) FROM sync_tombstones
      WHERE entity_kind = 'author_directory_set' AND entity_uid = ?
    `).pluck().get(tombstonedSetUid)).toBe(1);
    expect(survivorSet.syncVersion).toBeGreaterThan(1);
    expect(inspectDatabase(database)).toEqual({ ok: true, issues: [] });
    database.close();
  });

  it('keeps one View later position when both Authors were saved', () => {
    const database = createMigratedMemoryDatabase();
    const first = createProducer(database, { name: 'Saved Twin' });
    const second = createProducer(database, { name: 'Saved Twin' });
    const work = createEntry(database, { title: 'Saved work', type: 'comic' });
    linkEntryProducer(database, work.id, second.id);
    addViewLaterProducer(database, first.id);
    addViewLaterProducer(database, second.id);

    expect(mergeDuplicateAuthors(database)).toBe(1);

    // A position is unique, so the handoff must not try to reuse one.
    expect(listViewLaterProducerIds(database)).toHaveLength(1);
    expect(database.prepare('SELECT COUNT(DISTINCT position) FROM view_later_producers').pluck().get())
      .toBe(1);
    expect(orphanCount(database, 'view_later_producers')).toBe(0);
    database.close();
  });

  it('clears memberships a previous merge left pointing at a deleted Author', () => {
    const migrationDirectory = mkdtempSync(join(tmpdir(), 't3-orphan-memberships-migrations-'));
    cleanupDirectories.push(migrationDirectory);
    const migrationNames = readdirSync(sourceMigrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name));
    for (const name of migrationNames.filter((name) => Number.parseInt(name, 10) <= 18)) {
      copyFileSync(join(sourceMigrationsDirectory, name), join(migrationDirectory, name));
    }
    const temp = createTempFileDatabase();

    try {
      expect(applyAllMigrations(temp.database, migrationDirectory).currentVersion).toBe(18);
      const database = temp.database;
      const author = createProducer(database, { name: 'Doomed Author' });
      const survivor = createProducer(database, { name: 'Surviving Author' });
      const work = insertLegacyEntry(database, { title: 'Work', type: 'comic' });
      linkLegacyEntryProducer(database, work.id, survivor.id);
      const shelf = createCollection(database, { kind: 'producer', title: 'Shelf' });
      addCollectionProducer(database, shelf.id, survivor.id);
      addViewLaterProducer(database, survivor.id);
      // Reproduce the old damage directly: memberships plus a row that is gone.
      database.prepare('INSERT INTO collection_producers (collection_id, producer_id) VALUES (?, ?)')
        .run(shelf.id, author.id);
      database.prepare('INSERT INTO view_later_producers (producer_id, position) VALUES (?, ?)')
        .run(author.id, 5);
      database.pragma('foreign_keys = OFF');
      database.prepare('DELETE FROM producers WHERE id = ?').run(author.id);
      database.pragma('foreign_keys = ON');
      expect(orphanCount(database, 'collection_producers')).toBe(1);
      expect(orphanCount(database, 'view_later_producers')).toBe(1);
      expect(inspectDatabase(database).ok).toBe(false);

      const migration19 = migrationNames.find((name) => name.startsWith('019_'))!;
      copyFileSync(join(sourceMigrationsDirectory, migration19), join(migrationDirectory, migration19));
      expect(applyAllMigrations(temp.database, migrationDirectory)).toEqual({
        applied: [19],
        currentVersion: 19,
      });

      expect(orphanCount(database, 'collection_producers')).toBe(0);
      expect(orphanCount(database, 'view_later_producers')).toBe(0);
      // The surviving Author keeps its own memberships untouched.
      expect(database.prepare('SELECT COUNT(*) FROM collection_producers WHERE producer_id = ?')
        .pluck().get(survivor.id)).toBe(1);
      expect(listViewLaterProducerIds(database)).toEqual([survivor.id]);
      expect(inspectDatabase(database).ok).toBe(true);
    } finally {
      temp.cleanup();
    }
  });
});
