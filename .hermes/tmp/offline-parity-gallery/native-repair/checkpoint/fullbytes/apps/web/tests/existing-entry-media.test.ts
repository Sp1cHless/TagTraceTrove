import { File } from 'node:buffer';
import { describe, it, expect, vi } from 'vitest';
import { createMemoryOfflineStore } from '../src/offline/memory-offline-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import type { GalleryApi } from '../src/api/gallery.js';
import type { SyncSnapshot } from '@t3/shared';
import { indexedDB } from 'fake-indexeddb';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
import { preparePendingWork } from '../src/offline/pending-work-restore.js';
import { mediaQueueIdentity } from '../src/offline/media-outbox-store.js';

export const libraryId = '11111111-1111-4111-8111-111111111111';
export const entryUid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export function fixture(): SyncSnapshot {
 return {header:{libraryId,syncEpoch:'epoch',snapshotSeq:1,changeSeq:1,generatedAt:'2026-10-04',sqliteSchemaVersion:35,snapshotFormatVersion:2,counts:{entries:1,producers:0,entryContents:0,entryTags:0,collections:0},checksum:'stored'},payload:{entries:[{id:1,syncUid:entryUid,syncVersion:1,title:'Existing',type:'game',coverRef:null,previewRef:null,previewRefs:[],pageCount:null,uploadDate:null,createdAt:'2026-10-04',updatedAt:'2026-10-04'}],producers:[],entryProducers:[],tags:[],tagGroups:[],entryTags:[],producerTags:[],producerTagAssignments:[],entryContents:[],ratingSlots:[],entryRatingValues:[],producerRatingValues:[],collections:[],collectionMembers:[],authorDirectories:[],authorDirectoryEntries:[],entryUsage:[],viewLaterEntries:[],viewLaterProducers:[],gallerySettings:[],mediaRefs:[]}};
}
describe('Entry media order and deletion',()=>{
 it('queues one command and renders the reordered list before sync',async()=>{
  const store=createMemoryOfflineStore();
  await store.writeGeneration(1,JSON.stringify(fixture()));await store.writeMeta('activeGeneration','1');
  await store.writeMeta('capability.offlineEntryMediaOrder','1');
  await store.writeMeta('capability.existingEntryMedia','1');
  const api=createOfflineAwareGalleryApi({} as GalleryApi,store,{clientId:'client-media-order'});
  await api.preferOfflineSnapshot!();
  // Three pictures that exist in the copy: the fixture entry takes them directly.
  const snapshot=fixture();
  snapshot.payload.entries[0]!.coverRef='/api/assets/entries/1/cover.png';
  snapshot.payload.entries[0]!.previewRefs=['/api/assets/entries/1/preview.png','/api/assets/entries/1/preview-2.png'];
  await store.writeGeneration(1,JSON.stringify(snapshot));
  // A client that never downloaded this copy, but queued against it: the write
  // goes in as the op the server expects, and the copy shows the new order.
  const queued=await api.setEntryMediaOrder!(1,['/api/assets/entries/1/preview.png','/api/assets/entries/1/cover.png']);
  expect(queued.coverRef).toBe('/api/assets/entries/1/preview.png');
  expect(queued.previewRefs).toEqual(['/api/assets/entries/1/cover.png']);
  expect(await store.list()).toEqual([expect.objectContaining({
   operationKind:'entry.media.set',
   entityUid:entryUid,
   baseVersion:1,
   baseValues:{refs:['/api/assets/entries/1/cover.png','/api/assets/entries/1/preview.png','/api/assets/entries/1/preview-2.png']},
   payload:{refs:['/api/assets/entries/1/preview.png','/api/assets/entries/1/cover.png']},
  })]);
  // Deleting the remaining preview is the same door with a shorter list.
  const deleted=await api.setEntryMediaOrder!(1,['/api/assets/entries/1/preview.png']);
  expect(deleted.previewRefs).toEqual([]);
  expect(deleted.coverRef).toBe('/api/assets/entries/1/preview.png');
  // The second wire envelope addresses the predecessor's renamed positions,
  // while the local projection still renders the original cached picture.
  expect((await store.list()).at(-1)).toMatchObject({operationKind:'entry.media.set',baseVersion:2,baseValues:{refs:['/api/assets/entries/1/cover.png','/api/assets/entries/1/preview.png']},payload:{refs:['/api/assets/entries/1/cover.png']}});
 });
});

