import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { mount, flushPromises } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const window = new JSDOM('<!doctype html><html><body></body></html>', {url:'http://isolated/'}).window;
  for (const key of ['window','document','Element','HTMLElement','SVGElement','Node','localStorage','sessionStorage','MutationObserver','navigator','getComputedStyle'])
    Object.defineProperty(globalThis,key,{value:key === 'window' ? window : window[key as keyof typeof window],configurable:true});
  Object.defineProperty(globalThis,'addEventListener',{value:window.addEventListener.bind(window),configurable:true});
  Object.defineProperty(globalThis,'removeEventListener',{value:window.removeEventListener.bind(window),configurable:true});
});
import GalleryApp from '../src/GalleryApp.vue';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi, localCollectionId } from '../src/offline/offline-api.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
import { operationFingerprint } from '../src/offline/outbox-store.js';
import { setLocale } from '../src/i18n.js';
const serverModule = async(path:string) => {const target=`../../server/src/${path}.js`;return import(/* @vite-ignore */ target);};
const settle=async()=>{for(let i=0;i<15;i++){await flushPromises();await new Promise(resolve=>setTimeout(resolve,5));}};
async function fixture(){
  const {createMigratedMemoryDatabase}=await serverModule('database/testing');
  const {createEntry}=await serverModule('repositories/entry-repository');
  const {createProducer,linkEntryProducer}=await serverModule('repositories/producer-repository');
  const {createEntryRatingSlot,createProducerRatingSlot,setEntryRating,setProducerRating}=await serverModule('repositories/rating-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-entry-dimension-'));
  const work=createEntry(db,{title:'Rated work',type:'Comic'}),peer=createEntry(db,{title:'Rated peer',type:'Comic'}),other=createEntry(db,{title:'Other type',type:'Film'});
  const author=createProducer(db,{name:'Preserved Author'});linkEntryProducer(db,work.id,author.id);
  const slot=createEntryRatingSlot(db,{entryId:work.id,name:'Quality'}),keep=createEntryRatingSlot(db,{entryId:work.id,name:'Keep'}),foreign=createEntryRatingSlot(db,{entryId:other.id,name:'Quality'});
  const summary=createProducerRatingSlot(db,{producerId:author.id,name:'Quality'}),self=createProducerRatingSlot(db,{producerId:author.id,name:'Quality',kind:'author_self'});
  for(const entry of [work,peer])setEntryRating(db,{entryId:entry.id,slotId:slot.id,stars:4});
  setEntryRating(db,{entryId:other.id,slotId:foreign.id,stars:3});setProducerRating(db,{producerId:author.id,slotId:summary.id,stars:3.5});setProducerRating(db,{producerId:author.id,slotId:self.id,stars:5});
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false,loseReplay=false,loseAck=false;
  const calls:string[]=[],bodies:string[]=[];
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);if(disconnected)throw new TypeError('Known offline');
    if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));const response=await app.request(url.pathname+url.search,init);
    if(loseReplay && url.pathname==='/api/sync/replay' && response.ok){loseReplay=false;throw new TypeError('SQL response lost');}
    if(loseAck && url.pathname.includes('/ack') && response.ok){loseAck=false;throw new TypeError('ACK response lost');}return response;
  }}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();let store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'entry-rating-phone',randomUUID});
  return {db,root,work,peer,other,author,slot,keep,foreign,summary,self,api,online,calls,bodies,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
    async deleteMeta(key:string){const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(databaseName);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}finally{db.close();}},
    reconnect(){disconnected=false;},loseResponse(){loseReplay=true;},loseAcknowledgement(){loseAck=true;},
    cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'entry-rating-phone',randomUUID});},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
}
it('ordinary Entry dimension confirmation deletes shared same-type rows through durable cold restore exact SQL retry and ACK',async()=>{
  const f=await fixture();setLocale('en');vi.stubGlobal('scrollTo',vi.fn());await f.offline();
  const wrapper=mount(GalleryApp,{props:{api:f.api,offlineStore:f.store}});
  try{
    await settle();await wrapper.get('[data-gallery-type="Comic"]').trigger('click');await settle();
    const card=wrapper.findAll('button').find(row=>row.text().includes('Rated work'));expect(card).toBeDefined();await card!.trigger('click');await settle();
    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');await settle();
    await wrapper.get(`[data-delete-rating-slot-id="${f.slot.id}"]`).trigger('click');await settle();
    expect(await f.store.list()).toEqual([]);await wrapper.get('[data-testid="rating-delete-confirm"]').trigger('click');await settle();
    expect(await f.store.list()).toHaveLength(1);expect(f.calls.filter(call => !call.startsWith('GET '))).toEqual([]);
    expect(wrapper.find(`[data-rating-slot-id="${f.slot.id}"]`).exists()).toBe(false);
    const original=(await f.store.list())[0]!,fingerprint=operationFingerprint(original);
    expect(original).toMatchObject({operationKind:'rating-layout.slots.set',entityKind:'rating_layout'});
    expect(original.entityUid).not.toBe(f.db.prepare('SELECT sync_uid FROM entries WHERE id=?').pluck().get(f.work.id));
    expect(original.payload.deletedSlotUids).toHaveLength(1);
    let cold=f.cold();await cold.preferOfflineSnapshot!();
    for(const entry of [f.work,f.peer])expect((await cold.getEntry(entry.id)).ratings.map(row=>row.slotId)).toEqual([f.keep.id]);
    expect((await cold.getEntry(f.other.id)).ratings).toContainEqual({slotId:f.foreign.id,name:'Quality',stars:3});
    const archive=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany([original.opId]);await cold.restorePendingWork!(archive);expect(operationFingerprint((await f.store.list())[0]!)).toBe(fingerprint);
    f.reconnect();f.loseResponse();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(await f.store.list()).toHaveLength(1);
    expect(f.db.prepare('SELECT count(*) FROM entry_rating_values WHERE slot_id=?').pluck().get(f.slot.id)).toBe(0);
    expect(f.db.prepare('SELECT count(*) FROM rating_slots WHERE id=?').pluck().get(f.slot.id)).toBe(0);
    f.loseAcknowledgement();await cold.replayOfflineOperations!();expect(await f.store.list()).toHaveLength(1);
    cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(await f.store.list()).toEqual([]);
    expect(new Set(f.bodies).size).toBe(1);expect(f.db.prepare('SELECT count(*) FROM sync_operation_receipts WHERE op_id=?').pluck().get(original.opId)).toBe(1);
    expect(f.db.prepare("SELECT count(*) FROM sync_changes WHERE entity_kind='rating_layout' AND entity_uid=? AND resource_version>?").pluck().get(original.entityUid,original.baseVersion)).toBe(1);
    expect(f.db.prepare('SELECT stars FROM producer_rating_values WHERE slot_id=?').pluck().get(f.summary.id)).toBe(3.5);expect(f.db.prepare('SELECT stars FROM producer_rating_values WHERE slot_id=?').pluck().get(f.self.id)).toBe(5);
  }finally{wrapper.unmount();f.close();vi.unstubAllGlobals();}
});

