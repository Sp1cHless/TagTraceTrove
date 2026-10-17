import { describe, it, expect, vi } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import type { SyncSnapshot } from '@t3/shared';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createOfflineLibrary } from '../src/offline/offline-library.js';
import type { GalleryApi } from '../src/api/gallery.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
import { preparePendingWork } from '../src/offline/pending-work-restore.js';
import { mutationQueuePlan } from '../src/offline/sync-mutation-plan.js';
function fixture(): SyncSnapshot {
 return {header:{libraryId:'11111111-1111-4111-8111-111111111111',syncEpoch:'epoch',snapshotSeq:1,changeSeq:1,generatedAt:'2026-10-08',sqliteSchemaVersion:37,snapshotFormatVersion:2,counts:{entries:3,producers:0,entryContents:0,entryTags:0,collections:0},checksum:'stored'},payload:{entries:['Alpha','Hidden','Zebra'].map((type,i)=>({id:i+1,syncUid:`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`,syncVersion:1,title:type,type,coverRef:null,previewRef:null,previewRefs:[],pageCount:null,uploadDate:null,createdAt:'2026-10-08',updatedAt:'2026-10-08'})),producers:[],entryProducers:[],tags:[],tagGroups:[],entryTags:[],producerTags:[],producerTagAssignments:[],entryContents:[],ratingSlots:[],entryRatingValues:[],producerRatingValues:[],collections:[],collectionMembers:[],authorDirectories:[],authorDirectoryEntries:[],entryUsage:[],viewLaterEntries:[],viewLaterProducers:[],gallerySettings:[{entryType:'Hidden',nsfw:true}],galleryOrder:{syncUid:'00000000-0000-4000-8000-000000000037',syncVersion:1,orderedTypes:['Zebra','Hidden','Alpha']},mediaRefs:[]}};
}
describe('durable offline Gallery ordering',()=>{
 it('preserves server order, queues the full hidden scope, reopens IDB and exports/restores with causal native plans',async()=>{
  const name=`gallery-order-${crypto.randomUUID()}`;let store=createIndexedDbOfflineStore({indexedDB,databaseName:name});
  try {
   await store.writeGeneration(1,JSON.stringify(fixture()));await store.writeMeta('activeGeneration','1');
   await store.writeMeta('capability.offlineGalleryOrder','1');await store.writeMeta('capability.offlineMutations','1');await store.bindPendingWorkClient('phone');
   const online=vi.fn();const api=createOfflineAwareGalleryApi({setGalleryOrder:online} as unknown as GalleryApi,store,{clientId:'phone'});await api.preferOfflineSnapshot!();
   expect((await api.listGalleries()).map(row=>row.type)).toEqual(['Zebra','Hidden','Alpha']);
   await api.setGalleryOrder(['Alpha','Hidden','Zebra']);
   await api.setGalleryOrder(['Hidden','Alpha','Zebra']);
   expect(online).not.toHaveBeenCalled();
   expect((await store.list()).map(row=>row.baseVersion)).toEqual([1]);
   store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName:name});
   const cold=createOfflineAwareGalleryApi({} as GalleryApi,store,{clientId:'phone'});await cold.preferOfflineSnapshot!();
   expect((await cold.listGalleries()).map(row=>row.type)).toEqual(['Hidden','Alpha','Zebra']);
   const work=await preparePendingWork(JSON.stringify(await buildPendingWorkExport(store)));
   expect(work.operations).toHaveLength(1);
   const plan=[...mutationQueuePlan(await store.list()).values()];
   expect(plan[0]).toMatchObject({eligible:true,requiredFlags:['offlineMutations','offlineGalleryOrder']});
   expect(plan[0]!.dependencies).toEqual([]);
   const restored=createIndexedDbOfflineStore({indexedDB,databaseName:`restore-${name}`});
   try { await restored.writeGeneration(1,JSON.stringify(fixture()));await restored.writeMeta('activeGeneration','1');await restored.bindPendingWorkClient('phone');
    expect((await restored.restorePendingWork(work,'phone',true)).addedOperations).toBe(1);
   } finally {restored.close();}
  }finally{store.close();}
 });
 it.each([
  ['offlineMutations', null], ['offlineMutations', '0'],
  ['offlineGalleryOrder', null], ['offlineGalleryOrder', '0'],
 ] as const)('refuses writes when %s is %s without contacting the server or changing work', async (flag, value) => {
  const store = createIndexedDbOfflineStore({ indexedDB, databaseName: `gallery-gate-${crypto.randomUUID()}` });
  try {
   await store.writeGeneration(1, JSON.stringify(fixture())); await store.writeMeta('activeGeneration', '1');
   for (const name of ['offlineMutations', 'offlineGalleryOrder']) if (name !== flag) await store.writeMeta(`capability.${name}`, '1');
   if (value !== null) await store.writeMeta(`capability.${flag}`, value);
   const online = vi.fn(); const api = createOfflineAwareGalleryApi({ setGalleryOrder: online } as unknown as GalleryApi, store, { clientId: 'phone' });
   await api.preferOfflineSnapshot!();
   await expect(api.setGalleryOrder(['Alpha', 'Hidden', 'Zebra'])).rejects.toThrow('enable Gallery ordering');
   expect(online).not.toHaveBeenCalled(); expect(await store.list()).toEqual([]);
   expect((await api.listGalleries()).map(row => row.type)).toEqual(['Zebra', 'Hidden', 'Alpha']);
  } finally { store.close(); }
 });
 it('keeps legacy snapshots readable without claiming an order owner',()=>{
  const old=fixture();delete old.payload.galleryOrder;
  expect(createOfflineLibrary(old).listGalleries().map(row=>row.type)).toEqual(['Alpha','Hidden','Zebra']);
 });
});
