import { File } from 'node:buffer';
import { describe, it, expect, vi } from 'vitest';
import { createMemoryOfflineStore } from '../src/offline/memory-offline-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import type { GalleryApi } from '../src/api/gallery.js';
import { indexedDB } from 'fake-indexeddb';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
import { preparePendingWork } from '../src/offline/pending-work-restore.js';
import { mediaQueueIdentity } from '../src/offline/media-outbox-store.js';
import { LOCAL_FINAL_STATE_KEY, readLocalFinalState, emptyLocalFinalState } from '../src/offline/local-final-state.js';

import { entryUid, fixture } from './fixtures/existing-entry-media.js';
describe('Entry media order and deletion',()=>{
 it('persists the latest local selection and renders it before compiling a transport command',async()=>{
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
  // Unsent media changes are local selections; replay compiles the final command.
  const queued=await api.setEntryMediaOrder!(1,['/api/assets/entries/1/preview.png','/api/assets/entries/1/cover.png']);
  expect(queued.coverRef).toBe('/api/assets/entries/1/preview.png');
  expect(queued.previewRefs).toEqual(['/api/assets/entries/1/cover.png']);
  expect(await store.list()).toEqual([]);
  const control=readLocalFinalState(await store.readMeta(LOCAL_FINAL_STATE_KEY));
  expect(control.media).toHaveLength(1);
  expect(control.media[0]!.baselineRefs).toEqual(['/api/assets/entries/1/cover.png','/api/assets/entries/1/preview.png','/api/assets/entries/1/preview-2.png']);
  // Deleting the remaining preview is the same door with a shorter list.
  const deleted=await api.setEntryMediaOrder!(1,['/api/assets/entries/1/preview.png']);
  expect(deleted.previewRefs).toEqual([]);
  expect(deleted.coverRef).toBe('/api/assets/entries/1/preview.png');
  expect(await store.list()).toEqual([]);
  const final=readLocalFinalState(await store.readMeta(LOCAL_FINAL_STATE_KEY)).media[0]!;
  expect(final.baselineRefs).toEqual(control.media[0]!.baselineRefs);
  expect(final.desired.map(key=>final.items.find(row=>row.key===key)?.ref)).toEqual(['/api/assets/entries/1/preview.png']);
 });
});

describe('existing Entry media facade',()=>{
 it.each(['memory','idb'] as const)('preserves parent-free restore and rejects missing preview predecessors in %s',async(adapter)=>{
  const make=()=>adapter==='memory'?createMemoryOfflineStore():createIndexedDbOfflineStore({indexedDB,databaseName:`existing-restore-${crypto.randomUUID()}`});
  const source=make(),target=make();
  try {
   for(const store of [source,target]){await store.writeGeneration(1,JSON.stringify(fixture()));await store.writeMeta('activeGeneration','1');await store.writeMeta('capability.existingEntryMedia','1');await store.writeMeta('capability.offlineMediaUpload','1');await store.writeMeta('capability.offlineMediaMultiplePreviews','1');await store.bindPendingWorkClient('device');}
   const api=createOfflineAwareGalleryApi({} as GalleryApi,source,{clientId:'device'});await api.preferOfflineSnapshot!();
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
 it.each(['memory','idb'] as const)('atomic %s staging rejects snapshot or media-order changes and declares an occupied-cover replacement',async(adapter)=>{
  const store=adapter==='memory'?createMemoryOfflineStore():createIndexedDbOfflineStore({indexedDB,databaseName:`existing-race-${crypto.randomUUID()}`});
  try {
   await store.writeGeneration(1,JSON.stringify(fixture()));await store.writeMeta('activeGeneration','1');await store.writeMeta('capability.existingEntryMedia','1');await store.writeMeta('capability.offlineMediaUpload','1');
   const api=createOfflineAwareGalleryApi({} as GalleryApi,store);await api.preferOfflineSnapshot!();
   await api.uploadEntryMedia(1,'preview',new File(['first'],'image.png',{type:'image/png'}) as unknown as globalThis.File);
   const rows=await store.listMedia();const state=await store.captureSnapshot!();const upload={...rows[0]!,uploadId:crypto.randomUUID()};
   await expect(store.enqueueExistingEntryMedia!(upload,{snapshot:JSON.stringify(state.active!.snapshot),revision:state.revision,media:mediaQueueIdentity([]),operations:'[]'})).rejects.toThrow(/changed/iu);
   await store.writeGeneration(1,JSON.stringify({...fixture(),header:{...fixture().header,syncEpoch:'rotated'}}));
   await expect(store.enqueueExistingEntryMedia!(upload,{snapshot:JSON.stringify(state.active!.snapshot),revision:state.revision,media:mediaQueueIdentity(rows),operations:'[]'})).rejects.toThrow(/changed/iu);
   expect(await store.listMedia()).toEqual(rows);
   await store.removeMedia(rows[0]!.uploadId);await store.writeMeta(LOCAL_FINAL_STATE_KEY,JSON.stringify(emptyLocalFinalState()));const occupied=fixture();occupied.payload.entries[0]!.coverRef='/occupied';await store.writeGeneration(1,JSON.stringify(occupied));
   // A settled cover is swapped by a declared replacement; only a *pending*
   // cover still needs foreground review first, so this one queues.
   await api.uploadEntryMedia(1,'cover',new File(['cover'],'image.png',{type:'image/png'}) as unknown as globalThis.File);
   const staged=await store.listMedia();
   expect(staged).toHaveLength(1);
   expect(staged[0]).toMatchObject({kind:'cover',replace:true,existingEntry:{expectedCoverRef:'/occupied',expectedPreviewRefs:[]}});
  }finally{if('close' in store && typeof store.close==='function')store.close();}
 });
 it('durably queues a positive-ID upload without any create operation or network write',async()=>{
  const store=createMemoryOfflineStore(); await store.writeGeneration(1,JSON.stringify(fixture())); await store.writeMeta('activeGeneration','1'); await store.writeMeta('capability.existingEntryMedia','1'); await store.writeMeta('capability.offlineMediaUpload','1');
  const upload=vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  const api=createOfflineAwareGalleryApi({uploadEntryMedia:upload} as unknown as GalleryApi,store);
  await api.preferOfflineSnapshot?.();
  await api.uploadEntryMedia(1,'preview',new File(['original'],'image.png',{type:'image/png'}) as unknown as globalThis.File);
  expect(upload).not.toHaveBeenCalled(); expect(await store.list()).toEqual([]);
  const rows=await store.listMedia(); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({entryUid,existingEntry:{expectedCoverRef:null,expectedPreviewRefs:[]},ordinal:0,byteLength:8,mimeType:'image/png'});
  expect(await rows[0]!.blob.text()).toBe('original');
 });
});
