import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MANGABZ_ORIGIN,
  MangabzStructureError,
  createMangabzAdapter,
  parseMangabzSearch,
} from '../../src/source-maintenance/adapters/mangabz.js';
import { probeTargetHomepage } from '../../src/source-maintenance/adapter-registry.js';

const fixture = (name: string): string => readFileSync(
  fileURLToPath(new URL(`../fixtures/source-maintenance/mangabz/${name}`, import.meta.url)),
  'utf8',
);

describe('mangabz parser (saved fixtures, no network)', () => {
  it('extracts titles, canonical detail URLs and covers from the real page 1', () => {
    const candidates = parseMangabzSearch(fixture('search-blue-box-page1.html'));
    expect(candidates.length).toBeGreaterThanOrEqual(10);
    const blueBox = candidates.find((candidate) => candidate.title === '青色之箱');
    expect(blueBox).toBeDefined();
    expect(blueBox!.url).toBe(`${MANGABZ_ORIGIN}/11410bz`);
    expect(blueBox!.thumbnailUrl).toContain('cover.mangabz.com');
    expect(blueBox!.adapterEvidence).toMatchObject({ adapter: 'mangabz', detailPath: '/11410bz/' });
    // No duplicate detail URLs even if the page repeats them.
    const urls = candidates.map((candidate) => candidate.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('returns an empty list for the real zero-result page', () => {
    expect(parseMangabzSearch(fixture('search-no-result.html'))).toEqual([]);
  });

  it('parses page 2 as a different candidate set from the same layout', () => {
    const page2 = parseMangabzSearch(fixture('search-blue-box-page2.html'));
    expect(page2.length).toBeGreaterThan(0);
    expect(page2.every((candidate) => candidate.url.startsWith(`${MANGABZ_ORIGIN}/`))).toBe(true);
  });

  it('fails closed when the layout changes instead of returning wrong URLs', () => {
    expect(() => parseMangabzSearch('<html><body>redesigned page</body></html>')).toThrow(MangabzStructureError);
    expect(() => parseMangabzSearch(fixture('search-blue-box-page1.html').replace(/<h2 class="title">[\s\S]*?<\/h2>/gu, ''))).toThrow(MangabzStructureError);
  });
});

describe('mangabz adapter', () => {
  it('is reachable through the homepage probe and canonicalizes the origin', () => {
    for (const homepage of ['https://www.mangabz.com/', 'https://mangabz.com/', 'https://www.mangabz.com/list/view.html']) {
      const probe = probeTargetHomepage(homepage);
      expect(probe.ok, homepage).toBe(true);
      if (probe.ok) {
        expect(probe.adapter.key).toBe('mangabz');
        expect(probe.homepage.toString()).toBe('https://www.mangabz.com/');
      }
    }
  });

  it('strips query and fragment from item URLs', () => {
    const adapter = createMangabzAdapter();
    expect(adapter.canonicalizeItemUrl(new URL('https://www.mangabz.com/11410bz/?from=x#top')))
      .toBe('https://www.mangabz.com/11410bz');
  });

  it('searches page 1 with the encoded title, politely and abortably', async () => {
    const seen: Array<{ url: string; ua?: string | undefined }> = [];
    const adapter = createMangabzAdapter(((url: string | URL, init?: { headers?: Record<string, string> }) => {
      seen.push({ url: String(url), ua: init?.headers?.['user-agent'] });
      return Promise.resolve(new Response(fixture('search-blue-box-page1.html'), { status: 200 }));
    }) as unknown as typeof fetch);
    const candidates = await adapter.search({ title: '青色之箱', signal: AbortSignal.timeout(1000) });
    expect(candidates.length).toBeGreaterThan(0);
    expect(seen[0]!.url).toBe(`${MANGABZ_ORIGIN}/search?title=${encodeURIComponent('青色之箱')}&page=1`);
    expect(seen[0]!.ua).toContain('TagTraceTrove');
    expect(adapter.rateLimit).toEqual({ concurrency: 1, minDelayMs: 1500 });
  });

  it('maps HTTP failures and rate limits to structure errors, never silent empties', async () => {
    const rateLimited = createMangabzAdapter((() => Promise.resolve(new Response('slow down', { status: 429 }))) as unknown as typeof fetch);
    await expect(rateLimited.search({ title: 'x', signal: AbortSignal.timeout(1000) }))
      .rejects.toThrow(/rate limited/);

    const serverError = createMangabzAdapter((() => Promise.resolve(new Response('boom', { status: 500 }))) as unknown as typeof fetch);
    await expect(serverError.search({ title: 'x', signal: AbortSignal.timeout(1000) }))
      .rejects.toThrow(/HTTP 500/);
  });
});
