import { describe, expect, it } from 'vitest';
import { normalizeTag } from '../src/index.js';

describe('normalizeTag', () => {
  it('normalizes Unicode, whitespace, and case while preserving semantics', () => {
    expect(normalizeTag('  Ｓｃｈｏｏｌ   Life  ')).toBe('school life');
  });
});
