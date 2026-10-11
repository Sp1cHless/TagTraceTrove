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
  const {createSection,createFacet}=await serverModule('repositories/layout-repository');
  const {assignEntryTag}=await serverModule('repositories/entry-tag-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-layout-template-'));
  try {
  const source=createEntry(db,{title:'Source work',type:'Comic'});
  const peer=createEntry(db,{title:'Peer work',type:'Comic'}),other=createEntry(db,{title:'Other work',type:'Comic'}),film=createEntry(db,{title:'Film work',type:'Film'});
  const section=createSection(db,{entryType:'Comic',name:'Origin'});
  const facet=createFacet(db,{sectionId:section.id,name:'Manga'}),wrong=createFacet(db,{sectionId:section.id,name:'Wrong'});
  assignEntryTag(db,{entryId:source.id,name:'Manga',facetId:facet.id});
  assignEntryTag(db,{entryId:peer.id,name:'Manga',facetId:wrong.id});
  assignEntryTag(db,{entryId:other.id,name:'Manga',facetId:facet.id});
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false,loseReplay=false;
  const calls:string[]=[],bodies:string[]=[];
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);if(disconnected)throw new TypeError('Known offline');
    if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));const response=await app.request(url.pathname+url.search,init);
    if(loseReplay && url.pathname==='/api/sync/replay' && response.ok){loseReplay=false;throw new TypeError('SQL response lost');}return response;
  }}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();let store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const replayState={mode:'online' as 'online'|'offline',lastFallbackAt:null as string|null,lastReplayError:null as string|null};
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'layout-template-phone',randomUUID,state:replayState});
  return {db,root,source,peer,other,film,section,facet,wrong,api,online,calls,bodies,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
    reconnect(){disconnected=false;},loseResponse(){loseReplay=true;},
    get replayState(){return replayState;},cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'layout-template-phone',randomUUID,state:replayState});},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}

it('offline apply-tag-layout moves misplaced peer assignments and settles with durable proof',async()=>{
 const f=await fixture();try{
  await f.offline();
  const result=await f.api.applyEntryTagLayout(f.source.id);
  expect(result.entryType).toBe('Comic');
  expect(f.calls.filter(call=>!call.startsWith('GET '))).toEqual([]);
  const rows=await f.store.list();expect(rows).toHaveLength(1);expect(rows[0]!.operationKind).toBe('entry.tag-layout.apply');
  const cold=f.cold();await cold.preferOfflineSnapshot!();
  const peerDetail=await cold.getEntry(f.peer.id);
  const facetWith=(name:string)=>peerDetail.sections.flatMap(sectionRow=>sectionRow.facets).find(row=>row.name===name)?.tags.length ?? -1;
  expect(facetWith('Manga')).toBe(1);
  expect(facetWith('Wrong')).toBe(0);
  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);
  const peerFacet=f.db.prepare('SELECT g.name FROM entry_tags et JOIN tag_groups g ON g.id=et.facet_id WHERE et.entry_id=? AND et.tag_id=(SELECT tag_id FROM entry_tags WHERE entry_id=? LIMIT 1)').get(f.peer.id,f.peer.id) as {name:string};
  expect(peerFacet.name).toBe('Manga');
  expect(f.db.prepare('SELECT count(*) FROM entry_tags WHERE entry_id=?').pluck().get(f.other.id)).toBe(1);
 }finally{f.close();}
});
it('offline save-as-template rebuilds fresh group identities and relinks by name before deletes',async()=>{
 const f=await fixture();try{
  await f.offline();
  const result=await f.api.applyEntryLayoutTemplate(f.source.id);
  expect(result.sectionsRecreated).toBe(1);
  const rows=await f.store.list();expect(rows).toHaveLength(1);expect(rows[0]!.operationKind).toBe('entry.layout-template.apply');
  const cold=f.cold();await cold.preferOfflineSnapshot!();
  const filters=await cold.listFacetFilterOptions('Comic');
  expect(filters.facets.some(row=>row.facetName==='Manga')).toBe(true);
  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare("SELECT count(*) FROM tag_groups WHERE entry_type='Comic'").pluck().get()).toBe(4);
  const stillTagged=f.db.prepare('SELECT count(*) AS n FROM entry_tags').get() as {n:number};
  expect(stillTagged.n).toBe(3);
  // Save-as-template relinks by facet NAME identity, not placement: the
  // peer's misplaced assignment survives on the rebuilt Wrong facet. Correcting
  // placements is Apply-tag-layout's job.
  const peerFacetName=f.db.prepare(`SELECT g.name FROM entry_tags et JOIN tag_groups g ON g.id=et.facet_id
    WHERE et.entry_id=? AND et.tag_id=(SELECT tag_id FROM entry_tags WHERE entry_id=? LIMIT 1)`).get(f.peer.id,f.peer.id) as {name:string};
  expect(peerFacetName.name).toBe('Wrong');
 }finally{f.close();}
});
it('layout apply conflict after concurrent source edit retains the exact original',async()=>{
 const f=await fixture();try{
  await f.offline();
  await f.api.applyEntryTagLayout(f.source.id);
  f.reconnect();
  const wrongTag=f.db.prepare('SELECT tag_id FROM entry_tags WHERE entry_id=? LIMIT 1').pluck().get(f.peer.id) as number;
  f.db.prepare('UPDATE entry_tags SET facet_id=? WHERE entry_id=? AND tag_id=?').run(f.wrong.id,f.source.id,wrongTag);
  await f.online.applyEntryTagLayout(f.source.id).catch(()=>undefined);
  const cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toHaveLength(1);
 }finally{f.close();}
});
