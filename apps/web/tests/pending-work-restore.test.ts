// @vitest-environment jsdom
import { indexedDB } from 'fake-indexeddb';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import type { GalleryApi } from '../src/api/gallery.js';
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

it('previews and restores original create and image through the durable API, cold reopen, without network', async () => {
 vi.stubGlobal('Blob', NodeBlob);
 const databaseName = crypto.randomUUID();
 const store = createIndexedDbOfflineStore({ indexedDB, databaseName });
 try {
  const snapshot = offlineSnapshot(); snapshot.header.libraryId = libraryId;
  await store.writeGeneration(1, JSON.stringify(snapshot)); await store.writeMeta('activeGeneration', '1');
  const blob = new Blob([new Uint8Array([0,255,42])], {type:'image/png'});
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const upload = {uploadId:crypto.randomUUID(),libraryId,syncEpoch:identity.syncEpoch,entryUid:operation.entityUid,
   kind:'cover' as const,ordinal:0,mimeType:'image/png' as const,byteLength:3,
   sha256:[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join(''),blob,
   status:'pending' as const,lastAttemptAt:null,lastError:null};
  const backup = JSON.stringify(await buildPendingWorkExport({list:async()=>[operation],listMedia:async()=>[upload]}));
  const network = vi.fn(() => { throw new Error('Import must not contact the server'); });
  const api = createOfflineAwareGalleryApi({assetUrl:(p:string)=>p,getSyncCapabilities:network,fetchSyncSnapshot:network} as unknown as GalleryApi, store, {clientId:identity.clientId});
  expect(await api.previewPendingWorkRestore!(backup)).toMatchObject({addedOperations:1,addedMedia:1});
  expect(await store.list()).toEqual([]);expect(await store.listMedia()).toEqual([]);
  expect(await api.restorePendingWork!(backup)).toMatchObject({addedOperations:1,addedMedia:1});
  expect(await api.restorePendingWork!(backup)).toMatchObject({addedOperations:0,addedMedia:0,identicalOperations:1,identicalMedia:1});
  expect(network).not.toHaveBeenCalled();store.close();
  const reopened = createIndexedDbOfflineStore({indexedDB,databaseName});
  try {
   expect(await reopened.list()).toEqual([operation]);
   const media = await reopened.listMedia();expect(media).toHaveLength(1);
   expect(media[0]).toMatchObject({...upload,blob:expect.anything()});
   expect(new Uint8Array(await media[0]!.blob.arrayBuffer())).toEqual(new Uint8Array([0,255,42]));
  } finally {reopened.close();}
 } finally {store.close();}
});
it('rejects confirmation against a changed offline copy without partially restoring work',async()=>{
 const store=createMemoryOfflineStore();const snapshot=offlineSnapshot();snapshot.header.libraryId=libraryId;
 await store.writeGeneration(1,JSON.stringify(snapshot));await store.writeMeta('activeGeneration','1');
 const api=createOfflineAwareGalleryApi({assetUrl:(p:string)=>p} as GalleryApi,store,{clientId:identity.clientId});
 const text=JSON.stringify({format:'t3-pending-work-v1',exportedAt:new Date().toISOString(),operations:[operation],media:[]});
 await api.previewPendingWorkRestore!(text);snapshot.header.snapshotSeq++;
 await store.writeGeneration(2,JSON.stringify(snapshot));await store.writeMeta('activeGeneration','2');
 await expect(api.restorePendingWork!(text)).rejects.toThrow(/changed after preview/iu);
 expect(await store.list()).toEqual([]);expect(await store.listMedia()).toEqual([]);
});
it('keeps a failed atomic restore empty and reports committed success even when diagnostic refresh fails',async()=>{
 const store=createMemoryOfflineStore();const snapshot=offlineSnapshot();snapshot.header.libraryId=libraryId;
 await store.writeGeneration(1,JSON.stringify(snapshot));await store.writeMeta('activeGeneration','1');
 const api=createOfflineAwareGalleryApi({assetUrl:(p:string)=>p} as GalleryApi,store,{clientId:identity.clientId});
 const text=JSON.stringify({format:'t3-pending-work-v1',exportedAt:new Date().toISOString(),operations:[operation],media:[]});
 await api.previewPendingWorkRestore!(text);
 const atomic=store.restorePendingWork.bind(store);
 const restore=vi.spyOn(store,'restorePendingWork').mockRejectedValueOnce(new Error('Storage unavailable; nothing was restored'));
 await expect(api.restorePendingWork!(text)).rejects.toThrow(/nothing was restored/iu);
 expect(await store.list()).toEqual([]);
 const list=vi.spyOn(store,'list');
 restore.mockImplementation(async(...args)=>{const result=await atomic(...args);if(args[2])list.mockRejectedValueOnce(new Error('Diagnostic refresh unavailable'));return result;});
 await expect(api.restorePendingWork!(text)).resolves.toMatchObject({addedOperations:1});
 expect(restore).toHaveBeenCalledTimes(2);expect(await store.list()).toEqual([operation]);
});
