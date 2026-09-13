import type { AdapterCandidate, AdapterSearchInput, SourceSearchAdapter } from '../source-search-adapter.js';

/**
 * E-Hentai (e-hentai.org) — Source-maintenance target for gallery-type
 * Entries. Search is server-rendered HTML at `/?f_search=<keyword>`
 * (pagination `&page=<n>`, 25 rows per page). Titles are predominantly
 * Japanese/Romaji, so the evidence engine bridges Chinese Entry titles
 * through the catalog providers' alias graph. The parser fails closed: an
 * unrecognized page shape throws instead of yielding wrong URLs, and the
 * page's own "Found about N results" counter cross-checks the parse.
 */

export const EHENTAI_ORIGIN = 'https://e-hentai.org';

export class EhentaiStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EhentaiStructureError';
  }
}

const MAX_RESPONSE_BYTES = 3_000_000;
const USER_AGENT = 'TagTraceTrove/0.1 (personal local collection index; source maintenance)';

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#0*39;/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/&#(\d+);/gu, (_, code: string) => (
      Number(code) > 0 && Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : _
    ));
}

/** Extract one candidate from a `<tr>` chunk containing `gl3c glname`. */
function extractRow(chunk: string): AdapterCandidate | null {
  const urlMatch = /href="https:\/\/e-hentai\.org\/g\/(\d+)\/([a-f0-9]+)\/"/u.exec(chunk);
  if (urlMatch === null) return null;
  const titleMatch = /<div class="glink">([\s\S]*?)<\/div>/u.exec(chunk);
  if (titleMatch === null) return null;
  const title = decodeEntities(titleMatch[1]!.trim());
  if (title === '') return null;

  const coverMatch = /src="(https:\/\/ehgt\.org\/[^"]+)"/u.exec(chunk);
  const categoryMatch = /<div class="cn [^"]*"[^>]*>([^<]+)<\/div>/u.exec(chunk);
  // Namespace tags (parody:/artist:/group:/character:/language:) are strong
  // matching evidence, so they travel inside the adapter evidence.
  const tags = [...chunk.matchAll(/<div class="gt" title="([^"]+)">/gu)]
    .map((match) => decodeEntities(match[1]!))
    .filter((tag) => !tag.startsWith('temp:'));
  const artists = tags
    .filter((tag) => tag.startsWith('artist:'))
    .map((tag) => tag.slice('artist:'.length));
  const groups = tags
    .filter((tag) => tag.startsWith('group:'))
    .map((tag) => tag.slice('group:'.length));

  return {
    url: `${EHENTAI_ORIGIN}/g/${urlMatch[1]}/${urlMatch[2]}`,
    title,
    ...(coverMatch === null ? {} : { thumbnailUrl: coverMatch[1]! }),
    ...(artists.length > 0 || groups.length > 0
      ? { creators: [...groups, ...artists] }
      : {}),
    // The gallery id is the stable external identity; mirror sources (e.g.
    // hitomi slugs) embed the very same number, so the evidence engine can
    // match origin URLs to target galleries by id.
    catalogIds: [`ehentai:${urlMatch[1]!}`],
    adapterEvidence: {
      adapter: 'ehentai',
      galleryId: urlMatch[1]!,
      token: urlMatch[2]!,
      ...(categoryMatch === null ? {} : { category: decodeEntities(categoryMatch[1]!.trim()) }),
      ...(tags.length === 0 ? {} : { tags }),
    },
  };
}

export function parseEhentaiSearch(html: string): AdapterCandidate[] {
  if (/<p[^>]*>\s*No hits found\s*<\/p>/u.test(html)) return [];
  if (!html.includes('gl3c glname')) {
    throw new EhentaiStructureError('ehentai: page is missing the result list');
  }

  const candidates: AdapterCandidate[] = [];
  const seen = new Set<string>();
  for (const row of html.split(/<tr>/u)) {
    if (!row.includes('gl3c glname')) continue;
    const item = extractRow(row);
    if (item === null) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    candidates.push(item);
  }

  // Cross-check against the page's own hit counter: a non-zero report with
  // zero parsed rows means the layout changed — fail closed.
  const reported = /Found (?:about |exactly )?([\d,]+) results/u.exec(html);
  if (candidates.length === 0 && reported !== null) {
    const count = Number(reported[1]!.replace(/,/gu, ''));
    if (count > 0) {
      throw new EhentaiStructureError(`ehentai: page reports ${count} results but none could be parsed`);
    }
  }
  return candidates;
}

async function fetchSearchHtml(
  query: string,
  page: number,
  signal: AbortSignal,
  doFetch: typeof fetch,
): Promise<string> {
  const url = `${EHENTAI_ORIGIN}/?f_search=${encodeURIComponent(query)}${page > 0 ? `&page=${page}` : ''}`;
  const timeoutSignal = AbortSignal.timeout(20_000);
  const combined = AbortSignal.any([signal, timeoutSignal]);
  let response: Response;
  try {
    response = await doFetch(url, {
      signal: combined,
      headers: { 'user-agent': USER_AGENT },
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new EhentaiStructureError(`ehentai: search request failed (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (signal.aborted) throw signal.reason ?? new Error('ehentai: aborted');
  // e-hentai answers quota abuse with 509 and soft bans with 403.
  if (response.status === 429 || response.status === 503 || response.status === 509) {
    throw new EhentaiStructureError(`ehentai: rate limited (HTTP ${response.status})`);
  }
  if (response.status === 403) {
    throw new EhentaiStructureError('ehentai: access denied (HTTP 403; IP may be temporarily banned)');
  }
  if (!response.ok) {
    throw new EhentaiStructureError(`ehentai: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    throw new EhentaiStructureError('ehentai: response exceeds the size limit');
  }
  return new TextDecoder('utf-8').decode(buffer);
}

export function createEhentaiAdapter(fetchImpl?: typeof fetch): SourceSearchAdapter {
  const doFetch = fetchImpl ?? fetch;
  return {
    key: 'ehentai',
    displayName: 'E-Hentai',
    networked: true,
    acceptsHomepage(url: URL): boolean {
      const host = url.hostname.toLowerCase();
      return host === 'e-hentai.org' || host === 'www.e-hentai.org';
    },
    canonicalizeHomepage(url: URL): URL {
      void url;
      return new URL(`${EHENTAI_ORIGIN}/`);
    },
    canonicalizeItemUrl(url: URL): string {
      const canonical = new URL(url.toString());
      canonical.hash = '';
      canonical.search = '';
      return canonical.toString().replace(/\/+$/u, '');
    },
    async search({ title, signal }: AdapterSearchInput): Promise<AdapterCandidate[]> {
      const html = await fetchSearchHtml(title.trim(), 0, signal, doFetch);
      return parseEhentaiSearch(html);
    },
    // e-hentai enforces request quotas aggressively; keep the pace slow.
    rateLimit: { concurrency: 1, minDelayMs: 3000 },
  };
}
