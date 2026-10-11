import { cacheSnapshotMedia, type OfflineMediaResult } from './offline-media.js';
import { readActiveSnapshot, type SnapshotStore } from './snapshot-store.js';

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
  onProgress?: (progress: { processed: number; total: number; result: OfflineMediaResult }) => void;
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
    const active = await readActiveSnapshot(options.store);
    if (!active) return null;
    const token = revision;
    const { generationId, snapshot } = active;
    const { libraryId, syncEpoch } = snapshot.header;
    const isCurrent = async () => {
      if (revision !== token || await options.store.readMeta(KEY) !== raw) return false;
      const latest = await readActiveSnapshot(options.store);
      return latest?.generationId === generationId
        && latest.snapshot.header.libraryId === libraryId
        && latest.snapshot.header.syncEpoch === syncEpoch;
    };
    const refs = choice.mode === 'metadata' ? [] : choice.mode === 'thumbnails'
      ? snapshot.payload.mediaRefs
      : (choice.selectedRefs ?? []).filter((ref) => snapshot.payload.mediaRefs.includes(ref));
    if (!await isCurrent()) return null;
    return cacheSnapshotMedia(refs, {
      assetUrl: options.assetUrl, cacheStorage: options.cacheStorage,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      originals: choice.mode === 'selected-originals', isCurrent, concurrency: 1,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  };
  const task = work();
  running = task;
  runningRevision = revision;
  try { return await task; } finally { if (running === task) running = null; }
}
