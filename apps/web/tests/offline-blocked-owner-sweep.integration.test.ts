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
  const {createEntryRatingSlot}=await serverModule('repositories/rating-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-blocked-sweep-'));
  try {
  const keep=createEntry(db,{title:'Keep',type:'Comic'}),absorb=createEntry(db,{title:'Absorb',type:'Comic'}),other=createEntry(db,{title:'Other',type:'Comic'});
  const a1=createProducer(db,{name:'Author One'}),a2=createProducer(db,{name:'Author Two'});
  for(const entry of [keep,absorb,other]) linkEntryProducer(db,entry.id,a1.id);
  linkEntryProducer(db,keep.id,a2.id);
  const section=createSection(db,{entryType:'Comic',name:'Origin'});
  const facet=createFacet(db,{sectionId:section.id,name:'Manga'});
  createEntryRatingSlot(db,{entryId:keep.id,name:'Quality'});
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false;
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    if(disconnected)throw new TypeError('Known offline');
    return app.request(new URL(String(input)).pathname+new URL(String(input)).search,init);}}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID(),store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const replayState={mode:'online' as 'online'|'offline',lastFallbackAt:null as string|null,lastReplayError:null as string|null};
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'blocked-sweep-phone',randomUUID,state:replayState});
  await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));
  await store.writeMeta('activeGeneration','1');
  await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;
  return {db,api,keep,absorb,other,a1,a2,facet,get store(){return store;},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}};
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}

/**
 * The gestures a person expects to work offline on any live work. Each returns
 * either 'ok' or the refusal message, so a caller can assert the whole set.
 */
async function basics(api: Awaited<ReturnType<typeof fixture>>['api'], entryId: number, facetId: number): Promise<Record<string,string>> {
  const out: Record<string,string> = {};
  const run = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); out[label] = 'ok'; } catch (cause) { out[label] = cause instanceof Error ? cause.message : String(cause); }
  };
  await run('updateEntry', () => api.updateEntry(entryId,{title:'Renamed'}));
  await run('assignEntryTag', () => api.assignEntryTag(entryId,{name:'Manga',facetId}));
  const assigned = (await api.getEntry(entryId).catch(() => undefined))?.sections
    .flatMap(s=>s.facets).flatMap(r=>r.tags)[0];
  if (assigned !== undefined) {
    await run('renameEntryTag', () => api.renameEntryTag(entryId,assigned.id,'Manga x'));
    const renamed = (await api.getEntry(entryId).catch(() => undefined))?.sections
      .flatMap(s=>s.facets).flatMap(r=>r.tags).find(row=>row.name==='Manga x');
    if (renamed !== undefined) await run('removeEntryTag', () => api.removeEntryTag(entryId,renamed.id));
  }
  const slotId = (await api.getEntry(entryId).catch(() => undefined))?.ratings[0]?.slotId;
  if (slotId !== undefined) await run('setEntryRating', () => api.setEntryRating(entryId,slotId,4));
  await run('createEntryContent', () => api.createEntryContent(entryId,{contentType:'note',content:'body'}));
  await run('addViewLaterEntry', () => api.addViewLaterEntry(entryId));
  await run('likeEntry', () => api.likeEntry(entryId));
  return out;
}

const ALL_OK = {
  updateEntry:'ok', assignEntryTag:'ok', renameEntryTag:'ok', removeEntryTag:'ok',
  setEntryRating:'ok', createEntryContent:'ok', addViewLaterEntry:'ok', likeEntry:'ok',
};

it('every basic gesture works on the kept work of a queued merge', async () => {
  const f = await fixture(); try {
    await f.api.mergeAuthorEntries({authorId:f.a1.id,keepEntryId:f.keep.id,absorbEntryId:f.absorb.id,copyTags:true,sourceUrls:[]});
    expect(await basics(f.api,f.keep.id,f.facet.id)).toEqual(ALL_OK);
  } finally { f.close(); }
});

it('every basic gesture works on the work being converted to multiple authors', async () => {
  const f = await fixture(); try {
    await f.api.convertEntryAuthors(f.keep.id);
    expect(await basics(f.api,f.keep.id,f.facet.id)).toEqual(ALL_OK);
    expect(await basics(f.api,f.other.id,f.facet.id)).toEqual(ALL_OK);
  } finally { f.close(); }
});

it('every basic gesture works while a linked Author is queued for deletion', async () => {
  const f = await fixture(); try {
    await f.api.deleteAuthor(f.a1.id);
    expect(await basics(f.api,f.keep.id,f.facet.id)).toEqual(ALL_OK);
  } finally { f.close(); }
});

it('refuses every basic gesture on a work a queued merge or delete removes, with a reason', async () => {
  const f = await fixture(); try {
    await f.api.mergeAuthorEntries({authorId:f.a1.id,keepEntryId:f.keep.id,absorbEntryId:f.absorb.id,copyTags:true,sourceUrls:[]});
    for (const [label,message] of Object.entries(await basics(f.api,f.absorb.id,f.facet.id))) {
      expect(message,label).not.toBe('ok');
    }
  } finally { f.close(); }
  const g = await fixture(); try {
    await g.api.deleteEntry(g.keep.id);
    for (const [label,message] of Object.entries(await basics(g.api,g.keep.id,g.facet.id))) {
      expect(message,label).not.toBe('ok');
    }
  } finally { g.close(); }
});
