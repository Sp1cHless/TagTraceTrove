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
  connect(){disconnected=false;},loseReplay(){loseReplay=true;},loseAck(){loseAck=true;},
  cold(state?: import('../src/offline/offline-api.js').OfflineApiState){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName:name});return api(state);},
  close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}};
}
it('ordinary existing Entry deletion is durable and cold projected; real SQL receipt-loss retry and ACK settle without resurrecting it',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);expect(f.business).toEqual([]);
  const original=(await f.store.list())[0]!;expect(original).toMatchObject({operationKind:'entry.delete',entityKind:'entry',status:'pending'});
  expect((await f.current.queryEntryPage(entryPageQueryRequestSchema.parse({entryType:'comic'}))).items.map(row=>row.id)).toEqual([f.survivor.id]);
  expect((await f.current.queryProducerPage(producerPageQueryRequestSchema.parse({}))).total).toBe(0);
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(1);
  const backup=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany([original.opId]);
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
it('duration edit then delete settles the final deleted owner timeline after cold exact retries',async()=>{
 const f=await fixture();try{
  await f.current.updateEntry(f.entry.id,{title:'Changed',durationSeconds:0});
  await f.current.deleteEntry(f.entry.id);const originals=(await f.store.list()).map(originalMutationEnvelope);
  f.connect();const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline',lastFallbackAt:null};
  const cold=f.cold(state);await cold.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(0);
  expect(await f.store.list(),state.lastReplayError ?? undefined).toEqual([]);
  expect(f.bodies.map(body=>JSON.parse(body))).toEqual(originals);
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
  await f.current.deleteEntry(f.entry.id);const operations=await f.store.list();const media=await f.store.listMedia();expect(media).toHaveLength(1);
  f.connect();const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline',lastFallbackAt:null};const cold=f.cold(state);await cold.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(0);
  expect(await f.store.list(),state.lastReplayError ?? undefined).toEqual([]);expect(await f.store.listMedia()).toEqual([]);
  expect(operations.length).toBeGreaterThan(4);expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(2);
 }finally{f.close();}
});
it('restore rejects a later write to a deleted owner atomically and retains current exact operations',async()=>{
 const f=await fixture();try{
  await f.current.updateEntry(f.entry.id,{title:'Before'});const update=originalMutationEnvelope((await f.store.list())[0]!);
  await f.current.deleteEntry(f.entry.id);const before=await f.store.list();const backup=await buildPendingWorkExport(f.store);
  const bad={...backup,operations:[...backup.operations,{...before[0]!,...update,opId:randomUUID(),baseVersion:before[1]!.baseVersion+1,clientCreatedAt:new Date(Date.parse(before[1]!.clientCreatedAt)+1).toISOString()}]};
  await expect(f.current.restorePendingWork!(JSON.stringify(bad))).rejects.toThrow(/delet/i);expect(await f.store.list()).toEqual(before);
 }finally{f.close();}
});
it('known-offline deleted detail refuses locally rather than business HTTP; post-delete writes cannot recreate it',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);f.business.length=0;
  await expect(f.current.getEntry(f.entry.id)).rejects.toThrow();expect(f.business).toEqual([]);
  await expect(f.current.updateEntry(f.entry.id,{title:'Resurrection'})).rejects.toThrow(/delet/i);
  expect(await f.store.list()).toHaveLength(1);
 }finally{f.close();}
});
it.each([false,undefined])('cold capability %s refuses deletion with zero business HTTP and no new envelope',async value=>{
 const f=await fixture();try{
  f.connect();const caps=await f.online.getSyncCapabilities();
  if(value===undefined)delete caps.featureFlags.offlineEntryDelete;else caps.featureFlags.offlineEntryDelete=value;
  f.online.getSyncCapabilities=async()=>caps;await f.current.getSyncCapabilities({replay:false});
  const cold=f.cold();await cold.preferOfflineSnapshot!();f.business.length=0;
  await expect(cold.deleteEntry(f.entry.id)).rejects.toThrow(/refresh/i);expect(f.business).toEqual([]);expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});
it('exact delete replay after numeric ID reuse never removes replacement media',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.survivor.id);const op=originalMutationEnvelope((await f.store.list())[0]!);f.connect();await f.online.replaySyncOperation!(op);
  const {createEntry}=await serverModule('repositories/entry-repository');const replacement=createEntry(f.db,{title:'Replacement',type:'comic'});expect(replacement.id).toBe(f.survivor.id);
  const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs');const path=join(f.root,'entries',String(replacement.id));mkdirSync(path,{recursive:true});writeFileSync(join(path,'cover.webp'),'replacement bytes');
  expect((await f.online.replaySyncOperation!(op)).status).toBe('applied');expect(readFileSync(join(path,'cover.webp'),'utf8')).toBe('replacement bytes');
 }finally{f.close();}
});
it.each(['corrupt','foreign','body'])('changed stored delete proof %s cannot authorize cleanup after ACK loss',async mode=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);const row=(await f.store.list())[0]!;f.connect();f.loseAck();await f.current.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);
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
  await f.current.deleteEntry(f.entry.id);await f.current.updateEntry(f.survivor.id,{title:'Updated survivor'});
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
  await button.trigger('click');await settle();expect(await f.store.list()).toHaveLength(1);
  expect(wrapper.find('[data-testid="entry-list"]').exists()).toBe(true);
  expect(wrapper.find(`[data-entry-id="${f.entry.id}"]`).exists()).toBe(false);expect(f.business).toEqual([]);
  const cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.queryEntryPage(entryPageQueryRequestSchema.parse({entryType:'comic'}))).total).toBe(1);
 }finally{wrapper.unmount();f.close();vi.unstubAllGlobals();}
});
