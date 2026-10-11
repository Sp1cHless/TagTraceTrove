import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type T3Database } from '../../src/database/connection.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import {
  createProducerRatingSlot,
  listAuthorSelfRatings,
  listProducerRatings,
  listRatingSlots,
  setProducerRating,
} from '../../src/repositories/rating-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createProducer } from '../../src/repositories/producer-repository.js';
import { linkLegacyEntryProducer } from '../../src/database/testing.js';

const sourceMigrationsDirectory = fileURLToPath(new URL('../../src/database/migrations/', import.meta.url));
const cleanupDirectories: string[] = [];
afterEach(() => {
  while (cleanupDirectories.length > 0) rmSync(cleanupDirectories.pop()!, { recursive: true, force: true });
});

/** A database stopped at an older schema, so the migration under test has something to migrate. */
function databaseAt(version: number): T3Database {
  const directory = mkdtempSync(join(tmpdir(), 't3-rating-rebuild-'));
  cleanupDirectories.push(directory);
  const migrations = join(directory, 'migrations');
  mkdirSync(migrations);
  for (const name of readdirSync(sourceMigrationsDirectory).filter(
    (name) => /^\d+_.+\.sql$/u.test(name) && Number.parseInt(name, 10) <= version,
  )) {
    copyFileSync(join(sourceMigrationsDirectory, name), join(migrations, name));
  }
  const database = openDatabase(join(directory, 'library.db'));
  expect(applyAllMigrations(database, migrations).currentVersion).toBe(version);
  return database;
}

describe('the rating-class migration', () => {
  it('rebuilds the shared slot table without cascading a single rating value away', () => {
    // `rating_slots` is the FK parent of both value tables with ON DELETE CASCADE, and the CHECK
    // cannot be altered in place. Measured on a scratch copy (2026-10-08): dropping the parent
    // first runs its implicit DELETE with foreign keys on and takes every value with it — silently,
    // because a plain DROP TABLE does not fail. This pins the order that does not: build the new
    // tables, drop the OLD CHILD first, then the old parent, then rename.
    const database = databaseAt(38);
    try {
      seedRatedLibrary(database);

      const before = ratingFacts(database);
      expect(applyAllMigrations(database).currentVersion).toBeGreaterThanOrEqual(39);
      const after = ratingFacts(database);

      // Value for value: the rebuild is a schema change and nothing else, and a lost or duplicated
      // row is exactly what a wrong drop order produces.
      expect(after.entryValues).toEqual(before.entryValues);
      expect(after.producerValues).toEqual(before.producerValues);
      // Every slot and partition that existed is still there, unchanged. (A later migration may
      // legitimately ADD summary dimensions — see `041` — so this is a subset check, not equality.)
      for (const slot of before.slots) expect(after.slots).toContainEqual(slot);
      // A layout's sync_version legitimately moves when a dimension appears (041 mirrors names),
      // so the identity of the partition is what must survive, not its revision.
      const partitionOf = (layout: { sync_uid: string; subject_kind: string; entry_type: string }) =>
        ({ sync_uid: layout.sync_uid, subject_kind: layout.subject_kind, entry_type: layout.entry_type });
      for (const layout of before.layouts) {
        expect(after.layouts.map(partitionOf)).toContainEqual(partitionOf(layout));
      }
      expect(database.pragma('foreign_key_check')).toEqual([]);
      expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      database.close();
    }
  });

  it('lets the third class exist while the two original ones keep working', () => {
    const database = databaseAt(38);
    try {
      seedRatedLibrary(database);
      expect(applyAllMigrations(database).currentVersion).toBeGreaterThanOrEqual(39);

      // The works summary now carries every one of the Gallery's work dimensions: '未评的维度' was
      // seeded as an entry slot only, and `041` brought the summary into step with the template —
      // names only, so the seeded value on '画风精美' is untouched.
      expect(listProducerRatings(database, 2).map((row) => row.name)).toEqual(['画风精美', '未评的维度']);
      expect(listRatingSlots(database, 'entry', 'Comic').map((slot) => slot.name))
        .toEqual(['画风精美', '未评的维度']);
      // The author's own class is NOT mirrored from the template, so it starts empty.
      expect(listAuthorSelfRatings(database, 2)).toEqual([]);

      const selfSlot = createProducerRatingSlot(database, {
        producerId: 2, name: '演技', kind: 'author_self',
      });
      setProducerRating(database, { producerId: 2, slotId: selfSlot.id, stars: 5 });
      expect(listAuthorSelfRatings(database, 2)).toEqual([
        { slotId: selfSlot.id, name: '演技', stars: 5 },
      ]);
      // Its sync partition is born on first use, which is how a new partition has always appeared.
      expect(database.prepare(
        "SELECT COUNT(*) FROM rating_slot_layouts WHERE subject_kind = 'author_self'",
      ).pluck().get()).toBe(1);
      // The two author classes cannot be mistaken for one another.
      expect(listRatingSlots(database, 'producer', 'Comic').map((slot) => slot.name))
        .toEqual(['画风精美', '未评的维度']);
      expect(listRatingSlots(database, 'author_self', 'Comic').map((slot) => slot.name)).toEqual(['演技']);
    } finally {
      database.close();
    }
  });

  it('anchors every Author to the Gallery the derivation used to compute', () => {
    const database = databaseAt(38);
    try {
      const comic = createEntry(database, { title: 'Comic work', type: 'Comic' });
      const comics = createEntry(database, { title: 'Second comic', type: 'Comic' });
      const film = createEntry(database, { title: 'Film', type: '电影' });
      const author = createProducer(database, { name: 'Anchored' });
      linkLegacyEntryProducer(database, comic.id, author.id);
      linkLegacyEntryProducer(database, comics.id, author.id);
      linkLegacyEntryProducer(database, film.id, author.id);
      const lonely = createProducer(database, { name: 'No works' });

      applyAllMigrations(database);

      expect(database.prepare('SELECT gallery_anchor FROM producers WHERE id = ?').pluck().get(author.id))
        .toBe('Comic');
      // An Author with no works has no home Gallery to anchor to, and that stays NULL.
      expect(database.prepare('SELECT gallery_anchor FROM producers WHERE id = ?').pluck().get(lonely.id))
        .toBeNull();
    } finally {
      database.close();
    }
  });
});

