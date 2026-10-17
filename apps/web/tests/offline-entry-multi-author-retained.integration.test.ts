import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';

import { expect, it, vi } from 'vitest';
vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const window = new JSDOM('<!doctype html><html><body></body></html>', {url:'http://isolated/'}).window;
  for (const key of ['window','document','Element','HTMLElement','SVGElement','Node','localStorage','sessionStorage','MutationObserver','navigator','getComputedStyle'])
    Object.defineProperty(globalThis,key,{value:key === 'window' ? window : window[key as keyof typeof window],configurable:true});
  Object.defineProperty(globalThis,'addEventListener',{value:window.addEventListener.bind(window),configurable:true});
  Object.defineProperty(globalThis,'removeEventListener',{value:window.removeEventListener.bind(window),configurable:true});
});
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
const serverModule = async(path:string) => {const target=`../../server/src/${path}.js`;return import(/* @vite-ignore */ target);};

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

it('connected original settles only with trusted copy, persisted own proof and durable ACK after cold retries',async()=>{
 const f=await fixture();try{
  await f.offline();f.reconnect();await f.api.getSyncCapabilities({replay:false});f.loseResponse();
  await expect(f.api.convertEntryAuthors(f.work.id)).rejects.toThrow();const original=(await f.store.list())[0]!;const body=f.bodies[0];
  const cold=f.cold();await cold.getSyncCapabilities({replay:false});f.loseAcknowledgement();await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toHaveLength(1);expect(await f.store.readMeta('conversionProof.'+original.opId)).not.toBeNull();
  const retry=f.cold();await retry.getSyncCapabilities({replay:false});await retry.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);expect(f.bodies.every(row=>row===body)).toBe(true);
 }finally{f.close();}
});
it('saved-copy independent Entry and Film layout preserve exact mixed originals through atomic export restore and settlement',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.updateEntry(f.other.id,{title:'Mixed independent'});await f.api.deleteEntryRatingSlot(f.other.id,f.foreign.id);
  await f.api.convertEntryAuthors(f.work.id);const originals=await f.store.list();expect(originals).toHaveLength(3);
  const {buildPendingWorkExport}=await import('../src/offline/pending-work-export.js');const text=JSON.stringify(await buildPendingWorkExport(f.store));
  for(const row of originals)await f.store.remove(row.opId);const cold=f.cold();await cold.preferOfflineSnapshot!();
  await cold.previewPendingWorkRestore!(text);await cold.restorePendingWork!(text);expect(await f.store.list()).toEqual(originals);
  const forged=JSON.parse(text);forged.operations.find((row:{operationKind:string})=>row.operationKind==='entry.authors.convert-to-multi').baseValues.authors[0].producerUid=randomUUID();
  await expect(cold.restorePendingWork!(JSON.stringify(forged))).rejects.toThrow();expect(await f.store.list()).toEqual(originals);
  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.other.id)).toBe('Mixed independent');
 }finally{f.close();}
});

