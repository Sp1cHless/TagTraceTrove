import { entryCardMediaRef } from '../entry-media-stack.js';
import type { SyncSnapshot } from '@t3/shared';
import { OFFLINE_MEDIA_CACHE, offlineMediaCacheName } from './cache-names.js';

interface MediaCacheBucket {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
}

/** The bucket's deletion half, which only the eviction path needs. */
interface EvictableMediaCacheBucket extends MediaCacheBucket {
  keys(): Promise<Request[]>;
  delete(request: RequestInfo | URL): Promise<boolean>;
}

interface MediaCacheStorage {
  open(name: string): Promise<MediaCacheBucket>;
}

export interface OfflineMediaResult {
  cached: number;
  failed: number;
  skipped: number;
}

/**
 * Drops the cached pictures of the given media refs — the stored bytes, the
 * thumbnail markers derived from them, and the object URLs built from either.
 *
 * Only these refs are touched. Scanning the whole cache instead would walk
 * tens of thousands of keys on every picture edit, which is what made editing
 * take seconds; the entries it names are exactly the ones that changed.
 */
export async function evictEntryMediaRefs(
  refs: readonly string[],
  options: {
    assetUrl(ref: string): string;
    cacheStorage?: MediaCacheStorage;
    objectUrls?: { evictMatching(matches: (sourceUrl: string) => boolean): void };
  },
): Promise<void> {
  const unique = [...new Set(refs)];
  if (unique.length === 0) return;
  const urls = new Set<string>();
  for (const ref of unique) {
    urls.add(options.assetUrl(ref));
    // Cards read the thumbnail address, which the cache may hold as a redirect
    // marker; the immutable file behind it becomes unreachable once the marker
    // is gone and is dropped with the rest on Clear.
    urls.add(options.assetUrl(entryCardMediaRef(ref)));
  }
  options.objectUrls?.evictMatching((sourceUrl) => urls.has(sourceUrl)
    || unique.some((ref) => sourceUrl.includes(ref.split('/').pop() ?? '\u0000') && sourceUrl.includes('/entries/')));
  const storage = options.cacheStorage
    ?? (globalThis as unknown as { caches?: MediaCacheStorage }).caches;
  if (storage === undefined) return;
  try {
    const buckets = new Map<string, EvictableMediaCacheBucket>();
    const bucketFor = async (name: string): Promise<EvictableMediaCacheBucket> => {
      const existing = buckets.get(name);
      if (existing !== undefined) return existing;
      const opened = await storage.open(name) as EvictableMediaCacheBucket;
      buckets.set(name, opened);
      return opened;
    };
    // An address is dropped from its own bucket and from the pre-shard one, so
    // media downloaded before the split is evicted with everything else.
    await Promise.all([...urls].flatMap((url) => [
      bucketFor(offlineMediaCacheName(url)).then((cache) => cache.delete(url).catch(() => false)),
      bucketFor(OFFLINE_MEDIA_CACHE).then((cache) => cache.delete(url).catch(() => false)),
    ]));
  } catch {
    // A cache that cannot be reached is a cache that cannot be trusted, not a
    // reason to fail the edit the person just made.
  }
}

export function mediaRefsToRevalidate(
  previous: SyncSnapshot | null,
  next: SyncSnapshot,
): Set<string> {
  if (previous === null) return new Set();
  const previousUpdatedAt = new Map(previous.payload.entries.map((entry) => [entry.id, entry.updatedAt]));
  const nextUpdatedAt = new Map(next.payload.entries.map((entry) => [entry.id, entry.updatedAt]));
  return new Set(next.payload.mediaRefs.filter((ref) => {
    const match = /^\/api\/assets\/entries\/(\d+)\//u.exec(ref);
    if (match?.[1] === undefined) return true;
    const entryId = Number(match[1]);
    return !previousUpdatedAt.has(entryId)
      || previousUpdatedAt.get(entryId) !== nextUpdatedAt.get(entryId);
  }));
}

