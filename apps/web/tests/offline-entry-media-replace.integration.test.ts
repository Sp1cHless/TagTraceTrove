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
// A real 1x1 PNG: the media replay renders thumbnails server-side, so the
// fixture bytes must be a decodable image, not just a signed header.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const fileOf = ()=>new File([new Uint8Array(PNG).map(b=>b)],'cover.png',{type:'image/png'});
const serverModule = async(path:string) => {const target=`../../server/src/${path}.js`;return import(/* @vite-ignore */ target);};

async function fixture(){
  const {createMigratedMemoryDatabase}=await serverModule('database/testing');
  const {createEntry}=await serverModule('repositories/entry-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-media-replace-'));
  try {
  const work=createEntry(db,{title:'Covered work',type:'Comic'});
  const bare=createEntry(db,{title:'Bare work',type:'Comic'});
  db.prepare('UPDATE entries SET cover_ref=? WHERE id=?').run('/api/assets/entries/'+work.id+'/cover.webp',work.id);
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false;
  // The settlement's byte-identity check fetches asset refs through the global
  // fetch; in the test shell those are relative, so serve them from the app.
  const realFetch=globalThis.fetch;
  vi.stubGlobal('fetch', async (input:URL|RequestInfo, init?:RequestInit)=>{
    const url=String(input);
    if(/^https?:/u.test(url))return realFetch(input as RequestInfo, init);
    return app.request(url.startsWith('/')?url:'/'+url, init);
  });
  const calls:string[]=[];
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);if(disconnected)throw new TypeError('Known offline');
    return app.request(url.pathname+url.search,init);
  }}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();let store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const replayState={mode:'online' as 'online'|'offline',lastFallbackAt:null as string|null,lastReplayError:null as string|null};
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'media-replace-phone',randomUUID,state:replayState});
  return {db,root,work,bare,api,online,calls,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
    reconnect(){disconnected=false;},
    get replayState(){return replayState;},cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'media-replace-phone',randomUUID,state:replayState});},
    close(){vi.unstubAllGlobals();store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}

it('offline cover replacement of an occupied slot settles through the standard media receipt',async()=>{
 const f=await fixture();try{
  await f.offline();
  const staged=await f.api.uploadEntryMedia(f.work.id,'cover',fileOf()) as unknown as {coverRef:string};
  const rows=await f.store.listMedia();expect(rows).toHaveLength(1);
  expect(rows[0]!.replace).toBe(true);
  expect(rows[0]!.existingEntry?.expectedCoverRef).toBe('/api/assets/entries/'+f.work.id+'/cover.webp');
  f.reconnect();const cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.listMedia()).toEqual([]);
  const coverRef=f.db.prepare('SELECT cover_ref FROM entries WHERE id=?').pluck().get(f.work.id) as string;
  expect(coverRef).toMatch(/cover\.[0-9a-f-]+\.png$/u);
  expect(coverRef).not.toBe('/api/assets/entries/'+f.work.id+'/cover.webp');
  expect(await f.store.list()).toEqual([]);
  void staged;
 }finally{f.close();}
});
it('a cover changed after enqueue refuses the replacement as a visible failed row, not a stuck queue',async()=>{
 const f=await fixture();try{
  await f.offline();
  await f.api.uploadEntryMedia(f.work.id,'cover',fileOf());
  f.reconnect();
  f.db.prepare('UPDATE entries SET cover_ref=? WHERE id=?').run('/api/assets/entries/'+f.work.id+'/cover2.webp',f.work.id);
  const cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  const rows=await f.store.listMedia();expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('failed');
  expect(rows[0]!.lastError).toMatch(/media changed|conflict/i);
 }finally{f.close();}
});
it('a second queued cover while one replacement is pending stays refused',async()=>{
 const f=await fixture();try{
  await f.offline();
  await f.api.uploadEntryMedia(f.work.id,'cover',fileOf());
  await expect(f.api.uploadEntryMedia(f.work.id,'cover',fileOf())).rejects.toThrow('cannot replace an occupied cover or reorder pending media');
  expect(await f.store.listMedia()).toHaveLength(1);
 }finally{f.close();}
});