/**
 * A rated library written against the schema of its own version.
 *
 * Raw statements on purpose: this fixture exists to be migrated, so it must not depend on today's
 * writers (which name columns, and read facts, that the older schema does not have yet).
 */
function seedRatedLibrary(database: T3Database): void {
  database.exec(`
    INSERT INTO entries (id, title, type) VALUES (1, 'Rated work', 'Comic');
    INSERT INTO producers (id, name) VALUES (2, 'Rated author');
    INSERT INTO entry_producers (entry_id, producer_id) VALUES (1, 2);

    INSERT INTO rating_slots (id, subject_kind, entry_type, name, sort_order, sync_uid) VALUES
      (10, 'entry',    'Comic', '画风精美',   0, 'aaaaaaaa-0000-4000-8000-000000000010'),
      (11, 'entry',    'Comic', '未评的维度', 1, 'aaaaaaaa-0000-4000-8000-000000000011'),
      (12, 'producer', 'Comic', '画风精美',   0, 'aaaaaaaa-0000-4000-8000-000000000012');

    INSERT INTO entry_rating_values (slot_id, entry_id, stars) VALUES (10, 1, 4.5);
    INSERT INTO producer_rating_values (slot_id, producer_id, stars) VALUES (12, 2, 3.5);
  `);
}

/** Everything a rating is made of, so a rebuild that loses or duplicates rows cannot pass. */
function ratingFacts(database: T3Database): {
  slots: unknown[];
  entryValues: unknown[];
  producerValues: unknown[];
  layouts: Array<{ sync_uid: string; subject_kind: string; entry_type: string }>;
} {
  return {
    slots: database.prepare(`
      SELECT id, subject_kind, entry_type, name, sort_order, sync_uid FROM rating_slots ORDER BY id
    `).all(),
    entryValues: database.prepare(`
      SELECT slot_id, entry_id, stars FROM entry_rating_values ORDER BY slot_id, entry_id
    `).all(),
    producerValues: database.prepare(`
      SELECT slot_id, producer_id, stars FROM producer_rating_values ORDER BY slot_id, producer_id
    `).all(),
    layouts: database.prepare(`
      SELECT sync_uid, subject_kind, entry_type, sync_version FROM rating_slot_layouts
      ORDER BY subject_kind, entry_type
    `).all() as Array<{ sync_uid: string; subject_kind: string; entry_type: string }>,
  };
}
