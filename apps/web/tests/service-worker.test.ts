// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  SW_VERSION,
  isCapabilities,
  isHashedBuildAsset,
  isThumbnail,
  shellUrls,
  strategyFor,
} from '../src/sw/service-worker.js';

describe('service worker policy', () => {
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
      .toEqual({ kind: 'thumbnail', url: 'https://t3.local/api/thumbnails/abc512.webp' });
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
});
