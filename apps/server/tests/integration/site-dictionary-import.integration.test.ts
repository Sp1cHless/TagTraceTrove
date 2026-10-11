import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { importSiteDictionaries } from '../../src/taxonomy/import-dictionaries.js';
import {
  importTaxonomyAliases,
  listTaxonomyAliases,
  resolveTaxonomyName,
} from '../../src/repositories/taxonomy-repository.js';

/**
 * The one-time move off the tool's export tree.
 *
 * Each crawl writes `<export>/<group>/taxonomy_dictionary.json`; before this existed the only way to
 * use one was to find the file and hand it to the dictionary page, which stopped happening when a work
 * began going from a crawl to the library with nobody opening anything in between. Measured on this
 * machine: seven sites' dictionaries, 207+290 accepted mappings and 1,340 author spellings on the two
 * oldest — all stranded.
 *
 * What comes across is what a person **decided**. The tool fills every empty translation with its own
 * Traditional → Simplified conversion, so most of a dictionary is pairs this library already computes
 * for itself; those are passed over, and the dictionary keeps the mappings that carry information.
 */
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function exportTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 't3-site-dictionaries-'));
  directories.push(root);
  const write = async (group: string, document: unknown): Promise<void> => {
    await mkdir(join(root, group), { recursive: true });
    await writeFile(join(root, group, 'taxonomy_dictionary.json'),
                    JSON.stringify(document), 'utf8');
  };
  // A site whose dictionary carries a real decision, one the conversion already covers, and a name
  // nobody has decided about yet.
  await write('18comic_vip', {
    series: { 'JoJo的奇妙冒險': 'JoJo的奇妙冒险' },
    characters: { '一之瀨明日奈': '一之濑明日奈' },
    tags: {
      accepted: {
        'AI繪圖': 'AI绘图',
        Ahegao: '阿黑颜',
        '乳膠衣': '乳胶衣',
        Untranslated: '',
      },
      rejected: ['Something unwanted'],
    },
    authors: { 'Bee導師': 'Bee导师' },
  });
  // A site with nothing decided at all, which is a dictionary of pure placeholders.
  await write('jable.tv', {
    tags: { accepted: { '三田真鈴': '', '制服誘惑': '' } },
  });
  // A group with no dictionary at all, which is not a failure.
  await mkdir(join(root, 'manwa.me'), { recursive: true });
  return root;
}

