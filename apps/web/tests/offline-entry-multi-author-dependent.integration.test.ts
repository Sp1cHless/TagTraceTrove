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
  const {createCollection}=await serverModule('repositories/collection-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-entry-multi-author-dep-'));
  try {
  const work=createEntry(db,{title:'Converted work',type:'Comic'}),peer=createEntry(db,{title:'Peer work',type:'Comic'});
  const author=createProducer(db,{name:'Preserved Author'}),solo=createProducer(db,{name:'Solo Contributor'});
  linkEntryProducer(db,work.id,author.id);linkEntryProducer(db,work.id,solo.id);
  const collection=createCollection(db,{kind:'producer',title:'Author shelf'});
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false;
  const calls:string[]=[],bodies:string[]=[];
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);if(disconnected)throw new TypeError('Known offline');
    if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));return app.request(url.pathname+url.search,init);
  }}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();let store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const replayState={mode:'online' as 'online'|'offline',lastFallbackAt:null as string|null,lastReplayError:null as string|null};
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'entry-multi-author-dependent-phone',randomUUID,state:replayState});
  return {db,root,work,peer,author,solo,collection,api,online,calls,bodies,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
    reconnect(){disconnected=false;},
    get replayState(){return replayState;},cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'entry-multi-author-dependent-phone',randomUUID,state:replayState});},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}

it('pending conversion-created target author accepts later offline link and collection continuations and settles in order',async()=>{
 const f=await fixture();try{
  await f.offline();
  const dto=await f.api.convertEntryAuthors(f.work.id);
  expect(dto.convertedAuthors).toHaveLength(2);
  await f.api.linkEntryAuthor(f.peer.id,dto.multiAuthorId);
  await f.api.addCollectionProducer(f.collection.id,dto.multiAuthorId);
  const rows=await f.store.list();
  expect(rows.map(row=>row.operationKind)).toEqual(['entry.authors.convert-to-multi','entry.authors.set','collection.producer.set']);
  f.reconnect();await f.api.getSyncCapabilities({replay:false});await f.api.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);
  const targetId=f.db.prepare('SELECT id FROM producers WHERE name=? COLLATE NOCASE').pluck().get('multiple author') as number;
  expect(f.db.prepare('SELECT producer_id FROM entry_producers WHERE entry_id=? ORDER BY producer_id').all(f.peer.id).map((row:{producer_id:number})=>row.producer_id)).toEqual([targetId]);
  expect(f.db.prepare('SELECT producer_id FROM collection_producers WHERE collection_id=?').pluck().all(f.collection.id)).toEqual([targetId]);
  expect(f.db.prepare('SELECT producer_id FROM entry_producers WHERE entry_id=? ORDER BY producer_id').all(f.work.id).map((row:{producer_id:number})=>row.producer_id)).toEqual([targetId]);
 }finally{f.close();}
});
