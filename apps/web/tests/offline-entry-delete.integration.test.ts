import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import GalleryApp from '../src/GalleryApp.vue';
import { setLocale } from '../src/i18n.js';
vi.hoisted(async () => {
 const {JSDOM}=await import('jsdom');const window=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://isolated/'}).window;
 for(const key of ['window','document','Element','HTMLElement','SVGElement','Node','localStorage','sessionStorage','MutationObserver','navigator','getComputedStyle'])Object.defineProperty(globalThis,key,{value:key==='window'?window:window[key as keyof typeof window],configurable:true});
});
globalThis.addEventListener=window.addEventListener.bind(window);globalThis.removeEventListener=window.removeEventListener.bind(window);
const settle=async()=>{for(let i=0;i<15;i++){await flushPromises();await new Promise(resolve=>setTimeout(resolve,5));}};
import { entryPageQueryRequestSchema, producerPageQueryRequestSchema } from '@t3/shared';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { originalMutationEnvelope } from '../src/offline/sync-mutation-plan.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
import { preparePendingWork } from '../src/offline/pending-work-restore.js';
import { LOCAL_FINAL_STATE_KEY, readLocalFinalState, emptyLocalFinalState } from '../src/offline/local-final-state.js';
const serverModule = async (path: string) => { const target = `../../server/src/${path}.js`; return import(/* @vite-ignore */ target); };
async function fixture(install = true) {
 const { createMigratedMemoryDatabase } = await serverModule('database/testing');
 const { createEntry } = await serverModule('repositories/entry-repository');
 const { createProducer, linkEntryProducer } = await serverModule('repositories/producer-repository');
 const { createApiApp } = await serverModule('http/app');
 const db=createMigratedMemoryDatabase(), root=mkdtempSync(join(tmpdir(),'t3-entry-delete-'));
 const entry=createEntry(db,{title:'Delete this',type:'comic'}), survivor=createEntry(db,{title:'Keep this',type:'comic'});
 const author=createProducer(db,{name:'Retained workless Author'});linkEntryProducer(db,entry.id,author.id);
 const {createSection}=await serverModule('repositories/layout-repository');createSection(db,{entryType:'comic',name:'Tags'});
 const app=createApiApp(db,{assetRoot:root});const indexedDB=new IDBFactory(),name=randomUUID();
 let store=createIndexedDbOfflineStore({indexedDB,databaseName:name});let disconnected=false,loseReplay=false,loseAck=false;
 const originalFetch=globalThis.fetch;
 // Node fetch has no document origin; route relative asset proofs through this isolated server.
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(String(input),'http://isolated/');
  if(url.origin!=='http://isolated')return originalFetch(input,init);
  if(disconnected)throw new TypeError('Known offline');
  return app.request(url.pathname+url.search,init);
 });
 const bodies:string[]=[], business:string[]=[];
 const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
  const url=new URL(String(input));business.push(url.pathname);
  if(disconnected)throw new TypeError('Known offline');
  if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));
  const response=await app.request(url.pathname+url.search,init);
  if(url.pathname==='/api/sync/replay' && loseReplay && response.ok){loseReplay=false;throw new TypeError('Replay response lost');}
  if(url.pathname.includes('/ack') && loseAck && response.ok){loseAck=false;throw new TypeError('ACK response lost');}
  return response;
 }}));
 if (install) { await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1'); }
 const api=(state?: import('../src/offline/offline-api.js').OfflineApiState)=>createOfflineAwareGalleryApi(online,store,{clientId:'delete-phone',randomUUID,...(state ? {state} : {})});const current=api();
 await current.getSyncCapabilities({replay:false});if (install) await current.preferOfflineSnapshot!();business.length=0;disconnected=install;
 return {db,root,entry,survivor,author,online,current,bodies,business,get store(){return store;},
  connect(){disconnected=false;},disconnect(){disconnected=true;},loseReplay(){loseReplay=true;},loseAck(){loseAck=true;},
  cold(state?: import('../src/offline/offline-api.js').OfflineApiState){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName:name});return api(state);},
  async seal(){
   if(!disconnected)throw new Error('The fixture seals originals only against its disconnected transport');
   await current.flushOfflineOutbox!();business.length=0;
  },
  close(){store.close();db.close();rmSync(root,{recursive:true,force:true});vi.unstubAllGlobals();}};
}
it('ordinary existing Entry deletion is durable and cold projected; real SQL receipt-loss retry and ACK settle without resurrecting it',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);expect(f.business).toEqual([]);
  expect(await f.store.list()).toEqual([]);expect(readLocalFinalState(await f.store.readMeta(LOCAL_FINAL_STATE_KEY)).deleted).toHaveLength(1);
  await f.seal();
  const original=(await f.store.list())[0]!;expect(original).toMatchObject({operationKind:'entry.delete',entityKind:'entry',status:'pending'});
  expect((await f.current.queryEntryPage(entryPageQueryRequestSchema.parse({entryType:'comic'}))).items.map(row=>row.id)).toEqual([f.survivor.id]);
  expect((await f.current.queryProducerPage(producerPageQueryRequestSchema.parse({}))).total).toBe(0);
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(1);
  const backup=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany([original.opId]);
  await f.store.writeMeta(LOCAL_FINAL_STATE_KEY,JSON.stringify(emptyLocalFinalState()));
  const cold=f.cold();await cold.restorePendingWork!(backup);await cold.preferOfflineSnapshot!();
  expect((await cold.queryEntryPage(entryPageQueryRequestSchema.parse({entryType:'comic'}))).items.map(row=>row.id)).toEqual([f.survivor.id]);
  f.connect();f.loseReplay();await cold.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(0);
  expect(await f.store.list()).toHaveLength(1);
  f.loseAck();const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline',lastFallbackAt:null};const retry=f.cold(state);await retry.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);
  await retry.flushOfflineOutbox!();expect(await f.store.list(), state.lastReplayError ?? undefined).toEqual([]);
  expect(f.bodies.length).toBeGreaterThanOrEqual(3);expect(new Set(f.bodies).size).toBe(1);
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(1);
  expect(f.db.prepare('SELECT count(*) FROM entry_producers WHERE entry_id=?').pluck().get(f.entry.id)).toBe(0);
 }finally{f.close();}
});
it.each([false,true])('connected delete without current snapshot owner (old copy installed=%s) preserves UUID across response loss',async install=>{
 const f=await fixture(install);try{
  f.connect();const {createEntry}=await serverModule('repositories/entry-repository');const fresh=createEntry(f.db,{title:'New online work',type:'comic'});
  if (install) await f.current.getSyncCapabilities({replay:false});
  await f.current.getEntry(fresh.id);f.loseReplay();await f.current.deleteEntry(fresh.id);
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(fresh.id)).toBe(0);
  expect(await f.store.list()).toHaveLength(1);const original=originalMutationEnvelope((await f.store.list())[0]!);
  const cold=f.cold();await cold.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.bodies.map(body=>JSON.parse(body))).toEqual([original,original]);
  expect(f.business.some(path=>path.includes('/sync-identity'))).toBe(true);
 }finally{f.close();}
});
it('committed media reorder and removal then Entry deletion settle with exact original envelopes',async()=>{
 const f=await fixture();try{
  const {mkdirSync,writeFileSync}=await import('node:fs');const dir=join(f.root,'entries',String(f.entry.id));mkdirSync(dir,{recursive:true});
  const refs=['cover','preview','preview-2'].map(name=>`/api/assets/entries/${f.entry.id}/${name}.${randomUUID()}.webp`);
  for(const ref of refs)writeFileSync(join(dir,ref.split('/').at(-1)!),'committed bytes');
  f.db.prepare('UPDATE entries SET cover_ref=?,preview_ref=?,preview_refs=? WHERE id=?').run(refs[0],refs[1],JSON.stringify(refs.slice(1)),f.entry.id);
  f.connect();await f.store.writeGeneration(2,JSON.stringify(await f.online.fetchSyncSnapshot()));await f.store.writeMeta('activeGeneration','2');f.disconnect();
  await f.current.setEntryMediaOrder!(f.entry.id,[refs[0]!,refs[2]!]);
  f.connect();f.loseReplay();await f.current.flushOfflineOutbox!();f.disconnect();
  await f.current.deleteEntry(f.entry.id);
  const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();
  const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline',lastFallbackAt:null};
  await f.cold(state).flushOfflineOutbox!();expect(await f.store.list(),state.lastReplayError??undefined).toEqual([]);
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(0);
  for(const original of originals)for(const body of f.bodies.map(body=>JSON.parse(body)).filter(body=>body.opId===original.opId))expect(body).toEqual(original);
  expect(JSON.parse(f.bodies.at(-1)!)).toMatchObject({operationKind:'entry.delete'});
 }finally{f.close();}
});
it('uncertain pending create Content and metadata settle when a later authoritative existing Entry delete wins',async()=>{
 const f=await fixture();try{
  const {localKey}=await f.current.enqueueOfflineEntryCreate!({title:'Pending deleted',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});
  await f.current.enqueueOfflinePendingEntryContent!(localKey,{contentType:'Note',content:'pending content'});
  await f.current.enqueueOfflinePendingEntryMetadata!(localKey,{title:'Changed pending',uploadDate:null,pageCount:0});
  const before=(await f.store.list()).map(originalMutationEnvelope);
  await expect(f.current.deleteEntry(-1)).rejects.toThrow(/pending/i);expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(before);expect(f.business).toEqual([]);
  f.connect();f.loseReplay();await f.current.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(3);
  const attempted=await f.store.list();await expect(f.current.deleteEntry(-1)).rejects.toThrow(/pending/i);expect(await f.store.list()).toEqual(attempted);
  const id=Number(f.db.prepare("SELECT id FROM entries WHERE title='Pending deleted'").pluck().get());expect(id).toBeGreaterThan(0);
  const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline',lastFallbackAt:null};const cold=f.cold(state);
  await cold.getSyncCapabilities({replay:false});await cold.deleteEntry(id);
  expect(await f.store.list(),state.lastReplayError??undefined).toEqual([]);expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(id)).toBe(0);
  expect(f.bodies.slice(1,4).map(body=>JSON.parse(body))).toEqual(before);
 }finally{f.close();}
});
it('ordinary online numeric deletion retains stored Authors like durable replay while workless eligibility disappears',async()=>{
 const f=await fixture();try{
  f.connect();await f.online.deleteEntry(f.entry.id);
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(1);
  expect(f.db.prepare('SELECT count(*) FROM entry_producers WHERE producer_id=?').pluck().get(f.author.id)).toBe(0);
 }finally{f.close();}
});
it('rating layout values Collection and Directory predecessors retain independent members after Entry deletion',async()=>{
 const f=await fixture();try{
  const {linkEntryProducer}=await serverModule('repositories/producer-repository');linkEntryProducer(f.db,f.survivor.id,f.author.id);
  f.connect();await f.store.writeGeneration(2,JSON.stringify(await f.online.fetchSyncSnapshot()));await f.store.writeMeta('activeGeneration','2');f.disconnect();
  const slot=await f.current.createEntryRatingSlot(f.entry.id,'Quality');await f.current.setEntryRating(f.entry.id,slot.id,4);
  const collection=await f.current.createCollection({kind:'entry',title:'Keep collection',galleryType:'comic'});
  await f.current.addCollectionEntry(collection.id,f.entry.id);await f.current.addCollectionEntry(collection.id,f.survivor.id);
  await f.current.createAuthorDirectory(f.author.id,{title:'Keep directory',entryIds:[f.entry.id,f.survivor.id]});
  await f.current.deleteEntry(f.entry.id);const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();
  const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline',lastFallbackAt:null};await f.cold(state).flushOfflineOutbox!();
  expect(await f.store.list(),state.lastReplayError??undefined).toEqual([]);
  const collections=await f.online.listCollections('entry',true);expect(collections.find(row=>row.title==='Keep collection')?.entries.map(row=>row.id)).toEqual([f.survivor.id]);
  const author=await f.online.getAuthor(f.author.id);expect(author.directories.find(row=>row.title==='Keep directory')?.entries.map(row=>row.id)).toEqual([f.survivor.id]);
  expect((await f.online.listRatingSlots('comic')).some(row=>row.name==='Quality')).toBe(true);
  expect(f.bodies.slice(0,originals.length).map(body=>JSON.parse(body))).toEqual(originals);
  expect(JSON.parse(f.bodies.at(-1)!)).toMatchObject({operationKind:'entry.delete'});
 }finally{f.close();}
});
it.each(['collection','directory'] as const)('%s held membership blocks dependent deletion without blocking independent owners',async(kind)=>{
 const f=await fixture();try{
  const {linkEntryProducer}=await serverModule('repositories/producer-repository');linkEntryProducer(f.db,f.survivor.id,f.author.id);f.connect();
  const container=kind==='collection'?await f.online.createCollection({kind:'entry',title:'Conflict container',galleryType:'comic'}):await f.online.createAuthorDirectory(f.author.id,{title:'Conflict container'});
  await f.store.writeGeneration(2,JSON.stringify(await f.online.fetchSyncSnapshot()));await f.store.writeMeta('activeGeneration','2');f.disconnect();
  const add=(api:import('../src/api/gallery.js').GalleryApi,id:number)=>kind==='collection'?api.addCollectionEntry(container.id,id):api.moveEntryToAuthorDirectory(f.author.id,container.id,id);
  await add(f.current,f.entry.id);await f.current.deleteEntry(f.entry.id);await f.current.updateEntry(f.survivor.id,{title:'Independent changed'});
  const deletion=readLocalFinalState(await f.store.readMeta(LOCAL_FINAL_STATE_KEY)).deleted[0]!;
  expect((await f.store.list()).some(row=>row.operationKind==='entry.delete')).toBe(false);
  const held=(await f.store.list())[0]!;await f.store.update(held.opId,{status:'conflict',lastError:'Reviewed membership remains held'});
  f.connect();await f.cold().flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(1);
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.survivor.id)).toBe('Independent changed');
  expect(f.bodies.some(body=>JSON.parse(body).operationKind==='entry.delete')).toBe(false);
  expect(readLocalFinalState(await f.store.readMeta(LOCAL_FINAL_STATE_KEY)).deleted).toEqual([deletion]);
 }finally{f.close();}
});
it('duration edit then delete settles the final deleted owner timeline after cold exact retries',async()=>{
 const f=await fixture();try{
  await f.current.updateEntry(f.entry.id,{title:'Changed',durationSeconds:0});
  await f.current.deleteEntry(f.entry.id);expect(await f.store.list()).toEqual([]);
  f.connect();const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline',lastFallbackAt:null};
  const cold=f.cold(state);await cold.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(0);
  expect(await f.store.list(),state.lastReplayError ?? undefined).toEqual([]);
  expect(f.bodies.map(body=>JSON.parse(body).operationKind)).toEqual(['entry.delete']);
 }finally{f.close();}
});
it('Author Tag Content usage View-later and media predecessors settle only against final authoritative delete',async()=>{
 const f=await fixture();try{
  await f.current.linkEntryAuthorByName(f.entry.id,'New retained Author');
  const detail=await f.current.getEntry(f.entry.id);const facet=detail.sections.flatMap(section=>section.facets)[0]!;
  await f.current.assignEntryTag(f.entry.id,{name:'delete timeline',facetId:facet.id});
  await f.current.createEntryContent(f.entry.id,{contentType:'Note',content:'before delete'});
  await f.current.likeEntry(f.entry.id);await f.current.addViewLaterEntry(f.entry.id);
  const sharp=(await import('../../server/node_modules/sharp/lib/index.js')).default;const png=await sharp({create:{width:2,height:2,channels:4,background:'#ff0000'}}).png().toBuffer();
  await f.current.uploadEntryMedia(f.entry.id,'preview',new File([new Uint8Array(png)],'preview.png',{type:'image/png'}));
  await f.store.captureLocalFinalState(true); // These are submitted predecessors, not cancellable drafts.
  await f.current.deleteEntry(f.entry.id);const operations=await f.store.list();const media=await f.store.listMedia();expect(media).toHaveLength(1);
  f.connect();const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline',lastFallbackAt:null};const cold=f.cold(state);await cold.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id),state.lastReplayError??undefined).toBe(0);
  expect(await f.store.list(),state.lastReplayError ?? undefined).toEqual([]);expect(await f.store.listMedia()).toEqual([]);
  expect(operations.length).toBeGreaterThan(4);expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(2);
 }finally{f.close();}
});
it('restoring its own export retains an identical local deletion rather than treating it as newer work',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);
  const before=await f.store.captureLocalFinalState();
  const backup=JSON.stringify(await buildPendingWorkExport(f.store));
  const prepared=await preparePendingWork(backup);
  expect(prepared.localFinalState?.deleted).toEqual(before.local.deleted);
  await expect(f.current.restorePendingWork!(backup)).resolves.toMatchObject({addedOperations:0,identicalOperations:1});
  const after=await f.store.captureLocalFinalState();
  expect(after.local).toEqual(before.local);expect(after.operations).toEqual(before.operations);expect(after.media).toEqual(before.media);
 }finally{f.close();}
});

