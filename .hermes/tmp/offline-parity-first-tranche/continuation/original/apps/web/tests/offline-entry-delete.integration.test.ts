import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { entryPageQueryRequestSchema, producerPageQueryRequestSchema } from '@t3/shared';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { originalMutationEnvelope } from '../src/offline/sync-mutation-plan.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
const serverModule = async (path: string) => { const target = `../../server/src/${path}.js`; return import(/* @vite-ignore */ target); };
async function fixture() {
 const { createMigratedMemoryDatabase } = await serverModule('database/testing');
 const { createEntry } = await serverModule('repositories/entry-repository');
 const { createProducer, linkEntryProducer } = await serverModule('repositories/producer-repository');
 const { createApiApp } = await serverModule('http/app');
 const db=createMigratedMemoryDatabase(), root=mkdtempSync(join(tmpdir(),'t3-entry-delete-'));
 const entry=createEntry(db,{title:'Delete this',type:'comic'}), survivor=createEntry(db,{title:'Keep this',type:'comic'});
 const author=createProducer(db,{name:'Retained workless Author'});linkEntryProducer(db,entry.id,author.id);
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
 await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');
 const api=(state?: import('../src/offline/offline-api.js').OfflineApiState)=>createOfflineAwareGalleryApi(online,store,{clientId:'delete-phone',randomUUID,...(state ? {state} : {})});const current=api();
 await current.getSyncCapabilities({replay:false});await current.preferOfflineSnapshot!();business.length=0;disconnected=true;
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
  f.loseAck();const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline'};const retry=f.cold(state);await retry.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);
  await retry.flushOfflineOutbox!();expect(await f.store.list(), state.lastReplayError ?? undefined).toEqual([]);
  expect(f.bodies.length).toBeGreaterThanOrEqual(3);expect(new Set(f.bodies).size).toBe(1);
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(1);
  expect(f.db.prepare('SELECT count(*) FROM entry_producers WHERE entry_id=?').pluck().get(f.entry.id)).toBe(0);
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
  const operation=originalMutationEnvelope((await f.store.list())[0]!);f.connect();
  f.db.prepare('UPDATE entries SET title=? WHERE id=?').run('Server update',f.entry.id);
  await f.current.flushOfflineOutbox!();const held=await f.store.list();expect(held).toHaveLength(1);expect(held[0]!.status).toBe('conflict');
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.survivor.id)).toBe('Updated survivor');
  expect((await f.online.replaySyncOperation!({...operation,baseVersion:operation.baseVersion+1})).status).toBe('failed');
  expect((await f.online.replaySyncOperation!({...operation,opId:randomUUID(),syncEpoch:'another'})).status).toBe('resnapshot-required');
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(1);
 }finally{f.close();}
});
