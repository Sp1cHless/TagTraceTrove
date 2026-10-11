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
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-entry-multi-author-fg-'));
  try {
  const work=createEntry(db,{title:'Shared work',type:'Comic'}),peer=createEntry(db,{title:'Peer work',type:'Comic'});
  const author=createProducer(db,{name:'Preserved Author'}),solo=createProducer(db,{name:'Solo Contributor'});
  linkEntryProducer(db,work.id,author.id);linkEntryProducer(db,peer.id,author.id);linkEntryProducer(db,work.id,solo.id);
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false;
  const calls:string[]=[];
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);if(disconnected)throw new TypeError('Known offline');
    return app.request(url.pathname+url.search,init);
  }}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();const store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'entry-multi-author-foreground-phone',randomUUID});
  return {db,root,work,peer,author,api,online,calls,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}
it('ordinary GalleryApp conversion drops the older inflight Gallery result and refreshes cached list and author options',async()=>{
 const f=await fixture();let wrapper:ReturnType<typeof mount>|undefined;
 try{
  setLocale('en');vi.stubGlobal('scrollTo',vi.fn());await f.offline();
  let delayed=false;
  let release:((value:Awaited<ReturnType<typeof f.api.queryEntryPage>>)=>void)|undefined;
  let filterOptionLoads=0;
  const api={...f.api,
    queryEntryPage:async(input:Parameters<typeof f.api.queryEntryPage>[0])=>{
      const value=await f.api.queryEntryPage(input);
      if(delayed&&input.entryType==='Comic'){delayed=false;return new Promise<typeof value>(resolve=>{release=(resolved)=>resolve({...resolved,items:[...resolved.items,resolved.items[0]!]});});}
      return value;
    },
    listFacetFilterOptions:async(input:Parameters<typeof f.api.listFacetFilterOptions>[0])=>{filterOptionLoads+=1;return f.api.listFacetFilterOptions(input);},
  };
  wrapper=mount(GalleryApp,{props:{api,offlineStore:f.store,offlineState:{mode:'offline'} as never}});
  await settle();await wrapper.get('[data-gallery-type="Comic"]').trigger('click');await settle();
  expect(wrapper.findAll('[data-entry-id="'+f.work.id+'"]')).toHaveLength(1);
  expect(filterOptionLoads).toBe(1);
  delayed=true;await wrapper.get('[data-testid="gallery-sort"]').setValue('title-desc');await settle();expect(release).toBeDefined();
  const card=wrapper.findAll('button').find(row=>row.text().includes('Shared work'))!;expect(card).toBeDefined();await card.trigger('click');await settle();
  await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');await settle();
  await wrapper.get('[data-testid="convert-multi-author"]').trigger('click');await settle();
  expect(await f.store.list()).toHaveLength(1);
  expect(f.calls.filter(call=>!call.startsWith('GET '))).toEqual([]);
  expect(filterOptionLoads).toBe(2);
  await wrapper.get('[data-testid="entry-back"]').trigger('click');await settle();
  expect(wrapper.findAll('[data-entry-id="'+f.work.id+'"]')).toHaveLength(1);
  release!(await f.api.queryEntryPage({conditions:[],authorIds:[],ratingConditions:[],ratingSort:null,usageConditions:[],usageSort:null,sort:'title-asc',page:1,pageSize:30,includeNsfw:false,entryType:'Comic'}));
  await settle();
  expect(wrapper.findAll('[data-entry-id="'+f.work.id+'"]')).toHaveLength(1);
 }finally{wrapper?.unmount();f.close();vi.unstubAllGlobals();}
});
