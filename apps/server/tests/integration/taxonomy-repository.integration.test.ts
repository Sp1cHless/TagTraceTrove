import { describe, expect, it } from 'vitest';
import { commitImportBatch } from '../../src/import/commit.js';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { assignEntryTag, listEntryTags } from '../../src/repositories/entry-tag-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { createProducer } from '../../src/repositories/producer-repository.js';
import { assignProducerTag, listProducerTags } from '../../src/repositories/producer-tag-repository.js';
import {
  importTaxonomyAliases,
  listTaxonomyAliases,
  resolveTaxonomyName,
  upsertTaxonomyAlias,
} from '../../src/repositories/taxonomy-repository.js';

describe('taxonomy repository', () => {
  it('merges an existing Entry Tag alias and resolves it for later imports', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'manga', name: 'Characters' });
      const english = createEntry(database, { title: 'English work', type: 'manga' });
      const chinese = createEntry(database, { title: 'Chinese work', type: 'manga' });
      assignEntryTag(database, { entryId: english.id, facetId: section.defaultFacetId, name: 'Bob' });
      assignEntryTag(database, { entryId: chinese.id, facetId: section.defaultFacetId, name: '鲍勃' });

      const alias = upsertTaxonomyAlias(database, {
        vocabulary: 'entry',
        alias: 'Bob',
        canonicalName: '鲍勃',
      });

      expect(alias).toMatchObject({ vocabulary: 'entry', alias: 'Bob', canonicalName: '鲍勃' });
      expect(resolveTaxonomyName(database, 'entry', ' bob ')).toBe('鲍勃');
      expect(listEntryTags(database, english.id)).toMatchObject([{ name: '鲍勃' }]);
      expect(listEntryTags(database, chinese.id)).toMatchObject([{ name: '鲍勃' }]);
      expect(database.prepare('SELECT COUNT(*) FROM tags').pluck().get()).toBe(1);

      commitImportBatch(database, {
        source: 'example.test',
        warnings: [],
        entries: [{ title: 'Later work', tags: [{ name: 'BOB' }] }],
      }, {
        entryType: 'manga',
        canonicalTagFacetId: section.defaultFacetId,
        sourceContentType: 'source url',
        externalKeyContentType: 'external key',
        fieldMappings: {},
        ignoredFields: [],
      });
      const importedId = database.prepare("SELECT id FROM entries WHERE title = 'Later work'").pluck().get() as number;
      expect(listEntryTags(database, importedId)).toMatchObject([{ name: '鲍勃' }]);
      expect(listTaxonomyAliases(database, 'entry')).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('keeps Producer aliases in a separate vocabulary and merges their assignments', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const first = createProducer(database, { name: 'First' });
      const second = createProducer(database, { name: 'Second' });
      assignProducerTag(database, { producerId: first.id, name: 'Circle' });
      assignProducerTag(database, { producerId: second.id, name: '社团' });

      upsertTaxonomyAlias(database, {
        vocabulary: 'producer',
        alias: 'Circle',
        canonicalName: '社团',
      });

      expect(listProducerTags(database, first.id)).toMatchObject([{ name: '社团' }]);
      expect(listProducerTags(database, second.id)).toMatchObject([{ name: '社团' }]);
      expect(resolveTaxonomyName(database, 'entry', 'Circle')).toBe('Circle');
      expect(resolveTaxonomyName(database, 'producer', 'Circle')).toBe('社团');
    } finally {
      database.close();
    }
  });

  it('keeps partition labels and resolves names past placeholder rows', () => {
    const database = createMigratedMemoryDatabase();
    try {
      importTaxonomyAliases(database, [
        { vocabulary: 'entry', partition: 'series', alias: 'Arknights', canonicalName: '明日方舟' },
        { vocabulary: 'entry', partition: 'characters', alias: 'alice', canonicalName: '' },
        { vocabulary: 'producer', partition: 'authors', alias: 'bob', canonicalName: '鲍勃' },
      ]);

      const listed = listTaxonomyAliases(database);
      expect(listed).toHaveLength(3);
      expect(listed.find((alias) => alias.alias === 'Arknights')).toMatchObject({
        vocabulary: 'entry',
        partition: 'series',
        canonicalName: '明日方舟',
      });
      expect(listed.find((alias) => alias.alias === 'alice')).toMatchObject({
        vocabulary: 'entry',
        partition: 'characters',
        canonicalName: '',
      });
      expect(listed.find((alias) => alias.alias === 'bob')).toMatchObject({
        vocabulary: 'producer',
        partition: 'authors',
        canonicalName: '鲍勃',
      });

      // A placeholder row has no canonical yet, so resolution passes the name
      // through unchanged instead of mapping it to an empty string.
      expect(resolveTaxonomyName(database, 'entry', 'alice')).toBe('alice');
      expect(resolveTaxonomyName(database, 'producer', 'bob')).toBe('鲍勃');

      // Filling the placeholder upgrades the same row (no duplicate) and the
      // name now resolves.
      upsertTaxonomyAlias(database, {
        vocabulary: 'entry',
        partition: 'characters',
        alias: 'alice',
        canonicalName: '爱丽丝',
      });
      expect(listTaxonomyAliases(database)).toHaveLength(3);
      expect(resolveTaxonomyName(database, 'entry', 'alice')).toBe('爱丽丝');
      expect(resolveTaxonomyName(database, 'entry', 'alice').normalize('NFKC')).toBe('爱丽丝');
    } finally {
      database.close();
    }
  });

  it('never downgrades a completed mapping to a blank placeholder on re-import', () => {
    const database = createMigratedMemoryDatabase();
    try {
      importTaxonomyAliases(database, [
        { vocabulary: 'producer', alias: 'bob', canonicalName: '鲍勃' },
        { vocabulary: 'producer', alias: 'bob', canonicalName: '' },
      ]);
      const listed = listTaxonomyAliases(database, 'producer');
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ alias: 'bob', canonicalName: '鲍勃' });
    } finally {
      database.close();
    }
  });

  it('rejects an empty canonical name from the manual upsert path', () => {
    const database = createMigratedMemoryDatabase();
    try {
      expect(() => upsertTaxonomyAlias(database, {
        vocabulary: 'entry',
        alias: 'bob',
        canonicalName: '',
      })).toThrow(/cannot be empty/u);
    } finally {
      database.close();
    }
  });
});
