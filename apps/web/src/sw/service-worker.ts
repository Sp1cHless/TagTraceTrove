import { OFFLINE_MEDIA_CACHE } from '../offline/cache-names.js';

/**
 * T³ service worker (plan §23.6). The worker owns the versioned app shell
 * and transport caches only. The canonical business snapshot stays in
 * IndexedDB generations.
 */

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends Event {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}
interface CacheBucket {
  addAll(urls: string[]): Promise<void>;
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
}
interface CacheArea {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  open(name: string): Promise<CacheBucket>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}
declare const caches: CacheArea;
declare const self: {
  addEventListener(type: string, listener: (event: never) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
};
declare const __T3_PRECACHE_URLS__: readonly string[] | undefined;

export const SW_VERSION = 't3-shell-v4';
export { OFFLINE_MEDIA_CACHE };

export type CacheStrategy =
  | { kind: 'shell'; url: string }
  | { kind: 'immutable-asset'; url: string }
  | { kind: 'immutable-thumbnail'; url: string }
  | { kind: 'thumbnail-resolver'; url: string }
  | { kind: 'library-media'; url: string }
  | { kind: 'network-first'; url: string }
  | { kind: 'network-only'; url: string };

const BASE_SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest'];
const GENERATED_ASSET_URLS = typeof __T3_PRECACHE_URLS__ === 'undefined'
  ? []
  : [...__T3_PRECACHE_URLS__];

export function shellUrls(): string[] {
  return [...new Set([...BASE_SHELL_URLS, ...GENERATED_ASSET_URLS])];
}

export function isHashedBuildAsset(pathname: string): boolean {
  return /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpg|jpeg|webp|avif|svg)$/u
    .test(pathname);
}

/** Mutable resolver: it must reach the server whenever the server is online. */
export function isThumbnail(url: URL): boolean {
  return url.pathname.startsWith('/api/thumbnails/');
}

export function isImmutableThumbnail(url: URL): boolean {
  return /^\/api\/assets\/entries\/\d+\/thumbnails\/(?:cover|preview(?:-\d+)?)\.[a-f0-9]{16}\.webp$/u
    .test(url.pathname);
}

export function isLibraryMedia(url: URL): boolean {
  if (isImmutableThumbnail(url)) return false;
  return url.pathname.startsWith('/api/assets/')
    || (url.pathname.startsWith('/assets/') && !isHashedBuildAsset(url.pathname));
}

export function isCapabilities(url: URL): boolean {
  return url.pathname === '/api/sync/capabilities';
}

export function strategyFor(method: string, rawUrl: string, mode = 'cors'): CacheStrategy {
  const url = new URL(rawUrl);
  const { pathname } = url;
  if (method !== 'GET') return { kind: 'network-only', url: rawUrl };
  if (isCapabilities(url)) return { kind: 'network-first', url: rawUrl };
  if (isThumbnail(url)) return { kind: 'thumbnail-resolver', url: rawUrl };
  if (isImmutableThumbnail(url)) return { kind: 'immutable-thumbnail', url: rawUrl };
  if (isHashedBuildAsset(pathname)) return { kind: 'immutable-asset', url: rawUrl };
  if (isLibraryMedia(url)) return { kind: 'library-media', url: rawUrl };
  if (pathname === '/' || pathname === '/index.html' || pathname === '/manifest.webmanifest') {
    return { kind: 'shell', url: rawUrl };
  }
  if (mode === 'navigate') return { kind: 'shell', url: '/index.html' };
  return { kind: 'network-only', url: rawUrl };
}

const SHELL_CACHE = SW_VERSION;

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

export async function networkFirst(
  request: Request,
  cacheName: string,
  options: {
    persistOnlineResponse?: boolean;
    fallbackOnUnavailableResponse?: boolean;
  } = {},
): Promise<Response> {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (options.fallbackOnUnavailableResponse === true
      && [502, 503, 504].includes(response.status)) {
      const cached = await cache.match(request);
      if (cached !== undefined) return cached;
    }
    if (response.ok && options.persistOnlineResponse !== false) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached ?? new Response('Offline', { status: 503 });
  }
}

/** Cache each shell resource under its own key; only navigations use index.html. */
async function shellNetworkFirst(request: Request, fallbackUrl: string): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const cacheKey = new Request(fallbackUrl);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(cacheKey, response.clone());
    return response;
  } catch {
    const cached = await cache.match(cacheKey);
    return cached ?? new Response('Offline', { status: 503 });
  }
}

export function handleFetch(event: FetchEvent): void {
  const strategy = strategyFor(event.request.method, event.request.url, event.request.mode);
  switch (strategy.kind) {
    case 'network-only':
      return;
    case 'immutable-asset':
      event.respondWith(cacheFirst(event.request, SHELL_CACHE));
      return;
    case 'immutable-thumbnail':
      event.respondWith(cacheFirst(event.request, OFFLINE_MEDIA_CACHE));
      return;
    case 'thumbnail-resolver':
      // Resolver URLs are mutable. Explicit downloads may install a cached
      // redirect as the offline fallback, but online requests always recheck.
      event.respondWith(networkFirst(event.request, OFFLINE_MEDIA_CACHE, {
        persistOnlineResponse: false,
        fallbackOnUnavailableResponse: true,
      }));
      return;
    case 'library-media':
      event.respondWith(networkFirst(event.request, OFFLINE_MEDIA_CACHE, {
        fallbackOnUnavailableResponse: true,
      }));
      return;
    case 'network-first':
      event.respondWith(networkFirst(event.request, SHELL_CACHE));
      return;
    case 'shell':
      event.respondWith(shellNetworkFirst(event.request, strategy.url));
      return;
  }
}

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(shellUrls());
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('t3-shell-') && name !== SHELL_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', handleFetch);
