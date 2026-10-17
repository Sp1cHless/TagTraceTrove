import { describe, expect, it } from 'vitest';
import {
  COVER_TEXT_BUDGET,
  isSourceUrlContentKind,
  isUrlContentValue,
  pickDefaultCoverText,
  truncateToCoverText,
} from '../src/cover-text.js';

const content = (contentType: string, value: string) => ({ contentType, content: value });

describe('cover text rule', () => {
  it('reads the first Content that says something about the work, skipping the Source URL row', () => {
    expect(pickDefaultCoverText({
      contents: [
        content('Source URL', 'https://example.com/works/1'),
        content('description', 'A quiet story about a lighthouse keeper.'),
        content('评价', 'ignored — a later row never wins'),
      ],
      tags: ['Lighthouse'],
    })).toBe('A quiet story about a lighthouse keeper.');
  });

  it('skips an address wherever it is written, not only under the built-in kind', () => {
    expect(isSourceUrlContentKind(' source  url ')).toBe(true);
    expect(isSourceUrlContentKind('Source URL')).toBe(true);
    expect(isUrlContentValue('www.example.com/works/1')).toBe(true);
    expect(isUrlContentValue('https://example.com/works/1')).toBe(true);
    // A description that happens to mention a link is still a description.
    expect(isUrlContentValue('See https://example.com for more')).toBe(false);

    expect(pickDefaultCoverText({
      contents: [content('作品地址', 'https://example.com/works/9'), content('备注', '已完结')],
      tags: [],
    })).toBe('已完结');
  });

  it('ignores Content rows that are empty or only whitespace', () => {
    expect(pickDefaultCoverText({
      contents: [content('description', '   '), content('description', 'The second row has text')],
      tags: [],
    })).toBe('The second row has text');
  });

  it('falls back to the Tags, joined in the order the work shows them', () => {
    expect(pickDefaultCoverText({
      contents: [content('Source URL', 'https://example.com/works/1')],
      tags: ['Lighthouse', 'Drama'],
    })).toBe('Lighthouse · Drama');
  });

  it('answers nothing when the work carries nothing readable, so the title letter stands', () => {
    expect(pickDefaultCoverText({ contents: [], tags: [] })).toBeNull();
    expect(pickDefaultCoverText({
      contents: [content('Source URL', 'https://example.com/works/1')],
      tags: [],
    })).toBeNull();
  });

  it('collapses the line breaks a scraped description carries', () => {
    expect(pickDefaultCoverText({
      contents: [content('description', 'First line\n\n  Second\tline ')],
      tags: [],
    })).toBe('First line Second line');
  });

  it('cuts a long text at its script’s own budget, and only then adds the ellipsis', () => {
    const cjk = '字'.repeat(200);
    const latin = 'a'.repeat(300);

    const cutCjk = truncateToCoverText(cjk);
    const cutLatin = truncateToCoverText(latin);

    expect(cutCjk).toHaveLength(COVER_TEXT_BUDGET.cjk + 1);
    expect(cutLatin).toHaveLength(COVER_TEXT_BUDGET.latin + 1);
    expect(cutCjk.endsWith('…')).toBe(true);
    expect(cutLatin.endsWith('…')).toBe(true);
    // Text that already fits is handed back untouched, with no trailing ellipsis.
    expect(truncateToCoverText('短标题')).toBe('短标题');
    expect(truncateToCoverText('Short title')).toBe('Short title');
  });

  it('stops mixed text at one cover’s worth of room rather than at either count alone', () => {
    const cjkHalf = Math.floor(COVER_TEXT_BUDGET.cjk / 2);
    const latinHalf = Math.floor(COVER_TEXT_BUDGET.latin / 2);
    const cut = truncateToCoverText(`${'中'.repeat(cjkHalf)}${'a'.repeat(latinHalf + 50)}`);
    expect(cut).toHaveLength(cjkHalf + latinHalf + 1);
    expect(cut.startsWith('中'.repeat(cjkHalf))).toBe(true);
  });

  it('takes the two budgets separately, so one script can be tightened alone', () => {
    const tightLatin = { cjk: COVER_TEXT_BUDGET.cjk, latin: 20 };
    expect(truncateToCoverText('a'.repeat(300), tightLatin)).toHaveLength(21);
    expect(truncateToCoverText('字'.repeat(200), tightLatin)).toHaveLength(COVER_TEXT_BUDGET.cjk + 1);
  });
});
