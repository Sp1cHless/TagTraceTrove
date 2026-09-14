import { OFFLINE_MEDIA_CACHE } from './cache-names.js';

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
    const cache = await cacheStorage.open(OFFLINE_MEDIA_CACHE);
    let url = rawUrl;
    const seen = new Set<string>();
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (seen.has(url)) return null;
      seen.add(url);
      const response = await cache.match(url);
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
