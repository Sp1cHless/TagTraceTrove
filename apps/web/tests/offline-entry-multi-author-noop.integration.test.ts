import { randomUUID } from 'node:crypto';
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
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-entry-multi-author-noop-'));
  try {
  const work=createEntry(db,{title:'Already converted',type:'Comic'}),peer=createEntry(db,{title:'Peer work',type:'Comic'});
  const target=createProducer(db,{name:'multiple author'});linkEntryProducer(db,work.id,target.id);linkEntryProducer(db,peer.id,target.id);
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
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'entry-multi-author-noop-phone',randomUUID});
  return {db,root,work,peer,target,api,online,calls,bodies,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
    reconnect(){disconnected=false;},loseResponse(){loseReplay=true;},loseAcknowledgement(){loseAck=true;},
    get replayState(){return replayState;},cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'entry-multi-author-noop-phone',randomUUID,state:replayState});},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}

it('target-alone saved-copy conversion settles as an applied no-op with durable proof and cleanup',async()=>{
 const f=await fixture();try{
  await f.offline();const dto=await f.api.convertEntryAuthors(f.work.id);
  expect(dto.convertedAuthors).toEqual([]);expect(dto.multiAuthorId).toBe(f.target.id);
  expect(await f.store.list()).toHaveLength(1);
  const beforeVersion=f.db.prepare('SELECT sync_version FROM entries WHERE id=?').pluck().get(f.work.id) as number;
  f.reconnect();await f.api.getSyncCapabilities({replay:false});await f.api.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);
  expect(await f.store.readMeta('activeGeneration')).toBe('2');
  expect(f.db.prepare('SELECT producer_id FROM entry_producers WHERE entry_id=?').pluck().all(f.work.id)).toEqual([f.target.id]);
  expect(f.db.prepare('SELECT sync_version FROM entries WHERE id=?').pluck().get(f.work.id)).toBe(beforeVersion);
  const cold=f.cold();await cold.preferOfflineSnapshot!();
  expect((await cold.getEntry(f.work.id)).producers.map(row=>row.id)).toEqual([f.target.id]);
 }finally{f.close();}
});
it('target-alone no-op survives response and ACK loss through cold exact-body retries',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.convertEntryAuthors(f.work.id);const original=(await f.store.list())[0]!;
  f.reconnect();await f.api.getSyncCapabilities({replay:false});f.loseResponse();
  await f.api.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);const body=f.bodies[0];
  f.loseAcknowledgement();
  const cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toHaveLength(1);expect(await f.store.readMeta('conversionProof.'+original.opId)).not.toBeNull();
  const retry=f.cold();await retry.getSyncCapabilities({replay:false});await retry.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);
  expect(f.bodies.every(row=>row===body)).toBe(true);
  expect(f.db.prepare('SELECT producer_id FROM entry_producers WHERE entry_id=?').pluck().all(f.work.id)).toEqual([f.target.id]);
 }finally{f.close();}
});
