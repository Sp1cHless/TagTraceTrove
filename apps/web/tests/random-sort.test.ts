import { describe, expect, it } from 'vitest';
import { shuffledCopy } from '../src/random-sort.js';

describe('random sorting', () => {
  it('returns a shuffled copy without mutating the source list', () => {
    const source = [1, 2, 3];
    const values = [0.9, 0.1];
    const result = shuffledCopy(source, () => values.shift() ?? 0);

    expect(result).toEqual([2, 1, 3]);
    expect(source).toEqual([1, 2, 3]);
  });
});