describe('existing Entry media facade',()=>{
 it.each(['memory','idb'] as const)('preserves parent-free restore and rejects missing preview predecessors in %s',async(adapter)=>{
  const make=()=>adapter==='memory'?createMemoryOfflineStore():createIndexedDbOfflineStore({indexedDB,databaseName:`existing-restore-${crypto.randomUUID()}`});
  const source=make(),target=make();
  try {
   for(const store of [source,target]){await store.writeGeneration(1,JSON.stringify(fixture()));await store.writeMeta('activeGeneration','1');await store.writeMeta('capability.existingEntryMedia','1');await store.writeMeta('capability.offlineMediaMultiplePreviews','1');await store.bindPendingWorkClient('device');}
   const api=createOfflineAwareGalleryApi({} as GalleryApi,source);await api.preferOfflineSnapshot!();
   await api.uploadEntryMedia(1,'preview',new File(['first'],'first.png',{type:'image/png'}) as unknown as globalThis.File);
   await api.uploadEntryMedia(1,'preview',new File(['second'],'second.png',{type:'image/png'}) as unknown as globalThis.File);
   const work=await preparePendingWork(JSON.stringify(await buildPendingWorkExport(source)));
   await expect(target.restorePendingWork({...work,media:work.media.filter(row=>row.ordinal===1)},'device',true)).rejects.toThrow(/earlier|predecessor|position/iu);
   expect(await target.listMedia()).toEqual([]);
   expect((await target.restorePendingWork(work,'device',true)).addedMedia).toBe(2);
   expect(await target.list()).toEqual([]);expect(mediaQueueIdentity(await target.listMedia())).toBe(mediaQueueIdentity(await source.listMedia()));
   for(const row of await target.listMedia())expect(await row.blob.text()).toBe(row.ordinal===0?'first':'second');
  }finally{if('close' in source && typeof source.close==='function')source.close();if('close' in target && typeof target.close==='function')target.close();}
 });
 it.each(['memory','idb'] as const)('atomic %s staging rejects snapshot or media-order changes and occupied cover',async(adapter)=>{
  const store=adapter==='memory'?createMemoryOfflineStore():createIndexedDbOfflineStore({indexedDB,databaseName:`existing-race-${crypto.randomUUID()}`});
  try {
   await store.writeGeneration(1,JSON.stringify(fixture()));await store.writeMeta('activeGeneration','1');await store.writeMeta('capability.existingEntryMedia','1');
   const api=createOfflineAwareGalleryApi({} as GalleryApi,store);await api.preferOfflineSnapshot!();
   await api.uploadEntryMedia(1,'preview',new File(['first'],'image.png',{type:'image/png'}) as unknown as globalThis.File);
   const rows=await store.listMedia();const state=await store.captureSnapshot!();const upload={...rows[0]!,uploadId:crypto.randomUUID()};
   await expect(store.enqueueExistingEntryMedia!(upload,{snapshot:JSON.stringify(state.active!.snapshot),revision:state.revision,media:mediaQueueIdentity([]),operations:'[]'})).rejects.toThrow(/changed/iu);
   await store.writeGeneration(1,JSON.stringify({...fixture(),header:{...fixture().header,syncEpoch:'rotated'}}));
   await expect(store.enqueueExistingEntryMedia!(upload,{snapshot:JSON.stringify(state.active!.snapshot),revision:state.revision,media:mediaQueueIdentity(rows),operations:'[]'})).rejects.toThrow(/changed/iu);
   expect(await store.listMedia()).toEqual(rows);
   await store.removeMedia(rows[0]!.uploadId);const occupied=fixture();occupied.payload.entries[0]!.coverRef='/occupied';await store.writeGeneration(1,JSON.stringify(occupied));
   await expect(api.uploadEntryMedia(1,'cover',new File(['cover'],'image.png',{type:'image/png'}) as unknown as globalThis.File)).rejects.toThrow(/occupied/iu);expect(await store.listMedia()).toEqual([]);
  }finally{if('close' in store && typeof store.close==='function')store.close();}
 });
 it('durably queues a positive-ID upload without any create operation or network write',async()=>{
  const store=createMemoryOfflineStore(); await store.writeGeneration(1,JSON.stringify(fixture())); await store.writeMeta('activeGeneration','1'); await store.writeMeta('capability.existingEntryMedia','1');
  const upload=vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  const api=createOfflineAwareGalleryApi({uploadEntryMedia:upload} as unknown as GalleryApi,store);
  await api.preferOfflineSnapshot?.();
  await api.uploadEntryMedia(1,'preview',new File(['original'],'image.png',{type:'image/png'}) as unknown as globalThis.File);
  expect(upload).not.toHaveBeenCalled(); expect(await store.list()).toEqual([]);
  const rows=await store.listMedia(); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({entryUid,existingEntry:{expectedCoverRef:null,expectedPreviewRefs:[]},ordinal:0,byteLength:8,mimeType:'image/png'});
  expect(await rows[0]!.blob.text()).toBe('original');
 });
});