it('restore rejects a later write to a deleted owner atomically and retains current exact operations',async()=>{
 const f=await fixture();try{
  await f.current.updateEntry(f.entry.id,{title:'Before'});const update=originalMutationEnvelope((await f.store.list())[0]!);
  await f.current.deleteEntry(f.entry.id);const before=await f.store.list();const backup=await buildPendingWorkExport(f.store);
  const bad={...backup,operations:[...backup.operations,{...update,status:'pending',lastAttemptAt:null,lastError:null,opId:randomUUID(),baseVersion:update.baseVersion+1,clientCreatedAt:new Date(Date.parse(update.clientCreatedAt)+1).toISOString()}]};
  await expect(f.current.restorePendingWork!(JSON.stringify(bad))).rejects.toThrow(/delet/i);expect(await f.store.list()).toEqual(before);
 }finally{f.close();}
});
it('known-offline deleted detail refuses locally rather than business HTTP; post-delete writes cannot recreate it',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);f.business.length=0;
  await expect(f.current.getEntry(f.entry.id)).rejects.toThrow();expect(f.business).toEqual([]);
  await expect(f.current.updateEntry(f.entry.id,{title:'Resurrection'})).rejects.toThrow(/delet/i);
  expect(await f.store.list()).toEqual([]);expect(readLocalFinalState(await f.store.readMeta(LOCAL_FINAL_STATE_KEY)).deleted).toHaveLength(1);
 }finally{f.close();}
});
it.each([false,undefined])('cold capability %s refuses deletion with zero business HTTP and no new envelope',async value=>{
 const f=await fixture();try{
  f.connect();const caps=await f.online.getSyncCapabilities();
  if(value===undefined)delete caps.featureFlags.offlineEntryDelete;else caps.featureFlags.offlineEntryDelete=value;
  f.online.getSyncCapabilities=async()=>caps;await f.current.getSyncCapabilities({replay:false});
  const cold=f.cold();await cold.preferOfflineSnapshot!();f.business.length=0;
  await expect(cold.deleteEntry(f.entry.id)).rejects.toThrow('This library does not support Entry deletion');expect(f.business).toEqual([]);expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});
it('exact delete replay after numeric ID reuse never removes replacement media',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.survivor.id);await f.seal();const op=originalMutationEnvelope((await f.store.list())[0]!);f.connect();await f.online.replaySyncOperation!(op);
  const {createEntry}=await serverModule('repositories/entry-repository');const replacement=createEntry(f.db,{title:'Replacement',type:'comic'});expect(replacement.id).toBe(f.survivor.id);
  const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs');const path=join(f.root,'entries',String(replacement.id));mkdirSync(path,{recursive:true});writeFileSync(join(path,'cover.webp'),'replacement bytes');
  expect((await f.online.replaySyncOperation!(op)).status).toBe('applied');expect(readFileSync(join(path,'cover.webp'),'utf8')).toBe('replacement bytes');
 }finally{f.close();}
});
it.each(['corrupt','foreign','body'])('changed stored delete proof %s cannot authorize cleanup after ACK loss',async mode=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);await f.seal();const row=(await f.store.list())[0]!;f.connect();f.loseAck();await f.current.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);
  const key='entryDeleteProof.'+row.opId;const original=await f.store.readMeta(key);expect(original).not.toBeNull();
  const proof=JSON.parse(original!);if(mode==='foreign')proof.receipt.entityId=999;else if(mode==='body')proof.fingerprint='changed';
  await f.store.writeMeta(key,mode==='corrupt'?'native raw proof':JSON.stringify(proof));const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline',lastFallbackAt:null};
  await f.cold(state).flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);
 }finally{f.close();}
});
it('absence without an authoritative matching delete journal cannot authorize receipt cleanup',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);f.connect();
  const fetch=f.online.fetchSyncChanges!;
  f.online.fetchSyncChanges=async query=>({...await fetch(query),changes:[]});
  await f.current.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);
  f.online.fetchSyncChanges=fetch;await f.current.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});
