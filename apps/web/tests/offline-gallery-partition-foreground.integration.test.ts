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


import { mount, flushPromises } from '@vue/test-utils';
import GalleryApp from '../src/GalleryApp.vue';
import { setLocale } from '../src/i18n.js';
import { showNsfw } from '../src/stores/preferences.js';



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


it('connected no-copy serial different desired values survives cold response loss with bounded own journal and retained originals',async()=>{
 const f=await fixture();try{
  f.loseResponse();await f.api.setGalleryPartition('Comic',true);
  const first=(await f.store.list())[0]!;const fingerprint=operationFingerprint(first);const raw=f.bodies[0];
  const cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.setGalleryPartition('Comic',false);
  const rows=await f.store.list();expect(rows).toHaveLength(2);expect(rows.map(row=>row.baseVersion)).toEqual([1,2]);
  expect(operationFingerprint(rows[0]!)).toBe(fingerprint);expect(f.bodies[1]).toBe(raw);
  expect(f.db.prepare('SELECT nsfw FROM gallery_settings WHERE entry_type=?').pluck().get('Comic')).toBe(0);
  await cold.setGalleryPartition('Comic',true);expect(await f.store.list()).toHaveLength(3);
  expect((await f.store.list()).map(row=>row.baseVersion)).toEqual([1,2,3]);
  expect(f.calls.some(call=>call.includes('/snapshot') || call.includes('/assets') || call.startsWith('PUT') || call.includes('/ack'))).toBe(false);
  expect(f.calls.filter(call=>call.includes('/partition-context')).length).toBeGreaterThan(2);expect(await f.store.readMeta('activeGeneration')).toBeNull();
 }finally{f.close();}
});

