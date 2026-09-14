// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OFFLINE_MEDIA_CACHE,
  SW_VERSION,
  isCapabilities,
  isHashedBuildAsset,
  isLibraryMedia,
  isThumbnail,
  networkFirst,
  shellUrls,
  strategyFor,
} from '../src/sw/service-worker.js';

describe('service worker policy', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shells out the versioned shell URLs for precache', () => {
    expect(SW_VERSION).toMatch(/^t3-shell-v\d+$/u);
    expect(shellUrls()).toEqual(['/', '/index.html', '/manifest.webmanifest']);
  });

  it('never intercepts mutations', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(strategyFor(method, 'https://t3.local/api/entries', 'cors'))
        .toEqual({ kind: 'network-only', url: 'https://t3.local/api/entries' });
    }
    expect(strategyFor('POST', 'https://t3.local/api/sync/operations'))
      .toMatchObject({ kind: 'network-only' });
  });

  it('treats capabilities as network-first with a cache fallback', () => {
    expect(strategyFor('GET', 'https://t3.local/api/sync/capabilities'))
      .toEqual({ kind: 'network-first', url: 'https://t3.local/api/sync/capabilities' });
    expect(isCapabilities(new URL('https://t3.local/api/sync/capabilities'))).toBe(true);
  });

  it('caches immutable hashed build assets and thumbnails cache-first', () => {
    expect(isHashedBuildAsset('/assets/index-DUQy4ACC.js')).toBe(true);
    expect(isHashedBuildAsset('/assets/theme.css')).toBe(false);
    expect(isHashedBuildAsset('/assets/index.js')).toBe(false);
    expect(isThumbnail(new URL('https://t3.local/api/thumbnails/abc512.webp'))).toBe(true);
    expect(strategyFor('GET', 'https://t3.local/assets/index-DUQy4ACC.js'))
      .toEqual({ kind: 'immutable-asset', url: 'https://t3.local/assets/index-DUQy4ACC.js' });
    expect(strategyFor('GET', 'https://t3.local/api/thumbnails/abc512.webp'))
      .toEqual({ kind: 'thumbnail-resolver', url: 'https://t3.local/api/thumbnails/abc512.webp' });
    expect(strategyFor(
      'GET',
      'https://t3.local/api/assets/entries/1/thumbnails/cover.0123456789abcdef.webp',
    )).toEqual({
      kind: 'immutable-thumbnail',
      url: 'https://t3.local/api/assets/entries/1/thumbnails/cover.0123456789abcdef.webp',
    });
    expect(isLibraryMedia(new URL('https://t3.local/assets/game/endfield/cover.jpg'))).toBe(true);
    expect(isLibraryMedia(new URL('https://t3.local/api/assets/producers/9/artwork.webp'))).toBe(true);
    expect(strategyFor('GET', 'https://t3.local/api/assets/producers/9/artwork.webp'))
      .toEqual({ kind: 'library-media', url: 'https://t3.local/api/assets/producers/9/artwork.webp' });
    expect(strategyFor('GET', 'https://t3.local/assets/game/endfield/cover.jpg'))
      .toEqual({ kind: 'library-media', url: 'https://t3.local/assets/game/endfield/cover.jpg' });
  });

  it('serves client-side navigations from the app shell for offline cold start', () => {
    expect(strategyFor('GET', 'https://t3.local/galleries/comic', 'navigate'))
      .toEqual({ kind: 'shell', url: '/index.html' });
    expect(strategyFor('GET', 'https://t3.local/', 'navigate'))
      .toEqual({ kind: 'shell', url: 'https://t3.local/' });
  });

  it('keeps other API reads off the SW cache (business snapshot lives in IndexedDB)', () => {
    expect(strategyFor('GET', 'https://t3.local/api/entries/query', 'cors'))
      .toEqual({ kind: 'network-only', url: 'https://t3.local/api/entries/query' });
    expect(strategyFor('GET', 'https://t3.local/api/sync/snapshot', 'cors'))
      .toEqual({ kind: 'network-only', url: 'https://t3.local/api/sync/snapshot' });
  });

  it('falls back to cached media when the desktop endpoint responds 503, but not 404', async () => {
    const cached = new Response('cached-image', { status: 200 });
    const match = vi.fn(async () => cached.clone());
    vi.stubGlobal('caches', {
      async open(name: string) {
        expect(name).toBe(OFFLINE_MEDIA_CACHE);
        return { match, async put() {} };
      },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('missing', { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const request = new Request('https://t3.local/api/thumbnails/entries/1/cover.webp');

    const unavailable = await networkFirst(request, OFFLINE_MEDIA_CACHE, {
      persistOnlineResponse: false,
      fallbackOnUnavailableResponse: true,
    });
    expect(await unavailable.text()).toBe('cached-image');

    const missing = await networkFirst(request, OFFLINE_MEDIA_CACHE, {
      persistOnlineResponse: false,
      fallbackOnUnavailableResponse: true,
    });
    expect(missing.status).toBe(404);
  });
});
