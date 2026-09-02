import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import { createEntry, type EntryRecord } from '../../src/repositories/entry-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { assignProducerTag } from '../../src/repositories/producer-tag-repository.js';
import {
  importTaxonomyAliases,
  upsertTaxonomyAlias,
} from '../../src/repositories/taxonomy-repository.js';
import {
  executeProducerMerges,
  planProducerMerges,
} from '../../src/import/merge-producers.js';

function createWork(database: ReturnType<typeof createMigratedMemoryDatabase>, title: string): EntryRecord {
  return createEntry(database, { title, type: 'comic' });
}

function runMerges(database: ReturnType<typeof createMigratedMemoryDatabase>): void {
  database.pragma('foreign_keys = OFF');
  try {
    executeProducerMerges(database, planProducerMerges(database));
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

function producersOf(database: ReturnType<typeof createMigratedMemoryDatabase>): Array<{
  id: number;
  name: string;
}> {
  return database.prepare('SELECT id, name FROM producers ORDER BY id').all() as Array<{
    id: number;
    name: string;
  }>;
}

function linksOf(database: ReturnType<typeof createMigratedMemoryDatabase>, producerId: number): number[] {
  return database.prepare(`
    SELECT entry_id FROM entry_producers WHERE producer_id = ? ORDER BY entry_id
  `).pluck().all(producerId) as number[];
}

describe('merge authors (producers)', () => {
  it('merges identical-name producers, absorbing works, tags, and same-title directories', () => {
    const database = createMigratedMemoryDatabase();
    const first = createWork(database, 'First work');
    const second = createWork(database, 'Second work');
    const third = createWork(database, 'Third work');

    const banseeA = createProducer(database, { name: 'bansee' });
    const banseeB = createProducer(database, { name: 'bansee' });
    const banseeC = createProducer(database, { name: 'bansee' });
    linkEntryProducer(database, first.id, banseeA.id);
    linkEntryProducer(database, second.id, banseeA.id);
    linkEntryProducer(database, third.id, banseeB.id);
    assignProducerTag(database, { producerId: banseeA.id, name: '同人' });
    assignProducerTag(database, { producerId: banseeC.id, name: '合集' });

    // Both have a "Favs" directory; banseeC has none.
    const directoryA = database.prepare(`
      INSERT INTO author_directories (producer_id, title, description, sort_order)
      VALUES (?, 'Favs', '', 0)
    `).run(banseeA.id).lastInsertRowid as number;
    const directoryB = database.prepare(`
      INSERT INTO author_directories (producer_id, title, description, sort_order)
      VALUES (?, 'Favs', '', 0)
    `).run(banseeB.id).lastInsertRowid as number;
    const addMembership = database.prepare(`
      INSERT INTO author_directory_entries (directory_id, producer_id, entry_id, sort_order)
      VALUES (?, ?, ?, 0)
    `);
    addMembership.run(directoryA, banseeA.id, first.id);
    addMembership.run(directoryB, banseeB.id, third.id);

    const plans = planProducerMerges(database);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      canonicalName: null,
      renamed: false,
      keeper: { id: banseeA.id, name: 'bansee' },
    });
    expect(plans[0]!.others.map((member) => member.id).sort((a, b) => a - b))
      .toEqual([banseeB.id, banseeC.id]);

    runMerges(database);

    expect(producersOf(database)).toEqual([{ id: banseeA.id, name: 'bansee' }]);
    expect(linksOf(database, banseeA.id)).toEqual([first.id, second.id, third.id]);
    // Keeper's "Favs" absorbed banseeB's colliding directory; membership merged.
    const directories = database.prepare(`
      SELECT id, producer_id, title
      FROM author_directories
      ORDER BY id
    `).all() as Array<{ id: number; producer_id: number; title: string }>;
    expect(directories).toEqual([{ id: directoryA, producer_id: banseeA.id, title: 'Favs' }]);
    const memberships = database.prepare(`
      SELECT entry_id FROM author_directory_entries ORDER BY entry_id
    `).pluck().all() as number[];
    expect(memberships).toEqual([first.id, third.id]);
    // Both producer tags survived on the keeper.
    const tags = database.prepare(`
      SELECT tag.name
      FROM producer_tag_assignments AS assignment
      JOIN producer_tags AS tag ON tag.id = assignment.tag_id
      WHERE assignment.producer_id = ?
      ORDER BY tag.name
    `).pluck().all(banseeA.id) as string[];
    expect(tags).toEqual(['合集', '同人']);

    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(inspectDatabase(database).ok).toBe(true);
    database.close();
  });

  it('merges dictionary aliases into the canonical author, moving non-colliding directories', () => {
    const database = createMigratedMemoryDatabase();
    upsertTaxonomyAlias(database, {
      vocabulary: 'producer',
      alias: 'bob',
      canonicalName: '鲍勃',
    });
    const bobWork = createWork(database, 'Bob work');
    const canonicalWork = createWork(database, 'Canonical work');
    const bob = createProducer(database, { name: 'bob' });
    const canonical = createProducer(database, { name: '鲍勃' });
    linkEntryProducer(database, bobWork.id, bob.id);
    linkEntryProducer(database, canonicalWork.id, canonical.id);
    const bobDirectory = database.prepare(`
      INSERT INTO author_directories (producer_id, title, description, sort_order)
      VALUES (?, 'Works', 'Imported', 0)
    `).run(bob.id).lastInsertRowid as number;
    database.prepare(`
      INSERT INTO author_directory_entries (directory_id, producer_id, entry_id, sort_order)
      VALUES (?, ?, ?, 0)
    `).run(bobDirectory, bob.id, bobWork.id);

    const plans = planProducerMerges(database);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      canonicalName: '鲍勃',
      renamed: false,
      keeper: { id: canonical.id, name: '鲍勃' },
    });
    expect(plans[0]!.others.map((member) => member.id)).toEqual([bob.id]);

    runMerges(database);

    expect(producersOf(database)).toEqual([{ id: canonical.id, name: '鲍勃' }]);
    expect(linksOf(database, canonical.id)).toEqual([bobWork.id, canonicalWork.id]);
    const directories = database.prepare(`
      SELECT producer_id, title FROM author_directories ORDER BY id
    `).all() as Array<{ producer_id: number; title: string }>;
    expect(directories).toEqual([{ producer_id: canonical.id, title: 'Works' }]);
    const memberships = database.prepare(`
      SELECT entry_id FROM author_directory_entries ORDER BY entry_id
    `).pluck().all() as number[];
    expect(memberships).toEqual([bobWork.id]);

    // Dictionary row is untouched — it also powers the alternates sub-label.
    const aliases = database.prepare(`
      SELECT alias_name, canonical_name
      FROM taxonomy_aliases
      WHERE vocabulary = 'producer'
    `).all() as Array<{ alias_name: string; canonical_name: string }>;
    expect(aliases).toEqual([{ alias_name: 'bob', canonical_name: '鲍勃' }]);

    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(inspectDatabase(database).ok).toBe(true);
    database.close();
  });

  it('renames a lone alias-spelled producer to its dictionary canonical name', () => {
    const database = createMigratedMemoryDatabase();
    upsertTaxonomyAlias(database, {
      vocabulary: 'producer',
      alias: 'ボブ',
      canonicalName: 'Bob',
    });
    const work = createWork(database, 'A work');
    const katakana = createProducer(database, { name: 'ボブ' });
    linkEntryProducer(database, work.id, katakana.id);

    const plans = planProducerMerges(database);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      canonicalName: 'Bob',
      renamed: true,
      keeper: { id: katakana.id, name: 'ボブ' },
    });
    expect(plans[0]!.others).toEqual([]);

    runMerges(database);

    expect(producersOf(database)).toEqual([{ id: katakana.id, name: 'Bob' }]);
    expect(linksOf(database, katakana.id)).toEqual([work.id]);
    expect(inspectDatabase(database).ok).toBe(true);
    database.close();
  });

  it('ignores producer aliases whose canonical name is still empty (placeholders)', () => {
    const database = createMigratedMemoryDatabase();
    importTaxonomyAliases(database, [
      { vocabulary: 'producer', partition: 'authors', alias: 'bob', canonicalName: '鲍勃' },
      { vocabulary: 'producer', partition: 'authors', alias: 'alice', canonicalName: '' },
    ]);
    const author = createProducer(database, { name: 'Banssee' });
    const placeholder = createProducer(database, { name: 'alice' });
    const work = createWork(database, 'A work');
    linkEntryProducer(database, work.id, author.id);

    const plans = planProducerMerges(database);
    // 'bob' has no producer yet, and 'alice' is only a placeholder with no
    // canonical — it must NOT be treated as mapping 'alice' -> '' (which
    // would otherwise group/rename the producer into an empty name).
    expect(plans).toEqual([]);

    runMerges(database);
    expect(producersOf(database)).toEqual([
      { id: author.id, name: 'Banssee' },
      { id: placeholder.id, name: 'alice' },
    ]);
    expect(linksOf(database, author.id)).toEqual([work.id]);
    expect(inspectDatabase(database).ok).toBe(true);
    database.close();
  });
});
