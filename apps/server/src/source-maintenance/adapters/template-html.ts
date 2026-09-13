import type { AdapterCandidate, AdapterSearchInput, SourceSearchAdapter } from '../source-search-adapter.js';

/**
 * Declarative template for server-rendered HTML search lists (the "generic
 * rule" for simple targets). A site joins the registry with a small config
 * object plus saved fixtures — no per-site code. The safety semantics are
 * the same as hand-written adapters: explicit host allowlist, polite pacing,
 * response size cap, and fail-closed parsing (an unrecognized page or a
 * non-zero hit counter with zero parsed rows throws instead of answering a
 * silent no-match). Sites with JS hydration, JSON APIs or CAPTCHAs still
 * need a hand-written adapter — the template only covers plain HTML lists.
 */

export class TemplateStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateStructureError';
  }
}

export interface HtmlRowRule {
  /** Row chunk → target path or URL (first capture group is used). */
  urlPattern: RegExp;
  /** Builds the canonical candidate URL from the urlPattern match. */
  urlTemplate: (match: RegExpExecArray) => string;
  /** Row chunk → title (first capture group). */
  titlePattern: RegExp;
  /** Optional row chunk → cover image URL (first capture group). */
  coverPattern?: RegExp;
  /** Optional row chunk → alias/translated title (first capture group). */
  altTitlePattern?: RegExp;
}

export interface HtmlSearchTemplate {
  key: string;
  displayName: string;
  /** Canonical origin every candidate URL is rooted at. */
  origin: string;
  /** Host allowlist for the homepage probe. */
  hosts: string[];
  searchUrl(query: string, page: number): string;
  /** Splits the page into per-result chunks (must consume the whole list). */
  rowSplit: RegExp;
  row: HtmlRowRule;
  /** Any match means a legitimate zero-result page (no parsing required). */
  zeroResultMarkers: RegExp[];
  /** The page's own hit counter; a non-zero count with zero rows fails closed. */
  counterPattern?: RegExp;
  rateLimit: { concurrency: number; minDelayMs: number };
  headers?: Record<string, string>;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#0*39;/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/&#(\d+);/gu, (raw, code: string) => (
      Number(code) > 0 && Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : raw
    ));
}

function firstMatch(chunk: string, pattern: RegExp): string | null {
  const match = pattern.exec(chunk);
  return match === null ? null : decodeHtmlEntities(match[1]!.trim());
}

export function parseWithTemplate(html: string, template: HtmlSearchTemplate): AdapterCandidate[] {
  if (template.zeroResultMarkers.some((marker) => marker.test(html))) return [];
  if (!template.rowSplit.test(html)) {
    throw new TemplateStructureError(`${template.key}: page is missing the results list`);
  }
  template.rowSplit.lastIndex = 0;

  const candidates: AdapterCandidate[] = [];
  const seen = new Set<string>();
  for (const chunk of html.split(template.rowSplit).slice(1)) {
    const urlMatch = template.row.urlPattern.exec(chunk);
    if (urlMatch === null) continue;
    const title = firstMatch(chunk, template.row.titlePattern);
    if (title === null || title === '') continue;
    const url = template.row.urlTemplate(urlMatch);
    if (seen.has(url)) continue;
    seen.add(url);

    const cover = template.row.coverPattern === undefined ? null : firstMatch(chunk, template.row.coverPattern);
    const altTitle = template.row.altTitlePattern === undefined ? null : firstMatch(chunk, template.row.altTitlePattern);
    const candidate: AdapterCandidate = { url, title, adapterEvidence: {} };
    if (cover !== null) {
      candidate.thumbnailUrl = cover.startsWith('//') ? `https:${cover}` : cover;
    }
    if (altTitle !== null) {
      candidate.adapterEvidence = { altTitles: [altTitle] };
    }
    candidates.push(candidate);
  }

  if (template.counterPattern !== undefined) {
    const counter = template.counterPattern.exec(html);
    if (candidates.length === 0 && counter !== null && Number(counter[1]) > 0) {
      throw new TemplateStructureError(
        `${template.key}: page reports ${counter[1]} hits but none could be parsed`,
      );
    }
  }
  return candidates;
}

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'TagTraceTrove/0.1 (personal local collection index; source maintenance)';

async function fetchSearchHtml(
  template: HtmlSearchTemplate,
  url: string,
  signal: AbortSignal,
  doFetch: typeof fetch,
): Promise<string> {
  const timeout = AbortSignal.timeout(template.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await doFetch(url, {
      signal: combined,
      headers: { 'user-agent': USER_AGENT, ...(template.headers ?? {}) },
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new TemplateStructureError(`${template.key}: search request failed (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (signal.aborted) throw signal.reason ?? new Error(`${template.key}: aborted`);
  if (response.status === 429 || response.status === 503 || response.status === 509) {
    throw new TemplateStructureError(`${template.key}: rate limited (HTTP ${response.status})`);
  }
  if (response.status === 403) {
    throw new TemplateStructureError(`${template.key}: access denied (HTTP 403; IP may be banned)`);
  }
  if (!response.ok) {
    throw new TemplateStructureError(`${template.key}: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > (template.maxResponseBytes ?? DEFAULT_MAX_BYTES)) {
    throw new TemplateStructureError(`${template.key}: response exceeds the size limit`);
  }
  return new TextDecoder('utf-8').decode(buffer);
}

export function createTemplateHtmlAdapter(
  template: HtmlSearchTemplate,
  fetchImpl?: typeof fetch,
): SourceSearchAdapter {
  const doFetch = fetchImpl ?? fetch;
  const lowerHosts = new Set(template.hosts.map((host) => host.toLowerCase()));
  return {
    key: template.key,
    displayName: template.displayName,
    networked: true,
    acceptsHomepage(url: URL): boolean {
      return lowerHosts.has(url.hostname.toLowerCase());
    },
    canonicalizeHomepage(): URL {
      return new URL(`${template.origin}/`);
    },
    canonicalizeItemUrl(url: URL): string {
      const canonical = new URL(url.toString());
      canonical.hash = '';
      canonical.search = '';
      return canonical.toString().replace(/\/+$/u, '');
    },
    async search({ title, signal }: AdapterSearchInput): Promise<AdapterCandidate[]> {
      const html = await fetchSearchHtml(
        template,
        template.searchUrl(title.trim(), 1),
        signal,
        doFetch,
      );
      return parseWithTemplate(html, template);
    },
    rateLimit: template.rateLimit,
  };
}
