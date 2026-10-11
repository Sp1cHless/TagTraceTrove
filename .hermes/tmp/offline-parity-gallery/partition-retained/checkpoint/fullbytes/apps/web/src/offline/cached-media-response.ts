import { offlineMediaCacheNames } from './cache-names.js';

interface CachedMediaBucket {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
}

export interface CachedMediaStorage {
  open(name: string): Promise<CachedMediaBucket>;
}

export async function matchCachedMediaResponse(
  rawUrl: string,
  cacheStorage: CachedMediaStorage | undefined = globalThis.caches,
): Promise<Response | null> {
  if (cacheStorage === undefined) return null;
  try {
    let url = rawUrl;
    const seen = new Set<string>();
    const opened = new Map<string, CachedMediaBucket>();
    const bucketFor = async (name: string): Promise<CachedMediaBucket> => {
      const existing = opened.get(name);
      if (existing !== undefined) return existing;
      const cache = await cacheStorage.open(name);
      opened.set(name, cache);
      return cache;
    };
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (seen.has(url)) return null;
      seen.add(url);
      // Each hop may sit in the address's bucket or in the pre-shard one.
      let response: Response | undefined;
      for (const name of offlineMediaCacheNames(url)) {
        response = await (await bucketFor(name)).match(url);
        if (response !== undefined) break;
      }
      if (response === undefined) return null;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null) return null;
        url = new URL(location, url).toString();
        continue;
      }
      return response.ok ? response : null;
    }
    return null;
  } catch {
    return null;
  }
}
