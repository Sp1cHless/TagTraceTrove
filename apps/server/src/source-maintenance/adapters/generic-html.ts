import { JSDOM } from 'jsdom';

/**
 * Blind discovery for unknown Source-maintenance targets (the fully generic
 * rule). Given ONLY a homepage, the engine figures out how to search and how
 * to read the results — without any hand-written per-site rules and without
 * assuming a language:
 *
 *  1. search endpoint discovery: parse the homepage's `<form>`s (action +
 *     first text input name + hidden fields), the one standard HTML feature
 *     every server-rendered site ships;
 *  2. probe keyword: the longest title-looking link text taken from the
 *     homepage itself, so the probe is guaranteed on-topic in any language;
 *  3. differential extraction: search once with the probe and once with a
 *     nonce keyword; group anchors by URL signature on both pages and keep
 *     the group that exists under the probe but not under the nonce — that
 *     difference IS the result list, whatever the markup or language.
 *
 * Everything fails closed: no form, no search page, or no differential group
 * reports "unsupported" instead of guessing. Safety matches hand-written
 * adapters: https-only callers, size caps, timeouts, polite UA.
 */

export const GENERIC_USER_AGENT = 'TagTraceTrove/0.1 (personal local collection index; source maintenance)';

export interface GenericRow {
  url: string;
  title: string;
  coverUrl?: string;
}

export interface SearchRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
}

export interface DiscoveredSearch {
  request: SearchRequest;
  probeKeyword: string;
  nonceKeyword: string;
  /** Result rows (probe minus nonce), de-duplicated by URL. */
  rows: GenericRow[];
  rowSignature: string;
  searchPageUrl: string;
  /** Every row under the discovered signature on the nonce page — the
   * standing exclusion set for future keyword searches. */
  exclusionUrls: string[];
}

export type DiscoveryFailure =
  | { reason: 'unreachable'; detail: string }
  | { reason: 'no-search-form'; detail: string }
  | { reason: 'search-failed'; detail: string }
  | { reason: 'no-differential-rows'; detail: string };

export type DiscoveryResult =
  | { ok: true; discovery: DiscoveredSearch }
  | { ok: false; failure: DiscoveryFailure };

const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 20_000;
const NONCE_KEYWORD = 'zzqqxxvvuumm0417';

