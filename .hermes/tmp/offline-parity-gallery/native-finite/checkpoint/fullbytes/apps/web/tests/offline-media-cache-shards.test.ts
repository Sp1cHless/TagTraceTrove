// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  OFFLINE_MEDIA_CACHE,
  OFFLINE_MEDIA_CACHE_SHARDS,
  allOfflineMediaCacheNames,
  offlineMediaCacheName,
  offlineMediaCacheNames,
} from '../src/offline/cache-names.js';
import { matchCachedMediaResponse } from '../src/offline/cached-media-response.js';
import { cacheSnapshotMedia, reshardLegacyMediaCache } from '../src/offline/offline-media.js';

/**
 * A browser charges each CacheStorage write for the entries already in that
 * bucket (measured on a phone: 16 ms empty, 13.7–15.8 s at 10,891 entries), so
 * the media cache is spread over fixed buckets. These tests pin the contract the
 * downloader, the reader, the service worker and the eviction path share.
 */
describe('the media cache is sharded by address', () => {
  it('maps an address to the same bucket every time, and keeps it out of the pre-shard bucket', () => {
    const url = 'https://t3.local/api/thumbnails/entries/1/cover.webp';
    expect(offlineMediaCacheName(url)).toBe(offlineMediaCacheName(url));
    expect(offlineMediaCacheName(url)).not.toBe(OFFLINE_MEDIA_CACHE);
    expect(offlineMediaCacheName(url)).toMatch(/^t3-offline-media-v1-s\d+$/u);
  });

  it('spreads distinct addresses over many buckets instead of piling them into one', () => {
    const names = new Set(
      Array.from({ length: 500 }, (_, index) => offlineMediaCacheName(`https://t3.local/api/thumbnails/entries/${index}/cover.webp`)),
    );
    expect(names.size).toBeGreaterThan(OFFLINE_MEDIA_CACHE_SHARDS / 2);
  });

  it('reads the address bucket first and falls back to the pre-shard bucket', () => {
    const url = 'https://t3.local/api/thumbnails/entries/1/cover.webp';
    expect(offlineMediaCacheNames(url)).toEqual([offlineMediaCacheName(url), OFFLINE_MEDIA_CACHE]);
  });

  it('lists every bucket for Clear, including the pre-shard one', () => {
    const names = allOfflineMediaCacheNames();
    expect(names[0]).toBe(OFFLINE_MEDIA_CACHE);
    expect(names).toHaveLength(OFFLINE_MEDIA_CACHE_SHARDS + 1);
    expect(new Set(names).size).toBe(names.length);
  });

  it('serves media that was downloaded before the split', async () => {
    const url = 'https://t3.local/api/thumbnails/entries/9/cover.webp';
    const legacy = new Response('legacy-bytes', { status: 200 });
    const opened: string[] = [];
    const cacheStorage = {
      async open(name: string) {
        opened.push(name);
        return { async match(request: RequestInfo | URL) { return String(request) === url && name === OFFLINE_MEDIA_CACHE ? legacy.clone() : undefined; } };
      },
    };
    const response = await matchCachedMediaResponse(url, cacheStorage);
    expect(await response?.text()).toBe('legacy-bytes');
    expect(opened).toEqual(offlineMediaCacheNames(url));
  });

  it('serves media from its own bucket', async () => {
    const url = 'https://t3.local/api/thumbnails/entries/9/preview.webp';
    const shard = offlineMediaCacheName(url);
    const cacheStorage = {
      async open(name: string) {
        return { async match(request: RequestInfo | URL) { return name === shard && String(request) === url ? new Response('fresh-bytes', { status: 200 }) : undefined; } };
      },
    };
    const response = await matchCachedMediaResponse(url, cacheStorage);
    expect(await response?.text()).toBe('fresh-bytes');
  });
  it('writes downloaded media into its bucket and never into the pre-shard one', async () => {
    const ref = '/api/assets/entries/4/cover.png';
    const url = `https://t3.local${ref}`;
    const writes: Array<{ name: string; key: string }> = [];
    const cacheStorage = {
      async open(name: string) {
        return {
          async match() { return undefined; },
          async put(key: RequestInfo | URL, value: Response) { writes.push({ name, key: String(key) }); void value; },
        };
      },
    };
    const result = await cacheSnapshotMedia([ref], {
      assetUrl: (value: string) => `https://t3.local${value}`,
      cacheStorage,
      fetcher: async () => new Response('image-bytes', { status: 200 }),
    });
    expect(result.cached).toBe(1);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((write) => write.name.startsWith('t3-offline-media-v1-s'))).toBe(true);
    expect(writes.some((write) => write.name === OFFLINE_MEDIA_CACHE)).toBe(false);
    // The bucket is the address's own, not an arbitrary one.
    expect(writes.every((write) => write.name === offlineMediaCacheName(write.key))).toBe(true);
    expect(url.length).toBeGreaterThan(0);
  });

  it('reuses media cached before the split instead of downloading it again', async () => {
    const ref = '/api/assets/entries/5/cover.png';
    const sourceUrl = `https://t3.local${ref}`;
    const downloadUrl = 'https://t3.local/api/thumbnails/entries/5/cover.png';
    const immutableUrl = 'https://t3.local/api/assets/entries/5/thumbnails/cover.abc123.webp';
    const fetcher = vi.fn(async () => new Response('fresh', { status: 200 }));
    const writes: string[] = [];
    // What the pre-shard version left behind: a 302 marker under the thumbnail
    // address plus the immutable bytes it points at.
    const legacy = new Map<string, Response>([
      [downloadUrl, new Response(null, { status: 302, headers: { location: immutableUrl } })],
      [immutableUrl, new Response('immutable-bytes', { status: 200 })],
      [sourceUrl, new Response('source-bytes', { status: 200 })],
    ]);
    const cacheStorage = {
      async open(name: string) {
        return {
          async match(key: RequestInfo | URL) {
            return name === OFFLINE_MEDIA_CACHE ? legacy.get(String(key))?.clone() : undefined;
          },
          async put(key: RequestInfo | URL) { writes.push(`${name} ${String(key)}`); },
        };
      },
    };
    const result = await cacheSnapshotMedia([ref], { assetUrl: (value: string) => `https://t3.local${value}`, cacheStorage, fetcher });
    // No download: the bytes already on the device are reused.
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.failed).toBe(0);
    // Any write lands in a bucket, and the pre-shard bucket is only ever read.
    expect(writes.every((write) => write.startsWith('t3-offline-media-v1-s'))).toBe(true);
  });
});

