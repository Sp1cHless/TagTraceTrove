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
  const {createSection,createFacet}=await serverModule('repositories/layout-repository');
  const {assignEntryTag}=await serverModule('repositories/entry-tag-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-tag-layout-'));
  try {
  const work=createEntry(db,{title:'Tagged work',type:'Comic'}),film=createEntry(db,{title:'Film work',type:'Film'}),recipe=createEntry(db,{title:'Recipe work',type:'Recipes'});
  const author=createProducer(db,{name:'Layout Author'});linkEntryProducer(db,work.id,author.id);
  const section=createSection(db,{entryType:'Comic',name:'Origin'});
  const facet=createFacet(db,{sectionId:section.id,name:'Manga'});
  assignEntryTag(db,{entryId:work.id,name:'Manga',facetId:facet.id});
  createSection(db,{entryType:'Film',name:'Film origin'});
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false,loseReplay=false;
  const calls:string[]=[],bodies:string[]=[];
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);if(disconnected)throw new TypeError('Known offline');
    if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));const response=await app.request(url.pathname+url.search,init);
    if(loseReplay && url.pathname==='/api/sync/replay' && response.ok){loseReplay=false;throw new TypeError('SQL response lost');}return response;
  }}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();let store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const replayState={mode:'online' as 'online'|'offline',lastFallbackAt:null as string|null,lastReplayError:null as string|null};
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'tag-layout-phone',randomUUID,state:replayState});
  return {db,root,work,film,recipe,author,section,facet,api,online,calls,bodies,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
    reconnect(){disconnected=false;},loseResponse(){loseReplay=true;},
    get replayState(){return replayState;},cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'tag-layout-phone',randomUUID,state:replayState});},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}