it('strict version conflict holds deletion but lets an independent Entry settle; collision and identity mismatch never delete',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);await f.seal();await f.current.updateEntry(f.survivor.id,{title:'Updated survivor'});
  const operation=originalMutationEnvelope((await f.store.list())[0]!);if(operation.operationKind!=='entry.delete')throw new Error('Expected delete');f.connect();
  f.db.prepare('UPDATE entries SET title=? WHERE id=?').run('Server update',f.entry.id);
  await f.current.flushOfflineOutbox!();const held=await f.store.list();expect(held).toHaveLength(1);expect(held[0]!.status).toBe('conflict');
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.survivor.id)).toBe('Updated survivor');
  expect((await f.online.replaySyncOperation!({...operation,baseVersion:operation.baseVersion+1})).status).toBe('failed');
  expect((await f.online.replaySyncOperation!({...operation,opId:randomUUID(),syncEpoch:'another'})).status).toBe('resnapshot-required');
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(1);
 }finally{f.close();}
});
it('actual GalleryApp double-confirm uses durable offline deletion and returns to the correct Gallery with cold absence',async()=>{
 const f=await fixture();setLocale('en');vi.stubGlobal('scrollTo',vi.fn());const wrapper=mount(GalleryApp,{props:{api:f.current}});
 try{
  await settle();await wrapper.get('[data-gallery-type="comic"]').trigger('click');await settle();
  await wrapper.get(`[data-entry-id="${f.entry.id}"]`).trigger('click');await settle();
  await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
  f.business.length=0;const button=wrapper.get('[data-testid="delete-entry"]');await button.trigger('click');expect(await f.store.list()).toEqual([]);
  await button.trigger('click');await settle();expect(await f.store.list()).toEqual([]);expect(readLocalFinalState(await f.store.readMeta(LOCAL_FINAL_STATE_KEY)).deleted).toHaveLength(1);
  expect(wrapper.find('[data-testid="entry-list"]').exists()).toBe(true);
  expect(wrapper.find(`[data-entry-id="${f.entry.id}"]`).exists()).toBe(false);expect(f.business).toEqual([]);
  const cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.queryEntryPage(entryPageQueryRequestSchema.parse({entryType:'comic'}))).total).toBe(1);
 }finally{wrapper.unmount();f.close();vi.unstubAllGlobals();}
});