it('foreign bounded predecessor proofs and changed current owners never authorize a connected successor',async()=>{
 for(const field of ['opId','entityUid','resourceVersion','serverSeq','entryType','nsfw','libraryId','syncEpoch','syncVersion']){
  const f=await fixture();try{
   await f.api.setGalleryPartition('Comic',true);const original=(await f.store.list())[0]!;
   f.tamperResponse(async(path,response)=>{if(!path.endsWith('/partition-context'))return response;const data=await response.json();if(data.predecessor){if(field==='libraryId'||field==='syncEpoch')data[field]='foreign';else if(field==='syncVersion')data[field]+=1;else data.predecessor[field]=field==='nsfw'?false:field==='resourceVersion'||field==='serverSeq'?data.predecessor[field]+1:field==='opId'||field==='entityUid'?randomUUID():'Other';}return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});});
   await expect(f.api.setGalleryPartition('Comic',false)).rejects.toThrow();expect(await f.store.list()).toHaveLength(1);expect(operationFingerprint((await f.store.list())[0]!)).toBe(operationFingerprint(original));
  }finally{f.close();}
 }
});
it('uncertain or conflicted sameowner connected predecessor cannot stage across a failed original',async()=>{
 const f=await fixture();try{
  f.loseResponse();await f.api.setGalleryPartition('Comic',true);f.loseResponse();await expect(f.api.setGalleryPartition('Comic',false)).rejects.toThrow('unsettled');expect(await f.store.list()).toHaveLength(1);
  await f.store.update((await f.store.list())[0]!.opId,{status:'conflict'});await expect(f.api.setGalleryPartition('Comic',false)).rejects.toThrow('Retain queued');expect(await f.store.list()).toHaveLength(1);
 }finally{f.close();}
});
it('held creator and conflict partition block own successors while independent partition and Entry owner advance global off holds all',async()=>{
 for(const globalOff of [false,true]){
  const f=await fixture();try{
   await f.offline();await f.api.enqueueOfflineEntryCreate!({title:'Held',type:'Held Type',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});await f.api.setGalleryPartition('Held Type',true);
   await f.api.setGalleryPartition('Comic',true);
   // The first toggle must be an immutable original to model a conflicted predecessor.
   await f.store.captureLocalFinalState(true);
   await f.api.setGalleryPartition('Comic',false);await f.api.setGalleryPartition('Unstructured',true);await f.api.updateEntry(f.work.id,{title:'Independent Entry'});
   const rows=await f.store.list();await f.store.update(rows[0]!.opId,{status:'conflict'});await f.store.update(rows[2]!.opId,{status:'conflict'});const fingerprints=rows.map(operationFingerprint);
   f.reconnect();await f.api.getSyncCapabilities({replay:false});if(globalOff)await f.store.writeMeta('capability.offlineMutations','0');await f.api.replayOfflineOperations!();
   const kinds=f.bodies.map(body=>JSON.parse(body));expect(kinds.map(row=>row.opId)).toEqual(globalOff?[]:[rows[4]!.opId,rows[5]!.opId]);
   expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.work.id)).toBe(globalOff?'Shared work':'Independent Entry');
   const retained=await f.store.list();for(const row of retained)expect(operationFingerprint(row)).toBe(fingerprints[rows.findIndex(original=>original.opId===row.opId)]);
   expect(f.db.prepare('SELECT count(*) FROM entries WHERE type=?').pluck().get('Held Type')).toBe(0);
  }finally{f.close();}
 }
});
it('cold canonical snapshot hides whole Gallery on query search author filter random saved rating Collection members counts covers and Author ANY hideable then restores visible',async()=>{
 const f=await fixture();try{
  f.db.prepare('UPDATE entries SET cover_ref=? WHERE id=?').run('entries/'+f.work.id+'/cover.webp',f.work.id);
  const {linkEntryProducer}=await serverModule('repositories/producer-repository');linkEntryProducer(f.db,f.skipped.id,f.author.id);
  const slot=await f.online.createEntryRatingSlot(f.work.id,'Quality');await f.online.setEntryRating(f.work.id,slot.id,5);await f.online.addViewLaterEntry(f.work.id);
  await f.offline();await f.api.setGalleryPartition('Comic',true);let cold=f.cold();await cold.preferOfflineSnapshot!();
  const base={conditions:[],authorIds:[],ratingConditions:[],ratingSort:null,usageConditions:[],usageSort:null,sort:'title-asc' as const,page:1,pageSize:30,includeNsfw:false};
  for(const extra of [{entryType:'Comic'},{searchQuery:'Shared'},{authorIds:[f.author.id]},{sort:'random' as const,randomSeed:42},{entryIds:[f.work.id]},{entryType:'Comic',ratingConditions:[{slotId:slot.id,operator:'eq' as const,stars:5}]},{collectionId:f.child.id}]){
   const page=await cold.queryEntryPage({...base,...extra});expect(page.items.some(row=>row.type==='Comic')).toBe(false);expect(page.total).toBe(page.items.length);
  }
  const authors=await cold.queryProducerPage({ownTagIds:[],relatedEntryTagIds:[],page:1,pageSize:30,sort:'name-asc',includeNsfw:false});expect(authors.items).toEqual([]);expect((await cold.listAuthors())[0]?.nsfw).toBe(true);
  const tree=await cold.listCollections('entry',false);const shelf=tree.find(row=>row.id===f.parent.id)!;expect(shelf.entryCount).toBe(1);expect(shelf.entries.some(row=>row.type==='Comic')).toBe(false);expect(JSON.stringify(shelf)).not.toContain('cover.webp');
  expect((await cold.getViewLaterState()).entryIds).toContain(f.work.id);expect(f.calls).toEqual([]);
  await cold.setGalleryPartition('Comic',false);cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.queryEntryPage({...base,entryType:'Comic'})).total).toBe(2);for(const extra of [{searchQuery:'Shared'},{authorIds:[f.author.id]},{sort:'random' as const,randomSeed:42},{entryIds:[f.work.id]},{entryType:'Comic',ratingConditions:[{slotId:slot.id,operator:'eq' as const,stars:5}]},{collectionId:f.child.id}])expect((await cold.queryEntryPage({...base,...extra})).items.some(row=>row.type==='Comic')).toBe(true);expect((await cold.queryProducerPage({ownTagIds:[],relatedEntryTagIds:[],page:1,pageSize:30,sort:'name-asc',includeNsfw:false})).total).toBe(1);expect((await cold.listCollections('entry',false)).find(row=>row.id===f.parent.id)?.entryCount).toBe(2);expect(f.calls).toEqual([]);
 }finally{f.close();}
});
const settle=async()=>{for(let i=0;i<15;i++){await flushPromises();await new Promise(resolve=>setTimeout(resolve,5));}};
it('ordinary GalleryApp partition callback clears hidden active selection and excludes older inflight Gallery result after refresh',async()=>{
 const f=await fixture();setLocale('en');showNsfw.value=false;vi.stubGlobal('scrollTo',vi.fn());await f.offline();
 let release:((value:Awaited<ReturnType<typeof f.api.queryEntryPage>>)=>void)|undefined;let delayed=false;
 const api={...f.api,queryEntryPage:async(input:Parameters<typeof f.api.queryEntryPage>[0])=>{const value=await f.api.queryEntryPage(input);if(delayed&&input.entryType==='Comic')return new Promise<typeof value>(resolve=>{release=()=>resolve(value);});return value;}};
 const wrapper=mount(GalleryApp,{props:{api,offlineStore:f.store,offlineState:{mode:'offline'} as never}});try{
  await settle();await wrapper.findAll('button').find(row=>row.text().includes('Comic'))!.trigger('click');await settle();expect(wrapper.text()).toContain('Shared work');
  delayed=true;await wrapper.get('[data-testid="gallery-sort"]').setValue('title-desc');await settle();expect(release).toBeDefined();
  await wrapper.get('[data-testid="gallery-partition-toggle"]').trigger('click');await settle();expect(await f.store.list()).toHaveLength(1);release!(undefined as never);await settle();
  expect(wrapper.find('[data-testid="active-gallery-title"]').exists()).toBe(false);expect(wrapper.find('[data-entry-id="'+f.work.id+'"]').exists()).toBe(false);expect(wrapper.text()).not.toContain('Shared work');expect(f.calls).toEqual([]);
 }finally{wrapper.unmount();f.close();vi.unstubAllGlobals();}
});
