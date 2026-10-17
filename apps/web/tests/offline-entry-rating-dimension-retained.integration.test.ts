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
import FacetFilterBar from '../src/components/FacetFilterBar.vue';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
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
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false,loseReplay=false,loseAck=false,exceptReplay:string|undefined;
  const calls:string[]=[],bodies:string[]=[];
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);if(disconnected)throw new TypeError('Known offline');
    if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));const response=await app.request(url.pathname+url.search,init);
    if(loseReplay && url.pathname==='/api/sync/replay' && response.ok && JSON.parse(String(init?.body)).opId!==exceptReplay){loseReplay=false;throw new TypeError('SQL response lost');}
    if(loseAck && url.pathname.includes('/ack') && response.ok){loseAck=false;throw new TypeError('ACK response lost');}return response;
  }}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();let store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'entry-rating-phone',randomUUID});
  return {db,root,work,peer,other,author,slot,keep,foreign,summary,self,api,online,calls,bodies,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
    async deleteMeta(key:string){const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(databaseName);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}finally{db.close();}},
    reconnect(){disconnected=false;},loseResponse(except?:string){loseReplay=true;exceptReplay=except;},loseAcknowledgement(){loseAck=true;},
    cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'entry-rating-phone',randomUUID});},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
}
it('connected different dimension successor keeps bounded exact originals through cold response loss without snapshot',async()=>{
 for(const saved of [false,true]){
  const f=await fixture();try{
   if(saved){await f.offline();f.reconnect();await f.api.getSyncCapabilities({replay:false});}
   f.calls.length=0;f.loseResponse();await f.api.deleteEntryRatingSlot(f.work.id,f.slot.id);
   const first=(await f.store.list())[0]!,fingerprint=operationFingerprint(first);
   const cold=f.cold();await cold.getSyncCapabilities({replay:false});f.loseResponse(first.opId);await cold.deleteEntryRatingSlot(f.peer.id,f.keep.id);
   const rows=await f.store.list();expect(rows).toHaveLength(2);expect(operationFingerprint(rows[0]!)).toBe(fingerprint);
   expect(rows[1]!.baseVersion).toBe(first.baseVersion+1);expect(rows[1]!.baseValues).toEqual({slots:first.payload.slots});
   expect(rows[1]!.opId).not.toBe(first.opId);expect(rows[1]!.payload.slots).toEqual([]);
   if(saved){const archive=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany(rows.map(row=>row.opId));await cold.restorePendingWork!(archive);expect(await f.store.list()).toEqual(rows);}
   expect(f.db.prepare("SELECT count(*) FROM rating_slots WHERE subject_kind='entry' AND entry_type='Comic'").pluck().get()).toBe(0);
   expect(f.calls.filter(row=>row.includes('/snapshot')||row.includes('/delta')||row.includes('/ack')||row.startsWith('DELETE '))).toEqual([]);
   expect(await f.store.readMeta('activeGeneration')).toBe(saved?'1':null);
   expect(f.bodies.filter(body=>JSON.parse(body).opId===first.opId).every(body=>body===f.bodies[0])).toBe(true);
   const before=await f.store.list();await expect(cold.deleteEntryRatingSlot(f.work.id,f.slot.id)).rejects.toThrow();expect(await f.store.list()).toEqual(before);
  }finally{f.close();}
 }
});

