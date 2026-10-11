// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { cacheSnapshotMedia, mediaRefsToRevalidate } from '../src/offline/offline-media.js';
import type { SyncSnapshot } from '@t3/shared';

function responseAt(url: string, body: string): Response {
  const response = new Response(body, { status: 200, headers: { 'content-type': 'image/webp' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

describe('offline snapshot media cache', () => {
  it('revalidates changed/new Entry refs and unversioned non-Entry refs only', () => {
    const previous = {
      payload: {
        entries: [
          { id: 1, updatedAt: 'old' },
          { id: 2, updatedAt: 'same' },
        ],
      },
    } as SyncSnapshot;
    const next = {
      payload: {
        entries: [
          { id: 1, updatedAt: 'new' },
          { id: 2, updatedAt: 'same' },
          { id: 3, updatedAt: 'new' },
        ],
        mediaRefs: [
          '/api/assets/entries/1/cover.webp',
          '/api/assets/entries/2/cover.webp',
          '/api/assets/entries/3/cover.webp',
          '/api/assets/producers/9/artwork.webp',
        ],
      },
    } as SyncSnapshot;

    expect([...mediaRefsToRevalidate(previous, next)]).toEqual([
      '/api/assets/entries/1/cover.webp',
      '/api/assets/entries/3/cover.webp',
      '/api/assets/producers/9/artwork.webp',
    ]);
  });

  it('stores immutable thumbnail bytes plus an offline redirect for mutable resolver URLs', async () => {
    const stored = new Map<string, Response>();
    const cache = {
      async match(request: RequestInfo | URL) {
        return stored.get(String(request));
      },
      async put(request: RequestInfo | URL, response: Response) {
        stored.set(String(request), response);
      },
    };
    const cacheStorage = { open: vi.fn(async () => cache) };
    const immutable = 'https://t3.local/api/assets/entries/1/thumbnails/cover.0123456789abcdef.webp';
    const fetcher = vi.fn(async () => responseAt(immutable, 'image'));

    const result = await cacheSnapshotMedia(
      ['/api/assets/entries/1/cover.jpg'],
      {
        assetUrl: (ref) => `https://t3.local${ref}`,
        cacheStorage,
        fetcher,
      },
    );

    expect(result).toEqual({ cached: 1, failed: 0, skipped: 0 });
    expect(fetcher).toHaveBeenCalledWith(
      'https://t3.local/api/thumbnails/entries/1/cover.jpg',
      { cache: 'no-cache' },
    );
    expect(await stored.get(immutable)?.text()).toBe('image');
    expect(await stored.get('https://t3.local/api/assets/entries/1/cover.jpg')?.text()).toBe('image');
    expect(stored.get('https://t3.local/api/thumbnails/entries/1/cover.jpg')?.status).toBe(302);
    expect(stored.get('https://t3.local/api/thumbnails/entries/1/cover.jpg')?.headers.get('location'))
      .toBe(immutable);
  });

  it('repairs a legacy cached resolver by adding its missing source alias without refetching', async () => {
    const source = '/api/assets/entries/1/cover.webp';
    const resolver = 'https://t3.local/api/thumbnails/entries/1/cover.webp';
    const immutable = 'https://t3.local/api/assets/entries/1/thumbnails/cover.0123456789abcdef.webp';
    const stored = new Map<string, Response>([
      [resolver, new Response(null, { status: 302, headers: { location: immutable } })],
      [immutable, responseAt(immutable, 'image')],
    ]);
    const cacheStorage = {
      async open() {
        return {
          async match(request: RequestInfo | URL) { return stored.get(String(request)); },
          async put(request: RequestInfo | URL, response: Response) { stored.set(String(request), response); },
        };
      },
    };
    const fetcher = vi.fn(async () => { throw new Error('must not fetch a complete cached item'); });

    const result = await cacheSnapshotMedia([source], {
      assetUrl: (ref) => `https://t3.local${ref}`,
      cacheStorage,
      fetcher,
    });

    expect(result).toEqual({ cached: 1, failed: 0, skipped: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await stored.get('https://t3.local/api/assets/entries/1/cover.webp')?.text()).toBe('image');
  });

  it('skips a resolver whose immutable target and source alias are both cached', async () => {
    const source = '/api/assets/entries/1/cover.webp';
    const sourceUrl = 'https://t3.local/api/assets/entries/1/cover.webp';
    const resolver = 'https://t3.local/api/thumbnails/entries/1/cover.webp';
    const immutable = 'https://t3.local/api/assets/entries/1/thumbnails/cover.0123456789abcdef.webp';
    const stored = new Map<string, Response>([
      [sourceUrl, responseAt(immutable, 'image')],
      [resolver, new Response(null, { status: 302, headers: { location: immutable } })],
      [immutable, responseAt(immutable, 'image')],
    ]);
    const cacheStorage = {
      async open() {
        return {
          async match(request: RequestInfo | URL) { return stored.get(String(request)); },
          async put(request: RequestInfo | URL, response: Response) { stored.set(String(request), response); },
        };
      },
    };
    const fetcher = vi.fn(async () => { throw new Error('must not refetch a complete cached item'); });

    const result = await cacheSnapshotMedia([source], {
      assetUrl: (ref) => `https://t3.local${ref}`,
      cacheStorage,
      fetcher,
    });

    expect(result).toEqual({ cached: 0, failed: 0, skipped: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('revalidates a cached resolver when its Entry changed in the new snapshot', async () => {
    const source = '/api/assets/entries/1/cover.webp';
    const resolver = 'https://t3.local/api/thumbnails/entries/1/cover.webp';
    const oldImmutable = 'https://t3.local/api/assets/entries/1/thumbnails/cover.0123456789abcdef.webp';
    const newImmutable = 'https://t3.local/api/assets/entries/1/thumbnails/cover.fedcba9876543210.webp';
    const stored = new Map<string, Response>([
      [resolver, new Response(null, { status: 302, headers: { location: oldImmutable } })],
      [oldImmutable, responseAt(oldImmutable, 'old')],
    ]);
    const cacheStorage = {
      async open() {
        return {
          async match(request: RequestInfo | URL) { return stored.get(String(request)); },
          async put(request: RequestInfo | URL, response: Response) { stored.set(String(request), response); },
        };
      },
    };
    const fetcher = vi.fn(async () => responseAt(newImmutable, 'new'));

    const result = await cacheSnapshotMedia([source], {
      assetUrl: (ref) => `https://t3.local${ref}`,
      cacheStorage,
      fetcher,
      revalidateRefs: new Set([source]),
    });

    expect(result).toEqual({ cached: 1, failed: 0, skipped: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await stored.get(newImmutable)?.text()).toBe('new');
  });

  it('fetches the actual original after a thumbnail alias exists, then reuses the verified original', async () => {
    const source = '/api/assets/entries/1/cover.jpg';
    const originalUrl = `https://t3.local${source}`;
    const immutable = 'https://t3.local/api/assets/entries/1/thumbnails/cover.0123456789abcdef.webp';
    const stored = new Map<string, Response>();
    const cacheStorage = { async open() {
      return {
        async match(request: RequestInfo | URL) { return stored.get(String(request)); },
        async put(request: RequestInfo | URL, response: Response) { stored.set(String(request), response); },
      };
    } };
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      return responseAt(url === originalUrl ? originalUrl : immutable, url === originalUrl ? 'full-original' : 'thumbnail');
    });
    const options = { assetUrl: (ref: string) => `https://t3.local${ref}`, cacheStorage, fetcher };
    expect((await cacheSnapshotMedia([source], options)).cached).toBe(1);
    expect(await stored.get(originalUrl)?.text()).toBe('thumbnail');
    expect((await cacheSnapshotMedia([source], { ...options, originals: true })).cached).toBe(1);
    expect(fetcher).toHaveBeenCalledWith(originalUrl, { cache: 'no-cache' });
    expect(await stored.get(originalUrl)?.text()).toBe('full-original');
    expect((await cacheSnapshotMedia([source], { ...options, originals: true })).skipped).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not publish source/resolver aliases after the snapshot changes during a cache write', async () => {
    const source = '/api/assets/entries/1/cover.jpg';
    const original = `https://t3.local${source}`;
    const immutable = 'https://t3.local/api/assets/entries/1/thumbnails/cover.0123456789abcdef.webp';
    const stored = new Map<string, Response>();
    let current = true;
    const cacheStorage = { async open() { return {
      async match(request: RequestInfo | URL) { return stored.get(String(request)); },
      async put(request: RequestInfo | URL, response: Response) {
        stored.set(String(request), response);
        current = false;
      },
    }; } };
    await cacheSnapshotMedia([source], {
      assetUrl: (ref) => `https://t3.local${ref}`,
      fetcher: async () => responseAt(immutable, 'old-thumbnail'),
      cacheStorage,
      isCurrent: async () => current,
    });
    expect(stored.has(immutable)).toBe(true); // The in-flight write is not cancellable.
    expect(stored.has(original)).toBe(false);
    expect(stored.has('https://t3.local/api/thumbnails/entries/1/cover.jpg')).toBe(false);
  });

  it('continues after an individual media failure', async () => {
    const stored = new Map<string, Response>();
    const cacheStorage = {
      async open() {
        return {
          async match(request: RequestInfo | URL) { return stored.get(String(request)); },
          async put(request: RequestInfo | URL, response: Response) { stored.set(String(request), response); },
        };
      },
    };
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('missing.jpg')) throw new Error('offline');
      return responseAt(String(url), 'ok');
    });

    const result = await cacheSnapshotMedia(
      ['assets/cover.jpg', 'assets/missing.jpg'],
      { assetUrl: (ref) => `https://t3.local/${ref}`, cacheStorage, fetcher, concurrency: 2 },
    );

    expect(result).toEqual({ cached: 1, failed: 1, skipped: 0 });
  });
});
