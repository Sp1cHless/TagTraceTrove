import { randomUUID } from 'node:crypto';
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
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { setLocale } from '../src/i18n.js';
const serverModule = async(path:string) => {const target=`../../server/src/${path}.js`;return import(/* @vite-ignore */ target);};
const settle=async()=>{for(let i=0;i<15;i++){await flushPromises();await new Promise(resolve=>setTimeout(resolve,5));}};
async function fixture(){
  const {createMigratedMemoryDatabase}=await serverModule('database/testing');
  const {createEntry}=await serverModule('repositories/entry-repository');
  const {createProducer,linkEntryProducer}=await serverModule('repositories/producer-repository');
  const {createEntryRatingSlot,createProducerRatingSlot,setEntryRating,setProducerRating}=await serverModule('repositories/rating-repository');
  const {createAuthorDirectory}=await serverModule('repositories/author-directory-repository');
  const {createCollection}=await serverModule('repositories/collection-repository');
  const {assignProducerTag}=await serverModule('repositories/producer-tag-repository');
  const {addViewLaterProducer}=await serverModule('repositories/view-later-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-entry-multi-author-'));
  try {
  const work=createEntry(db,{title:'Rated work',type:'Comic'}),peer=createEntry(db,{title:'Rated peer',type:'Comic'}),other=createEntry(db,{title:'Other type',type:'Film'});
  const author=createProducer(db,{name:'Preserved Author'}),contributor=createProducer(db,{name:'Single-work Contributor'});linkEntryProducer(db,work.id,author.id);linkEntryProducer(db,work.id,contributor.id);linkEntryProducer(db,peer.id,author.id);
  const slot=createEntryRatingSlot(db,{entryId:work.id,name:'Quality'}),keep=createEntryRatingSlot(db,{entryId:work.id,name:'Keep'}),foreign=createEntryRatingSlot(db,{entryId:other.id,name:'Quality'});
  const summary=createProducerRatingSlot(db,{producerId:author.id,name:'Quality'}),self=createProducerRatingSlot(db,{producerId:author.id,name:'Quality',kind:'author_self'});
  for(const entry of [work,peer])setEntryRating(db,{entryId:entry.id,slotId:slot.id,stars:4});
  setEntryRating(db,{entryId:other.id,slotId:foreign.id,stars:3});setProducerRating(db,{producerId:author.id,slotId:summary.id,stars:3.5});setProducerRating(db,{producerId:author.id,slotId:self.id,stars:5});
  createAuthorDirectory(db,{producerId:contributor.id,title:'Pruned directory',entryIds:[work.id]});
  createAuthorDirectory(db,{producerId:author.id,title:'Retained directory',entryIds:[work.id]});
  const collection=createCollection(db,{kind:'producer',title:'Cascade collection'});
  db.prepare('INSERT INTO collection_producers (collection_id,producer_id) VALUES (?,?)').run(collection.id,contributor.id);
  assignProducerTag(db,{producerId:contributor.id,name:'Pruned unique tag'});addViewLaterProducer(db,contributor.id);setProducerRating(db,{producerId:contributor.id,slotId:summary.id,stars:2});
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false,loseReplay=false,loseAck=false;
  const calls:string[]=[],bodies:string[]=[];
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);if(disconnected)throw new TypeError('Known offline');
    if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));const response=await app.request(url.pathname+url.search,init);
    if(loseReplay && url.pathname==='/api/sync/replay' && response.ok){loseReplay=false;throw new TypeError('SQL response lost');}
    if(loseAck && url.pathname.includes('/ack') && response.ok){loseAck=false;throw new TypeError('ACK response lost');}return response;
  }}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();let store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const replayState={mode:'online' as 'online'|'offline',lastFallbackAt:null as string|null,lastReplayError:null as string|null};
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'entry-multi-author-phone',randomUUID});
  return {db,root,work,peer,other,author,contributor,slot,keep,foreign,summary,self,api,online,calls,bodies,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
    async deleteMeta(key:string){const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(databaseName);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}finally{db.close();}},
    reconnect(){disconnected=false;},loseResponse(){loseReplay=true;},loseAcknowledgement(){loseAck=true;},
    get replayState(){return replayState;},cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'entry-multi-author-phone',randomUUID,state:replayState});},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}