it.each(['existing','credited'] as const)('ordinary saved-copy %s earliest NOCASE target reuses identity and prunes only contributors',async(mode)=>{
 const f=await fixture();try{
  const {createProducer,linkEntryProducer}=await serverModule('repositories/producer-repository');
  const target=createProducer(f.db,{name:'MULTIPLE AUTHOR'});createProducer(f.db,{name:'multiple author'});if(mode==='credited')linkEntryProducer(f.db,f.work.id,target.id);
  await f.offline();const dto=await f.api.convertEntryAuthors(f.work.id);expect(dto.multiAuthorId).toBe(target.id);expect(dto.convertedAuthors).toHaveLength(2);
  const cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.getEntry(f.work.id)).producers.map(row=>row.id)).toEqual([target.id]);
  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT producer_id FROM entry_producers WHERE entry_id=?').pluck().all(f.work.id)).toEqual([target.id]);
 }finally{f.close();}
});
it('cold ANY/visible/hideable author filters options counts cards and directory facts equal actual SQL projection',async()=>{
 const f=await fixture();try{
  f.db.prepare('UPDATE entries SET type=? WHERE id=?').run('Film',f.peer.id);f.db.prepare('INSERT OR REPLACE INTO gallery_settings (entry_type,nsfw) VALUES (?,?)').run('Film',1);
  const {createProducer}=await serverModule('repositories/producer-repository');const target=createProducer(f.db,{name:'multiple author'});
  await f.offline();await f.api.convertEntryAuthors(f.work.id);const cold=f.cold();await cold.preferOfflineSnapshot!();
  await f.online.convertEntryAuthors(f.work.id).catch(()=>undefined); // Offline transport is deliberately down until explicit reconnect.
  f.reconnect();await f.online.convertEntryAuthors(f.work.id);
  const {entryPageQueryRequestSchema}=await import('@t3/shared');
  for(const includeNsfw of [false,true])for(const entryType of [undefined,'Comic','Film'])for(const authorIds of [[],[f.author.id],[target.id]]){
   const query=entryPageQueryRequestSchema.parse({includeNsfw,entryType,authorIds,pageSize:30,sort:'title-asc'});
   const canonical=await f.online.queryEntryPage(query);
   // Online text covers are an opt-in extension, outside the saved snapshot contract.
   for(const row of canonical.items)delete row.coverText;
   expect(await cold.queryEntryPage(query)).toEqual(canonical);
  }
  expect(await cold.listFacetFilterOptions('Comic')).toEqual(await f.online.listFacetFilterOptions('Comic'));
  const facts=(row:Awaited<ReturnType<typeof cold.getAuthor>>)=>({id:row.id,name:row.name,galleryType:row.galleryType,looseEntryCount:row.looseEntryCount,ratings:row.ratings,tags:row.tags,usage:row.usage,directories:row.directories.map(({id,title,entryCount,entries})=>({id,title,entryCount,entries}))});
  expect(facts(await cold.getAuthor(f.author.id))).toEqual(facts(await f.online.getAuthor(f.author.id)));
  for(const includeNsfw of [false,true])expect(await cold.getNavigationCounts!(includeNsfw)).toEqual(await f.online.getNavigationCounts!(includeNsfw));
 }finally{f.close();}
});
it.each(['missingEntry','missingTarget','unrelatedHigher','prunedPresent','cascadePresent','foreignEpoch'] as const)('transport-valid checksum/count malicious %s cannot authorize cleanup or ACK',async(cell)=>{
 const f=await fixture();try{
  await f.offline();await f.api.convertEntryAuthors(f.work.id);const original=(await f.store.list())[0]!;const before=JSON.parse((await f.store.readGeneration(1))!);
  f.reconnect();let transportValid=false;
  const online={...f.online,fetchSnapshotDelta:async(request:Parameters<NonNullable<typeof f.online.fetchSnapshotDelta>>[0])=>{
   const page=await f.online.fetchSnapshotDelta!(request);const snapshot=await f.online.fetchSyncSnapshot();
   if(cell==='missingEntry')snapshot.payload.entries=snapshot.payload.entries.filter(row=>row.id!==f.work.id);
   if(cell==='missingTarget')snapshot.payload.producers=snapshot.payload.producers.filter(row=>row.syncUid!==original.payload.targetUid);
   if(cell==='unrelatedHigher')snapshot.payload.entries.find(row=>row.id===f.work.id)!.syncVersion!+=1;
   if(cell==='prunedPresent')snapshot.payload.producers.push(before.payload.producers.find((row:{id:number})=>row.id===f.contributor.id));
   if(cell==='cascadePresent')snapshot.payload.authorDirectorySets!.push(before.payload.authorDirectorySets.find((row:{producerId:number})=>row.producerId===f.contributor.id));
   if(cell==='foreignEpoch')snapshot.header.syncEpoch=randomUUID();
   snapshot.header.counts.entries=snapshot.payload.entries.length;snapshot.header.counts.producers=snapshot.payload.producers.length;
   const {checksum,...header}=snapshot.header;void checksum;snapshot.header.checksum=createHash('sha256').update(JSON.stringify(header)+JSON.stringify(snapshot.payload)).digest('hex');
   const {verifyChecksum}=await import('../src/offline/snapshot-store.js');expect(await verifyChecksum(snapshot,snapshot.header.checksum)).toBe(true);transportValid=true;
   const text=JSON.stringify(snapshot);return {...page,prefix:0,remove:JSON.stringify(before).length,offset:0,chunk:text,insertLength:text.length,done:true,target:snapshot.header};
  }};
  const api=createOfflineAwareGalleryApi(online,f.store,{clientId:'entry-multi-author-phone',randomUUID,state:f.replayState});await api.getSyncCapabilities({replay:false});f.calls.length=0;
  await api.flushOfflineOutbox!();expect(transportValid).toBe(true);expect((await f.store.list())[0]!.opId).toBe(original.opId);
  expect(f.calls.some(call=>call==='POST /api/sync/ack')).toBe(false);expect(await f.store.readMeta('activeGeneration')).toBe('1');
  expect(f.replayState.lastReplayError).toMatch(cell==='foreignEpoch'?/delta/i:/Conversion snapshot/);
 }finally{f.close();}
});
it('ACK-loss mixed originals export and atomic restore use exact snapshot seal before cold raw retry',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.updateEntry(f.other.id,{title:'ACK mixed'});await f.api.convertEntryAuthors(f.work.id);
  const originals=await f.store.list();f.reconnect();await f.api.getSyncCapabilities({replay:false});f.loseAcknowledgement();await f.api.flushOfflineOutbox!();
  expect(await f.store.list()).toHaveLength(2);const {buildPendingWorkExport}=await import('../src/offline/pending-work-export.js');const text=JSON.stringify(await buildPendingWorkExport(f.store));
  for(const row of originals)await f.store.remove(row.opId);const cold=f.cold();await cold.previewPendingWorkRestore!(text);await cold.restorePendingWork!(text);
  const restored=await f.store.list();expect(restored.map(row=>row.opId)).toEqual(originals.map(row=>row.opId));
  const foreign=JSON.parse(text);foreign.operations.find((row:{operationKind:string})=>row.operationKind==='entry.authors.convert-to-multi').opId=randomUUID();
  await expect(cold.restorePendingWork!(JSON.stringify(foreign))).rejects.toThrow();expect(await f.store.list()).toEqual(restored);
  await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.bodies.filter(row=>JSON.parse(row).operationKind==='entry.authors.convert-to-multi').every(row=>row===f.bodies.find(body=>JSON.parse(body).operationKind==='entry.authors.convert-to-multi'))).toBe(true);
 }finally{f.close();}
});
it('noCopy explicit flush never installs or ACKs; only genuinely installed copy enables settlement',async()=>{
 const f=await fixture();try{
  await f.api.getSyncCapabilities({replay:false});await f.api.convertEntryAuthors(f.work.id);const original=(await f.store.list())[0]!;f.calls.length=0;
  await f.api.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);expect(f.calls.some(call=>/snapshot|delta|ack|assets|changes/.test(call))).toBe(false);
  const {downloadOfflineSnapshot}=await import('../src/offline/offline-sync.js');
  const result=await downloadOfflineSnapshot({api:f.online,store:f.store,capabilities:await f.online.getSyncCapabilities(),media:'none'});expect(result.ok).toBe(true);
  const cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);expect(await f.store.readMeta('conversionProof.'+original.opId)).not.toBeNull();
 }finally{f.close();}
});

