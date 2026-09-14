// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { SyncCapabilities, SyncSnapshot } from '@t3/shared';
import { createMemorySnapshotStore, readActiveSnapshot } from '../src/offline/snapshot-store.js';
import { clearOfflineSnapshot, downloadOfflineSnapshot } from '../src/offline/offline-sync.js';

function capabilities(overrides: Partial<SyncCapabilities> = {}): SyncCapabilities {
  return {
    libraryId: 'library-1',
    syncEpoch: 'epoch-1',
    sqliteSchemaVersion: 15,
    snapshotFormatVersion: 1,
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
    generatedAt: '2026-09-13T00:00:00.000Z',
    sqliteSchemaVersion: 15,
    snapshotFormatVersion: 1,
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
