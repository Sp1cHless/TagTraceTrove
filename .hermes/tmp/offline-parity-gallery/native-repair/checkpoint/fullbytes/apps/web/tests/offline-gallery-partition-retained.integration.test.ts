import { randomUUID } from 'node:crypto';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { IDBFactory } from 'fake-indexeddb';

import { expect, it, vi } from 'vitest';


vi.hoisted(async () => {

  const { JSDOM } = await import('jsdom');

  const window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://isolated/' }).window;

  Object.defineProperty(globalThis, 'addEventListener', {value:window.addEventListener.bind(window),configurable:true});

  Object.defineProperty(globalThis, 'removeEventListener', {value:window.removeEventListener.bind(window),configurable:true});

  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'localStorage', 'sessionStorage', 'MutationObserver', 'navigator', 'getComputedStyle']) {

    Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key as keyof typeof window], configurable: true });

  }

});


import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';

import { originalMutationEnvelope } from '../src/offline/sync-mutation-plan.js';
import { operationFingerprint } from '../src/offline/outbox-store.js';



import { createGalleryApi } from '../src/api/gallery.js';

import { createApiClient } from '../src/api/client.js';

import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';

import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';

const serverModule = async (path: string) => {

  const target = `../../server/src/${path}.js`;

  return import(/* @vite-ignore */ target);

};

async function fixture() {

  const { createMigratedMemoryDatabase } = await serverModule('database/testing');

  const { createApiApp } = await serverModule('http/app');

  const { createEntry } = await serverModule('repositories/entry-repository');

  const { createProducer, linkEntryProducer } = await serverModule('repositories/producer-repository');

  const { createSection } = await serverModule('repositories/layout-repository');

  const { createCollection, addCollectionEntry } = await serverModule('repositories/collection-repository');

  const db = createMigratedMemoryDatabase();

  const root = mkdtempSync(join(tmpdir(), 't3-collection-parity-'));

  const section = createSection(db, { entryType: 'Comic', name: 'Tags' });

  const work = createEntry(db, { title: 'Shared work', type: 'Comic' });

  const other = createEntry(db, { title: 'Child work', type: 'Comic' });

  const skipped = createEntry(db, { title: 'Unstructured work', type: 'Unstructured' });

  const author = createProducer(db, { name: 'Surviving Author' });

  linkEntryProducer(db, work.id, author.id);

  const parent = createCollection(db, { kind: 'entry', title: 'Shelf', galleryType: 'Comic' });

  const child = createCollection(db, { kind: 'entry', title: 'Child shelf', parentId: parent.id });

  const peer = createCollection(db, { kind: 'entry', title: 'Peer shelf', galleryType: 'Comic' });

  for (const folder of [parent, child, peer]) addCollectionEntry(db, folder.id, work.id);

  addCollectionEntry(db, child.id, other.id);

  addCollectionEntry(db, parent.id, skipped.id);

  addCollectionEntry(db, child.id, skipped.id);

  const app = createApiApp(db, { assetRoot: join(root, 'assets'), dataDir: root });

  const calls: string[] = [];

  let disconnected = false;

  let responseTamper: ((path:string,response:Response)=>Promise<Response>) | undefined;

  let loseReplay=false,loseAck=false;const bodies:string[]=[];let downgraded=false;

  const online = createGalleryApi(createApiClient({ baseUrl: 'http://isolated/api', fetchImplementation: async (input, init) => {

    const url = new URL(String(input));

    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);

    if (disconnected) throw new TypeError('Known offline');

    if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));

    let response=await app.request(url.pathname + url.search, init);

    if(downgraded && url.pathname==='/api/sync/capabilities'){const data=await response.json();data.featureFlags.offlineCollectionCommonTag=false;response=new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});}

    if(loseReplay && url.pathname==='/api/sync/replay' && response.ok){loseReplay=false;throw new TypeError('Lost SQL response');}

    if(loseAck && url.pathname.includes('/ack') && response.ok){loseAck=false;throw new TypeError('Lost ACK response');}

    return responseTamper ? responseTamper(url.pathname,response) : response;

  } }));

  const indexedDB=new IDBFactory(),databaseName=randomUUID();

  let store = createIndexedDbOfflineStore({ indexedDB, databaseName });

  const api = createOfflineAwareGalleryApi(online, store, { clientId: 'collection-parity-phone', randomUUID });

  return { db, section, work, other, skipped, author, parent, child, peer, online, api, calls, bodies, get store(){return store;},

    tamperResponse(hook:typeof responseTamper){responseTamper=hook;},

    reconnect(){disconnected=false;},loseResponse(){loseReplay=true;},loseAcknowledgement(){loseAck=true;},downgrade(){downgraded=true;},

    async durableState() {

      const database=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(databaseName);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});

      const names=Array.from(database.objectStoreNames);

      try{return await new Promise<Record<string,unknown>>((resolve,reject)=>{

        const tx=database.transaction(names,'readonly');const requests=names.map(name=>({name,keys:tx.objectStore(name).getAllKeys(),values:tx.objectStore(name).getAll()}));

        tx.oncomplete=()=>resolve(Object.fromEntries(requests.map(row=>[row.name,{keys:row.keys.result,values:row.values.result}])));tx.onerror=()=>reject(tx.error);

      });}finally{database.close();}

    },

    async deleteMeta(key:string) {

      const database=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(databaseName);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});

      try{await new Promise<void>((resolve,reject)=>{const tx=database.transaction('meta','readwrite');tx.objectStore('meta').delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}finally{database.close();}

    },

    async deleteCapability(flag:string) {

      const database=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(databaseName);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});

      await new Promise<void>((resolve,reject)=>{const tx=database.transaction('meta','readwrite');tx.objectStore('meta').delete('capability.'+flag);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});database.close();

    },

    cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'collection-parity-phone',randomUUID});},

    async offline() {

      await store.writeGeneration(1, JSON.stringify(await online.fetchSyncSnapshot()));

      await store.writeMeta('activeGeneration', '1');

      await api.getSyncCapabilities({ replay: false });

      await api.preferOfflineSnapshot!();

      disconnected = true;

      calls.length = 0;

    },

    close() { store.close(); db.close(); rmSync(root, { recursive: true, force: true }); },

  };

}


