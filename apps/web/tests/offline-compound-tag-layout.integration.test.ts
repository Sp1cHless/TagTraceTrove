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
import { createGalleryApi, type GalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi, localCollectionId } from '../src/offline/offline-api.js';
import { operationFingerprint } from '../src/offline/outbox-store.js';
import { mutationQueuePlan } from '../src/offline/sync-mutation-plan.js';
const serverModule = async(path:string) => {const target=`../../server/src/${path}.js`;return import(/* @vite-ignore */ target);};

async function fixture() {
  const {createMigratedMemoryDatabase}=await serverModule('database/testing');
  const {createEntry}=await serverModule('repositories/entry-repository');
  const {createSection,createFacet}=await serverModule('repositories/layout-repository');
  const {assignEntryTag}=await serverModule('repositories/entry-tag-repository');
  const {createEntryRatingSlot}=await serverModule('repositories/rating-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-compound-layout-'));
  try {
    const sourceUid=randomUUID(),peerUid=randomUUID();
    const source={...createEntry(db,{title:'Source',type:'Comic',syncUid:sourceUid}),syncUid:sourceUid};
    const peer={...createEntry(db,{title:'Peer',type:'Comic',syncUid:peerUid}),syncUid:peerUid};
    const film=createEntry(db,{title:'Other type',type:'Film'});
    const section=createSection(db,{entryType:'Comic',name:'Origin'});
    const facet=createFacet(db,{sectionId:section.id,name:'Manga'}),wrong=createFacet(db,{sectionId:section.id,name:'Wrong'});
    assignEntryTag(db,{entryId:source.id,name:'Shared',facetId:facet.id});
    assignEntryTag(db,{entryId:peer.id,name:'Shared',facetId:wrong.id});
    createEntryRatingSlot(db,{entryId:source.id,name:'Quality'});
    const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});
    let disconnected=false,loseReplay=false,loseAck=false,expiredBaseline=false,changeBeforeRefresh:(()=>void)|undefined;
    const calls:string[]=[],bodies:string[]=[];
    const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
      const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);
      if(disconnected)throw new TypeError('Known offline');
      if(url.pathname==='/api/sync/delta' && expiredBaseline){expiredBaseline=false;return new Response(JSON.stringify({error:{code:'CONFLICT',message:'Snapshot delta baseline unavailable'}}),{status:409,headers:{'content-type':'application/json'}});}
      if(url.pathname==='/api/sync/delta' && changeBeforeRefresh){const change=changeBeforeRefresh;changeBeforeRefresh=undefined;change();}
      if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));
      const response=await app.request(url.pathname+url.search,init);
      if(loseReplay && url.pathname==='/api/sync/replay' && response.ok){loseReplay=false;throw new TypeError('SQL response lost');}
      if(loseAck && url.pathname==='/api/sync/ack' && response.ok){loseAck=false;throw new TypeError('ACK response lost');}
      return response;
    }}));
    const indexedDB=new IDBFactory(),databaseName=randomUUID();let store=createIndexedDbOfflineStore({indexedDB,databaseName});
    const state={mode:'online' as 'online'|'offline',lastFallbackAt:null as string|null,lastReplayError:null as string|null};
    const makeApi=()=>createOfflineAwareGalleryApi(online,store,{clientId:'compound-layout-phone',randomUUID,state});
    let api=makeApi();
    return {db,source,peer,film,section,facet,wrong,calls,bodies,state,get api(){return api;},get store(){return store;},
      async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;},
      async queued(){const uid=randomUUID(),id=localCollectionId(uid);await api.enqueueOfflineEntryCreate!({title:'Queued',type:'Comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null,previewFiles:[],syncUid:uid});return {id,uid};},
      async cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});api=makeApi();await api.preferOfflineSnapshot!();},
      async reconnect(){disconnected=false;await api.getSyncCapabilities({replay:false});await api.flushOfflineOutbox!();},
      loseResponse(){loseReplay=true;},loseAcknowledgement(){loseAck=true;},
      expireBaseline(){expiredBaseline=true;},
      changeBeforeRefresh(change:()=>void){changeBeforeRefresh=change;},
      close(){store.close();db.close();rmSync(root,{recursive:true,force:true});},
    };
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}

