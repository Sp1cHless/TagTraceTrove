// @vitest-environment jsdom

import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import type { SyncSnapshot } from '@t3/shared';
import type { GalleryApi } from '../src/api/gallery.js';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { clearOfflineSnapshot } from '../src/offline/offline-sync.js';
import { applySnapshot, ACTIVE_GENERATION_KEY } from '../src/offline/snapshot-store.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
import { createPendingSyncOperation } from '../src/offline/outbox-store.js';

const databaseNames: string[] = [];

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('failed to delete IndexedDB fixture'));
    request.onblocked = () => reject(new Error('IndexedDB fixture deletion was blocked'));
  });
}

function createLegacyV1Database(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('snapshotGenerations');
      request.result.createObjectStore('meta');
    };
    request.onerror = () => reject(request.error ?? new Error('failed to create v1 fixture'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(['snapshotGenerations', 'meta'], 'readwrite');
      transaction.objectStore('snapshotGenerations').put('{"snapshotSeq":1}', 1);
      transaction.objectStore('meta').put('1', 'activeGeneration');
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error ?? new Error('failed to seed v1 fixture'));
    };
  });
}

afterEach(async () => {
  for (const name of databaseNames.splice(0)) await deleteDatabase(name);
});

describe('IndexedDB snapshot store', () => {
  it('cold-reopens independent pending metadata patches and keeps their parent during atomic cleanup', async () => {
    const databaseName = `t3-offline-test-${crypto.randomUUID()}`; databaseNames.push(databaseName);
    const original = createIndexedDbOfflineStore({ indexedDB, databaseName });
    const clientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', uid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await original.writeGeneration(1, JSON.stringify(offlineSnapshot())); await original.writeMeta(ACTIVE_GENERATION_KEY, '1');
    await original.writeMeta('capability.offlinePendingEntryMetadata', '1');
    const parent = createPendingSyncOperation({clientId,libraryId:'library-1',syncEpoch:'epoch-1',entityKind:'entry',entityUid:uid,operationKind:'entry.create',baseVersion:0,baseValues:{},payload:{title:'Pending',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false}});
    await original.enqueue(parent);
    await createOfflineAwareGalleryApi({} as GalleryApi, original, {clientId}).enqueueOfflinePendingEntryMetadata!(`local:${uid}`, {title:'Changed',uploadDate:null,pageCount:null});
    const saved = await original.list(); original.close();
    const reopened = createIndexedDbOfflineStore({indexedDB,databaseName});
    try {
      const api = createOfflineAwareGalleryApi({} as GalleryApi,reopened,{clientId});
      expect(await reopened.list()).toEqual(saved);
      expect((await api.listPendingOfflineEntryCreates!())[0]).toMatchObject({title:'Changed',canEditMetadata:true,metadataEditStatus:'pending'});
      await api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Changed',uploadDate:null,pageCount:42});
      await reopened.removeApplied(saved.map(row=>row.opId));
      expect((await reopened.list()).map(row=>row.operationKind)).toEqual(['entry.create','entry.update']);
      expect((await reopened.list())[0]).toEqual(parent);
    } finally { reopened.close(); }
  });
  it('cold-reopens pending Entry Author children with persisted capability and immutable parent', async () => {
    const databaseName = `t3-offline-test-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    const original = createIndexedDbOfflineStore({ indexedDB, databaseName });
    const clientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const uid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const producerUid = '99999999-9999-4999-8999-999999999999';
    await original.writeGeneration(1, JSON.stringify(offlineSnapshot()));
    await original.writeMeta(ACTIVE_GENERATION_KEY, '1');
    await original.writeMeta('capability.offlinePendingEntryAuthors', '1');
    const parent = createPendingSyncOperation({clientId,libraryId:'library-1',syncEpoch:'epoch-1',entityKind:'entry',entityUid:uid,operationKind:'entry.create',baseVersion:0,baseValues:{},payload:{title:'Pending',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false}});
    await original.enqueue(parent);
    const first = createOfflineAwareGalleryApi({} as GalleryApi, original, {clientId});
    await first.enqueueOfflinePendingEntryAuthors!(`local:${uid}`, [producerUid]);
    const saved = await original.list();
    original.close();
    const reopened = createIndexedDbOfflineStore({ indexedDB, databaseName });
    try {
      const api = createOfflineAwareGalleryApi({} as GalleryApi, reopened, {clientId});
      expect(await reopened.list()).toEqual(saved);
      expect((await api.listPendingOfflineEntryCreates!())[0]).toMatchObject({canEditAuthors:true,authors:[{producerUid,name:'Offline Author'}],authorStatus:'pending',authorLastError:null});
      expect(await api.getPendingOfflineEntryAuthorOptions!(`local:${uid}`)).toEqual({authors:[{producerUid,name:'Offline Author'}]});
      await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`, []);
      expect((await reopened.list())[0]).toEqual(parent);
      expect((await reopened.list())[2]!.baseValues).toEqual({producerUids:[producerUid]});
    } finally { reopened.close(); }
  });
  it('cold-opens a saved Entry from IndexedDB while the paired server never responds', async () => {
    const databaseName = `t3-offline-test-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    const original = createIndexedDbOfflineStore({ indexedDB, databaseName });
    const snapshot: SyncSnapshot = {
      header: {
        libraryId: 'library-1', syncEpoch: 'epoch-1', snapshotSeq: 1, changeSeq: 0,
        generatedAt: '2026-09-23T00:00:00Z', sqliteSchemaVersion: 21,
        snapshotFormatVersion: 2,
        counts: { entries: 1, producers: 0, entryContents: 0, entryTags: 0, collections: 0 },
        checksum: '',
      },
      payload: {
        entries: [{ id: 1, syncUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', syncVersion: 1,
          title: 'Saved work', type: 'game', coverRef: null, previewRef: null, previewRefs: [],
          pageCount: null, uploadDate: null, createdAt: '2026-09-23', updatedAt: '2026-09-23' }],
        producers: [], entryProducers: [], tags: [], tagGroups: [], entryTags: [],
        producerTags: [], producerTagAssignments: [], entryContents: [], ratingSlots: [],
        entryRatingValues: [], producerRatingValues: [], collections: [], collectionMembers: [],
        authorDirectories: [], authorDirectoryEntries: [], entryUsage: [], viewLaterEntries: [],
        viewLaterProducers: [], gallerySettings: [], mediaRefs: [],
      },
    };
    const { checksum, ...unsignedHeader } = snapshot.header;
    void checksum;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
      JSON.stringify(unsignedHeader) + JSON.stringify(snapshot.payload),
    ));
    snapshot.header.checksum = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(await applySnapshot(snapshot, { store: original })).toMatchObject({ ok: true });
    original.close();

    const reopened = createIndexedDbOfflineStore({ indexedDB, databaseName });
    const remoteRead = vi.fn(() => new Promise<never>(() => undefined));
    const online = { listGalleries: remoteRead } as unknown as GalleryApi;
    const state = { mode: 'online' as 'online' | 'offline', lastFallbackAt: null as string | null };
    const api = createOfflineAwareGalleryApi(online, reopened, { state });
    expect(await api.preferOfflineSnapshot?.()).toBe(true);
    expect(state.mode).toBe('offline');
    expect((await api.listGalleries())[0]?.type).toBe('game');
    expect(remoteRead).not.toHaveBeenCalled();
    reopened.close();
  });

  it('persists snapshot generations and metadata across store instances', async () => {
    const databaseName = `t3-offline-test-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    const first = createIndexedDbOfflineStore({ indexedDB, databaseName });

    await first.writeGeneration(2, '{"snapshotSeq":2}');
    await first.writeGeneration(1, '{"snapshotSeq":1}');
    await first.writeMeta('activeGeneration', '2');
    first.close();

    const reopened = createIndexedDbOfflineStore({ indexedDB, databaseName });
    expect(await reopened.listGenerationIds()).toEqual([1, 2]);
    expect(await reopened.readGeneration(2)).toBe('{"snapshotSeq":2}');
    expect(await reopened.readMeta('activeGeneration')).toBe('2');

    await reopened.deleteGeneration(1);
    expect(await reopened.listGenerationIds()).toEqual([2]);
    reopened.close();
  });

  it('upgrades v1 without losing snapshots and preserves outbox rows across restart and snapshot clear', async () => {
    const databaseName = `t3-offline-test-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    await createLegacyV1Database(databaseName);
    const operation = createPendingSyncOperation({
      clientId: '11111111-1111-4111-8111-111111111111',
      libraryId: 'library-1',
      syncEpoch: 'epoch-1',
      entityKind: 'entry',
      entityUid: '22222222-2222-4222-8222-222222222222',
      operationKind: 'entry.patch',
      baseVersion: 3,
      baseValues: { title: 'Before' },
      payload: { title: 'After' },
    });
    const secondOperation = {
      ...operation,
      opId: '00000000-0000-4000-8000-000000000000',
      entityKind: 'rating',
      entityUid: '44444444-4444-4444-8444-444444444444',
      operationKind: 'rating.set',
      payload: { stars: 4.5 },
    };
    const createOperation = {
      ...operation,
      opId: '55555555-5555-4555-8555-555555555555',
      entityUid: '66666666-6666-4666-8666-666666666666',
      operationKind: 'entry.create',
      baseVersion: 0,
      baseValues: {},
      payload: { title: 'Queued create', type: 'game' },
    };
    const stagedMedia = {
      uploadId: '77777777-7777-4777-8777-777777777777',
      libraryId: '11111111-1111-4111-8111-111111111111',
      syncEpoch: 'epoch-1',
      entryUid: createOperation.entityUid,
      kind: 'cover' as const,
      ordinal: 0 as const,
      mimeType: 'image/png' as const,
      byteLength: 4,
      sha256: 'a'.repeat(64),
      blob: new NodeBlob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }) as unknown as Blob,
      status: 'pending' as const,
      lastAttemptAt: null,
      lastError: null,
    };
    const upgraded = createIndexedDbOfflineStore({ indexedDB, databaseName });

    expect(await upgraded.readGeneration(1)).toBe('{"snapshotSeq":1}');
    expect(await upgraded.enqueue(operation)).toBe('queued');
    expect(await upgraded.enqueue(secondOperation)).toBe('queued');
    await upgraded.enqueueEntryCreate(createOperation, [stagedMedia]);
    await upgraded.update(operation.opId, {
      status: 'conflict',
      lastAttemptAt: '2026-09-14T12:01:00.000Z',
      lastError: 'newer server value',
    });
    const conflictedOperation = {
      ...operation,
      status: 'conflict' as const,
      lastAttemptAt: '2026-09-14T12:01:00.000Z',
      lastError: 'newer server value',
    };
    upgraded.close();

    const reopened = createIndexedDbOfflineStore({ indexedDB, databaseName });
    expect(await reopened.list()).toEqual([conflictedOperation, secondOperation, createOperation]);
    const reopenedMedia = await reopened.listMedia();
    expect(reopenedMedia).toHaveLength(1);
    expect(reopenedMedia[0]).toMatchObject({
      uploadId: stagedMedia.uploadId,
      entryUid: stagedMedia.entryUid,
      sha256: stagedMedia.sha256,
      status: 'pending',
    });
    expect([...new Uint8Array(await reopenedMedia[0]!.blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    await expect(clearOfflineSnapshot(reopened)).rejects.toThrow(/unsynced/i);
    expect(await reopened.readGeneration(1)).not.toBeNull();
    expect(await reopened.list()).toEqual([conflictedOperation, secondOperation, createOperation]);
    expect(await reopened.listMedia()).toHaveLength(1);
    await reopened.removeMany([
      operation.opId,
      secondOperation.opId,
      createOperation.opId,
      'missing-op-id',
    ]);
    expect(await reopened.list()).toEqual([]);
    await reopened.removeMedia(stagedMedia.uploadId);
    expect(await reopened.listMedia()).toEqual([]);
    await clearOfflineSnapshot(reopened);
    expect(await reopened.readGeneration(1)).toBeNull();
    reopened.close();
  });

  it('cold-reopens the pending Tag parent and causal edits with their saved capability and Facets', async () => {
    const name = `t3-offline-test-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const first = createIndexedDbOfflineStore({ indexedDB, databaseName: name });
    const snapshot = offlineSnapshot();
    snapshot.payload.tagGroups = [
      { id: 2, entryType: 'game', name: 'Tags', groupKind: 'section', parentId: null, sortOrder: 0 },
      { id: 1, entryType: 'game', name: 'Genre', groupKind: 'facet', parentId: 2, sortOrder: 0 },
      { id: 3, entryType: 'game', name: 'Theme', groupKind: 'facet', parentId: 2, sortOrder: 1 },
    ];
    await first.writeGeneration(1, JSON.stringify(snapshot));
    await first.writeMeta(ACTIVE_GENERATION_KEY, '1');
    await first.writeMeta('capability.offlineEntryCreate', '1');
    await first.writeMeta('capability.offlinePendingEntryTags', '1');
    const api = createOfflineAwareGalleryApi({} as GalleryApi, first, { clientId: 'cold-tag-client' });
    const created = await api.enqueueOfflineEntryCreate!({ title: 'Cold Tag draft', type: 'game',
      uploadDate: null, pageCount: null, ratings: [], viewLater: false, coverFile: null, previewFile: null });
    await api.enqueueOfflinePendingEntryTags!(created.localKey, [{ name: 'RPG', facetId: 1 }]);
    await api.enqueueOfflinePendingEntryTags!(created.localKey, [{ name: 'RPG', facetId: 3 }]);
    const before = await first.list();
    first.close();
    const reopened = createIndexedDbOfflineStore({ indexedDB, databaseName: name });
    try {
      const restarted = createOfflineAwareGalleryApi({} as GalleryApi, reopened, { clientId: 'cold-tag-client' });
      expect(await reopened.list()).toEqual(before);
      expect((await restarted.getPendingOfflineEntryTagOptions!(created.localKey)).tags).toEqual([{ name: 'RPG', facetId: 3 }]);
      expect((await restarted.listPendingOfflineEntryCreates!())[0]).toMatchObject({
        localKey: created.localKey, canEditTags: true, tagEditStatus: 'pending', tags: [{ name: 'RPG', facetId: 3 }],
      });
      await expect(clearOfflineSnapshot(reopened)).rejects.toThrow(/unsynced/i);
      expect(await reopened.list()).toEqual(before);
    } finally { reopened.close(); }
  });

  it('cold-reopens the immutable Source and following Note Content identities and order', async () => {
    const name = `t3-offline-test-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const first = createIndexedDbOfflineStore({ indexedDB, databaseName: name });
    const operation = createPendingSyncOperation({
      clientId: 'source-client',
      libraryId: 'library-1', syncEpoch: 'epoch-1', entityKind: 'entry',
      entityUid: '22222222-2222-4222-8222-222222222222', operationKind: 'entry.create',
      baseVersion: 0, baseValues: {},
      payload: { title: 'Source draft', type: 'game', uploadDate: null, pageCount: null,
        ratings: [], viewLater: false, contents: [
          { syncUid: '33333333-3333-4333-8333-333333333333', contentType: 'Source URL', content: 'https://example.test/read#page-2', sortOrder: 0 },
          { syncUid: '44444444-4444-4444-8444-444444444444', contentType: 'Notes', content: 'Saved note', sortOrder: 1 },
        ] },
    });
    await first.enqueueEntryCreate(operation, []);
    first.close();
    const reopened = createIndexedDbOfflineStore({ indexedDB, databaseName: name });
    try {
      expect(await reopened.list()).toEqual([operation]);
    } finally { reopened.close(); }
  });

  it('cold-reopens every staged Preview blob with its ordinal despite upload-ID key ordering', async () => {
    const name = `t3-offline-test-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const first = createIndexedDbOfflineStore({ indexedDB, databaseName: name });
    const operation = createPendingSyncOperation({
      clientId: '11111111-1111-4111-8111-111111111111', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'entry', entityUid: '22222222-2222-4222-8222-222222222222',
      operationKind: 'entry.create', baseVersion: 0, baseValues: {}, payload: { title: 'Previews', type: 'game' },
    });
    const uploads = [
      { uploadId: '77777777-7777-4777-8777-777777777777', ordinal: 0, bytes: [1, 2] },
      { uploadId: '33333333-3333-4333-8333-333333333333', ordinal: 1, bytes: [3, 4] },
      { uploadId: '11111111-1111-4111-8111-111111111111', ordinal: 2, bytes: [5, 6] },
    ].map(({ uploadId, ordinal, bytes }) => ({ uploadId, ordinal,
      libraryId: operation.libraryId, syncEpoch: operation.syncEpoch, entryUid: operation.entityUid,
      kind: 'preview' as const, mimeType: 'image/png' as const,
      byteLength: bytes.length, sha256: 'a'.repeat(64), blob: new NodeBlob([new Uint8Array(bytes)]) as unknown as Blob,
      status: 'pending' as const, lastAttemptAt: null, lastError: null }));
    await first.enqueueEntryCreate(operation, uploads);
    first.close();
    const reopened = createIndexedDbOfflineStore({ indexedDB, databaseName: name });
    try {
      expect(await reopened.list()).toEqual([operation]);
      const media = await reopened.listMedia();
      expect(media.map((upload) => upload.ordinal)).toEqual([0, 1, 2]);
      const ordered = media.sort((a, b) => a.ordinal - b.ordinal);
      expect(await Promise.all(ordered.map(async (upload) => [...new Uint8Array(await upload.blob.arrayBuffer())])))
        .toEqual([[1, 2], [3, 4], [5, 6]]);
      await expect(clearOfflineSnapshot(reopened)).rejects.toThrow(/unsynced/i);
      expect(await reopened.listMedia()).toHaveLength(3);
    } finally {
      reopened.close();
    }
  });

  it('atomically rejects two queued Entry creates for the same library identity', async () => {
    const name = `t3-offline-test-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const store = createIndexedDbOfflineStore({ indexedDB, databaseName: name });
    const first = createPendingSyncOperation({
      clientId: '11111111-1111-4111-8111-111111111111', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'entry', entityUid: '22222222-2222-4222-8222-222222222222',
      operationKind: 'entry.create', baseVersion: 0, baseValues: {}, payload: { title: 'First', type: 'game' },
    });
    const second = {
      ...first, opId: '33333333-3333-4333-8333-333333333333',
      payload: { title: 'Another draft', type: 'game' },
    };
    const results = await Promise.allSettled([
      store.enqueueEntryCreate(first, []), store.enqueueEntryCreate(second, []),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await store.list()).toHaveLength(1);
    expect((await store.list())[0]?.entityUid).toBe(first.entityUid);
    store.close();
  });
});
