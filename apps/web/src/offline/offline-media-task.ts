import { cacheSnapshotMedia, reshardLegacyMediaCache, type OfflineMediaResult } from './offline-media.js';
import { ACTIVE_GENERATION_KEY, readActiveSnapshot, type SnapshotStore } from './snapshot-store.js';

export type MediaPreloadMode = 'metadata' | 'thumbnails' | 'selected-originals';
interface Choice { mode: MediaPreloadMode; selectedRefs: string[] }
const KEY = 'mediaPreloadChoice';
let revision = 0;
let running: Promise<OfflineMediaResult | null> | null = null;
let runningRevision = -1;

export async function saveMediaPreloadChoice(
  store: SnapshotStore, mode: MediaPreloadMode, selectedRefs: string[] = [],
): Promise<void> {
  revision += 1;
  await store.writeMeta(KEY, JSON.stringify({ mode, selectedRefs } satisfies Choice));
}

export async function cancelMediaPreload(store: SnapshotStore): Promise<void> {
  revision += 1;
  await store.writeMeta(KEY, '');
}

export async function startMediaPreload(options: {
  store: SnapshotStore;
  assetUrl(ref: string): string;
  cacheStorage: { open(name: string): Promise<{ match(key: RequestInfo | URL): Promise<Response | undefined>; put(key: RequestInfo | URL, value: Response): Promise<void> }> };
  fetcher?: typeof fetch;
  onProgress?: (progress: {
    processed: number;
    total: number;
    result: OfflineMediaResult;
    phase?: 'preparing' | 'downloading';
  }) => void;
}): Promise<OfflineMediaResult | null> {
  if (running) {
    if (runningRevision === revision) return running;
    // A changed choice invalidates the old task, but cannot cancel its in-flight fetch.
    // Wait for it to settle, then read the newest persisted choice rather than
    // silently returning the obsolete task's result to the new caller.
    const previous = running;
    try { await previous; } catch { /* The new choice is still eligible to run. */ }
    return startMediaPreload(options);
  }
  const work = async (): Promise<OfflineMediaResult | null> => {
    // Every start, not only a download: this is the one-time move of already
    // cached media out of the pre-shard bucket, and once it is empty it is simply
    // dropped. A library that changed under the walk leaves the rest for next time.
    const generationBefore = await options.store.readMeta(ACTIVE_GENERATION_KEY);
    const migrationIsCurrent = async (): Promise<boolean> =>
      await options.store.readMeta(ACTIVE_GENERATION_KEY) === generationBefore;
    try {
      await reshardLegacyMediaCache({
        cacheStorage: options.cacheStorage,
        isCurrent: migrationIsCurrent,
        ...(options.onProgress ? {
          onProgress: ({ processed, total }) => options.onProgress?.({
            processed, total, result: { cached: 0, failed: 0, skipped: 0 }, phase: 'preparing',
          }),
        } : {}),
      });
    } catch (cause) {
      // A bucket that cannot be moved is not a reason to stop caching media.
      console.warn('Offline media reshard skipped', cause);
    }
    const raw = await options.store.readMeta(KEY);
    if (!raw) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; } catch { return null; }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<Choice>;
    if (!['metadata', 'thumbnails', 'selected-originals'].includes(candidate.mode ?? '')
      || !Array.isArray(candidate.selectedRefs)
      || !candidate.selectedRefs.every((ref) => typeof ref === 'string')) return null;
    const choice = candidate as Choice;
    const token = revision;
    const choiceIsCurrent = async (): Promise<boolean> => revision === token
      && await options.store.readMeta(KEY) === raw;
    while (await choiceIsCurrent()) {
      const active = await readActiveSnapshot(options.store);
      if (!active) return null;
      const { snapshot } = active;
      const generation = String(active.generationId);
      // The generation pointer is the whole per-reference test: rebuilding the
      // snapshot here would re-parse the entire library for every media item.
      const isCurrent = async () => await choiceIsCurrent()
        && await options.store.readMeta(ACTIVE_GENERATION_KEY) === generation;
      const refs = choice.mode === 'metadata' ? [] : choice.mode === 'thumbnails'
        ? snapshot.payload.mediaRefs
        : (choice.selectedRefs ?? []).filter((ref) => snapshot.payload.mediaRefs.includes(ref));
      if (!await isCurrent()) continue;
      const result = await cacheSnapshotMedia(refs, {
        assetUrl: options.assetUrl, cacheStorage: options.cacheStorage,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        originals: choice.mode === 'selected-originals', isCurrent, concurrency: 1,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
      if (await isCurrent()) return result;
      // Reconnect can install a newer generation while this task is walking the
      // cache. Keep the same user choice and restart against that generation;
      // already written bytes are skipped. A changed/cleared choice still exits.
    }
    return null;
  };
  const task = work();
  running = task;
  runningRevision = revision;
  try { return await task; } finally { if (running === task) running = null; }
}
