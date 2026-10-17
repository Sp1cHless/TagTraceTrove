// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createNativeTransfers } from '../src/offline/native-background-transfer.js';
import type { GalleryApi } from '../src/api/gallery.js';
import { nativeMutationContract, type SyncSnapshot } from '@t3/shared';
function fixture():SyncSnapshot {return {header:{libraryId:'11111111-1111-4111-8111-111111111111',syncEpoch:'epoch',snapshotSeq:1,changeSeq:1,generatedAt:'2026-10-04',sqliteSchemaVersion:35,snapshotFormatVersion:2,counts:{entries:1,producers:0,entryContents:0,entryTags:0,collections:0},checksum:'stored'},payload:{entries:[{id:1,syncUid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',syncVersion:1,title:'Existing',type:'game',coverRef:null,previewRef:null,previewRefs:[],pageCount:null,uploadDate:null,createdAt:'2026-10-04',updatedAt:'2026-10-04'}],producers:[],entryProducers:[],tags:[],tagGroups:[],entryTags:[],producerTags:[],producerTagAssignments:[],entryContents:[],ratingSlots:[],entryRatingValues:[],producerRatingValues:[],collections:[],collectionMembers:[],authorDirectories:[],authorDirectoryEntries:[],entryUsage:[],viewLaterEntries:[],viewLaterProducers:[],gallerySettings:[],mediaRefs:[]}};}
it('the native facade reports a released survivor as foreground-only and retains its bytes',async()=>{
 const store=createIndexedDbOfflineStore({indexedDB:new IDBFactory(),databaseName:'released-preview-status'});
 const snapshot=fixture();await store.writeGeneration(1,JSON.stringify(snapshot));await store.writeMeta('activeGeneration','1');
 const uploadId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 await store.writeMeta('capability.existingEntryMedia','1');
 await store.enqueueExistingEntryMedia!({uploadId,libraryId:snapshot.header.libraryId,syncEpoch:'epoch',entryUid:snapshot.payload.entries[0]!.syncUid!,kind:'preview',ordinal:0,mimeType:'image/png',byteLength:1,sha256:'0'.repeat(64),blob:new Blob(['x']),existingEntry:{expectedCoverRef:null,expectedPreviewRefs:[]},status:'pending',lastAttemptAt:null,lastError:null},{snapshot:JSON.stringify(snapshot),revision:(await store.captureSnapshot!()).revision,media:'[]',operations:'[]'});
 const call=vi.fn(async(method:string)=>method==='status'?{protocolVersion:1,planVersion:1,operationKinds:Object.keys(nativeMutationContract)}:method==='preflight'?{libraryId:snapshot.header.libraryId,syncEpoch:'epoch',featureFlags:{offlineMediaUpload:true,existingEntryMedia:true}}:method==='foregroundOnlyUploads'?{uploadIds:[uploadId]}:method==='reconcile'?{active:0,completed:0,held:0,mirroredUploadIds:[],foregroundUploadIds:[uploadId]}:{});
 const api=createOfflineAwareGalleryApi({assetUrl:(path:string)=>path} as GalleryApi,store,{nativeTransfers:createNativeTransfers(store,{call})});
 const result=await api.resumeNativeTransfers!();
 expect(result).toMatchObject({active:0,foregroundMedia:1});expect(result.foregroundReason).toContain('Canceled preview chain');
 expect(call.mock.calls.some(([method])=>method==='activateStandaloneMedia')).toBe(false);expect(await store.listMedia()).toHaveLength(1);store.close();
});
it('the durable facade keeps old-plugin work for foreground replay without scheduling or losing the original',async()=>{
 const store=createIndexedDbOfflineStore({indexedDB:new IDBFactory(),databaseName:'settings-old-plugin'});
 await store.writeGeneration(1,JSON.stringify(fixture()));await store.writeMeta('activeGeneration','1');await store.writeMeta('capability.offlineEntryCreate','1');
 const call=vi.fn(async(method:string,args:Record<string,unknown>)=>{void method;void args;return {};});
 const api=createOfflineAwareGalleryApi({assetUrl:(path:string)=>path} as GalleryApi,store,{nativeTransfers:createNativeTransfers(store,{call})});
 await api.preferOfflineSnapshot!();await api.enqueueOfflineEntryCreate!({title:'Saved original',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});
 const before=await store.list();expect(before).toHaveLength(1);
 const result=await api.resumeNativeTransfers!();
 expect(result).toMatchObject({active:0,remainingOperations:1,foregroundReason:'Native mutation protocol unavailable; use foreground Update'});
 expect(call.mock.calls.every(([method])=>method==='status')).toBe(true);expect(await store.list()).toEqual(before);store.close();
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
