import { describe, expect, it } from 'vitest';

import { parseTaxonomyDictionary } from '../src/taxonomy-dictionary.js';

describe('parseTaxonomyDictionary', () => {
  it('keeps every mapping, including the empty placeholders', () => {
    expect(parseTaxonomyDictionary({
      series: { 'Arknights Endfield': '明日方舟：终末地', Empty: '' },
      authors: { Bob: '鲍勃' },
      tags: {
        accepted: { Ahegao: '阿黑颜', Untranslated: '' },
        rejected: ['Ignored'],
      },
    })).toEqual([
      { vocabulary: 'entry', alias: 'Arknights Endfield', canonicalName: '明日方舟:终末地' },
      { vocabulary: 'entry', alias: 'Empty', canonicalName: '' },
      { vocabulary: 'producer', alias: 'Bob', canonicalName: '鲍勃' },
      { vocabulary: 'entry', alias: 'Ahegao', canonicalName: '阿黑颜' },
      { vocabulary: 'entry', alias: 'Untranslated', canonicalName: '' },
    ]);
  });

  it('flattens the sections: they are how three hand-written adapters split what they read', () => {
    // hitomi and 18comic read a work's series, characters and tags from different places on the page,
    // so their dictionaries carry them in separate sections. A generic adapter reads one field, so
    // every tag arrives together and there is no section to file it under — and the library's own
    // classification is a Tag's Facet, which the import learns from where the tag already lives.
    // Carrying the section through as a partition made the dictionary promise a split that was never
    // in the database, and left `characters`/`series` headings that could never receive anything again.
    const rows = parseTaxonomyDictionary({
      series: { 'JoJo的奇妙冒險': 'JoJo的奇妙冒险' },
      characters: { '一之瀨明日奈': '一之濑明日奈' },
      types: { Manga: '漫画' },
      tags: { accepted: { Ahegao: '阿黑颜' } },
    });

    expect(rows.every((row) => !('partition' in row))).toBe(true);
    expect(rows.map((row) => row.alias).sort())
      .toEqual(['Ahegao', 'JoJo的奇妙冒險', 'Manga', '一之瀨明日奈'].sort());
  });

  it('drops a mapping that says nothing, and sends authors to the producer vocabulary', () => {
    // A pair whose two sides are the same name is not a mapping — the built-in Traditional →
    // Simplified conversion already covers that case, so keeping it would be a row that can never do
    // anything. `authors` is the one section that is a different *kind* of name, not a different
    // filing cabinet.
    expect(parseTaxonomyDictionary({
      series: { Same: 'Same', '  ': 'X' },
      authors: { Bob: '鲍勃' },
    })).toEqual([
      { vocabulary: 'producer', alias: 'Bob', canonicalName: '鲍勃' },
    ]);
  });
});
