/**
 * T³ service worker (plan §23.6). One file holds both the pure routing
 * policy (exported, unit-tested in Node/jsdom) and the worker glue, because
 * vite emits this module verbatim to `dist/sw.js` via lib mode.
 *
 * The worker owns exactly three things: a versioned app shell, a navigation
 * fallback for offline cold start, and cache-first immutable hashed build
 * assets plus explicitly requested immutable thumbnails. It never caches
 * mutations and never owns the business snapshot — that lives in IndexedDB
 * generations, not the SW cache.
 */

// Worker-scope globals. The DOM lib used by vue-tsc does not know them, so
// declare them here; the declarations are type-only and erased at build time.
// Inside the real worker `self` is the ServiceWorkerGlobalScope; under jsdom
// tests it is the window, where only addEventListener is exercised.
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends Event {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
  waitUntil(promise: Promise<unknown>): void;
}
interface CacheArea {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  open(name: string): Promise<{ addAll(urls: string[]): Promise<void>; put(request: RequestInfo | URL, response: Response): Promise<void> }>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}
declare const caches: CacheArea;
declare const self: {
  addEventListener(type: string, listener: (event: never) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
};

export const SW_VERSION = 't3-shell-v2';

export type CacheStrategy =
  | { kind: 'shell'; url: string }
  | { kind: 'immutable-asset'; url: string }
  | { kind: 'thumbnail'; url: string }
  | { kind: 'network-first'; url: string }
  | { kind: 'network-only'; url: string };

const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest'];

export function shellUrls(): string[] {
  return [...SHELL_URLS];
}

export function isHashedBuildAsset(pathname: string): boolean {
  // Vite emits `assets/<name>-<hash>.js|css|…`; the content hash is what
  // makes the URL immutable, which is the only reason we may cache it forever.
  return /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpg|jpeg|webp|avif|svg)$/u
    .test(pathname);
}

export function isThumbnail(url: URL): boolean {
  return url.pathname.startsWith('/api/thumbnails/');
}

export function isCapabilities(url: URL): boolean {
  return url.pathname === '/api/sync/capabilities';
}

export function strategyFor(method: string, rawUrl: string, mode = 'cors'): CacheStrategy {
  const url = new URL(rawUrl);
  const { pathname } = url;
  if (method !== 'GET') return { kind: 'network-only', url: rawUrl };
  if (isCapabilities(url)) return { kind: 'network-first', url: rawUrl };
  if (isThumbnail(url)) return { kind: 'thumbnail', url: rawUrl };
  if (isHashedBuildAsset(pathname)) return { kind: 'immutable-asset', url: rawUrl };
  if (pathname === '/' || pathname === '/index.html' || pathname === '/manifest.webmanifest') {
    return { kind: 'shell', url: rawUrl };
  }
  if (mode === 'navigate') {
    // Client-side routes fall back to the app shell for offline cold start.
    return { kind: 'shell', url: '/index.html' };
  }
  return { kind: 'network-only', url: rawUrl };
}

// ---------------------------------------------------------------------------
// Worker glue. In unit tests this file is imported under jsdom, where `self`
// is the window: addEventListener exists, so attaching the workers is
// harmless and lets tests drive the handlers directly.
// ---------------------------------------------------------------------------

const CACHE_NAME = SW_VERSION;

async function cacheFirst(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

/**
 * Network-first shell. The app is served by the local T3 server, so reading the
 * current index.html on every navigation is cheap, and it keeps the browser off
 * a stale bundle after a rebuild: the old stale-while-revalidate version served
 * the cached shell first, so a refresh could keep running replaced front-end
 * code. The cached copy is only the offline cold-start fallback now.
 */
async function shellFirst(request: Request): Promise<Response> {
  const shell = new Request('/index.html');
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(shell, response.clone());
      return response;
    }
  } catch {
    // Offline or the server is down: fall back to the cached shell below.
  }
  const cached = await caches.match(shell) ?? await caches.match(request);
  return cached ?? new Response('Offline', { status: 503 });
}

export function handleFetch(event: FetchEvent): void {
  const strategy = strategyFor(event.request.method, event.request.url, event.request.mode);
  switch (strategy.kind) {
    case 'network-only':
      return; // default handling; mutations are never intercepted or cached
    case 'immutable-asset':
    case 'thumbnail':
      event.respondWith(cacheFirst(event.request));
      return;
    case 'network-first': {
      event.respondWith((async () => {
        try {
          const response = await fetch(event.request);
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(event.request, response.clone());
          }
          return response;
        } catch {
          const cached = await caches.match(event.request);
          return cached ?? new Response('Offline', { status: 503 });
        }
      })());
      return;
    }
    case 'shell':
      event.respondWith(shellFirst(event.request));
      return;
  }
}

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(shellUrls());
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', handleFetch);
