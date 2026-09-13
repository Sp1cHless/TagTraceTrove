import type { AdapterCandidate, AdapterSearchInput, SourceSearchAdapter } from '../source-search-adapter.js';

/**
 * Mangabz (www.mangabz.com) — the first real Source-maintenance target
 * (plan §33). Search is server-rendered HTML at
 * `/search?title=<keyword>&page=<n>`; each result is a `.mh-item` with the
 * detail path `/{id}bz/`. The parser fails closed: any response without the
 * expected list markup throws instead of returning silently wrong URLs.
 */

export const MANGABZ_ORIGIN = 'https://www.mangabz.com';

export class MangabzStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MangabzStructureError';
  }
}

const MAX_RESPONSE_BYTES = 2_000_000;
const USER_AGENT = 'TagTraceTrove/0.1 (personal local collection index; source maintenance)';

interface RawItem {
  id: string;
  title: string;
  coverUrl?: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&nbsp;/gu, ' ');
}

/** Strip everything from `<ul class="mh-list">` to the results container end. */
function resultsSection(html: string): string {
  const listStart = html.indexOf('<ul class="mh-list">');
  if (listStart < 0) {
    // Zero-result pages still carry the result title; anything else is a
    // layout change and must fail loudly instead of yielding wrong URLs.
    if (html.includes('class="result-title"')) return '';
    throw new MangabzStructureError('mangabz: search page is missing the results list');
  }
  const listEnd = html.indexOf('</ul>', listStart);
  if (listEnd < 0) throw new MangabzStructureError('mangabz: unterminated results list');
  return html.slice(listStart, listEnd);
}

function extractItem(chunk: string): RawItem | null {
  const idMatch = /href="\/(\d+bz)\/"/u.exec(chunk);
  if (idMatch === null) return null;
  const titleMatch = /<h2 class="title">\s*<a[^>]*title="([^"]*)"/u.exec(chunk)
    ?? /<h2 class="title">\s*<a[^>]*>([^<]+)<\/a>/u.exec(chunk);
  if (titleMatch === null) return null;
  const title = decodeEntities(titleMatch[1]!.trim());
  if (title === '') return null;
  const coverMatch = /<img class="mh-cover" src="([^"]*)"/u.exec(chunk);
  return {
    id: idMatch[1]!,
    title,
    ...(coverMatch === null ? {} : { coverUrl: coverMatch[1]! }),
  };
}

export function parseMangabzSearch(html: string): AdapterCandidate[] {
  const section = resultsSection(html);
  if (section === '') return [];
  const candidates: AdapterCandidate[] = [];
  const seen = new Set<string>();
  for (const chunk of section.split(/<li>/u).slice(1)) {
    const item = extractItem(chunk);
    if (item === null || seen.has(item.id)) continue;
    seen.add(item.id);
    candidates.push({
      url: `${MANGABZ_ORIGIN}/${item.id}`,
      title: item.title,
      ...(item.coverUrl === undefined ? {} : { thumbnailUrl: item.coverUrl }),
      adapterEvidence: {
        adapter: 'mangabz',
        detailPath: `/${item.id}/`,
        status: /<span>(?:最新|完結)<\/span>/u.exec(chunk)?.[1] ?? null,
      },
    });
  }
  // The page announces its own hit count; if it reports matches but the
  // parser extracted none, the layout changed — fail closed instead of
  // answering a silent no-match.
  const reported = /result-title[\s\S]{0,120}?[（(]\s*(\d+)\s*[）)]/u.exec(html);
  if (candidates.length === 0 && reported !== null && Number(reported[1]) > 0) {
    throw new MangabzStructureError(`mangabz: page reports ${reported[1]} matches but none could be parsed`);
  }
  return candidates;
}

async function fetchSearchHtml(
  query: string,
  page: number,
  signal: AbortSignal,
  doFetch: typeof fetch,
): Promise<string> {
  const url = `${MANGABZ_ORIGIN}/search?title=${encodeURIComponent(query)}&page=${page}`;
  const timeoutSignal = AbortSignal.timeout(15_000);
  const combined = AbortSignal.any([signal, timeoutSignal]);
  let response: Response;
  try {
    response = await doFetch(url, {
      signal: combined,
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'zh-TW,zh;q=0.9' },
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new MangabzStructureError(`mangabz: search request failed (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (signal.aborted) throw signal.reason ?? new Error('mangabz: aborted');
  if (response.status === 429 || response.status === 503) {
    throw new MangabzStructureError(`mangabz: rate limited (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new MangabzStructureError(`mangabz: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    throw new MangabzStructureError('mangabz: response exceeds the size limit');
  }
  return new TextDecoder('utf-8').decode(buffer);
}

export function createMangabzAdapter(fetchImpl?: typeof fetch): SourceSearchAdapter {
  const doFetch = fetchImpl ?? fetch;
  return {
    key: 'mangabz',
    displayName: 'Mangabz',
    networked: true,
    acceptsHomepage(url: URL): boolean {
      const host = url.hostname.toLowerCase();
      return host === 'mangabz.com' || host === 'www.mangabz.com';
    },
    canonicalizeHomepage(url: URL): URL {
      void url;
      return new URL(`${MANGABZ_ORIGIN}/`);
    },
    canonicalizeItemUrl(url: URL): string {
      const canonical = new URL(url.toString());
      canonical.hash = '';
      canonical.search = '';
      return canonical.toString().replace(/\/+$/u, '');
    },
    async search({ title, signal }: AdapterSearchInput): Promise<AdapterCandidate[]> {
      const html = await fetchSearchHtml(title.trim(), 1, signal, doFetch);
      return parseMangabzSearch(html);
    },
    rateLimit: { concurrency: 1, minDelayMs: 1500 },
  };
}
