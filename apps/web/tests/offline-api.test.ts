// @vitest-environment jsdom

import { File as NodeFile } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import type { SyncSnapshot } from '@t3/shared';
import type { GalleryApi } from '../src/api/gallery.js';
import { ApiError } from '../src/api/client.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createMemoryMediaOutboxStore } from '../src/offline/media-outbox-store.js';
import {
  createMemoryOutboxStore,
  createPendingSyncOperation,
  type PendingSyncOperation,
} from '../src/offline/outbox-store.js';
import {
  ACTIVE_GENERATION_KEY,
  createMemorySnapshotStore,
  readActiveSnapshot,
} from '../src/offline/snapshot-store.js';

function offlineSnapshot(): SyncSnapshot {
  return {
    header: {
      libraryId: 'library-1', syncEpoch: 'epoch-1', snapshotSeq: 1, changeSeq: 1,
      generatedAt: '2026-09-13', sqliteSchemaVersion: 16, snapshotFormatVersion: 2,
      counts: { entries: 1, producers: 1, entryContents: 0, entryTags: 1, collections: 1 }, checksum: 'stored',
    },
    payload: {
      entries: [{ id: 1, syncUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', syncVersion: 1, title: 'Offline Entry', type: 'game', coverRef: null, previewRef: null, previewRefs: [], pageCount: null, uploadDate: null, createdAt: '2026-09-13', updatedAt: '2026-09-13' }],
      producers: [{ id: 9, name: 'Offline Author', occupation: 'Artist', artworkRef: '/api/assets/producers/9/artwork.webp', content: 'Saved bio' }],
      entryProducers: [{ entryId: 1, producerId: 9 }],
      tags: [{ id: 10, name: 'RPG', normalizedName: 'rpg' }], tagGroups: [],
      entryTags: [{ entryId: 1, tagId: 10, facetId: 1 }],
      producerTags: [{ id: 20, name: 'Illustrator', normalizedName: 'illustrator' }],
      producerTagAssignments: [{ producerId: 9, tagId: 20 }],
      entryContents: [],
      ratingSlots: [{
        id: 7,
        syncUid: '71717171-7171-4171-8171-717171717171',
        subjectKind: 'entry',
        entryType: 'game',
        name: 'Quality',
        sortOrder: 0,
      }],
      entryRatingValues: [], producerRatingValues: [],
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

async function populatedOfflineStore() {
  const outbox = createMemoryOutboxStore();
  const media = createMemoryMediaOutboxStore((operation) => outbox.enqueue(operation));
  return { ...await populatedStore(), ...outbox, ...media };
}

async function stampChecksum(snapshot: SyncSnapshot): Promise<void> {
  const { checksum, ...header } = snapshot.header;
  void checksum;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(header) + JSON.stringify(snapshot.payload),
  ));
  snapshot.header.checksum = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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

  it('treats Capacitor native connection failures as offline transport errors', async () => {
    const online = {
      listGalleries: vi.fn().mockRejectedValue(
        new Error('Failed to connect to /192.168.50.155:8765'),
      ),
    } as unknown as GalleryApi;
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null as string | null };
    const api = createOfflineAwareGalleryApi(online, await populatedStore(), { state });

    await expect(api.listGalleries()).resolves.toEqual([
      { type: 'game', entryCount: 1, nsfw: false },
    ]);
    expect(state.mode).toBe('offline');
  });

  it('accepts a Capacitor connection failure for offline Entry creation but rejects business errors', async () => {
    const store = await populatedOfflineStore();
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', sqliteSchemaVersion: 23,
        snapshotFormatVersion: 2, syncProtocolVersion: 1, serverBuild: 'test',
        featureFlags: { offlineEntryCreate: true, offlineMediaUpload: true },
      }),
    } as unknown as GalleryApi;
    const ids = [
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'test-client',
      randomUUID: () => ids.shift()!,
    });
    await api.getSyncCapabilities();
    const draft = {
      title: 'Native offline create', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: false, coverFile: null, previewFile: null,
    };

    await expect(api.enqueueOfflineEntryCreate?.(
      draft,
      new Error('Failed to connect to /192.168.50.155:8765'),
    )).resolves.toEqual({ localKey: 'local:22222222-2222-4222-8222-222222222222' });
    expect(await store.list()).toHaveLength(1);
    await expect(api.enqueueOfflineEntryCreate?.(
      draft,
      new Error('Title is invalid'),
    )).rejects.toThrow('Title is invalid');
  });

  it('caches new mutation capabilities from the startup probe before going offline', async () => {
    const store = await populatedOfflineStore();
    const disconnected = new Error('Failed to connect to /192.168.50.155:8765');
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', sqliteSchemaVersion: 23,
        snapshotFormatVersion: 2, syncProtocolVersion: 1, serverBuild: 'c2-test',
        featureFlags: {
          offlineEntryCreate: true,
          offlineMediaUpload: true,
          offlineUsageEvents: true,
          offlineEntryViewLater: true,
          offlineEntryRating: true,
        },
      }),
      recordEntryView: vi.fn().mockRejectedValue(disconnected),
      likeEntry: vi.fn().mockRejectedValue(disconnected),
      addViewLaterEntry: vi.fn().mockRejectedValue(disconnected),
      setEntryRating: vi.fn().mockRejectedValue(disconnected),
    } as unknown as GalleryApi;
    const state = {
      mode: 'online' as 'online' | 'offline',
      lastFallbackAt: null as string | null,
      pendingCount: 0,
      lastCapabilityProbe: null,
      lastSuccessfulCapabilityProbe: null,
      lastMutationDiagnostic: null,
    };
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];
    const api = createOfflineAwareGalleryApi(online, store, {
      state,
      clientId: 'test-client',
      randomUUID: () => ids.shift()!,
    });

    await api.getSyncCapabilities();
    expect(await store.readMeta('capability.offlineUsageEvents')).toBe('1');
    expect(await store.readMeta('capability.offlineEntryViewLater')).toBe('1');
    expect(await store.readMeta('capability.offlineEntryRating')).toBe('1');
    expect(state.lastCapabilityProbe).toMatchObject({
      status: 'success', serverBuild: 'c2-test', offlineUsageEvents: true, offlineEntryViewLater: true,
    });
    expect(state.lastSuccessfulCapabilityProbe).toMatchObject({
      serverBuild: 'c2-test', offlineUsageEvents: true, offlineEntryViewLater: true,
    });

    await api.recordEntryView(1);
    await api.likeEntry(1);
    await api.addViewLaterEntry(1);
    await api.setEntryRating(1, 7, 4.5);

    expect((await store.list()).map((operation) => operation.operationKind)).toEqual([
      'entry.usage', 'entry.usage', 'entry.view-later.set', 'entry.rating.set',
    ]);
    expect(state).toMatchObject({
      mode: 'offline', pendingCount: 4,
      lastMutationDiagnostic: {
        action: 'rating-set', modeBefore: 'offline', capability: '1', result: 'queued',
      },
    });
  });

  it('never converts a failed mutation into a local write', async () => {
    const online = {
      deleteEntry: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, await populatedStore());

    await expect(api.deleteEntry(1)).rejects.toThrow('Failed to fetch');
    expect(online.deleteEntry).toHaveBeenCalledWith(1);
  });

  it('queues an offline Entry title and removes it only after replay plus snapshot refresh', async () => {
    const store = await populatedOfflineStore();
    const refreshed = structuredClone(offlineSnapshot());
    refreshed.header.snapshotSeq = 2;
    refreshed.header.changeSeq = 2;
    refreshed.payload.entries[0]!.title = 'Queued title';
    refreshed.payload.entries[0]!.syncVersion = 2;
    await stampChecksum(refreshed);
    const replaySyncOperation = vi.fn().mockImplementation(async (operation) => ({
      opId: operation.opId, status: 'applied', resourceVersion: 2, serverSeq: 2,
    }));
    const online = {
      updateEntry: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      replaySyncOperation,
      fetchSyncSnapshot: vi.fn().mockResolvedValue(refreshed),
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', sqliteSchemaVersion: 16,
        snapshotFormatVersion: 2, syncProtocolVersion: 1, serverBuild: 'test',
        featureFlags: { offlineMutations: false },
      }),
    } as unknown as GalleryApi;
    const state = {
      mode: 'online' as 'online' | 'offline',
      lastFallbackAt: null as string | null,
      pendingCount: 0,
      conflictCount: 0,
      lastReplayError: null as string | null,
    };
    const api = createOfflineAwareGalleryApi(online, store, {
      state,
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
      clientId: 'test-client',
    });

    expect(await api.updateEntry(1, { title: 'Queued title' })).toMatchObject({
      id: 1, title: 'Queued title', type: 'game',
    });
    expect(await store.list()).toHaveLength(1);
    expect(state).toMatchObject({ mode: 'offline', pendingCount: 1, conflictCount: 0 });
    expect((await api.getEntry(1)).title).toBe('Queued title');

    await api.getSyncCapabilities();

    expect(replaySyncOperation).toHaveBeenCalledTimes(1);
    expect(replaySyncOperation.mock.calls[0]?.[0]).not.toHaveProperty('status');
    expect(replaySyncOperation.mock.calls[0]?.[0]).not.toHaveProperty('lastError');
    expect(online.fetchSyncSnapshot).toHaveBeenCalledTimes(1);
    expect(await store.list()).toEqual([]);
    expect(state).toMatchObject({ mode: 'online', pendingCount: 0, conflictCount: 0 });
  });

  it('queues offline View and Like events and overlays usage without calling the server', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineUsageEvents', '1');
    const refreshed = structuredClone(offlineSnapshot());
    refreshed.header.snapshotSeq = 2;
    refreshed.header.changeSeq = 3;
    refreshed.payload.entries[0]!.syncVersion = 3;
    refreshed.payload.entryUsage = [{
      entryId: 1, viewCount: 1, likeCount: 1, lastViewedAt: '2026-09-20T12:00:00.000Z',
    }];
    await stampChecksum(refreshed);
    const replaySyncOperation = vi.fn(async (operation: PendingSyncOperation) => ({
      opId: operation.opId,
      status: 'applied' as const,
      resourceVersion: operation.payload.event === 'view' ? 2 : 3,
      serverSeq: operation.payload.event === 'view' ? 2 : 3,
    }));
    const online = {
      recordEntryView: vi.fn(),
      likeEntry: vi.fn(),
      replaySyncOperation,
      fetchSyncSnapshot: vi.fn().mockResolvedValue(refreshed),
    } as unknown as GalleryApi;
    const ids = [
      '41414141-4141-4141-8141-414141414141',
      '42424242-4242-4242-8242-424242424242',
    ];
    const state = {
      mode: 'offline' as 'online' | 'offline', lastFallbackAt: null,
      pendingCount: 0, conflictCount: 0, failedCount: 0,
      lastReplayError: null as string | null,
    };
    const api = createOfflineAwareGalleryApi(online, store, {
      state,
      clientId: 'android-client',
      randomUUID: () => ids.shift()!,
    });

    const viewed = await api.recordEntryView(1);
    const liked = await api.likeEntry(1);

    expect(viewed).toMatchObject({ viewCount: 1, likeCount: 0 });
    expect(viewed.lastViewedAt).toEqual(expect.any(String));
    expect(liked).toMatchObject({ viewCount: 1, likeCount: 1 });
    expect(online.recordEntryView).not.toHaveBeenCalled();
    expect(online.likeEntry).not.toHaveBeenCalled();
    expect((await store.list()).map((operation) => ({
      opId: operation.opId,
      operationKind: operation.operationKind,
      baseVersion: operation.baseVersion,
      payload: operation.payload,
    }))).toEqual([
      {
        opId: '41414141-4141-4141-8141-414141414141',
        operationKind: 'entry.usage', baseVersion: 0, payload: { event: 'view' },
      },
      {
        opId: '42424242-4242-4242-8242-424242424242',
        operationKind: 'entry.usage', baseVersion: 0, payload: { event: 'like' },
      },
    ]);
    expect((await api.getEntry(1)).usage).toMatchObject({ viewCount: 1, likeCount: 1 });
    expect((await api.getAuthor(9)).usage).toMatchObject({ viewCount: 1, likeCount: 1 });
    expect(state).toMatchObject({ mode: 'offline', pendingCount: 2 });

    await api.flushOfflineOutbox?.();

    expect(replaySyncOperation).toHaveBeenCalledTimes(2);
    expect(await store.list()).toEqual([]);
    expect((await readActiveSnapshot(store))?.snapshot.payload.entryUsage).toEqual([
      { entryId: 1, viewCount: 1, likeCount: 1, lastViewedAt: '2026-09-20T12:00:00.000Z' },
    ]);
    expect(state.pendingCount).toBe(0);
  });

  it('queues ordered Entry View later desired states and overlays membership', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryViewLater', '1');
    const refreshed = structuredClone(offlineSnapshot());
    refreshed.header.snapshotSeq = 2;
    refreshed.header.changeSeq = 3;
    refreshed.payload.entries[0]!.syncVersion = 3;
    refreshed.payload.viewLaterEntries = [];
    await stampChecksum(refreshed);
    const online = {
      addViewLaterEntry: vi.fn(),
      removeViewLaterEntry: vi.fn(),
      replaySyncOperation: vi.fn(async (operation: PendingSyncOperation) => ({
        opId: operation.opId,
        status: 'applied' as const,
        resourceVersion: operation.payload.present === true ? 2 : 3,
        serverSeq: operation.payload.present === true ? 2 : 3,
      })),
      fetchSyncSnapshot: vi.fn(async () => structuredClone(refreshed)),
    } as unknown as GalleryApi;
    const state = {
      mode: 'offline' as const, pendingCount: 0, conflictCount: 0, failedCount: 0,
      lastReplayError: null, lastFallbackAt: null,
    };
    const ids = [
      '91919191-9191-4191-8191-919191919191',
      '92929292-9292-4292-8292-929292929292',
    ];
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-1', state, randomUUID: () => ids.shift()!,
    });

    expect(await api.addViewLaterEntry(1)).toMatchObject({ entryIds: [1] });
    expect(await api.addViewLaterEntry(1)).toMatchObject({ entryIds: [1] });
    expect(await api.removeViewLaterEntry(1)).toMatchObject({ entryIds: [] });
    expect(online.addViewLaterEntry).not.toHaveBeenCalled();
    expect(online.removeViewLaterEntry).not.toHaveBeenCalled();
    const queued = await store.list();
    expect(queued).toHaveLength(2);
    expect(queued.map((operation) => ({
      kind: operation.operationKind,
      baseVersion: operation.baseVersion,
      baseValues: operation.baseValues,
      payload: operation.payload,
    }))).toEqual([
      {
        kind: 'entry.view-later.set',
        baseVersion: 1,
        baseValues: { present: false },
        payload: { present: true },
      },
      {
        kind: 'entry.view-later.set',
        baseVersion: 2,
        baseValues: { present: true },
        payload: { present: false },
      },
    ]);
    expect(await api.getViewLaterState()).toMatchObject({ entryIds: [] });
    expect(state).toMatchObject({ mode: 'offline', pendingCount: 2 });

    await api.flushOfflineOutbox?.();
    expect(await store.list()).toEqual([]);
    expect((await readActiveSnapshot(store))?.snapshot.payload.viewLaterEntries).toEqual([]);
    expect(state.pendingCount).toBe(0);
  });

  it('keeps old snapshots readable but refuses ratings until slot UIDs are refreshed', async () => {
    const snapshot = offlineSnapshot();
    snapshot.payload.ratingSlots = snapshot.payload.ratingSlots.map((slot) => ({
      id: slot.id,
      subjectKind: slot.subjectKind,
      entryType: slot.entryType,
      name: slot.name,
      sortOrder: slot.sortOrder,
    }));
    const outbox = createMemoryOutboxStore();
    const media = createMemoryMediaOutboxStore((operation) => outbox.enqueue(operation));
    const store = { ...createMemorySnapshotStore(), ...outbox, ...media };
    await store.writeGeneration(1, JSON.stringify(snapshot));
    await store.writeMeta(ACTIVE_GENERATION_KEY, '1');
    await store.writeMeta('capability.offlineEntryRating', '1');
    const api = createOfflineAwareGalleryApi({} as GalleryApi, store, {
      state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1',
    });

    await expect(api.getEntry(1)).resolves.toMatchObject({ id: 1, title: 'Offline Entry' });
    await expect(api.setEntryRating(1, 7, 4.5)).rejects.toThrow(
      'Rating slot is unavailable in this offline copy; update it while online',
    );
    await expect(store.list()).resolves.toHaveLength(0);
  });

  it('queues ordered Entry rating desired states and overlays the final value', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryRating', '1');
    const state = {
      mode: 'offline' as const, pendingCount: 0, conflictCount: 0, failedCount: 0,
      lastReplayError: null, lastFallbackAt: null,
    };
    const ids = [
      '71717171-7171-4171-8171-717171717171',
      '72727272-7272-4272-8272-727272727272',
    ];
    const online = { setEntryRating: vi.fn() } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-1', state, randomUUID: () => ids.shift()!,
    });

    expect(await api.setEntryRating(1, 7, 4.5)).toEqual({
      slotId: 7, name: 'Quality', stars: 4.5,
    });
    expect(await api.setEntryRating(1, 7, 4.5)).toEqual({
      slotId: 7, name: 'Quality', stars: 4.5,
    });
    expect(await api.setEntryRating(1, 7, null)).toEqual({
      slotId: 7, name: 'Quality', stars: null,
    });
    expect(online.setEntryRating).not.toHaveBeenCalled();
    expect((await store.list()).map((operation) => ({
      kind: operation.operationKind,
      baseVersion: operation.baseVersion,
      baseValues: operation.baseValues,
      payload: operation.payload,
    }))).toEqual([
      {
        kind: 'entry.rating.set', baseVersion: 1,
        baseValues: { slotUid: '71717171-7171-4171-8171-717171717171', stars: null },
        payload: { slotUid: '71717171-7171-4171-8171-717171717171', stars: 4.5 },
      },
      {
        kind: 'entry.rating.set', baseVersion: 2,
        baseValues: { slotUid: '71717171-7171-4171-8171-717171717171', stars: 4.5 },
        payload: { slotUid: '71717171-7171-4171-8171-717171717171', stars: null },
      },
    ]);
    expect((await api.getEntry(1)).ratings).toEqual([
      { slotId: 7, name: 'Quality', stars: null },
    ]);
    expect(state).toMatchObject({ mode: 'offline', pendingCount: 2 });
  });

  it('predicts one shared Entry revision across usage, rating, View later, and scalar operations', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineUsageEvents', '1');
    await store.writeMeta('capability.offlineEntryViewLater', '1');
    await store.writeMeta('capability.offlineEntryRating', '1');
    const state = {
      mode: 'offline' as const, pendingCount: 0, conflictCount: 0, failedCount: 0,
      lastReplayError: null, lastFallbackAt: null,
    };
    const ids = [
      '93939393-9393-4393-8393-939393939393',
      '94949494-9494-4494-8494-949494949494',
      '95959595-9595-4595-8595-959595959595',
      '96969696-9696-4696-8696-969696969696',
    ];
    const api = createOfflineAwareGalleryApi({} as GalleryApi, store, {
      clientId: 'client-1', state, randomUUID: () => ids.shift()!,
    });

    await api.likeEntry(1);
    await api.setEntryRating(1, 7, 4.5);
    await api.addViewLaterEntry(1);
    await api.updateEntry(1, { title: 'Queued title' });

    expect((await store.list()).map((operation) => ({
      kind: operation.operationKind,
      baseVersion: operation.baseVersion,
    }))).toEqual([
      { kind: 'entry.usage', baseVersion: 0 },
      { kind: 'entry.rating.set', baseVersion: 2 },
      { kind: 'entry.view-later.set', baseVersion: 3 },
      { kind: 'entry.update', baseVersion: 4 },
    ]);
  });

  it('does not queue authoritative Like business errors', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineUsageEvents', '1');
    const online = {
      likeEntry: vi.fn().mockRejectedValue(new ApiError(409, {
        error: { code: 'CONFLICT', message: 'Like rejected' },
      })),
    } as unknown as GalleryApi;
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null as string | null };
    const api = createOfflineAwareGalleryApi(online, store, { state });

    await expect(api.likeEntry(1)).rejects.toThrow('Like rejected');
    expect(await store.list()).toEqual([]);
    expect(state.mode).toBe('online');
  });

  it('does not queue authoritative rating business errors', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryRating', '1');
    const online = {
      setEntryRating: vi.fn().mockRejectedValue(new ApiError(409, {
        error: { code: 'CONFLICT', message: 'Rating slot changed' },
      })),
    } as unknown as GalleryApi;
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null as string | null };
    const api = createOfflineAwareGalleryApi(online, store, { state });

    await expect(api.setEntryRating(1, 7, 4.5)).rejects.toThrow('Rating slot changed');
    expect(await store.list()).toEqual([]);
    expect(state.mode).toBe('online');
  });

  it('stages an offline Entry and media atomically, then replays metadata before media', async () => {
    const store = await populatedOfflineStore();
    const entityUid = '22222222-2222-4222-8222-222222222222';
    const opId = '33333333-3333-4333-8333-333333333333';
    const coverUploadId = '44444444-4444-4444-8444-444444444444';
    const previewUploadId = '55555555-5555-4555-8555-555555555555';
    const ids = [entityUid, opId, coverUploadId, previewUploadId];
    const refreshed = structuredClone(offlineSnapshot());
    refreshed.header.snapshotSeq = 2;
    refreshed.header.changeSeq = 3;
    refreshed.header.counts.entries = 2;
    refreshed.payload.entries.push({
      id: 2,
      syncUid: entityUid,
      syncVersion: 3,
      title: 'Created offline',
      type: 'game',
      coverRef: '/api/assets/entries/2/cover.png',
      previewRef: '/api/assets/entries/2/preview.png',
      previewRefs: ['/api/assets/entries/2/preview.png'],
      pageCount: 12,
      uploadDate: '2026-09-19',
      createdAt: '2026-09-19',
      updatedAt: '2026-09-19',
    });
    await stampChecksum(refreshed);
    const replaySyncOperation = vi.fn().mockImplementation(async (operation) => ({
      opId: operation.opId,
      status: 'applied',
      resourceVersion: 1,
      serverSeq: 2,
      entityId: 2,
    }));
    const uploadSyncMedia = vi.fn().mockImplementation(async (uploadId, metadata) => ({
      uploadId,
      status: 'applied',
      entityId: 2,
      relativeRef: `/api/assets/entries/2/${metadata.kind}.png`,
      resourceVersion: metadata.kind === 'cover' ? 2 : 3,
      serverSeq: 3,
    }));
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', sqliteSchemaVersion: 22,
        snapshotFormatVersion: 2, syncProtocolVersion: 1, serverBuild: 'test',
        featureFlags: {
          offlineMutations: true,
          offlineEntryUpdate: true,
          offlineEntryCreate: true,
          offlineMediaUpload: true,
        },
      }),
      replaySyncOperation,
      uploadSyncMedia,
      fetchSyncSnapshot: vi.fn().mockResolvedValue(refreshed),
    } as unknown as GalleryApi;
    const state = {
      mode: 'online' as 'online' | 'offline', lastFallbackAt: null,
      pendingCount: 0, conflictCount: 0, failedCount: 0,
      lastReplayError: null as string | null,
    };
    const api = createOfflineAwareGalleryApi(online, store, {
      state,
      randomUUID: () => ids.shift()!,
      clientId: 'test-client',
    });
    await api.getSyncCapabilities();
    const cover = new NodeFile([new Uint8Array([1, 2, 3])], 'cover.png', {
      type: 'image/png',
    }) as unknown as File;
    const preview = new NodeFile([new Uint8Array([4, 5, 6])], 'preview.png', {
      type: 'image/png',
    }) as unknown as File;

    await expect(api.enqueueOfflineEntryCreate?.({
      title: 'Created offline',
      type: 'game',
      uploadDate: '2026-09-19',
      pageCount: 12,
      ratings: [],
      viewLater: true,
      coverFile: cover,
      previewFile: preview,
    })).resolves.toEqual({ localKey: `local:${entityUid}` });
    const queued = await store.list();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      opId,
      entityUid,
      operationKind: 'entry.create',
      baseVersion: 0,
      baseValues: {},
      payload: {
        title: 'Created offline', type: 'game', pageCount: 12, viewLater: true,
      },
    });
    expect((await store.listMedia()).map((upload) => upload.uploadId))
      .toEqual([coverUploadId, previewUploadId]);
    expect(state.pendingCount).toBe(3);
    await expect(api.listPendingOfflineEntryCreates?.()).resolves.toEqual([{
      localKey: `local:${entityUid}`,
      title: 'Created offline',
      type: 'game',
      uploadDate: '2026-09-19',
      pageCount: 12,
      status: 'pending',
    }]);

    await api.flushOfflineOutbox?.();

    expect(replaySyncOperation).toHaveBeenCalledTimes(1);
    expect(uploadSyncMedia).toHaveBeenCalledTimes(2);
    expect(replaySyncOperation.mock.invocationCallOrder[0])
      .toBeLessThan(uploadSyncMedia.mock.invocationCallOrder[0]!);
    expect(await store.list()).toEqual([]);
    expect(await store.listMedia()).toEqual([]);
    expect((await readActiveSnapshot(store))?.snapshot.payload.entries[1]).toMatchObject({
      id: 2, syncUid: entityUid, title: 'Created offline',
    });
    expect(state).toMatchObject({ pendingCount: 0, conflictCount: 0, failedCount: 0 });
  });

  it.each([
    ['a non-advancing snapshot sequence', 1, 2],
    ['a missing change sequence', 2, undefined],
    ['a change sequence behind the replay receipt', 2, 1],
  ])('retains an applied operation when refresh returns %s', async (_label, snapshotSeq, changeSeq) => {
    const store = await populatedOfflineStore();
    const stale = structuredClone(offlineSnapshot());
    stale.header.snapshotSeq = snapshotSeq;
    stale.header.changeSeq = changeSeq;
    stale.payload.entries[0]!.title = 'Queued title';
    stale.payload.entries[0]!.syncVersion = 2;
    await stampChecksum(stale);
    const online = {
      updateEntry: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      replaySyncOperation: vi.fn().mockImplementation(async (operation) => ({
        opId: operation.opId, status: 'applied', resourceVersion: 2, serverSeq: 2,
      })),
      fetchSyncSnapshot: vi.fn().mockResolvedValue(stale),
    } as unknown as GalleryApi;
    const state = {
      mode: 'online' as 'online' | 'offline', lastFallbackAt: null,
      pendingCount: 0, conflictCount: 0, lastReplayError: null as string | null,
    };
    const api = createOfflineAwareGalleryApi(online, store, {
      state,
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
      clientId: 'test-client',
    });

    await api.updateEntry(1, { title: 'Queued title' });
    await api.flushOfflineOutbox?.();

    expect(await store.list()).toHaveLength(1);
    expect((await readActiveSnapshot(store))?.snapshot.payload.entries[0]?.title).toBe('Offline Entry');
    expect(state).toMatchObject({ pendingCount: 1 });
    expect(state.lastReplayError).toContain('Snapshot refresh failed');
  });

  it('retains an applied operation when snapshot refresh transport fails', async () => {
    const store = await populatedOfflineStore();
    const online = {
      updateEntry: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      replaySyncOperation: vi.fn().mockImplementation(async (operation) => ({
        opId: operation.opId, status: 'applied', resourceVersion: 2, serverSeq: 2,
      })),
      fetchSyncSnapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
      clientId: 'test-client',
    });

    await api.updateEntry(1, { title: 'Queued title' });
    await api.flushOfflineOutbox?.();

    expect(await store.list()).toHaveLength(1);
    expect((await readActiveSnapshot(store))?.snapshot.payload.entries[0]?.title).toBe('Offline Entry');
  });

  it('replays independent Entries past a conflict but preserves later dependent edits', async () => {
    const seeded = structuredClone(offlineSnapshot());
    seeded.header.counts.entries = 2;
    seeded.payload.entries.push({
      ...seeded.payload.entries[0]!,
      id: 2,
      syncUid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Second Entry',
    });
    const snapshotStore = createMemorySnapshotStore();
    await snapshotStore.writeGeneration(1, JSON.stringify(seeded));
    await snapshotStore.writeMeta(ACTIVE_GENERATION_KEY, '1');
    const store = { ...snapshotStore, ...createMemoryOutboxStore() };
    const refreshed = structuredClone(seeded);
    refreshed.header.snapshotSeq = 2;
    refreshed.header.changeSeq = 3;
    refreshed.payload.entries[0]!.title = 'Server title';
    refreshed.payload.entries[0]!.syncVersion = 2;
    refreshed.payload.entries[1]!.title = 'Independent local title';
    refreshed.payload.entries[1]!.syncVersion = 2;
    await stampChecksum(refreshed);
    const replaySyncOperation = vi.fn().mockImplementation(async (operation) => operation.entityUid.startsWith('a')
      ? {
          opId: operation.opId, status: 'conflict', currentVersion: 2,
          currentValues: { title: 'Server title' }, serverSeq: 2,
        }
      : { opId: operation.opId, status: 'applied', resourceVersion: 2, serverSeq: 3 });
    const online = {
      updateEntry: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      replaySyncOperation,
      fetchSyncSnapshot: vi.fn().mockResolvedValue(refreshed),
    } as unknown as GalleryApi;
    const operationIds = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    const api = createOfflineAwareGalleryApi(online, store, {
      randomUUID: () => operationIds.shift()!,
      clientId: 'test-client',
    });

    await api.updateEntry(1, { title: 'First local title' });
    await api.updateEntry(1, { title: 'Dependent local title' });
    await api.updateEntry(2, { title: 'Independent local title' });
    await api.flushOfflineOutbox?.();

    expect(replaySyncOperation.mock.calls.map(([operation]) => operation.entityUid)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
    expect(await store.list()).toMatchObject([
      { opId: '11111111-1111-4111-8111-111111111111', status: 'conflict' },
      { opId: '22222222-2222-4222-8222-222222222222', status: 'pending' },
    ]);

    await api.discardBlockedOfflineOperations?.();
    expect(await store.list()).toEqual([]);
  });

  it('marks an unsupported legacy operation failed and continues with later valid work', async () => {
    const seeded = structuredClone(offlineSnapshot());
    seeded.header.counts.entries = 2;
    seeded.payload.entries.push({
      ...seeded.payload.entries[0]!,
      id: 2,
      syncUid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Second Entry',
    });
    const snapshotStore = createMemorySnapshotStore();
    await snapshotStore.writeGeneration(1, JSON.stringify(seeded));
    await snapshotStore.writeMeta(ACTIVE_GENERATION_KEY, '1');
    const outbox = createMemoryOutboxStore();
    const store = { ...snapshotStore, ...outbox };
    const legacy = {
      ...createPendingSyncOperation({
        clientId: 'test-client', libraryId: 'library-1', syncEpoch: 'epoch-1',
        entityKind: 'entry', entityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        operationKind: 'entry.update', baseVersion: 1,
        baseValues: { title: 'Offline Entry' }, payload: { title: 'Legacy title' },
      }, { randomUUID: () => '11111111-1111-4111-8111-111111111111' }),
      operationKind: 'entry.legacy',
    } as unknown as PendingSyncOperation;
    const valid = createPendingSyncOperation({
      clientId: 'test-client', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'entry', entityUid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      operationKind: 'entry.update', baseVersion: 1,
      baseValues: { title: 'Second Entry' }, payload: { title: 'Valid title' },
    }, { randomUUID: () => '22222222-2222-4222-8222-222222222222' });
    await store.enqueue(legacy);
    await store.enqueue(valid);
    const refreshed = structuredClone(seeded);
    refreshed.header.snapshotSeq = 2;
    refreshed.header.changeSeq = 2;
    refreshed.payload.entries[1]!.title = 'Valid title';
    refreshed.payload.entries[1]!.syncVersion = 2;
    await stampChecksum(refreshed);
    const replaySyncOperation = vi.fn().mockImplementation(async (operation) => ({
      opId: operation.opId, status: 'applied', resourceVersion: 2, serverSeq: 2,
    }));
    const api = createOfflineAwareGalleryApi({
      replaySyncOperation,
      fetchSyncSnapshot: vi.fn().mockResolvedValue(refreshed),
    } as unknown as GalleryApi, store);

    await api.flushOfflineOutbox?.();

    expect(replaySyncOperation).toHaveBeenCalledTimes(1);
    expect(replaySyncOperation.mock.calls[0]?.[0]).toMatchObject({ opId: valid.opId });
    expect(await store.list()).toMatchObject([{
      opId: legacy.opId,
      status: 'failed',
      lastError: expect.stringContaining('Invalid offline operation'),
    }]);
  });

  it('persists an explicit conflict and keeps the optimistic overlay', async () => {
    const store = await populatedOfflineStore();
    const online = {
      updateEntry: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      replaySyncOperation: vi.fn().mockImplementation(async (operation) => ({
        opId: operation.opId,
        status: 'conflict',
        currentVersion: 2,
        currentValues: { title: 'Server title' },
        serverSeq: 2,
      })),
    } as unknown as GalleryApi;
    const state = {
      mode: 'online' as 'online' | 'offline', lastFallbackAt: null,
      pendingCount: 0, conflictCount: 0, lastReplayError: null as string | null,
    };
    const api = createOfflineAwareGalleryApi(online, store, {
      state,
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
      clientId: 'test-client',
    });

    await api.updateEntry(1, { title: 'Local title' });
    await api.flushOfflineOutbox?.();

    expect(await store.list()).toMatchObject([{
      status: 'conflict',
      lastError: 'An offline edit conflicts with a newer server value',
    }]);
    expect(state).toMatchObject({ pendingCount: 0, conflictCount: 1 });
    expect((await api.getEntry(1)).title).toBe('Local title');
    expect(online.fetchSyncSnapshot).toBeUndefined();

    await api.discardBlockedOfflineOperations?.();
    expect(await store.list()).toEqual([]);
    expect(state).toMatchObject({ pendingCount: 0, conflictCount: 0 });
    expect((await api.getEntry(1)).title).toBe('Offline Entry');
  });

  it('discards pending staged media together with a blocked offline create', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    await store.writeMeta('capability.offlineMediaUpload', '1');
    const ids = [
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];
    const api = createOfflineAwareGalleryApi({} as GalleryApi, store, {
      clientId: 'test-client',
      randomUUID: () => ids.shift()!,
    });
    await api.enqueueOfflineEntryCreate?.({
      title: 'Blocked create',
      type: 'game',
      uploadDate: null,
      pageCount: null,
      ratings: [],
      viewLater: false,
      coverFile: new NodeFile([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' }) as unknown as File,
      previewFile: null,
    });
    const [operation] = await store.list();
    await store.update(operation!.opId, { status: 'conflict', lastError: 'restored library' });
    expect(await store.listMedia()).toHaveLength(1);

    await api.discardBlockedOfflineOperations?.();

    expect(await store.list()).toEqual([]);
    expect(await store.listMedia()).toEqual([]);
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

  it('mints its client identity on an insecure origin without crypto.randomUUID', async () => {
    // A phone reaches T3 at http://192.168.x.x:8765, where the browser exposes
    // getRandomValues but not randomUUID. Constructing the offline API there
    // must not throw, or the whole app fails to mount.
    window.localStorage.clear();
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(7);
        return bytes;
      },
    });
    try {
      const online = {
        listGalleries: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      } as unknown as GalleryApi;
      const api = createOfflineAwareGalleryApi(online, await populatedStore());

      expect(await api.listGalleries()).toEqual([{ type: 'game', entryCount: 1, nsfw: false }]);
      expect(window.localStorage.getItem('t3.offline-client-id'))
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
