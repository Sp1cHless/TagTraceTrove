// @vitest-environment jsdom

import { File as NodeFile } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncReplayOperation, SyncSnapshot } from '@t3/shared';
import type { GalleryApi } from '../src/api/gallery.js';
import { ApiError } from '../src/api/client.js';
import { createOfflineAwareGalleryApi, localCollectionId, subscribeCollectionReconciliation } from '../src/offline/offline-api.js';
import { createMemoryMediaOutboxStore } from '../src/offline/media-outbox-store.js';
import {
  createMemoryOutboxStore,
  createPendingSyncOperation,
  operationFingerprint,
  type PendingSyncOperation,
} from '../src/offline/outbox-store.js';
import {
  ACTIVE_GENERATION_KEY,
  createMemorySnapshotStore,
  readActiveSnapshot,
} from '../src/offline/snapshot-store.js';

it('foreground scheduler observes the shared current entry-update capability downgrade without rewriting its original',async()=>{
 const store=await populatedOfflineStore();
 const operation=createPendingSyncOperation({clientId:'client',libraryId:'library-1',syncEpoch:'epoch-1',entityKind:'entry',entityUid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',operationKind:'entry.update',baseVersion:1,baseValues:{title:'Offline Entry'},payload:{title:'After'}},{randomUUID:()=> '13131313-1313-4313-8313-131313131313'});
 await store.enqueue(operation);await store.writeMeta('capability.offlineEntryUpdate','0');
 const replaySyncOperation=vi.fn(async()=>({status:'failed',opId:operation.opId,code:'fixture',message:'unexpected send'}));
 const api=createOfflineAwareGalleryApi({replaySyncOperation} as unknown as GalleryApi,store);
 await api.replayOfflineOperations!();
 expect(replaySyncOperation).not.toHaveBeenCalled();expect(await store.list()).toEqual([operation]);
});
function offlineSnapshot(): SyncSnapshot {
  return {
    header: {
      libraryId: 'library-1', syncEpoch: 'epoch-1', snapshotSeq: 1, changeSeq: 1,
      generatedAt: '2026-09-13', sqliteSchemaVersion: 28, snapshotFormatVersion: 2,
      counts: { entries: 1, producers: 1, entryContents: 0, entryTags: 1, collections: 1 }, checksum: 'stored',
    },
    payload: {
      entries: [{ id: 1, syncUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', syncVersion: 1, title: 'Offline Entry', type: 'game', coverRef: null, previewRef: null, previewRefs: [], pageCount: null, uploadDate: null, createdAt: '2026-09-13', updatedAt: '2026-09-13' }],
      producers: [{ id: 9, syncUid: '99999999-9999-4999-8999-999999999999', syncVersion: 1, name: 'Offline Author', occupation: 'Artist', artworkRef: '/api/assets/producers/9/artwork.webp', content: 'Saved bio' }],
      entryProducers: [{ entryId: 1, producerId: 9 }],
      tags: [{ id: 10, name: 'RPG', normalizedName: 'rpg' }], tagGroups: [],
      entryTags: [{ entryId: 1, tagId: 10, facetId: 1 }],
      producerTags: [{ id: 20, syncUid: '20202020-2020-4020-8020-202020202020', name: 'Illustrator', normalizedName: 'illustrator' }],
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
      ratingLayouts: [
        { syncUid: '72727272-7272-4272-8272-727272727272', syncVersion: 2, subjectKind: 'entry', entryType: 'game' },
        { syncUid: '82828282-8282-4282-8282-828282828282', syncVersion: 1, subjectKind: 'producer', entryType: 'game' },
      ],
      entryRatingValues: [], producerRatingValues: [],
      collections: [{
        id: 60, syncUid: '60606060-6060-4060-8060-606060606060', syncVersion: 1,
        kind: 'producer', title: 'Artists', description: '', nsfw: false, parentId: null, sortOrder: 0,
      }],
      collectionMembers: [{ collectionId: 60, producerId: 9, position: 0 }],
      authorDirectories: [],
      authorDirectorySets: [{
        producerId: 9, syncUid: '92929292-9292-4292-8292-929292929292', syncVersion: 1,
      }],
      authorDirectoryEntries: [], entryUsage: [],
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

async function populatedProducerRatingStore() {
  const snapshot = offlineSnapshot();
  snapshot.payload.ratingSlots.push({
    id: 8,
    syncUid: '81818181-8181-4181-8181-818181818181',
    subjectKind: 'producer',
    entryType: 'game',
    name: 'Craft',
    sortOrder: 0,
  });
  const layout = snapshot.payload.ratingLayouts?.find((row) => row.subjectKind === 'producer' && row.entryType === 'game');
  if (layout !== undefined) layout.syncVersion = 2;
  const outbox = createMemoryOutboxStore();
  const media = createMemoryMediaOutboxStore((operation) => outbox.enqueue(operation));
  const store = { ...createMemorySnapshotStore(), ...outbox, ...media };
  await store.writeGeneration(1, JSON.stringify(snapshot));
  await store.writeMeta(ACTIVE_GENERATION_KEY, '1');
  return store;
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
  afterEach(() => vi.useRealTimers());

  it('keeps new Entry Tag assignment, move and unlink in a single ordered Entry revision chain', async () => {
    const store = await populatedOfflineStore();
    const snapshot = offlineSnapshot();
    snapshot.payload.tagGroups = [
      { id: 2, entryType: 'game', name: 'Genre', groupKind: 'section', parentId: null, sortOrder: 0 },
      { id: 1, entryType: 'game', name: '', groupKind: 'facet', parentId: 2, sortOrder: 0 },
      { id: 3, entryType: 'game', name: 'Theme', groupKind: 'facet', parentId: 2, sortOrder: 1 },
    ];
    await store.writeGeneration(1, JSON.stringify(snapshot));
    snapshot.header.sqliteSchemaVersion = 34; await store.writeGeneration(1, JSON.stringify(snapshot));
    await store.writeMeta('capability.offlineEntryTags', '1');
    await store.writeMeta('capability.offlineEntryTagVocabulary', '1');
    const api = createOfflineAwareGalleryApi({} as GalleryApi, store);
    await api.preferOfflineSnapshot?.();
    const assignment = await api.assignEntryTag(1, { facetId: 1, name: 'Fresh' });
    const newTag = (await api.getEntry(1)).sections.flatMap((section) => section.facets.flatMap((facet) => facet.tags))
      .find((tag) => tag.name === 'Fresh');
    expect(newTag).toBeDefined();
    // The queued write names the tag it recorded, so the caller can show it
    // without re-reading the whole Entry.
    expect(assignment).toEqual({ tagId: newTag!.id, name: 'Fresh', normalizedName: 'fresh', facetId: 1 });
    await api.moveEntryTag(1, newTag!.id, 3);
    await api.removeEntryTag(1, newTag!.id);
    const queued = await store.list();
    expect(queued.map((operation) => operation.operationKind)).toEqual([
      'entry.tag.create', 'entry.tags.set', 'entry.tags.set', 'entry.tags.set',
    ]);
    expect(queued.map((operation) => operation.baseVersion)).toEqual([0, 1, 2, 3]);
    expect((await api.getEntry(1)).sections.flatMap((section) => section.facets.flatMap((facet) => facet.tags.map((tag) => tag.name))))
      .not.toContain('Fresh');
  });

  it('assigns an existing Entry Tag while disconnected and projects the selected Facet from Outbox', async () => {
    const store = await populatedOfflineStore();
    const snapshot = offlineSnapshot();
    snapshot.payload.tagGroups = [
      { id: 2, entryType: 'game', name: 'Genre', groupKind: 'section', parentId: null, sortOrder: 0 },
      { id: 1, entryType: 'game', name: '', groupKind: 'facet', parentId: 2, sortOrder: 0 },
    ];
    snapshot.payload.tags.push({ id: 11, name: 'Action', normalizedName: 'action' });
    await store.writeGeneration(1, JSON.stringify(snapshot));
    await store.writeMeta('capability.offlineEntryTags', '1');
    const online = { assignEntryTag: vi.fn().mockRejectedValue(new Error('Failed to connect')) } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store);
    await api.preferOfflineSnapshot?.();
    await api.assignEntryTag(1, { facetId: 1, name: 'Action' });
    expect(online.assignEntryTag).not.toHaveBeenCalled();
    expect((await store.list()).map((operation) => operation.operationKind)).toEqual(['entry.tags.set']);
    expect((await api.getEntry(1)).sections.flatMap((section) => section.facets.flatMap((facet) => facet.tags.map((tag) => tag.name))))
      .toContain('Action');
  });

  it('resolves an existing Author alias locally and queues the existing Entry relation instead of creating a duplicate', async () => {
    const store = await populatedOfflineStore();
    const snapshot = offlineSnapshot();
    snapshot.payload.taxonomyAliases = [
      { id: 1, vocabulary: 'producer', partition: 'authors', aliasName: 'Cached Alias', normalizedAlias: 'cached alias', canonicalName: 'Offline Author', normalizedCanonical: 'offline author' },
    ];
    await store.writeGeneration(1, JSON.stringify(snapshot));
    await store.writeMeta('capability.offlineEntryAuthors', '1');
    const online = { linkEntryAuthorByName: vi.fn().mockRejectedValue(new Error('Failed to connect')) } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store);
    await api.preferOfflineSnapshot?.();
    await expect(api.linkEntryAuthorByName(1, 'Cached Alias')).resolves.toMatchObject({
      entryId: 1, producerId: 9, producerName: 'Offline Author', created: false, matchedAlias: 'Cached Alias',
    });
    expect(online.linkEntryAuthorByName).not.toHaveBeenCalled();
    expect((await store.list()).length).toBe(0); // Already linked is an idempotent no-op.
  });

  it('orders Entry Tag and new Author relation under the same local Entry revision', async () => {
    const store = await populatedOfflineStore();
    const snapshot = offlineSnapshot();
    snapshot.payload.tagGroups = [
      { id: 2, entryType: 'game', name: 'Genre', groupKind: 'section', parentId: null, sortOrder: 0 },
      { id: 1, entryType: 'game', name: '', groupKind: 'facet', parentId: 2, sortOrder: 0 },
    ];
    await store.writeGeneration(1, JSON.stringify(snapshot));
    snapshot.header.sqliteSchemaVersion = 34; await store.writeGeneration(1, JSON.stringify(snapshot));
    for (const name of ['offlineEntryTags', 'offlineEntryTagVocabulary', 'offlineEntryAuthors', 'offlineAuthorCreate']) {
      await store.writeMeta(`capability.${name}`, '1');
    }
    const api = createOfflineAwareGalleryApi({} as GalleryApi, store);
    await api.preferOfflineSnapshot?.();
    await api.assignEntryTag(1, { facetId: 1, name: 'New Tag' });
    await api.linkEntryAuthorByName(1, 'New Author');
    const operations = await store.list();
    expect(operations.map((row) => [row.operationKind, row.baseVersion])).toEqual([
      ['entry.tag.create', 0], ['entry.tags.set', 1], ['entry.author.create-and-link', 2],
    ]);
    const detail = await api.getEntry(1);
    expect(detail.producers.map((row) => row.name)).toContain('New Author');
    expect(detail.sections.flatMap((section) => section.facets.flatMap((facet) => facet.tags.map((tag) => tag.name))))
      .toContain('New Tag');
  });

  it('carries the author’s rating class through the offline facade instead of dropping it', async () => {
    // The wrapper takes one parameter MORE than the base facade it wraps, and in TypeScript a function
    // with fewer parameters is assignable to a signature with more — so dropping the class typechecked
    // and silently used the base default. Measured on a real library before this: every author
    // dimension created through the app landed in the works summary (0 rows in the author's own class).
    const store = await populatedProducerRatingStore();
    await Promise.all([
      store.writeMeta('capability.offlineRatingSlotLayout', '1'),
      store.writeMeta('capability.offlineProducerRating', '1'),
    ]);
    const ids = ['d0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0', 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1'];

    // Online: the class is part of the call that goes out.
    const onlineApi = {
      createAuthorRatingSlot: vi.fn(async () => ({ id: 11, name: 'Charisma', sortOrder: 0 })),
    } as unknown as GalleryApi;
    const online = createOfflineAwareGalleryApi(onlineApi, store, {
      clientId: 'client-rating-class-online', state: { mode: 'online', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });
    await online.createAuthorRatingSlot(9, 'Charisma', 'author_self');
    expect(onlineApi.createAuthorRatingSlot).toHaveBeenCalledWith(9, 'Charisma', 'author_self');

    // Offline: the class picks the partition, and this snapshot has no layout row for the author's own
    // class yet — so the call is refused rather than quietly written into the works summary's layout.
    const offlineApi = {
      createAuthorRatingSlot: vi.fn(async () => ({ id: 12, name: 'Charisma', sortOrder: 0 })),
    } as unknown as GalleryApi;
    const offline = createOfflineAwareGalleryApi(offlineApi, store, {
      clientId: 'client-rating-class-offline', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });
    await expect(offline.createAuthorRatingSlot(9, 'Charisma', 'author_self'))
      .rejects.toThrow(/Refresh this offline copy/u);
    expect(offlineApi.createAuthorRatingSlot).not.toHaveBeenCalled();
    // Nothing was queued against the works summary's layout either.
    await expect(store.list()).resolves.toEqual([]);
  });

  it('reconciles a newly created Author local ID only after an authoritative replay snapshot includes its link', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryAuthors', '1');
    await store.writeMeta('capability.offlineAuthorCreate', '1');
    const state = { mode: 'offline' as 'online' | 'offline', lastFallbackAt: null, pendingCount: 0, conflictCount: 0, lastReplayError: null as string | null };
    let restored = offlineSnapshot();
    const online = {
      linkEntryAuthorByName: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      replaySyncOperation: vi.fn(async (operation: { opId: string }) => ({
        opId: operation.opId, status: 'applied', entityId: 22, resourceVersion: 2, serverSeq: 2,
      })),
      fetchSyncSnapshot: vi.fn(async () => restored),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, { state, clientId: 'client' });
    const local = await api.linkEntryAuthorByName(1, 'Fresh Artist');
    const pending = await store.list();
    const uid = (pending[0]!.payload as { producerUid: string }).producerUid;
    restored = structuredClone(offlineSnapshot());
    restored.header.snapshotSeq = 2;
    restored.header.changeSeq = 2;
    restored.header.sqliteSchemaVersion = 30;
    restored.header.counts.producers = 2;
    restored.payload.entries[0]!.syncVersion = 2;
    restored.payload.producers.push({ id: 22, syncUid: uid, syncVersion: 1, name: 'Fresh Artist', occupation: null, artworkRef: null, content: null });
    restored.payload.entryProducers.push({ entryId: 1, producerId: 22 });
    await stampChecksum(restored);

    await api.flushOfflineOutbox?.();
    expect(await store.list()).toEqual([]);
    expect(state).toMatchObject({ lastReplaySnapshotSeq: 2, reconciledAuthorIds: { [String(local.producerId)]: 22 } });
    expect((await api.getEntry(1)).producers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 22, name: 'Fresh Artist' })]));
  });

  it('creates and links a genuinely new Author in one durable offline operation, without transport', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryAuthors', '1');
    await store.writeMeta('capability.offlineAuthorCreate', '1');
    const online = { linkEntryAuthorByName: vi.fn().mockRejectedValue(new Error('Failed to connect')) } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store);
    await api.preferOfflineSnapshot?.();
    await expect(api.linkEntryAuthorByName(1, 'New Artist')).resolves.toMatchObject({
      entryId: 1, producerName: 'New Artist', created: true,
    });
    expect(online.linkEntryAuthorByName).not.toHaveBeenCalled();
    expect((await store.list()).map((operation) => operation.operationKind)).toEqual(['entry.author.create-and-link']);
    expect((await api.getEntry(1)).producers.map((producer) => producer.name)).toContain('New Artist');
  });

  it('serves Relation suggestions from the installed snapshot without touching disconnected transport', async () => {
    const store = await populatedOfflineStore();
    const snapshot = offlineSnapshot();
    snapshot.payload.taxonomyAliases = [
      { id: 1, vocabulary: 'producer', partition: 'authors', aliasName: 'Alias', normalizedAlias: 'alias', canonicalName: 'Offline Author', normalizedCanonical: 'offline author' },
    ];
    await store.writeGeneration(1, JSON.stringify(snapshot));
    const online = {
      suggestProducers: vi.fn().mockRejectedValue(new Error('Failed to connect')),
      suggestTags: vi.fn().mockRejectedValue(new Error('Failed to connect')),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store);
    await api.preferOfflineSnapshot?.();
    await expect(api.suggestProducers({ q: 'alias', excludeIds: [] })).resolves.toMatchObject([
      { id: 9, name: 'Offline Author', matchedAlias: 'Alias' },
    ]);
    await expect(api.suggestTags({ vocabulary: 'producer', q: 'ill', excludeIds: [] })).resolves.toMatchObject([
      { id: 20, name: 'Illustrator' },
    ]);
    expect(online.suggestProducers).not.toHaveBeenCalled();
    expect(online.suggestTags).not.toHaveBeenCalled();
  });

  it('starts from an installed local copy without waiting for the native server timeout', async () => {
    const store = await populatedOfflineStore();
    const online = { listGalleries: vi.fn(() => new Promise<never>(() => undefined)) } as unknown as GalleryApi;
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null as string | null,
      connectionPhase: null as 'opening-copy' | 'switching' | 'no-copy' | null,
      lastLocalLoadMs: null as number | null };
    const api = createOfflineAwareGalleryApi(online, store, { state });

    await expect(api.preferOfflineSnapshot?.()).resolves.toBe(true);
    expect(state.mode).toBe('offline');
    expect(state.connectionPhase).toBe('opening-copy');
    await expect(api.listGalleries()).resolves.toEqual([{ type: 'game', entryCount: 1, nsfw: false }]);
    expect(state.connectionPhase).toBeNull();
    expect(state.lastLocalLoadMs).not.toBeNull();
    expect(state.lastLocalLoadMs).toBeGreaterThanOrEqual(0);
    expect(online.listGalleries).not.toHaveBeenCalled();
    expect(await store.readMeta(ACTIVE_GENERATION_KEY)).toBe('1');
  });

  it('keeps the disconnect message visible until the local copy has opened', async () => {
    const store = await populatedOfflineStore();
    const online = { listGalleries: vi.fn() } as unknown as GalleryApi;
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null as string | null,
      connectionPhase: null as 'opening-copy' | 'switching' | 'no-copy' | null };
    const api = createOfflineAwareGalleryApi(online, store, { state });

    await expect(api.preferOfflineSnapshot?.('disconnect')).resolves.toBe(true);
    expect(state.connectionPhase).toBe('switching');
    await expect(api.listGalleries()).resolves.toHaveLength(1);
    expect(state.connectionPhase).toBeNull();
    expect(online.listGalleries).not.toHaveBeenCalled();
  });

  it('keeps the local copy sticky across failed probes and returns online only after a successful probe', async () => {
    const offline = new Error('Failed to connect to /192.168.1.10:8765');
    const online = {
      getSyncCapabilities: vi.fn().mockRejectedValueOnce(offline).mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'test',
        featureFlags: { offlineEntryContents: true },
      }),
      listGalleries: vi.fn().mockResolvedValue([{ type: 'remote', entryCount: 2, nsfw: false }]),
    } as unknown as GalleryApi;
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null as string | null };
    const store = await populatedStore();
    const api = createOfflineAwareGalleryApi(online, store, { state });

    await api.preferOfflineSnapshot?.();
    await expect(api.getSyncCapabilities()).rejects.toBe(offline);
    expect((await api.listGalleries())[0]?.type).toBe('game');
    expect(state.mode).toBe('offline');
    expect(online.listGalleries).not.toHaveBeenCalled();
    await api.getSyncCapabilities();
    expect(state.mode).toBe('online');
    expect((await api.listGalleries())[0]?.type).toBe('remote');
    expect(await store.readMeta('capability.offlineEntryContents')).toBe('1');
  });

  it('finishes a lightweight reachability probe before starting a potentially long replay', async () => {
    const store = await populatedOfflineStore();
    const operation = createPendingSyncOperation({
      clientId: '11111111-1111-4111-8111-111111111111',
      libraryId: 'library-1', syncEpoch: 'epoch-1', entityKind: 'entry',
      entityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operationKind: 'entry.update', baseVersion: 1,
      baseValues: { title: 'Offline Entry' }, payload: { title: 'Local' },
    });
    await store.enqueue(operation);
    const replaySyncOperation = vi.fn(async () => ({
      opId: operation.opId, status: 'conflict' as const, currentVersion: 2,
    }));
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'test', featureFlags: {},
      }), replaySyncOperation,
    } as unknown as GalleryApi;
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null as string | null };
    const api = createOfflineAwareGalleryApi(online, store, { state });

    await api.preferOfflineSnapshot?.();
    await api.getSyncCapabilities({ replay: false });
    expect(state.mode).toBe('online');
    expect(replaySyncOperation).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
    await api.replayOfflineOperations?.();
    expect(replaySyncOperation).toHaveBeenCalledOnce();
    expect((await store.list())[0]?.status).toBe('conflict');
  });

  it('bounds stalled online reads and shows a transition while the local copy opens', async () => {
    vi.useFakeTimers();
    const store = await populatedStore();
    const originalRead = store.captureSnapshot!;
    let allowRead: (() => void) | undefined;
    store.captureSnapshot = vi.fn(async () => {
      await new Promise<void>((resolve) => { allowRead = resolve; });
      return originalRead();
    });
    const online = { listGalleries: vi.fn(() => new Promise<never>(() => undefined)) } as unknown as GalleryApi;
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null as string | null,
      connectionPhase: null as 'opening-copy' | 'switching' | 'no-copy' | null };
    const api = createOfflineAwareGalleryApi(online, store, { state, onlineReadTimeoutMs: 2_500 });

    const pending = api.listGalleries();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(state.connectionPhase).toBe('switching');
    expect(allowRead).toBeTypeOf('function');
    allowRead?.();
    await expect(pending).resolves.toEqual([{ type: 'game', entryCount: 1, nsfw: false }]);
    expect(state.mode).toBe('offline');
    expect(state.connectionPhase).toBeNull();
  });

  it('shares one snapshot parse across simultaneous offline home reads', async () => {
    const store = await populatedStore();
    const captureSnapshot = vi.spyOn(store, 'captureSnapshot');
    const online = { listGalleries: vi.fn(() => new Promise<never>(() => undefined)) } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store);
    await api.preferOfflineSnapshot?.();
    await Promise.all([api.listGalleries(), api.listGalleries(), api.listGalleries()]);
    expect(captureSnapshot).toHaveBeenCalledTimes(1);
  });

  it('reports a disconnected server without presenting an empty library when no copy exists', async () => {
    vi.useFakeTimers();
    const online = { listGalleries: vi.fn(() => new Promise<never>(() => undefined)) } as unknown as GalleryApi;
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null as string | null,
      connectionPhase: null as 'opening-copy' | 'switching' | 'no-copy' | null };
    const api = createOfflineAwareGalleryApi(online, createMemorySnapshotStore(), {
      state, onlineReadTimeoutMs: 2_000,
    });
    const pending = api.listGalleries();
    const rejection = expect(pending).rejects.toThrow('did not respond in time');
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    expect(state.connectionPhase).toBe('no-copy');
    expect(state.mode).toBe('online');
  });

  it('never times out a possibly committed online write into the Outbox', async () => {
    vi.useFakeTimers();
    const store = await populatedOfflineStore();
    let finish!: (value: { id: number; title: string }) => void;
    const online = { updateEntry: vi.fn(() => new Promise((resolve) => { finish = resolve; })) } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, { onlineReadTimeoutMs: 2_000 });
    const pending = api.updateEntry(1, { title: 'Remote value' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await store.list()).toHaveLength(0);
    finish({ id: 1, title: 'Remote value' });
    await pending;
    expect(await store.list()).toHaveLength(0);
  });
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
          offlineEntryInitialContents: true,
          offlineMediaUpload: true,
          offlineUsageEvents: true,
          offlineEntryViewLater: true,
          offlineEntryRating: true,
          offlineEntryAuthors: true,
          offlineAuthorCreate: true,
          offlineEntryTags: true,
          offlineEntryContents: true,
          offlineMutations: true,
          offlineCollectionManagement: true,
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
    expect(await store.readMeta('capability.offlineEntryInitialContents')).toBe('1');
    expect(await store.readMeta('capability.offlineUsageEvents')).toBe('1');
    expect(await store.readMeta('capability.offlineEntryViewLater')).toBe('1');
    expect(await store.readMeta('capability.offlineEntryRating')).toBe('1');
    expect(await store.readMeta('capability.offlineEntryAuthors')).toBe('1');
    expect(await store.readMeta('capability.offlineAuthorCreate')).toBe('1');
    expect(await store.readMeta('capability.offlineEntryTags')).toBe('1');
    expect(await store.readMeta('capability.offlineEntryContents')).toBe('1');
    expect(await store.readMeta('capability.offlineCollectionManagement')).toBe('1');
    expect(state.lastCapabilityProbe).toMatchObject({
      status: 'success', serverBuild: 'c2-test', offlineUsageEvents: true,
      offlineEntryViewLater: true, offlineEntryRating: true, offlineEntryAuthors: true, offlineAuthorCreate: true, offlineEntryTags: true,
      offlineEntryContents: true, offlineCollectionManagement: true,
    });
    expect(state.lastSuccessfulCapabilityProbe).toMatchObject({
      serverBuild: 'c2-test', offlineUsageEvents: true, offlineEntryViewLater: true,
      offlineEntryRating: true, offlineEntryAuthors: true, offlineAuthorCreate: true, offlineEntryTags: true, offlineEntryContents: true,
      offlineCollectionManagement: true,
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

  it('does not enable Collection writes when the global offline mutation switch is disabled', async () => {
    const store = await populatedOfflineStore();
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', sqliteSchemaVersion: 29,
        snapshotFormatVersion: 2, syncProtocolVersion: 1, serverBuild: 'disabled',
        featureFlags: { offlineMutations: false, offlineCollectionManagement: true },
      }),
      createCollection: vi.fn(),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store);
    await api.getSyncCapabilities({ replay: false });
    api.preferOfflineSnapshot?.();
    expect(await store.readMeta('capability.offlineCollectionManagement')).toBe('0');
    await expect(api.createCollection({ kind: 'entry', title: 'Must not queue' }))
      .rejects.toThrow('offline Collection management');
    expect(await store.list()).toEqual([]);
    expect(online.createCollection).not.toHaveBeenCalled();
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

  it('queues Producer View later add/remove only after the capability probe and preserves causal identity', async () => {
    const store = await populatedOfflineStore();
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'producer-test',
        featureFlags: { offlineProducerViewLater: true, offlineProducerRating: true },
      }),
      addViewLaterAuthor: vi.fn(),
      removeViewLaterAuthor: vi.fn(),
    } as unknown as GalleryApi;
    const state = { mode: 'offline' as const, lastFallbackAt: null as string | null,
      lastCapabilityProbe: null, lastSuccessfulCapabilityProbe: null };
    const ids = [
      '91919191-9191-4191-8191-919191919191',
      '92929292-9292-4292-8292-929292929292',
    ];
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-producer', state, randomUUID: () => ids.shift()!,
    });

    await expect(api.addViewLaterAuthor(9)).rejects.toThrow(/not enabled/u);
    await api.getSyncCapabilities({ replay: false });
    expect(await store.readMeta('capability.offlineProducerViewLater')).toBe('1');
    expect(await store.readMeta('capability.offlineProducerRating')).toBe('1');
    expect(state.lastCapabilityProbe).toMatchObject({
      status: 'success', offlineProducerViewLater: true, offlineProducerRating: true,
    });
    expect(state.lastSuccessfulCapabilityProbe).toMatchObject({
      offlineProducerViewLater: true, offlineProducerRating: true,
    });
    // A successful capability probe returns the client to online mode; explicitly
    // reopen the cached copy so these calls exercise the offline mutation path.
    await expect(api.preferOfflineSnapshot?.()).resolves.toBe(true);

    await expect(api.addViewLaterAuthor(9)).resolves.toMatchObject({ producerIds: [9] });
    await expect(api.getViewLaterState()).resolves.toMatchObject({ producerIds: [9] });
    await expect(api.removeViewLaterAuthor(9)).resolves.toMatchObject({ producerIds: [] });
    expect(online.addViewLaterAuthor).not.toHaveBeenCalled();
    expect(online.removeViewLaterAuthor).not.toHaveBeenCalled();
    const [addOperation, removeOperation] = await store.list();
    expect(addOperation).toMatchObject({
      opId: '91919191-9191-4191-8191-919191919191',
      clientId: 'client-producer', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'producer', entityUid: '99999999-9999-4999-8999-999999999999',
      operationKind: 'producer.view-later.set', baseVersion: 1,
      baseValues: { present: false }, payload: { present: true },
    });
    expect(addOperation).toBeDefined();
    expect(removeOperation).toMatchObject({
      opId: '92929292-9292-4292-8292-929292929292',
      entityKind: 'producer', entityUid: '99999999-9999-4999-8999-999999999999',
      operationKind: 'producer.view-later.set', baseVersion: 2,
      baseValues: { present: true }, payload: { present: false },
    });
    expect(operationFingerprint(addOperation!)).not.toBe(operationFingerprint(removeOperation!));
    await expect(api.getViewLaterState()).resolves.toMatchObject({ producerIds: [] });
  });

  it('queues Author rating changes and shares Producer revision ordering with View later', async () => {
    const store = await populatedProducerRatingStore();
    await store.writeMeta('capability.offlineProducerRating', '1');
    await store.writeMeta('capability.offlineProducerViewLater', '1');
    const ids = [
      'a4a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4',
      'a5a5a5a5-a5a5-45a5-85a5-a5a5a5a5a5a5',
      'a6a6a6a6-a6a6-46a6-86a6-a6a6a6a6a6a6',
    ];
    const online = { setAuthorRating: vi.fn(), addViewLaterAuthor: vi.fn() } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-producer', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });

    await expect(api.setAuthorRating(9, 8, 4.5)).resolves.toEqual({
      slotId: 8, name: 'Craft', stars: 4.5,
    });
    await api.addViewLaterAuthor(9);
    await expect(api.setAuthorRating(9, 8, null)).resolves.toEqual({
      slotId: 8, name: 'Craft', stars: null,
    });

    expect(online.setAuthorRating).not.toHaveBeenCalled();
    expect(online.addViewLaterAuthor).not.toHaveBeenCalled();
    expect((await store.list()).map((operation) => ({
      kind: operation.operationKind,
      baseVersion: operation.baseVersion,
      baseValues: operation.baseValues,
      payload: operation.payload,
    }))).toEqual([
      {
        kind: 'producer.rating.set', baseVersion: 1,
        baseValues: { slotUid: '81818181-8181-4181-8181-818181818181', stars: null },
        payload: { slotUid: '81818181-8181-4181-8181-818181818181', stars: 4.5 },
      },
      {
        kind: 'producer.view-later.set', baseVersion: 2,
        baseValues: { present: false }, payload: { present: true },
      },
      {
        kind: 'producer.rating.set', baseVersion: 3,
        baseValues: { slotUid: '81818181-8181-4181-8181-818181818181', stars: 4.5 },
        payload: { slotUid: '81818181-8181-4181-8181-818181818181', stars: null },
      },
    ]);
    await expect(api.getAuthor(9)).resolves.toMatchObject({
      ratings: [{ slotId: 8, name: 'Craft', stars: null }],
    });
  });

  it('supports Entry-owned rating-slot creation, ordering, and ratings in one shared layout chain', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineRatingSlotLayout', '1');
    await store.writeMeta('capability.offlineEntryRating', '1');
    await store.writeMeta('capability.offlineEntryCreate', '1');
    const ids = [
      'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0', 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1',
      'e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2', 'e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3',
      'e4e4e4e4-e4e4-44e4-84e4-e4e4e4e4e4e4', 'e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5',
    ];
    const online = {
      createEntryRatingSlot: vi.fn(), reorderEntryRatingSlots: vi.fn(), setEntryRating: vi.fn(),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-entry-rating-layout', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });
    const created = await api.createEntryRatingSlot(1, 'Technique');
    expect(created).toMatchObject({ id: 8, name: 'Technique', sortOrder: 1 });
    await api.reorderEntryRatingSlots(1, [8, 7]);
    await api.setEntryRating(1, 8, 4.5);
    await api.enqueueOfflineEntryCreate?.({
      title: 'Uses new layout', type: 'game', uploadDate: null, pageCount: null,
      ratings: [{ slotId: 8, stars: 4.5 }], viewLater: false, coverFile: null, previewFile: null,
    });

    expect(await store.list()).toMatchObject([
      {
        operationKind: 'rating-layout.slots.set', entityKind: 'rating_layout', baseVersion: 2,
        baseValues: { slots: [{ syncUid: '71717171-7171-4171-8171-717171717171', name: 'Quality', sortOrder: 0 }] },
        payload: { slots: [
          { syncUid: '71717171-7171-4171-8171-717171717171', name: 'Quality', sortOrder: 0 },
          { syncUid: 'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0', name: 'Technique', sortOrder: 1 },
        ] },
      },
      { operationKind: 'rating-layout.slots.set', entityKind: 'rating_layout', baseVersion: 3 },
      {
        operationKind: 'entry.rating.set', entityKind: 'entry', baseVersion: 1,
        baseValues: { slotUid: 'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0', stars: null },
        payload: { slotUid: 'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0', stars: 4.5 },
      },
      {
        operationKind: 'entry.create',
        payload: { ratings: [{ slotUid: 'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0', stars: 4.5 }] },
      },
    ]);
    await expect(api.getEntry(1)).resolves.toMatchObject({
      ratings: [{ slotId: 8, name: 'Technique', stars: 4.5 }, { slotId: 7, name: 'Quality', stars: null }],
    });
    expect(online.createEntryRatingSlot).not.toHaveBeenCalled();
    expect(online.reorderEntryRatingSlots).not.toHaveBeenCalled();
    expect(online.setEntryRating).not.toHaveBeenCalled();
  });

  it('queues an uncertain online create command with its exact identity and staged media', async () => {
    const store = await populatedOfflineStore();
    await Promise.all([
      store.writeMeta('capability.offlineEntryCreate', '1'),
      store.writeMeta('capability.offlineEntryInitialContents', '1'),
      store.writeMeta('capability.offlineMediaUpload', '1'),
    ]);
    const online = { createEntry: vi.fn() } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-command-fallback', state: { mode: 'online', lastFallbackAt: null },
    });
    const preset = {
      opId: '9c9c9c9c-9c9c-49c9-89c9-9c9c9c9c9c9c',
      clientId: 'browser-client-1', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'entry', entityUid: 'dededede-dede-4ede-8ede-dededededede',
      operationKind: 'entry.create', baseVersion: 0, baseValues: {},
      clientCreatedAt: '2026-10-06T02:00:00.000Z',
      payload: {
        title: 'Commanded offline', type: 'game', uploadDate: null, pageCount: null,
        ratings: [{ slotId: 7, stars: 4 }], viewLater: true,
        contents: [{ syncUid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', contentType: 'Source URL', content: 'https://example.test/x', sortOrder: 0 }],
      },
    } as unknown as SyncReplayOperation;
    const cover = new NodeFile([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' }) as unknown as File;
    await api.enqueueOfflineEntryCreate?.({
      title: 'Commanded offline', type: 'game', uploadDate: null, pageCount: null,
      ratings: [{ slotId: 7, stars: 4 }], viewLater: true,
      coverFile: cover, previewFile: null, previewFiles: [cover],
      presetCreateOperation: preset,
    }, new TypeError('response lost'));
    // The outbox must carry the attempt verbatim: opId and clientCreatedAt are
    // part of the server's request hash, and a reworded copy would collide
    // with the receipt instead of resolving the uncertainty.
    expect(await store.list()).toEqual([expect.objectContaining({
      opId: preset.opId,
      clientId: 'browser-client-1',
      libraryId: 'library-1',
      syncEpoch: 'epoch-1',
      entityUid: preset.entityUid,
      clientCreatedAt: '2026-10-06T02:00:00.000Z',
      operationKind: 'entry.create',
      payload: preset.payload,
    })]);
    expect(await store.listMedia()).toMatchObject([
      { uploadId: expect.any(String), entryUid: preset.entityUid, kind: 'cover', ordinal: 0, status: 'pending' },
      { uploadId: expect.any(String), entryUid: preset.entityUid, kind: 'preview', ordinal: 0, status: 'pending' },
    ]);
    expect(online.createEntry).not.toHaveBeenCalled();
  });

  // The user's own finding: an Entry created offline did not appear in the
  // offline copy at all, and its picture was missing from the row. This pins
  // the whole promise — the row exists, and it carries the picture the person
  // just chose, straight from the staged bytes.
  it('shows an offline-created Entry with its staged cover before anything syncs', async () => {
    const store = await populatedOfflineStore();
    await Promise.all([
      store.writeMeta('capability.offlineEntryCreate', '1'),
      store.writeMeta('capability.offlineMediaUpload', '1'),
    ]);
    const api = createOfflineAwareGalleryApi({ assetUrl: (path: string) => `/assets/${path}` } as unknown as GalleryApi, store, {
      clientId: 'client-staged-cover', state: { mode: 'offline', lastFallbackAt: null },
    });
    const cover = new NodeFile([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' }) as unknown as File;
    await api.enqueueOfflineEntryCreate?.({
      title: 'Staged cover', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: false, coverFile: cover, previewFile: null, previewFiles: [],
    }, new TypeError('Failed to fetch'));

    const created: string[] = [];
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      void blob;
      created.push(`blob:staged-${created.length}`);
      return created[created.length - 1]!;
    }) as unknown as typeof URL.createObjectURL;
    try {
      const page = await api.queryEntryPage({
        entryType: 'game', conditions: [], authorIds: [], ratingConditions: [], ratingSort: null,
        usageConditions: [], usageSort: null, sort: 'date-desc', page: 1, pageSize: 30,
      });
      const row = page.items.find((item) => item.title === 'Staged cover');
      expect(row).toBeDefined();
      expect(row?.coverRef).toBe(`blob:staged-0#t3-upload=${(await store.listMedia())[0]!.uploadId}`);
      expect(created).toHaveLength(1);
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
    }
  });

  // Measured on the device: one cover the server refused with a 500 left the
  // whole queue at 8 pending — nothing failed, nothing else was even attempted,
  // because the rethrow aborted the replay. The media list is ordered by Entry
  // UID, so the refused upload sat in front of the good ones forever.
  it('marks a server-refused upload failed and still drains the rest of the queue', async () => {
    const store = await populatedOfflineStore();
    await Promise.all([
      store.writeMeta('capability.offlineEntryCreate', '1'),
      store.writeMeta('capability.offlineMediaUpload', '1'),
    ]);
    const refusedUid = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
    const acceptedUid = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
    const refreshed = structuredClone(offlineSnapshot());
    refreshed.header.snapshotSeq = 2;
    refreshed.header.changeSeq = 9;
    refreshed.header.counts.entries = 3;
    refreshed.payload.entries.push(
      { ...refreshed.payload.entries[0]!, id: 2, syncUid: refusedUid, syncVersion: 2, title: 'Refused cover', coverRef: null, previewRef: null, previewRefs: [] },
      { ...refreshed.payload.entries[0]!, id: 3, syncUid: acceptedUid, syncVersion: 2, title: 'Accepted cover', coverRef: '/api/assets/entries/3/cover.png', previewRef: null, previewRefs: [] },
    );
    await stampChecksum(refreshed);
    const uploadSyncMedia = vi.fn().mockImplementation(async (uploadId, metadata) => {
      if (metadata.entryUid === refusedUid) throw new ApiError(500, { error: { message: 'Internal server error' } });
      return {
        uploadId, status: 'applied', entityId: 3,
        relativeRef: `/api/assets/entries/3/${metadata.kind}.png`, resourceVersion: 2, serverSeq: 3,
      };
    });
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', sqliteSchemaVersion: 32,
        snapshotFormatVersion: 2, syncProtocolVersion: 1, serverBuild: 'test',
        featureFlags: { offlineMutations: true, offlineEntryCreate: true, offlineMediaUpload: true },
      }),
      replaySyncOperation: vi.fn(async (operation) => ({
        opId: operation.opId, status: 'applied',
        entityId: operation.entityUid === refusedUid ? 2 : 3, resourceVersion: 1, serverSeq: 2,
      })),
      uploadSyncMedia,
      fetchSyncSnapshot: vi.fn().mockResolvedValue(refreshed),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, { clientId: 'test-refused-media' });
    await api.getSyncCapabilities();
    const cover = new NodeFile([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' }) as unknown as File;
    const preset = (opId: string, uid: string, title: string) => ({
      opId, clientId: 'test-refused-media', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'entry', entityUid: uid, operationKind: 'entry.create', baseVersion: 0, baseValues: {},
      clientCreatedAt: new Date().toISOString(),
      payload: { title, type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false },
    }) as unknown as SyncReplayOperation;
    await api.enqueueOfflineEntryCreate?.({
      title: 'Refused cover', type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false,
      coverFile: cover, previewFile: null, previewFiles: [], presetCreateOperation: preset('e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1', refusedUid, 'Refused cover'),
    }, new TypeError('response lost'));
    await api.enqueueOfflineEntryCreate?.({
      title: 'Accepted cover', type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false,
      coverFile: cover, previewFile: null, previewFiles: [], presetCreateOperation: preset('e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2', acceptedUid, 'Accepted cover'),
    }, new TypeError('response lost'));
    await api.flushOfflineOutbox?.();

    const remaining = await store.listMedia();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ kind: 'cover', entryUid: refusedUid, status: 'failed' });
    expect(remaining[0]?.lastError).toContain('500');
    // The accepted cover went through, and both creates were acknowledged.
    expect(uploadSyncMedia.mock.calls.map((call) => call[1].entryUid)).toEqual([refusedUid, acceptedUid]);
    expect(await store.list()).toEqual([]);
  });

  it('refuses an offline create command whose identity belongs to another library revision', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    const api = createOfflineAwareGalleryApi({} as unknown as GalleryApi, store, {
      clientId: 'client-command-fallback', state: { mode: 'online', lastFallbackAt: null },
    });
    const preset = {
      opId: '9c9c9c9c-9c9c-49c9-89c9-9c9c9c9c9c9c',
      clientId: 'browser-client-1', libraryId: 'library-1', syncEpoch: 'epoch-2',
      entityKind: 'entry', entityUid: 'dededede-dede-4ede-8ede-dededededede',
      operationKind: 'entry.create', baseVersion: 0, baseValues: {},
      clientCreatedAt: '2026-10-06T02:00:00.000Z',
      payload: {
        title: 'Stale epoch', type: 'game', uploadDate: null, pageCount: null,
        ratings: [], viewLater: false,
      },
    } as unknown as SyncReplayOperation;
    await expect(api.enqueueOfflineEntryCreate?.({
      title: 'Stale epoch', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: false, coverFile: null, previewFile: null,
      presetCreateOperation: preset,
    }, new TypeError('response lost'))).rejects.toThrow('different library revision');
    expect(await store.list()).toEqual([]);
  });

  it('queues the full Producer-owned Author edit set in one stable revision chain', async () => {
    const store = await populatedProducerRatingStore();
    await Promise.all([
      store.writeMeta('capability.offlineProducerProfile', '1'),
      store.writeMeta('capability.offlineProducerTags', '1'),
      store.writeMeta('capability.offlineProducerRating', '1'),
      store.writeMeta('capability.offlineProducerViewLater', '1'),
    ]);
    const ids = [
      'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
      'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1',
      'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2',
      'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1',
      'c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2',
    ];
    const online = {
      updateAuthor: vi.fn(), assignAuthorTag: vi.fn(), setAuthorRating: vi.fn(), addViewLaterAuthor: vi.fn(),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-author-data', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });

    await api.updateAuthor(9, {
      name: 'Offline Author', occupation: 'Writer',
      artworkRef: '/api/assets/producers/9/artwork.webp', content: 'Saved bio',
    });
    await api.assignAuthorTag(9, ' New   Tag ');
    await api.setAuthorRating(9, 8, 4.5);
    await api.addViewLaterAuthor(9);

    expect(online.updateAuthor).not.toHaveBeenCalled();
    expect(online.assignAuthorTag).not.toHaveBeenCalled();
    expect(online.setAuthorRating).not.toHaveBeenCalled();
    expect(online.addViewLaterAuthor).not.toHaveBeenCalled();
    expect((await store.list()).map((operation) => ({
      opId: operation.opId,
      operationKind: operation.operationKind,
      baseVersion: operation.baseVersion,
      baseValues: operation.baseValues,
      payload: operation.payload,
    }))).toEqual([
      {
        opId: 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', operationKind: 'producer.update', baseVersion: 1,
        baseValues: { occupation: 'Artist' }, payload: { occupation: 'Writer' },
      },
      {
        opId: 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2', operationKind: 'producer.tags.set', baseVersion: 2,
        baseValues: { tags: [{ syncUid: '20202020-2020-4020-8020-202020202020', name: 'Illustrator' }] },
        payload: { tags: [
          { syncUid: '20202020-2020-4020-8020-202020202020', name: 'Illustrator' },
          { syncUid: 'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1', name: 'New Tag' },
        ] },
      },
      {
        opId: 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1', operationKind: 'producer.rating.set', baseVersion: 3,
        baseValues: { slotUid: '81818181-8181-4181-8181-818181818181', stars: null },
        payload: { slotUid: '81818181-8181-4181-8181-818181818181', stars: 4.5 },
      },
      {
        opId: 'c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2', operationKind: 'producer.view-later.set', baseVersion: 4,
        baseValues: { present: false }, payload: { present: true },
      },
    ]);
    await expect(api.getAuthor(9)).resolves.toMatchObject({
      occupation: 'Writer', tags: expect.arrayContaining([expect.objectContaining({ name: 'New Tag' })]),
      ratings: [{ slotId: 8, name: 'Craft', stars: 4.5 }],
    });
  });

  it('queues Entry-Author link edits offline with ordered Entry revisions and optimistic projection', async () => {
    const store = await populatedOfflineStore();
    const active = await readActiveSnapshot(store);
    if (active === null) throw new Error('fixture snapshot missing');
    active.snapshot.payload.producers.push({
      id: 10, syncUid: '10101010-1010-4010-8010-101010101010', syncVersion: 1,
      name: 'Second Author', occupation: null, artworkRef: null, content: null,
    });
    active.snapshot.header.counts.producers = 2;
    await store.writeGeneration(1, JSON.stringify(active.snapshot));
    await store.writeMeta('capability.offlineEntryAuthors', '1');
    const opIds = [
      'a0010000-0000-4000-8000-000000000001',
      'a0010000-0000-4000-8000-000000000002',
      'a0010000-0000-4000-8000-000000000003',
    ];
    const online = {
      linkEntryAuthor: vi.fn(), unlinkEntryAuthor: vi.fn(), updateEntry: vi.fn(),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-entry-authors', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => opIds.shift()!,
    });

    await api.linkEntryAuthor(1, 10);
    await api.updateEntry(1, { title: 'Edited while offline' });
    await api.unlinkEntryAuthor(1, 9);

    const operations = await store.list();
    expect(operations.map(({ operationKind, baseVersion }) => [operationKind, baseVersion])).toEqual([
      ['entry.authors.set', 1], ['entry.update', 2], ['entry.authors.set', 3],
    ]);
    expect(operations[0]).toMatchObject({
      baseValues: { producerUids: ['99999999-9999-4999-8999-999999999999'] },
      payload: { producerUids: ['10101010-1010-4010-8010-101010101010', '99999999-9999-4999-8999-999999999999'] },
    });
    expect(operations[2]).toMatchObject({
      baseValues: { producerUids: ['10101010-1010-4010-8010-101010101010', '99999999-9999-4999-8999-999999999999'] },
      payload: { producerUids: ['10101010-1010-4010-8010-101010101010'] },
    });
    expect(online.linkEntryAuthor).not.toHaveBeenCalled();
    expect(online.unlinkEntryAuthor).not.toHaveBeenCalled();
    expect(online.updateEntry).not.toHaveBeenCalled();
    await expect(api.getEntry(1)).resolves.toMatchObject({
      id: 1,
      title: 'Edited while offline',
      producers: [expect.objectContaining({ id: 10, name: 'Second Author' })],
    });
  });

  it('refuses Entry-Author editing when any currently linked Author lacks a stable snapshot UID', async () => {
    const store = await populatedOfflineStore();
    const active = await readActiveSnapshot(store);
    if (active === null) throw new Error('fixture snapshot missing');
    delete (active.snapshot.payload.producers[0] as { syncUid?: string }).syncUid;
    active.snapshot.payload.producers.push({
      id: 10, syncUid: '10101010-1010-4010-8010-101010101010', syncVersion: 1,
      name: 'Second Author', occupation: null, artworkRef: null, content: null,
    });
    active.snapshot.header.counts.producers = 2;
    await store.writeGeneration(1, JSON.stringify(active.snapshot));
    await store.writeMeta('capability.offlineEntryAuthors', '1');
    const api = createOfflineAwareGalleryApi({} as GalleryApi, store, {
      clientId: 'client-entry-authors-old-snapshot', state: { mode: 'offline', lastFallbackAt: null },
    });

    await expect(api.linkEntryAuthor(1, 10)).rejects.toThrow(/linked Author is missing its stable identity/u);
    expect(await store.list()).toEqual([]);
  });

  it('queues an Entry-Author link after a classified transport failure against a capable server', async () => {
    const store = await populatedOfflineStore();
    const active = await readActiveSnapshot(store);
    expect(active).not.toBeNull();
    active!.snapshot.payload.producers.push({
      id: 10, syncUid: '10101010-1010-4010-8010-101010101010', syncVersion: 1,
      name: 'Second Author', occupation: null, artworkRef: null, content: null,
    });
    active!.snapshot.header.counts.producers = active!.snapshot.payload.producers.length;
    await store.writeGeneration(1, JSON.stringify(active!.snapshot));
    await store.writeMeta('capability.offlineEntryAuthors', '1');
    const disconnected = new Error('Failed to connect to /192.168.50.155:8765');
    const link = vi.fn().mockRejectedValue(disconnected);
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null as string | null };
    const api = createOfflineAwareGalleryApi({
      linkEntryAuthor: link,
    } as unknown as GalleryApi, store, {
      clientId: 'client-entry-authors-fallback', state,
      randomUUID: () => 'a0010000-0000-4000-8000-000000000011',
    });

    await api.linkEntryAuthor(1, 10);
    expect(state.mode).toBe('offline');
    expect(link).toHaveBeenCalledOnce();
    expect(await store.list()).toMatchObject([{
      operationKind: 'entry.authors.set', entityKind: 'entry', status: 'pending',
    }]);
  });

  it('does not send queued Entry-Author edits to a server that omits the capability', async () => {
    const store = await populatedOfflineStore();
    const operation = createPendingSyncOperation({
      clientId: 'client-entry-authors-legacy', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'entry', entityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operationKind: 'entry.authors.set', baseVersion: 1,
      baseValues: { producerUids: ['99999999-9999-4999-8999-999999999999'] },
      payload: { producerUids: ['10101010-1010-4010-8010-101010101010', '99999999-9999-4999-8999-999999999999'] },
    }, { randomUUID: () => 'a0010000-0000-4000-8000-000000000021' });
    await store.enqueue(operation);
    await store.writeMeta('capability.offlineEntryAuthors', '1');
    const replay = vi.fn();
    const api = createOfflineAwareGalleryApi({
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', sqliteSchemaVersion: 29,
        snapshotFormatVersion: 2, syncProtocolVersion: 1, serverBuild: 'legacy',
        featureFlags: { offlineMutations: true },
      }),
      replaySyncOperation: replay,
    } as unknown as GalleryApi, store, {
      clientId: 'client-entry-authors-legacy', state: { mode: 'offline', lastFallbackAt: null },
    });

    await api.getSyncCapabilities({ replay: false });
    await api.replayOfflineOperations?.();
    expect(replay).not.toHaveBeenCalled();
    expect(await store.list()).toMatchObject([{ opId: operation.opId, status: 'pending' }]);
  });

  it('queues and projects rating layouts, Collection membership, and Directory/Entry membership offline', async () => {
    const store = await populatedProducerRatingStore();
    await Promise.all([
      store.writeMeta('capability.offlineRatingSlotLayout', '1'),
      store.writeMeta('capability.offlineCollectionProducerMembership', '1'),
      store.writeMeta('capability.offlineAuthorDirectories', '1'),
      store.writeMeta('capability.offlineProducerRating', '1'),
    ]);
    const ids = [
      'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0', 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
      'a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2', 'a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3',
      'a4a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4', 'a5a5a5a5-a5a5-45a5-85a5-a5a5a5a5a5a5',
      'a6a6a6a6-a6a6-46a6-86a6-a6a6a6a6a6a6', 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7',
      'a8a8a8a8-a8a8-48a8-88a8-a8a8a8a8a8a8', 'a9a9a9a9-a9a9-49a9-89a9-a9a9a9a9a9a9',
      'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0', 'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1',
      'c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0',
    ];
    const online = {
      createAuthorRatingSlot: vi.fn(), reorderAuthorRatingSlots: vi.fn(), setAuthorRating: vi.fn(),
      addCollectionProducer: vi.fn(), removeCollectionProducer: vi.fn(),
      createAuthorDirectory: vi.fn(), updateAuthorDirectory: vi.fn(),
      moveEntryToAuthorDirectory: vi.fn(), removeEntryFromAuthorDirectory: vi.fn(),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-author-resources', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });

    const createdSlot = await api.createAuthorRatingSlot(9, 'Mood');
    expect(createdSlot).toMatchObject({ id: 9, name: 'Mood', sortOrder: 1 });
    await api.reorderAuthorRatingSlots(9, [9, 8]);
    await api.setAuthorRating(9, 9, 4.5);
    await api.removeCollectionProducer(60, 9);
    await api.addCollectionProducer(60, 9);
    const firstDirectory = await api.createAuthorDirectory(9, { title: 'First', entryIds: [1] });
    expect(firstDirectory).toMatchObject({ id: -1, title: 'First', entryCount: 1 });
    await api.updateAuthorDirectory(firstDirectory.id, { title: 'Renamed first' });
    const secondDirectory = await api.createAuthorDirectory(9, { title: 'Second' });
    expect(secondDirectory.id).toBe(-2);
    await api.moveEntryToAuthorDirectory(9, secondDirectory.id, 1);
    await api.removeEntryFromAuthorDirectory(9, secondDirectory.id, 1);

    expect(online.createAuthorRatingSlot).not.toHaveBeenCalled();
    expect(online.reorderAuthorRatingSlots).not.toHaveBeenCalled();
    expect(online.setAuthorRating).not.toHaveBeenCalled();
    expect(online.addCollectionProducer).not.toHaveBeenCalled();
    expect(online.removeCollectionProducer).not.toHaveBeenCalled();
    expect(online.createAuthorDirectory).not.toHaveBeenCalled();
    expect(online.updateAuthorDirectory).not.toHaveBeenCalled();
    expect(online.moveEntryToAuthorDirectory).not.toHaveBeenCalled();
    expect(online.removeEntryFromAuthorDirectory).not.toHaveBeenCalled();

    const operations = await store.list();
    expect(operations.map((operation) => [operation.operationKind, operation.baseVersion])).toEqual([
      ['rating-layout.slots.set', 2],
      ['rating-layout.slots.set', 3],
      ['producer.rating.set', 1],
      ['collection.producer.set', 1],
      ['collection.producer.set', 2],
      ['author.directories.set', 1],
      ['author.directories.set', 3],
      ['author.directories.set', 4],
      ['author.directories.set', 5],
      ['author.directories.set', 7],
    ]);
    expect(operations[2]).toMatchObject({
      operationKind: 'producer.rating.set',
      baseValues: { slotUid: 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0', stars: null },
      payload: { slotUid: 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0', stars: 4.5 },
    });
    await expect(api.getAuthor(9)).resolves.toMatchObject({
      ratings: [{ slotId: 9, name: 'Mood', stars: 4.5 }, { slotId: 8, name: 'Craft', stars: null }],
      tags: expect.any(Array),
      directories: [
        expect.objectContaining({ id: -1, title: 'Renamed first', entryCount: 0 }),
        expect.objectContaining({ id: -2, title: 'Second', entryCount: 0 }),
      ],
      looseEntries: [expect.objectContaining({ id: 1 })],
    });
    await expect(api.listCollectionsForProducer(9)).resolves.toEqual([60]);
    const projected = await readActiveSnapshot(store);
    expect(projected?.snapshot.payload.collections[0]).toMatchObject({ syncVersion: 1 });
    expect(projected?.snapshot.payload.authorDirectoryEntries).toEqual([]);
  });

  it('queues and projects offline Collection create, nested folders, metadata, membership and ordering as one bundle', async () => {
    const store = await populatedProducerRatingStore();
    const active = await readActiveSnapshot(store);
    if (active === null) throw new Error('fixture snapshot missing');
    active.snapshot.payload.collections.push({
      id: 61, syncUid: '61616161-6161-4161-8161-616161616161', syncVersion: 1,
      kind: 'entry', title: 'Entry shelf', description: '', nsfw: false, parentId: null, sortOrder: 0, galleryType: null,
    });
    active.snapshot.payload.collectionMembers.push({ collectionId: 61, entryId: 1, position: 0 });
    await store.writeGeneration(1, JSON.stringify(active.snapshot));
    await Promise.all([
      store.writeMeta('capability.offlineCollectionManagement', '1'),
      store.writeMeta('capability.offlineCollectionProducerMembership', '1'),
    ]);
    const ids = [
      'b0010000-0000-4000-8000-000000000001', 'b0010000-0000-4000-8000-000000000002',
      'b0020000-0000-4000-8000-000000000001', 'b0020000-0000-4000-8000-000000000002',
      'b0030000-0000-4000-8000-000000000001', 'b0040000-0000-4000-8000-000000000001',
      'b0050000-0000-4000-8000-000000000001', 'b0060000-0000-4000-8000-000000000001',
      'b0070000-0000-4000-8000-000000000001', 'b0080000-0000-4000-8000-000000000001',
      'b0080000-0000-4000-8000-000000000002', 'b0090000-0000-4000-8000-000000000001',
    ];
    const online = {
      createCollection: vi.fn(), updateCollection: vi.fn(), setCollectionNsfw: vi.fn(),
      reorderCollections: vi.fn(), addCollectionEntry: vi.fn(), removeCollectionEntry: vi.fn(),
      addCollectionProducer: vi.fn(),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-collection-management', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });

    const root = await api.createCollection({ kind: 'entry', title: 'Offline box', description: 'Notes', galleryType: 'Comic' });
    const child = await api.createCollection({ kind: 'entry', title: 'Child box', parentId: root.id });
    await api.updateCollection(root.id, { title: 'Renamed box', description: 'Updated' });
    await api.setCollectionNsfw(root.id, true);
    await api.addCollectionEntry(root.id, 1);
    await api.removeCollectionEntry(61, 1);
    await api.reorderCollections('entry', [root.id, 61]);
    const authorCollection = await api.createCollection({ kind: 'producer', title: 'Offline authors' });
    await api.addCollectionProducer(authorCollection.id, 9);

    expect(root.id).toBeLessThan(0);
    expect(child.id).toBeLessThan(0);
    expect(await api.listCollections('entry', true)).toMatchObject([
      { id: root.id, title: 'Renamed box', description: 'Updated', nsfw: true, sortOrder: 0,
        galleryType: 'Comic', children: [{ id: child.id, title: 'Child box', galleryType: 'Comic' }],
        entries: [{ id: 1, title: 'Offline Entry' }] },
      { id: 61, title: 'Entry shelf', sortOrder: 1, entries: [] },
    ]);
    expect(await api.listCollections('producer', true)).toMatchObject([
      { id: 60, title: 'Artists' },
      { id: authorCollection.id, title: 'Offline authors', producers: [{ id: 9, name: 'Offline Author' }] },
    ]);
    expect((await store.list()).map((operation) => operation.operationKind)).toEqual([
      'collection.create', 'collection.create', 'collection.update', 'collection.update',
      'collection.entry.set', 'collection.entry.set', 'collection.order.set',
      'collection.create', 'collection.producer.set',
    ]);
    expect((await store.list()).map((operation) => operation.baseVersion)).toEqual([0, 0, 1, 2, 3, 1, 6, 0, 1]);
    expect((await store.list())[0]).toMatchObject({
      operationKind: 'collection.create', payload: { galleryType: 'Comic' },
    });
    expect(online.createCollection).not.toHaveBeenCalled();
    expect(online.updateCollection).not.toHaveBeenCalled();
    expect(online.setCollectionNsfw).not.toHaveBeenCalled();
    expect(online.reorderCollections).not.toHaveBeenCalled();
    expect(online.addCollectionEntry).not.toHaveBeenCalled();
    expect(online.removeCollectionEntry).not.toHaveBeenCalled();
    expect(online.addCollectionProducer).not.toHaveBeenCalled();
  });

  it('keeps a pending Collection presentation ID stable when an earlier create leaves the outbox', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineCollectionManagement', '1');
    const ids = [
      'b0010000-0000-4000-8000-000000000001', 'b0010000-0000-4000-8000-000000000002',
      'b0020000-0000-4000-8000-000000000001', 'b0020000-0000-4000-8000-000000000002',
    ];
    const api = createOfflineAwareGalleryApi({} as GalleryApi, store, {
      state: { mode: 'offline', lastFallbackAt: null }, clientId: 'client-stable-collection',
      randomUUID: () => ids.shift()!,
    });
    await api.createCollection({ kind: 'producer', title: 'First' });
    const second = await api.createCollection({ kind: 'producer', title: 'Second' });
    const [firstOperation] = await store.list();
    await store.remove(firstOperation!.opId);
    expect((await api.listCollections('producer', true)).find((row) => row.title === 'Second')?.id)
      .toBe(second.id);
    const restarted = createOfflineAwareGalleryApi({} as GalleryApi, store, {
      state: { mode: 'offline', lastFallbackAt: null }, clientId: 'client-stable-collection',
    });
    expect((await restarted.listCollections('producer', true)).find((row) => row.title === 'Second')?.id)
      .toBe(second.id);
  });

  it('publishes an authoritative Collection ID after replay and never sends a stale negative ID online', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineCollectionManagement', '1');
    const refreshed = structuredClone(offlineSnapshot());
    refreshed.header.snapshotSeq = 2;
    refreshed.header.changeSeq = 2;
    refreshed.payload.collections.push({
      id: 72, syncUid: 'b0010000-0000-4000-8000-000000000001', syncVersion: 1,
      kind: 'entry', title: 'Local shelf', description: '', nsfw: false, parentId: null, sortOrder: 1,
    });
    refreshed.header.counts.collections = 2;
    await stampChecksum(refreshed);
    const online = {
      getSyncCapabilities: vi.fn(async () => ({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'test',
        featureFlags: { offlineMutations: true, offlineCollectionManagement: true, offlineCollectionProducerMembership: true },
      })),
      replaySyncOperation: vi.fn(async (operation: PendingSyncOperation) => ({
        opId: operation.opId, status: 'applied' as const, resourceVersion: 1, serverSeq: 2,
      })),
      fetchSyncSnapshot: vi.fn(async () => structuredClone(refreshed)),
      updateCollection: vi.fn(async () => ({ id: 72 })),
      setCollectionNsfw: vi.fn(async () => ({ id: 72 })),
      addCollectionEntry: vi.fn(async () => undefined),
      createCollection: vi.fn(async () => ({ id: 73 })),
    } as unknown as GalleryApi;
    const state = { mode: 'offline' as 'online' | 'offline', lastFallbackAt: null };
    const ids = ['b0010000-0000-4000-8000-000000000001', 'b0010000-0000-4000-8000-000000000002'];
    const api = createOfflineAwareGalleryApi(online, store, {
      state, clientId: 'client-collection-reconcile', randomUUID: () => ids.shift()!,
    });
    const created = await api.createCollection({ kind: 'entry', title: 'Local shelf' });
    const mapped = vi.fn();
    const unsubscribe = subscribeCollectionReconciliation(api, mapped);
    await api.getSyncCapabilities({ replay: false });
    expect(state.mode).toBe('online');
    await api.replayOfflineOperations?.();
    expect(await store.list()).toEqual([]);
    expect(mapped).toHaveBeenCalledWith(new Map([[created.id, 72]]));
    await api.updateCollection(created.id, { title: 'After replay' });
    await api.setCollectionNsfw(created.id, true);
    await api.addCollectionEntry(created.id, 1);
    await api.createCollection({ kind: 'entry', title: 'Child', parentId: created.id });
    expect(online.updateCollection).toHaveBeenCalledWith(72, { title: 'After replay' });
    expect(online.setCollectionNsfw).toHaveBeenCalledWith(72, true);
    expect(online.addCollectionEntry).toHaveBeenCalledWith(72, 1);
    expect(online.createCollection).toHaveBeenCalledWith({ kind: 'entry', title: 'Child', parentId: 72 });
    unsubscribe();
  });

  it('blocks a source-Collection removal when the preceding destination membership conflicts', async () => {
    const store = await populatedOfflineStore();
    const active = await readActiveSnapshot(store);
    if (active === null) throw new Error('fixture snapshot missing');
    const entryUid = active.snapshot.payload.entries[0]!.syncUid!;
    const sourceUid = 'c1111111-1111-4111-8111-111111111111';
    const targetUid = 'c2222222-2222-4222-8222-222222222222';
    active.snapshot.payload.collections.push(
      { id: 61, syncUid: sourceUid, syncVersion: 1, kind: 'entry', title: 'Source', description: '', nsfw: false, parentId: null, sortOrder: 0, galleryType: null },
      { id: 62, syncUid: targetUid, syncVersion: 1, kind: 'entry', title: 'Target', description: '', nsfw: false, parentId: null, sortOrder: 1, galleryType: null },
    );
    active.snapshot.payload.collectionMembers.push({ collectionId: 61, entryId: 1, position: 0 });
    await store.writeGeneration(1, JSON.stringify(active.snapshot));
    await store.writeMeta('capability.offlineCollectionManagement', '1');
    const add = createPendingSyncOperation({
      clientId: 'client-move', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'collection', entityUid: targetUid, operationKind: 'collection.entry.set',
      baseVersion: 1, baseValues: { entryUid, present: false }, payload: { entryUid, present: true },
    }, { randomUUID: () => 'c3333333-3333-4333-8333-333333333333' });
    const remove = createPendingSyncOperation({
      clientId: 'client-move', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'collection', entityUid: sourceUid, operationKind: 'collection.entry.set',
      baseVersion: 1, baseValues: { entryUid, present: true }, payload: { entryUid, present: false },
    }, { randomUUID: () => 'c4444444-4444-4444-8444-444444444444' });
    await store.enqueue(add);
    await store.enqueue(remove);
    const replaySyncOperation = vi.fn().mockResolvedValue({
      opId: add.opId, status: 'conflict', currentVersion: 2,
      currentValues: { entryUid, present: false },
    });
    const api = createOfflineAwareGalleryApi({ replaySyncOperation } as unknown as GalleryApi, store);

    await api.replayOfflineOperations?.();
    expect(replaySyncOperation).toHaveBeenCalledTimes(1);
    expect(await store.list()).toMatchObject([
      { opId: add.opId, status: 'conflict' },
      { opId: remove.opId, status: 'pending' },
    ]);
    await api.discardBlockedOfflineOperations?.();
    expect(await store.list()).toEqual([]);
  });

  it('refuses to serve a snapshot from a different library than the paired shell', async () => {
    const store = await populatedOfflineStore(); // header libraryId 'library-1'
    const online = { getSyncCapabilities: vi.fn() } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-pairing-guard', state: { mode: 'online', lastFallbackAt: null } as never,
      nativeShellLibraryId: async () => 'library-2',
      fallbackLibraryMismatchMessage: 'The paired library changed.',
    });
    // The local copy belongs to library-1 while the shell is paired to
    // library-2: going offline must neither flip the mode nor serve the copy.
    await expect(api.preferOfflineSnapshot?.('disconnect')).resolves.toBe(false);
    expect(online.getSyncCapabilities).not.toHaveBeenCalled();
  });

  it('serves the snapshot offline when it belongs to the paired library', async () => {
    const store = await populatedOfflineStore();
    const api = createOfflineAwareGalleryApi({} as unknown as GalleryApi, store, {
      clientId: 'client-pairing-guard', state: { mode: 'online', lastFallbackAt: null } as never,
      nativeShellLibraryId: async () => 'library-1',
    });
    await expect(api.preferOfflineSnapshot?.('disconnect')).resolves.toBe(true);
  });

  it('does not remove queued operations when the library changes; discard can take them', async () => {
    const store = await populatedOfflineStore();
    const stale = createPendingSyncOperation({
      clientId: 'client-september', libraryId: 'library-1', syncEpoch: 'epoch-0',
      entityKind: 'entry', entityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operationKind: 'entry.rating.set',
      baseVersion: 1, baseValues: { slotId: 7, stars: null }, payload: { slotId: 7, stars: 5 },
    }, { randomUUID: () => 'd3333333-3333-4333-8333-333333333333' });
    await store.enqueue(stale);
    const api = createOfflineAwareGalleryApi({} as unknown as GalleryApi, store, {
      clientId: 'client-pairing-guard', state: { mode: 'online', lastFallbackAt: null } as never,
      nativeShellLibraryId: async () => 'library-2',
    });
    await expect(api.preferOfflineSnapshot?.('startup')).resolves.toBe(false);
    // Outbox rows stay untouched by a refused fallback; the explicit discard
    // is the single cleanup path.
    expect(await store.list()).toEqual([expect.objectContaining({ opId: stale.opId, status: 'pending' })]);
    await api.discardBlockedOfflineOperations?.();
    expect(await store.list()).toEqual([]);
  });

  it('refuses the per-call transport fallback when the local copy belongs to another library', async () => {
    const store = await populatedOfflineStore(); // header libraryId 'library-1', entry id 1
    const mismatchState = { mode: 'offline' as const, lastFallbackAt: null, pendingCount: 0, conflictCount: 0, failedCount: 0, lastReplayError: null as string | null } as never;
    const online = { getEntry: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      state: mismatchState,
      nativeShellLibraryId: async () => 'library-2',
      fallbackLibraryMismatchMessage: 'The paired library changed.',
    });
    // Even with the mode already offline, a failed online read must not serve
    // the foreign-library copy; it reports the failed connection instead.
    await expect(api.getEntry(1)).rejects.toThrow();
    expect((mismatchState as { lastReplayError: string | null }).lastReplayError).toBe('The paired library changed.');
  });

  it('projects a queued offline Entry create into the offline copy immediately', async () => {
    const store = await populatedOfflineStore();
    await Promise.all([
      store.writeMeta('capability.offlineEntryCreate', '1'),
      store.writeMeta('capability.offlineEntryInitialContents', '1'),
      store.writeMeta('capability.offlineMediaUpload', '1'),
      store.writeMeta('capability.offlineEntryViewLater', '1'),
    ]);
    const offline = new TypeError('Failed to fetch');
    const online = { createEntry: vi.fn().mockRejectedValue(offline) } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-create-projection', state: { mode: 'offline', lastFallbackAt: null } as never,
    });
    await api.enqueueOfflineEntryCreate?.({
      title: 'Queued offline work', type: 'game', uploadDate: null, pageCount: 5,
      ratings: [{ slotId: 7, stars: 4 }], viewLater: true,
      coverFile: null, previewFile: null,
      contents: [{ contentType: 'Source URL', content: 'https://example.test/queued' }],
    });
    // The queued create's presentation id is the stable hash of its UID.
    const queued = await store.list();
    const entityUid = queued[0]?.entityUid;
    expect(entityUid).toEqual(expect.any(String));
    const localId = localCollectionId(entityUid as string);
    await expect(api.getEntry?.(localId)).resolves.toMatchObject({
      title: 'Queued offline work', type: 'game',
      contents: [{ contentType: 'Source URL', content: 'https://example.test/queued' }],
    });
    const page = await api.queryEntryPage?.({
      entryType: 'game', conditions: [], authorIds: [], ratingConditions: [], ratingSort: null,
      usageConditions: [], usageSort: null, includeNsfw: true, page: 1, pageSize: 50,
    } as never);
    expect((page?.items ?? [])).toContainEqual(expect.objectContaining({ id: localId, title: 'Queued offline work' }));
    // Optional View later rides the create payload, not a separate operation.
    const viewLater = await api.getViewLaterState?.();
    expect(viewLater?.entryIds).toContain(localId);
  });

  it('discards pending operations from a foreign library epoch with the blocked set', async () => {
    const store = await populatedOfflineStore();
    const stale = createPendingSyncOperation({
      clientId: 'client-september', libraryId: 'library-1', syncEpoch: 'epoch-0',
      entityKind: 'entry', entityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operationKind: 'entry.rating.set',
      baseVersion: 1, baseValues: { slotId: 7, stars: null }, payload: { slotId: 7, stars: 5 },
    }, { randomUUID: () => 'd1111111-1111-4111-8111-111111111111' });
    const current = createPendingSyncOperation({
      clientId: 'client-september', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'entry', entityUid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', operationKind: 'entry.view-later.set',
      baseVersion: 1, baseValues: { present: false }, payload: { present: true },
    }, { randomUUID: () => 'd2222222-2222-4222-8222-222222222222' });
    await store.enqueue(stale);
    await store.enqueue(current);
    // The stale-epoch operation never replays (the plan skips it and the server
    // refuses it by identity), so the explicit blocked-set discard takes it. A
    // current-epoch edit to an unrelated entity stays queued; edits chained to
    // the blocked entity go with it, as with any blocked-entity dependent.
    const api = createOfflineAwareGalleryApi({} as unknown as GalleryApi, store);
    await api.discardBlockedOfflineOperations?.();
    expect(await store.list()).toMatchObject([{ opId: current.opId, status: 'pending' }]);
  });

  it('does not enqueue offline Collection deletion or temporary membership imports', async () => {
    const store = await populatedOfflineStore();
    const offline = new TypeError('Failed to fetch');
    const online = {
      deleteCollection: vi.fn().mockRejectedValue(offline),
      createTemporaryCollection: vi.fn().mockRejectedValue(offline),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      state: { mode: 'offline', lastFallbackAt: null },
    });
    await expect(api.deleteCollection(60)).rejects.toThrow('Failed to fetch');
    await expect(api.createTemporaryCollection([1])).rejects.toThrow('Failed to fetch');
    expect(await store.list()).toEqual([]);
  });

  it('does not enqueue Collection edits without the explicit management capability', async () => {
    const store = await populatedOfflineStore();
    const online = {
      createCollection: vi.fn(), updateCollection: vi.fn(), setCollectionNsfw: vi.fn(),
      reorderCollections: vi.fn(), addCollectionEntry: vi.fn(), removeCollectionEntry: vi.fn(),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => 'b1110000-0000-4000-8000-000000000001',
    });
    await expect(api.createCollection({ kind: 'entry', title: 'No capability' }))
      .rejects.toThrow('has not enabled offline Collection management');
    await expect(api.updateCollection(60, { title: 'No capability' }))
      .rejects.toThrow('has not enabled offline Collection management');
    expect(await store.list()).toEqual([]);
    expect(online.createCollection).not.toHaveBeenCalled();
    expect(online.updateCollection).not.toHaveBeenCalled();
  });

  it('holds dependent Author ratings if their newly created slot is blocked during replay', async () => {
    const store = await populatedProducerRatingStore();
    await Promise.all([
      store.writeMeta('capability.offlineRatingSlotLayout', '1'),
      store.writeMeta('capability.offlineProducerRating', '1'),
    ]);
    const ids = [
      'c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0', 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1',
      'c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2',
    ];
    const replaySyncOperation = vi.fn(async (operation: Parameters<NonNullable<GalleryApi['replaySyncOperation']>>[0]) => ({
      opId: operation.opId,
      status: 'conflict' as const,
      currentVersion: 2,
      currentValues: { slots: [{ syncUid: '81818181-8181-4181-8181-818181818181', name: 'Craft', sortOrder: 0 }] },
      serverSeq: 1,
    }));
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'test',
        featureFlags: { offlineRatingSlotLayout: true, offlineProducerRating: true },
      }),
      replaySyncOperation,
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-rating-dependency', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });
    await api.createAuthorRatingSlot(9, 'Mood');
    await api.setAuthorRating(9, 9, 4.5);
    await api.getSyncCapabilities();

    expect(replaySyncOperation).toHaveBeenCalledTimes(1);
    expect(replaySyncOperation.mock.calls[0]?.[0].operationKind).toBe('rating-layout.slots.set');
    expect(await store.list()).toMatchObject([
      { operationKind: 'rating-layout.slots.set', status: 'conflict' },
      { operationKind: 'producer.rating.set', status: 'pending' },
    ]);
    await api.discardBlockedOfflineOperations?.();
    expect(await store.list()).toEqual([]);
  });

  it('keeps an Entry-create rated by a new slot queued behind a blocked layout replay', async () => {
    const store = await populatedOfflineStore();
    await Promise.all([
      store.writeMeta('capability.offlineRatingSlotLayout', '1'),
      store.writeMeta('capability.offlineEntryCreate', '1'),
    ]);
    const ids = [
      'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0', 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1',
      'f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2', 'f3f3f3f3-f3f3-43f3-83f3-f3f3f3f3f3f3',
    ];
    const replaySyncOperation = vi.fn(async (operation: Parameters<NonNullable<GalleryApi['replaySyncOperation']>>[0]) => ({
      opId: operation.opId, status: 'conflict' as const, currentVersion: 2,
      currentValues: { slots: [{ syncUid: '71717171-7171-4171-8171-717171717171', name: 'Quality', sortOrder: 0 }] },
      serverSeq: 1,
    }));
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'test',
        featureFlags: { offlineRatingSlotLayout: true, offlineEntryCreate: true },
      }),
      replaySyncOperation,
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-entry-create-dependency', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });
    const slot = await api.createEntryRatingSlot(1, 'Technique');
    expect(slot.id).toBe(8);
    await api.enqueueOfflineEntryCreate?.({
      title: 'Rated queued Entry', type: 'game', uploadDate: null, pageCount: null,
      ratings: [{ slotId: slot.id, stars: 4.5 }], viewLater: false, coverFile: null, previewFile: null,
    });
    const queued = await store.list();
    expect(queued[1]?.payload).toMatchObject({
      ratings: [{ slotUid: 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0', stars: 4.5 }],
    });

    await api.getSyncCapabilities();
    expect(replaySyncOperation).toHaveBeenCalledTimes(1);
    expect(replaySyncOperation.mock.calls[0]?.[0].operationKind).toBe('rating-layout.slots.set');
    expect(await store.list()).toMatchObject([
      { operationKind: 'rating-layout.slots.set', status: 'conflict' },
      { operationKind: 'entry.create', status: 'pending' },
    ]);
    await api.discardBlockedOfflineOperations?.();
    expect(await store.list()).toEqual([]);
  });

  it('does not enqueue new resource edits without their explicit capabilities', async () => {
    const store = await populatedProducerRatingStore();
    const online = {
      createAuthorRatingSlot: vi.fn(), addCollectionProducer: vi.fn(), createAuthorDirectory: vi.fn(),
    } as unknown as GalleryApi;
    const ids = [
      '11112222-3333-4333-8333-111111111111', '22223333-4444-4444-8444-222222222222',
    ];
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-resource-no-capability', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });
    await expect(api.createAuthorRatingSlot(9, 'Mood')).rejects.toThrow('has not enabled offline rating-slot editing');
    await expect(api.addCollectionProducer(60, 9)).rejects.toThrow('has not enabled offline Collection membership editing');
    await expect(api.createAuthorDirectory(9, { title: 'New directory' }))
      .rejects.toThrow('has not enabled offline Author Directory editing');
    expect(await store.list()).toEqual([]);
    expect(online.createAuthorRatingSlot).not.toHaveBeenCalled();
    expect(online.addCollectionProducer).not.toHaveBeenCalled();
    expect(online.createAuthorDirectory).not.toHaveBeenCalled();
  });

  it('replays Collection and Directory operations only when their probed capability is enabled', async () => {
    const store = await populatedProducerRatingStore();
    await store.writeMeta('capability.offlineCollectionProducerMembership', '1');
    await store.writeMeta('capability.offlineAuthorDirectories', '1');
    const ids = [
      'd0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0', 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1',
      'd2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2',
    ];
    const replaySyncOperation = vi.fn();
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'older-server', featureFlags: {},
      }),
      replaySyncOperation,
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-author-resource-capability', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });
    await api.removeCollectionProducer(60, 9);
    await api.createAuthorDirectory(9, { title: 'Pending Directory' });
    await api.getSyncCapabilities();
    expect(replaySyncOperation).not.toHaveBeenCalled();
    expect(await store.readMeta('capability.offlineCollectionProducerMembership')).toBe('0');
    expect(await store.readMeta('capability.offlineAuthorDirectories')).toBe('0');
    expect(await store.list()).toMatchObject([
      { operationKind: 'collection.producer.set', status: 'pending' },
      { operationKind: 'author.directories.set', status: 'pending' },
    ]);
  });

  it('replays Author profile and tag edits in order and clears them only after a covering snapshot', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineProducerProfile', '1');
    await store.writeMeta('capability.offlineProducerTags', '1');
    const ids = [
      'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1',
      'd2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2',
      'd3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3',
    ];
    const snapshot = offlineSnapshot();
    snapshot.header.snapshotSeq = 2;
    snapshot.header.changeSeq = 3;
    snapshot.header.sqliteSchemaVersion = 27;
    snapshot.payload.producers[0]!.occupation = 'Writer';
    snapshot.payload.producerTags.push({
      id: 21, syncUid: 'd2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2', name: 'New Tag', normalizedName: 'new tag',
    });
    snapshot.payload.producerTagAssignments.push({ producerId: 9, tagId: 21 });
    await stampChecksum(snapshot);
    const replaySyncOperation = vi.fn(async (operation: Parameters<NonNullable<GalleryApi['replaySyncOperation']>>[0]) => ({
      opId: operation.opId,
      status: 'applied' as const,
      resourceVersion: operation.operationKind === 'producer.tags.set' ? 3 : 2,
      serverSeq: operation.operationKind === 'producer.tags.set' ? 3 : 2,
    }));
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'author-data',
        featureFlags: { offlineProducerProfile: true, offlineProducerTags: true },
      }),
      replaySyncOperation,
      fetchSyncSnapshot: vi.fn().mockResolvedValue(snapshot),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-author-replay', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });
    await api.updateAuthor(9, { occupation: 'Writer' });
    await api.assignAuthorTag(9, 'New Tag');

    await api.getSyncCapabilities();

    expect(replaySyncOperation.mock.calls.map(([operation]) => operation.operationKind))
      .toEqual(['producer.update', 'producer.tags.set']);
    expect(replaySyncOperation.mock.calls.map(([operation]) => operation.baseVersion)).toEqual([1, 2]);
    expect(online.fetchSyncSnapshot).toHaveBeenCalledTimes(1);
    expect(await store.list()).toEqual([]);
    await expect(api.getAuthor(9)).resolves.toMatchObject({
      occupation: 'Writer', tags: expect.arrayContaining([expect.objectContaining({ name: 'New Tag' })]),
    });
  });

  it('queues Producer profile/tag edits only on classified transport failures', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineProducerProfile', '1');
    await store.writeMeta('capability.offlineProducerTags', '1');
    const offline = {
      updateAuthor: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      assignAuthorTag: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    } as unknown as GalleryApi;
    const ids = [
      'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1',
      'e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2',
      'e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3',
    ];
    const api = createOfflineAwareGalleryApi(offline, store, {
      clientId: 'client-author-transport', state: { mode: 'online', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });
    await api.updateAuthor(9, { occupation: 'Writer' });
    await api.assignAuthorTag(9, 'New Tag');
    expect(await store.list()).toMatchObject([
      { operationKind: 'producer.update', status: 'pending' },
      { operationKind: 'producer.tags.set', status: 'pending' },
    ]);

    const businessStore = await populatedOfflineStore();
    await businessStore.writeMeta('capability.offlineProducerProfile', '1');
    await businessStore.writeMeta('capability.offlineProducerTags', '1');
    const rejected = new ApiError(409, { error: { code: 'CONFLICT', message: 'Author changed' } });
    const business = {
      updateAuthor: vi.fn().mockRejectedValue(rejected),
      assignAuthorTag: vi.fn().mockRejectedValue(rejected),
    } as unknown as GalleryApi;
    const businessApi = createOfflineAwareGalleryApi(business, businessStore, {
      clientId: 'client-author-business-error', state: { mode: 'online', lastFallbackAt: null },
    });
    await expect(businessApi.updateAuthor(9, { occupation: 'Writer' })).rejects.toThrow('Author changed');
    await expect(businessApi.assignAuthorTag(9, 'New Tag')).rejects.toThrow('Author changed');
    expect(await businessStore.list()).toEqual([]);
  });

  it('blocks profile and tag replay when a successful capability probe omits either flag', async () => {
    const store = await populatedProducerRatingStore();
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'older-server', featureFlags: {},
      }),
      replaySyncOperation: vi.fn(),
    } as unknown as GalleryApi;
    const ids = [
      'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1',
      'd2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2',
      'd3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3',
    ];
    const api = createOfflineAwareGalleryApi(online, store, {
      clientId: 'client-author-data', state: { mode: 'offline', lastFallbackAt: null },
      randomUUID: () => ids.shift()!,
    });
    await store.writeMeta('capability.offlineProducerProfile', '1');
    await store.writeMeta('capability.offlineProducerTags', '1');
    await api.updateAuthor(9, { occupation: 'Writer' });
    await api.assignAuthorTag(9, 'New Tag');
    await api.getSyncCapabilities();

    expect(online.replaySyncOperation).not.toHaveBeenCalled();
    expect(await store.readMeta('capability.offlineProducerProfile')).toBe('0');
    expect(await store.readMeta('capability.offlineProducerTags')).toBe('0');
    expect(await store.list()).toMatchObject([
      { operationKind: 'producer.update', status: 'pending' },
      { operationKind: 'producer.tags.set', status: 'pending' },
    ]);
  });

  it('blocks Author rating queueing when capability is false and disables stale capability on omitted flags', async () => {
    const store = await populatedProducerRatingStore();
    const replaySyncOperation = vi.fn();
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'older-server', featureFlags: {},
      }),
      replaySyncOperation,
    } as unknown as GalleryApi;
    await store.writeMeta('capability.offlineProducerRating', '1');
    const operation = createPendingSyncOperation({
      clientId: 'client-producer', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'producer', entityUid: '99999999-9999-4999-8999-999999999999',
      operationKind: 'producer.rating.set', baseVersion: 1,
      baseValues: { slotUid: '81818181-8181-4181-8181-818181818181', stars: null },
      payload: { slotUid: '81818181-8181-4181-8181-818181818181', stars: 4.5 },
    }, { randomUUID: () => 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7' });
    await store.enqueue(operation);
    const state = { mode: 'offline' as const, lastFallbackAt: null as string | null,
      lastCapabilityProbe: null, lastSuccessfulCapabilityProbe: null };
    const api = createOfflineAwareGalleryApi(online, store, { state });

    await api.getSyncCapabilities();

    expect(await store.readMeta('capability.offlineProducerRating')).toBe('0');
    expect(state.lastCapabilityProbe).toMatchObject({ status: 'success', offlineProducerRating: false });
    expect(state.lastSuccessfulCapabilityProbe).toMatchObject({ offlineProducerRating: false });
    expect(replaySyncOperation).not.toHaveBeenCalled();
    expect(await store.list()).toMatchObject([{ opId: operation.opId, status: 'pending' }]);
  });

  it('queues Author ratings only after transport failure, not HTTP or validation errors', async () => {
    const store = await populatedProducerRatingStore();
    await store.writeMeta('capability.offlineProducerRating', '1');
    const online = { setAuthorRating: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      state: { mode: 'online', lastFallbackAt: null },
      randomUUID: () => 'a8a8a8a8-a8a8-48a8-88a8-a8a8a8a8a8a8',
    });
    await expect(api.setAuthorRating(9, 8, 4)).resolves.toMatchObject({ stars: 4 });
    expect(await store.list()).toMatchObject([{ operationKind: 'producer.rating.set', status: 'pending' }]);

    const businessStore = await populatedProducerRatingStore();
    await businessStore.writeMeta('capability.offlineProducerRating', '1');
    const rejectedOnline = {
      setAuthorRating: vi.fn().mockRejectedValue(new ApiError(409, {
        error: { code: 'CONFLICT', message: 'Author rating changed' },
      })),
    } as unknown as GalleryApi;
    const rejectedApi = createOfflineAwareGalleryApi(rejectedOnline, businessStore, {
      state: { mode: 'online', lastFallbackAt: null },
    });
    await expect(rejectedApi.setAuthorRating(9, 8, 4)).rejects.toThrow('Author rating changed');
    expect(await businessStore.list()).toEqual([]);
  });

  it('does not send queued Author rating operations to servers without the capability', async () => {
    const store = await populatedProducerRatingStore();
    const operation = createPendingSyncOperation({
      clientId: 'client-producer', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'producer', entityUid: '99999999-9999-4999-8999-999999999999',
      operationKind: 'producer.rating.set', baseVersion: 1,
      baseValues: { slotUid: '81818181-8181-4181-8181-818181818181', stars: null },
      payload: { slotUid: '81818181-8181-4181-8181-818181818181', stars: 4.5 },
    }, { randomUUID: () => 'a9a9a9a9-a9a9-49a9-89a9-a9a9a9a9a9a9' });
    await store.enqueue(operation);
    await store.writeMeta('capability.offlineProducerRating', '0');
    const replaySyncOperation = vi.fn();
    const api = createOfflineAwareGalleryApi({ replaySyncOperation } as unknown as GalleryApi, store, {
      state: { mode: 'offline', lastFallbackAt: null },
    });

    await api.replayOfflineOperations?.();

    expect(replaySyncOperation).not.toHaveBeenCalled();
    expect(await store.list()).toMatchObject([{ opId: operation.opId, status: 'pending' }]);
  });

  it('does not queue Producer View later when the probed capability is false', async () => {
    const store = await populatedOfflineStore();
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'old-server',
        featureFlags: { offlineProducerViewLater: false },
      }),
      addViewLaterAuthor: vi.fn(),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      state: { mode: 'offline', lastFallbackAt: null },
    });

    await api.getSyncCapabilities({ replay: false });
    await expect(api.preferOfflineSnapshot?.()).resolves.toBe(true);
    await expect(api.addViewLaterAuthor(9)).rejects.toThrow(/not enabled/u);
    expect(online.addViewLaterAuthor).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it('clears Producer View later capability when a successful probe omits the flag', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineProducerViewLater', '1');
    const operation = createPendingSyncOperation({
      clientId: 'client-producer', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'producer', entityUid: '99999999-9999-4999-8999-999999999999',
      operationKind: 'producer.view-later.set', baseVersion: 1,
      baseValues: { present: false }, payload: { present: true },
    }, { randomUUID: () => '95959595-9595-4595-8595-959595959595' });
    await store.enqueue(operation);
    const replaySyncOperation = vi.fn();
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'older-server',
        featureFlags: {},
      }),
      replaySyncOperation,
    } as unknown as GalleryApi;
    const state = {
      mode: 'offline' as const, lastFallbackAt: null as string | null,
      lastCapabilityProbe: null, lastSuccessfulCapabilityProbe: null,
    };
    const api = createOfflineAwareGalleryApi(online, store, { state });

    await api.getSyncCapabilities();

    expect(await store.readMeta('capability.offlineProducerViewLater')).toBe('0');
    expect(state.lastCapabilityProbe).toMatchObject({ status: 'success', offlineProducerViewLater: false });
    expect(state.lastSuccessfulCapabilityProbe).toMatchObject({ offlineProducerViewLater: false });
    expect(replaySyncOperation).not.toHaveBeenCalled();
    expect(await store.list()).toMatchObject([{ opId: operation.opId, status: 'pending' }]);
  });

  it('queues Producer View later only after transport failure, never after an HTTP error', async () => {
    const store = await populatedOfflineStore();
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', serverBuild: 'producer-test',
        featureFlags: { offlineProducerViewLater: true, offlineProducerRating: true },
      }),
      addViewLaterAuthor: vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')),
      removeViewLaterAuthor: vi.fn().mockRejectedValueOnce(
        new ApiError(409, { message: 'membership conflict' }),
      ),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      state: { mode: 'online' as 'online' | 'offline', lastFallbackAt: null },
    });
    await store.writeMeta('capability.offlineProducerViewLater', '1');

    await expect(api.addViewLaterAuthor(9)).resolves.toMatchObject({ producerIds: [9] });
    expect(online.addViewLaterAuthor).toHaveBeenCalledTimes(1);
    await api.getSyncCapabilities({ replay: false });
    await expect(api.removeViewLaterAuthor(9)).rejects.toMatchObject({ status: 409 });
    expect(online.removeViewLaterAuthor).toHaveBeenCalledTimes(1);
    expect(await store.list()).toHaveLength(1);
  });

  it('does not send a queued Producer View later operation to a server without that capability', async () => {
    const store = await populatedOfflineStore();
    const operation = createPendingSyncOperation({
      clientId: 'client-producer', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'producer', entityUid: '99999999-9999-4999-8999-999999999999',
      operationKind: 'producer.view-later.set', baseVersion: 1,
      baseValues: { present: false }, payload: { present: true },
    }, { randomUUID: () => '96969696-9696-4696-8696-969696969696' });
    await store.enqueue(operation);
    await store.writeMeta('capability.offlineProducerViewLater', '0');
    const replaySyncOperation = vi.fn();
    const online = { replaySyncOperation } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      state: { mode: 'offline', lastFallbackAt: null },
    });

    await api.replayOfflineOperations?.();

    expect(replaySyncOperation).not.toHaveBeenCalled();
    expect(await store.list()).toMatchObject([{ opId: operation.opId, status: 'pending' }]);
  });

  it('retains Producer View later operations until a refreshed snapshot covers every replay receipt', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineProducerViewLater', '1');
    const staleSnapshot = structuredClone(offlineSnapshot());
    staleSnapshot.header.snapshotSeq = 2;
    staleSnapshot.header.changeSeq = 2;
    const refreshedSnapshot = structuredClone(offlineSnapshot());
    refreshedSnapshot.header.snapshotSeq = 3;
    refreshedSnapshot.header.changeSeq = 3;
    refreshedSnapshot.payload.producers[0]!.syncVersion = 3;
    await stampChecksum(staleSnapshot);
    await stampChecksum(refreshedSnapshot);
    const replaySyncOperation = vi.fn(async (operation: PendingSyncOperation) => ({
      opId: operation.opId,
      status: 'applied' as const,
      resourceVersion: operation.baseVersion + 1,
      serverSeq: operation.baseVersion + 1,
    }));
    const online = {
      addViewLaterAuthor: vi.fn(),
      removeViewLaterAuthor: vi.fn(),
      replaySyncOperation,
      fetchSyncSnapshot: vi.fn()
        .mockResolvedValueOnce(staleSnapshot)
        .mockResolvedValue(refreshedSnapshot),
    } as unknown as GalleryApi;
    const ids = [
      '94949494-9494-4494-8494-949494949494',
      '95959595-9595-4595-8595-959595959595',
    ];
    const api = createOfflineAwareGalleryApi(online, store, {
      state: { mode: 'offline', lastFallbackAt: null },
      clientId: 'client-producer',
      randomUUID: () => ids.shift()!,
    });

    await expect(api.addViewLaterAuthor(9)).resolves.toMatchObject({ producerIds: [9] });
    await expect(api.removeViewLaterAuthor(9)).resolves.toMatchObject({ producerIds: [] });
    await api.replayOfflineOperations?.();
    expect(replaySyncOperation).toHaveBeenCalledTimes(2);
    expect(online.fetchSyncSnapshot).toHaveBeenCalledTimes(1);
    expect((await store.list()).map((operation) => operation.status)).toEqual(['pending', 'pending']);
    await expect(api.getViewLaterState()).resolves.toMatchObject({ producerIds: [] });

    await api.replayOfflineOperations?.();
    expect(replaySyncOperation).toHaveBeenCalledTimes(4);
    expect(replaySyncOperation.mock.calls[0]?.[0].opId)
      .toBe(replaySyncOperation.mock.calls[2]?.[0].opId);
    expect(replaySyncOperation.mock.calls[1]?.[0].opId)
      .toBe(replaySyncOperation.mock.calls[3]?.[0].opId);
    expect(online.fetchSyncSnapshot).toHaveBeenCalledTimes(2);
    expect(await store.list()).toEqual([]);
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

  it.each([
    { contentType: 'Notes', content: 'keep' },
    { contentType: 'Source URL', content: 'https://example.test/keep' },
  ])('refuses Content-bearing creates against a server that only advertised legacy Entry create: $contentType', async (content) => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    const api = createOfflineAwareGalleryApi({} as GalleryApi, store, {
      state: { mode: 'offline', lastFallbackAt: null }, clientId: 'client',
    });
    await expect(api.enqueueOfflineEntryCreate!({
      title: 'New', type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false,
      coverFile: null, previewFile: null, contents: [content],
    })).rejects.toThrow(/initial Content.*server/i);
    expect(await store.list()).toEqual([]);
  });

  it.each(['failed', 'conflict'] as const)('projects a persisted %s create reason after facade restart', async (status) => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    await store.writeMeta('capability.offlineEntryContentAppend', '1');
    const online = {} as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, { clientId: 'client' });
    await api.enqueueOfflineEntryCreate!({
      title: 'Blocked draft', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: false, coverFile: null, previewFile: null,
    });
    const saved = (await store.list())[0]!;
    await store.update(saved.opId, { status, lastError: 'The saved creation needs review' });
    const before = await store.list();
    const restarted = createOfflineAwareGalleryApi(online, store, { clientId: 'client' });
    expect(await restarted.listPendingOfflineEntryCreates!()).toMatchObject([{
      title: 'Blocked draft', status, lastError: 'The saved creation needs review', canAppendContent: false,
    }]);
    expect(await store.list()).toEqual(before);
  });

  it('reports an already committed offline create as saved if the post-commit status read fails', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    const uid = '22222222-2222-4222-8222-222222222222';
    const list = store.list.bind(store);
    const enqueue = store.enqueueEntryCreate.bind(store);
    let committed = false;
    vi.spyOn(store, 'enqueueEntryCreate').mockImplementation(async (...args) => {
      await enqueue(...args);
      committed = true;
    });
    vi.spyOn(store, 'list').mockImplementation(async () => {
      if (committed) {
        committed = false;
        throw new Error('status read failed');
      }
      return list();
    });
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null,
      pendingCount: 0, conflictCount: 0, failedCount: 0, lastReplayError: null as string | null };
    const api = createOfflineAwareGalleryApi({} as GalleryApi, store, { state, clientId: 'client' });
    await expect(api.enqueueOfflineEntryCreate!({
      title: 'Committed draft', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: false, coverFile: null, previewFile: null, syncUid: uid,
    })).resolves.toEqual({ localKey: `local:${uid}` });
    expect((await list()).filter((row) => row.operationKind === 'entry.create' && row.entityUid === uid)).toHaveLength(1);
    expect(state.mode).toBe('offline');
    expect(state.lastReplayError).toContain('status read failed');
  });

  it('stores initial Content UUID in the original create across facade restart', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    await store.writeMeta('capability.offlineEntryInitialContents', '1');
    const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
    const online = {} as GalleryApi;
    const input = {
      title: 'Created with Content', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: false, coverFile: null, previewFile: null,
      contents: [{ contentType: 'Source URL', content: 'https://example.test/entry' }],
    };
    const api = createOfflineAwareGalleryApi(online, store, {
      state: { mode: 'offline', lastFallbackAt: null }, randomUUID: () => ids.shift()!, clientId: 'client',
    });
    await api.enqueueOfflineEntryCreate!(input);
    const before = await store.list();
    expect(before[0]).toMatchObject({ payload: {
      contents: [{ syncUid: '33333333-3333-4333-8333-333333333333', contentType: 'Source URL', content: 'https://example.test/entry', sortOrder: 0 }],
    } });
    const restarted = createOfflineAwareGalleryApi(online, store, {
      state: { mode: 'offline', lastFallbackAt: null }, clientId: 'client',
    });
    expect(await restarted.listPendingOfflineEntryCreates!()).toMatchObject([{
      contents: [{ contentType: 'Source URL', content: 'https://example.test/entry' }],
    }]);
    expect(await store.list()).toEqual(before);
    await store.writeMeta('capability.offlineEntryInitialContents', '0');
    const replay = vi.fn();
    const downgraded = createOfflineAwareGalleryApi({ replaySyncOperation: replay } as unknown as GalleryApi, store, {
      state: { mode: 'offline', lastFallbackAt: null }, clientId: 'client',
    });
    await downgraded.flushOfflineOutbox?.();
    expect(replay).not.toHaveBeenCalled();
    expect(await store.list()).toEqual(before);
  });

  it('keeps the online attempt UID in an offline create after a lost response', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    const onlineUid = '22222222-2222-4222-8222-222222222222';
    const api = createOfflineAwareGalleryApi({} as GalleryApi, store, {
      state: { mode: 'online', lastFallbackAt: null }, clientId: 'client',
      randomUUID: () => '33333333-3333-4333-8333-333333333333',
    });
    const input = {
      title: 'Uncertain online work', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: false, coverFile: null, previewFile: null, syncUid: onlineUid,
    };
    await expect(api.enqueueOfflineEntryCreate!(input, new TypeError('Failed to fetch')))
      .resolves.toEqual({ localKey: `local:${onlineUid}` });
    expect(await store.list()).toMatchObject([{ operationKind: 'entry.create', entityUid: onlineUid }]);
  });

  it('keeps an adopted create pending until the authoritative snapshot contains its Entry UID', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    const uid = '22222222-2222-4222-8222-222222222222';
    const stale = structuredClone(offlineSnapshot());
    stale.header.snapshotSeq = 2;
    stale.header.changeSeq = 5;
    await stampChecksum(stale);
    const online = {
      replaySyncOperation: vi.fn().mockImplementation(async (operation) => ({
        opId: operation.opId, status: 'applied', entityId: 2, resourceVersion: 1, serverSeq: 5,
      })),
      fetchSyncSnapshot: vi.fn().mockResolvedValue(stale),
    } as unknown as GalleryApi;
    const state = {
      mode: 'online' as 'online' | 'offline', lastFallbackAt: null,
      pendingCount: 0, conflictCount: 0, failedCount: 0, lastReplayError: null as string | null,
    };
    const api = createOfflineAwareGalleryApi(online, store, { state, clientId: 'client',
      randomUUID: () => '33333333-3333-4333-8333-333333333333' });
    await api.enqueueOfflineEntryCreate!({ title: 'New', type: 'game', uploadDate: null,
      pageCount: null, ratings: [], viewLater: false, coverFile: null, previewFile: null, syncUid: uid });
    await api.flushOfflineOutbox?.();
    expect(await store.list()).toMatchObject([{ entityUid: uid, operationKind: 'entry.create' }]);
    expect(state.lastReplayError).toContain('Snapshot refresh failed');
  });

  it.each(['pending', 'failed', 'conflict'] as const)('projects a later Content operation as %s without changing its parent payload', async (status) => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    await store.writeMeta('capability.offlineEntryInitialContents', '1');
    await store.writeMeta('capability.offlineEntryContentAppend', '1');
    const online = {} as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, { clientId: 'client' });
    const created = await api.enqueueOfflineEntryCreate!({
      title: 'Child state draft', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: false, coverFile: null, previewFile: null,
      contents: [{ contentType: 'Notes', content: 'initial' }],
    });
    const parent = structuredClone((await store.list())[0]);
    await api.enqueueOfflinePendingEntryContent!(created.localKey, { contentType: 'Notes', content: 'later' });
    const child = (await store.list())[1]!;
    await store.update(child.opId, { status, lastError: status === 'pending' ? null : 'Later Content needs review' });
    const before = await store.list();
    const restarted = createOfflineAwareGalleryApi(online, store, { clientId: 'client' });
    const projected = (await restarted.listPendingOfflineEntryCreates!())[0]!;
    expect(projected.status).toBe('pending');
    expect(projected.canAppendContent).toBe(status === 'pending');
    expect(projected.contents?.[0]).toEqual({ contentType: 'Notes', content: 'initial' });
    expect(projected.contents?.[1]).toMatchObject({ contentType: 'Notes', content: 'later', status });
    expect(projected.contents?.[1]?.lastError).toBe(status === 'pending' ? undefined : 'Later Content needs review');
    expect((await store.list())[0]).toEqual(parent);
    expect(await store.list()).toEqual(before);
  });

  it('persists a later Content append for a pending Entry without rewriting its queued create', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    await store.writeMeta('capability.offlineEntryInitialContents', '1');
    await store.writeMeta('capability.offlineEntryContentAppend', '1');
    const ids = [
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    const online = {} as GalleryApi;
    const localKey = `local:${ids[0]}`;
    const api = createOfflineAwareGalleryApi(online, store, {
      state: { mode: 'offline', lastFallbackAt: null }, randomUUID: () => ids.shift()!, clientId: 'client',
    });
    await api.enqueueOfflineEntryCreate!({
      title: 'Draft', type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false,
      coverFile: null, previewFile: null, contents: [{ contentType: 'Notes', content: 'first' }],
    });
    const createBefore = structuredClone((await store.list())[0]);
    const append = api as typeof api & { enqueueOfflinePendingEntryContent: (
      key: string, row: { contentType: string; content: string },
    ) => Promise<unknown> };
    await append.enqueueOfflinePendingEntryContent(localKey, { contentType: 'Notes', content: 'later' });
    const operations = await store.list();
    expect(operations).toHaveLength(2);
    expect(operations[0]).toEqual(createBefore);
    expect(operations[1]).toMatchObject({ entityUid: localKey.slice(6), entityKind: 'entry' });
    const restarted = createOfflineAwareGalleryApi(online, store, {
      state: { mode: 'offline', lastFallbackAt: null }, clientId: 'client',
    });
    expect(await restarted.listPendingOfflineEntryCreates!()).toMatchObject([{
      localKey,
      canAppendContent: true,
      contents: [
        { contentType: 'Notes', content: 'first' },
        { contentType: 'Notes', content: 'later' },
      ],
    }]);
  });

  it('persists the append gate only when both server flags are enabled', async () => {
    const store = await populatedOfflineStore();
    const flags = { offlineMutations: false, offlineEntryContentAppend: true };
    const api = createOfflineAwareGalleryApi({
      getSyncCapabilities: vi.fn().mockImplementation(async () => ({
        libraryId: 'library-1', syncEpoch: 'epoch-1', sqliteSchemaVersion: 30,
        snapshotFormatVersion: 2, syncProtocolVersion: 1, serverBuild: 'test', featureFlags: flags,
      })),
    } as unknown as GalleryApi, store, { clientId: 'client' });
    await api.getSyncCapabilities({ replay: false });
    expect(await store.readMeta('capability.offlineEntryContentAppend')).toBe('0');
    flags.offlineMutations = true;
    await api.getSyncCapabilities({ replay: false });
    expect(await store.readMeta('capability.offlineEntryContentAppend')).toBe('1');
    flags.offlineEntryContentAppend = false;
    await api.getSyncCapabilities({ replay: false });
    expect(await store.readMeta('capability.offlineEntryContentAppend')).toBe('0');
  });

  it('requires a persisted global and append capability, and refuses unrelated or malformed local identity', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    const api = createOfflineAwareGalleryApi({} as GalleryApi, store, {
      state: { mode: 'offline', lastFallbackAt: null }, clientId: 'client',
    });
    const { localKey } = await api.enqueueOfflineEntryCreate!({
      title: 'Draft', type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false,
      coverFile: null, previewFile: null,
    });
    const append = (key: string) => api.enqueueOfflinePendingEntryContent!(key, { contentType: 'Notes', content: 'later' });
    await expect(append(localKey)).rejects.toThrow(/not supported/);
    await store.writeMeta('capability.offlineEntryContentAppend', '1');
    await expect(append('local:not-a-uuid')).rejects.toThrow(/local Entry key/);
    await expect(append('local:77777777-7777-4777-8777-777777777777')).rejects.toThrow(/not found/);
    const foreign = createOfflineAwareGalleryApi({} as GalleryApi, store, {
      state: { mode: 'offline', lastFallbackAt: null }, clientId: 'other-client',
    });
    await expect(foreign.enqueueOfflinePendingEntryContent!(localKey, { contentType: 'Notes', content: 'foreign' }))
      .rejects.toThrow(/not found/);
    expect(await store.list()).toHaveLength(1);
  });

  it('holds a dependent append after a failed parent create and blocks replay on capability downgrade', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    await store.writeMeta('capability.offlineEntryContentAppend', '1');
    const replay = vi.fn().mockImplementation(async (operation) => ({
      opId: operation.opId, status: 'rejected', detail: 'parent failed',
    }));
    const api = createOfflineAwareGalleryApi({ replaySyncOperation: replay } as unknown as GalleryApi, store, {
      state: { mode: 'offline', lastFallbackAt: null }, clientId: 'client',
    });
    const { localKey } = await api.enqueueOfflineEntryCreate!({
      title: 'Draft', type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false,
      coverFile: null, previewFile: null,
    });
    await api.enqueueOfflinePendingEntryContent!(localKey, { contentType: 'Notes', content: 'later' });
    await api.flushOfflineOutbox!();
    expect(replay).toHaveBeenCalledTimes(1);
    expect((await store.list()).map(({ status }) => status)).toEqual(['failed', 'pending']);
    await expect(api.enqueueOfflinePendingEntryContent!(localKey, { contentType: 'Notes', content: 'too late' }))
      .rejects.toThrow(/blocked|pending/i);
    await store.writeMeta('capability.offlineEntryContentAppend', '0');
    await api.flushOfflineOutbox!();
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('refuses another append behind a conflicted append for the same pending Entry', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    await store.writeMeta('capability.offlineEntryContentAppend', '1');
    const ids = ['22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777'];
    const api = createOfflineAwareGalleryApi({
      replaySyncOperation: vi.fn().mockImplementation(async (operation) => operation.operationKind === 'entry.create'
        ? { opId: operation.opId, status: 'applied', entityId: 2, resourceVersion: 1, serverSeq: 2 }
        : { opId: operation.opId, status: 'conflict', currentVersion: 2, currentValues: { contents: [] }, serverSeq: 3 }),
      fetchSyncSnapshot: vi.fn().mockRejectedValue(new TypeError('refresh unavailable')),
    } as unknown as GalleryApi, store, { clientId: 'client', randomUUID: () => ids.shift()! });
    const { localKey } = await api.enqueueOfflineEntryCreate!({
      title: 'Draft', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: false, coverFile: null, previewFile: null,
    });
    await api.enqueueOfflinePendingEntryContent!(localKey, { contentType: 'Notes', content: 'first' });
    await api.flushOfflineOutbox!();
    expect((await store.list()).map(({ status }) => status)).toEqual(['pending', 'conflict']);
    await expect(api.enqueueOfflinePendingEntryContent!(localKey, { contentType: 'Notes', content: 'second' }))
      .rejects.toThrow(/blocked/i);
    expect((await store.list())).toHaveLength(2);
  });

  it('retains a replayed append if the refreshed snapshot omits its Content identity', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    await store.writeMeta('capability.offlineEntryContentAppend', '1');
    const entryUid = '22222222-2222-4222-8222-222222222222';
    const ids = [entryUid, '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
    const refreshed = structuredClone(offlineSnapshot());
    refreshed.header.snapshotSeq = 2;
    refreshed.header.changeSeq = 3;
    refreshed.header.counts.entries = 2;
    refreshed.payload.entries.push({ ...refreshed.payload.entries[0]!, id: 2, syncUid: entryUid, syncVersion: 2, title: 'Draft' });
    await stampChecksum(refreshed);
    const replay = vi.fn().mockImplementation(async (operation) => ({
      opId: operation.opId, status: 'applied', entityId: 2,
      resourceVersion: operation.operationKind === 'entry.create' ? 1 : 2,
      serverSeq: operation.operationKind === 'entry.create' ? 2 : 3,
    }));
    const api = createOfflineAwareGalleryApi({
      replaySyncOperation: replay, fetchSyncSnapshot: vi.fn().mockResolvedValue(refreshed),
    } as unknown as GalleryApi, store, { clientId: 'client', randomUUID: () => ids.shift()! });
    const { localKey } = await api.enqueueOfflineEntryCreate!({
      title: 'Draft', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: false, coverFile: null, previewFile: null,
    });
    await api.enqueueOfflinePendingEntryContent!(localKey, { contentType: 'Notes', content: 'must not be lost' });
    await api.flushOfflineOutbox!();
    expect(replay).toHaveBeenCalledTimes(2);
    expect(await store.list()).toHaveLength(2);
    expect((await readActiveSnapshot(store))?.snapshot.header.snapshotSeq).toBe(1);
  });

  it('clears a replayed append only after the authoritative snapshot contains its Content UID', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    await store.writeMeta('capability.offlineEntryContentAppend', '1');
    const entryUid = '22222222-2222-4222-8222-222222222222';
    const contentUid = '44444444-4444-4444-8444-444444444444';
    const ids = [entryUid, '33333333-3333-4333-8333-333333333333', contentUid,
      '55555555-5555-4555-8555-555555555555'];
    const refreshed = structuredClone(offlineSnapshot());
    refreshed.header.snapshotSeq = 2;
    refreshed.header.changeSeq = 3;
    refreshed.header.counts.entries = 2;
    refreshed.header.counts.entryContents = 1;
    refreshed.payload.entries.push({ ...refreshed.payload.entries[0]!, id: 2, syncUid: entryUid, syncVersion: 2, title: 'Draft' });
    refreshed.payload.entryContents.push({ id: 80, entryId: 2, syncUid: contentUid,
      contentType: 'Notes', content: 'must survive', sortOrder: 0 });
    await stampChecksum(refreshed);
    const replay = vi.fn().mockImplementation(async (operation) => ({
      opId: operation.opId, status: 'applied', entityId: 2,
      resourceVersion: operation.operationKind === 'entry.create' ? 1 : 2,
      serverSeq: operation.operationKind === 'entry.create' ? 2 : 3,
    }));
    const api = createOfflineAwareGalleryApi({
      replaySyncOperation: replay, fetchSyncSnapshot: vi.fn().mockResolvedValue(refreshed),
    } as unknown as GalleryApi, store, { clientId: 'client', randomUUID: () => ids.shift()! });
    const { localKey } = await api.enqueueOfflineEntryCreate!({
      title: 'Draft', type: 'game', uploadDate: null, pageCount: null,
      ratings: [], viewLater: false, coverFile: null, previewFile: null,
    });
    await api.enqueueOfflinePendingEntryContent!(localKey, { contentType: 'Notes', content: 'must survive' });
    await api.flushOfflineOutbox!();
    expect(replay).toHaveBeenCalledTimes(2);
    expect(await store.list()).toHaveLength(0);
    expect((await readActiveSnapshot(store))?.snapshot.payload.entryContents).toContainEqual(
      expect.objectContaining({ entryId: 2, syncUid: contentUid }),
    );
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
      canAppendContent: false,
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

  it('stages every selected preview in order when the server advertises multi-preview replay', async () => {
    const store = await populatedOfflineStore();
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', sqliteSchemaVersion: 32,
        snapshotFormatVersion: 2, syncProtocolVersion: 1, serverBuild: 'test',
        featureFlags: { offlineMutations: true, offlineEntryCreate: true,
          offlineMediaUpload: true, offlineMediaMultiplePreviews: true },
      }),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      randomUUID: () => crypto.randomUUID(), clientId: 'test-client',
    });
    await api.getSyncCapabilities();
    const preview1 = new NodeFile([new Uint8Array([1, 2])], 'first.png',
      { type: 'image/png' }) as unknown as File;
    const preview2 = new NodeFile([new Uint8Array([3, 4])], 'second.png',
      { type: 'image/png' }) as unknown as File;
    await api.enqueueOfflineEntryCreate?.({ title: 'All previews', type: 'game',
      uploadDate: null, pageCount: null, ratings: [], viewLater: false,
      coverFile: null, previewFile: null, previewFiles: [preview1, preview2] });
    const media = await store.listMedia();
    expect(media).toHaveLength(2);
    expect(media.map(({ kind, ordinal }) => ({ kind, ordinal }))).toEqual([
      { kind: 'preview', ordinal: 0 }, { kind: 'preview', ordinal: 1 },
    ]);
    expect([...new Uint8Array(await media[0]!.blob.arrayBuffer())]).toEqual([1, 2]);
    expect([...new Uint8Array(await media[1]!.blob.arrayBuffer())]).toEqual([3, 4]);
  });

  it('replays shuffled previews in ordinal order and retains both across a lost upload response', async () => {
    const store = await populatedOfflineStore();
    const uid = '22222222-2222-4222-8222-222222222222';
    const ids = [uid, '33333333-3333-4333-8333-333333333333',
      '77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111'];
    const refreshed = structuredClone(offlineSnapshot());
    refreshed.header.snapshotSeq = 2;
    refreshed.header.changeSeq = 3;
    refreshed.header.counts.entries = 2;
    const refs = ['/api/assets/entries/2/preview.png', '/api/assets/entries/2/preview-2.png'];
    refreshed.payload.entries.push({ ...refreshed.payload.entries[0]!, id: 2,
      syncUid: uid, syncVersion: 3, title: 'Resumable previews', previewRef: refs[0]!, previewRefs: refs });
    await stampChecksum(refreshed);
    let lostSecondResponse = true;
    const uploadSyncMedia = vi.fn().mockImplementation(async (uploadId, metadata) => {
      if (metadata.ordinal === 1 && lostSecondResponse) {
        lostSecondResponse = false;
        throw new TypeError('upload response lost');
      }
      return { uploadId, status: 'applied', entityId: 2,
        relativeRef: refs[metadata.ordinal], resourceVersion: metadata.ordinal + 2, serverSeq: 3 };
    });
    const online = {
      getSyncCapabilities: vi.fn().mockResolvedValue({
        libraryId: 'library-1', syncEpoch: 'epoch-1', sqliteSchemaVersion: 32,
        snapshotFormatVersion: 2, syncProtocolVersion: 1, serverBuild: 'test',
        featureFlags: { offlineMutations: true, offlineEntryCreate: true,
          offlineMediaUpload: true, offlineMediaMultiplePreviews: true },
      }),
      replaySyncOperation: vi.fn(async (operation) => ({ opId: operation.opId,
        status: 'applied', entityId: 2, resourceVersion: 1, serverSeq: 2 })),
      uploadSyncMedia, fetchSyncSnapshot: vi.fn().mockResolvedValue(refreshed),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      randomUUID: () => ids.shift()!, clientId: 'test-client',
    });
    await api.getSyncCapabilities();
    const first = new NodeFile([new Uint8Array([1])], 'first.png',
      { type: 'image/png' }) as unknown as File;
    const second = new NodeFile([new Uint8Array([2])], 'second.png',
      { type: 'image/png' }) as unknown as File;
    await api.enqueueOfflineEntryCreate?.({ title: 'Resumable previews', type: 'game',
      uploadDate: null, pageCount: null, ratings: [], viewLater: false,
      coverFile: null, previewFile: null, previewFiles: [first, second] });
    const listMedia = store.listMedia.bind(store);
    vi.spyOn(store, 'listMedia').mockImplementation(async () => (
      (await listMedia()).sort((a, b) => a.uploadId.localeCompare(b.uploadId))
    ));
    await api.flushOfflineOutbox?.();
    expect(uploadSyncMedia.mock.calls.map((call) => call[1].ordinal)).toEqual([0, 1]);
    expect(await store.listMedia()).toHaveLength(2);
    expect(await store.list()).toHaveLength(1);
    const resumed = createOfflineAwareGalleryApi(online, store, { clientId: 'test-client' });
    await resumed.flushOfflineOutbox?.();
    expect(uploadSyncMedia.mock.calls.map((call) => call[1].ordinal)).toEqual([0, 1, 0, 1]);
    expect(uploadSyncMedia.mock.calls[0]![0]).toBe(uploadSyncMedia.mock.calls[2]![0]);
    expect(uploadSyncMedia.mock.calls[1]![0]).toBe(uploadSyncMedia.mock.calls[3]![0]);
    expect(await store.listMedia()).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect((await readActiveSnapshot(store))?.snapshot.payload.entries[1]?.previewRefs).toEqual(refs);
  });

  it('keeps the whole multi-preview create pending if capability is revoked before replay', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    await store.writeMeta('capability.offlineMediaUpload', '1');
    await store.writeMeta('capability.offlineMediaMultiplePreviews', '1');
    const replay = vi.fn(async (operation) => ({ opId: operation.opId,
      status: 'applied', entityId: 2, resourceVersion: 1, serverSeq: 2 }));
    const upload = vi.fn();
    const api = createOfflineAwareGalleryApi({ replaySyncOperation: replay,
      uploadSyncMedia: upload } as unknown as GalleryApi, store, {
      randomUUID: () => crypto.randomUUID(), clientId: 'test-client',
    });
    const file = new NodeFile([new Uint8Array([1])], 'preview.png',
      { type: 'image/png' }) as unknown as File;
    await api.enqueueOfflineEntryCreate?.({ title: 'Downgraded server', type: 'game',
      uploadDate: null, pageCount: null, ratings: [], viewLater: false,
      coverFile: null, previewFile: null, previewFiles: [file, file] });
    await store.writeMeta('capability.offlineMediaMultiplePreviews', '0');
    await api.flushOfflineOutbox?.();
    expect(replay).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
    expect((await store.listMedia()).map((media) => media.status)).toEqual(['pending', 'pending']);
  });

  it('leaves later previews pending after a permanent earlier failure and discards the dependent group together', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    await store.writeMeta('capability.offlineMediaUpload', '1');
    await store.writeMeta('capability.offlineMediaMultiplePreviews', '1');
    const upload = vi.fn().mockRejectedValue(new ApiError(400, { message: 'invalid first image' }));
    const online = {
      replaySyncOperation: vi.fn(async (operation) => ({ opId: operation.opId,
        status: 'applied', entityId: 2, resourceVersion: 1, serverSeq: 2 })),
      uploadSyncMedia: upload,
      fetchSyncSnapshot: vi.fn().mockRejectedValue(new TypeError('snapshot offline')),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      randomUUID: () => crypto.randomUUID(), clientId: 'test-client',
    });
    const file = new NodeFile([new Uint8Array([1])], 'preview.png',
      { type: 'image/png' }) as unknown as File;
    await api.enqueueOfflineEntryCreate?.({ title: 'Failed first image', type: 'game',
      uploadDate: null, pageCount: null, ratings: [], viewLater: false,
      coverFile: null, previewFile: null, previewFiles: [file, file] });
    await api.flushOfflineOutbox?.();
    expect(upload).toHaveBeenCalledTimes(1);
    expect((await store.listMedia()).map(({ ordinal, status }) => ({ ordinal, status }))).toEqual([
      { ordinal: 0, status: 'failed' }, { ordinal: 1, status: 'pending' },
    ]);
    await api.discardBlockedOfflineOperations?.();
    expect(await store.listMedia()).toEqual([]);
  });

  it('refuses multi-preview staging without a matching server capability and retains an empty outbox', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryCreate', '1');
    await store.writeMeta('capability.offlineMediaUpload', '1');
    const api = createOfflineAwareGalleryApi({} as GalleryApi, store, {
      randomUUID: () => crypto.randomUUID(), clientId: 'test-client',
    });
    const file = new NodeFile([new Uint8Array([1])], 'preview.png',
      { type: 'image/png' }) as unknown as File;
    await expect(api.enqueueOfflineEntryCreate?.({ title: 'Old server', type: 'game',
      uploadDate: null, pageCount: null, ratings: [], viewLater: false,
      coverFile: null, previewFile: null, previewFiles: [file, file] }))
      .rejects.toThrow(/multiple previews|multi-preview/i);
    expect(await store.list()).toEqual([]);
    expect(await store.listMedia()).toEqual([]);
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
      // The offline snapshot carries no Author rating dimensions, so there is nothing to filter by.
      ratingSlots: [],
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
      const store = await populatedStore();
      const api = createOfflineAwareGalleryApi(online, store);

      expect(await api.listGalleries()).toEqual([{ type: 'game', entryCount: 1, nsfw: false }]);
      expect(await store.readMeta('t3.offline-client-id'))
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps authoritative Entry Content HTTP errors and queues nothing', async () => {
    const store = await populatedOfflineStore();
    const online = {
      createEntryContent: vi.fn().mockRejectedValue(new ApiError(422, { message: 'invalid Content' })),
    } as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store);

    await expect(api.createEntryContent(1, { contentType: 'Note', content: 'draft' }))
      .rejects.toMatchObject({ status: 422 });
    expect(await store.list()).toEqual([]);
  });

  it('queues an atomic Entry Content list edit, create, reorder, and delete while offline', async () => {
    const store = await populatedOfflineStore();
    await store.writeMeta('capability.offlineEntryContents', '1');
    const existingUid = '12121212-1212-4212-8212-121212121212';
    const snapshot = offlineSnapshot();
    snapshot.header.counts.entryContents = 1;
    snapshot.payload.entryContents = [{
      id: 12, entryId: 1, syncUid: existingUid, syncVersion: 1,
      contentType: 'Source URL', content: 'https://old.test', sortOrder: 0,
    }];
    await store.writeGeneration(1, JSON.stringify(snapshot));
    const ids = [
      '13131313-1313-4313-8313-131313131313',
      '14141414-1414-4414-8414-141414141414',
      '15151515-1515-4515-8515-151515151515',
      '16161616-1616-4616-8616-161616161616',
      '17171717-1717-4717-8717-171717171717',
      '18181818-1818-4818-8818-181818181818',
    ];
    const online = {} as unknown as GalleryApi;
    const api = createOfflineAwareGalleryApi(online, store, {
      state: { mode: 'offline', lastFallbackAt: null },
      clientId: '19191919-1919-4919-8919-191919191919',
      randomUUID: () => ids.shift() ?? '20202020-2020-4020-8020-202020202020',
    });

    const created = await api.createEntryContent(1, { contentType: 'Note', content: 'draft', sortOrder: 0 });
    expect(created.id).toBeLessThan(0);
    expect((await api.getEntry(1)).contents.map((content) => content.id)).toEqual([12, created.id]);
    await api.updateEntryContent(12, { content: 'https://new.test' });
    await api.reorderEntryContents(1, [created.id, 12]);
    await api.deleteEntryContent(12);

    const detail = await api.getEntry(1);
    expect(detail.contents).toHaveLength(1);
    expect(detail.contents[0]).toMatchObject({ contentType: 'Note', content: 'draft', sortOrder: 0 });
    const operations = await store.list();
    expect(operations).toHaveLength(4);
    expect(operations.map((item) => item.operationKind)).toEqual(Array(4).fill('entry.contents.set'));
    expect(operations.every((item) => item.entityUid === snapshot.payload.entries[0]?.syncUid)).toBe(true);
    expect(operations[1]?.baseVersion).toBe((operations[0]?.baseVersion ?? 0) + 1);
    expect(operations[2]?.baseVersion).toBe((operations[1]?.baseVersion ?? 0) + 1);
    expect(operations[3]?.baseVersion).toBe((operations[2]?.baseVersion ?? 0) + 1);
  });
});