it('settles tag layout through durable ACK after the server delta baseline expires',async()=>{
  const f=await fixture();try{
    await f.offline();await f.api.applyEntryTagLayout(f.source.id);f.expireBaseline();
    await f.reconnect();expect(f.state.lastReplayError).toBeNull();expect(await f.store.list()).toEqual([]);
    expect(await f.store.readMeta('pendingSnapshotAck')).toBeNull();
    expect(f.calls.filter(row=>row.includes('/api/sync/delta')).length).toBeGreaterThanOrEqual(2);
    expect(f.calls.some(row=>row.includes('/api/sync/ack'))).toBe(true);
  }finally{f.close();}
});

async function namedFacet(api:GalleryApi,id:number,name:string,sectionName?:string){
  const detail=await api.getEntry(id);
  const facets=detail.sections.filter(s=>sectionName===undefined || s.name===sectionName).flatMap(s=>s.facets);
  const facet=facets.find(row=>row.name===name);
  expect(facet,`Facet ${sectionName??''}/${name}`).toBeDefined();
  return facet!;
}

function sqlPlacement(f:Awaited<ReturnType<typeof fixture>>,uid:string,name='Shared'){
  return f.db.prepare(`SELECT g.name AS facet,p.name AS section FROM entry_tags et JOIN entries e ON e.id=et.entry_id
    JOIN tags t ON t.id=et.tag_id JOIN tag_groups g ON g.id=et.facet_id JOIN tag_groups p ON p.id=g.parent_id
    WHERE e.sync_uid=? AND t.name=?`).get(uid,name);
}

it.each(['queued','settled'] as const)('B6/B9/B10 and continued edits stay offline and settle on a %s Entry',async kind=>{
  const f=await fixture();try{
    await f.offline();
    const work=kind==='queued'?await f.queued():{id:f.source.id,uid:f.source.syncUid};
    const section=await f.api.createSection({entryType:'Comic',name:'Cuisine'});
    const localDefault=await namedFacet(f.api,work.id,'','Cuisine');
    await f.api.assignEntryTag(work.id,{name:'Shared',facetId:localDefault.id});
    await f.api.applyEntryLayoutTemplate(work.id);
    const rebuilt=(await f.api.getEntry(work.id)).sections.find(s=>s.name==='Cuisine')!;
    expect(rebuilt.id).not.toBe(section.id);
    await f.api.createFacet({sectionId:rebuilt.id,name:'After template'});
    const target=await namedFacet(f.api,work.id,'After template','Cuisine');
    const tag=(await namedFacet(f.api,work.id,'','Cuisine')).tags.find(row=>row.name==='Shared')!;
    await f.api.moveEntryTag(work.id,tag.id,target.id);
    const result=await f.api.applyEntryTagLayout(work.id);
    expect(result).toMatchObject({entriesAffected:kind==='queued'?2:1,tagsMoved:kind==='queued'?2:1});
    await f.api.assignEntryTag(work.id,{name:'Extra',facetId:target.id});
    const extra=(await namedFacet(f.api,work.id,'After template')).tags.find(row=>row.name==='Extra')!;
    await f.api.renameEntryTag(work.id,extra.id,'Extra renamed');
    const renamed=(await namedFacet(f.api,work.id,'After template')).tags.find(row=>row.name==='Extra renamed')!;
    await f.api.removeEntryTag(work.id,renamed.id);
    await f.api.updateEntry(work.id,{title:'Edited after layout'});
    await f.api.addViewLaterEntry(work.id);
    await f.api.likeEntry(work.id);
    const content=await f.api.createEntryContent(work.id,{contentType:'note',content:'offline body'});
    await f.api.updateEntryContent(content.id,{content:'continued offline'});
    const rating=(await f.api.getEntry(work.id)).ratings[0]!;
    await f.api.setEntryRating(work.id,rating.slotId,4);
    expect(f.calls).toEqual([]);
    const originals=(await f.store.list()).map(operationFingerprint);
    const plan=mutationQueuePlan(await f.store.list());
    expect([...plan.values()].every(row=>row.eligible)).toBe(true);
    await f.cold();
    expect((await namedFacet(f.api,work.id,'After template')).tags.map(row=>row.name)).toEqual(['Shared']);
    expect((await f.store.list()).map(operationFingerprint)).toEqual(originals);
    expect(f.calls).toEqual([]);
    await f.reconnect();
    expect(f.state.lastReplayError).toBeNull();expect(await f.store.list()).toEqual([]);
    expect(sqlPlacement(f,work.uid)).toEqual({facet:'After template',section:'Cuisine'});
    expect(sqlPlacement(f,f.peer.syncUid)).toEqual({facet:'After template',section:'Cuisine'});
    expect(f.db.prepare('SELECT title FROM entries WHERE sync_uid=?').pluck().get(work.uid)).toBe('Edited after layout');
    expect(f.db.prepare('SELECT type FROM entries WHERE id=?').pluck().get(f.film.id)).toBe('Film');
  }finally{f.close();}
});

