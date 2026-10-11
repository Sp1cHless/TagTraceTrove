// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { indexedDB } from 'fake-indexeddb';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import type { GalleryApi } from '../src/api/gallery.js';
import OfflineLibrarySettings from '../src/components/OfflineLibrarySettings.vue';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';

import { createMemoryOfflineStore } from '../src/offline/memory-offline-store.js';
const libraryId = '11111111-1111-4111-8111-111111111111';
const identity = { clientId: 'restore-client', libraryId, syncEpoch: 'epoch-1' };
const operation = createPendingSyncOperation({ ...identity, entityKind: 'entry',
 entityUid: '22222222-2222-4222-8222-222222222222', operationKind: 'entry.create',
 baseVersion: 0, baseValues: {}, payload: { title: 'Restored', type: 'game',
 uploadDate: null, pageCount: null, ratings: [], viewLater: false } });
afterEach(() => vi.unstubAllGlobals());

it('Settings previews and explicitly restores original create and image through durable facade, cold reopen, without network', async () => {
 vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('File', NodeFile);
 const databaseName = crypto.randomUUID();
 const store = createIndexedDbOfflineStore({ indexedDB, databaseName });
 const snapshot = offlineSnapshot(); snapshot.header.libraryId = libraryId;
 await store.writeGeneration(1, JSON.stringify(snapshot)); await store.writeMeta('activeGeneration', '1');
 const blob = new Blob([new Uint8Array([0,255,42])], {type:'image/png'});
 const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
 const upload = {uploadId:crypto.randomUUID(),libraryId,syncEpoch:identity.syncEpoch,entryUid:operation.entityUid,
 kind:'cover' as const,ordinal:0,mimeType:'image/png' as const,byteLength:3,
 sha256:[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join(''),blob,
 status:'pending' as const,lastAttemptAt:null,lastError:null};
 const backup = await buildPendingWorkExport({list:async()=>[operation],listMedia:async()=>[upload]});
 const network = vi.fn(() => { throw new Error('Import must not contact the server'); });
 const online = {assetUrl:(p:string)=>p,getSyncCapabilities:network,fetchSyncSnapshot:network} as unknown as GalleryApi;
 const api = createOfflineAwareGalleryApi(online, store, {clientId:identity.clientId});
 const wrapper = mount(OfflineLibrarySettings, {props:{api,store,online:false}});
 await flushPromises();
 const input = wrapper.get('[data-testid="offline-restore-file"]');
 Object.defineProperty(input.element,'files',{value:[new File([JSON.stringify(backup)],'pending.json',{type:'application/json'})]});
 await input.trigger('change'); await flushPromises();
 await vi.waitFor(() => expect(wrapper.get('[data-testid="offline-restore-preview"]').text()).toMatch(/1.*edit.*1.*image/i));
 expect(await store.list()).toEqual([]);
 await wrapper.get('[data-testid="offline-restore-confirm"]').trigger('click'); await flushPromises();
 await vi.waitFor(() => expect(wrapper.get('[data-testid="offline-restore-result"]').text()).toMatch(/restored|added/i));
 expect(network).not.toHaveBeenCalled(); wrapper.unmount(); store.close();
 const reopened = createIndexedDbOfflineStore({indexedDB,databaseName});
 expect(await reopened.list()).toEqual([operation]);
 const media = await reopened.listMedia(); expect(media).toHaveLength(1);
 expect(media[0]).toMatchObject({...upload,blob:expect.anything()});
 expect(new Uint8Array(await media[0]!.blob.arrayBuffer())).toEqual(new Uint8Array([0,255,42]));
 reopened.close();
});
it('Settings owns the awaited confirmation lock across repeated clicks and unmount while durable restore completes',async()=>{
 vi.stubGlobal('File',NodeFile);
 const store=createMemoryOfflineStore(); const snapshot=offlineSnapshot();snapshot.header.libraryId=libraryId;
 await store.writeGeneration(1,JSON.stringify(snapshot));await store.writeMeta('activeGeneration','1');
 const api=createOfflineAwareGalleryApi({assetUrl:(p:string)=>p} as GalleryApi,store,{clientId:identity.clientId});
 const original=api.restorePendingWork!; let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const restore=vi.fn(async(text:string)=>{await gate;return original(text);}); api.restorePendingWork=restore;
 const wrapper=mount(OfflineLibrarySettings,{props:{api,store,online:false}});await flushPromises();
 const input=wrapper.get('[data-testid="offline-restore-file"]');
 Object.defineProperty(input.element,'files',{value:[new File([JSON.stringify({format:'t3-pending-work-v1',exportedAt:new Date().toISOString(),operations:[operation],media:[]})],'pending.json')]});
 await input.trigger('change');await vi.waitFor(()=>expect(wrapper.find('[data-testid="offline-restore-confirm"]').exists()).toBe(true));
 const button=wrapper.get('[data-testid="offline-restore-confirm"]');
 await button.trigger('click');await button.trigger('click');expect(restore).toHaveBeenCalledTimes(1);
 wrapper.unmount();release();await vi.waitFor(async()=>expect(await store.list()).toEqual([operation]));
});
it('Settings keeps rejected file/preview and live queue intact, and committed refresh failure is a warning not a second write',async()=>{
 vi.stubGlobal('File',NodeFile);
 const store=createMemoryOfflineStore();const snapshot=offlineSnapshot();snapshot.header.libraryId=libraryId;
 await store.writeGeneration(1,JSON.stringify(snapshot));await store.writeMeta('activeGeneration','1');
 const api=createOfflineAwareGalleryApi({assetUrl:(p:string)=>p} as GalleryApi,store,{clientId:identity.clientId});
 const original=api.restorePendingWork!; const restore=vi.fn((text:string)=>original(text)); api.restorePendingWork=restore;
 const wrapper=mount(OfflineLibrarySettings,{props:{api,store,online:false}});await flushPromises();
 const input=wrapper.get('[data-testid="offline-restore-file"]');
 Object.defineProperty(input.element,'files',{value:[new File([JSON.stringify({format:'t3-pending-work-v1',exportedAt:new Date().toISOString(),operations:[operation],media:[]})],'pending.json')]});
 await input.trigger('change');await vi.waitFor(()=>expect(wrapper.find('[data-testid="offline-restore-confirm"]').exists()).toBe(true));
 const atomic=store.restorePendingWork; const fault=vi.spyOn(store,'restorePendingWork').mockRejectedValueOnce(new Error('Storage unavailable; nothing was restored'));
 await wrapper.get('[data-testid="offline-restore-confirm"]').trigger('click');await flushPromises();
 expect(wrapper.get('[data-testid="offline-restore-error"]').text()).toMatch(/nothing was restored/);
 expect(wrapper.find('[data-testid="offline-restore-preview"]').exists()).toBe(true);expect(await store.list()).toEqual([]);
 // The refresh re-reads the snapshot identity before it projects; the projection
 // itself is cached, so the failure that must warn is the identity read failing.
 fault.mockImplementation(async(...args)=>{const result=await atomic(...args);if(args[2]){const readMeta=store.readMeta.bind(store);store.readMeta=vi.fn(async(key:string)=>key==='snapshotRevision'?Promise.reject(new Error('refresh unavailable')):readMeta(key));}return result;});
 await wrapper.get('[data-testid="offline-restore-confirm"]').trigger('click');await flushPromises();
 expect(wrapper.get('[data-testid="offline-restore-result"]').text()).toMatch(/Restored 1/);
 expect(wrapper.get('[data-testid="offline-restore-error"]').text()).toMatch(/Do not import again/);
 expect(wrapper.find('[data-testid="offline-restore-confirm"]').exists()).toBe(false);
 expect(restore).toHaveBeenCalledTimes(2);expect(await store.list()).toEqual([operation]);wrapper.unmount();
});

