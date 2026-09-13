import { fakeAdapter } from './adapters/fake.js';
import { createMangabzAdapter } from './adapters/mangabz.js';
import { createEhentaiAdapter } from './adapters/ehentai.js';
import { createManhuaguiAdapter } from './adapters/manhuagui.js';
import type { SourceSearchAdapter } from './source-search-adapter.js';

/**
 * Adapter registry and target-safety probe. The registry fails closed: only
 * adapters with saved fixtures may join, unknown targets stop at
 * `unsupported`, and networked adapters pass the SSRF checklist before any
 * request is ever issued (plan §11/§18).
 */

const adapters = new Map<string, SourceSearchAdapter>();

export function registerSourceAdapter(adapter: SourceSearchAdapter): void {
  if (adapters.has(adapter.key)) {
    throw new Error(`source adapter already registered: ${adapter.key}`);
  }
  adapters.set(adapter.key, adapter);
}

export function listSourceAdapters(): SourceSearchAdapter[] {
  return [...adapters.values()];
}

export function getSourceAdapter(key: string): SourceSearchAdapter | null {
  return adapters.get(key) ?? null;
}

export type HomepageProbe =
  | { ok: true; adapter: SourceSearchAdapter; homepage: URL }
  | { ok: false; reason: 'unparsable' | 'scheme' | 'credentials' | 'port' | 'private' | 'unsupported' | 'adapter-not-found'; detail: string };

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
]);

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/u.test(part))) return false;
  const [a, b] = parts.map((part) => Number(part));
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (isPrivateIpv4(host)) return true;
  if (host.includes(':')) return ['::1', '::'].includes(host) || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd');
  return false;
}

export function probeTargetHomepage(rawHomepage: string): HomepageProbe {
  let url: URL;
  try {
    url = new URL(rawHomepage.trim());
  } catch {
    return { ok: false, reason: 'unparsable', detail: rawHomepage };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme', detail: url.protocol };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials', detail: url.hostname };
  }
  // A private/loopback host is rejected before the port check so the reason
  // never points at the port when the host itself is the problem.
  if (isBlockedHost(url.hostname)) {
    return { ok: false, reason: 'private', detail: url.hostname };
  }
  const port = url.port === '' ? '' : url.port;
  if (port !== '' && port !== '443') {
    return { ok: false, reason: 'port', detail: port };
  }
  for (const adapter of adapters.values()) {
    if (adapter.acceptsHomepage(url)) {
      return { ok: true, adapter, homepage: adapter.canonicalizeHomepage(url) };
    }
  }
  return {
    ok: false,
    reason: 'unsupported',
    detail: 'Unsupported target; adapter required',
  };
}

registerSourceAdapter(fakeAdapter);
registerSourceAdapter(createMangabzAdapter());
registerSourceAdapter(createEhentaiAdapter());
registerSourceAdapter(createManhuaguiAdapter());