it('ordinary saved-copy conversion seals one durable atomic original before any business HTTP',async()=>{
 const f=await fixture();let wrapper:ReturnType<typeof mount>|undefined;
 try{
  setLocale('en');vi.stubGlobal('scrollTo',vi.fn());await f.offline();
  wrapper=mount(GalleryApp,{props:{api:f.api,offlineStore:f.store}});
  await settle();await wrapper.get('[data-gallery-type="Comic"]').trigger('click');await settle();
  const card=wrapper.findAll('button').find(row=>row.text().includes('Rated work'));expect(card).toBeDefined();await card!.trigger('click');await settle();
  await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');await settle();
  await wrapper.get('[data-testid="convert-multi-author"]').trigger('click');await settle();
  expect(await f.store.list()).toHaveLength(1);
  expect(f.calls.filter(call=>!call.startsWith('GET '))).toEqual([]);
  wrapper.unmount();wrapper=undefined;
  const original=(await f.store.list())[0]!;
  expect(original.operationKind).toBe('entry.authors.convert-to-multi');
  expect(await f.store.readMeta('capability.offlineEntryMultiAuthorConversion')).toBe('1');
  const cold=f.cold();await cold.preferOfflineSnapshot!();
  expect((await cold.getEntry(f.work.id)).producers.map(row=>row.name)).toEqual(['multiple author']);
  expect((await cold.listAuthors()).some(row=>row.id===f.contributor.id)).toBe(false);
  expect((await cold.getAuthor(f.author.id)).looseEntryCount).toBe(1);
  expect((await cold.getAuthor(f.author.id)).directories[0]?.entryCount).toBe(0);
  expect((await cold.getViewLaterState()).producerIds).not.toContain(f.contributor.id);
  const {buildPendingWorkExport}=await import('../src/offline/pending-work-export.js');
  const exported=JSON.stringify(await buildPendingWorkExport(f.store));
  await f.store.remove(original.opId);
  await cold.previewPendingWorkRestore!(exported);await cold.restorePendingWork!(exported);
  expect((await f.store.list())[0]).toEqual(original);
  const altered=JSON.parse(exported);altered.operations[0].payload.targetUid=randomUUID();
  await expect(cold.previewPendingWorkRestore!(JSON.stringify(altered))).rejects.toThrow();
  expect((await f.store.list())[0]).toEqual(original);
  const foreign=JSON.parse(exported);foreign.operations[0].opId=randomUUID();foreign.operations[0].baseValues.authors[0].producerUid=randomUUID();
  await expect(cold.previewPendingWorkRestore!(JSON.stringify(foreign))).rejects.toThrow();
  expect((await f.store.list())[0]).toEqual(original);
  await expect(cold.updateAuthor(f.author.id,{name:'Unsupported successor'})).rejects.toThrow();
  expect(await f.store.list()).toHaveLength(1);
  f.reconnect();f.loseResponse();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();
  expect(await f.store.list()).toHaveLength(1);
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.contributor.id)).toBe(0);
  const firstBody=f.bodies[0];expect(firstBody).toBeDefined();
  const retry=f.cold();f.loseAcknowledgement();await retry.getSyncCapabilities({replay:false});await retry.replayOfflineOperations!();
  expect(await f.store.list()).toHaveLength(1);
  expect(await f.store.readMeta('conversionProof.'+original.opId)).not.toBeNull();
  const final=f.cold();await final.getSyncCapabilities({replay:false});await final.replayOfflineOperations!();
  expect(await f.store.list()).toEqual([]);
  expect(f.bodies.every(body=>body===firstBody)).toBe(true);
  expect(f.db.prepare('SELECT count(*) FROM sync_operation_receipts WHERE op_id=?').pluck().get(original.opId)).toBe(1);
  expect((await final.getEntry(f.work.id)).producers.map(row=>row.name)).toEqual(['multiple author']);
 }finally{wrapper?.unmount();f.close();vi.unstubAllGlobals();}
});
it.each(['false','absent'] as const)('offline conversion capability %s fails locally without business HTTP or a new queue',async(value)=>{
 const f=await fixture();try{
  await f.offline();
  if(value==='false')await f.store.writeMeta('capability.offlineEntryMultiAuthorConversion','0');else await f.deleteMeta('capability.offlineEntryMultiAuthorConversion');
  const cold=f.cold();await cold.preferOfflineSnapshot!();
  await expect(cold.convertEntryAuthors(f.work.id)).rejects.toThrow('not available under offline');
  expect(await f.store.list()).toEqual([]);expect(f.calls.filter(call=>!call.startsWith('GET '))).toEqual([]);
 }finally{f.close();}
});
it('canonical Online conversion prunes only unlinked workless contributors and retains other-work Authors',async()=>{
 const f=await fixture();try{
  const result=await f.online.convertEntryAuthors(f.work.id);expect(result.convertedAuthors).toHaveLength(2);
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.contributor.id)).toBe(0);
  expect(f.db.prepare('SELECT entry_id FROM entry_producers WHERE producer_id=?').pluck().all(f.author.id)).toEqual([f.peer.id]);
 }finally{f.close();}
});

