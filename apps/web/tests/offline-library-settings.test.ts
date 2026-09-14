// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncCapabilities, SyncSnapshot } from '@t3/shared';
import OfflineLibrarySettings from '../src/components/OfflineLibrarySettings.vue';
import { createMemorySnapshotStore, readActiveSnapshot } from '../src/offline/snapshot-store.js';
import { setLocale } from '../src/i18n.js';

const capabilities: SyncCapabilities = {
  libraryId: 'library-1', syncEpoch: 'epoch-1', sqliteSchemaVersion: 15,
  snapshotFormatVersion: 1, syncProtocolVersion: 1, serverBuild: 'test',
  featureFlags: { readOnlySnapshot: true, offlineMutations: false },
};

async function makeSnapshot(mediaRefs: string[] = []): Promise<SyncSnapshot> {
  const value: SyncSnapshot = {
    header: {
      libraryId: 'library-1', syncEpoch: 'epoch-1', snapshotSeq: 1,
      generatedAt: '2026-09-13T00:00:00.000Z', sqliteSchemaVersion: 15,
      snapshotFormatVersion: 1,
      counts: { entries: 1, producers: 0, entryContents: 0, entryTags: 0, collections: 0 },
      checksum: '',
    },
    payload: {
      entries: [{ id: 1, title: 'Endfield', type: 'game', coverRef: mediaRefs[0] ?? null, previewRef: null, previewRefs: [], pageCount: null, uploadDate: null, createdAt: '2026-09-13', updatedAt: '2026-09-13' }],
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

describe('OfflineLibrarySettings', () => {
  afterEach(() => vi.unstubAllGlobals());

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
});
