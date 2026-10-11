import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProviderHttpError, ProviderParseError, ProviderRateLimitedError } from '../../src/source-maintenance/catalog-provider.js';
import { createBangumiProvider, parseBangumiSearch } from '../../src/source-maintenance/catalogs/bangumi.js';
import { createMangaDexProvider, parseMangaDexSearch } from '../../src/source-maintenance/catalogs/mangadex.js';
import { createKitsuProvider, parseKitsuSearch } from '../../src/source-maintenance/catalogs/kitsu.js';
import { createWikidataProvider, parseWikidataEntities } from '../../src/source-maintenance/catalogs/wikidata.js';
import type { FetchLike } from '../../src/source-maintenance/catalog-provider.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../fixtures/source-maintenance/${name}`, import.meta.url)),
  'utf8',
));

function jsonFetch(status: number, body: unknown, headers: Record<string, string> = {}): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

const signal = AbortSignal.timeout(1000);

describe('bangumi provider', () => {
  it('extracts canonical names, Chinese aliases and infobox aliases from fixtures', () => {
    const works = parseBangumiSearch(fixture('bangumi-search.json'));
    expect(works).toHaveLength(1);
    const work = works[0]!;
    expect(work.providerId).toBe('bangumi:332037');
    const values = work.titles.map((title) => title.value);
    expect(values).toContain('アオのハコ');
    expect(values).toContain('青春之箱');
    expect(values).toEqual(expect.arrayContaining(['蓝箱', '青色之箱', 'Blue Box', 'Ao no Hako']));
  });

  it('sends the POST search with the descriptive User-Agent', async () => {
    let captured: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } } | null = null;
    const provider = createBangumiProvider(async (url, init) => {
      captured = { url, init };
      return jsonFetch(200, fixture('bangumi-search.json'))(url, { signal: init.signal });
    });
    await provider.lookup({ value: '青色之箱' }, signal);
    expect(captured!.url).toBe('https://api.bgm.tv/v0/search/subjects');
    expect(captured!.init.method).toBe('POST');
    expect(JSON.parse(captured!.init.body!)).toEqual({ keyword: '青色之箱' });
    expect(captured!.init.headers?.['user-agent']).toContain('TagTraceTrove');
  });
});

describe('mangadex provider', () => {
  it('maps altTitles, ja-ro romaji, creators and Oneshot tags', () => {
    const works = parseMangaDexSearch(fixture('mangadex-search.json'));
    expect(works).toHaveLength(2);
    const series = works[0]!;
    expect(series.providerId).toBe('mangadex:b7d0f5e3-51b1-4b13-9f6a-3aa2efc91234');
    expect(series.workKind).toBe('series');
    expect(series.titles.some((title) => title.kind === 'romaji' && title.value === 'Ao no Hako')).toBe(true);
    expect(series.titles.some((title) => title.value === 'アオのハコ')).toBe(true);
    expect(series.creators).toContain('MIURA Kouji');
    // Same-name prototype short story stays as its own record.
    expect(works[1]!.workKind).toBe('oneshot');
  });

  it('builds the title search URL with includes and limit', async () => {
    let requestedUrl: string | null = null;
    const provider = createMangaDexProvider(async (url, init) => {
      requestedUrl = url;
      return jsonFetch(200, fixture('mangadex-search.json'))(url, { signal: init.signal });
    });
    await provider.lookup({ value: 'Blue Box' }, signal);
    expect(requestedUrl).toContain('title=Blue%20Box');
    expect(requestedUrl).toContain('includes%5B%5D=author');
    expect(requestedUrl).toContain('limit=8');
  });
});

