/**
 * Target-site search adapter contract (plan §12). One adapter per supported
 * target; each must ship saved HTML/JSON fixtures before it can join the
 * registry — guessing a site's search API is prohibited. Networked adapters
 * are only ever invoked by the local server, behind the SSRF checks in
 * `adapter-registry.ts`, and must implement bounded, polite pacing.
 */

export interface AdapterCandidate {
  url: string;
  title: string;
  language?: string;
  creators?: string[];
  workKind?: string;
  thumbnailUrl?: string;
  /** Stable external identity (e.g. `ehentai:<gallery-id>`) for evidence matching. */
  catalogIds?: string[];
  /** Raw provider/adapter evidence kept for review and reproducibility. */
  adapterEvidence: Record<string, unknown>;
}

export interface AdapterSearchInput {
  title: string;
  language?: string;
  signal: AbortSignal;
}

export interface SourceSearchAdapter {
  key: string;
  displayName: string;
  /**
   * True when the adapter performs real network fetches. QA adapters (and the
   * registry's SSRF guards) use this to decide whether URL validation
   * applies — QA adapters never fetch, so fake hostnames are fine.
   */
  networked: boolean;
  acceptsHomepage(url: URL): boolean;
  canonicalizeHomepage(url: URL): URL;
  canonicalizeItemUrl(url: URL): string;
  search(input: AdapterSearchInput): Promise<AdapterCandidate[]>;
  rateLimit: { concurrency: number; minDelayMs: number };
}