it('required deletion flags false or absent and missing stable owner fail closed without business HTTP',async()=>{
 for(const flag of ['offlineMutations','offlineRatingSlotLayout','offlineRatingSlotDelete'])for(const value of ['0','']){
  const f=await fixture();try{await f.offline();if(value==='')await f.deleteMeta('capability.'+flag);else await f.store.writeMeta('capability.'+flag,value);await expect(f.api.deleteEntryRatingSlot(f.work.id,f.slot.id)).rejects.toThrow('not available under offline');expect(await f.store.list()).toEqual([]);expect(f.calls).toEqual([]);}finally{f.close();}
 }
 const f=await fixture();try{await f.offline();f.reconnect();const snapshot=await f.online.fetchSyncSnapshot();snapshot.payload.ratingLayouts=snapshot.payload.ratingLayouts!.filter(row=>row.subjectKind!=='entry' || row.entryType!=='Comic');const {checksum,...header}=snapshot.header;void checksum;snapshot.header.checksum=createHash('sha256').update(JSON.stringify(header)).update(JSON.stringify(snapshot.payload)).digest('hex');await f.store.writeGeneration(2,JSON.stringify(snapshot));await f.store.writeMeta('activeGeneration','2');const cold=f.cold();await cold.preferOfflineSnapshot!();await expect(cold.deleteEntryRatingSlot(f.work.id,f.slot.id)).rejects.toThrow('stable layout identity');
  await expect(f.api.deleteEntryRatingSlot(f.work.id,f.foreign.id)).rejects.toThrow('not available under offline');expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});
it('connected no-copy and old-copy delete uses bounded original UUID command and response loss retry',async()=>{
 for(const saved of [false,true]){
  const f=await fixture();try{
   if(saved){await f.offline();f.reconnect();await f.api.getSyncCapabilities({replay:false});}
   f.calls.length=0;f.loseResponse();await f.api.deleteEntryRatingSlot(f.work.id,f.slot.id);
   const original=(await f.store.list())[0]!;expect(original).toBeDefined();expect(original.operationKind).toBe('rating-layout.slots.set');
   expect(f.calls.filter(row=>row.includes('/snapshot')||row.includes('/delta')||row.startsWith('DELETE '))).toEqual([]);
   const cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(new Set(f.bodies).size).toBe(1);
   expect(await f.store.list()).toEqual([]);
   if(!saved){expect(await f.store.readMeta('activeGeneration')).toBeNull();expect(f.calls.some(row=>row.includes('/snapshot')||row.includes('/delta')||row.includes('/ack'))).toBe(false);}
  }finally{f.close();}
 }
});
it('no-copy rating deletion settles an online success immediately and reports zero pending work',async()=>{
 const f=await fixture();try{
  const state={mode:'online' as const,lastFallbackAt:null,pendingCount:0};
  const api=createOfflineAwareGalleryApi(f.online,f.store,{clientId:'entry-rating-phone',randomUUID,state});
  await api.deleteEntryRatingSlot(f.work.id,f.slot.id);
  expect(await f.store.list()).toEqual([]);expect(state.pendingCount).toBe(0);
  expect(f.db.prepare('SELECT count(*) FROM rating_slots WHERE id=?').pluck().get(f.slot.id)).toBe(0);
  expect(f.db.prepare('SELECT count(*) FROM sync_operation_receipts').pluck().get()).toBe(1);
  expect(await f.store.readMeta('activeGeneration')).toBeNull();
  expect(f.calls.some(row=>row.includes('/snapshot')||row.includes('/delta')||row.includes('/ack'))).toBe(false);
 }finally{f.close();}
});
it('no-copy rating deletion recovers a legacy original after later online changes without overwriting them',async()=>{
 const f=await fixture();try{
  f.loseResponse();await f.api.deleteEntryRatingSlot(f.work.id,f.slot.id);const original=(await f.store.list())[0]!;
  const added=await f.online.createEntryRatingSlot(f.work.id,'Later online dimension');
  const cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);expect(f.db.prepare('SELECT name FROM rating_slots WHERE id=?').pluck().get(added.id)).toBe('Later online dimension');
  expect(new Set(f.bodies).size).toBe(1);expect(JSON.parse(f.bodies[0]!).opId).toBe(original.opId);
  expect(f.calls.some(row=>row.includes('/snapshot')||row.includes('/delta')||row.includes('/ack'))).toBe(false);
 }finally{f.close();}
});
it.each(['missing','foreign-owner','wrong-class','wrong-version','foreign-receipt','lost-journal'] as const)('no-copy rating deletion retains its original on %s proof and recovers on a valid retry',async fault=>{
 const f=await fixture();try{
  f.loseResponse();await f.api.deleteEntryRatingSlot(f.work.id,f.slot.id);const original=(await f.store.list())[0]!,fingerprint=operationFingerprint(original);
  const online={...f.online,replaySyncOperation:async(operation:Parameters<NonNullable<typeof f.online.replaySyncOperation>>[0])=>{
   const result=await f.online.replaySyncOperation!(operation);return fault==='foreign-receipt'?{...result,opId:randomUUID()}:result;
  },getEntryRatingLayoutSettlement:async(layoutUid:string,opId:string)=>{
   if(fault==='lost-journal')throw new TypeError('Journal response lost');
   const proof=await f.online.getEntryRatingLayoutSettlement!(layoutUid,opId);const row=proof.predecessor;
   if(fault==='missing')proof.predecessor=undefined as unknown as typeof row;if(fault==='foreign-owner')row.entityUid=randomUUID();
   if(fault==='wrong-version')row.resourceVersion+=1;if(fault==='wrong-class')Object.assign(row,{subjectKind:'producer'});return proof;
  }};
  const cold=createOfflineAwareGalleryApi(online,f.store,{clientId:'entry-rating-phone',randomUUID});
  await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toHaveLength(1);expect(operationFingerprint((await f.store.list())[0]!)).toBe(fingerprint);
  const retry=f.cold();await retry.getSyncCapabilities({replay:false});await retry.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT count(*) FROM sync_operation_receipts').pluck().get()).toBe(1);
 }finally{f.close();}
});
it('pending dimension creation is a real same-owner predecessor while unsupported pending new type refuses',async()=>{
 const f=await fixture();try{await f.offline();const slot=await f.api.createEntryRatingSlot(f.work.id,'Pending dimension');await f.api.deleteEntryRatingSlot(f.peer.id,slot.id);const rows=await f.store.list();expect(rows).toHaveLength(2);expect(rows[1]!.entityUid).toBe(rows[0]!.entityUid);expect(rows[1]!.baseVersion).toBe(rows[0]!.baseVersion+1);
  const archive=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany(rows.map(row=>row.opId));await f.api.restorePendingWork!(archive);expect(await f.store.list()).toEqual(rows);
  f.reconnect();await f.api.getSyncCapabilities({replay:false});await f.api.replayOfflineOperations!();expect(await f.store.list()).toEqual([]);expect(f.bodies.map(body=>JSON.parse(body).opId)).toEqual(rows.map(row=>row.opId));
  await f.api.preferOfflineSnapshot!();await f.api.enqueueOfflineEntryCreate!({title:'Pending type',type:'Unknown type',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});const pending=await f.api.listPendingOfflineEntryCreates!();const prior=await f.store.list();await expect(f.api.deleteEntryRatingSlot(localCollectionId(pending[0]!.localKey.slice(6)),f.slot.id)).rejects.toThrow();expect(await f.store.list()).toEqual(prior);
 }finally{f.close();}
});
it('held same layout blocks its successor but independent Entry and layout progress; general off holds all',async()=>{
 const f=await fixture();try{await f.offline();await f.api.deleteEntryRatingSlot(f.work.id,f.slot.id);await f.api.deleteEntryRatingSlot(f.peer.id,f.keep.id);await f.api.setEntryRating(f.other.id,f.foreign.id,4);await f.api.deleteEntryRatingSlot(f.other.id,f.foreign.id);
  const rows=await f.store.list();await f.store.update(rows[0]!.opId,{status:'conflict',lastError:'held'});f.reconnect();await f.store.writeMeta('capability.offlineMutations','0');await f.api.replayOfflineOperations!();expect(f.bodies).toEqual([]);
  await f.store.writeMeta('capability.offlineMutations','1');await f.api.replayOfflineOperations!();expect(f.bodies.map(body=>JSON.parse(body).opId)).not.toContain(rows[1]!.opId);expect(f.bodies.map(body=>JSON.parse(body).opId)).toContain(rows[2]!.opId);
 }finally{f.close();}
});
it('foreign archive atomically refuses and foreign receipt never cleans original',async()=>{
 const f=await fixture();try{await f.offline();await f.api.deleteEntryRatingSlot(f.work.id,f.slot.id);const rows=await f.store.list();const archive=await buildPendingWorkExport(f.store);archive.operations[0]!.syncEpoch='foreign';await expect(f.api.restorePendingWork!(JSON.stringify(archive))).rejects.toThrow();expect(await f.store.list()).toEqual(rows);
  f.reconnect();const online={...f.online,replaySyncOperation:async(operation:Parameters<NonNullable<typeof f.online.replaySyncOperation>>[0])=>({...await f.online.replaySyncOperation!(operation),opId:randomUUID()})};const api=createOfflineAwareGalleryApi(online,f.store,{clientId:'entry-rating-phone',randomUUID});await api.getSyncCapabilities({replay:false});await api.replayOfflineOperations!();expect(operationFingerprint((await f.store.list())[0]!)).toBe(operationFingerprint(rows[0]!));
 }finally{f.close();}

 const semantic=await fixture();try{
  await semantic.offline();await semantic.api.deleteEntryRatingSlot(semantic.work.id,semantic.slot.id);const original=(await semantic.store.list())[0]!;semantic.reconnect();
  const {fetchSnapshotDelta,...rest}=semantic.online;void fetchSnapshotDelta;
  const online={...rest,fetchSyncSnapshot:async()=>{const snapshot=await semantic.online.fetchSyncSnapshot();const layout=snapshot.payload.ratingLayouts!.find(row=>row.syncUid===original.entityUid)!;layout.syncVersion=original.baseVersion;const {checksum,...header}=snapshot.header;void checksum;snapshot.header.checksum=createHash('sha256').update(JSON.stringify(header)).update(JSON.stringify(snapshot.payload)).digest('hex');return snapshot;}};
  const api=createOfflineAwareGalleryApi(online,semantic.store,{clientId:'entry-rating-phone',randomUUID});await api.getSyncCapabilities({replay:false});await api.replayOfflineOperations!();expect(await semantic.store.list()).toHaveLength(1);
 }finally{semantic.close();}
});