it.each(['noCopy','oldCopy','connectedSavedCopy'] as const)('connected %s seals original before real SQL response loss and cold exact retry without snapshot/media/ACK',async(mode)=>{
 const f=await fixture();try{
  if(mode!=='noCopy'){await f.offline();f.reconnect();}
  if(mode==='oldCopy'){f.db.prepare('UPDATE producers SET name=? WHERE id=?').run('Current Author',f.author.id);f.db.prepare('UPDATE entries SET title=? WHERE id=?').run('Current work',f.work.id);}
  await f.api.getSyncCapabilities({replay:false});f.calls.length=0;f.loseResponse();
  await expect(f.api.convertEntryAuthors(f.work.id)).rejects.toThrow();
  const rows=await f.store.list();expect(rows).toHaveLength(1);const original=rows[0]!;
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.contributor.id)).toBe(0);
  const generation=await f.store.readMeta('activeGeneration');const firstBody=f.bodies[0];expect(firstBody).toBeDefined();
  const cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();
  expect(f.bodies).toHaveLength(2);expect(f.bodies[1]).toBe(firstBody);
  const retained=(await f.store.list())[0]!;expect(retained.opId).toBe(original.opId);expect(retained.baseValues).toEqual(original.baseValues);expect(retained.payload).toEqual(original.payload);
  expect(await f.store.readMeta('activeGeneration')).toBe(generation);
  expect(f.calls.some(call=>/snapshot|delta|assets|ack|changes/.test(call))).toBe(false);
  expect(f.db.prepare('SELECT count(*) FROM sync_operation_receipts WHERE op_id=?').pluck().get(original.opId)).toBe(1);
 }finally{f.close();}
});