describe('wikidata provider', () => {
  it('bridges labels, aliases and external catalog IDs', () => {
    const works = parseWikidataEntities(fixture('wikidata-blue-box.json'));
    expect(works).toHaveLength(1);
    const work = works[0]!;
    expect(work.providerId).toBe('wikidata:Q106447820');
    const values = work.titles.map((title) => title.value);
    expect(values).toEqual(expect.arrayContaining(['Blue Box', 'アオのハコ', '青春之箱', '青色之箱', '蓝箱', '藍箱']));
    expect(work.externalIds).toEqual({
      wikidata: 'Q106447820',
      mangadex: 'b7d0f5e3-51b1-4b13-9f6a-3aa2efc91234',
    });
  });

  it('searches entities first and fetches up to three full entities', async () => {
    const urls: string[] = [];
    const provider = createWikidataProvider(async (url, init) => {
      urls.push(url);
      if (url.includes('wbsearchentities')) {
        return jsonFetch(200, {
          search: [
            { id: 'Q106447820' },
            { id: 'Q2' },
            { id: 'Q3' },
            { id: 'Q4' },
          ],
        })(url, { signal: init.signal });
      }
      return jsonFetch(200, fixture('wikidata-blue-box.json'))(url, { signal: init.signal });
    });
    const works = await provider.lookup({ value: 'Blue Box' }, signal);
    expect(urls.filter((url) => url.includes('EntityData'))).toHaveLength(1);
    expect(urls.find((url) => url.includes('EntityData'))).toContain('Q106447820|Q2|Q3');
    expect(works).toHaveLength(1);
  });
});

describe('kitsu provider', () => {
  it('keeps the oneshot record and the series record side by side', () => {
    const works = parseKitsuSearch(fixture('kitsu-search.json'));
    expect(works).toHaveLength(2);
    expect(works[0]!.workKind).toBe('series');
    expect(works[0]!.titles.some((title) => title.kind === 'romaji' && title.value === 'Ao no Hako')).toBe(true);
    expect(works[0]!.titles.some((title) => title.value === 'AoHako')).toBe(true);
    expect(works[1]!.workKind).toBe('oneshot');
  });
});

describe('provider client error handling', () => {
  const provider = createKitsuProvider(jsonFetch(200, fixture('kitsu-search.json')));

  it('maps 429 with Retry-After to a rate limit error', async () => {
    const rateLimited = createKitsuProvider(jsonFetch(429, { error: 'slow down' }, { 'retry-after': '3' }));
    await expect(rateLimited.lookup({ value: 'Blue Box' }, signal))
      .rejects.toThrow(ProviderRateLimitedError);
  });

  it('maps 503 without Retry-After to a rate limit error without a hint', async () => {
    const unavailable = createKitsuProvider(jsonFetch(503, 'busy'));
    await expect(unavailable.lookup({ value: 'Blue Box' }, signal)).rejects.toMatchObject({
      retryAfterMs: null,
    });
  });

  it('maps other HTTP errors and keeps their status', async () => {
    const serverError = createKitsuProvider(jsonFetch(500, 'boom'));
    await expect(serverError.lookup({ value: 'Blue Box' }, signal))
      .rejects.toThrow(ProviderHttpError);
  });

  it('rejects malformed JSON with a parse error', async () => {
    const malformed = createKitsuProvider(jsonFetch(200, '<html>not json</html>'));
    await expect(malformed.lookup({ value: 'Blue Box' }, signal))
      .rejects.toThrow(ProviderParseError);
  });

  it('tolerates records without usable titles and empty payloads', () => {
    expect(parseKitsuSearch({ data: [{ id: '1', attributes: {} }, { id: null }] })).toEqual([]);
    expect(parseMangaDexSearch({ data: [] })).toEqual([]);
    expect(parseBangumiSearch({ data: [{ id: '1' }] })).toEqual([]);
  });

  it('reports a failed request as a provider error while respecting caller aborts', async () => {
    const abortController = new AbortController();
    const failing: FetchLike = async (_url, init) => {
      init.signal.throwIfAborted();
      return jsonFetch(200, {})(String(_url), { signal: init.signal });
    };
    abortController.abort();
    await expect(provider.lookup({ value: 'Blue Box' }, abortController.signal))
      .rejects.toThrow();
    await expect(failing('https://kitsu.io/api/edge/manga', { signal: AbortSignal.timeout(1000) }))
      .resolves.toMatchObject({ ok: true });
  });
});
