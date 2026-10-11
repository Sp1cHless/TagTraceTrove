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
  const {assignEntryTag}=await serverModule('repositories/entry-tag-repository');
  const {createSection,createFacet}=await serverModule('repositories/layout-repository');
  const {createEntryContent}=await serverModule('repositories/entry-content-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-entry-merge-'));
  try {
  const keep=createEntry(db,{title:'Kept work',type:'Comic'}),absorb=createEntry(db,{title:'Absorbed work',type:'Comic'}),film=createEntry(db,{title:'Film work',type:'Film'});
  const section=createSection(db,{entryType:'Comic',name:'Tags'}),facet=createFacet(db,{sectionId:section.id,name:'Theme'});
  const author=createProducer(db,{name:'Merging Author'});linkEntryProducer(db,keep.id,author.id);linkEntryProducer(db,absorb.id,author.id);
  assignEntryTag(db,{entryId:absorb.id,name:'Copied Tag',facetId:facet.id});
  createEntryContent(db,{entryId:absorb.id,contentType:'Source URL',content:'https://example.org/absorbed-source',sortOrder:0});
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
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'entry-merge-phone',randomUUID,state:replayState});
  return {db,root,keep,absorb,film,author,api,online,calls,bodies,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
    reconnect(){disconnected=false;},loseResponse(){loseReplay=true;},loseAcknowledgement(){loseAck=true;},
    get replayState(){return replayState;},cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'entry-merge-phone',randomUUID,state:replayState});},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}

it('saved-copy merge enqueues one atomic original, projects reads and settles with durable proof',async()=>{
 const f=await fixture();try{
  await f.offline();
  const sources=await f.api.listEntrySources(f.absorb.id);
  expect(sources.map(row=>row.url)).toEqual(['https://example.org/absorbed-source']);
  const result=await f.api.mergeAuthorEntries({authorId:f.author.id,keepEntryId:f.keep.id,absorbEntryId:f.absorb.id,copyTags:true,title:'Merged title',sourceUrls:['https://example.org/absorbed-source']});
  expect(result.keptEntryId).toBe(f.keep.id);expect(result.copiedSourceCount).toBe(1);
  const rows=await f.store.list();expect(rows).toHaveLength(1);expect(rows[0]!.operationKind).toBe('entry.merge');
  expect(f.calls.filter(call=>!call.startsWith('GET '))).toEqual([]);
  const cold=f.cold();await cold.preferOfflineSnapshot!();
  await expect(cold.getEntry(f.absorb.id)).rejects.toThrow();
  expect((await cold.getEntry(f.keep.id)).title).toBe('Merged title');
  expect((await cold.listEntrySources(f.keep.id)).map(row=>row.url)).toEqual(['https://example.org/absorbed-source']);
  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.absorb.id)).toBe(0);
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.keep.id)).toBe('Merged title');
  expect(f.db.prepare("SELECT count(*) FROM entry_contents WHERE entry_id=? AND content_type='Source URL' AND content='https://example.org/absorbed-source'").pluck().get(f.keep.id)).toBe(1);
  expect(f.db.prepare('SELECT count(*) FROM entry_tags WHERE entry_id=?').pluck().get(f.keep.id)).toBe(1);
 }finally{f.close();}
});
it('merge survives SQL response and ACK loss through cold exact-body retries',async()=>{
 const f=await fixture();try{
  await f.offline();
  await f.api.mergeAuthorEntries({authorId:f.author.id,keepEntryId:f.keep.id,absorbEntryId:f.absorb.id,copyTags:false,title:'Uncertain title',sourceUrls:[]});
  expect(await f.store.list()).toHaveLength(1);
  f.reconnect();await f.api.getSyncCapabilities({replay:false});f.loseResponse();
  await f.api.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);const body=f.bodies[0];
  f.loseAcknowledgement();
  const cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toHaveLength(1);
  const retry=f.cold();await retry.getSyncCapabilities({replay:false});await retry.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);
  expect(f.bodies.every(row=>row===body)).toBe(true);
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.absorb.id)).toBe(0);
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.keep.id)).toBe('Uncertain title');
 }finally{f.close();}
});
it('queued merge holds both owners and refuses to stack on queued owner work',async()=>{
 const f=await fixture();try{
  await f.offline();
  await f.api.mergeAuthorEntries({authorId:f.author.id,keepEntryId:f.keep.id,absorbEntryId:f.absorb.id,copyTags:true,sourceUrls:[]});
  await expect(f.api.updateEntry(f.keep.id,{title:'Too late'})).rejects.toThrow('atomic Entry merge');
  await expect(f.api.mergeAuthorEntries({authorId:f.author.id,keepEntryId:f.film.id,absorbEntryId:f.keep.id,copyTags:true,sourceUrls:[]})).rejects.toThrow();
  expect(await f.store.list()).toHaveLength(1);
 }finally{f.close();}
});
it('merge and independent originals export, restore atomically and settle in order',async()=>{
 const f=await fixture();try{
  await f.offline();
  await f.api.updateEntry(f.film.id,{title:'Independent film'});
  await f.api.mergeAuthorEntries({authorId:f.author.id,keepEntryId:f.keep.id,absorbEntryId:f.absorb.id,copyTags:true,title:'Restored merge',sourceUrls:['https://example.org/absorbed-source']});
  const originals=await f.store.list();expect(originals).toHaveLength(2);
  const {buildPendingWorkExport}=await import('../src/offline/pending-work-export.js');
  const text=JSON.stringify(await buildPendingWorkExport(f.store));
  for(const row of originals)await f.store.remove(row.opId);
  const cold=f.cold();await cold.previewPendingWorkRestore!(text);await cold.restorePendingWork!(text);
  expect(await f.store.list()).toEqual(originals);
  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.absorb.id)).toBe(0);
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.keep.id)).toBe('Restored merge');
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.film.id)).toBe('Independent film');
 }finally{f.close();}
});
