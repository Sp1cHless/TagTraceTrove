import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import { createEntry, type EntryRecord } from '../../src/repositories/entry-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import {
  executeProducerMerges,
  planProducerMerges,
} from '../../src/import/merge-producers.js';
import {
  listAuthorAliasGroups,
  writeAuthorAliasGroup,
} from '../../src/repositories/author-alias-repository.js';

type Database = ReturnType<typeof createMigratedMemoryDatabase>;

function createWork(database: Database, title: string): EntryRecord {
  return createEntry(database, { title, type: 'comic' });
}

function producersOf(database: Database): Array<{ id: number; name: string }> {
  return database.prepare('SELECT id, name FROM producers ORDER BY id').all() as Array<{
    id: number;
    name: string;
  }>;
}

describe('author alias groups', () => {
  it('stores one display name with several tag-name spellings and groups them on read', () => {
    const database = createMigratedMemoryDatabase();
    writeAuthorAliasGroup(database, {
      displayName: '海盗猫',
      tagNames: ['pirate cat', '海盜貓', '海賊猫', '海盗猫'],
    });

    const groups = listAuthorAliasGroups(database);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.canonicalName).toBe('海盗猫');
    expect(groups[0]!.aliases.map((alias) => alias.name).sort())
      .toEqual(['pirate cat', '海盜貓', '海賊猫']);
    // No producer row yet — the display name appears after the next import.
    expect(groups[0]!.producerId).toBeNull();
    expect(groups[0]!.producerName).toBeNull();
    expect(inspectDatabase(database).ok).toBe(true);
    database.close();
  });

  it('rejects duplicate tag names inside one group', () => {
    const database = createMigratedMemoryDatabase();
    expect(() => writeAuthorAliasGroup(database, {
      displayName: '海盗猫',
      tagNames: ['pirate cat', 'Pirate  Cat'],
    })).toThrowError(/duplicate author tag name/);
    database.close();
  });

  it('rejects a group without any tag name besides the display name', () => {
    const database = createMigratedMemoryDatabase();
    expect(() => writeAuthorAliasGroup(database, {
      displayName: '海盗猫',
      tagNames: ['海盗猫', '  '],
    })).toThrowError(/at least one tag name/);
    database.close();
  });

  it('merges duplicate alias-spelled producers into the display-name row', () => {
    const database = createMigratedMemoryDatabase();
    const englishWork = createWork(database, 'English work');
    const chineseWork = createWork(database, 'Chinese work');
    const japaneseWork = createWork(database, 'Japanese work');
    const english = createProducer(database, { name: 'pirate cat' });
    const chinese = createProducer(database, { name: '海盜貓' });
    const japanese = createProducer(database, { name: '海賊猫' });
    linkEntryProducer(database, englishWork.id, english.id);
    linkEntryProducer(database, chineseWork.id, chinese.id);
    linkEntryProducer(database, japaneseWork.id, japanese.id);

    writeAuthorAliasGroup(database, {
      displayName: '海盗猫',
      tagNames: ['pirate cat', '海盜貓', '海賊猫'],
    });

    // No producer named 海盗猫 exists yet; the display name appears when the
    // dictionary merge renames the surviving row.
    const before = listAuthorAliasGroups(database);
    expect(before[0]!.producerId).toBeNull();

    database.pragma('foreign_keys = OFF');
    try {
      executeProducerMerges(database, planProducerMerges(database));
    } finally {
      database.pragma('foreign_keys = ON');
    }

    const producers = producersOf(database);
    expect(producers).toHaveLength(1);
    expect(producers[0]!.name).toBe('海盗猫');
    const links = database.prepare(
      'SELECT entry_id FROM entry_producers WHERE producer_id = ? ORDER BY entry_id',
    ).pluck().all(producers[0]!.id) as number[];
    expect(links).toEqual([englishWork.id, chineseWork.id, japaneseWork.id].sort((a, b) => a - b));

    const groups = listAuthorAliasGroups(database);
    expect(groups[0]!.producerId).toBe(producers[0]!.id);
    expect(groups[0]!.producerName).toBe('海盗猫');
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(inspectDatabase(database).ok).toBe(true);
    database.close();
  });

  it('collapses into the existing display-name producer when one already exists', () => {
    const database = createMigratedMemoryDatabase();
    const aliasWork = createWork(database, 'Alias work');
    const displayWork = createWork(database, 'Display work');
    const alias = createProducer(database, { name: 'PirateCat' });
    const display = createProducer(database, { name: '海盗猫' });
    linkEntryProducer(database, aliasWork.id, alias.id);
    linkEntryProducer(database, displayWork.id, display.id);

    writeAuthorAliasGroup(database, { displayName: '海盗猫', tagNames: ['PirateCat'] });

    database.pragma('foreign_keys = OFF');
    try {
      executeProducerMerges(database, planProducerMerges(database));
    } finally {
      database.pragma('foreign_keys = ON');
    }

    expect(producersOf(database)).toEqual([{ id: display.id, name: '海盗猫' }]);
    const links = database.prepare(
      'SELECT entry_id FROM entry_producers WHERE producer_id = ? ORDER BY entry_id',
    ).pluck().all(display.id) as number[];
    expect(links).toEqual([aliasWork.id, displayWork.id]);

    // The producer-tag vocabulary row for the alias spelling merges too.
    assignAndCheckTagVocabulary(database, alias.id, display.id);
    expect(inspectDatabase(database).ok).toBe(true);
    database.close();
  });
});

function assignAndCheckTagVocabulary(database: Database, aliasId: number, displayId: number): void {
  const tags = database.prepare(`
    SELECT tag.name FROM producer_tag_assignments AS assignment
    JOIN producer_tags AS tag ON tag.id = assignment.tag_id
    WHERE assignment.producer_id = ? OR assignment.producer_id = ?
    ORDER BY tag.name
  `).all(aliasId, displayId) as unknown[];
  // The absorbed producer row is gone, so only the display producer remains.
  expect(database.prepare('SELECT COUNT(*) AS n FROM producers WHERE id = ?')
    .get(aliasId) as { n: number }).toEqual({ n: 0 });
  expect(tags).toEqual([]);
}
