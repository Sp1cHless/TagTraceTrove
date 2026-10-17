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
  it('brings a Traditional spelling in as Simplified, without any dictionary', () => {
    // The three scripts a tag arrives in: English, Traditional Chinese, Simplified Chinese. Only
    // Traditional → Simplified can be done without asking anybody — the same language written two
    // ways — so it is built in and needs no dictionary at all. English is a translation and is left
    // for the alias dictionary. Measured on jable.tv (2026-10-05), whose 45 pending tags include 24
    // Traditional spellings that used to enter the library exactly as the site spelled them.
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'manga', name: 'Tags' });
      const work = createEntry(database, { title: 'A work', type: 'manga' });
      assignEntryTag(database, { entryId: work.id, facetId: section.defaultFacetId, name: '乳膠衣' });

      expect(listEntryTags(database, work.id)).toMatchObject([{ name: '乳胶衣' }]);
      expect(resolveTaxonomyName(database, 'entry', '三田真鈴')).toBe('三田真铃');
      // And a name that is not Chinese is left exactly as it is — the dictionary's job, not this one.
      expect(resolveTaxonomyName(database, 'entry', 'Ahegao')).toBe('Ahegao');
    } finally {
      database.close();
    }
  });

  it('treats a Traditional and a Simplified spelling of one name as one dictionary row', () => {
    // The dictionary is written simplified on both sides, so the two spellings collapse to one
    // identity instead of becoming two rows that answer differently.
    const database = createMigratedMemoryDatabase();
    try {
      const first = upsertTaxonomyAlias(database, {
        vocabulary: 'entry', alias: '乳膠衣', canonicalName: '内衣',
      });
      expect(first.alias).toBe('乳胶衣');

      // Written the other way round, it is the same row rather than a second one.
      const second = upsertTaxonomyAlias(database, {
        vocabulary: 'entry', alias: '乳胶衣', canonicalName: '内衣',
      });
      expect(second.id).toBe(first.id);
      expect(listTaxonomyAliases(database, 'entry')).toHaveLength(1);

      // And either spelling resolves through it.
      expect(resolveTaxonomyName(database, 'entry', '乳膠衣')).toBe('内衣');
      expect(resolveTaxonomyName(database, 'entry', '乳胶衣')).toBe('内衣');

      // A mapping that says nothing — Traditional to its own Simplified form — does not become a
      // row of its own: the canonical is resolved through the dictionary too, so the request lands
      // back on the mapping that is already there instead of fighting it.
      const third = upsertTaxonomyAlias(database, {
        vocabulary: 'entry', alias: '乳膠衣', canonicalName: '乳胶衣',
      });
      expect(third.id).toBe(first.id);
      expect(third.canonicalName).toBe('内衣');
      expect(listTaxonomyAliases(database, 'entry')).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('imports a work even when the dictionary holds a row that points a name at itself', () => {
    // The failure this exists for, measured on a real library: a migration simplified a row's alias so
    // that `黃泉 → 黄泉` became a name mapped to itself, and `resolveTaxonomyName` threw on it. Because
    // committing a work resolves every tag it carries, **every import of that site** answered 500 —
    // the browser said "Internal server error" and the work could not be imported at all. A broken
    // dictionary row must not be able to stop a work from being imported.
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'comic', name: 'Tags' });
      database.prepare(`INSERT INTO taxonomy_aliases
        (vocabulary, partition, alias_name, normalized_alias, canonical_name, normalized_canonical)
        VALUES ('entry', 'tags', '黄泉', '黄泉', '黄泉', '黄泉')`).run();

      // The walk stops at the loop instead of failing: the name it had reached is what those rows say.
      expect(resolveTaxonomyName(database, 'entry', '黄泉')).toBe('黄泉');

      // And a commit carrying that tag goes through.
      const result = commitImportBatch(database, {
        source: 'example.test',
        warnings: [],
        entries: [{
          externalKey: 'example.test:42',
          title: 'A work',
          tags: [{ name: '黄泉', sourceField: 'tags' }],
          sources: [{ label: 'example', url: 'https://example.test/w/42' }],
        }],
      }, {
        entryType: 'comic',
        canonicalTagFacetId: section.defaultFacetId,
        sourceContentType: 'Source URL',
        externalKeyContentType: 'External Key',
        fieldMappings: {},
        ignoredFields: [],
        authorRatings: [],
      } as never);
      expect(result.entries).toHaveLength(1);
      expect(listEntryTags(database, result.entries[0]!.entryId)).toMatchObject([{ name: '黄泉' }]);
    } finally {
      database.close();
    }
  });

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
        authorRatings: [],
      });
      const importedId = database.prepare("SELECT id FROM entries WHERE title = 'Later work'").pluck().get() as number;
      expect(listEntryTags(database, importedId)).toMatchObject([{ name: '鲍勃' }]);
      // The catalog is the library's tags *and* the stored mappings: the mapping row, and the tag
      // it resolves to — a tag in the library, so it reports itself as its own canonical.
      expect(listTaxonomyAliases(database, 'entry')).toMatchObject([
        { alias: 'Bob', canonicalName: '鲍勃' },
        { alias: '鲍勃', canonicalName: '鲍勃' },
      ]);
    } finally {
      database.close();
    }
  });

  it('shows a tag a work brought in, before anyone has mapped it', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const section = createSection(database, { entryType: 'manga', name: 'Tags' });
      const work = createEntry(database, { title: 'A work', type: 'manga' });
      // The same call an import makes for every tag it brings in (`commit.ts` → `assignEntryTag`),
      // so this is what a work arriving does to the catalog.
      assignEntryTag(database, { entryId: work.id, facetId: section.defaultFacetId, name: 'NTR' });

      // Nothing was imported from a dictionary: the catalog is a view of the library, so the tag is
      // already there and says it has no mapping yet.
      expect(listTaxonomyAliases(database, 'entry')).toMatchObject([
        { alias: 'NTR', canonicalName: '', tagId: expect.any(Number) },
      ]);

      upsertTaxonomyAlias(database, { vocabulary: 'entry', alias: 'NTR', canonicalName: '牛头人' });

      // Mapping it merges the tag into the canonical, so the catalog then carries the mapping and
      // the canonical tag's own row.
      expect(listTaxonomyAliases(database, 'entry')).toMatchObject([
        { alias: 'NTR', canonicalName: '牛头人' },
        { alias: '牛头人', canonicalName: '牛头人', tagId: expect.any(Number) },
      ]);
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
