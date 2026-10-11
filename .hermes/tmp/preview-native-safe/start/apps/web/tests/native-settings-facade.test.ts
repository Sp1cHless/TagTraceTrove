// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { IDBFactory } from 'fake-indexeddb';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createNativeTransfers } from '../src/offline/native-background-transfer.js';
import OfflineLibrarySettings from '../src/components/OfflineLibrarySettings.vue';
import type { GalleryApi } from '../src/api/gallery.js';
import type { SyncSnapshot } from '@t3/shared';
function fixture():SyncSnapshot {return {header:{libraryId:'11111111-1111-4111-8111-111111111111',syncEpoch:'epoch',snapshotSeq:1,changeSeq:1,generatedAt:'2026-10-04',sqliteSchemaVersion:35,snapshotFormatVersion:2,counts:{entries:1,producers:0,entryContents:0,entryTags:0,collections:0},checksum:'stored'},payload:{entries:[{id:1,syncUid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',syncVersion:1,title:'Existing',type:'game',coverRef:null,previewRef:null,previewRefs:[],pageCount:null,uploadDate:null,createdAt:'2026-10-04',updatedAt:'2026-10-04'}],producers:[],entryProducers:[],tags:[],tagGroups:[],entryTags:[],producerTags:[],producerTagAssignments:[],entryContents:[],ratingSlots:[],entryRatingValues:[],producerRatingValues:[],collections:[],collectionMembers:[],authorDirectories:[],authorDirectoryEntries:[],entryUsage:[],viewLaterEntries:[],viewLaterProducers:[],gallerySettings:[],mediaRefs:[]}};}
it('mounted Settings uses the actual durable facade old-plugin fallback without scheduling or losing the original',async()=>{
 const store=createIndexedDbOfflineStore({indexedDB:new IDBFactory(),databaseName:'settings-old-plugin'});
 await store.writeGeneration(1,JSON.stringify(fixture()));await store.writeMeta('activeGeneration','1');await store.writeMeta('capability.offlineEntryCreate','1');
 const call=vi.fn(async(method:string,args:Record<string,unknown>)=>{void method;void args;return {};});
 const api=createOfflineAwareGalleryApi({assetUrl:(path:string)=>path} as GalleryApi,store,{nativeTransfers:createNativeTransfers(store,{call})});
 await api.preferOfflineSnapshot!();await api.enqueueOfflineEntryCreate!({title:'Saved original',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});
 const before=await store.list();expect(before).toHaveLength(1);
 const wrapper=mount(OfflineLibrarySettings,{props:{api,store}});await flushPromises();await vi.waitFor(()=>expect(wrapper.get('[data-testid="native-transfer-resume"]').attributes('disabled')).toBeUndefined());await wrapper.get('[data-testid="native-transfer-resume"]').trigger('click');await vi.waitFor(()=>expect(wrapper.text()).toContain('0 scheduled'));
 expect(wrapper.text()).toContain('0 scheduled');expect(wrapper.text()).toContain('1 foreground-only');expect(wrapper.text()).toContain('Native mutation protocol unavailable; use foreground Update');
 expect(call.mock.calls.every(([method])=>method==='status')).toBe(true);expect(await store.list()).toEqual(before);wrapper.unmount();store.close();
});
it('real facade refuses canonical blocked-work discard if native cancellation reports an in-flight request',async()=>{
 const store=createIndexedDbOfflineStore({indexedDB:new IDBFactory(),databaseName:'settings-inflight'});
 await store.writeGeneration(1,JSON.stringify(fixture()));await store.writeMeta('activeGeneration','1');await store.writeMeta('capability.offlineEntryCreate','1');
 const native=createNativeTransfers(store,{call:async(method)=>{if(method==='pause')throw new Error('In flight');return {};}});
 const api=createOfflineAwareGalleryApi({} as GalleryApi,store,{nativeTransfers:native});await api.preferOfflineSnapshot!();
 await api.enqueueOfflineEntryCreate!({title:'Retain',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});
 const row=(await store.list())[0]!;await store.update(row.opId,{status:'conflict'});const before=await store.list();
 await expect(api.discardBlockedOfflineOperations!()).rejects.toThrow('In flight');expect(await store.list()).toEqual(before);store.close();
});
