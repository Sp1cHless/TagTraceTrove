// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import SearchPage from '../src/SearchPage.vue';
import GalleryApp from '../src/GalleryApp.vue';
import type { GalleryApi } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createMemorySnapshotStore, ACTIVE_GENERATION_KEY } from '../src/offline/snapshot-store.js';
import { createMemoryOutboxStore, createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
vi.stubGlobal('scrollTo', vi.fn());
const uid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function fixture() {
 const snapshot = offlineSnapshot(); snapshot.header.sqliteSchemaVersion = 34;
 snapshot.payload.tagGroups = [
 { id: 2, syncUid: '22222222-2222-4222-8222-222222222222', entryType: 'game', name: 'Tags', groupKind: 'section', parentId: null, sortOrder: 0 },
 { id: 1, entryType: 'game', name: 'Genre', groupKind: 'facet', parentId: 2, sortOrder: 0 } ];
 snapshot.payload.entryTagLayouts = [{ entryType: 'game', syncUid: '33333333-3333-4333-8333-333333333333', syncVersion: 4 }];
 const store = { ...createMemorySnapshotStore(), ...createMemoryOutboxStore() };
 await store.writeGeneration(1, JSON.stringify(snapshot)); await store.writeMeta(ACTIVE_GENERATION_KEY, '1');
 const parent = createPendingSyncOperation({ clientId: 'facet-client', libraryId: 'library-1', syncEpoch: 'epoch-1', entityKind: 'entry', entityUid: uid, operationKind: 'entry.create', baseVersion: 0, baseValues: {}, payload: { title: 'New', type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false } });
 await store.enqueue(parent);
 const online = { getSyncCapabilities: vi.fn().mockResolvedValue({ featureFlags: { offlineMutations: true, offlineEntryTags: true, offlinePendingEntryTags: true, offlineEntryTagVocabulary: true, offlinePendingEntryTagCreation: true, offlineEntryFacetCreate: true } }) } as unknown as GalleryApi;
 const state = { mode: 'offline' as 'offline' | 'online', lastFallbackAt: null, lastReplayError: null as string | null };
 const api = createOfflineAwareGalleryApi(online, store, { clientId: 'facet-client', state }); await api.getSyncCapabilities({ replay: false });
 return { api, store, online, parent, snapshot, state };
}
it('mounted Search creates a shared Facet durably then places a new Tag in it without changing Entry create', async () => {
 setLocale('en'); const {api, store, parent} = await fixture();
 const wrapper = mount(SearchPage, { props: {api, initialQuery: 'New', initialScope: 'entries', nsfwEntryTypes: []} });
 await flushPromises(); await wrapper.get('[data-testid="pending-edit-tags"]').trigger('click'); await flushPromises();
 await wrapper.get('[data-testid="pending-new-facet-name"]').setValue('Mood');
 await wrapper.get('[data-testid="pending-new-facet-create"]').trigger('click'); await flushPromises();
 const facet = (await api.getPendingOfflineEntryTagOptions!(`local:${uid}`)).facets.find(row => row.name === 'Mood')!;
 expect(facet.id).toBeLessThan(0);
 await wrapper.get('[data-testid="pending-new-tag-name"]').setValue('Bright');
 await wrapper.get('[data-testid="pending-new-tag-create"]').trigger('click'); await flushPromises();
 expect((await store.list())[0]).toEqual(parent);
 expect((await store.list()).map(row => row.operationKind)).toEqual(['entry.create', 'entry.facet.create', 'entry.tag.create', 'entry.tags.set']);
 expect((await store.list()).at(-1)!.payload).toMatchObject({ facetCreates: [{facetUid: expect.any(String), createOpId: expect.any(String)}], tags: [{name: 'Bright', tagUid: expect.any(String), facetUid: expect.any(String)}] });
 wrapper.unmount();
});
it('same-type peer layout and genuine recovered Gallery add move remove keep Facet IDs out of online writes', async () => {
 setLocale('en'); window.localStorage.clear(); const f = await fixture(); await f.store.remove(f.parent.opId);
 const raw = await f.api.getEntry(1);
 await f.api.createFacet({sectionId: 2, name: 'Mood'});
 const facet = (await f.api.getEntry(1)).sections.flatMap(row => row.facets).find(row => row.name === 'Mood')!;
 f.online.getEntry = vi.fn().mockResolvedValue(raw); f.online.fetchSyncSnapshot = vi.fn().mockResolvedValue(f.snapshot);
 f.online.assignEntryTag = vi.fn(); f.online.moveEntryTag = vi.fn(); f.online.removeEntryTag = vi.fn();
 const wrapper = mount(GalleryApp, {props: {api: f.api}}); await flushPromises();
 await wrapper.get('[data-gallery-type="game"]').trigger('click'); await flushPromises();
 await f.api.fetchSyncSnapshot(); await f.api.getEntry(1); expect(f.state.mode).toBe('online'); expect(f.online.getEntry).toHaveBeenCalled();
 await wrapper.get('[data-entry-id="1"]').trigger('click'); await flushPromises();
 await wrapper.get('[data-testid="start-entry-editing"]').trigger('click'); await flushPromises();
 await wrapper.get('[data-detail-tag-id="10"]').trigger('click');
 await wrapper.get(`[data-move-selected-tag-to-facet-id="${facet.id}"]`).trigger('click'); await flushPromises();
 expect(f.online.moveEntryTag).not.toHaveBeenCalled();
 await f.api.fetchSyncSnapshot(); await f.api.getEntry(1); expect(f.state.mode).toBe('online');
 await wrapper.get('[data-remove-entry-tag-id="10"]').trigger('click'); await flushPromises();
 expect(f.online.removeEntryTag).not.toHaveBeenCalled();
 await f.api.fetchSyncSnapshot(); await f.api.getEntry(1); expect(f.state.mode).toBe('online');
 await f.api.assignEntryTag(1, {name: 'RPG', facetId: facet.id});
 expect(f.online.assignEntryTag).not.toHaveBeenCalled();
 expect((await f.store.list()).at(-1)!.payload).toMatchObject({facetCreates: [{facetUid: expect.any(String), createOpId: expect.any(String)}]});
 wrapper.unmount();
});
it('mounted Gallery awaits durable shared Facet creation with a page-owned repeat-submit lock', async () => {
 setLocale('en'); window.localStorage.clear(); const {api, store, parent} = await fixture(); await store.remove(parent.opId);
 const wrapper = mount(GalleryApp, {props: {api}}); await flushPromises();
 await wrapper.get('[data-gallery-type="game"]').trigger('click'); await flushPromises();
 await wrapper.get('[data-entry-id="1"]').trigger('click'); await flushPromises();
 await wrapper.get('[data-testid="start-entry-editing"]').trigger('click'); await flushPromises();
 const original = api.createFacet; let release!: () => void;
 api.createFacet = vi.fn(async input => { await new Promise<void>(resolve => {release = resolve;}); await original(input); });
 await wrapper.get('[data-add-facet-section-id="2"]').trigger('click');
 const form = wrapper.get('[data-create-facet-section-id="2"]'); await form.get('input').setValue('Mood');
 await form.get('input').trigger('blur'); await form.trigger('submit');
 expect(api.createFacet).toHaveBeenCalledTimes(1);
 release(); await flushPromises();
 const options = await api.getEntry(1), facet = options.sections.flatMap(row => row.facets).find(row => row.name === 'Mood')!;
 expect(facet.id).toBeLessThan(0);
 const input = wrapper.get(`[data-create-tag-facet-id="${facet.id}"] [name="tagName"]`); await input.setValue('Bright'); await input.trigger('blur'); await flushPromises();
 expect((await store.list()).map(row => row.operationKind)).toEqual(['entry.facet.create','entry.tag.create','entry.tags.set']);
 expect((await store.list()).at(-1)!.payload).toMatchObject({facetCreates: [{facetUid: expect.any(String), createOpId: expect.any(String)}]});
 wrapper.unmount();
});

it.each(['offlineMutations','offlineEntryTags','offlineEntryFacetCreate'])('rejects omitted %s before durable Facet creation',async flag=>{
 const f=await fixture(), capabilities=await f.online.getSyncCapabilities();
 const flags={...capabilities.featureFlags};delete flags[flag]; f.online.getSyncCapabilities=vi.fn().mockResolvedValue({featureFlags:flags});
 await f.api.getSyncCapabilities({replay:false});const before=await f.store.list();
 await expect(f.api.createFacet({sectionId:2,name:'Blocked'})).rejects.toThrow(/supported/i); expect(await f.store.list()).toEqual(before);
});
it.each(['downgrade','source-failure'] as const)('holds Facet-dependent and later owner mutations on %s',async reason=>{
 const f=await fixture();await f.api.enqueueOfflinePendingEntryFacetCreate!(`local:${uid}`,'Mood',2);
 const facet=(await f.api.getPendingOfflineEntryTagOptions!(`local:${uid}`)).facets.find(row=>row.name==='Mood')!;
 await f.api.enqueueOfflinePendingEntryTagCreate!(`local:${uid}`,'Bright',facet.id);await f.api.enqueueOfflinePendingEntryTags!(`local:${uid}`,[]);
 const origin=(await f.store.list()).find(row=>row.operationKind==='entry.facet.create')!;
 if(reason==='downgrade') await f.store.writeMeta('capability.offlineEntryFacetCreate','0');else await f.store.update(origin.opId,{status:'failed',lastError:'source failure'});
 f.online.replaySyncOperation=vi.fn().mockImplementation(async op=>({opId:op.opId,status:'applied',serverSeq:10,entityId:20}));f.online.fetchSyncSnapshot=vi.fn().mockRejectedValue(new Error('held'));
 await f.api.flushOfflineOutbox!();expect(vi.mocked(f.online.replaySyncOperation!).mock.calls.map(([op])=>op.operationKind)).not.toContain('entry.tags.set');
});
it('same-type pending peer shares the staged Facet while another Entry type cannot assign it',async()=>{
 const f=await fixture();await f.api.enqueueOfflinePendingEntryFacetCreate!(`local:${uid}`,'Shared',2);
 const peerUid='dddddddd-dddd-4ddd-8ddd-dddddddddddd', otherUid='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 await f.store.enqueue({...f.parent,opId:crypto.randomUUID(),entityUid:peerUid,payload:{...f.parent.payload,title:'Peer'}});
 await f.store.enqueue({...f.parent,opId:crypto.randomUUID(),entityUid:otherUid,payload:{...f.parent.payload,type:'comic',title:'Other'}});
 const peer=await f.api.getPendingOfflineEntryTagOptions!(`local:${peerUid}`),facet=peer.facets.find(row=>row.name==='Shared')!;
 await f.api.enqueueOfflinePendingEntryTagCreate!(`local:${peerUid}`,'Bright',facet.id);
 const before=await f.store.list();await expect(f.api.enqueueOfflinePendingEntryTagCreate!(`local:${otherUid}`,'Bright',facet.id)).rejects.toThrow(/Facet/);expect(await f.store.list()).toEqual(before);
 const wrapper=mount(SearchPage,{props:{api:f.api,initialQuery:'Peer',initialScope:'entries',nsfwEntryTypes:[]}});await flushPromises();await wrapper.get('[data-testid="pending-edit-tags"]').trigger('click');await flushPromises();expect(wrapper.text()).toContain('Shared');expect(wrapper.text()).toContain('Bright');wrapper.unmount();
});
it.each(['reject','refresh'] as const)('pending Facet %s preserves rejected names or warns after durable commit without resubmit',async kind=>{
 setLocale('en');const f=await fixture(),original=f.api.enqueueOfflinePendingEntryFacetCreate!;
 f.api.enqueueOfflinePendingEntryFacetCreate=vi.fn(async(key: string, name: string, sectionId: number)=>{if(kind==='reject')throw new Error('save rejected');await original(key, name, sectionId);f.api.getPendingOfflineEntryTagOptions=vi.fn().mockRejectedValue(new Error('refresh lost'));});
 const wrapper=mount(SearchPage,{props:{api:f.api,initialQuery:'New',initialScope:'entries',nsfwEntryTypes:[]}});await flushPromises();await wrapper.get('[data-testid="pending-edit-tags"]').trigger('click');await flushPromises();await wrapper.get('[data-testid="pending-new-facet-name"]').setValue('Keep Name');await wrapper.get('[data-testid="pending-new-facet-create"]').trigger('click');await flushPromises();
 expect((wrapper.get('[data-testid="pending-new-facet-name"]').element as HTMLInputElement).value).toBe('Keep Name');
 if(kind==='refresh'){expect(wrapper.get('[data-testid="pending-new-facet-create"]').attributes('disabled')).toBeDefined();expect(wrapper.text()).toContain('saved');}else expect(wrapper.text()).toContain('save rejected');
 expect(f.api.enqueueOfflinePendingEntryFacetCreate).toHaveBeenCalledTimes(1);wrapper.unmount();
});
