import { createHash, randomUUID } from 'node:crypto';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { IDBFactory } from 'fake-indexeddb';

import { expect, it, vi } from 'vitest';

import { mount, flushPromises } from '@vue/test-utils';

vi.hoisted(async () => {

  const { JSDOM } = await import('jsdom');

  const window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://isolated/' }).window;

  Object.defineProperty(globalThis, 'addEventListener', {value:window.addEventListener.bind(window),configurable:true});

  Object.defineProperty(globalThis, 'removeEventListener', {value:window.removeEventListener.bind(window),configurable:true});

  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'localStorage', 'sessionStorage', 'MutationObserver', 'navigator', 'getComputedStyle']) {

    Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key as keyof typeof window], configurable: true });

  }

});

import GalleryApp from '../src/GalleryApp.vue';

import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';

import { operationFingerprint } from '../src/offline/outbox-store.js';

import { setLocale } from '../src/i18n.js';

import { showNsfw } from '../src/stores/preferences.js';

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

const settle = async () => { for (let i = 0; i < 20; i++) { await flushPromises(); await new Promise(resolve=>setTimeout(resolve,5)); } };

it('ordinary offline partition toggle queues one owner and cold whole Gallery Author visibility then real SQL ACK', async()=>{

 const f=await fixture();setLocale('en');showNsfw.value=true;vi.stubGlobal('scrollTo',vi.fn());await f.offline();

 const wrapper=mount(GalleryApp,{props:{api:f.api,offlineStore:f.store,offlineState:{mode:'offline'} as never}});try{

  await settle();const gallery=wrapper.findAll('button').find(row=>row.text().includes('Comic'));expect(gallery).toBeDefined();await gallery!.trigger('click');await settle();

  await wrapper.get('[data-testid="gallery-partition-toggle"]').trigger('click');await settle();

  expect(f.calls).toEqual([]);expect(await f.store.list()).toHaveLength(1);

  const original=(await f.store.list())[0]!;expect(original.operationKind).toBe('gallery.partition.set');

  const cold=f.cold();await cold.preferOfflineSnapshot!();

  expect(await cold.listGalleries()).toContainEqual({type:'Comic',entryCount:2,nsfw:true});

  expect((await cold.listAuthors()).find(row=>row.id===f.author.id)?.nsfw).toBe(true);

  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();

  expect(await f.store.list()).toEqual([]);

  expect(f.db.prepare('SELECT nsfw FROM gallery_settings WHERE entry_type=?').pluck().get('Comic')).toBe(1);

  expect(f.db.prepare('SELECT count(*) FROM sync_operation_receipts WHERE op_id=?').pluck().get(original.opId)).toBe(1);

 }finally{wrapper.unmount();f.close();vi.unstubAllGlobals();}

});

it('partition original survives response loss cold atomic restore ACK loss and exact retry',async()=>{

 const f=await fixture();try{

  await f.offline();await f.api.setGalleryPartition('Comic',true);const original=(await f.store.list())[0]!;const fingerprint=operationFingerprint(original);

  f.reconnect();f.loseResponse();await f.api.getSyncCapabilities({replay:false});await f.api.replayOfflineOperations!();expect(operationFingerprint((await f.store.list())[0]!)).toBe(fingerprint);

  const rows=await f.store.list();const archive=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany(rows.map(row=>row.opId));let cold=f.cold();await cold.restorePendingWork!(archive);expect(await f.store.list()).toEqual(rows);

  f.loseAcknowledgement();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(await f.store.list()).toHaveLength(1);

  const state={mode:'offline',lastFallbackAt:null,lastReplayError:null} as import('../src/offline/offline-api.js').OfflineApiState;cold=createOfflineAwareGalleryApi(f.online,f.store,{clientId:'collection-parity-phone',randomUUID,state});await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(state.lastReplayError).toBeNull();expect(await f.store.list()).toEqual([]);expect(new Set(f.bodies).size).toBe(1);

  expect(f.db.prepare('SELECT count(*) FROM sync_operation_receipts WHERE op_id=?').pluck().get(original.opId)).toBe(1);

  expect(f.db.prepare("SELECT resource_version FROM sync_changes WHERE entity_kind='gallery_partition' AND entity_uid=?").pluck().all(original.entityUid)).toEqual([2]);

 }finally{f.close();}

});

it('same desired partition is one durable queue and required flags false absent refuse zero business HTTP',async()=>{

 const f=await fixture();try{await f.offline();await f.api.setGalleryPartition('Comic',true);await f.api.setGalleryPartition('Comic',true);expect(await f.store.list()).toHaveLength(1);expect(f.calls).toEqual([]);}finally{f.close();}

 for(const flag of ['offlineMutations','offlineGalleryPartition'])for(const absent of [true,false]){const f=await fixture();try{await f.offline();if(absent)await f.deleteCapability(flag);else await f.store.writeMeta('capability.'+flag,'0');await expect(f.api.setGalleryPartition('Comic',true)).rejects.toThrow('not available under offline');expect(await f.store.list()).toEqual([]);expect(f.calls).toEqual([]);}finally{f.close();}}

});

it('attempted partition capability downgrade preserves original without mutation HTTP',async()=>{

 const f=await fixture();try{

  await f.offline();await f.api.setGalleryPartition('Comic',true);await f.api.setGalleryPartition('Unstructured',true);f.reconnect();f.loseResponse();await f.api.getSyncCapabilities({replay:false});await f.api.replayOfflineOperations!();

  const original=(await f.store.list())[0]!;await f.store.writeMeta('capability.offlineGalleryPartition','0');f.calls.length=0;await f.api.replayOfflineOperations!();expect(f.calls.filter(row=>row.startsWith('POST'))).toEqual([]);expect(operationFingerprint((await f.store.list())[0]!)).toBe(operationFingerprint(original));

 }finally{f.close();}

});

it('pending new type partition is explicitly fail closed without guessed owner or extra queue',async()=>{

 const f=await fixture();try{await f.offline();await f.deleteCapability('offlineGalleryPartitionOrigins');await f.api.enqueueOfflineEntryCreate!({title:'New pending',type:'Pending Type',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});const rows=await f.store.list();await expect(f.api.setGalleryPartition('Pending Type',true)).rejects.toThrow('missing saved type owner');expect(await f.store.list()).toEqual(rows);expect(f.calls).toEqual([]);}finally{f.close();}

});

it('covering cursor cannot clean partition when authoritative snapshot omits its dedicated owner',async()=>{

 const f=await fixture();try{await f.offline();await f.api.setGalleryPartition('Comic',true);f.reconnect();

  const {fetchSnapshotDelta,...rest}=f.online;void fetchSnapshotDelta;const online={...rest,fetchSyncSnapshot:async()=>{const snapshot=await f.online.fetchSyncSnapshot();snapshot.payload.galleryPartitionScopes=[];const {checksum,...header}=snapshot.header;void checksum;snapshot.header.checksum=createHash('sha256').update(JSON.stringify(header)).update(JSON.stringify(snapshot.payload)).digest('hex');return snapshot;}};

  const cold=createOfflineAwareGalleryApi(online,f.store,{clientId:'collection-parity-phone',randomUUID});await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(await f.store.list()).toHaveLength(1);

 }finally{f.close();}

});

