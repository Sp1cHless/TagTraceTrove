export const OFFLINE_MEDIA_CACHE = 't3-offline-media-v1';

/**
 * A browser charges every CacheStorage *write* for what the bucket already
 * holds: measured in the phone's own WebView, a `put` cost 4–15 ms in a bucket
 * of up to 4,000 entries (105 MB) and 10.2–12.7 s in the one holding 11,007
 * entries (195 MB), with per-entry `delete` just as slow — while a keyed
 * `match` stayed at 1 ms in every size. There is therefore a size past which a
 * bucket turns pathological, and filling a library through one bucket walked
 * into it: ~4 images a minute, slower with every image. Media entries are
 * spread over a fixed number of buckets instead, so a write is bounded by the
 * bucket rather than by the size of the library. 256 keeps a million cached
 * addresses inside the measured-fast range (~4,000 per bucket).
 */
export const OFFLINE_MEDIA_CACHE_SHARDS = 256;
const MEDIA_SHARD_PREFIX = `${OFFLINE_MEDIA_CACHE}-s`;

/**
 * FNV-1a over the address: stable in every engine and cheap enough to run per
 * lookup, so the downloader, the reader, the service worker and the eviction
 * path all agree on the bucket without keeping a registry.
 */
export function offlineMediaCacheName(url: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${MEDIA_SHARD_PREFIX}${hash % OFFLINE_MEDIA_CACHE_SHARDS}`;
}

/** Read order for one address: its bucket, then the pre-shard bucket, so media
 *  downloaded before this change stays readable (and is not re-downloaded). */
export function offlineMediaCacheNames(url: string): string[] {
  return [offlineMediaCacheName(url), OFFLINE_MEDIA_CACHE];
}

/** Every bucket media can live in, for Clear. */
export function allOfflineMediaCacheNames(): string[] {
  return [
    OFFLINE_MEDIA_CACHE,
    ...Array.from({ length: OFFLINE_MEDIA_CACHE_SHARDS }, (_, index) => `${MEDIA_SHARD_PREFIX}${index}`),
  ];
}
