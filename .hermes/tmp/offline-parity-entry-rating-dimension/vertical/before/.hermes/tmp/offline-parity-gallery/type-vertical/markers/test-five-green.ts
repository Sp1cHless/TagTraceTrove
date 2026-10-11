import { randomUUID } from 'node:crypto';
import { pendingWorkFileSchema, syncReplayRequestSchema } from '@t3/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
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

it('ordinary known-offline new type creates one durable Entry and derived cold Gallery then settles real SQL', async () => {
 const f=await fixture();setLocale('en');showNsfw.value=true;vi.stubGlobal('scrollTo',vi.fn());await f.offline();
 const wrapper=mount(GalleryApp,{props:{api:f.api,offlineStore:f.store,offlineState:{mode:'offline'} as never}});
 try{
  await settle();await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');await settle();
  await wrapper.get('input[name="title"]').setValue('New type work');await wrapper.get('input[name="type"]').setValue('  Fresh Type  ');
  await wrapper.get('[data-testid="manual-entry-form"]').trigger('submit');await settle();
  expect(f.calls).toEqual([]);expect(await f.store.list()).toHaveLength(1);
  expect(wrapper.find('[data-testid="add-entry-page"]').exists()).toBe(false);
  const original=(await f.store.list())[0]!;expect(original.payload.type).toBe('Fresh Type');
  const cold=f.cold();await cold.preferOfflineSnapshot!();
  expect(await cold.listGalleries()).toContainEqual({type:'Fresh Type',entryCount:1,nsfw:false});
  expect(await cold.listLayout('Fresh Type')).toEqual([]);
  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();
  expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT title,type FROM entries WHERE sync_uid=?').get(original.entityUid)).toEqual({title:'New type work',type:'Fresh Type'});
  expect(f.db.prepare('SELECT count(*) FROM sync_operation_receipts WHERE op_id=?').pluck().get(original.opId)).toBe(1);
  expect(await f.online.listLayout('Fresh Type')).toEqual([]);
 }finally{wrapper.unmount();f.close();vi.unstubAllGlobals();}
});

const draft=(type='Fresh Type')=>({title:'Queued work',type,uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});
it('new type original survives SQL response loss cold export atomic restore and ACK loss exact retry',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.enqueueOfflineEntryCreate!(draft());const original=(await f.store.list())[0]!;const fingerprint=operationFingerprint(original);
  f.reconnect();f.loseResponse();await f.api.getSyncCapabilities({replay:false});await f.api.replayOfflineOperations!();
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE type=?').pluck().get('Fresh Type')).toBe(1);
  expect(operationFingerprint((await f.store.list())[0]!)).toBe(fingerprint);
  const attempted=await f.store.list();const archive=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany(attempted.map(row=>row.opId));
  let cold=f.cold();await cold.restorePendingWork!(archive);expect(await f.store.list()).toEqual(attempted);
  f.loseAcknowledgement();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(await f.store.list()).toHaveLength(1);
  const ackRows=await f.store.list();const ackArchive=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany(ackRows.map(row=>row.opId));cold=f.cold();await cold.restorePendingWork!(ackArchive);expect(await f.store.list()).toEqual(ackRows);
  await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(await f.store.list()).toEqual([]);
  expect(new Set(f.bodies).size).toBe(1);expect(f.bodies.length).toBeGreaterThanOrEqual(2);
  expect(f.db.prepare('SELECT count(*) FROM sync_operation_receipts WHERE op_id=?').pluck().get(original.opId)).toBe(1);
 }finally{f.close();}
});
it('same trimmed type reuses one derived Gallery and existing type retains canonical shared layout',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.enqueueOfflineEntryCreate!(draft(' Fresh Type '));await f.api.enqueueOfflineEntryCreate!(draft('Fresh Type'));await f.api.enqueueOfflineEntryCreate!(draft('Comic'));
  const cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.listGalleries()).filter(row=>row.type==='Fresh Type')).toEqual([{type:'Fresh Type',entryCount:2,nsfw:false}]);
  expect(await cold.listLayout('Comic')).toEqual(await (async()=>{f.reconnect();return f.online.listLayout('Comic');})());
  await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();expect(await f.store.list()).toEqual([]);
  expect((await f.online.listGalleries()).filter(row=>row.type==='Fresh Type')).toEqual([{type:'Fresh Type',entryCount:2,nsfw:false}]);
 }finally{f.close();}
});
it('required flags false and truly absent refuse new type locally with no queue or business HTTP',async()=>{
 for(const flag of ['offlineMutations','offlineEntryCreate','offlineEntryNewType'])for(const missing of [false,true]){
  const f=await fixture();try{
   await f.offline();if(missing)await f.deleteCapability(flag);else await f.store.writeMeta('capability.'+flag,'0');
   await expect(f.api.enqueueOfflineEntryCreate!(draft())).rejects.toThrow('not available under offline');expect(await f.store.list()).toEqual([]);expect(f.calls).toEqual([]);
  }finally{f.close();}
 }
});
it('new type capability downgrade holds an attempted original byte identity without mutation HTTP',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.enqueueOfflineEntryCreate!(draft());f.reconnect();f.loseResponse();await f.api.getSyncCapabilities({replay:false});await f.api.replayOfflineOperations!();
  const original=(await f.store.list())[0]!;const body=f.bodies[0];await f.store.writeMeta('capability.offlineEntryNewType','0');f.calls.length=0;
  await f.api.replayOfflineOperations!();expect(f.calls.filter(call=>call.startsWith('POST'))).toEqual([]);expect(operationFingerprint((await f.store.list())[0]!)).toBe(operationFingerprint(original));expect(f.bodies).toEqual([body]);
 }finally{f.close();}
});
