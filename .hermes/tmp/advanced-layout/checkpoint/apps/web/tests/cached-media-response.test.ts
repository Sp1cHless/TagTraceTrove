// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { matchCachedMediaResponse } from '../src/offline/cached-media-response.js';
import { CachedMediaObjectUrlRegistry } from '../src/offline/cached-media-object-urls.js';

function responseAt(url: string, body: string): Response {
  const response = new Response(body, { status: 200, headers: { 'content-type': 'image/webp' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

describe('direct cached media lookup', () => {
  it('follows a cached resolver redirect to its immutable image response', async () => {
    const resolver = 'https://t3.local/api/thumbnails/entries/1/cover.webp';
    const immutable = 'https://t3.local/api/assets/entries/1/thumbnails/cover.0123456789abcdef.webp';
    const stored = new Map<string, Response>([
      [resolver, new Response(null, { status: 302, headers: { location: immutable } })],
      [immutable, responseAt(immutable, 'cached-image')],
    ]);
    const cacheStorage = {
      async open() {
        return { async match(request: RequestInfo | URL) { return stored.get(String(request)); } };
      },
    };

    const response = await matchCachedMediaResponse(resolver, cacheStorage);

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe('cached-image');
  });

  it('returns null for missing, cyclic, or inaccessible cache entries', async () => {
    const resolver = 'https://t3.local/api/thumbnails/entries/1/cover.webp';
    const cacheStorage = {
      async open() {
        return {
          async match(request: RequestInfo | URL) {
            return String(request) === resolver
              ? new Response(null, { status: 302, headers: { location: resolver } })
              : undefined;
          },
        };
      },
    };

    expect(await matchCachedMediaResponse('https://t3.local/missing.webp', cacheStorage)).toBeNull();
    expect(await matchCachedMediaResponse(resolver, cacheStorage)).toBeNull();
    await expect(matchCachedMediaResponse(resolver, {
      open: vi.fn(async () => { throw new Error('cache unavailable'); }),
    })).resolves.toBeNull();
  });
});

describe('cached media object URL registry', () => {
  it('reuses a decoded object URL and its loaded state across component mounts', async () => {
    const source = 'https://t3.local/api/thumbnails/entries/1/cover.webp';
    const cacheStorage = {
      async open() {
        return { async match() { return responseAt(source, 'cached-image'); } };
      },
    };
    const objectUrls = {
      createObjectURL: vi.fn(() => 'blob:t3-cover-1'),
      revokeObjectURL: vi.fn(),
    };
    const registry = new CachedMediaObjectUrlRegistry(2);

    const first = await registry.acquire(source, cacheStorage, objectUrls);
    expect(first).toMatchObject({ objectUrl: 'blob:t3-cover-1', loaded: false });
    registry.markLoaded(first!);
    registry.release(first!);
    const second = await registry.acquire(source, cacheStorage, objectUrls);

    expect(second).toMatchObject({ objectUrl: 'blob:t3-cover-1', loaded: true });
    expect(objectUrls.createObjectURL).toHaveBeenCalledOnce();
  });

  it('revokes the least-recently-used unmounted object URL at its bound', async () => {
    const cacheStorage = {
      async open() {
        return { async match(request: RequestInfo | URL) { return responseAt(String(request), 'image'); } };
      },
    };
    let nextId = 0;
    const objectUrls = {
      createObjectURL: vi.fn(() => `blob:t3-${++nextId}`),
      revokeObjectURL: vi.fn(),
    };
    const registry = new CachedMediaObjectUrlRegistry(2);
    for (const source of ['https://t3.local/1.webp', 'https://t3.local/2.webp', 'https://t3.local/3.webp']) {
      const handle = await registry.acquire(source, cacheStorage, objectUrls);
      registry.release(handle!);
    }

    expect(objectUrls.revokeObjectURL).toHaveBeenCalledWith('blob:t3-1');
    expect(registry.size).toBe(2);
    registry.clear();
    expect(objectUrls.revokeObjectURL).toHaveBeenCalledTimes(3);
  });
});