it('connected independent Entry pending advances while conversion retains its original; held affected Author blocks only conversion',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.updateEntry(f.other.id,{title:'Independent Film'});await f.api.deleteEntryRatingSlot(f.other.id,f.foreign.id);f.reconnect();await f.api.getSyncCapabilities({replay:false});f.calls.length=0;
  const dto=await f.api.convertEntryAuthors(f.work.id);expect(dto.entryId).toBe(f.work.id);
  await f.api.replayOfflineOperations!();
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.other.id)).toBe('Independent Film');expect(f.db.prepare('SELECT count(*) FROM rating_slots WHERE id=?').pluck().get(f.foreign.id)).toBe(0);
  expect((await f.store.list()).filter(row=>row.operationKind==='entry.authors.convert-to-multi')).toHaveLength(1);
 }finally{f.close();}
 const held=await fixture();try{
  await held.offline();await held.api.updateAuthor(held.contributor.id,{name:'Held Author'});const row=(await held.store.list())[0]!;await held.store.update(row.opId,{status:'conflict'});
  await held.api.updateEntry(held.other.id,{title:'Untouched progress'});held.reconnect();await held.api.getSyncCapabilities({replay:false});held.calls.length=0;
  await expect(held.api.convertEntryAuthors(held.work.id)).rejects.toThrow();expect((await held.store.list()).some(row=>row.operationKind==='entry.authors.convert-to-multi')).toBe(false);
  await held.api.replayOfflineOperations!();expect(held.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(held.other.id)).toBe('Untouched progress');expect((await held.store.list()).some(row=>row.opId===row.opId && row.status==='conflict')).toBe(true);
 }finally{held.close();}
});
it.each(['foreignLibrary','foreignEpoch','foreignAuthor','overLimit'] as const)('connected bounded context rejects %s before enqueue or SQL mutation',async(cell)=>{
 const f=await fixture();try{
  await f.offline();f.reconnect();const real=f.online.getEntryConversionContext!.bind(f.online);
  const online={...f.online,getEntryConversionContext:async(id:number)=>{const c=structuredClone(await real(id));
   if(cell==='foreignLibrary')c.libraryId=randomUUID();if(cell==='foreignEpoch')c.syncEpoch=randomUUID();if(cell==='foreignAuthor')c.authors[0]!.producerUid=randomUUID();if(cell==='overLimit')c.authors[0]!.workUids=Array.from({length:2001},()=>randomUUID());return c;}};
  const api=createOfflineAwareGalleryApi(online,f.store,{clientId:'entry-multi-author-phone',randomUUID});f.calls.length=0;
  await expect(api.convertEntryAuthors(f.work.id)).rejects.toThrow();expect(await f.store.list()).toEqual([]);expect(f.calls.some(call=>call.startsWith('POST '))).toBe(false);
 }finally{f.close();}
});
it('connected capability downgrade holds attempted exact original; old-server legacy only with no original',async()=>{
 const f=await fixture();try{
  await f.api.getSyncCapabilities({replay:false});f.loseResponse();await expect(f.api.convertEntryAuthors(f.work.id)).rejects.toThrow();const original=(await f.store.list())[0]!;
  const online={...f.online,getSyncCapabilities:async()=>{const c=await f.online.getSyncCapabilities();return {...c,featureFlags:{...c.featureFlags,offlineMutations:false,offlineEntryMultiAuthorConversion:false}};}};
  const api=createOfflineAwareGalleryApi(online,f.store,{clientId:'entry-multi-author-phone',randomUUID});f.calls.length=0;
  await api.getSyncCapabilities({replay:false});await api.replayOfflineOperations!();await expect(api.convertEntryAuthors(f.work.id)).rejects.toThrow();
  expect(f.calls.some(call=>call.startsWith('POST '))).toBe(false);expect((await f.store.list())[0]!.baseValues).toEqual(original.baseValues);expect((await f.store.list())[0]!.opId).toBe(original.opId);
 }finally{f.close();}
 const legacy=await fixture();try{
  const online={...legacy.online,getSyncCapabilities:async()=>{const c=await legacy.online.getSyncCapabilities();const flags={...c.featureFlags};delete flags.offlineEntryMultiAuthorConversion;return {...c,featureFlags:flags};}};
  const api=createOfflineAwareGalleryApi(online,legacy.store,{clientId:'entry-multi-author-phone',randomUUID});const dto=await api.convertEntryAuthors(legacy.work.id);expect(dto.entryId).toBe(legacy.work.id);expect(await legacy.store.list()).toEqual([]);expect(legacy.calls).toContain(`POST /api/entries/${legacy.work.id}/multi-author`);
 }finally{legacy.close();}
});

