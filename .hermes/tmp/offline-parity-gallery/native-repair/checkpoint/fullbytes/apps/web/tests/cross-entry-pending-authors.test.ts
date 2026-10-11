// @vitest-environment jsdom
import { flushPromises, mount, enableAutoUnmount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import SearchPage from '../src/SearchPage.vue';
import { setLocale } from '../src/i18n.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createMemorySnapshotStore, ACTIVE_GENERATION_KEY } from '../src/offline/snapshot-store.js';
import { createMemoryOutboxStore } from '../src/offline/outbox-store.js';
import { createMemoryMediaOutboxStore } from '../src/offline/media-outbox-store.js';
import type { GalleryApi } from '../src/api/gallery.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
enableAutoUnmount(afterEach);
const clientId='cross-client';
async function setup(durable?:ReturnType<typeof createIndexedDbOfflineStore>) {
 const outbox=createMemoryOutboxStore();
 const store=durable ?? {...createMemorySnapshotStore(),...outbox,...createMemoryMediaOutboxStore(op=>outbox.enqueue(op))};
 const snapshot=offlineSnapshot();
 await store.writeGeneration(1,JSON.stringify(snapshot));await store.writeMeta(ACTIVE_GENERATION_KEY,'1');
 for(const flag of ['offlineEntryCreate','offlineEntryAuthors','offlinePendingEntryAuthors','offlineAuthorCreate','offlinePendingEntryAuthorCreate','offlineCrossEntryPendingAuthors']) await store.writeMeta(`capability.${flag}`,'1');
 const online={queryEntryPage:vi.fn().mockRejectedValue(new TypeError('offline')),suggestProducers:vi.fn().mockRejectedValue(new TypeError('offline'))} as unknown as GalleryApi;
 const api=createOfflineAwareGalleryApi(online,store,{clientId});
 const draft={title:'Cross A',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null};
 const a=await api.enqueueOfflineEntryCreate!(draft),author=await api.enqueueOfflinePendingEntryAuthorCreate!(a.localKey,'Cross Author');
 const b=await api.enqueueOfflineEntryCreate!({...draft,title:'Cross B'});
 return {api,store,a,b,author,online};
}
it('matches UUID case in atomic dependencies and keeps queued bodies immutable through cleanup',async()=>{
 const {store,b,author}=await setup();const before=await store.list();const source=before[1]!,parent=before[2]!;
 const child={...source,opId:crypto.randomUUID(),entityUid:parent.entityUid.toUpperCase(),operationKind:'entry.authors.set',baseVersion:0,baseValues:{producerUids:[]},payload:{parentCreateOpId:parent.opId.toUpperCase(),producerUids:[author.producerUid.toUpperCase()],producerCreates:[{producerUid:author.producerUid.toUpperCase(),createOpId:source.opId.toUpperCase()}]}};
 await store.enqueue(child);expect((await store.list()).at(-1)).toEqual(child);
 await store.removeApplied(before.map(row=>row.opId));expect(await store.list()).toEqual([...before,child]);
 expect(b.localKey).toBe(`local:${parent.entityUid}`);
});
it('actual pending Search callback links B to the staged Author created on A',async()=>{
 setLocale('en');const {api,store,b,author}=await setup();
 const wrapper=mount(SearchPage,{props:{api,initialQuery:'Cross B',initialScope:'entries',nsfwEntryTypes:[]},global:{stubs:{PagedCardGrid:true}}});
 await flushPromises();await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');await flushPromises();
 await wrapper.get('[data-testid="pending-author-query"]').setValue('Cross');
 await wrapper.get('[data-testid="pending-author-option"]').trigger('click');
 await wrapper.get('[data-testid="pending-author-form"]').trigger('submit');await flushPromises();
 expect((await api.listPendingOfflineEntryCreates!()).find(row=>row.localKey===b.localKey)?.authors).toEqual([author]);
 expect((await store.list()).at(-1)?.payload.producerCreates).toEqual([{producerUid:author.producerUid,createOpId:(await store.list())[1]!.opId}]);
});
it.each(['missing','failed-source','conflict-source','orphan'] as const)('refuses unsafe cross-target enqueue: %s',async reason=>{
 const {api,store,b,author}=await setup();const source=(await store.list())[1]!;
 if(reason==='missing') await store.writeMeta('capability.offlineCrossEntryPendingAuthors','0');
 if(reason==='failed-source'||reason==='conflict-source') await store.update(source.opId,{status:reason==='failed-source'?'failed':'conflict'});
 if(reason==='orphan') await store.remove(source.opId);
 const before=await store.list();await expect(api.enqueueOfflinePendingEntryAuthors!(b.localKey,[author.producerUid])).rejects.toThrow();expect(await store.list()).toEqual(before);
});
it('never transports a staged numeric Author ID after an online read switches mode',async()=>{
 const {api,online,store}=await setup();const suggestion=(await api.suggestProducers({q:'Cross'}))[0]!;
 online.listAuthors=vi.fn().mockResolvedValue([]);online.linkEntryAuthor=vi.fn().mockResolvedValue(undefined);
 online.fetchSyncSnapshot=vi.fn().mockResolvedValue(offlineSnapshot());
 await api.fetchSyncSnapshot();
 online.getEntry=vi.fn().mockResolvedValue({id:1});
 await api.getEntry(1);expect(online.getEntry).toHaveBeenCalledWith(1);
 await api.linkEntryAuthor(1,suggestion.id);
 expect(online.linkEntryAuthor).not.toHaveBeenCalled();expect((await store.list()).at(-1)?.operationKind).toBe('entry.authors.set');
});
it('durably unlinks a staged Author after recovery without changing source or other target links',async()=>{
 const databaseName=crypto.randomUUID();const first=createIndexedDbOfflineStore({indexedDB,databaseName});
 try {
  const {api,online,store,a,b,author}=await setup(first);
  await api.enqueueOfflinePendingEntryAuthors!(b.localKey,[author.producerUid]);
  const suggestion=(await api.suggestProducers({q:'Cross'}))[0]!;
  await api.linkEntryAuthor(1,suggestion.id);
  const before=await store.list();const source=before[1]!;const target=before.at(-1)!;
  online.fetchSyncSnapshot=vi.fn().mockResolvedValue(offlineSnapshot());
  online.getEntry=vi.fn().mockResolvedValue({id:1});
  online.unlinkEntryAuthor=vi.fn().mockRejectedValue(new Error('negative ID rejected'));
  await api.fetchSyncSnapshot();await api.getEntry(1);expect(online.getEntry).toHaveBeenCalledWith(1);
  await api.unlinkEntryAuthor(1,suggestion.id);
  expect(online.unlinkEntryAuthor).not.toHaveBeenCalled();
  const after=await store.list();expect(after.slice(0,before.length)).toEqual(before);
  expect(after.at(-1)).toMatchObject({operationKind:'entry.authors.set',entityUid:target.entityUid,baseValues:{producerUids:target.payload.producerUids},payload:{producerUids:(target.payload.producerUids as string[]).filter(uid=>uid!==author.producerUid),producerCreates:[{producerUid:author.producerUid,createOpId:source.opId}]}});
  await api.fetchSyncSnapshot();await api.getEntry(1);
  const error=new Error('positive ID permission refused');online.unlinkEntryAuthor=vi.fn().mockRejectedValue(error);
  await expect(api.unlinkEntryAuthor(1,9)).rejects.toBe(error);
  expect(online.unlinkEntryAuthor).toHaveBeenCalledWith(1,9);
  expect(await store.list()).toEqual(after);
  first.close();const reopened=createIndexedDbOfflineStore({indexedDB,databaseName});
  try {
   expect(await reopened.list()).toEqual(after);
   const restart=createOfflineAwareGalleryApi({} as GalleryApi,reopened,{clientId});
   const pending=await restart.listPendingOfflineEntryCreates!();
   expect(pending.find(row=>row.localKey===a.localKey)?.authors).toContainEqual(author);
   expect(pending.find(row=>row.localKey===b.localKey)?.authors).toContainEqual(author);
   expect((await restart.suggestProducers({q:'Cross'})).map(row=>row.id)).toContain(suggestion.id);
  }finally{reopened.close();}
 }finally{first.close();}
});
it('cold reopens durable cross-target options and retains transitive sources during two-instance cleanup',async()=>{
 const databaseName=crypto.randomUUID();const first=createIndexedDbOfflineStore({indexedDB,databaseName});
 try {
  const {api,store,b,author}=await setup(first);await api.enqueueOfflinePendingEntryAuthors!(b.localKey,[author.producerUid]);
  const before=await store.list();first.close();
  const reopened=createIndexedDbOfflineStore({indexedDB,databaseName}),second=createIndexedDbOfflineStore({indexedDB,databaseName});
  try {
   const restart=createOfflineAwareGalleryApi({} as GalleryApi,reopened,{clientId});
   expect((await restart.getPendingOfflineEntryAuthorOptions!(b.localKey)).authors).toContainEqual(author);
   await reopened.removeApplied(before.slice(0,3).map(row=>row.opId));expect(await second.list()).toEqual(before);
   const target={...before[3]!,opId:crypto.randomUUID(),baseValues:{producerUids:[author.producerUid]},payload:{...before[3]!.payload,producerUids:[]}};
   const results=await Promise.allSettled([reopened.removeApplied(before.map(row=>row.opId)),second.enqueue(target)]);
   const rows=await second.list();
   if(results[1]!.status==='fulfilled') expect(rows.map(row=>row.opId)).toEqual([before[0]!.opId,before[1]!.opId,before[2]!.opId,target.opId]);
   else expect(rows).toEqual([]);
  }finally{reopened.close();second.close();}
 }finally{first.close();}
});
it.each(['clientId','libraryId','syncEpoch'] as const)('rejects a staged Producer from foreign %s on synced targets',async(field)=>{
 const {api,store,author}=await setup();const source=(await store.list())[1]!;
 await store.remove(source.opId);await store.enqueue({...source,[field]:'foreign',payload:{producerUid:source.payload.producerUid!,name:source.payload.name!},baseVersion:1});
 const before=await store.list();
 const candidates=await api.suggestProducers({q:'Cross'});
 const candidate=candidates.find(row=>row.name===author.name);
 if(candidate) await expect(api.linkEntryAuthor(1,candidate.id)).rejects.toThrow();
 expect(candidate).toBeUndefined();expect(await store.list()).toEqual(before);
});

it('projects uppercase staged Producer identity canonically without rewriting its durable source',async()=>{
 const {api,store,b,author}=await setup();const source=(await store.list())[1]!;
 await store.remove(source.opId);const upper={...source,payload:{...source.payload,producerUid:author.producerUid.toUpperCase()}};await store.enqueue(upper);
 expect((await api.getPendingOfflineEntryAuthorOptions!(b.localKey)).authors).toContainEqual(author);
 await api.enqueueOfflinePendingEntryAuthors!(b.localKey,[author.producerUid.toUpperCase()]);
 const before=await store.list();await api.enqueueOfflinePendingEntryAuthors!(b.localKey,[author.producerUid]);expect(await store.list()).toEqual(before);
 expect((await store.list()).find(row=>row.opId===source.opId)).toEqual(upper);
});
