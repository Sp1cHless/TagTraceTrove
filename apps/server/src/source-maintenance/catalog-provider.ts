/**
 * External title catalogs provide evidence only; they never write to the
 * library directly. Each provider converts a saved, versioned JSON fixture
 * shape into `CatalogWork` records. Live network access is forbidden in
 * tests — parsers are exercised against fixtures, clients against injected
 * fetch implementations.
 */

export interface CatalogTitle {
  value: string;
  language?: string;
  kind: 'title' | 'alias' | 'romaji';
}

export interface CatalogWork {
  /** Stable identity inside one provider, e.g. `bangumi:332037`. */
  providerId: string;
  titles: CatalogTitle[];
  creators: string[];
  workKind?: string;
  externalIds: Record<string, string>;
}

export interface TitleQuery {
  value: string;
  kind?: 'title' | 'alias' | 'romaji';
}

export interface TitleCatalogProvider {
  key: string;
  lookup(query: TitleQuery, signal: AbortSignal): Promise<CatalogWork[]>;
}

export class ProviderHttpError extends Error {
  readonly status: number;
  constructor(status: string | number, message: string) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = Number(status);
  }
}

export class ProviderRateLimitedError extends Error {
  readonly retryAfterMs: number | null;
  constructor(retryAfterMs: number | null) {
    super('catalog provider rate limited (429/503)');
    this.name = 'ProviderRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProviderParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderParseError';
  }
}

export interface FetchInit {
  signal: AbortSignal;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text: () => Promise<string>;
}>;

export const PROVIDER_TIMEOUT_MS = 10_000;

export async function fetchProviderJson(
  providerKey: string,
  url: string,
  signal: AbortSignal,
  fetchImpl: FetchLike,
  timeoutMs: number = PROVIDER_TIMEOUT_MS,
  init: Omit<FetchInit, 'signal'> = {},
): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: combined });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ProviderHttpError(0, `${providerKey}: request failed or timed out`);
  }
  if (signal.aborted) throw signal.reason ?? new Error(`${providerKey}: aborted`);
  if (response.status === 429 || response.status === 503) {
    const retryAfter = response.headers.get('retry-after');
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    throw new ProviderRateLimitedError(Number.isFinite(seconds) ? seconds * 1000 : null);
  }
  if (!response.ok) {
    throw new ProviderHttpError(response.status, `${providerKey}: HTTP ${response.status}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderParseError(`${providerKey}: malformed JSON response`);
  }
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