it('ordinary Gallery deletion invalidates deleted rating constraints sort cached rows and older inflight response',async()=>{
 const f=await fixture();await f.offline();setLocale('en');vi.stubGlobal('scrollTo',vi.fn());
 type Query=Parameters<typeof f.api.queryEntryPage>[0];const queries:Query[]=[];
 let release:((value:Awaited<ReturnType<typeof f.api.queryEntryPage>>)=>void)|undefined;let held=false;
 const api={...f.api,listFacetFilterOptions:async(type:string)=>({...await f.api.listFacetFilterOptions(type),allTags:[{tagId:999,name:'Visible filter fixture'}]}),queryEntryPage:async(query:Query)=>{
  queries.push(JSON.parse(JSON.stringify(query)));if(held){held=false;return new Promise<Awaited<ReturnType<typeof f.api.queryEntryPage>>>(resolve=>{release=resolve;});}return f.api.queryEntryPage(query);
 }};
 const wrapper=mount(GalleryApp,{props:{api,offlineStore:f.store}});
 try{
  await settle();await wrapper.get('[data-gallery-type="Comic"]').trigger('click');await settle();
  const filters={conditions:[],authorIds:[f.author.id],ratingConditions:[{slotId:f.slot.id,operator:'gt',stars:3},{slotId:f.keep.id,operator:'unrated',stars:null}],ratingSort:{slotId:f.slot.id,direction:'desc',applyAuthorRating:false},usageConditions:[{field:'views',operator:'gt',value:0}],usageSort:null};
  // Keep the current card visible while the older filtered query waits.
  const old=await f.api.queryEntryPage({entryType:'Comic',conditions:[],authorIds:[],ratingConditions:[],ratingSort:null,usageConditions:[],usageSort:null,page:1,pageSize:30,sort:'title-asc'});
  held=true;wrapper.findComponent(FacetFilterBar).vm.$emit('update:modelValue',filters);await settle();expect(release).toBeDefined();
  const card=wrapper.findAll('button').find(row=>row.text().includes('Rated work'));await card!.trigger('click');await settle();
  await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');await wrapper.get(`[data-delete-rating-slot-id="${f.slot.id}"]`).trigger('click');await wrapper.get('[data-testid="rating-delete-confirm"]').trigger('click');await settle();
  const last=queries.at(-1)!;expect(last.ratingConditions).toEqual([filters.ratingConditions[1]]);expect(last.ratingSort).toBeNull();expect(last.authorIds).toEqual(filters.authorIds);expect(last.usageConditions).toEqual(filters.usageConditions);
  release!(old);await settle();
  const state=(wrapper.vm.$ as unknown as {setupState:unknown}).setupState as {entries:Array<{id:number}>;facetFilters:typeof filters;closeEntry:()=>Promise<void>};
  expect(state.entries).toEqual([]);expect(state.facetFilters.ratingConditions).toEqual([filters.ratingConditions[1]]);await wrapper.get('[data-testid="entry-back"]').trigger('click');await settle();expect(wrapper.find('[data-testid="entry-list"]').text()).not.toContain('Rated peer');
 }finally{wrapper.unmount();f.close();vi.unstubAllGlobals();}
});