it('connected no-copy bounded canonical SQL response-loss retries original UUID and raw body without installing snapshot',async()=>{
 const f=await fixture();try{
  f.loseResponse();await f.api.setGalleryPartition('Comic',true);
  expect(f.calls).toContain('GET /api/galleries/Comic/partition-context');expect(f.bodies).toHaveLength(1);
  const original=(await f.store.list())[0]!;expect(original.operationKind).toBe('gallery.partition.set');const fingerprint=operationFingerprint(original);
  expect(f.db.prepare('SELECT nsfw FROM gallery_settings WHERE entry_type=?').pluck().get('Comic')).toBe(1);
  const cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.setGalleryPartition('Comic',true);
  expect(f.bodies).toHaveLength(2);expect(f.bodies[1]).toBe(f.bodies[0]);expect(operationFingerprint((await f.store.list())[0]!)).toBe(fingerprint);
  await cold.replayOfflineOperations!();expect(f.bodies).toHaveLength(3);expect(f.bodies[2]).toBe(f.bodies[0]);
  expect(f.calls.some(call=>call.includes('/snapshot') || call.includes('/assets') || call.startsWith('PUT'))).toBe(false);
  expect(await f.store.readMeta('activeGeneration')).toBeNull();
 }finally{f.close();}
});

it('legal pending type origin serial stages causal owner then cold projection restore SQL own journal and ACK loss',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.enqueueOfflineEntryCreate!({title:'New pending',type:'Pending Type',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});
  await Promise.all([f.api.setGalleryPartition('Pending Type',true),f.api.setGalleryPartition('Pending Type',false)]);
  const rows=await f.store.list();expect(rows).toHaveLength(3);expect(rows.slice(1).map(row=>row.baseVersion)).toEqual([1,2]);expect(rows[1]!.entityUid).toBe(rows[0]!.payload.partitionScopeUid);
  let cold=f.cold();await cold.preferOfflineSnapshot!();expect(await cold.listGalleries()).toContainEqual({type:'Pending Type',entryCount:1,nsfw:false});expect(await cold.listLayout('Pending Type')).toEqual([]);expect(f.calls).toEqual([]);
  const archive=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany(rows.map(row=>row.opId));cold=f.cold();await cold.restorePendingWork!(archive);expect(await f.store.list()).toEqual(rows);
  f.reconnect();f.loseAcknowledgement();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(await f.store.list()).toHaveLength(3);
  cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT sync_uid FROM gallery_partition_scopes WHERE entry_type=?').pluck().get('Pending Type')).toBe(rows[1]!.entityUid);
  expect(f.db.prepare("SELECT resource_version FROM sync_changes WHERE entity_kind='gallery_partition' AND entity_uid=? ORDER BY seq").pluck().all(rows[1]!.entityUid)).toEqual([2,3]);
  expect(new Set(f.bodies).size).toBe(3);
 }finally{f.close();}
});

