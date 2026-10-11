// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncCapabilities, SyncSnapshot } from '@t3/shared';
import OfflineLibrarySettings from '../src/components/OfflineLibrarySettings.vue';
import { createMemorySnapshotStore, readActiveSnapshot } from '../src/offline/snapshot-store.js';
import { createMemoryOutboxStore, createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { setLocale } from '../src/i18n.js';

const capabilities: SyncCapabilities = {
  libraryId: 'library-1', syncEpoch: 'epoch-1', sqliteSchemaVersion: 21,
  snapshotFormatVersion: 2, syncProtocolVersion: 1, serverBuild: 'test',
  featureFlags: { readOnlySnapshot: true, offlineMutations: true, offlineEntryUpdate: true },
};

async function makeSnapshot(mediaRefs: string[] = []): Promise<SyncSnapshot> {
  const value: SyncSnapshot = {
    header: {
      libraryId: 'library-1', syncEpoch: 'epoch-1', snapshotSeq: 1, changeSeq: 0,
      generatedAt: '2026-09-13T00:00:00.000Z', sqliteSchemaVersion: 21,
      snapshotFormatVersion: 2,
      counts: { entries: 1, producers: 0, entryContents: 0, entryTags: 0, collections: 0 },
      checksum: '',
    },
    payload: {
      entries: [{ id: 1, syncUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', syncVersion: 1, title: 'Endfield', type: 'game', coverRef: mediaRefs[0] ?? null, previewRef: null, previewRefs: [], pageCount: null, uploadDate: null, createdAt: '2026-09-13', updatedAt: '2026-09-13' }],
      producers: [], entryProducers: [], tags: [], tagGroups: [], entryTags: [], producerTags: [],
      producerTagAssignments: [], entryContents: [], ratingSlots: [], entryRatingValues: [], producerRatingValues: [],
      collections: [], collectionMembers: [], authorDirectories: [], authorDirectoryEntries: [], entryUsage: [],
      viewLaterEntries: [], viewLaterProducers: [], gallerySettings: [], mediaRefs,
    },
  };
  const { checksum, ...unsignedHeader } = value.header;
  void checksum;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(unsignedHeader) + JSON.stringify(value.payload),
  ));
  value.header.checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return value;
}

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');

describe('OfflineLibrarySettings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
    else Reflect.deleteProperty(URL, 'createObjectURL');
    if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
    else Reflect.deleteProperty(URL, 'revokeObjectURL');
    if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage);
    else Reflect.deleteProperty(navigator, 'storage');
  });

  it('refuses to clear an active snapshot while unsynced Outbox work still depends on it', async () => {
    setLocale('en');
    const store = Object.assign(createMemorySnapshotStore(), createMemoryOutboxStore());
    await store.writeGeneration(1, JSON.stringify(await makeSnapshot()));
    await store.writeMeta('activeGeneration', '1');
    await store.enqueue(createPendingSyncOperation({
      clientId: 'client-1', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'entry', entityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operationKind: 'entry.update', baseVersion: 1, baseValues: {}, payload: { title: 'Queued title' },
    }));
    const wrapper = mount(OfflineLibrarySettings, { props: {
      store, api: {
        assetUrl: (ref: string) => ref,
        async getSyncCapabilities() { return capabilities; },
        async fetchSyncSnapshot() { return makeSnapshot(); },
      },
    } });
    await flushPromises();
    await wrapper.get('[data-testid="offline-clear"]').trigger('click');
    await flushPromises();
    expect(await readActiveSnapshot(store)).not.toBeNull();
    expect(await store.list()).toHaveLength(1);
    expect(wrapper.get('[data-testid="offline-status"]').text()).toMatch(/pending|unsynced/i);
  });

  it('shows actual storage estimate and requests persistence without assuming grant', async () => {
    setLocale('en');
    const persist = vi.fn(async () => false);
    Object.defineProperty(navigator, 'storage', { configurable: true, value: {
      async estimate() { return { usage: 1_048_576, quota: 10_485_760 }; }, persist,
    } });
    const store = createMemorySnapshotStore();
    const wrapper = mount(OfflineLibrarySettings, { props: {
      store, api: {
        assetUrl: (ref: string) => ref,
        async getSyncCapabilities() { return capabilities; },
        async fetchSyncSnapshot() { return makeSnapshot(); },
      },
    } });
    await flushPromises();
    expect(wrapper.get('[data-testid="offline-storage-status"]').text()).toContain('1.0 MiB');
    await wrapper.get('[data-testid="offline-request-persistence"]').trigger('click');
    await flushPromises();
    expect(persist).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-testid="offline-storage-status"]').text()).toMatch(/not granted/i);
  });

  it('exposes explicit Sync now even in offline mode and probes before replay', async () => {
    setLocale('en');
    const store = createMemorySnapshotStore();
    await store.writeGeneration(1, JSON.stringify(await makeSnapshot()));
    await store.writeMeta('activeGeneration', '1');
    const probe = vi.fn(async () => capabilities);
    const fetchSnapshot = vi.fn(async () => makeSnapshot());
    const wrapper = mount(OfflineLibrarySettings, { props: {
      store, online: false, api: {
        assetUrl: (ref: string) => ref,
        getSyncCapabilities: probe,
        fetchSyncSnapshot: fetchSnapshot,
      },
    } });
    await flushPromises();
    await wrapper.get('[data-testid="offline-sync-now"]').trigger('click');
    await flushPromises();
    expect(probe).toHaveBeenCalledWith({replay:false});
    expect(fetchSnapshot).toHaveBeenCalledOnce();
  });

  it('exports pending work without removing the Outbox or active snapshot', async () => {
    setLocale('en');
    const store = Object.assign(createMemorySnapshotStore(), createMemoryOutboxStore(), { async listMedia() { return []; } });
    await store.writeGeneration(1, JSON.stringify(await makeSnapshot()));
    await store.writeMeta('activeGeneration', '1');
    await store.enqueue(createPendingSyncOperation({
      clientId: 'client-1', libraryId: 'library-1', syncEpoch: 'epoch-1',
      entityKind: 'entry', entityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operationKind: 'entry.update', baseVersion: 1, baseValues: {}, payload: { title: 'Queued title' },
    }));
    const createObjectURL = vi.fn((blob: Blob) => { void blob; return 'blob:pending-work'; });
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const wrapper = mount(OfflineLibrarySettings, { props: {
      store, api: {
        assetUrl: (ref: string) => ref,
        async getSyncCapabilities() { return capabilities; },
        async fetchSyncSnapshot() { return makeSnapshot(); },
      },
    } });
    await flushPromises();
    await wrapper.get('[data-testid="offline-export-pending"]').trigger('click');
    await flushPromises();
    expect(createObjectURL).toHaveBeenCalledOnce();
    const exported = createObjectURL.mock.calls[0]![0] as Blob;
    expect((await exported.text())).toContain('Queued title');
    expect(click).toHaveBeenCalledOnce();
    expect(await store.list()).toHaveLength(1);
    expect(await readActiveSnapshot(store)).not.toBeNull();
  });

  it('downloads and reports the active offline snapshot', async () => {
    setLocale('en');
    const store = createMemorySnapshotStore();
    const wrapper = mount(OfflineLibrarySettings, {
      props: {
        store,
        api: {
          assetUrl(ref: string) { return `https://t3.local${ref}`; },
          async getSyncCapabilities() { return capabilities; },
          async fetchSyncSnapshot() { return makeSnapshot(); },
        },
      },
    });
    await flushPromises();
    expect(wrapper.get('[data-testid="offline-status"]').text()).toContain('No offline copy');

    await wrapper.get('[data-testid="offline-download"]').trigger('click');
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="offline-status"]').text()).toContain('1 Entry');
    });
    expect(wrapper.get('[data-testid="offline-media-status"]').text()).toContain('Metadata saved');
    expect((await readActiveSnapshot(store))?.snapshot.header.snapshotSeq).toBe(1);

    await wrapper.get('[data-testid="offline-clear"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="offline-status"]').text()).toContain('No offline copy');
    expect(await readActiveSnapshot(store)).toBeNull();
  });

  it('shows that metadata is ready while media is still downloading', async () => {
    setLocale('en');
    const ref = '/api/assets/entries/1/cover.webp';
    let finishFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => { finishFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => pendingFetch));
    vi.stubGlobal('caches', {
      async open() {
        return {
          async match() { return undefined; },
          async put() {},
        };
      },
      async delete() { return true; },
    });
    const wrapper = mount(OfflineLibrarySettings, {
      props: {
        store: createMemorySnapshotStore(),
        api: {
          assetUrl(value: string) { return `https://t3.local${value}`; },
          async getSyncCapabilities() { return capabilities; },
          async fetchSyncSnapshot() { return makeSnapshot([ref]); },
        },
      },
    });
    await flushPromises();

    await wrapper.get('[data-testid="offline-download"]').trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="offline-media-status"]').text()).toContain('0/1');
      expect(wrapper.get('[data-testid="offline-media-status"]').text()).toContain('still downloading');
    });

    const response = new Response('image', { status: 200 });
    Object.defineProperty(response, 'url', {
      value: 'https://t3.local/api/assets/entries/1/thumbnails/cover.0123456789abcdef.webp',
    });
    finishFetch(response);
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="offline-media-status"]').text()).toContain('1 new');
    });
  });

  it('checks Entry Content editing support without downloading a large snapshot again', async () => {
    setLocale('en');
    const store = createMemorySnapshotStore();
    await store.writeGeneration(1, JSON.stringify(await makeSnapshot()));
    await store.writeMeta('activeGeneration', '1');
    await store.writeMeta('capability.offlineEntryContents', '0');
    const getSyncCapabilities = vi.fn(async () => {
      await store.writeMeta('capability.offlineEntryContents', '1');
      return { ...capabilities, featureFlags: { ...capabilities.featureFlags, offlineEntryContents: true } };
    });
    const fetchSyncSnapshot = vi.fn();
    const wrapper = mount(OfflineLibrarySettings, { props: {
      store, api: { assetUrl: (ref: string) => ref, getSyncCapabilities, fetchSyncSnapshot },
    } });
    await flushPromises();
    expect(wrapper.get('[data-testid="offline-content-support"]').text()).toContain('not enabled');
    await wrapper.get('[data-testid="offline-check-support"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="offline-content-support"]').text()).toContain('ready');
    expect(fetchSyncSnapshot).not.toHaveBeenCalled();
    expect((await readActiveSnapshot(store))?.generationId).toBe(1);
    await wrapper.setProps({ online: false });
    expect(wrapper.get('[data-testid="offline-check-support"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="offline-download"]').attributes('disabled')).toBeDefined();
  });
});