it.each(['libraryId','syncEpoch'] as const)('connected noCopy context must match fresh capability %s before new queue',async(key)=>{
 const f=await fixture();try{
  const online={...f.online,getEntryConversionContext:async(id:number)=>({...await f.online.getEntryConversionContext!(id),[key]:randomUUID()})};
  const api=createOfflineAwareGalleryApi(online,f.store,{clientId:'entry-multi-author-phone',randomUUID});
  await expect(api.convertEntryAuthors(f.work.id)).rejects.toThrow();expect(await f.store.list()).toEqual([]);expect(f.calls.some(call=>call.startsWith('POST '))).toBe(false);
 }finally{f.close();}
});
it('connected explicit general capability off without originals cannot fall back to legacy POST',async()=>{
 const f=await fixture();try{
  const online={...f.online,getSyncCapabilities:async()=>{const c=await f.online.getSyncCapabilities();return {...c,featureFlags:{...c.featureFlags,offlineMutations:false}};}};
  const api=createOfflineAwareGalleryApi(online,f.store,{clientId:'entry-multi-author-phone',randomUUID});await expect(api.convertEntryAuthors(f.work.id)).rejects.toThrow();expect(await f.store.list()).toEqual([]);expect(f.calls.some(call=>call.startsWith('POST '))).toBe(false);
 }finally{f.close();}
});
it('connected ordinary mounted noCopy button returns real canonical DTO without installing a copy',async()=>{
 const f=await fixture();let wrapper:ReturnType<typeof mount>|undefined;try{
  setLocale('en');vi.stubGlobal('scrollTo',vi.fn());wrapper=mount(GalleryApp,{props:{api:f.api,offlineStore:f.store}});await settle();
  await wrapper.get('[data-gallery-type="Comic"]').trigger('click');await settle();const card=wrapper.findAll('button').find(row=>row.text().includes('Rated work'));expect(card).toBeDefined();await card!.trigger('click');await settle();await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');await settle();
  f.calls.length=0;await wrapper.get('[data-testid="convert-multi-author"]').trigger('click');await settle();
  expect(await f.store.list()).toHaveLength(1);expect(f.bodies).toHaveLength(1);expect(await f.store.readMeta('activeGeneration')).toBeNull();expect(f.calls.some(call=>/snapshot|delta|assets|ack/.test(call))).toBe(false);expect(wrapper.text()).toContain('multiple author');
  const original=(await f.store.list())[0]!;expect(await f.store.readMeta('connectedConversionReceipt.'+original.opId)).not.toBeNull();
  await f.api.convertEntryAuthors(f.work.id);expect(await f.store.list()).toHaveLength(1);expect(f.bodies[1]).toBe(f.bodies[0]);
 }finally{wrapper?.unmount();f.close();vi.unstubAllGlobals();}
});
it('connected real SQL bounded workset limit rejects complete oversized context rather than silently dropping works',async()=>{
 const f=await fixture();try{
  const {createEntry}=await serverModule('repositories/entry-repository');const {linkEntryProducer}=await serverModule('repositories/producer-repository');
  f.db.transaction(()=>{for(let i=0;i<2000;i++){const work=createEntry(f.db,{title:'Limit '+i,type:'Comic'});linkEntryProducer(f.db,work.id,f.contributor.id);}})();
  await expect(f.api.convertEntryAuthors(f.work.id)).rejects.toThrow();expect(await f.store.list()).toEqual([]);expect(f.calls.some(call=>call.startsWith('POST '))).toBe(false);expect(f.db.prepare('SELECT count(*) FROM entry_producers WHERE producer_id=?').pluck().get(f.contributor.id)).toBe(2001);
 }finally{f.close();}
});
it.each(['authorVersion','targetRace'] as const)('connected real SQL %s rejects stale scoped authority and retains original',async(cell)=>{
 const f=await fixture();try{
  const before=f.db.prepare('SELECT count(*) FROM entry_producers WHERE entry_id=?').pluck().get(f.work.id);
  const online={...f.online,getEntryConversionContext:async(id:number)=>{const c=await f.online.getEntryConversionContext!(id);if(cell==='authorVersion')f.db.prepare('UPDATE producers SET name=? WHERE id=?').run('Concurrent Author',f.author.id);else{const {createProducer}=await serverModule('repositories/producer-repository');createProducer(f.db,{name:'MULTIPLE AUTHOR'});}return c;}};
  const api=createOfflineAwareGalleryApi(online,f.store,{clientId:'entry-multi-author-phone',randomUUID});await expect(api.convertEntryAuthors(f.work.id)).rejects.toThrow();expect(await f.store.list()).toHaveLength(1);expect((await f.store.list())[0]!.status).toBe('conflict');expect(f.db.prepare('SELECT count(*) FROM entry_producers WHERE entry_id=?').pluck().get(f.work.id)).toBe(before);
 }finally{f.close();}
});