describe('bringing the site dictionaries across', () => {
  it('keeps what a person decided and passes over what the conversion already does', async () => {
    const database = createMigratedMemoryDatabase();
    try {
      const result = importSiteDictionaries(database, await exportTree());

      expect(result.sites).toBe(2);
      // Five pairs are the tool's own t2s output — `JoJo的奇妙冒險 → JoJo的奇妙冒险`,
      // `一之瀨明日奈 → 一之濑明日奈`, `AI繪圖 → AI绘图`, `乳膠衣 → 乳胶衣` and the author
      // `Bee導師 → Bee导师`. The library computes all of those itself now, so they are passed over
      // rather than stored as rows that could never do anything.
      expect(result.skipped).toBe(5);
      // What is left is what carries information: one translation, and three names nobody has
      // decided about yet (which is what the dictionary page exists to work through).
      expect(result.imported).toBe(4);
      expect(result.pending).toBe(3);

      expect(resolveTaxonomyName(database, 'entry', 'Ahegao')).toBe('阿黑颜');
      // A Traditional spelling reaches its Simplified form through the built-in conversion, with no
      // row needed for it.
      expect(resolveTaxonomyName(database, 'entry', '乳膠衣')).toBe('乳胶衣');
      expect(resolveTaxonomyName(database, 'producer', 'Bee導師')).toBe('Bee导师');
      // The sections are flattened: `characters` and `series` are not a filing system any more.
      const entryRows = listTaxonomyAliases(database, 'entry');
      expect(entryRows.every((row) => row.partition === '')).toBe(true);
      // Stored simplified, placeholders included: the alias column holds one script, so a site's
      // Traditional spelling is the same row as its Simplified one rather than a second name.
      expect(entryRows.map((row) => row.alias).sort())
        .toEqual(['Ahegao', 'Untranslated', '三田真铃', '制服诱惑'].sort());

      // Running it again changes nothing: the dictionary is the alias table now.
      const again = importSiteDictionaries(database, await exportTree());
      expect(again.imported).toBe(4);
      expect(listTaxonomyAliases(database, 'entry')).toHaveLength(4);
    } finally {
      database.close();
    }
  });

  it('re-writes the rows that were stored before the library converted anything', async () => {
    // A row's identity is its simplified spelling now, so a row written the old way — keyed on the
    // Traditional form — stops being found the moment the lookup simplifies what it is asked about:
    // both spellings came back as themselves and the translation `內衣` was silently lost. Every
    // library that imported a dictionary by hand before this existed holds rows of exactly this shape.
    const database = createMigratedMemoryDatabase();
    try {
      const insert = (alias: string, canonical: string): void => {
        database.prepare(`INSERT INTO taxonomy_aliases
          (vocabulary, partition, alias_name, normalized_alias, canonical_name, normalized_canonical)
          VALUES ('entry', 'tags', ?, ?, ?, ?)`).run(alias, alias, canonical, canonical);
      };
      insert('乳膠衣', '內衣');
      // …and the same name entered the other way, which has to fold into it rather than collide.
      insert('乳胶衣', '');
      expect(resolveTaxonomyName(database, 'entry', '乳膠衣')).toBe('乳胶衣');

      const result = importSiteDictionaries(database, await exportTree());

      expect(result.rewritten).toBe(1);
      expect(result.merged).toBe(1);
      // The mapping is back, and both spellings reach it.
      expect(resolveTaxonomyName(database, 'entry', '乳膠衣')).toBe('内衣');
      expect(resolveTaxonomyName(database, 'entry', '乳胶衣')).toBe('内衣');
      expect(listTaxonomyAliases(database, 'entry').filter((row) => row.alias === '乳胶衣'))
        .toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('drops a row the simplification turned into a name mapped to itself', async () => {
    // The bug this exists for, measured on a real library: the rewrite simplified a row's alias, so a
    // pair like `黃泉 → 黄泉` — Traditional to its own Simplified form, which the tool filled in — became
    // "a name mapped to itself". `resolveTaxonomyName` follows that into a loop and throws, and because
    // the import is one transaction the whole commit answered **500**, on every import of that site.
    // The real library held 591 of them, all length-1 loops, every one made by this pass.
    const database = createMigratedMemoryDatabase();
    try {
      const insert = (alias: string, canonical: string): void => {
        database.prepare(`INSERT INTO taxonomy_aliases
          (vocabulary, partition, alias_name, normalized_alias, canonical_name, normalized_canonical)
          VALUES ('entry', 'tags', ?, ?, ?, ?)`).run(alias, alias, canonical, canonical);
      };
      insert('黃泉', '黄泉');
      // Before the pass it resolves — the two sides are different names.
      expect(resolveTaxonomyName(database, 'entry', '黃泉')).toBe('黄泉');

      // Make it the shape the pass produces, then run the pass.
      database.prepare(`UPDATE taxonomy_aliases SET alias_name = '黄泉', normalized_alias = '黄泉'`).run();
      const result = importSiteDictionaries(database, await exportTree());

      // The row is gone rather than left to loop, and the name still resolves — to itself, which is
      // what the built-in conversion would have produced anyway.
      expect(result.merged).toBeGreaterThanOrEqual(1);
      expect(listTaxonomyAliases(database, 'entry').filter((row) => row.alias === '黄泉')).toHaveLength(0);
      expect(resolveTaxonomyName(database, 'entry', '黃泉')).toBe('黄泉');
    } finally {
      database.close();
    }
  });

  it("keeps the library's own mapping when a site's dictionary says the opposite", async () => {
    // The failure this exists for: a site's dictionary said `Bob → 鲍勃` while the library already said
    // `鲍勃 → Bob`. The cycle check threw, and because a bulk import is one transaction the whole move
    // answered 500 — naming nothing, and taking two thousand other names with it. Measured before the
    // fix: `THREW: taxonomy alias must differ from its canonical name`.
    const database = createMigratedMemoryDatabase();
    try {
      importTaxonomyAliases(database, [
        { vocabulary: 'entry', alias: '鲍勃', canonicalName: 'Bob' },
      ]);

      const result = importTaxonomyAliases(database, [
        { vocabulary: 'entry', alias: 'Bob', canonicalName: '鲍勃' },
        { vocabulary: 'entry', alias: 'Ahegao', canonicalName: '阿黑颜' },
      ]);

      // The library keeps its own answer — it is the one a person worked on — and the other pair is
      // written, so one contradiction does not take the rest of the dictionary with it.
      expect(result.aliases.map((alias) => alias.alias)).toEqual(['Ahegao']);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.alias).toBe('Bob');
      expect(resolveTaxonomyName(database, 'entry', '鲍勃')).toBe('Bob');
    } finally {
      database.close();
    }
  });

  it('answers nothing at all when there is no export tree', () => {
    const database = createMigratedMemoryDatabase();
    try {
      // Nothing to bring across, but the rows already in the library are still re-written: that half
      // repairs a library whether or not a crawl has ever run on this machine.
      expect(importSiteDictionaries(database, join(tmpdir(), 't3-no-such-export-tree')))
        .toEqual({
          sites: 0, imported: 0, pending: 0, skipped: 0, conflicts: [], rewritten: 0, merged: 0,
        });
    } finally {
      database.close();
    }
  });
});
