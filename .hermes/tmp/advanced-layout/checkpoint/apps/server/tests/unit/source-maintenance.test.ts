import { describe, expect, it } from 'vitest';
import { buildTitleVariants } from '../../src/source-maintenance/title-variants.js';
import {
  bandCandidates,
  isDefaultSelectable,
  type EvidenceContext,
} from '../../src/source-maintenance/evidence.js';

describe('title variants', () => {
  it('normalizes full-width characters and keeps the complete title first', () => {
    expect(buildTitleVariants('青色之箱')).toEqual(['青色之箱']);
    expect(buildTitleVariants('ＢＬＵＥ　ＢＯＸ')).toEqual(['blue box']);
    expect(buildTitleVariants('  Blue   Box  ')).toEqual(['blue box']);
  });

  it('splits explicit separator fragments without dropping the full title', () => {
    const variants = buildTitleVariants('Ao no Hako | 青色之箱');
    expect(variants[0]).toBe('ao no hako | 青色之箱');
    expect(variants).toContain('ao no hako');
    expect(variants).toContain('青色之箱');
  });

  it('deduplicates variants and caps the query budget', () => {
    const variants = buildTitleVariants('Blue Box | blue box | ブルーボックス | blue box / Blue Box | a | b');
    expect(new Set(variants).size).toBe(variants.length);
    expect(variants.length).toBeLessThanOrEqual(6);
    expect(variants[0]).toBe('blue box | blue box | ブルーボックス | blue box / blue box | a | b');
  });

  it('never invents variants from identity-deciding tokens', () => {
    // Volume markers and oneshot hints stay part of the whole title; the
    // engine must not decide by itself that they can be dropped.
    expect(buildTitleVariants('Blue Box Vol.1')).toEqual(['blue box vol.1']);
    expect(buildTitleVariants('Blue Box (oneshot)')).toEqual(['blue box (oneshot)']);
  });
});