it('cold detail options bounded queries and ratings aggregates equal canonical SQL after same-type cascade',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.deleteEntryRatingSlot(f.work.id,f.slot.id);const cold=f.cold();await cold.preferOfflineSnapshot!();
  const before=[await cold.getEntry(f.work.id),await cold.getEntry(f.peer.id),await cold.getEntry(f.other.id),await cold.getAuthor(f.author.id)];
  const queries=[{entryType:'Comic',ratingConditions:[],ratingSort:null},{entryType:'Comic',ratingConditions:[{slotId:f.keep.id,operator:'unrated' as const,stars:null}],ratingSort:{slotId:f.keep.id,direction:'desc' as const,applyAuthorRating:false}},{entryType:'Film',ratingConditions:[{slotId:f.foreign.id,operator:'gt' as const,stars:2}],ratingSort:{slotId:f.foreign.id,direction:'desc' as const,applyAuthorRating:false}}].map(q=>({...q,conditions:[],authorIds:[],usageConditions:[],usageSort:null,sort:'title-asc' as const,page:1,pageSize:30}));
  const projected=await Promise.all(queries.map(q=>cold.queryEntryPage(q)));const options=await cold.listFacetFilterOptions('Comic');
  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(await f.store.list()).toEqual([]);
  const canonical=[await f.online.getEntry(f.work.id),await f.online.getEntry(f.peer.id),await f.online.getEntry(f.other.id),await f.online.getAuthor(f.author.id)];expect(before.map(row=>row.ratings)).toEqual(canonical.map(row=>row.ratings));expect('authorSelfRatings' in before[3]! ? before[3]!.authorSelfRatings : null).toEqual('authorSelfRatings' in canonical[3]! ? canonical[3]!.authorSelfRatings : null);expect(options).toEqual(await f.online.listFacetFilterOptions('Comic'));
  const canonicalPages=await Promise.all(queries.map(q=>f.online.queryEntryPage(q)));
  for(const page of canonicalPages)for(const row of page.items)delete row.coverText;
  expect(projected).toEqual(canonicalPages);
  expect(f.db.prepare('SELECT count(*) FROM entry_rating_values WHERE slot_id=?').pluck().get(f.slot.id)).toBe(0);
  const reopened=f.cold();await reopened.preferOfflineSnapshot!();expect(await Promise.all(queries.map(q=>reopened.queryEntryPage(q)))).toEqual(projected);
 }finally{f.close();}
});
it('finite valid-checksum semantic owners values epochs and bounded foreign journals retain immutable originals',async()=>{
 for(const variant of ['ownerAbsent','wrongClass','wrongType','higherUnrelated','oldValue','extraSlot','epoch']){
  const f=await fixture();try{
   await f.offline();await f.api.deleteEntryRatingSlot(f.work.id,f.slot.id);const original=(await f.store.list())[0]!;const source=await f.store.readGeneration(1);const initial=JSON.parse(source!);f.reconnect();
   const {fetchSnapshotDelta,...rest}=f.online;void fetchSnapshotDelta;
   const online={...rest,fetchSyncSnapshot:async()=>{
    const snapshot=await f.online.fetchSyncSnapshot();const layout=snapshot.payload.ratingLayouts!.find(row=>row.syncUid===original.entityUid)!;
    if(variant==='ownerAbsent')snapshot.payload.ratingLayouts=snapshot.payload.ratingLayouts!.filter(row=>row.syncUid!==original.entityUid);
    if(variant==='wrongClass')layout.subjectKind='producer';if(variant==='wrongType')layout.entryType='Film';if(variant==='higherUnrelated')layout.syncVersion+=1;
    if(variant==='oldValue')snapshot.payload.entryRatingValues.push(initial.payload.entryRatingValues.find((row:{slotId:number})=>row.slotId===f.slot.id));
    if(variant==='extraSlot'){snapshot.payload.ratingSlots.push({...initial.payload.ratingSlots.find((row:{id:number})=>row.id===f.slot.id),id:987,syncUid:randomUUID()});}
    if(variant==='epoch')snapshot.header.syncEpoch='foreign-epoch';
    const {checksum,...header}=snapshot.header;void checksum;snapshot.header.checksum=createHash('sha256').update(JSON.stringify(header)).update(JSON.stringify(snapshot.payload)).digest('hex');return snapshot;
   }};
   const api=createOfflineAwareGalleryApi(online,f.store,{clientId:'entry-rating-phone',randomUUID});await api.getSyncCapabilities({replay:false});await api.replayOfflineOperations!();expect(await f.store.list(),variant).toHaveLength(1);expect(operationFingerprint((await f.store.list())[0]!)).toBe(operationFingerprint(original));
  }finally{f.close();}
 }
 for(const variant of ['foreignJournal','higherOwner','wrongType','epoch']){
  const f=await fixture();try{
   f.loseResponse();await f.api.deleteEntryRatingSlot(f.work.id,f.slot.id);const original=(await f.store.list())[0]!;
   const online={...f.online,getEntryRatingLayoutContext:async(entryId:number,opId?:string)=>{
    const context=await f.online.getEntryRatingLayoutContext!(entryId,opId);
    if(opId && variant==='foreignJournal')context.predecessor!.opId=randomUUID();if(variant==='higherOwner')context.syncVersion+=1;if(variant==='wrongType')context.entryType='Film';if(variant==='epoch')context.syncEpoch='foreign';return context;
   }};
   const api=createOfflineAwareGalleryApi(online,f.store,{clientId:'entry-rating-phone',randomUUID});await api.getSyncCapabilities({replay:false});await expect(api.deleteEntryRatingSlot(f.peer.id,f.keep.id),variant).rejects.toThrow();expect(await f.store.list()).toHaveLength(1);expect(operationFingerprint((await f.store.list())[0]!)).toBe(operationFingerprint(original));
  }finally{f.close();}
 }
});
