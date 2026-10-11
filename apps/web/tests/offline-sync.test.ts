// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { SyncCapabilities, SyncSnapshot } from '@t3/shared';
import { createMemorySnapshotStore, readActiveSnapshot } from '../src/offline/snapshot-store.js';
import { clearOfflineSnapshot, downloadOfflineSnapshot } from '../src/offline/offline-sync.js';
import { createMemoryOutboxStore, createPendingSyncOperation } from '../src/offline/outbox-store.js';

function capabilities(overrides: Partial<SyncCapabilities> = {}): SyncCapabilities {
  return {
    libraryId: 'library-1',
    syncEpoch: 'epoch-1',
    sqliteSchemaVersion: 21,
    snapshotFormatVersion: 2,
    syncProtocolVersion: 1,
    serverBuild: 'test',
    featureFlags: { readOnlySnapshot: true, offlineMutations: false },
    ...overrides,
  };
}

async function snapshot(overrides: Partial<SyncSnapshot['header']> = {}): Promise<SyncSnapshot> {
  const header = {
    libraryId: 'library-1',
    syncEpoch: 'epoch-1',
    snapshotSeq: 1,
    changeSeq: 0,
    generatedAt: '2026-09-13T00:00:00.000Z',
    sqliteSchemaVersion: 21,
    snapshotFormatVersion: 2,
    counts: { entries: 1, producers: 0, entryContents: 0, entryTags: 0, collections: 0 },
    ...overrides,
  };
  const value: SyncSnapshot = {
    header: { ...header, checksum: '' },
    payload: {
      entries: [{
        id: 1, title: 'Endfield', type: 'game', coverRef: null, previewRef: null,
        previewRefs: [], pageCount: null, uploadDate: null,
        createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
      }],
      producers: [], entryProducers: [], tags: [], tagGroups: [], entryTags: [],
      producerTags: [], producerTagAssignments: [], entryContents: [], ratingSlots: [],
      entryRatingValues: [], producerRatingValues: [], collections: [], collectionMembers: [],
      authorDirectories: [], authorDirectoryEntries: [], entryUsage: [], viewLaterEntries: [],
      viewLaterProducers: [], gallerySettings: [], mediaRefs: [],
    },
  };
  const { checksum, ...unsignedHeader } = value.header;
  void checksum;
  const bytes = new TextEncoder().encode(JSON.stringify(unsignedHeader) + JSON.stringify(value.payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  value.header.checksum = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return value;
}

describe('offline snapshot download', () => {
  it('materializes a full verified snapshot despite a feed transport and never acknowledges unapplied records', async () => {
    const store = createMemorySnapshotStore();
    const old = await snapshot({ changeSeq: 1 });
    await store.writeGeneration(1, JSON.stringify(old));
    await store.writeMeta('activeGeneration', '1');
    const next = await snapshot({ changeSeq: 2, snapshotSeq: 2 });
    next.payload.tags.push({ id: 7, name: 'Unjournaled tag', normalizedName: 'unjournaled tag' });
    const { checksum: _checksum, ...unsigned } = next.header;
    void _checksum;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(unsigned) + JSON.stringify(next.payload)));
    next.header.checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    let reads = 0;
    let acks = 0;
    const api = Object.assign({
      async getSyncCapabilities() { return capabilities(); },
      async fetchSyncSnapshot() { return next; },
    }, {
      async fetchSyncChanges() { reads++; return { changes: [], nextSeq: 1, highWaterSeq: 1, ackSeq: 0 }; },
      async ackSyncChanges() { acks++; return { ackSeq: 1 }; },
    });
    const result = await downloadOfflineSnapshot({ store, api });
    expect(result.ok).toBe(true);
    expect((await readActiveSnapshot(store))?.snapshot.payload.tags[0]?.name).toBe('Unjournaled tag');
    expect(reads).toBe(0);
    expect(acks).toBe(0);
  });
  it('refuses epoch replacement while unsynced work still needs the old snapshot', async () => {
    const store = Object.assign(createMemorySnapshotStore(), createMemoryOutboxStore());
    const original = await snapshot();
    await store.writeGeneration(1, JSON.stringify(original));
    await store.writeMeta('activeGeneration', '1');
    await store.enqueue(createPendingSyncOperation({
      clientId: 'client-1', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'entry', entityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operationKind: 'entry.update', baseVersion: 1,
      baseValues: {}, payload: { title: 'Unsynced change' },
    }));
    const result = await downloadOfflineSnapshot({
      store,
      api: {
        async getSyncCapabilities() { return capabilities({ syncEpoch: 'epoch-2' }); },
        async fetchSyncSnapshot() { return snapshot({ syncEpoch: 'epoch-2' }); },
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'pending-work' });
    expect((await readActiveSnapshot(store))?.snapshot.header.syncEpoch).toBe('epoch-1');
    expect(await store.list()).toHaveLength(1);
  });

  it('refuses epoch replacement while only staged media remain unsynced', async () => {
    const store = Object.assign(createMemorySnapshotStore(), {
      async listMedia() { return [{ id: 'staged-image' }]; },
    });
    const original = await snapshot();
    await store.writeGeneration(1, JSON.stringify(original));
    await store.writeMeta('activeGeneration', '1');
    const result = await downloadOfflineSnapshot({
      store,
      api: {
        async getSyncCapabilities() { return capabilities({ syncEpoch: 'epoch-2' }); },
        async fetchSyncSnapshot() { return snapshot({ syncEpoch: 'epoch-2' }); },
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'pending-work' });
    expect((await readActiveSnapshot(store))?.snapshot.header.syncEpoch).toBe('epoch-1');
  });

  it('downloads, verifies, and activates a snapshot', async () => {
    const store = createMemorySnapshotStore();
    const incoming = await snapshot();
    const result = await downloadOfflineSnapshot({
      api: {
        async getSyncCapabilities() { return capabilities(); },
        async fetchSyncSnapshot() { return incoming; },
      },
      store,
    });

    expect(result).toMatchObject({ ok: true, status: 'updated', active: { generationId: 1 } });
    expect((await readActiveSnapshot(store))?.snapshot.payload.entries[0]?.title).toBe('Endfield');
  });

  it('accepts the current protocol 1 and snapshot format 2 capability pair', async () => {
    const store = createMemorySnapshotStore();
    const incoming = await snapshot({ snapshotFormatVersion: 2, changeSeq: 0 });
    const result = await downloadOfflineSnapshot({
      api: {
        async getSyncCapabilities() {
          return capabilities({
            snapshotFormatVersion: 2,
            featureFlags: {
              readOnlySnapshot: true,
              offlineMutations: true,
              offlineEntryUpdate: true,
            },
          });
        },
        async fetchSyncSnapshot() { return incoming; },
      },
      store,
    });

    expect(result).toMatchObject({ ok: true, status: 'updated' });
    expect((await readActiveSnapshot(store))?.snapshot.header).toMatchObject({
      snapshotFormatVersion: 2,
      changeSeq: 0,
    });
  });

  it('accepts an explicit full resnapshot after the server epoch rotates', async () => {
    const store = createMemorySnapshotStore();
    await downloadOfflineSnapshot({
      api: {
        async getSyncCapabilities() { return capabilities(); },
        async fetchSyncSnapshot() { return snapshot(); },
      },
      store,
    });

    const result = await downloadOfflineSnapshot({
      api: {
        async getSyncCapabilities() { return capabilities({ syncEpoch: 'epoch-2' }); },
        async fetchSyncSnapshot() { return snapshot({ syncEpoch: 'epoch-2', snapshotSeq: 1 }); },
      },
      store,
    });

    expect(result).toMatchObject({ ok: true, status: 'resnapshotted' });
    expect((await readActiveSnapshot(store))?.snapshot.header.syncEpoch).toBe('epoch-2');
    expect(await store.listGenerationIds()).toEqual([2]);
  });

  it('reports local storage failures instead of rejecting the UI action', async () => {
    const store = {
      ...createMemorySnapshotStore(),
      async captureSnapshot() { throw new Error('IndexedDB blocked'); },
      async readMeta() { throw new Error('IndexedDB blocked'); },
    };

    const result = await downloadOfflineSnapshot({
      api: {
        async getSyncCapabilities() { return capabilities(); },
        async fetchSyncSnapshot() { return snapshot(); },
      },
      store,
    });

    expect(result).toEqual({ ok: false, reason: 'storage', detail: 'IndexedDB blocked' });
  });

  it('clears the active pointer and every stored generation without server access', async () => {
    const store = createMemorySnapshotStore();
    await downloadOfflineSnapshot({
      api: {
        async getSyncCapabilities() { return capabilities(); },
        async fetchSyncSnapshot() { return snapshot(); },
      },
      store,
    });

    await clearOfflineSnapshot(store);

    expect(await readActiveSnapshot(store)).toBeNull();
    expect(await store.listGenerationIds()).toEqual([]);
  });

  it('refuses direct snapshot clear when the durable Outbox still has work', async () => {
    const store = Object.assign(createMemorySnapshotStore(), {
      async list() { return [{ opId: 'unsynced' }]; },
      async listMedia() { return []; },
    });
    await downloadOfflineSnapshot({
      api: {
        async getSyncCapabilities() { return capabilities(); },
        async fetchSyncSnapshot() { return snapshot(); },
      },
      store,
    });
    await expect(clearOfflineSnapshot(store)).rejects.toThrow(/unsynced|pending/i);
    expect((await readActiveSnapshot(store))?.snapshot.header.libraryId).toBe('library-1');
  });

  it('refuses direct snapshot clear when staged media remain', async () => {
    const store = Object.assign(createMemorySnapshotStore(), {
      async list() { return []; },
      async listMedia() { return [{ uploadId: 'unsynced' }]; },
    });
    await downloadOfflineSnapshot({
      api: {
        async getSyncCapabilities() { return capabilities(); },
        async fetchSyncSnapshot() { return snapshot(); },
      },
      store,
    });
    await expect(clearOfflineSnapshot(store)).rejects.toThrow(/unsynced|pending/i);
    expect((await readActiveSnapshot(store))?.snapshot.header.libraryId).toBe('library-1');
  });

  it('rejects a different library and keeps the active snapshot', async () => {
    const store = createMemorySnapshotStore();
    await downloadOfflineSnapshot({
      api: {
        async getSyncCapabilities() { return capabilities(); },
        async fetchSyncSnapshot() { return snapshot(); },
      },
      store,
    });

    const result = await downloadOfflineSnapshot({
      api: {
        async getSyncCapabilities() { return capabilities({ libraryId: 'library-2' }); },
        async fetchSyncSnapshot() { return snapshot({ libraryId: 'library-2' }); },
      },
      store,
    });

    expect(result).toMatchObject({ ok: false, reason: 'library-mismatch' });
    expect((await readActiveSnapshot(store))?.snapshot.header.libraryId).toBe('library-1');
  });
});