describe('evidence bands', () => {
  const trustedTitles = [
    { value: '青色之箱', kind: 'title' as const },
    { value: '蓝箱', kind: 'alias' as const },
    { value: '青春之箱', kind: 'alias' as const },
    { value: 'アオのハコ', kind: 'title' as const },
    { value: 'Ao no Hako', kind: 'romaji' as const },
    { value: 'Blue Box', kind: 'alias' as const },
  ];
  const freeUrl = () => false;

  function context(overrides: Partial<EvidenceContext> = {}): EvidenceContext {
    return { trustedTitles, isUrlOwnedByOtherEntry: freeUrl, ...overrides };
  }

  it('admits a unique trusted alias hit with full work-kind evidence as exact-safe', () => {
    const [candidate] = bandCandidates([{
      url: 'https://target.example/works/blue-box',
      title: 'Blue Box',
      language: 'en',
      workKind: 'series',
    }], context());
    if (candidate === undefined) throw new Error('candidate missing');
    expect(candidate.band).toBe('exact-safe');
    expect(isDefaultSelectable(candidate)).toBe(true);
    expect(candidate.reasons.join(' ')).toContain('trusted alias');
  });

  it('keeps work-kind-less canonical matches in strong-review (oneshot/series risk)', () => {
    const candidates = bandCandidates([{
      url: 'https://target.example/works/blue-box',
      title: '青色之箱',
    }], context());
    expect(candidates[0]!.band).toBe('strong-review');
    expect(candidates[0]!.reasons.join(' ')).toContain('work-kind');
  });

  it('stays ambiguous when only a translation alias and nothing else matches', () => {
    const candidates = bandCandidates([{
      url: 'https://target.example/works/ao-hako-alt',
      title: '青春之箱',
    }], context());
    expect(candidates[0]!.band).toBe('ambiguous');
    expect(isDefaultSelectable(candidates[0]!)).toBe(false);
  });

  it('demotes Romaji-only matches without creator evidence to ambiguous', () => {
    const supported = bandCandidates([{
      url: 'https://target.example/works/romaji',
      title: 'Ao no Hako',
      creators: ['三浦糀'],
      workKind: 'series',
    }], context({ entryCreators: ['三浦糀'] }));
    expect(supported[0]!.band).toBe('strong-review');

    const unsupported = bandCandidates([{
      url: 'https://target.example/works/romaji',
      title: 'Ao no Hako',
      workKind: 'series',
    }], context({ entryCreators: ['三浦糀'] }));
    expect(unsupported[0]!.band).toBe('ambiguous');
  });

  it('raises conflict for oneshot/series collisions and same-name different-author works', () => {
    const oneshot = bandCandidates([{
      url: 'https://target.example/works/blue-box-prototype',
      title: 'Blue Box',
      workKind: 'oneshot',
    }], context({ entryWorkKind: 'series' }));
    expect(oneshot[0]!.band).toBe('conflict');
    expect(oneshot[0]!.reasons.join(' ')).toContain('work kind');

    const otherAuthor = bandCandidates([{
      url: 'https://target.example/works/other-blue-box',
      title: 'Blue Box',
      creators: ['Someone Else'],
      workKind: 'series',
    }], context({ entryCreators: ['三浦糀'], entryWorkKind: 'series' }));
    expect(otherAuthor[0]!.band).toBe('conflict');
    expect(otherAuthor[0]!.reasons.join(' ')).toContain('disjoint');
  });

  it('raises conflict when the target URL is already owned by another Entry', () => {
    const candidates = bandCandidates([{
      url: 'https://target.example/works/taken',
      title: 'Blue Box',
      workKind: 'series',
    }], context({ isUrlOwnedByOtherEntry: () => true }));
    expect(candidates[0]!.band).toBe('conflict');
    expect(candidates[0]!.reasons.join(' ')).toContain('another Entry');
  });

  it('treats a candidate whose external id matches the origin slug as strong-review', () => {
    // hitomi slugs embed the mirrored gallery id; the adapter carries it as
    // a catalog id, so the id equality is identity evidence for the review.
    const candidates = bandCandidates([{
      url: 'https://target.example/g/3133339/4e34ee3a35',
      title: '[nameco] Some Title (Blue Archive) [Chinese]',
      catalogIds: ['ehentai:3133339'],
    }], context({ originExternalIds: ['ehentai:3133339'] }));
    expect(candidates[0]!.band).toBe('strong-review');
    expect(candidates[0]!.reasons.join(' ')).toContain('origin source URL');
  });

  it('never promotes similarity-only candidates', () => {
    const candidates = bandCandidates([{
      url: 'https://target.example/works/like-blue-box',
      title: 'Blue Boxx',
      workKind: 'series',
    }], context({ entryWorkKind: 'series' }));
    expect(candidates[0]!.band).toBe('ambiguous');
    expect(candidates[0]!.reasons.join(' ')).toContain('never eligible');
  });

  it('marks shared-title collisions as ambiguous even when each hit is trusted', () => {
    const candidates = bandCandidates([
      { url: 'https://target.example/works/series', title: '青色之箱', workKind: 'series' },
      { url: 'https://target.example/works/oneshot', title: '青色之箱', workKind: 'oneshot' },
    ], context({ entryWorkKind: 'series' }));
    // Different work kinds conflict first — the ambiguity guard applies when
    // work-kind evidence is absent on both.
    expect(candidates.map((candidate) => candidate.band)).toContain('conflict');

    const unnamedKinds = bandCandidates([
      { url: 'https://target.example/works/a', title: '蓝箱', workKind: 'series' },
      { url: 'https://target.example/works/b', title: '蓝箱', workKind: 'series' },
    ], context());
    for (const candidate of unnamedKinds) {
      expect(candidate.band).toBe('ambiguous');
      expect(candidate.reasons.join(' ')).toContain('share this exact title');
    }
  });
});
