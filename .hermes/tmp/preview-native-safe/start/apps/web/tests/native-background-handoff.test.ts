// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());
import { IDBFactory } from 'fake-indexeddb';
import { File } from 'node:buffer';
import type { GalleryApi, OfflineEntryCreateRequest } from '../src/api/gallery.js';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { nativeMutationContract } from '@t3/shared';
import { createNativeTransfers } from '../src/offline/native-background-transfer.js';

it.each([1, 0, 3])('actual durable facade commits original Entry (media=%s) before native handoff, retaining canonical work', async (mediaCount) => {
  const withMedia=mediaCount > 0;
  const factory=new IDBFactory();
  const store = createIndexedDbOfflineStore({ indexedDB: factory, databaseName: 'native-handoff' });
  const snapshot = { header: {libraryId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',syncEpoch:'epoch',snapshotSeq:1,changeSeq:1,generatedAt:'now',sqliteSchemaVersion:35,snapshotFormatVersion:2,counts:{entries:1,producers:0,entryContents:0,entryTags:0,collections:0},checksum:'stored'},
    payload: {entries:[{id:1,syncUid:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',syncVersion:1,title:'seed',type:'comic',coverRef:null,previewRef:null,previewRefs:[],pageCount:null,uploadDate:null,createdAt:'now',updatedAt:'now'}],producers:[],entryProducers:[],tags:[],tagGroups:[],entryTags:[],producerTags:[],producerTagAssignments:[],entryContents:[],ratingSlots:[],entryRatingValues:[],producerRatingValues:[],collections:[],collectionMembers:[],authorDirectories:[],authorDirectoryEntries:[],entryUsage:[],viewLaterEntries:[],viewLaterProducers:[],gallerySettings:[],mediaRefs:[]} };
  await store.writeGeneration(1, JSON.stringify(snapshot)); await store.writeMeta('activeGeneration','1');
  await store.writeMeta('capability.offlineMediaMultiplePreviews','1'); await store.writeMeta('capability.offlineEntryCreate','1'); await store.writeMeta('capability.offlineMediaUpload','1');
  const call=vi.fn(async(method:string)=> method==='status'?{protocolVersion:1,planVersion:1,operationKinds:Object.keys(nativeMutationContract)}:method==='stage'?{stageId:'stage'}:{});
  const native=createNativeTransfers(store,{call});
  const handoff = vi.fn(async () => { expect(await store.list()).toHaveLength(1); expect(await store.listMedia()).toHaveLength(mediaCount); await native.handoff(); });
  const pause=vi.fn();
  const api = createOfflineAwareGalleryApi({} as GalleryApi, store, { nativeTransfers: {handoff, pause, reconcile:vi.fn()} } as never);
  await api.preferOfflineSnapshot?.();
  await api.enqueueOfflineEntryCreate?.({ title:'queued',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:withMedia ? new File([new Uint8Array([1,2,3])],'a.png',{type:'image/png'}) : null,previewFile:null,previewFiles:mediaCount === 3 ? [new File([new Uint8Array([4])],'b.png',{type:'image/png'}),new File([new Uint8Array([5])],'c.png',{type:'image/png'})] : [] } as unknown as OfflineEntryCreateRequest);
  expect(handoff).toHaveBeenCalledTimes(1);
  expect(call.mock.calls.map(args=>args[0])).toEqual(withMedia ? ['status',...Array.from({length:mediaCount},()=>['stage','chunk','seal']).flat(),'activate'] : ['status','stageOperation','activate']);
  store.close(); const cold = createIndexedDbOfflineStore({indexedDB:factory, databaseName:'native-handoff'});
  expect((await cold.list())[0]?.operationKind).toBe('entry.create'); expect((await cold.listMedia()).find(image=>image.kind==='cover')?.byteLength).toBe(withMedia ? 3 : undefined); cold.close();
  if (mediaCount !== 1) { store.close(); return; }
  const image=(await store.listMedia())[0]!;
  await store.updateMedia(image.uploadId,{status:'failed'});
  await api.discardBlockedOfflineOperations?.();
  expect(pause).toHaveBeenCalledWith();
  expect(await store.listMedia()).toHaveLength(0);store.close();
});


it('actual positive Entry facade hands off parent-free immutable media and never a create envelope', async () => {
  // jsdom lacks the browser Blob URL methods used by the actual staged detail projection.
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:native-handoff'; }
    static revokeObjectURL() {}
  });
  const {fixture}=await import('./existing-entry-media.test.js');
  const factory=new IDBFactory();const store=createIndexedDbOfflineStore({indexedDB:factory,databaseName:'standalone-native'});
  await store.writeGeneration(1,JSON.stringify(fixture()));await store.writeMeta('activeGeneration','1');
  await store.writeMeta('capability.existingEntryMedia','1');await store.writeMeta('capability.offlineMediaMultiplePreviews','1');
  const call=vi.fn(async(method:string,args:Record<string,unknown>)=>{void args;return method==='status'?{protocolVersion:1,planVersion:1,operationKinds:Object.keys(nativeMutationContract)}:method==='stageStandaloneMedia'?{stageId:'standalone'}:{};});
  const native=createNativeTransfers(store,{call});const api=createOfflineAwareGalleryApi({} as GalleryApi,store,{nativeTransfers:native});
  await api.preferOfflineSnapshot!();
  await api.uploadEntryMedia(1,'preview',new File(['original'],'a.png',{type:'image/png'}) as unknown as globalThis.File);
  expect(call.mock.calls.map(args=>args[0])).toEqual(['status','stageStandaloneMedia','chunk','seal','activateStandaloneMedia']);
  expect(await store.list()).toEqual([]);const image=(await store.listMedia())[0]!;
  const args=call.mock.calls.find(([method])=>method==='stageStandaloneMedia')![1];
  expect(args).not.toHaveProperty('opId');expect(args).not.toHaveProperty('body');
  expect(JSON.parse(String(args.metadata))).toMatchObject({entryUid:image.entryUid,existingEntry:image.existingEntry,sha256:image.sha256});
  expect(args.clientId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(args.uploadId).toBe(image.uploadId);store.close();
});
