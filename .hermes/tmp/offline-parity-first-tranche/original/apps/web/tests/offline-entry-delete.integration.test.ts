import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
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
 const api=()=>createOfflineAwareGalleryApi(online,store,{clientId:'delete-phone',randomUUID});const current=api();
 await current.getSyncCapabilities({replay:false});await current.preferOfflineSnapshot!();business.length=0;disconnected=true;
 return {db,root,entry,survivor,author,online,current,bodies,business,get store(){return store;},
  connect(){disconnected=false;},loseReplay(){loseReplay=true;},loseAck(){loseAck=true;},
  cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName:name});return api();},
  close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}};
}
it('ordinary existing Entry deletion is durable and cold projected; real SQL receipt-loss retry and ACK settle without resurrecting it',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);expect(f.business).toEqual([]);
  const original=(await f.store.list())[0]!;expect(original).toMatchObject({operationKind:'entry.delete',entityKind:'entry',status:'pending'});
  expect((await f.current.queryEntryPage({entryType:'comic'})).items.map(row=>row.id)).toEqual([f.survivor.id]);
  expect((await f.current.queryProducerPage({})).total).toBe(0);
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(1);
  const backup=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany([original.opId]);
  const cold=f.cold();await cold.restorePendingWork!(backup);await cold.preferOfflineSnapshot!();
  expect((await cold.queryEntryPage({entryType:'comic'})).items.map(row=>row.id)).toEqual([f.survivor.id]);
  f.connect();f.loseReplay();await cold.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(0);
  expect(await f.store.list()).toHaveLength(1);
  f.loseAck();const retry=f.cold();await retry.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);
  await retry.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.bodies.length).toBeGreaterThanOrEqual(3);expect(new Set(f.bodies).size).toBe(1);
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(1);
  expect(f.db.prepare('SELECT count(*) FROM entry_producers WHERE entry_id=?').pluck().get(f.entry.id)).toBe(0);
 }finally{f.close();}
});
