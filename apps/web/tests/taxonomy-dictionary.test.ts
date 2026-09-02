import { describe, expect, it } from 'vitest';
import { parseTaxonomyDictionary } from '../src/taxonomy-dictionary.js';

describe('parseTaxonomyDictionary', () => {
  it('keeps every mapping including empty placeholders, with partition and vocabulary', () => {
    expect(parseTaxonomyDictionary({
      series: { 'Arknights Endfield': '明日方舟：终末地', Empty: '' },
      authors: { Bob: '鲍勃' },
      tags: {
        accepted: { Ahegao: '阿黑颜', Untranslated: '' },
        rejected: ['Ignored'],
      },
    })).toEqual([
      { vocabulary: 'entry', partition: 'series', alias: 'Arknights Endfield', canonicalName: '明日方舟:终末地' },
      { vocabulary: 'entry', partition: 'series', alias: 'Empty', canonicalName: '' },
      { vocabulary: 'producer', partition: 'authors', alias: 'Bob', canonicalName: '鲍勃' },
      { vocabulary: 'entry', partition: 'tags', alias: 'Ahegao', canonicalName: '阿黑颜' },
      { vocabulary: 'entry', partition: 'tags', alias: 'Untranslated', canonicalName: '' },
    ]);
  });
});