it.each(['libraryId','syncEpoch'] as const)('foreign active copy %s cannot dispatch connected original or fetch a replacement',async(key)=>{
 const f=await fixture();try{
  await f.offline();f.reconnect();await f.api.getSyncCapabilities({replay:false});await f.api.convertEntryAuthors(f.work.id);const original=(await f.store.list())[0]!;
  const snapshot=JSON.parse((await f.store.readGeneration(1))!);snapshot.header[key]=randomUUID();const {checksum,...header}=snapshot.header;void checksum;snapshot.header.checksum=createHash('sha256').update(JSON.stringify(header)+JSON.stringify(snapshot.payload)).digest('hex');
  await f.store.writeGeneration(1,JSON.stringify(snapshot));const cold=f.cold();await cold.getSyncCapabilities({replay:false});f.calls.length=0;
  await cold.flushOfflineOutbox!();expect(f.calls.some(call=>/replay|snapshot|delta|ack|changes/.test(call))).toBe(false);expect((await f.store.list())[0]!.opId).toBe(original.opId);
 }finally{f.close();}
});

it('checksum-invalid active copy is not connected reconciliation authority',async()=>{
 const f=await fixture();try{
  await f.offline();f.reconnect();await f.api.getSyncCapabilities({replay:false});await f.api.convertEntryAuthors(f.work.id);
  const snapshot=JSON.parse((await f.store.readGeneration(1))!);snapshot.payload.entries[0].title='Tampered copy';await f.store.writeGeneration(1,JSON.stringify(snapshot));
  const cold=f.cold();await cold.getSyncCapabilities({replay:false});f.calls.length=0;await cold.flushOfflineOutbox!();
  expect(f.calls.some(call=>/replay|snapshot|delta|ack|changes/.test(call))).toBe(false);expect(await f.store.list()).toHaveLength(1);
 }finally{f.close();}
});
