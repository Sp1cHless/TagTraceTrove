// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { SyncSnapshot } from '@t3/shared';
import type { GalleryApi } from '../src/api/gallery.js';
import { ApiError } from '../src/api/client.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { ACTIVE_GENERATION_KEY, createMemorySnapshotStore } from '../src/offline/snapshot-store.js';

function offlineSnapshot(): SyncSnapshot {
  return {
    header: {
      libraryId: 'library-1', syncEpoch: 'epoch-1', snapshotSeq: 1,
      generatedAt: '2026-09-13', sqliteSchemaVersion: 15, snapshotFormatVersion: 1,
      counts: { entries: 1, producers: 1, entryContents: 0, entryTags: 1, collections: 1 }, checksum: 'stored',
    },
    payload: {
      entries: [{ id: 1, title: 'Offline Entry', type: 'game', coverRef: null, previewRef: null, previewRefs: [], pageCount: null, uploadDate: null, createdAt: '2026-09-13', updatedAt: '2026-09-13' }],
      producers: [{ id: 9, name: 'Offline Author', occupation: 'Artist', artworkRef: '/api/assets/producers/9/artwork.webp', content: 'Saved bio' }],
      entryProducers: [{ entryId: 1, producerId: 9 }],
      tags: [{ id: 10, name: 'RPG', normalizedName: 'rpg' }], tagGroups: [],
      entryTags: [{ entryId: 1, tagId: 10, facetId: 1 }],
      producerTags: [{ id: 20, name: 'Illustrator', normalizedName: 'illustrator' }],
      producerTagAssignments: [{ producerId: 9, tagId: 20 }],
      entryContents: [], ratingSlots: [], entryRatingValues: [], producerRatingValues: [],
      collections: [{ id: 60, kind: 'producer', title: 'Artists', description: '', nsfw: false, parentId: null, sortOrder: 0 }],
      collectionMembers: [{ collectionId: 60, producerId: 9, position: 0 }],
      authorDirectories: [], authorDirectoryEntries: [], entryUsage: [],
      viewLaterEntries: [], viewLaterProducers: [], gallerySettings: [], mediaRefs: [],
    },
  };
}

async function populatedStore() {
  const store = createMemorySnapshotStore();
  await store.writeGeneration(1, JSON.stringify(offlineSnapshot()));
  await store.writeMeta(ACTIVE_GENERATION_KEY, '1');
  return store;
}

describe('offline-aware Gallery API', () => {
  it('falls back to the active snapshot for core read calls', async () => {
    const offline = new TypeError('Failed to fetch');
    const online = {
      assetUrl: (path: string) => `/assets/${path}`,
      listGalleries: vi.fn().mockRejectedValue(offline),
      listAuthors: vi.fn().mockRejectedValue(offline),
      getViewLaterState: vi.fn().mockRejectedValue(offline),
      queryEntryPage: vi.fn().mockRejectedValue(offline),
      getSyncCapabilities: vi.fn().mockResolvedValue({}),
    } as unknown as GalleryApi;
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null as string | null };
    const api = createOfflineAwareGalleryApi(online, await populatedStore(), { state });

    expect(await api.listGalleries()).toEqual([{ type: 'game', entryCount: 1, nsfw: false }]);
    expect((await api.queryEntryPage({
      entryType: 'game', conditions: [], authorIds: [], ratingConditions: [], ratingSort: null,
      usageConditions: [], usageSort: null, sort: 'date-desc', page: 1, pageSize: 30,
    })).items[0]?.title).toBe('Offline Entry');
    expect(online.queryEntryPage).not.toHaveBeenCalled();
    expect(api.assetUrl('cover.webp')).toBe('/assets/cover.webp');
    expect(state.mode).toBe('offline');
    expect(state.lastFallbackAt).not.toBeNull();

    await api.getSyncCapabilities();
    await api.listGalleries();
    expect(online.listGalleries).toHaveBeenCalledTimes(2);
    expect(state.mode).toBe('offline');
  });

  it('never converts a failed mutation into a local write', async () => {
    const online = {
      deleteEntry: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, await populatedStore());

    await expect(api.deleteEntry(1)).rejects.toThrow('Failed to fetch');
    expect(online.deleteEntry).toHaveBeenCalledWith(1);
  });

  it('serves Author, Tag, taxonomy, and producer-collection reads from the snapshot', async () => {
    const offline = new TypeError('Failed to fetch');
    const online = {
      queryProducerPage: vi.fn().mockRejectedValue(offline),
      getAuthor: vi.fn().mockRejectedValue(offline),
      listAuthorFilterOptions: vi.fn().mockRejectedValue(offline),
      searchTags: vi.fn().mockRejectedValue(offline),
      listGalleryTags: vi.fn().mockRejectedValue(offline),
      listCollectionsForProducer: vi.fn().mockRejectedValue(offline),
      listTaxonomyAliases: vi.fn().mockRejectedValue(offline),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, await populatedStore());

    const page = await api.queryProducerPage({
      ownTagIds: [], relatedEntryTagIds: [], includeNsfw: true,
      sort: 'name-asc', page: 1, pageSize: 30,
    });
    expect(page.items).toMatchObject([{ id: 9, name: 'Offline Author' }]);
    expect(await api.getAuthor(9)).toMatchObject({ id: 9, name: 'Offline Author', tags: [{ tagId: 20 }] });
    expect(await api.listAuthorFilterOptions()).toEqual({
      authorTags: [{ tagId: 20, name: 'Illustrator' }],
      workTags: [{ tagId: 10, name: 'RPG' }],
    });
    expect(await api.searchTags('rpg', true)).toMatchObject([{ tagId: 10, entryCount: 1 }]);
    expect(await api.listGalleryTags('game')).toMatchObject([{ id: 10, entryCount: 1 }]);
    expect(await api.listCollectionsForProducer(9)).toEqual([60]);
    expect(await api.listTaxonomyAliases('producer')).toEqual([]);
    expect(online.getAuthor).not.toHaveBeenCalled();
  });

  it('does not hide authoritative HTTP errors behind stale snapshot data', async () => {
    const online = {
      listGalleries: vi.fn().mockRejectedValue(new ApiError(404, { message: 'missing route' })),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, await populatedStore());

    await expect(api.listGalleries()).rejects.toMatchObject({ status: 404 });
  });

  it('preserves the online error when no snapshot is available', async () => {
    const online = {
      listGalleries: vi.fn().mockRejectedValue(new Error('server unavailable')),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, createMemorySnapshotStore());

    await expect(api.listGalleries()).rejects.toThrow('server unavailable');
  });
});
