// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SearchPage from '../src/SearchPage.vue';
import GalleryApp from '../src/GalleryApp.vue';
import { setLocale } from '../src/i18n.js';
vi.stubGlobal('scrollTo', vi.fn());
import type { GalleryApi } from '../src/api/gallery.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createMemorySnapshotStore, ACTIVE_GENERATION_KEY } from '../src/offline/snapshot-store.js';
import { createMemoryOutboxStore, createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
const clientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const uid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export async function setupNewTags() {
  const snapshot = offlineSnapshot(); snapshot.header.sqliteSchemaVersion = 34;
  snapshot.payload.tagGroups = [
    { id: 2, entryType: 'game', name: 'Tags', groupKind: 'section', parentId: null, sortOrder: 0 },
    { id: 1, entryType: 'game', name: 'Genre', groupKind: 'facet', parentId: 2, sortOrder: 0 },
    { id: 3, entryType: 'game', name: 'Theme', groupKind: 'facet', parentId: 2, sortOrder: 1 },
  ];
  const store = { ...createMemorySnapshotStore(), ...createMemoryOutboxStore() };
  await store.writeGeneration(1, JSON.stringify(snapshot)); await store.writeMeta(ACTIVE_GENERATION_KEY, '1');
  const parent = createPendingSyncOperation({ clientId, libraryId: 'library-1', syncEpoch: 'epoch-1', entityKind: 'entry', entityUid: uid, operationKind: 'entry.create', baseVersion: 0, baseValues: {}, payload: { title: 'New', type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false } });
  await store.enqueue(parent);
  const online = { getSyncCapabilities: vi.fn().mockResolvedValue({ featureFlags: { offlineMutations: true, offlineEntryTags: true, offlinePendingEntryTags: true, offlineEntryTagVocabulary: true, offlinePendingEntryTagCreation: true } }) } as unknown as GalleryApi;
  const state = { mode: 'offline' as 'offline' | 'online', lastFallbackAt: null, lastReplayError: null as string | null };
  const api = createOfflineAwareGalleryApi(online, store, { clientId, state }); await api.getSyncCapabilities({ replay: false });
  return { api, store, parent, snapshot, online, state };
}
it('creates an immutable global Entry Tag then assigns it to an existing Facet of a pending Entry', async () => {
  const { api, store, parent } = await setupNewTags();
  await api.enqueueOfflinePendingEntryTagCreate!(`local:${uid}`, ' School Life ', 1);
  const rows = await store.list();
  expect(rows[0]).toEqual(parent);
  expect(rows.map(row => row.operationKind)).toEqual(['entry.create', 'entry.tag.create', 'entry.tags.set']);
  const origin = rows[1]!;
  expect(origin).toMatchObject({ entityKind: 'entry_tag', baseVersion: 0, payload: { name: 'School Life' } });
  expect(rows[2]!.payload).toEqual({ parentCreateOpId: parent.opId, tags: [{ name: 'School Life', tagUid: origin.entityUid, facetId: 1 }], tagCreates: [{ tagUid: origin.entityUid, createOpId: origin.opId }] });
  const restarted = createOfflineAwareGalleryApi({} as GalleryApi, store, { clientId });
  expect(await restarted.getPendingOfflineEntryTagOptions!(`local:${uid}`)).toMatchObject({ canCreateTag: true, tags: [{ name: 'School Life', facetId: 1 }], availableTags: expect.arrayContaining([{ id: expect.any(Number), name: 'School Life' }]) });
  await restarted.enqueueOfflinePendingEntryTags!(`local:${uid}`, []);
  await restarted.enqueueOfflinePendingEntryTagCreate!(`local:${uid}`, 'school life', 3);
  expect((await store.list()).filter(row => row.operationKind === 'entry.tag.create')).toHaveLength(1);
  expect((await restarted.getPendingOfflineEntryTagOptions!(`local:${uid}`)).tags).toEqual([{ name: 'School Life', facetId: 3 }]);
});

it('creates for a cached synced Entry and routes staged add move remove after genuine online getEntry recovery through UUID queue', async () => {
  const { api, store, online, snapshot, state } = await setupNewTags();
  await api.assignEntryTag(1, { name: 'New Global', facetId: 1 });
  const origin = (await store.list()).find(row => row.operationKind === 'entry.tag.create')!;
  expect(origin).toBeDefined();
  expect((await store.list()).at(-1)!.payload).toMatchObject({ tags: expect.arrayContaining([{ name: 'New Global', tagUid: origin.entityUid, facetId: 1 }]), tagCreates: [{ tagUid: origin.entityUid, createOpId: origin.opId }] });
  const staged = (await api.getEntry(1)).sections.flatMap(row => row.facets.flatMap(facet => facet.tags)).find(tag => tag.name === 'New Global')!;
  expect(staged.id).toBeLessThan(0);
  online.getEntry = vi.fn().mockResolvedValue(await api.getEntry(1));
  online.fetchSyncSnapshot = vi.fn().mockResolvedValue(snapshot);
  online.assignEntryTag = vi.fn(); online.moveEntryTag = vi.fn(); online.removeEntryTag = vi.fn();
  await api.fetchSyncSnapshot(); await api.getEntry(1);
  expect(online.getEntry).toHaveBeenCalled(); expect(state.mode).toBe('online');
  await api.moveEntryTag(1, staged.id, 3);
  await api.fetchSyncSnapshot(); await api.getEntry(1); expect(state.mode).toBe('online'); await api.removeEntryTag(1, staged.id);
  await api.fetchSyncSnapshot(); await api.getEntry(1); expect(state.mode).toBe('online'); await api.assignEntryTag(1, { name: 'New Global', facetId: 1 });
  expect(online.moveEntryTag).not.toHaveBeenCalled(); expect(online.removeEntryTag).not.toHaveBeenCalled(); expect(online.assignEntryTag).not.toHaveBeenCalled();
  expect((await store.list()).filter(row => row.operationKind === 'entry.tag.create')).toHaveLength(1);
  expect((await store.list()).at(-1)!.payload).toMatchObject({ tagCreates: [{ tagUid: origin.entityUid, createOpId: origin.opId }] });
});

it('creates through mounted Search and the real pending durable facade callback', async () => {
  setLocale('en'); const { api, store, parent } = await setupNewTags();
  const wrapper = mount(SearchPage, { props: { api, initialQuery: 'New', initialScope: 'entries', nsfwEntryTypes: [] } });
  await flushPromises(); await wrapper.get('[data-testid="pending-edit-tags"]').trigger('click'); await flushPromises();
  await wrapper.get('[data-testid="pending-new-tag-name"]').setValue('Search New Tag');
  await wrapper.get('[data-testid="pending-new-tag-create"]').trigger('click'); await flushPromises();
  expect((await store.list()).map(row => row.operationKind)).toEqual(['entry.create', 'entry.tag.create', 'entry.tags.set']);
  expect((await store.list())[0]).toEqual(parent);
  expect(wrapper.text()).toContain('Search New Tag'); expect(wrapper.find('[data-testid="pending-tag-form"]').exists()).toBe(false);
  wrapper.unmount();
});
it('creates through the existing mounted Gallery Tag control and real cached synced facade', async () => {
  setLocale('en'); window.localStorage.clear(); const { api, store, parent, online, snapshot, state } = await setupNewTags(); await store.remove(parent.opId);
  const wrapper = mount(GalleryApp, { props: { api } }); await flushPromises();
  await wrapper.get('[data-gallery-type="game"]').trigger('click'); await flushPromises();
  await wrapper.get('[data-entry-id="1"]').trigger('click'); await flushPromises();
  await wrapper.get('[data-testid="start-entry-editing"]').trigger('click'); await flushPromises();
  await wrapper.get('[data-add-tag-facet-id="1"]').trigger('click');
  const input = wrapper.get('[data-create-tag-facet-id="1"] [name="tagName"]');
  await input.setValue('Gallery New Tag'); await input.trigger('blur'); await flushPromises();
  expect((await store.list()).map(row => row.operationKind)).toEqual(['entry.tag.create', 'entry.tags.set']);
  expect(wrapper.get('[data-facet-id="1"]').text()).toContain('Gallery New Tag');
  const detail = await api.getEntry(1), staged = detail.sections.flatMap(section => section.facets.flatMap(facet => facet.tags)).find(tag => tag.name === 'Gallery New Tag')!;
  online.getEntry = vi.fn().mockResolvedValue(detail); online.fetchSyncSnapshot = vi.fn().mockResolvedValue(snapshot);
  online.moveEntryTag = vi.fn(); online.removeEntryTag = vi.fn(); online.assignEntryTag = vi.fn();
  await api.fetchSyncSnapshot(); await api.getEntry(1);
  expect(online.getEntry).toHaveBeenCalled(); expect(state.mode).toBe('online');
  await wrapper.get(`[data-detail-tag-id="${staged.id}"]`).trigger('click');
  await wrapper.get('[data-move-selected-tag-to-facet-id="3"]').trigger('click'); await flushPromises();
  expect(online.moveEntryTag).not.toHaveBeenCalled();
  await api.fetchSyncSnapshot(); await api.getEntry(1); expect(state.mode).toBe('online');
  await wrapper.get(`[data-remove-entry-tag-id="${staged.id}"]`).trigger('click'); await flushPromises();
  expect(online.removeEntryTag).not.toHaveBeenCalled();
  await api.fetchSyncSnapshot(); await api.getEntry(1); expect(state.mode).toBe('online');
  await wrapper.get('[data-add-tag-facet-id="1"]').trigger('click');
  const again = wrapper.get('[data-create-tag-facet-id="1"] [name="tagName"]');
  await again.setValue('Gallery New Tag'); await again.trigger('blur'); await flushPromises();
  expect(online.assignEntryTag).not.toHaveBeenCalled();
  expect((await store.list()).filter(row => row.operationKind === 'entry.tag.create')).toHaveLength(1);
  expect((await store.list()).filter(row => row.operationKind === 'entry.tags.set')).toHaveLength(4);
  wrapper.unmount();
});
it.each(['offlineMutations' , 'offlineEntryTags', 'offlineEntryTagVocabulary', 'offlinePendingEntryTags', 'offlinePendingEntryTagCreation'])('rejects missing/false %s before enqueueing new pending vocabulary', async flag => {
  const { api, store, online } = await setupNewTags();
  const capabilities = await online.getSyncCapabilities();
  online.getSyncCapabilities = vi.fn().mockResolvedValue({ ...capabilities, featureFlags: { ...capabilities.featureFlags, [flag]: false } });
  await api.getSyncCapabilities({ replay: false }); const before = await store.list();
  await expect(api.enqueueOfflinePendingEntryTagCreate!(`local:${uid}`, 'New', 1)).rejects.toThrow(/supported/i);
  expect(await store.list()).toEqual(before);
});
it.each(['downgrade', 'failed'] as const)('holds vocabulary and later same-owner operations on %s', async reason => {
  const { api, store, online } = await setupNewTags();
  await api.enqueueOfflinePendingEntryTagCreate!(`local:${uid}`, 'New', 1);
  await api.enqueueOfflinePendingEntryTags!(`local:${uid}`, []);
  const origin = (await store.list())[1]!;
  if (reason === 'downgrade') await store.writeMeta('capability.offlineEntryTagVocabulary', '0');
  else await store.update(origin.opId, { status: 'failed', lastError: 'source failed' });
  online.replaySyncOperation = vi.fn().mockImplementation(async op => ({ status: 'applied', opId: op.opId, serverSeq: 10, entityId: 12 }));
  online.fetchSyncSnapshot = vi.fn().mockRejectedValue(new Error('no cleanup fixture'));
  await api.flushOfflineOutbox!();
  expect(vi.mocked(online.replaySyncOperation!).mock.calls.map(([op]) => op.operationKind)).toEqual(['entry.create']);
});