/** An in-memory CacheStorage with the abilities the one-time reshard probes for. */
function memoryStore(initial: Record<string, string[]> = {}) {
  const buckets = new Map<string, Map<string, string>>(
    Object.entries(initial).map(([name, urls]) => [name, new Map(urls.map((url) => [url, `bytes of ${url}`]))]),
  );
  const open = vi.fn(async (name: string) => {
    let bucket = buckets.get(name);
    if (bucket === undefined) {
      bucket = new Map();
      buckets.set(name, bucket);
    }
    const own = bucket;
    return {
      async match(key: RequestInfo | URL) {
        const body = own.get(String(key));
        return body === undefined ? undefined : new Response(body, { status: 200 });
      },
      async put(key: RequestInfo | URL, value: Response) { own.set(String(key), await value.text()); },
      async keys() { return [...own.keys()].map((url) => new Request(url)); },
    };
  });
  const drop = vi.fn(async (name: string) => buckets.delete(name));
  return { buckets, open, drop, withDrop: { open, delete: drop } };
}

describe('the pre-shard bucket is carried over once, then dropped', () => {
  const urls = [
    'https://t3.local/api/thumbnails/entries/1/cover.webp',
    'https://t3.local/api/assets/entries/1/thumbnails/cover.1a2b3c.webp',
    'https://t3.local/api/assets/entries/2/cover.webp',
  ];

  it('carries the bytes over even when the store cannot drop a bucket', async () => {
    const store = memoryStore({ [OFFLINE_MEDIA_CACHE]: urls });
    // No storage-level delete: the move still happens, so nothing is re-downloaded.
    const summary = await reshardLegacyMediaCache({ cacheStorage: { open: store.open } });
    expect(summary).toEqual({ moved: 3, skipped: 0, collapsed: false });
    expect(store.buckets.get(offlineMediaCacheName(urls[0]!))?.get(urls[0]!)).toBe(`bytes of ${urls[0]!}`);
  });

  it('lands each entry in the bucket its own address names, with the bytes intact', async () => {
    const store = memoryStore({ [OFFLINE_MEDIA_CACHE]: urls });
    const summary = await reshardLegacyMediaCache({ cacheStorage: store.withDrop });
    expect(summary).toEqual({ moved: 3, skipped: 0, collapsed: true });
    expect(summary.collapsed).toBe(true);
    for (const url of urls) {
      const bucket = store.buckets.get(offlineMediaCacheName(url));
      expect(bucket?.get(url)).toBe(`bytes of ${url}`);
    }
    expect(store.buckets.has(OFFLINE_MEDIA_CACHE)).toBe(false);
  });

  it('leaves media that is already in its address bucket untouched', async () => {
    const url = urls[0]!;
    const store = memoryStore({ [OFFLINE_MEDIA_CACHE]: [url], [offlineMediaCacheName(url)]: [url] });
    store.buckets.get(offlineMediaCacheName(url))?.set(url, 'newer bytes');
    const summary = await reshardLegacyMediaCache({ cacheStorage: store.withDrop });
    expect(summary).toEqual({ moved: 0, skipped: 1, collapsed: true });
    expect(store.buckets.get(offlineMediaCacheName(url))?.get(url)).toBe('newer bytes');
  });

  it('drops an empty pre-shard bucket rather than leaving it behind', async () => {
    const store = memoryStore({ [OFFLINE_MEDIA_CACHE]: [] });
    expect(await reshardLegacyMediaCache({ cacheStorage: store.withDrop }))
      .toEqual({ moved: 0, skipped: 0, collapsed: true });
  });

  it('leaves a store that cannot list keys completely alone', async () => {
    const open = vi.fn(async () => ({ async match() { return undefined; }, async put() { /* no writes */ } }));
    expect(await reshardLegacyMediaCache({ cacheStorage: { open } as never }))
      .toEqual({ moved: 0, skipped: 0, collapsed: false });
  });

  it('stops carrying media over once the copy underneath it changed', async () => {
    const store = memoryStore({ [OFFLINE_MEDIA_CACHE]: urls });
    const summary = await reshardLegacyMediaCache({ cacheStorage: store.withDrop, isCurrent: async () => false });
    expect(summary).toEqual({ moved: 0, skipped: 0, collapsed: false });
    expect(store.buckets.has(OFFLINE_MEDIA_CACHE)).toBe(true);
  });

  it('reports how far the carry-over has got', async () => {
    const store = memoryStore({ [OFFLINE_MEDIA_CACHE]: urls });
    const progress: Array<{ processed: number; total: number }> = [];
    await reshardLegacyMediaCache({ cacheStorage: store.withDrop, onProgress: (value) => progress.push(value) });
    expect(progress).toEqual([{ processed: 3, total: 3 }]);
  });
});
