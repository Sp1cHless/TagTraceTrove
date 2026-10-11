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
import { localCollectionId } from '../src/offline/offline-api.js';
const serverModule = async(path:string) => {const target=`../../server/src/${path}.js`;return import(/* @vite-ignore */ target);};

async function fixture(){
  const {createMigratedMemoryDatabase}=await serverModule('database/testing');
  const {createEntry}=await serverModule('repositories/entry-repository');
  const {createSection,createFacet}=await serverModule('repositories/layout-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-create-edit-'));
  try {
  const existing=createEntry(db,{title:'Existing work',type:'Comic'});
  const section=createSection(db,{entryType:'Comic',name:'Origin'});
  const facet=createFacet(db,{sectionId:section.id,name:'Manga'});
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false,loseReplay=false;
  const calls:string[]=[],bodies:string[]=[];
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);if(disconnected)throw new TypeError('Known offline');
    if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));const response=await app.request(url.pathname+url.search,init);
    if(loseReplay && url.pathname==='/api/sync/replay' && response.ok){loseReplay=false;throw new TypeError('SQL response lost');}return response;
  }}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();let store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const replayState={mode:'online' as 'online'|'offline',lastFallbackAt:null as string|null,lastReplayError:null as string|null};
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'create-edit-phone',randomUUID,state:replayState});
  return {db,root,existing,section,facet,api,online,calls,bodies,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
    reconnect(){disconnected=false;},loseResponse(){loseReplay=true;},
    get replayState(){return replayState;},cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'create-edit-phone',randomUUID,state:replayState});},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}

it('offline create-then-edit queues pending metadata and tag edits under the parent create and settles in order',async()=>{
 const f=await fixture();try{
  await f.offline();
  const uid=randomUUID();
  const localId=localCollectionId(uid);
  const queued=await f.api.enqueueOfflineEntryCreate!({title:'Queued work',type:'Comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null,previewFiles:[],syncUid:uid});
  expect(queued.localKey).toBe('local:'+uid);
  const dto=await f.api.updateEntry(localId,{title:'Edited offline'});
  expect(dto.title).toBe('Edited offline');
  await f.api.assignEntryTag(localId,{name:'Manga',facetId:f.facet.id});
  const rows=await f.store.list();
  expect(rows.map(row=>row.operationKind)).toEqual(['entry.create','entry.update','entry.tag.create','entry.tags.set']);
  expect(rows.every(row=>row.payload.parentCreateOpId===undefined||row.payload.parentCreateOpId===rows[0]!.opId)).toBe(true);
  const cold=f.cold();await cold.preferOfflineSnapshot!();
  expect((await cold.getEntry(localId)).title).toBe('Edited offline');
  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT title FROM entries WHERE sync_uid=?').pluck().get(uid)).toBe('Edited offline');
  expect(f.db.prepare('SELECT count(*) FROM entry_tags WHERE entry_id=(SELECT id FROM entries WHERE sync_uid=?)').pluck().get(uid)).toBe(1);
 }finally{f.close();}
});