it('old copy server-new type uses bounded current owner canonical command not snapshot media or legacy PUT',async()=>{
 const f=await fixture();try{
  await f.offline();f.reconnect();await f.api.getSyncCapabilities({replay:false});
  const {createEntry}=await serverModule('repositories/entry-repository');createEntry(f.db,{title:'Server new',type:' New Type '.trim()});
  const generation=await f.store.readMeta('activeGeneration');f.calls.length=0;
  await f.api.setGalleryPartition('New Type',true);const row=(await f.store.list())[0]!;
  expect(row.entityUid).toBe(f.db.prepare('SELECT sync_uid FROM gallery_partition_scopes WHERE entry_type=?').pluck().get('New Type'));
  expect(f.bodies).toHaveLength(1);expect(f.calls.some(call=>call.includes('/snapshot') || call.includes('/assets') || call.startsWith('PUT'))).toBe(false);expect(await f.store.readMeta('activeGeneration')).toBe(generation);
 }finally{f.close();}
});
it('foreign altered child origins restore atomically refuses with zero partial rows valid archive still settles',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.enqueueOfflineEntryCreate!({title:'Fresh',type:'Fresh Type',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});await f.api.setGalleryPartition('Fresh Type',true);
  const archive=await buildPendingWorkExport(f.store),rows=await f.store.list();await f.store.removeMany(rows.map(row=>row.opId));const cold=f.cold();
  await f.store.bindPendingWorkClient('collection-parity-phone');
  const mutations=[(row:typeof rows[number])=>{row.entityUid=randomUUID();},(row:typeof rows[number])=>{row.payload.entryType='Comic';},(row:typeof rows[number])=>{row.libraryId='foreign-library';},(row:typeof rows[number])=>{row.syncEpoch='foreign-epoch';},(row:typeof rows[number])=>{row.clientId='foreign-client';},(row:typeof rows[number])=>{(row.payload.typeOwnerOrigin as Record<string,unknown>).opId=randomUUID();},(row:typeof rows[number])=>{((row.payload.typeOwnerOrigin as Record<string,unknown>).payload as Record<string,unknown>).title='Changed creator';}];
  for(const mutate of mutations){const bad=structuredClone(archive);mutate(bad.operations[1]!);const before=await f.durableState();await expect(cold.restorePendingWork!(JSON.stringify(bad))).rejects.toThrow();expect(await f.durableState()).toEqual(before);expect(await f.store.list()).toEqual([]);}
  await cold.restorePendingWork!(JSON.stringify(archive));expect(await f.store.list()).toEqual(rows);
  // SQL compares the frozen creator envelope hash, not merely UUID/type numbers.
  f.reconnect();await f.online.replaySyncOperation!(originalMutationEnvelope(rows[0]!));const bad=structuredClone(rows[1]!);bad.opId=randomUUID();(bad.payload.typeOwnerOrigin as Record<string,unknown>).clientCreatedAt='foreign-time';
  const result=await f.online.replaySyncOperation!(originalMutationEnvelope(bad));expect(result.status).toBe('failed');expect(f.db.prepare('SELECT count(*) FROM gallery_settings WHERE entry_type=?').pluck().get('Fresh Type')).toBe(0);
  await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});
it('held creator blocks serial sameowner partitions and attempted capability downgrade retains exact origins',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.enqueueOfflineEntryCreate!({title:'Held',type:'Held Type',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});await Promise.all([f.api.setGalleryPartition('Held Type',true),f.api.setGalleryPartition('Held Type',false)]);
  const originals=await f.store.list();await f.store.update(originals[0]!.opId,{status:'conflict'});f.reconnect();await f.api.getSyncCapabilities({replay:false});f.calls.length=0;await f.api.replayOfflineOperations!();expect(f.bodies).toEqual([]);expect((await f.store.list()).map(operationFingerprint)).toEqual(originals.map(operationFingerprint));
  await f.store.update(originals[0]!.opId,{status:'pending'});f.loseResponse();await f.api.replayOfflineOperations!();expect(f.bodies).toHaveLength(1);const attempted=await f.store.list();await f.store.writeMeta('capability.offlineGalleryPartitionOrigins','0');f.calls.length=0;await f.api.replayOfflineOperations!();expect(f.calls.filter(call=>call.startsWith('POST'))).toEqual([]);expect((await f.store.list()).map(operationFingerprint)).toEqual(attempted.map(operationFingerprint));
 }finally{f.close();}
});
it('connected legacy capabilities retain old online PUT while attempted canonical originals never fallback',async()=>{
 const f=await fixture();try{
  f.tamperResponse(async(path,response)=>{if(path!=='/api/sync/capabilities')return response;const data=await response.json();delete data.featureFlags.offlineGalleryPartition;return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});});
  await f.api.setGalleryPartition('Comic',true);expect(f.calls).toContain('PUT /api/galleries/Comic/partition');expect(await f.store.list()).toEqual([]);
  f.tamperResponse(undefined);f.loseResponse();await f.api.setGalleryPartition('Comic',false);const rows=await f.store.list();
  f.tamperResponse(async(path,response)=>{if(path!=='/api/sync/capabilities')return response;const data=await response.json();delete data.featureFlags.offlineGalleryPartition;return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});});f.calls.length=0;
  await expect(f.api.setGalleryPartition('Comic',false)).rejects.toThrow('not available under offline');expect(f.calls.filter(call=>call.startsWith('PUT') || call.startsWith('POST'))).toEqual([]);expect((await f.store.list()).map(operationFingerprint)).toEqual(rows.map(operationFingerprint));
 }finally{f.close();}
});