it.each(['author_directory_set','collection'] as const)('connected held %s cascade owner blocks conversion, not independent Entry SQL',async(entityKind)=>{
 const f=await fixture();try{
  await f.offline();f.reconnect();const c=await f.online.getEntryConversionContext!(f.work.id);const owner=c.cascadeOwners.find(row=>row.entityKind===entityKind)!;expect(owner).toBeDefined();
  const {createPendingSyncOperation}=await import('../src/offline/outbox-store.js');const {syncReplayRequestSchema}=await import('@t3/shared');
  const snapshot=await f.online.fetchSyncSnapshot();const set=snapshot.payload.authorDirectorySets?.find(row=>row.syncUid===owner.entityUid);const directories=snapshot.payload.authorDirectories.filter(row=>row.producerId===set?.producerId).map(row=>({syncUid:row.syncUid!,title:row.title,description:row.description,sortOrder:row.sortOrder,entries:snapshot.payload.authorDirectoryEntries.filter(entry=>entry.directoryId===row.id).map(entry=>({syncUid:snapshot.payload.entries.find(work=>work.id===entry.entryId)!.syncUid!,sortOrder:entry.sortOrder}))}));
  const row=createPendingSyncOperation({clientId:'entry-multi-author-phone',libraryId:c.libraryId,syncEpoch:c.syncEpoch,entityKind,entityUid:owner.entityUid,baseVersion:owner.version,operationKind:entityKind==='collection'?'collection.update':'author.directories.set',baseValues:entityKind==='collection'?{title:'Cascade collection'}:{directories},payload:entityKind==='collection'?{title:'Held collection'}:{directories:directories.map(row=>({...row,title:row.title+' held'}))}},{randomUUID});
  expect(syncReplayRequestSchema.safeParse({opId:row.opId,clientId:row.clientId,libraryId:row.libraryId,syncEpoch:row.syncEpoch,entityKind:row.entityKind,entityUid:row.entityUid,clientCreatedAt:row.clientCreatedAt,operationKind:row.operationKind,baseVersion:row.baseVersion,baseValues:row.baseValues,payload:row.payload}).success).toBe(true);
  await f.store.enqueue({...row,status:'conflict'});await f.api.preferOfflineSnapshot!();await f.api.updateEntry(f.other.id,{title:'Independent cascade progress'});await f.api.getSyncCapabilities({replay:false});f.calls.length=0;
  await expect(f.api.convertEntryAuthors(f.work.id)).rejects.toThrow('touched owner');expect(f.calls.some(call=>call.startsWith('POST '))).toBe(false);
  await f.api.replayOfflineOperations!();expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.other.id)).toBe('Independent cascade progress');expect((await f.store.list()).some(item=>item.opId===row.opId)).toBe(true);
 }finally{f.close();}
});
it('connected retained conversion permits new independent Entry enqueue while affected Producer remains held',async()=>{
 const f=await fixture();try{
  await f.offline();f.reconnect();await f.api.getSyncCapabilities({replay:false});await f.api.convertEntryAuthors(f.work.id);const original=(await f.store.list())[0]!;
  await f.api.preferOfflineSnapshot!();await f.api.updateEntry(f.other.id,{title:'Post-conversion independent'});await expect(f.api.updateAuthor(f.author.id,{name:'Blocked successor'})).rejects.toThrow();
  await f.api.getSyncCapabilities({replay:false});await f.api.replayOfflineOperations!();expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.other.id)).toBe('Post-conversion independent');expect((await f.store.list()).some(row=>row.opId===original.opId)).toBe(true);
 }finally{f.close();}
});

it('conversion explicit replay after trusted copy removal retains original without downloading or ACKing a new library',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.convertEntryAuthors(f.work.id);const original=(await f.store.list())[0]!;await f.deleteMeta('activeGeneration');f.reconnect();const cold=f.cold();await cold.getSyncCapabilities({replay:false});f.calls.length=0;
  await cold.replayOfflineOperations!();expect((await f.store.list()).some(row=>row.opId===original.opId)).toBe(true);expect(await f.store.readMeta('activeGeneration')).toBeNull();expect(f.calls.some(call=>/snapshot|delta|ack|assets/.test(call))).toBe(false);
 }finally{f.close();}
});