it('offline tag layout create rename reorder delete settle atomically per type',async()=>{
 const f=await fixture();try{
  await f.offline();
  const created=await f.api.createSection({entryType:'Comic',name:'Style'});
  expect(created.entryType).toBe('Comic');
  await f.api.renameSection(f.section.id,'Origin renamed');
  await f.api.createFacet({sectionId:f.section.id,name:'Anime'});
  await f.api.reorderSectionFacets(f.section.id,[created.defaultFacetId,f.facet.id]);
  const rows=await f.store.list();
  // A creator/observer boundary may require separate layout commands; verify intent, not a fixed count.
  expect(rows.filter(row=>row.operationKind==='entry.facet.create')).toHaveLength(1);
  expect(rows.some(row=>row.operationKind==='entry.tag-layout.set')).toBe(true);
  expect(f.calls.filter(call=>!call.startsWith('GET '))).toEqual([]);
  await expect(f.api.deleteFacet(f.facet.id)).rejects.toThrow('still has tags assigned');
  expect(await f.store.list()).toEqual(rows);
  const cold=f.cold();await cold.preferOfflineSnapshot!();
  const filters=await cold.listFacetFilterOptions('Comic');
  expect(filters.facets.some(row=>row.sectionName==='Style')).toBe(true);
  expect(filters.facets.some(row=>row.facetName==='Anime')).toBe(true);
  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list(),JSON.stringify(f.replayState)).toEqual([]);
  expect(f.db.prepare("SELECT count(*) FROM tag_groups WHERE entry_type='Comic' AND name='Style'").pluck().get()).toBe(1);
  expect(f.db.prepare('SELECT name FROM tag_groups WHERE id=?').pluck().get(f.section.id)).toBe('Origin renamed');
  expect(f.db.prepare("SELECT count(*) FROM tag_groups WHERE entry_type='Comic' AND name='Anime'").pluck().get()).toBe(1);
  expect(f.db.prepare('SELECT sort_order FROM tag_groups WHERE id=?').pluck().get(f.facet.id)).toBe(1);
  await f.api.createSection({entryType:'Comic',name:'After flush'});
  expect(await f.store.list()).toHaveLength(1);
  f.reconnect();await f.api.getSyncCapabilities({replay:false});await f.api.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});
 it('offline entry tag rename replaces the assignment through the existing tags.set machinery',async()=>{
 const f=await fixture();try{
  await f.offline();
  const tagId=f.db.prepare('SELECT tag_id FROM entry_tags WHERE entry_id=?').pluck().get(f.work.id) as number;
  await f.api.renameEntryTag(f.work.id,tagId,'Comic tag');
  const rows=await f.store.list();
  expect(rows.map(row=>row.operationKind)).toEqual(['entry.tag.create','entry.tags.set']);
  const cold=f.cold();await cold.preferOfflineSnapshot!();
  const detail=await cold.getEntry(f.work.id);
  expect(detail.sections.some(sectionRow=>sectionRow.facets.some(row=>row.tags.some(tag=>tag.name==='Comic tag')))).toBe(true);
  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT count(*) FROM entry_tags WHERE entry_id=?').pluck().get(f.work.id)).toBe(1);
 }finally{f.close();}
});
it('a fresh Gallery type creates its first Section offline and the layout row materializes at replay',async()=>{
 const f=await fixture();try{
  await f.offline();
  const created=await f.api.createSection({entryType:'Recipes',name:'Ingredients'});
  expect(created.entryType).toBe('Recipes');
  const rows=await f.store.list();expect(rows).toHaveLength(1);
  expect(rows[0]!.operationKind).toBe('entry.tag-layout.set');
  expect(rows[0]!.baseVersion).toBe(1);
  expect((rows[0]!.payload as {entryType?:string}).entryType).toBe('Recipes');
  const cold=f.cold();await cold.preferOfflineSnapshot!();
  const filters=await cold.listFacetFilterOptions('Recipes');
  expect(filters.facets.some(row=>row.sectionName==='Ingredients')).toBe(true);
  // The rename resolves through the local layout and coalesces into its unsent draft.
  await f.api.renameSection(created.id,'Ingredients renamed');
  expect(await f.store.list()).toHaveLength(1);
  expect((await f.store.list())[0]!.payload.entryType).toBe('Recipes');
  f.reconnect();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list(),JSON.stringify(f.replayState)).toEqual([]);
  expect(f.db.prepare("SELECT count(*) FROM entry_tag_layouts WHERE entry_type='Recipes'").pluck().get()).toBe(1);
  expect(f.db.prepare("SELECT count(*) FROM tag_groups WHERE entry_type='Recipes' AND name='Ingredients renamed'").pluck().get()).toBe(1);
 }finally{f.close();}
});
it('a Facet under a queued Section and tags placed in it chain after the layout original',async()=>{
 const f=await fixture();try{
  await f.offline();
  const section=await f.api.createSection({entryType:'Recipes',name:'Ingredients'});
  await f.api.createFacet({sectionId:section.id,name:'Spices'});
  // The queued Facet's local identity comes from the projected state.
  const detail=await (async()=>{const cold=f.cold();await cold.preferOfflineSnapshot!();return cold.getEntry(f.recipe.id)})();
  const facetId=detail.sections.flatMap(s=>s.facets).find(row=>row.name==='Spices')!.id;
  expect(facetId).toBeLessThan(0);
  await f.api.assignEntryTag(f.recipe.id,{name:'Chili',facetId});
  const {localCollectionId}=await import('../src/offline/offline-api.js');
  const uid=randomUUID();
  const localId=localCollectionId(uid);
  await f.api.enqueueOfflineEntryCreate!({title:'Queued recipe',type:'Recipes',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null,previewFiles:[],syncUid:uid});
  await f.api.assignEntryTag(localId,{name:'Chili',facetId});
  const rows=await f.store.list();
  expect(rows.map(row=>row.operationKind)).toEqual(['entry.tag-layout.set','entry.facet.create','entry.tag.create','entry.tags.set','entry.create','entry.tags.set']);
  const cold2=f.cold();await cold2.preferOfflineSnapshot!();
  f.reconnect();await cold2.getSyncCapabilities({replay:false});await cold2.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare("SELECT count(*) FROM tag_groups WHERE entry_type='Recipes' AND name='Spices'").pluck().get()).toBe(1);
  const facetIdDb=f.db.prepare("SELECT id FROM tag_groups WHERE name='Spices'").pluck().get() as number;
  expect(f.db.prepare('SELECT count(*) FROM entry_tags WHERE facet_id=?').pluck().get(facetIdDb)).toBe(2);
 }finally{f.close();}
});
it('layout conflict after a concurrent online edit retains the exact original',async()=>{
 const f=await fixture();try{
  await f.offline();
  await f.api.renameSection(f.section.id,'Offline name');
  f.reconnect();await f.online.renameSection(f.section.id,'Concurrent name');
  const cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox!();
  expect(await f.store.list()).toHaveLength(1);
  expect(f.db.prepare('SELECT name FROM tag_groups WHERE id=?').pluck().get(f.section.id)).toBe('Concurrent name');
 }finally{f.close();}
});