it.each(['queued','settled'] as const)('tags assigned before a template from a saved Facet continue editing on a %s Entry',async kind=>{
  const f=await fixture();try{
    await f.offline();const work=kind==='queued'?await f.queued():{id:f.source.id,uid:f.source.syncUid};
    await f.api.assignEntryTag(work.id,{name:'Shared',facetId:f.facet.id});
    await f.api.applyEntryLayoutTemplate(work.id);
    const originDefault=await namedFacet(f.api,work.id,'','Origin');
    const tag=(await namedFacet(f.api,work.id,'Manga')).tags[0]!;
    await f.api.moveEntryTag(work.id,tag.id,originDefault.id);
    await f.api.applyEntryTagLayout(work.id);
    await f.api.addViewLaterEntry(work.id);
    expect(f.calls).toEqual([]);await f.cold();await f.reconnect();
    expect(f.state.lastReplayError).toBeNull();expect(await f.store.list()).toEqual([]);
    expect(sqlPlacement(f,work.uid)).toEqual({facet:'',section:'Origin'});
  }finally{f.close();}
});

it('counts a move between two UID-addressed local Facets before B10, including native dependencies',async()=>{
  const f=await fixture();try{
    await f.offline();const work=await f.queued();
    const s=await f.api.createSection({entryType:'Comic',name:'Cuisine'});
    await f.api.createFacet({sectionId:s.id,name:'Other'});
    const empty=await namedFacet(f.api,work.id,'','Cuisine'),other=await namedFacet(f.api,work.id,'Other');
    await f.api.assignEntryTag(work.id,{name:'Shared',facetId:empty.id});
    const tag=(await namedFacet(f.api,work.id,'','Cuisine')).tags[0]!;
    await f.api.moveEntryTag(work.id,tag.id,other.id);await f.api.applyEntryTagLayout(work.id);
    const rows=await f.store.list(),apply=rows.at(-1)!;
    expect(apply.baseVersion).toBe(3);
    expect(mutationQueuePlan(rows).get(apply.opId)?.dependencies).toContain(rows.find(row=>row.operationKind==='entry.facet.create')!.opId);
    expect(f.calls).toEqual([]);await f.cold();await f.reconnect();
    expect(f.state.lastReplayError).toBeNull();expect(await f.store.list()).toEqual([]);
    expect(sqlPlacement(f,work.uid)).toEqual({facet:'Other',section:'Cuisine'});
  }finally{f.close();}
});

it('settles alternating layout edits, template rebuilds and Facet creation/deletion as one resource chain',async()=>{
  const f=await fixture();try{
    await f.offline();
    const s=await f.api.createSection({entryType:'Comic',name:'Cuisine'});
    await f.api.createFacet({sectionId:s.id,name:'Before template'});
    await f.api.applyEntryLayoutTemplate(f.source.id);
    const rebuilt=(await f.api.getEntry(f.source.id)).sections.find(row=>row.name==='Cuisine')!;
    await f.api.createFacet({sectionId:rebuilt.id,name:'Between templates'});
    await f.api.renameSection(rebuilt.id,'Renamed cuisine');
    await f.api.applyEntryLayoutTemplate(f.source.id);
    const dead=await namedFacet(f.api,f.source.id,'Before template');
    await f.api.deleteFacet(dead.id);
    expect(f.calls).toEqual([]);await f.cold();await f.reconnect();
    expect(f.state.lastReplayError).toBeNull();expect(await f.store.list()).toEqual([]);
    const names=f.db.prepare("SELECT name FROM tag_groups WHERE entry_type='Comic'").pluck().all();
    expect(names).toContain('Between templates');expect(names).toContain('Renamed cuisine');expect(names).not.toContain('Before template');
    expect(sqlPlacement(f,f.source.syncUid)).toEqual({facet:'Manga',section:'Origin'});
  }finally{f.close();}
});

