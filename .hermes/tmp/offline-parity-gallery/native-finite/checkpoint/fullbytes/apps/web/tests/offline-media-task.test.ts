// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createMemorySnapshotStore } from '../src/offline/snapshot-store.js';
import { startMediaPreload, saveMediaPreloadChoice, cancelMediaPreload } from '../src/offline/offline-media-task.js';
import { syncSnapshotSchema, type SyncSnapshot } from '@t3/shared';

const snapshot = { header: {
  libraryId: 'library', syncEpoch: 'epoch', snapshotSeq: 1, changeSeq: 0,
  generatedAt: '2026-09-13T00:00:00.000Z', sqliteSchemaVersion: 21,
  snapshotFormatVersion: 2, counts: { entries: 0, producers: 0, entryContents: 0, entryTags: 0, collections: 0 }, checksum: 'test',
}, payload: {
  entries: [], producers: [], entryProducers: [], tags: [], tagGroups: [], entryTags: [], producerTags: [],
  producerTagAssignments: [], entryContents: [], ratingSlots: [], entryRatingValues: [], producerRatingValues: [],
  collections: [], collectionMembers: [], authorDirectories: [], authorDirectoryEntries: [], entryUsage: [],
  viewLaterEntries: [], viewLaterProducers: [], gallerySettings: [],
  mediaRefs: ['/api/assets/entries/1/cover.webp', '/api/assets/entries/1/preview.webp'],
} } as SyncSnapshot;

function setup() {
  const store = createMemorySnapshotStore();
  const bytes = new Map<string, Response>();
  const cacheStorage = { open: vi.fn(async () => ({
    match: async (key: RequestInfo | URL) => bytes.get(String(key)),
    put: async (key: RequestInfo | URL, value: Response) => { bytes.set(String(key), value); },
  })) };
  return { store, bytes, cacheStorage, assetUrl: (ref: string) => `https://t3.local${ref}` };
}

async function install(store: ReturnType<typeof createMemorySnapshotStore>) {
  const parsed = syncSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  await store.writeGeneration(1, JSON.stringify(snapshot));
  await store.writeMeta('activeGeneration', '1');
}

describe('foreground media preload recovery', () => {
  it('persists a thumbnails choice and retries missing bytes after a new task starts', async () => {
    const ctx = setup(); await install(ctx.store);
    await saveMediaPreloadChoice(ctx.store, 'thumbnails');
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('preview')) throw new Error('interrupted');
      const response = new Response('cover');
      Object.defineProperty(response, 'url', { value: 'https://t3.local/api/assets/entries/1/thumbnails/cover.hash.webp' });
      return response;
    });
    const first = await startMediaPreload({ ...ctx, fetcher });
    expect(first?.failed).toBe(1);
    const nextFetcher = vi.fn(async () => new Response('preview'));
    const second = await startMediaPreload({ ...ctx, fetcher: nextFetcher });
    expect(second).toEqual({ cached: 1, failed: 0, skipped: 1 });
    expect(nextFetcher).toHaveBeenCalledTimes(1);
  });

  it('runs a newly selected media intent after an obsolete in-flight task settles', async () => {
    const ctx = setup(); await install(ctx.store);
    await saveMediaPreloadChoice(ctx.store, 'thumbnails');
    let release!: (response: Response) => void;
    const firstFetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const first = startMediaPreload({ ...ctx, fetcher: firstFetcher });
    await vi.waitFor(() => expect(firstFetcher).toHaveBeenCalledTimes(1));

    await saveMediaPreloadChoice(ctx.store, 'selected-originals', ['/api/assets/entries/1/preview.webp']);
    const secondFetcher = vi.fn(async () => new Response('original'));
    const second = startMediaPreload({ ...ctx, fetcher: secondFetcher });
    release(new Response('obsolete thumbnail'));
    await first;
    expect((await second)?.cached).toBe(1);
    expect(secondFetcher).toHaveBeenCalledWith('https://t3.local/api/assets/entries/1/preview.webp', { cache: 'no-cache' });
  });

  it('does not download originals unless selected explicitly', async () => {
    const ctx = setup(); await install(ctx.store);
    const fetcher = vi.fn(async () => new Response('image'));
    await saveMediaPreloadChoice(ctx.store, 'metadata');
    await startMediaPreload({ ...ctx, fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    await saveMediaPreloadChoice(ctx.store, 'selected-originals', ['/api/assets/entries/1/preview.webp']);
    await startMediaPreload({ ...ctx, fetcher });
    expect(fetcher).toHaveBeenCalledWith('https://t3.local/api/assets/entries/1/preview.webp', { cache: 'no-cache' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed saved selections instead of crashing the foreground resume', async () => {
    const ctx = setup(); await install(ctx.store);
    await ctx.store.writeMeta('mediaPreloadChoice', JSON.stringify({ mode: 'selected-originals', selectedRefs: 'not-an-array' }));
    const fetcher = vi.fn(async () => new Response('image'));
    await expect(startMediaPreload({ ...ctx, fetcher })).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('drops a delayed fetch after Clear and does not restore stale metadata', async () => {
    const ctx = setup(); await install(ctx.store);
    await saveMediaPreloadChoice(ctx.store, 'thumbnails');
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const running = startMediaPreload({ ...ctx, fetcher });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await ctx.store.writeMeta('activeGeneration', '');
    await cancelMediaPreload(ctx.store);
    release(new Response('old'));
    await running;
    expect(ctx.bytes.size).toBe(0);
    expect(await ctx.store.readMeta('mediaPreloadChoice')).toBe('');
  });
});
