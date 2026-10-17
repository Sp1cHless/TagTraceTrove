import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import { createTempFileDatabase } from '../../src/database/testing.js';
import type { T3Database } from '../../src/database/connection.js';
import { createCollection, listCollections } from '../../src/repositories/collection-repository.js';
import { setGalleryPartition } from '../../src/repositories/partition-repository.js';

const sourceMigrationsDirectory = fileURLToPath(
  new URL('../../src/database/migrations/', import.meta.url),
);
const cleanupDirectories: string[] = [];

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function storedGalleryType(database: T3Database, title: string): unknown {
  return database.prepare('SELECT gallery_type FROM collections WHERE title = ?').pluck().get(title);
}

describe('collection Gallery scope migration', () => {
  it('files existing folders under their members Gallery and leaves the rest unfiled', () => {
    const migrationDirectory = mkdtempSync(join(tmpdir(), 't3-collection-gallery-migrations-'));
    cleanupDirectories.push(migrationDirectory);
    const migrationNames = readdirSync(sourceMigrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name));
    for (const name of migrationNames.filter((name) => Number.parseInt(name, 10) <= 16)) {
      copyFileSync(join(sourceMigrationsDirectory, name), join(migrationDirectory, name));
    }
    const temp = createTempFileDatabase();

    try {
      expect(applyAllMigrations(temp.database, migrationDirectory).currentVersion).toBe(16);
      const database = temp.database;
      setGalleryPartition(database, 'comic', true);
      setGalleryPartition(database, 'hentai', true);
      const insertEntry = database.prepare('INSERT INTO entries (title, type) VALUES (?, ?)');
      insertEntry.run('Comic One', 'comic');
      insertEntry.run('Comic Two', 'comic');
      insertEntry.run('Hentai One', 'hentai');
      insertEntry.run('Safe One', 'safe');
      const entryRows = database.prepare('SELECT id, title FROM entries').all() as Array<{
        id: number;
        title: string;
      }>;
      const entryId = (title: string) => entryRows.find((row) => row.title === title)!.id;

      const insertCollection = database.prepare(`
        INSERT INTO collections (kind, title, parent_id, sort_order)
        VALUES (?, ?, ?, ?)
      `);
      const linkEntry = database.prepare(
        'INSERT INTO collection_entries (collection_id, entry_id) VALUES (?, ?)',
      );
      const comicOnly = Number(insertCollection.run('entry', 'Comic shelf', null, 0).lastInsertRowid);
      linkEntry.run(comicOnly, entryId('Comic One'));
      linkEntry.run(comicOnly, entryId('Comic Two'));
      const mixed = Number(insertCollection.run('entry', 'Mixed shelf', null, 1).lastInsertRowid);
      linkEntry.run(mixed, entryId('Comic One'));
      linkEntry.run(mixed, entryId('Hentai One'));
      const empty = Number(insertCollection.run('entry', 'Empty shelf', null, 2).lastInsertRowid);
      database.prepare('UPDATE collections SET nsfw = 1 WHERE id = ?').run(empty);
      const parent = Number(insertCollection.run('entry', 'Parent shelf', null, 3).lastInsertRowid);
      linkEntry.run(parent, entryId('Comic One'));
      const child = Number(insertCollection.run('entry', 'Nested shelf', parent, 4).lastInsertRowid);
      linkEntry.run(child, entryId('Comic Two'));
      const producerShelf = Number(
        insertCollection.run('producer', 'Author shelf', null, 5).lastInsertRowid,
      );

      const migration17 = migrationNames.find((name) => name.startsWith('017_'))!;
      copyFileSync(join(sourceMigrationsDirectory, migration17), join(migrationDirectory, migration17));
      expect(applyAllMigrations(temp.database, migrationDirectory)).toEqual({
        applied: [17],
        currentVersion: 17,
      });

      // Members and the folder-level hideable flag survive the backfill untouched.
      expect(database.prepare('SELECT COUNT(*) FROM collection_entries').pluck().get()).toBe(6);
      expect(database.prepare('SELECT nsfw FROM collections WHERE id = ?').pluck().get(empty)).toBe(1);
      expect(database.prepare(
        'SELECT COUNT(*) FROM collection_entries WHERE collection_id = ?',
      ).pluck().get(comicOnly)).toBe(2);
      expect(database.prepare('SELECT COUNT(*) FROM collections WHERE id = ?').pluck().get(producerShelf)).toBe(1);

      // One-Gallery folders are filed there; mixed and empty ones stay unfiled.
      expect(storedGalleryType(database, 'Comic shelf')).toBe('comic');
      expect(storedGalleryType(database, 'Mixed shelf')).toBeNull();
      expect(storedGalleryType(database, 'Empty shelf')).toBeNull();
      expect(storedGalleryType(database, 'Parent shelf')).toBe('comic');
      expect(storedGalleryType(database, 'Nested shelf')).toBe('comic');
      expect(storedGalleryType(database, 'Author shelf')).toBeNull();

      const listed = listCollections(database, 'entry');
      expect(listed.map((record) => [record.title, record.galleryType])).toEqual([
        ['Comic shelf', 'comic'],
        ['Mixed shelf', null],
        ['Empty shelf', null],
        ['Parent shelf', 'comic'],
      ]);
      expect(listed.find((record) => record.title === 'Parent shelf')?.children[0]?.galleryType)
        .toBe('comic');
      expect(listCollections(database, 'producer')[0]?.galleryType).toBeNull();

      // A nested folder stays on its parent page; a Gallery-less kind is refused.
      expect(createCollection(database, {
        kind: 'entry', title: 'Another nested shelf', parentId: parent,
      }).galleryType).toBe('comic');
      expect(() => createCollection(database, {
        kind: 'entry', title: 'Wrong page', parentId: parent, galleryType: 'hentai',
      })).toThrow('a nested collection stays on its parent Gallery page');
      expect(() => createCollection(database, {
        kind: 'producer', title: 'Filed authors', galleryType: 'comic',
      })).toThrow('only an entry collection can be filed under a Gallery');
      expect(createCollection(database, { kind: 'entry', title: 'Fresh shelf' }).galleryType).toBeNull();
      expect(createCollection(database, {
        kind: 'entry', title: 'Hentai shelf', galleryType: 'hentai',
      }).galleryType).toBe('hentai');

      expect(inspectDatabase(database).ok).toBe(true);
    } finally {
      temp.cleanup();
    }
  });
});
