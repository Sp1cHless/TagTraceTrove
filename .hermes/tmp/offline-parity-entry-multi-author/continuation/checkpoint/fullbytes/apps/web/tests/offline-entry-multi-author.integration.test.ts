import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { mount, flushPromises } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const window = new JSDOM('<!doctype html><html><body></body></html>', {url:'http://isolated/'}).window;
  for (const key of ['window','document','Element','HTMLElement','SVGElement','Node','localStorage','sessionStorage','MutationObserver','navigator','getComputedStyle'])
    Object.defineProperty(globalThis,key,{value:key === 'window' ? window : window[key as keyof typeof window],configurable:true});
  Object.defineProperty(globalThis,'addEventListener',{value:window.addEventListener.bind(window),configurable:true});
  Object.defineProperty(globalThis,'removeEventListener',{value:window.removeEventListener.bind(window),configurable:true});
});
import GalleryApp from '../src/GalleryApp.vue';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { setLocale } from '../src/i18n.js';
const serverModule = async(path:string) => {const target=`../../server/src/${path}.js`;return import(/* @vite-ignore */ target);};
const settle=async()=>{for(let i=0;i<15;i++){await flushPromises();await new Promise(resolve=>setTimeout(resolve,5));}};
async function fixture(){
  const {createMigratedMemoryDatabase}=await serverModule('database/testing');
  const {createEntry}=await serverModule('repositories/entry-repository');
  const {createProducer,linkEntryProducer}=await serverModule('repositories/producer-repository');
  const {createEntryRatingSlot,createProducerRatingSlot,setEntryRating,setProducerRating}=await serverModule('repositories/rating-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-entry-multi-author-'));
  const work=createEntry(db,{title:'Rated work',type:'Comic'}),peer=createEntry(db,{title:'Rated peer',type:'Comic'}),other=createEntry(db,{title:'Other type',type:'Film'});
  const author=createProducer(db,{name:'Preserved Author'}),contributor=createProducer(db,{name:'Single-work Contributor'});linkEntryProducer(db,work.id,author.id);linkEntryProducer(db,work.id,contributor.id);linkEntryProducer(db,peer.id,author.id);
  const slot=createEntryRatingSlot(db,{entryId:work.id,name:'Quality'}),keep=createEntryRatingSlot(db,{entryId:work.id,name:'Keep'}),foreign=createEntryRatingSlot(db,{entryId:other.id,name:'Quality'});
  const summary=createProducerRatingSlot(db,{producerId:author.id,name:'Quality'}),self=createProducerRatingSlot(db,{producerId:author.id,name:'Quality',kind:'author_self'});
  for(const entry of [work,peer])setEntryRating(db,{entryId:entry.id,slotId:slot.id,stars:4});
  setEntryRating(db,{entryId:other.id,slotId:foreign.id,stars:3});setProducerRating(db,{producerId:author.id,slotId:summary.id,stars:3.5});setProducerRating(db,{producerId:author.id,slotId:self.id,stars:5});
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false,loseReplay=false,loseAck=false;
  const calls:string[]=[],bodies:string[]=[];
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);if(disconnected)throw new TypeError('Known offline');
    if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));const response=await app.request(url.pathname+url.search,init);
    if(loseReplay && url.pathname==='/api/sync/replay' && response.ok){loseReplay=false;throw new TypeError('SQL response lost');}
    if(loseAck && url.pathname.includes('/ack') && response.ok){loseAck=false;throw new TypeError('ACK response lost');}return response;
  }}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();let store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'entry-multi-author-phone',randomUUID});
  return {db,root,work,peer,other,author,contributor,slot,keep,foreign,summary,self,api,online,calls,bodies,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
    async deleteMeta(key:string){const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(databaseName);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}finally{db.close();}},
    reconnect(){disconnected=false;},loseResponse(){loseReplay=true;},loseAcknowledgement(){loseAck=true;},
    cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'entry-multi-author-phone',randomUUID});},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
}
it('ordinary saved-copy conversion seals one durable atomic original before any business HTTP',async()=>{
 const f=await fixture();let wrapper:ReturnType<typeof mount>|undefined;
 try{
  setLocale('en');vi.stubGlobal('scrollTo',vi.fn());await f.offline();
  wrapper=mount(GalleryApp,{props:{api:f.api,offlineStore:f.store}});
  await settle();await wrapper.get('[data-gallery-type="Comic"]').trigger('click');await settle();
  const card=wrapper.findAll('button').find(row=>row.text().includes('Rated work'));expect(card).toBeDefined();await card!.trigger('click');await settle();
  await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');await settle();
  await wrapper.get('[data-testid="convert-multi-author"]').trigger('click');await settle();
  expect(await f.store.list()).toHaveLength(1);
  expect(f.calls.filter(call=>!call.startsWith('GET '))).toEqual([]);
 }finally{wrapper?.unmount();f.close();vi.unstubAllGlobals();}
});
it('canonical Online conversion prunes only unlinked workless contributors and retains other-work Authors',async()=>{
 const f=await fixture();try{
  const result=await f.online.convertEntryAuthors(f.work.id);expect(result.convertedAuthors).toHaveLength(2);
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.contributor.id)).toBe(0);
  expect(f.db.prepare('SELECT entry_id FROM entry_producers WHERE producer_id=?').pluck().all(f.author.id)).toEqual([f.peer.id]);
 }finally{f.close();}
});
