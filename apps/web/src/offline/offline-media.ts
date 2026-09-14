import { entryCardMediaRef } from '../entry-media-stack.js';
import type { SyncSnapshot } from '@t3/shared';
import { OFFLINE_MEDIA_CACHE } from './cache-names.js';

interface MediaCacheBucket {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
}

interface MediaCacheStorage {
  open(name: string): Promise<MediaCacheBucket>;
}

export interface OfflineMediaResult {
  cached: number;
  failed: number;
  skipped: number;
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
    onProgress?: (progress: {
      processed: number;
      total: number;
      result: OfflineMediaResult;
    }) => void;
  },
): Promise<OfflineMediaResult> {
  const cache = await options.cacheStorage.open(OFFLINE_MEDIA_CACHE);
  const fetcher = options.fetcher ?? fetch;
  const refs = [...new Set(mediaRefs)];
  const result: OfflineMediaResult = { cached: 0, failed: 0, skipped: 0 };
  let cursor = 0;
  let processed = 0;
  options.onProgress?.({ processed, total: refs.length, result: { ...result } });

  async function downloadOne(ref: string): Promise<void> {
    const sourceUrl = options.assetUrl(ref);
    const downloadUrl = options.assetUrl(entryCardMediaRef(ref));
    const isMutableResolver = new URL(downloadUrl).pathname.startsWith('/api/thumbnails/');
    const cachedDownload = await cache.match(downloadUrl);
    const revalidate = options.revalidateRefs?.has(ref) ?? false;
    if (!revalidate && !isMutableResolver && cachedDownload !== undefined) {
      result.skipped += 1;
      return;
    }
    if (!revalidate && isMutableResolver && cachedDownload !== undefined) {
      const location = cachedDownload.headers.get('location');
      const immutableUrl = location === null ? null : new URL(location, downloadUrl).toString();
      const immutableResponse = immutableUrl === null ? undefined : await cache.match(immutableUrl);
      if (immutableUrl !== null && immutableResponse !== undefined) {
        if (sourceUrl !== immutableUrl && await cache.match(sourceUrl) === undefined) {
          try {
            await cache.put(sourceUrl, immutableResponse.clone());
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
      const response = await fetcher(downloadUrl, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Media download returned ${response.status}`);
      const immutableUrl = response.url || downloadUrl;
      await cache.put(immutableUrl, response.clone());
      if (sourceUrl !== immutableUrl) {
        await cache.put(sourceUrl, response.clone());
      }
      if (immutableUrl !== downloadUrl) {
        await cache.put(downloadUrl, new Response(null, {
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