export async function cacheSnapshotMedia(
  mediaRefs: readonly string[],
  options: {
    assetUrl(ref: string): string;
    cacheStorage: MediaCacheStorage;
    fetcher?: typeof fetch;
    concurrency?: number;
    revalidateRefs?: ReadonlySet<string>;
    originals?: boolean;
    isCurrent?: () => Promise<boolean>;
    onProgress?: (progress: {
      processed: number;
      total: number;
      result: OfflineMediaResult;
    }) => void;
  },
): Promise<OfflineMediaResult> {
  const buckets = new Map<string, MediaCacheBucket>();
  const bucketFor = async (url: string): Promise<MediaCacheBucket> => {
    const name = offlineMediaCacheName(url);
    const existing = buckets.get(name);
    if (existing !== undefined) return existing;
    const opened = await options.cacheStorage.open(name);
    buckets.set(name, opened);
    return opened;
  };
  // Reads fall back to the pre-shard bucket: media already downloaded stays
  // usable, and the walk below then skips it instead of re-downloading a library.
  // Once that bucket is gone, asking for it per address would reopen (and even
  // recreate) it for every skip, so its absence is established once.
  let legacyBucket: Promise<MediaCacheBucket> | null = null;
  const legacyFor = (): Promise<MediaCacheBucket> => {
    legacyBucket ??= options.cacheStorage.open(OFFLINE_MEDIA_CACHE);
    return legacyBucket;
  };
  const storageKeys = (options.cacheStorage as { keys?: () => Promise<readonly string[]> }).keys;
  const legacyExists = typeof storageKeys === 'function'
    ? await storageKeys.call(options.cacheStorage).then((names) => names.includes(OFFLINE_MEDIA_CACHE), () => true)
    : true;
  const readCached = async (url: string): Promise<Response | undefined> => {
    const own = await (await bucketFor(url)).match(url);
    if (own !== undefined) return own;
    if (!legacyExists) return undefined;
    return (await legacyFor()).match(url);
  };
  const fetcher = options.fetcher ?? fetch;
  const refs = [...new Set(mediaRefs)];
  const result: OfflineMediaResult = { cached: 0, failed: 0, skipped: 0 };
  let cursor = 0;
  let processed = 0;
  options.onProgress?.({ processed, total: refs.length, result: { ...result } });

  async function downloadOne(ref: string): Promise<void> {
    const sourceUrl = options.assetUrl(ref);
    const downloadUrl = options.assetUrl(options.originals ? ref : entryCardMediaRef(ref));
    const isMutableResolver = new URL(downloadUrl).pathname.startsWith('/api/thumbnails/');
    const cachedDownload = await readCached(downloadUrl);
    const hasVerifiedOriginal = cachedDownload?.ok
      && cachedDownload.headers.get('x-t3-offline-original') === '1';
    const revalidate = options.revalidateRefs?.has(ref) ?? false;
    if (!revalidate && !isMutableResolver && cachedDownload?.ok
      && (!options.originals || hasVerifiedOriginal)) {
      result.skipped += 1;
      return;
    }
    if (!revalidate && isMutableResolver && cachedDownload !== undefined) {
      const location = cachedDownload.headers.get('location');
      const immutableUrl = location === null ? null : new URL(location, downloadUrl).toString();
      const immutableResponse = immutableUrl === null ? undefined : await readCached(immutableUrl);
      if (immutableUrl !== null && immutableResponse?.ok) {
        if (sourceUrl !== immutableUrl && !(await readCached(sourceUrl))?.ok) {
          try {
            if (options.isCurrent && !(await options.isCurrent())) return;
            await (await bucketFor(sourceUrl)).put(sourceUrl, immutableResponse.clone());
            result.cached += 1;
          } catch {
            result.failed += 1;
          }
        } else {
          result.skipped += 1;
        }
        return;
      }
    }

    try {
      if (options.isCurrent && !(await options.isCurrent())) return;
      const response = await fetcher(downloadUrl, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Media download returned ${response.status}`);
      if (options.isCurrent && !(await options.isCurrent())) return;
      const immutableUrl = response.url || downloadUrl;
      const headers = new Headers(response.headers);
      if (options.originals) headers.set('x-t3-offline-original', '1');
      const storedResponse = options.originals
        ? new Response(response.clone().body, { status: response.status, statusText: response.statusText, headers })
        : response.clone();
      await (await bucketFor(immutableUrl)).put(immutableUrl, storedResponse.clone());
      if (options.isCurrent && !(await options.isCurrent())) return;
      if (sourceUrl !== immutableUrl && !(await readCached(sourceUrl))?.headers.get('x-t3-offline-original')) {
        if (options.isCurrent && !(await options.isCurrent())) return;
        await (await bucketFor(sourceUrl)).put(sourceUrl, storedResponse.clone());
      }
      if (options.isCurrent && !(await options.isCurrent())) return;
      if (immutableUrl !== downloadUrl) {
        await (await bucketFor(downloadUrl)).put(downloadUrl, new Response(null, {
          status: 302,
          headers: { location: immutableUrl },
        }));
      }
      result.cached += 1;
    } catch {
      result.failed += 1;
    }
  }

  async function worker(): Promise<void> {
    while (cursor < refs.length) {
      const index = cursor;
      cursor += 1;
      if (options.isCurrent && !(await options.isCurrent())) break;
      const ref = refs[index];
      if (ref !== undefined) {
        await downloadOne(ref);
        processed += 1;
        if (processed === refs.length || processed % 25 === 0) {
          options.onProgress?.({ processed, total: refs.length, result: { ...result } });
        }
      }
    }
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8, refs.length || 1));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return result;
}

/** The two abilities a one-time reshard needs beyond open: listing a bucket's
 *  keys, and dropping a bucket whole. Both are probed at runtime, so a host that
 *  cannot do one of them keeps working against the pre-shard bucket. */
interface ReshardableMediaCacheStorage {
  open(name: string): Promise<MediaCacheBucket & { keys?: () => Promise<readonly Request[]> }>;
  delete?(name: string): Promise<boolean>;
}

export interface ReshardSummary {
  moved: number;
  skipped: number;
  collapsed: boolean;
}

/**
 * Carries the pre-shard bucket over to the per-address buckets and then drops it.
 *
 * That one bucket is what made a download crawl: a write is charged for what the
 * bucket already holds, so it grew slower with every image cached. The entries are
 * copied, never re-downloaded, and the bucket is dropped only after the walk has
 * been through every key, so an interrupted run costs nothing but a repeated
 * attempt. Readers keep working throughout — they try the address's bucket first
 * and fall back to this one.
 */
export async function reshardLegacyMediaCache(options: {
  cacheStorage: MediaCacheStorage;
  isCurrent?: () => Promise<boolean>;
  onProgress?: (progress: { processed: number; total: number }) => void;
}): Promise<ReshardSummary> {
  const summary: ReshardSummary = { moved: 0, skipped: 0, collapsed: false };
  const legacy = await options.cacheStorage.open(OFFLINE_MEDIA_CACHE) as
    MediaCacheBucket & { keys?: () => Promise<readonly Request[]> };
  // A store that cannot enumerate its own bucket cannot be moved safely.
  if (typeof legacy.keys !== 'function') return summary;
  const keys = await legacy.keys();
  const buckets = new Map<string, MediaCacheBucket>();
  for (const [index, request] of keys.entries()) {
    // The whole move is meaningless once the copy underneath it was cleared.
    if (index % 100 === 0 && options.isCurrent && !(await options.isCurrent())) return summary;
    const url = typeof request === 'string' ? request : request.url;
    const name = offlineMediaCacheName(url);
    let bucket = buckets.get(name);
    if (bucket === undefined) {
      bucket = await options.cacheStorage.open(name);
      buckets.set(name, bucket);
    }
    if (await bucket.match(url) !== undefined) {
      summary.skipped += 1;
    } else {
      const response = await legacy.match(url);
      // Gone between the listing and now: already evicted, nothing to carry.
      if (response === undefined) {
        summary.skipped += 1;
      } else {
        await bucket.put(url, response);
        summary.moved += 1;
      }
    }
    if ((index + 1) % 25 === 0 || index + 1 === keys.length) {
      options.onProgress?.({ processed: index + 1, total: keys.length });
    }
  }
  const storage = options.cacheStorage as ReshardableMediaCacheStorage;
  if (typeof storage.delete === 'function') {
    summary.collapsed = await storage.delete(OFFLINE_MEDIA_CACHE);
  }
  return summary;
}
