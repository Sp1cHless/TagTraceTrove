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
} from '../../src/database/testing.js';
import type { T3Database } from '../../src/database/connection.js';
import { createEntry, deleteEntry } from '../../src/repositories/entry-repository.js';
import {
  createProducer,
  linkEntryProducer,
  unlinkEntryProducer,
} from '../../src/repositories/producer-repository.js';
import { mergeAuthorEntries } from '../../src/repositories/entry-merge-repository.js';

const sourceMigrationsDirectory = fileURLToPath(
  new URL('../../src/database/migrations/', import.meta.url),
);
const cleanupDirectories: string[] = [];

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function exists(database: T3Database, producerId: number): boolean {
  return database.prepare('SELECT COUNT(*) FROM producers WHERE id = ?').pluck().get(producerId) !== 0;
}

describe('work-less Author pruning', () => {
  it('removes the residue a migration inherits without touching the alias dictionary', () => {
    const migrationDirectory = mkdtempSync(join(tmpdir(), 't3-prune-authors-migrations-'));
    cleanupDirectories.push(migrationDirectory);
    const migrationNames = readdirSync(sourceMigrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name));
    for (const name of migrationNames.filter((name) => Number.parseInt(name, 10) <= 17)) {
      copyFileSync(join(sourceMigrationsDirectory, name), join(migrationDirectory, name));
    }
    const temp = createTempFileDatabase();

    try {
      expect(applyAllMigrations(temp.database, migrationDirectory).currentVersion).toBe(17);
      const database = temp.database;
      const linked = createProducer(database, { name: 'Linked Author' });
      const work = createEntry(database, { title: 'Work', type: 'comic' });
      linkEntryProducer(database, work.id, linked.id);
      // A merged-away spelling: the alias dictionary keeps the name, the row does not.
      const mergedSpelling = createProducer(database, { name: 'Old Spelling' });
      database.prepare(`
        INSERT INTO taxonomy_aliases (
          vocabulary, partition, alias_name, normalized_alias,
          canonical_name, normalized_canonical
        ) VALUES ('producer', 'authors', 'Old Spelling', 'old spelling', 'Linked Author', 'linked author')
      `).run();
      // Residue that still carries other rows: they cascade with the Author.
      const abandoned = createProducer(database, { name: 'Abandoned Author' });
      const collectionId = Number(database.prepare(
        "INSERT INTO collections (kind, title) VALUES ('producer', 'Shelf')",
      ).run().lastInsertRowid);
      database.prepare('INSERT INTO collection_producers (collection_id, producer_id) VALUES (?, ?)')
        .run(collectionId, abandoned.id);
      const aliasesBefore = database.prepare(
        'SELECT vocabulary, partition, alias_name, canonical_name FROM taxonomy_aliases ORDER BY id',
      ).all();

      const migration18 = migrationNames.find((name) => name.startsWith('018_'))!;
      copyFileSync(join(sourceMigrationsDirectory, migration18), join(migrationDirectory, migration18));
      expect(applyAllMigrations(temp.database, migrationDirectory)).toEqual({
        applied: [18],
        currentVersion: 18,
      });

      expect(exists(database, linked.id)).toBe(true);
      expect(exists(database, mergedSpelling.id)).toBe(false);
      expect(exists(database, abandoned.id)).toBe(false);
      // The membership went with the Author instead of dangling; the folder the
      // user curated survives it, because pruning an Author is not deleting a folder.
      expect(database.prepare('SELECT COUNT(*) FROM collection_producers').pluck().get()).toBe(0);
      expect(database.prepare('SELECT COUNT(*) FROM collections').pluck().get()).toBe(1);
      // The alias dictionary is name data with no foreign key here: untouched.
      expect(database.prepare(
        'SELECT vocabulary, partition, alias_name, canonical_name FROM taxonomy_aliases ORDER BY id',
      ).all()).toEqual(aliasesBefore);
      expect(inspectDatabase(database).ok).toBe(true);
    } finally {
      temp.cleanup();
    }
  });

  it('removes the unused Tag rows a migration inherits, alias dictionary intact', () => {
    const migrationDirectory = mkdtempSync(join(tmpdir(), 't3-prune-tags-migrations-'));
    cleanupDirectories.push(migrationDirectory);
    const migrationNames = readdirSync(sourceMigrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name));
    for (const name of migrationNames.filter((name) => Number.parseInt(name, 10) <= 19)) {
      copyFileSync(join(sourceMigrationsDirectory, name), join(migrationDirectory, name));
    }
    const temp = createTempFileDatabase();

    try {
      expect(applyAllMigrations(temp.database, migrationDirectory).currentVersion).toBe(19);
      const database = temp.database;
      database.exec(`
        INSERT INTO tags (id, name, normalized_name) VALUES
          (1, 'Kept tag', 'kept tag'),
          (2, 'Typo tag', 'typo tag');
        INSERT INTO producer_tags (id, name, normalized_name) VALUES
          (1, 'Kept author tag', 'kept author tag'),
          (2, 'Typo author tag', 'typo author tag');
        INSERT INTO entries (id, title, type) VALUES (1, 'Work', 'comic');
        INSERT INTO tag_groups (id, entry_type, name, group_kind) VALUES (1, 'comic', 'Basic', 'section');
        INSERT INTO tag_groups (id, entry_type, name, group_kind, parent_id) VALUES (2, 'comic', '', 'facet', 1);
        INSERT INTO entry_tags (entry_id, tag_id, facet_id) VALUES (1, 1, 2);
        INSERT INTO producers (id, name) VALUES (1, 'Creator');
        INSERT INTO producer_tag_assignments (producer_id, tag_id) VALUES (1, 1);
      `);
      database.prepare(`
        INSERT INTO taxonomy_aliases (
          vocabulary, partition, alias_name, normalized_alias,
          canonical_name, normalized_canonical
        ) VALUES ('entry', 'tags', 'Typo spelling', 'typo spelling', 'Typo tag', 'typo tag')
      `).run();

      const migration20 = migrationNames.find((name) => name.startsWith('020_'))!;
      copyFileSync(join(sourceMigrationsDirectory, migration20), join(migrationDirectory, migration20));
      expect(applyAllMigrations(temp.database, migrationDirectory)).toEqual({
        applied: [20],
        currentVersion: 20,
      });

      expect(database.prepare('SELECT id FROM tags ORDER BY id').pluck().all()).toEqual([1]);
      expect(database.prepare('SELECT id FROM producer_tags ORDER BY id').pluck().all()).toEqual([1]);
      // The alias dictionary is name data with no foreign key here: untouched.
      expect(database.prepare('SELECT canonical_name FROM taxonomy_aliases').pluck().all())
        .toEqual(['Typo tag']);
      expect(inspectDatabase(database).ok).toBe(true);
    } finally {
      temp.cleanup();
    }
  });

  it('drops an Author the moment its last work leaves it', () => {
    const database = createMigratedMemoryDatabase();
    const author = createProducer(database, { name: 'One Work Author' });
    const other = createProducer(database, { name: 'Two Work Author' });
    const first = createEntry(database, { title: 'Only Work', type: 'comic' });
    linkEntryProducer(database, first.id, author.id);
    const second = createEntry(database, { title: 'Work A', type: 'comic' });
    const third = createEntry(database, { title: 'Work B', type: 'comic' });
    linkEntryProducer(database, second.id, other.id);
    linkEntryProducer(database, third.id, other.id);

    unlinkEntryProducer(database, first.id, author.id);
    expect(exists(database, author.id)).toBe(false);

    // Still holding one work: deleting the other work leaves the Author alone.
    deleteEntry(database, second.id);
    expect(exists(database, other.id)).toBe(true);
    deleteEntry(database, third.id);
    expect(exists(database, other.id)).toBe(false);

    // The last link may also disappear together with the work it was on.
    const spare = createProducer(database, { name: 'Spare Author' });
    const spareWork = createEntry(database, { title: 'Spare', type: 'comic' });
    linkEntryProducer(database, spareWork.id, spare.id);
    deleteEntry(database, spareWork.id);
    expect(exists(database, spare.id)).toBe(false);

    // A hand-created Author that never held a work waits for one.
    const fresh = createProducer(database, { name: 'Fresh Author' });
    expect(exists(database, fresh.id)).toBe(true);
    database.close();
  });

  it('keeps every Author an Entry merge moves onto the kept work', () => {
    const database = createMigratedMemoryDatabase();
    const keeper = createProducer(database, { name: 'Keeper Author' });
    const absorbed = createProducer(database, { name: 'Absorbed Author' });
    const keepEntry = createEntry(database, { title: 'Kept Work', type: 'comic' });
    const absorbEntry = createEntry(database, { title: 'Absorbed Work', type: 'comic' });
    linkEntryProducer(database, keepEntry.id, keeper.id);
    linkEntryProducer(database, absorbEntry.id, absorbed.id);
    linkEntryProducer(database, absorbEntry.id, keeper.id);

    mergeAuthorEntries(database, {
      authorId: keeper.id,
      keepEntryId: keepEntry.id,
      absorbEntryId: absorbEntry.id,
      copyTags: true,
      sourceUrls: [],
    });

    // Merging works merges their credits: both Authors now hold the kept work, so
    // the absorbed Entry going away must not take either of them with it.
    expect(exists(database, keeper.id)).toBe(true);
    expect(exists(database, absorbed.id)).toBe(true);
    expect(database.prepare(
      'SELECT COUNT(*) FROM entry_producers WHERE entry_id = ?',
    ).pluck().get(keepEntry.id)).toBe(2);
    database.close();
  });
});
