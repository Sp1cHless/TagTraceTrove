import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EHENTAI_ORIGIN,
  EhentaiStructureError,
  createEhentaiAdapter,
  parseEhentaiSearch,
} from '../../src/source-maintenance/adapters/ehentai.js';
import { probeTargetHomepage } from '../../src/source-maintenance/adapter-registry.js';

const fixture = (name: string): string => readFileSync(
  fileURLToPath(new URL(`../fixtures/source-maintenance/ehentai/${name}`, import.meta.url)),
  'utf8',
);

describe('ehentai parser (saved fixtures, no network)', () => {
  it('extracts galleries, titles, covers and evidence tags from a real result page', () => {
    const candidates = parseEhentaiSearch(fixture('search-aohako-page1.html'));
    expect(candidates.length).toBe(25); // one full e-hentai page
    const first = candidates[0]!;
    expect(first.url).toMatch(/^https:\/\/e-hentai\.org\/g\/\d+\/[a-f0-9]+$/);
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.thumbnailUrl).toContain('ehgt.org');
    expect(first.catalogIds).toEqual([`ehentai:${first.url.match(/g\/(\d+)\//u)?.[1]}`]);
    // The parody tag is the identity evidence this site is most useful for.
    const withParody = candidates.find((candidate) => (
      (candidate.adapterEvidence.tags as string[] | undefined)?.some((tag) => tag.startsWith('parody:'))
    ));
    expect(withParody).toBeDefined();
    const withArtist = candidates.find((candidate) => candidate.creators !== undefined);
    expect(withArtist).toBeDefined();
    // URLs are unique.
    const urls = candidates.map((candidate) => candidate.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('returns an empty list for a real no-hit page', () => {
    expect(parseEhentaiSearch(fixture('search-no-hit.html'))).toEqual([]);
  });

  it('fails closed on a layout change and on non-zero-count parse failures', () => {
    expect(() => parseEhentaiSearch('<html>redesigned</html>')).toThrow(EhentaiStructureError);
    // The page still shows rows and reports 42 hits, but the gallery links
    // changed shape (e.g. token removed): the counter cross-check must fire
    // instead of answering a silent no-match.
    const brokenLinks = fixture('search-aohako-page1.html')
      .replace(/e-hentai\.org\/g\/\d+\/[a-f0-9]+\//gu, 'e-hentai.org/g/changed/');
    expect(() => parseEhentaiSearch(brokenLinks)).toThrow(EhentaiStructureError);
  });

  it('never admits a gallery URL missing its token', () => {
    const candidates = parseEhentaiSearch(fixture('search-aohako-page1.html'));
    for (const candidate of candidates) {
      expect(/^https:\/\/e-hentai\.org\/g\/\d+\/[a-f0-9]+$/.test(candidate.url)).toBe(true);
    }
  });
});

describe('ehentai adapter', () => {
  it('is reachable through the homepage probe', () => {
    const probe = probeTargetHomepage('https://e-hentai.org/');
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(probe.adapter.key).toBe('ehentai');
      expect(probe.homepage.toString()).toBe('https://e-hentai.org/');
    }
  });

  it('searches with f_search and keeps a slow, polite pace', async () => {
    const seen: Array<{ url: string; ua?: string | undefined }> = [];
    const adapter = createEhentaiAdapter(((url: string | URL, init?: { headers?: Record<string, string> }) => {
      seen.push({ url: String(url), ua: init?.headers?.['user-agent'] });
      return Promise.resolve(new Response(fixture('search-aohako-page1.html'), { status: 200 }));
    }) as unknown as typeof fetch);
    const candidates = await adapter.search({ title: 'アオのハコ', signal: AbortSignal.timeout(1000) });
    expect(candidates.length).toBe(25);
    expect(seen[0]!.url).toBe(`${EHENTAI_ORIGIN}/?f_search=${encodeURIComponent('アオのハコ')}`);
    expect(seen[0]!.ua).toContain('TagTraceTrove');
    expect(adapter.rateLimit).toEqual({ concurrency: 1, minDelayMs: 3000 });
  });

  it('maps bans and quota errors to explicit failures', async () => {
    const banned = createEhentaiAdapter((() => Promise.resolve(new Response('no', { status: 403 }))) as unknown as typeof fetch);
    await expect(banned.search({ title: 'x', signal: AbortSignal.timeout(1000) }))
      .rejects.toThrow(/banned/);
    const quota = createEhentaiAdapter((() => Promise.resolve(new Response('509', { status: 509 }))) as unknown as typeof fetch);
    await expect(quota.search({ title: 'x', signal: AbortSignal.timeout(1000) }))
      .rejects.toThrow(/rate limited/);
  });
});
