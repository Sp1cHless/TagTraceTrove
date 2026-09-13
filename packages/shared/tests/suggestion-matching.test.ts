import { describe, expect, it } from 'vitest';
import { rankRelationSuggestions } from '../src/index.js';

type Candidate = {
  id: number;
  name: string;
  aliases?: string[];
  sameContextUsageCount: number;
  totalUsageCount: number;
};

function candidate(
  id: number,
  name: string,
  options: Partial<Omit<Candidate, 'id' | 'name'>> = {},
): Candidate {
  return {
    id,
    name,
    aliases: options.aliases ?? [],
    sameContextUsageCount: options.sameContextUsageCount ?? 0,
    totalUsageCount: options.totalUsageCount ?? 0,
  };
}

describe('relation suggestion matching', () => {
  it('returns no candidates for empty or Unicode-whitespace-only queries', () => {
    const candidates = [candidate(1, '校园')];
    expect(rankRelationSuggestions(candidates, '')).toEqual([]);
    expect(rankRelationSuggestions(candidates, '   ')).toEqual([]);
    expect(rankRelationSuggestions(candidates, '\u3000')).toEqual([]);
  });

  it('requires the complete normalized query to occur in the canonical name', () => {
    const candidates = [
      candidate(1, '学校', { totalUsageCount: 100 }),
      candidate(2, '校园生活'),
      candidate(3, '校服', { totalUsageCount: 999 }),
      candidate(4, '校园'),
    ];

    expect(rankRelationSuggestions(candidates, '校').map((item) => item.name))
      .toEqual(['校服', '校园', '校园生活', '学校']);
    expect(rankRelationSuggestions(candidates, '校园').map((item) => item.name))
      .toEqual(['校园', '校园生活']);
  });

  it('supports English partial words, multi-token substrings, and NFKC input', () => {
    const candidates = [
      candidate(1, 'High School'),
      candidate(2, 'School Life'),
      candidate(3, 'School Uniform'),
      candidate(4, 'C++'),
    ];

    expect(rankRelationSuggestions(candidates, 'sch').map((item) => item.name))
      .toEqual(['School Life', 'School Uniform', 'High School']);
    expect(rankRelationSuggestions(candidates, 'school u').map((item) => item.name))
      .toEqual(['School Uniform']);
    expect(rankRelationSuggestions(candidates, 'school   u').map((item) => item.name))
      .toEqual(['School Uniform']);
    expect(rankRelationSuggestions(candidates, 'schol')).toEqual([]);
    expect(rankRelationSuggestions(candidates, 'Ｃ＋＋').map((item) => item.name))
      .toEqual(['C++']);
  });

  it('allows aliases to establish eligibility and reports the matched alias', () => {
    const results = rankRelationSuggestions([
      candidate(1, '青色之箱', { aliases: ['Blue Box', 'Ao no Hako'] }),
      candidate(2, '蓝色监狱', { aliases: ['Blue Lock'] }),
      candidate(3, '蓝箱'),
    ], 'blue b');

    expect(results).toEqual([{
      id: 1,
      name: '青色之箱',
      matchedAlias: 'Blue Box',
      sameContextUsageCount: 0,
      totalUsageCount: 0,
    }]);
  });

  it('keeps canonical eligibility ahead of alias matches and picks aliases deterministically', () => {
    const results = rankRelationSuggestions([
      candidate(1, 'After Blue Box', { totalUsageCount: 0 }),
      candidate(2, '青色之箱', { aliases: ['Blue Box'], totalUsageCount: 999 }),
    ], 'blue box');

    expect(results.map((item) => item.id)).toEqual([1, 2]);
    expect(rankRelationSuggestions([
      candidate(3, '学校', { aliases: ['ＳＣＨＯＯＬ', 'school'] }),
    ], 'school')[0]?.matchedAlias).toBe('school');
  });

  it('deduplicates repeated canonical IDs after selecting the best-ranked row', () => {
    expect(rankRelationSuggestions([
      candidate(1, 'After School', { totalUsageCount: 999 }),
      candidate(1, 'School', { totalUsageCount: 1 }),
      candidate(2, 'School Life'),
    ], 'school').map((item) => item.id)).toEqual([1, 2]);
  });

  it('ranks only eligible candidates by match class, context use, total use, name, and id', () => {
    const results = rankRelationSuggestions([
      candidate(9, 'School Club', { sameContextUsageCount: 1, totalUsageCount: 20 }),
      candidate(8, 'School Club', { sameContextUsageCount: 1, totalUsageCount: 20 }),
      candidate(7, 'School Days', { sameContextUsageCount: 2, totalUsageCount: 1 }),
      candidate(6, 'After School', { sameContextUsageCount: 999, totalUsageCount: 999 }),
      candidate(5, 'Scholar', { totalUsageCount: 9999 }),
    ], 'school');

    expect(results.map((item) => item.id)).toEqual([7, 8, 9, 6]);
  });

  it('applies a deterministic bounded result limit after ranking', () => {
    const candidates = Array.from({ length: 25 }, (_, index) => candidate(
      index + 1,
      `校${String(index + 1).padStart(2, '0')}`,
    ));

    expect(rankRelationSuggestions(candidates, '校')).toHaveLength(20);
    expect(rankRelationSuggestions(candidates, '校', 3).map((item) => item.id))
      .toEqual([1, 2, 3]);
  });
});