it('keeps applying placements and editing peer Entries after a type-wide apply',async()=>{
  const f=await fixture();try{
    await f.offline();
    expect(await f.api.applyEntryTagLayout(f.source.id)).toMatchObject({entriesAffected:1,tagsMoved:1});
    await f.api.addViewLaterEntry(f.peer.id);
    const tag=(await namedFacet(f.api,f.peer.id,'Manga')).tags[0]!;
    await f.api.moveEntryTag(f.peer.id,tag.id,f.wrong.id);
    await f.api.applyEntryTagLayout(f.peer.id);
    await f.api.applyEntryLayoutTemplate(f.source.id);
    await f.api.addViewLaterEntry(f.source.id);
    expect(f.calls).toEqual([]);await f.cold();await f.reconnect();
    expect(f.state.lastReplayError).toBeNull();expect(await f.store.list()).toEqual([]);
    expect(sqlPlacement(f,f.source.syncUid)).toEqual({facet:'Wrong',section:'Origin'});
    expect(sqlPlacement(f,f.peer.syncUid)).toEqual({facet:'Wrong',section:'Origin'});
  }finally{f.close();}
});

it.each(['replay','ack'] as const)('retains unchanged originals and settles the compound chain after %s response loss and cold restart',async loss=>{
  const f=await fixture();try{
    await f.offline();
    await f.api.applyEntryLayoutTemplate(f.source.id);
    const section=(await f.api.getEntry(f.source.id)).sections[0]!;
    await f.api.createFacet({sectionId:section.id,name:'Continued'});
    const tag=(await namedFacet(f.api,f.source.id,'Manga')).tags[0]!;
    const facet=await namedFacet(f.api,f.source.id,'Continued');
    await f.api.moveEntryTag(f.source.id,tag.id,facet.id);await f.api.applyEntryTagLayout(f.source.id);
    const fingerprints=(await f.store.list()).map(operationFingerprint);
    if(loss==='replay')f.loseResponse();else f.loseAcknowledgement();
    await f.reconnect();
    expect(f.state.lastReplayError).not.toBeNull();
    expect((await f.store.list()).map(operationFingerprint)).toEqual(fingerprints);
    await f.cold();await f.reconnect();
    expect(f.state.lastReplayError).toBeNull();expect(await f.store.list()).toEqual([]);
    expect(sqlPlacement(f,f.source.syncUid)).toEqual({facet:'Continued',section:'Origin'});
    const bodiesById=new Map<string,string>();
    for(const body of f.bodies){const op=JSON.parse(body) as {opId:string};expect(bodiesById.get(op.opId)??body).toBe(body);bodiesById.set(op.opId,body);}
  }finally{f.close();}
});

it('retains a real concurrent layout conflict with the exact originals',async()=>{
  const f=await fixture();try{
    await f.offline();await f.api.applyEntryLayoutTemplate(f.source.id);
    const before=(await f.store.list()).map(operationFingerprint);
    const {createFacet}=await serverModule('repositories/layout-repository');
    createFacet(f.db,{sectionId:f.section.id,name:'Concurrent desktop edit'});
    await f.reconnect();
    expect(f.state.lastReplayError).toMatch(/conflict/iu);
    expect((await f.store.list()).map(operationFingerprint)).toEqual(before);
    expect((await f.store.list())[0]!.status).toBe('conflict');
  }finally{f.close();}
});

it('does not clear accepted layout originals when the authoritative final groups differ from their complete chain',async()=>{
  const f=await fixture();try{
    await f.offline();await f.api.applyEntryLayoutTemplate(f.source.id);
    const before=(await f.store.list()).map(operationFingerprint);
    f.changeBeforeRefresh(()=>{
      const section=f.db.prepare("SELECT id FROM tag_groups WHERE group_kind='section' AND entry_type='Comic'").pluck().get() as number;
      f.db.prepare("INSERT INTO tag_groups (entry_type,name,group_kind,parent_id) VALUES ('Comic','Unrelated later edit','facet',?)").run(section);
    });
    await f.reconnect();
    expect(f.state.lastReplayError).toMatch(/exact applied groups/iu);
    expect((await f.store.list()).map(operationFingerprint)).toEqual(before);
  }finally{f.close();}
});