/** Accepts ArrayBuffer or the byte-view TypeScript nowadays distinguishes. */
export function decodeBody(buffer: ArrayBuffer | Uint8Array, contentType: string | null): string {
  let charset = /charset=["']?([\w-]+)/iu.exec(contentType ?? '')?.[1]?.toLowerCase();
  if (charset === undefined) {
    // Sniff the <meta charset> / http-equiv from the first bytes.
    const head = new TextDecoder('utf-8', { fatal: false }).decode(buffer.slice(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/iu.exec(head)?.[1]?.toLowerCase();
  }
  const decoder = charset === undefined ? new TextDecoder('utf-8')
    : charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030' ? new TextDecoder('gb18030')
    : charset === 'big5' ? new TextDecoder('big5')
    : charset === 'shift_jis' || charset === 'sjis' ? new TextDecoder('shift_jis')
    : charset === 'euc-kr' || charset === 'euckr' ? new TextDecoder('euc-kr')
    : new TextDecoder('utf-8');
  return decoder.decode(buffer);
}

export async function fetchPage(
  url: string,
  signal: AbortSignal,
  doFetch: typeof fetch,
  init: { method?: string; body?: string } = {},
): Promise<{ html: string; finalUrl: string }> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  let response: Response;
  try {
    response = await doFetch(url, {
      signal: combined,
      redirect: 'follow',
      headers: { 'user-agent': GENERIC_USER_AGENT, ...(init.body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(init.method === 'POST' || init.body !== undefined
        ? { method: init.method ?? 'POST', body: init.body }
        : {}),
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new Error(`request failed (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
  if (response.status === 403) throw new Error('access denied (HTTP 403)');
  if (response.status === 429 || response.status === 503 || response.status === 509) {
    throw new Error(`rate limited (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) throw new Error('response exceeds the size limit');
  return {
    html: decodeBody(buffer, response.headers.get('content-type')),
    finalUrl: response.url || url,
  };
}

/** First plausible search form: standard `<form>` + a named text input. */
export function discoverSearchRequest(
  homepageHtml: string,
  homepageUrl: string,
): SearchRequest | null {
  const dom = new JSDOM(homepageHtml, { url: homepageUrl });
  const document = dom.window.document;
  for (const form of [...document.querySelectorAll('form')]) {
    const textInput = [...form.querySelectorAll('input')].find((input) => {
      const type = (input.getAttribute('type') ?? 'text').toLowerCase();
      return (type === 'text' || type === 'search' || type === '') && input.getAttribute('name') !== null;
    });
    if (textInput === undefined) continue;
    const name = textInput.getAttribute('name')!;
    const action = form.getAttribute('action') ?? '';
    let url: URL;
    try {
      url = new URL(action === '' ? homepageUrl : action, homepageUrl);
    } catch {
      continue;
    }
    const method = (form.getAttribute('method') ?? 'get').toLowerCase() === 'post' ? 'POST' as const : 'GET' as const;
    const extras: Record<string, string> = {};
    for (const hidden of form.querySelectorAll('input[type=hidden i]')) {
      const hiddenName = hidden.getAttribute('name');
      if (hiddenName !== null && hiddenName !== name) {
        extras[hiddenName] = hidden.getAttribute('value') ?? '';
      }
    }
    if (method === 'GET') {
      for (const [key, value] of Object.entries(extras)) url.searchParams.set(key, value);
      url.searchParams.set(name, '{keyword}');
      return { url: url.toString(), method, };
    }
    const body = new URLSearchParams({ ...extras, [name]: '{keyword}' });
    return { url: url.toString(), method, body: body.toString() };
  }
  return null;
}

/**
 * Fallback for sites whose search box is a bare `<input>` wired up by JS
 * (very common on Chinese manga sites): synthesize a GET against the
 * homepage itself with the input's name. Conventional path probing below
 * covers the rest.
 */
export function discoverLooseInput(
  homepageHtml: string,
  homepageUrl: string,
): SearchRequest | null {
  const dom = new JSDOM(homepageHtml, { url: homepageUrl });
  const document = dom.window.document;
  for (const input of document.querySelectorAll('input')) {
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();
    if (type !== 'text' && type !== 'search' && type !== '') continue;
    const name = input.getAttribute('name') ?? input.getAttribute('id');
    if (name === null || name === '') continue;
    if (/pass|mail|user|captcha/iu.test(name)) continue;
    return { url: `${homepageUrl}${homepageUrl.includes('?') ? '&' : '?'}${name}={keyword}`, method: 'GET' };
  }
  return null;
}

/** Bounded set of conventional search URL shapes across manga/CMS platforms. */
export const CONVENTIONAL_SEARCH_SHAPES: Array<{ name: string; build: (origin: string, keyword: string) => string }> = [
  { name: 'search?keyword', build: (o, k) => `${o}/search?keyword=${k}` },
  { name: 'search?keywords', build: (o, k) => `${o}/search?keywords=${k}` },
  { name: 'search?q', build: (o, k) => `${o}/search?q=${k}` },
  { name: 'search?title', build: (o, k) => `${o}/search?title=${k}` },
  { name: 'search?searchkey', build: (o, k) => `${o}/search?searchkey=${k}` },
  { name: 'search?searchtype+searchkey', build: (o, k) => `${o}/search?searchtype=all&searchkey=${k}` },
  { name: '?s', build: (o, k) => `${o}/?s=${k}` },
  { name: '?keyword', build: (o, k) => `${o}/?keyword=${k}` },
  { name: 's/{kw}', build: (o, k) => `${o}/s/${k}` },
  { name: 's/{kw}.html', build: (o, k) => `${o}/s/${k}.html` },
  { name: 'search/{kw}', build: (o, k) => `${o}/search/${k}` },
  { name: 'search{kw}.html', build: (o, k) => `${o}/search${k}.html` },
  { name: 'so/{kw}.html', build: (o, k) => `${o}/so/${k}.html` },
  { name: 'booksearch', build: (o, k) => `${o}/booksearch/${k}` },
];

function fillKeyword(request: SearchRequest, keyword: string): { url: string; method: 'GET' | 'POST'; body?: string } {
  if (request.method === 'POST') {
    return { url: request.url, method: 'POST', body: request.body!.replace('{keyword}', encodeURIComponent(keyword)) };
  }
  return { url: request.url.replace('{keyword}', encodeURIComponent(keyword)), method: 'GET' };
}

/** Group same-origin anchors by URL shape; digits and long hashes are ids. */
export function groupRows(html: string, baseUrl: string): Map<string, GenericRow[]> {
  const dom = new JSDOM(html, { url: baseUrl });
  const document = dom.window.document;
  const base = new URL(baseUrl);
  const groups = new Map<string, GenericRow[]>();
  for (const anchor of document.querySelectorAll('a[href]')) {
    const rawHref = anchor.getAttribute('href') ?? '';
    if (/^(?:javascript:|mailto:|#)/iu.test(rawHref)) continue;
    let url: URL;
    try {
      url = new URL(rawHref, base);
    } catch {
      continue;
    }
    if (url.origin !== base.origin) continue;

    let title = anchor.getAttribute('title')?.trim() ?? '';
    if (title === '') {
      const img = anchor.querySelector('img[alt]');
      title = img?.getAttribute('alt')?.trim() ?? '';
    }
    if (title === '') title = anchor.textContent?.replace(/\s+/gu, ' ').trim() ?? '';
    if (title.length < 2 || title.length > 300) continue;

    const signature = `${url.pathname.replace(/\d+/gu, '{d}').replace(/[a-f0-9]{8,}/giu, '{h}')}${url.search}`;
    const rows = groups.get(signature) ?? [];
    if (rows.some((row) => row.url === url.toString())) continue;

    const coverImg = anchor.querySelector('img[src]');
    const row: GenericRow = {
      url: `${url.origin}${url.pathname}${url.search}`,
      title,
      ...(coverImg === null ? {} : { coverUrl: new URL(coverImg.getAttribute('src') ?? '', base).toString() }),
    };
    rows.push(row);
    groups.set(signature, rows);
  }
  return groups;
}

function isTitleLike(text: string): boolean {
  // Title-looking: has a letter/CJK character, not pure punctuation/digits.
  return /[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

function pickProbeKeyword(homepageHtml: string, homepageUrl: string): string {
  const groups = groupRows(homepageHtml, homepageUrl);
  let best = '';
  for (const rows of groups.values()) {
    for (const row of rows) {
      if (!isTitleLike(row.title)) continue;
      if (row.title.length >= 4 && row.title.length > best.length) best = row.title;
    }
  }
  return best === '' ? 'love' : best.slice(0, 60);
}

export interface DiscoveryPacing {
  /** Delay between the probe and nonce fetches (politeness). */
  probeNonceMs?: number;
  /** Delay between candidate shapes. */
  betweenCandidatesMs?: number;
}

const DEFAULT_PACING: Required<DiscoveryPacing> = { probeNonceMs: 1000, betweenCandidatesMs: 800 };

export interface DiscoveryPageCapture {
  homepage?: (html: string) => void;
  probe?: (html: string) => void;
  nonce?: (html: string) => void;
}

export async function discoverHtmlSearch(
  homepage: string,
  signal: AbortSignal,
  doFetch: typeof fetch,
  capture: DiscoveryPageCapture = {},
  pacing: DiscoveryPacing = {},
): Promise<DiscoveryResult> {
  const pauses = { ...DEFAULT_PACING, ...pacing };
  const originUrl = new URL(homepage);
  if (originUrl.protocol !== 'https:') {
    return { ok: false, failure: { reason: 'unreachable', detail: 'https required' } };
  }
  let homepageHtml: string;
  let homepageFinal: string;
  try {
    ({ html: homepageHtml, finalUrl: homepageFinal } = await fetchPage(originUrl.toString(), signal, doFetch));
    capture.homepage?.(homepageHtml);
  } catch (cause) {
    return { ok: false, failure: { reason: 'unreachable', detail: cause instanceof Error ? cause.message : String(cause) } };
  }

  const probeKeyword = pickProbeKeyword(homepageHtml, homepageFinal);

  // Layered search-endpoint discovery: real form → bare input → conventional
  // path shapes. Every candidate goes through the same differential check.
  const candidates: Array<{ request: SearchRequest; label: string }> = [];
  const formRequest = discoverSearchRequest(homepageHtml, homepageFinal);
  if (formRequest !== null) candidates.push({ request: formRequest, label: 'form' });
  const looseRequest = discoverLooseInput(homepageHtml, homepageFinal);
  if (looseRequest !== null) candidates.push({ request: looseRequest, label: 'loose-input' });
  const originBase = new URL(homepageFinal).origin;
  for (const shape of CONVENTIONAL_SEARCH_SHAPES) {
    candidates.push({
      request: { url: shape.build(originBase, '{keyword}'), method: 'GET' },
      label: `shape:${shape.name}`,
    });
  }

  let lastFailure: DiscoveryFailure = {
    reason: 'no-differential-rows',
    detail: searchCapabilitySummary(homepageHtml),
  };
  for (const candidate of candidates) {
    const outcome = await probeDifferential(candidate.request, probeKeyword, signal, doFetch, capture, pauses);
    if (outcome !== null) {
      return {
        ok: true,
        discovery: {
          request: candidate.request,
          probeKeyword,
          nonceKeyword: NONCE_KEYWORD,
          rows: outcome.rows,
          rowSignature: outcome.signature,
          searchPageUrl: outcome.searchPageUrl,
          exclusionUrls: outcome.exclusionUrls,
        },
      };
    }
    // Remember the most specific candidate shape that failed, for the report.
    lastFailure = { reason: 'no-differential-rows', detail: candidate.label };
    if (pauses.betweenCandidatesMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pauses.betweenCandidatesMs));
    }
  }
  return { ok: false, failure: lastFailure };
}

/** Engine-collected diagnostics: what search affordances the homepage has,
 * so an "unsupported" verdict always comes with an actionable reason. */
export function searchCapabilitySummary(homepageHtml: string): string {
  const dom = new JSDOM(homepageHtml);
  const document = dom.window.document;
  const forms = document.querySelectorAll('form').length;
  const namedInputs = [...document.querySelectorAll('input')]
    .filter((input) => ['text', 'search', ''].includes((input.getAttribute('type') ?? 'text').toLowerCase()))
    .filter((input) => input.getAttribute('name') !== null).length;
  const searchLinks = [...document.querySelectorAll('a[href]')]
    .filter((anchor) => /search|so\.|\/s\/|searchkey/iu.test(anchor.getAttribute('href') ?? '')).length;
  const scripts = document.querySelectorAll('script[src]').length;
  return `homepage affordances: forms=${forms}, named-text-inputs=${namedInputs}, search-links=${searchLinks}, external-scripts=${scripts} (SPA pages need a dedicated JSON adapter)`;
}

interface DifferentialOutcome {
  rows: GenericRow[];
  signature: string;
  searchPageUrl: string;
  exclusionUrls: string[];
}

async function probeDifferential(
  request: SearchRequest,
  probeKeyword: string,
  signal: AbortSignal,
  doFetch: typeof fetch,
  capture: DiscoveryPageCapture,
  pauses: Required<DiscoveryPacing>,
): Promise<DifferentialOutcome | null> {
  let probePage: string;
  let noncePage: string;
  let searchPageUrl: string;
  try {
    const probeRequest = fillKeyword(request, probeKeyword);
    const nonceRequest = fillKeyword(request, NONCE_KEYWORD);
    const probeResponse = await fetchPage(
      probeRequest.url, signal, doFetch,
      probeRequest.method === 'POST' && probeRequest.body !== undefined
        ? { method: 'POST', body: probeRequest.body }
        : {},
    );
    if (!/\p{L}|\p{Script=Han}/u.test(probeResponse.html)) return null;
    if (pauses.probeNonceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pauses.probeNonceMs));
    }
    const nonceResponse = await fetchPage(
      nonceRequest.url, signal, doFetch,
      nonceRequest.method === 'POST' && nonceRequest.body !== undefined
        ? { method: 'POST', body: nonceRequest.body }
        : {},
    );
    probePage = probeResponse.html;
    noncePage = nonceResponse.html;
    searchPageUrl = probeResponse.finalUrl;
  } catch {
    return null; // shape not supported by this site; try the next one
  }
  capture.probe?.(probePage);
  capture.nonce?.(noncePage);

  const probeGroups = groupRows(probePage, searchPageUrl);
  const nonceGroups = groupRows(noncePage, searchPageUrl);
  const ordered = [...probeGroups.entries()].sort((left, right) => right[1].length - left[1].length);
  for (const [signature, rows] of ordered) {
    if (rows.length < 2) continue;
    const nonceRows = nonceGroups.get(signature) ?? [];
    const nonceUrls = nonceRows.map((row) => row.url);
    const nonceUrlSet = new Set(nonceUrls);
    const differential = rows.filter((row) => !nonceUrlSet.has(row.url));
    if (differential.length >= 1) {
      return { rows: differential, signature, searchPageUrl, exclusionUrls: nonceUrls };
    }
  }
  return null;
}

/** A runtime adapter bound to one discovered site (in-memory; not registered). */
export function createDiscoveredAdapter(
  discovery: DiscoveredSearch,
  fetchImpl?: typeof fetch,
): { search: (keyword: string, signal: AbortSignal) => Promise<GenericRow[]> } {
  const doFetch = fetchImpl ?? fetch;
  const exclusions = new Set(discovery.exclusionUrls);
  return {
    async search(keyword: string, signal: AbortSignal): Promise<GenericRow[]> {
      const request = fillKeyword(discovery.request, keyword);
      const { html, finalUrl } = await fetchPage(
        request.url, signal, doFetch,
        request.method === 'POST' && request.body !== undefined
          ? { method: 'POST', body: request.body }
          : {},
      );
      const groups = groupRows(html, finalUrl);
      const rows = groups.get(discovery.rowSignature) ?? [];
      const seen = new Set<string>();
      const result: GenericRow[] = [];
      for (const row of rows) {
        if (seen.has(row.url) || exclusions.has(row.url)) continue;
        seen.add(row.url);
        result.push(row);
      }
      return result;
    },
  };
}
