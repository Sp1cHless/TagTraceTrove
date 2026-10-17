import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { expect,it,vi } from 'vitest';
vi.hoisted(async()=>{
  const {JSDOM}=await import('jsdom');const window=new JSDOM('<!doctype html>',{url:'http://isolated/'}).window;
  for(const key of ['window','document','Element','HTMLElement','SVGElement','Node','localStorage','sessionStorage','MutationObserver','navigator','getComputedStyle'])Object.defineProperty(globalThis,key,{value:key==='window'?window:window[key as keyof typeof window],configurable:true});
});
import { nativeMutationContract } from '@t3/shared';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { createOfflineAwareGalleryApi,localCollectionId } from '../src/offline/offline-api.js';
import { createIndexedDbOfflineStore, type IndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createMemoryOfflineStore } from '../src/offline/memory-offline-store.js';
import { createNativeTransfers } from '../src/offline/native-background-transfer.js';
import { operationFingerprint } from '../src/offline/outbox-store.js';
import { LOCAL_FINAL_STATE_KEY,readLocalFinalState } from '../src/offline/local-final-state.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
import { preparePendingWork } from '../src/offline/pending-work-restore.js';
const serverModule=async(path:string)=>{const target=`../../server/src/${path}.js`;return import(/* @vite-ignore */target);};
const PNG=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));
const image=()=>new File([new Uint8Array(PNG)],'local.png',{type:'image/png'});

function hasNativeCapture(store: ReturnType<typeof createMemoryOfflineStore>): store is IndexedDbOfflineStore {
  return 'captureNativeTransfers' in store && typeof store.captureNativeTransfers === 'function';
}

async function fixture(memory=false){
  const {createMigratedMemoryDatabase}=await serverModule('database/testing');
  const {createEntry}=await serverModule('repositories/entry-repository');
  const {createSection,createFacet}=await serverModule('repositories/layout-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-final-state-'));
  const uid=randomUUID();const work={...createEntry(db,{title:'Original',type:'Comic',syncUid:uid}),syncUid:uid};
  const section=createSection(db,{entryType:'Comic',name:'Origin'}),a=createFacet(db,{sectionId:section.id,name:'A'}),b=createFacet(db,{sectionId:section.id,name:'B'});
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false,loseUpload=false,loseReplay=false,loseAck=false;
  const calls:string[]=[],uploads:Array<{id:string;body:unknown}>=[],bodies:string[]=[];
  const realFetch=globalThis.fetch;
  vi.stubGlobal('fetch',async(input:URL|RequestInfo,init?:RequestInit)=>/^https?:/u.test(String(input))?realFetch(input as RequestInfo,init):app.request(String(input),init));
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);if(disconnected)throw new TypeError('Known offline');
    if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));
    if(url.pathname.includes('/media/'))uploads.push({id:url.pathname.split('/').at(-1)!,body:init?.body});
    const response=await app.request(url.pathname+url.search,init);
    if(loseUpload && url.pathname.includes('/media/') && response.ok){loseUpload=false;throw new TypeError('Upload response lost');}
    if(loseReplay && url.pathname==='/api/sync/replay' && response.ok){loseReplay=false;throw new TypeError('Replay response lost');}
    if(loseAck && url.pathname==='/api/sync/ack' && response.ok){loseAck=false;throw new TypeError('ACK response lost');}
    return response;
  }}));
  const indexedDB=new IDBFactory(),name=randomUUID();let store=memory?createMemoryOfflineStore():createIndexedDbOfflineStore({indexedDB,databaseName:name});
  const state={mode:'online' as 'online'|'offline',lastFallbackAt:null as string|null,lastReplayError:null as string|null};
  const makeApi=()=>createOfflineAwareGalleryApi(online,store,{clientId:'final-state-phone',randomUUID,state});let api=makeApi();
  return {db,work,a,b,state,calls,uploads,bodies,online,get api(){return api;},get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;calls.length=0;uploads.length=0;bodies.length=0;},
    async queued(cover=false){const uid=randomUUID(),id=localCollectionId(uid);await api.enqueueOfflineEntryCreate!({title:'Created',type:'Comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:cover?image():null,previewFile:null,previewFiles:[],syncUid:uid});return {id,uid};},
    async cold(){if('close' in store && typeof store.close==='function'){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName:name});api=makeApi();}await api.preferOfflineSnapshot!();},
    async reconnect(){disconnected=false;await api.getSyncCapabilities({replay:false});await api.flushOfflineOutbox!();},
    loseUpload(){loseUpload=true;},loseReplay(){loseReplay=true;},loseAck(){loseAck=true;},
    async covered(){await online.uploadEntryMedia(work.id,'cover',image());},
    async restoreExport(text:string){
      const target=createIndexedDbOfflineStore({indexedDB,databaseName:randomUUID()});await target.writeGeneration(1,(await store.readGeneration(1))!);await target.writeMeta('activeGeneration','1');
      const targetApi=createOfflineAwareGalleryApi(online,target,{clientId:'final-state-phone',randomUUID,state});disconnected=false;await targetApi.getSyncCapabilities({replay:false});disconnected=true;
      await target.bindPendingWorkClient('final-state-phone');await target.restorePendingWork(await preparePendingWork(text),'final-state-phone',true);
      if('close' in store && typeof store.close==='function')store.close();store=target;api=targetApi;await api.preferOfflineSnapshot!();calls.length=0;
    },
    close(){if('close' in store && typeof store.close==='function')store.close();db.close();rmSync(root,{recursive:true,force:true});vi.unstubAllGlobals();},
  };
}
const mediaRefs=async(f:Awaited<ReturnType<typeof fixture>>,id=f.work.id)=>{const entry=await f.api.getEntry(id);return [...(entry.coverRef?[entry.coverRef]:[]),...entry.previewRefs];};
const settled=async(f:Awaited<ReturnType<typeof fixture>>)=>{
  expect(f.calls).toEqual([]);await f.cold();await f.reconnect();expect(f.state.lastReplayError).toBeNull();expect(await f.store.list()).toEqual([]);expect(await f.store.listMedia()).toEqual([]);
  const local=readLocalFinalState(await f.store.readMeta(LOCAL_FINAL_STATE_KEY));expect(local.media).toEqual([]);expect(local.deleted).toEqual([]);
};

it.each([false,true])('coalesces scalar drafts from the original baseline, including memory adapter=%s',async memory=>{
  const f=await fixture(memory);try{
    await f.offline();await f.api.updateEntry(f.work.id,{title:'First'});await f.api.updateEntry(f.work.id,{title:'Final'});
    expect(await f.store.list()).toHaveLength(1);expect((await f.store.list())[0]).toMatchObject({baseValues:{title:'Original'},payload:{title:'Final'}});
    await settled(f);expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.work.id)).toBe('Final');
  }finally{f.close();}
});

it('folds initial scalar edits into a never-submitted create and cancels a fresh work with its bytes',async()=>{
  const f=await fixture();try{
    await f.offline();const work=await f.queued(true);await f.api.updateEntry(work.id,{title:'Final creation'});
    expect(await f.store.list()).toHaveLength(1);expect((await f.store.list())[0]!.payload.title).toBe('Final creation');
    await f.api.deleteEntry(work.id);expect(await f.store.list()).toEqual([]);expect(await f.store.listMedia()).toEqual([]);await expect(f.api.getEntry(work.id)).rejects.toThrow();
    await settled(f);expect(f.db.prepare('SELECT count(*) FROM entries WHERE sync_uid=?').pluck().get(work.uid)).toBe(0);
  }finally{f.close();}
});

it('cancels a reverted scalar draft and an unused locally-created tag',async()=>{
  const f=await fixture();try{
    await f.offline();await f.api.updateEntry(f.work.id,{title:'Temporary'});await f.api.updateEntry(f.work.id,{title:'Original'});expect(await f.store.list()).toEqual([]);
    await f.api.assignEntryTag(f.work.id,{name:'Temporary tag',facetId:f.a.id});
    const tag=(await f.api.getEntry(f.work.id)).sections.flatMap(s=>s.facets).flatMap(r=>r.tags)[0]!;
    await f.api.removeEntryTag(f.work.id,tag.id);expect(await f.store.list()).toEqual([]);
    await settled(f);expect(f.db.prepare("SELECT count(*) FROM tags WHERE name='Temporary tag'").pluck().get()).toBe(0);
  }finally{f.close();}
});

it('coalesces interleaved scalar, tag and View later states while rebasing only local drafts',async()=>{
  const f=await fixture();try{
    await f.offline();await f.api.updateEntry(f.work.id,{title:'First'});await f.api.assignEntryTag(f.work.id,{name:'Local',facetId:f.a.id});await f.api.addViewLaterEntry(f.work.id);
    await f.api.updateEntry(f.work.id,{title:'Last'});
    const tag=(await f.api.getEntry(f.work.id)).sections.flatMap(s=>s.facets).flatMap(r=>r.tags)[0]!;await f.api.moveEntryTag(f.work.id,tag.id,f.b.id);
    await f.api.removeViewLaterEntry(f.work.id);await f.api.addViewLaterEntry(f.work.id);
    const rows=await f.store.list();expect(rows.filter(row=>row.operationKind==='entry.update')).toHaveLength(1);expect(rows.filter(row=>row.operationKind==='entry.tags.set')).toHaveLength(1);
    await settled(f);expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.work.id)).toBe('Last');
  }finally{f.close();}
});

it('rebases an unsubmitted dependent state after canceling a local image',async()=>{
  const f=await fixture();try{
    await f.offline();const work=await f.queued();await f.api.uploadEntryMedia(work.id,'cover',image());await f.api.addViewLaterEntry(work.id);await f.api.setEntryMediaOrder!(work.id,[]);
    await settled(f);expect(f.uploads).toEqual([]);expect(f.db.prepare('SELECT cover_ref FROM entries WHERE sync_uid=?').pluck().get(work.uid)).toBeNull();
  }finally{f.close();}
});

it('stores the final placement of a local tag and settles it on a local work',async()=>{
  const f=await fixture();try{
    await f.offline();const work=await f.queued();await f.api.assignEntryTag(work.id,{name:'Local tag',facetId:f.a.id});
    const tag=(await f.api.getEntry(work.id)).sections.flatMap(s=>s.facets).flatMap(r=>r.tags)[0]!;
    await f.api.moveEntryTag(work.id,tag.id,f.b.id);await f.api.moveEntryTag(work.id,tag.id,f.a.id);await f.api.moveEntryTag(work.id,tag.id,f.b.id);
    expect((await f.store.list()).filter(row=>row.operationKind==='entry.tags.set')).toHaveLength(1);
    await settled(f);expect(f.db.prepare('SELECT g.name FROM entry_tags et JOIN entries e ON e.id=et.entry_id JOIN tag_groups g ON g.id=et.facet_id WHERE e.sync_uid=?').pluck().get(work.uid)).toBe('B');
  }finally{f.close();}
});

it('edits profile, tags and View later of an Author created by a local work rather than standalone creation',async()=>{
  const f=await fixture();try{
    await f.offline();const work=await f.queued();await f.api.linkEntryAuthorByName(work.id,'Created through work');
    const author=(await f.api.getEntry(work.id)).producers[0]!;await f.api.updateAuthor(author.id,{name:'First name'});
    await f.api.assignAuthorTag(author.id,'Local Author tag');await f.api.addViewLaterAuthor(author.id);await f.api.updateAuthor(author.id,{name:'Final name'});
    await settled(f);expect(f.db.prepare("SELECT name FROM producers WHERE name='Final name'").pluck().get()).toBe('Final name');
    expect(f.db.prepare('SELECT count(*) FROM producer_tag_assignments').pluck().get()).toBe(1);
  }finally{f.close();}
});

it.each(['saved','new'] as const)('deletes an unsent cover offline on a %s work without uploading it',async kind=>{
  const f=await fixture();try{
    await f.offline();const work=kind==='new'?await f.queued(true):{id:f.work.id,uid:f.work.syncUid};
    if(kind==='saved')await f.api.uploadEntryMedia(work.id,'cover',image());
    expect(await f.api.getEntryMediaRemovalBlockReason!(work.id)).toBeNull();await f.api.setEntryMediaOrder!(work.id,[]);
    expect(await mediaRefs(f,work.id)).toEqual([]);expect(await f.store.listMedia()).toEqual([]);
    await settled(f);expect(f.uploads).toEqual([]);expect(f.db.prepare('SELECT cover_ref FROM entries WHERE sync_uid=?').pluck().get(work.uid)).toBeNull();
  }finally{f.close();}
});

it('shows the new local cover after deleting a saved cover offline, including cold reopen',async()=>{
  const f=await fixture();try{
    await f.covered();await f.offline();const old=(await mediaRefs(f))[0]!;
    await f.api.setEntryMediaOrder!(f.work.id,[]);expect(await mediaRefs(f)).toEqual([]);
    await f.api.uploadEntryMedia(f.work.id,'cover',image());
    const upload=(await f.store.listMedia())[0]!;
    expect((await mediaRefs(f))[0]).toContain(`#t3-upload=${upload.uploadId}`);
    expect((await mediaRefs(f))[0]).not.toBe(old);
    await f.cold();expect((await mediaRefs(f))[0]).toContain(`#t3-upload=${upload.uploadId}`);
  }finally{f.close();}
});

it('keeps only the latest unsent replacement cover and cancels an earlier preview before ordering',async()=>{
  const f=await fixture();try{
    await f.offline();await f.api.uploadEntryMedia(f.work.id,'cover',image());const old=(await f.store.listMedia())[0]!.uploadId;
    await f.api.uploadEntryMedia(f.work.id,'cover',image());await f.api.uploadEntryMedia(f.work.id,'preview',image());await f.api.uploadEntryMedia(f.work.id,'preview',image());
    let refs=await mediaRefs(f);await f.api.setEntryMediaOrder!(f.work.id,[refs[2]!,refs[0]!]);
    expect((await f.store.listMedia()).some(row=>row.uploadId===old)).toBe(false);expect(await f.store.listMedia()).toHaveLength(2);
    refs=await mediaRefs(f);expect(refs).toHaveLength(2);await settled(f);
    expect(f.db.prepare('SELECT cover_ref FROM entries WHERE id=?').pluck().get(f.work.id)).toMatch(/cover/u);
    expect(JSON.parse(String(f.db.prepare('SELECT preview_refs FROM entries WHERE id=?').pluck().get(f.work.id)))).toHaveLength(1);
    expect(f.uploads).toHaveLength(2);
  }finally{f.close();}
});

it('accepts images and reorders/deletes them after offline creation',async()=>{
  const f=await fixture();try{
    await f.offline();const work=await f.queued();await f.api.uploadEntryMedia(work.id,'cover',image());await f.api.uploadEntryMedia(work.id,'preview',image());await f.api.uploadEntryMedia(work.id,'preview',image());
    const refs=await mediaRefs(f,work.id);await f.api.setEntryMediaOrder!(work.id,[refs[2]!,refs[0]!]);
    expect(await mediaRefs(f,work.id)).toHaveLength(2);await settled(f);expect(f.uploads).toHaveLength(2);
    expect(f.db.prepare('SELECT cover_ref FROM entries WHERE sync_uid=?').pluck().get(work.uid)).not.toBeNull();
  }finally{f.close();}
});

it('preserves a submitted title request while accepting later final edits',async()=>{
  const f=await fixture();try{
    await f.offline();await f.api.updateEntry(f.work.id,{title:'Submitted'});const old=(await f.store.list())[0]!,fingerprint=operationFingerprint(old);
    await f.store.captureLocalFinalState(true);await f.api.updateEntry(f.work.id,{title:'Intermediate'});await f.api.updateEntry(f.work.id,{title:'Final'});
    const rows=await f.store.list();expect(rows).toHaveLength(2);expect(operationFingerprint(rows[0]!)).toBe(fingerprint);
    await settled(f);expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.work.id)).toBe('Final');
  }finally{f.close();}
});

it('allows a later local state after an installed snapshot loses its ACK without double-counting old requests',async()=>{
  const f=await fixture();try{
    await f.offline();await f.api.updateEntry(f.work.id,{title:'First'});f.loseAck();await f.reconnect();expect(f.state.lastReplayError).not.toBeNull();
    const original=operationFingerprint((await f.store.list())[0]!);await f.api.preferOfflineSnapshot!();await f.api.addViewLaterEntry(f.work.id);await f.api.updateEntry(f.work.id,{title:'Last'});
    expect(operationFingerprint((await f.store.list())[0]!)).toBe(original);await f.cold();await f.reconnect();
    expect(f.state.lastReplayError).toBeNull();expect(await f.store.list()).toEqual([]);expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.work.id)).toBe('Last');
  }finally{f.close();}
});

it('settles successive frozen cover uploads against their final selection',async()=>{
  const f=await fixture();try{
    await f.covered();await f.offline();await f.api.uploadEntryMedia(f.work.id,'cover',image());
    await f.store.captureLocalFinalState(true);const first=(await f.store.listMedia())[0]!;
    await f.api.setEntryMediaOrder!(f.work.id,[]);await f.api.uploadEntryMedia(f.work.id,'cover',image());
    expect(await f.store.listMedia()).toHaveLength(2);
    const last=(await f.store.listMedia())[1]!;expect(first.uploadId).not.toBe(last.uploadId);
    await f.cold();await f.reconnect();expect(f.state.lastReplayError).toBeNull();
    expect(await f.store.listMedia()).toEqual([]);expect(await f.store.list()).toEqual([]);
    expect(f.db.prepare('SELECT cover_ref FROM entries WHERE id=?').pluck().get(f.work.id)).toContain(last.uploadId);
  }finally{f.close();}
});

it('allows deleting an uncertain cover offline, retries the original bytes and then deletes its result',async()=>{
  const f=await fixture();try{
    await f.offline();await f.api.uploadEntryMedia(f.work.id,'cover',image());const original=(await f.store.listMedia())[0]!;
    f.loseUpload();await f.reconnect();expect(f.state.lastReplayError).not.toBeNull();const calls=f.calls.length;
    await f.api.setEntryMediaOrder!(f.work.id,[]);expect(f.calls).toHaveLength(calls);expect(await mediaRefs(f)).toEqual([]);
    const retained=(await f.store.listMedia())[0]!;expect(retained.uploadId).toBe(original.uploadId);expect(retained.sha256).toBe(original.sha256);
    await f.cold();await f.reconnect();expect(f.state.lastReplayError).toBeNull();expect(await f.store.listMedia()).toEqual([]);expect(await f.store.list()).toEqual([]);
    expect(f.db.prepare('SELECT cover_ref FROM entries WHERE id=?').pluck().get(f.work.id)).toBeNull();expect(f.uploads).toHaveLength(2);expect(f.uploads[0]!.id).toBe(f.uploads[1]!.id);
  }finally{f.close();}
});

it('buffers replacement media and deletion after an already-submitted local create',async()=>{
  const f=await fixture();try{
    await f.offline();const work=await f.queued(true);const original=(await f.store.list())[0]!;await f.store.captureLocalFinalState(true);
    await f.api.uploadEntryMedia(work.id,'cover',image());expect(operationFingerprint((await f.store.list())[0]!)).toBe(operationFingerprint(original));
    expect(readLocalFinalState(await f.store.readMeta(LOCAL_FINAL_STATE_KEY)).deferredMedia).toHaveLength(1);
    await settled(f);expect(f.uploads).toHaveLength(2);
    const id=f.db.prepare('SELECT id FROM entries WHERE sync_uid=?').pluck().get(work.uid) as number;
    await f.api.preferOfflineSnapshot!();f.calls.length=0;await f.api.deleteEntry(id);await settled(f);
    expect(f.db.prepare('SELECT count(*) FROM entries WHERE sync_uid=?').pluck().get(work.uid)).toBe(0);
  }finally{f.close();}
});

it('shows deletion immediately for an uncertain create and completes it after the exact create retry',async()=>{
  const f=await fixture();try{
    await f.offline();const work=await f.queued();f.loseReplay();await f.reconnect();expect(f.state.lastReplayError).not.toBeNull();
    const original=operationFingerprint((await f.store.list())[0]!);const calls=f.calls.length;await f.api.preferOfflineSnapshot!();await f.api.deleteEntry(work.id);
    expect(f.calls).toHaveLength(calls);await expect(f.api.getEntry(work.id)).rejects.toThrow();expect(operationFingerprint((await f.store.list())[0]!)).toBe(original);
    await f.cold();await f.reconnect();expect(f.state.lastReplayError).toBeNull();expect(await f.store.list()).toEqual([]);expect(f.db.prepare('SELECT count(*) FROM entries WHERE sync_uid=?').pluck().get(work.uid)).toBe(0);
  }finally{f.close();}
});

it('freezes native bodies at handoff, while foreground edits remain mutable until that boundary',async()=>{
  const f=await fixture();try{
    await f.offline();await f.api.updateEntry(f.work.id,{title:'Draft'});expect('captureNativeTransfers' in f.store).toBe(true);
    if(!hasNativeCapture(f.store))throw new Error('Missing native capture');
    let editing=true;const sent:string[]=[];
    const transfers=createNativeTransfers(f.store,{call:async(method,args)=>{if(method==='status')return {protocolVersion:1,planVersion:1,operationKinds:Object.keys(nativeMutationContract)};if(method==='stageOperation')sent.push(String(args.body));return {}; }},{isEditing:()=>editing});
    await transfers.handoff();expect(sent).toEqual([]);await f.api.updateEntry(f.work.id,{title:'Latest draft'});
    editing=false;await transfers.handoff();expect(sent).toHaveLength(1);const original=operationFingerprint((await f.store.list())[0]!);
    await f.api.updateEntry(f.work.id,{title:'After submission'});expect(await f.store.list()).toHaveLength(2);expect(operationFingerprint((await f.store.list())[0]!)).toBe(original);
  }finally{f.close();}
});

it.each([false, true])('refuses edits after a local deletion without changing its durable intent (memory=%s)',async memory=>{
  const f=await fixture(memory);try{
    await f.offline();await f.api.deleteEntry(f.work.id);
    const before=await f.store.captureLocalFinalState();
    await expect(f.api.updateEntry(f.work.id,{title:'Resurrection'})).rejects.toThrow(/delet/iu);
    await expect(f.api.likeEntry(f.work.id)).rejects.toThrow(/delet/iu);
    expect(await f.store.captureLocalFinalState()).toEqual(before);
    expect(f.calls).toEqual([]);
    await settled(f);expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.work.id)).toBe(0);
  }finally{f.close();}
});

it('exports and atomically restores an intent-only deletion of stored media',async()=>{
  const f=await fixture();try{
    await f.covered();await f.offline();await f.api.setEntryMediaOrder!(f.work.id,[]);expect(await f.store.list()).toEqual([]);expect(await f.store.listMedia()).toEqual([]);
    await expect(f.store.clearSnapshot!()).rejects.toThrow(/unsynced/iu);
    const file=await buildPendingWorkExport(f.store);expect(file.localFinalState?.media).toHaveLength(1);
    await f.restoreExport(JSON.stringify(file));expect(await mediaRefs(f)).toEqual([]);await settled(f);
    expect(f.db.prepare('SELECT cover_ref FROM entries WHERE id=?').pluck().get(f.work.id)).toBeNull();
  }finally{f.close();}
});

it('restores deferred image drafts with fresh UUIDs, retaining submitted requests unchanged',async()=>{
  const f=await fixture();try{
    await f.offline();const work=await f.queued(true);await f.store.captureLocalFinalState(true);await f.api.uploadEntryMedia(work.id,'cover',image());
    const originals=(await f.store.list()).map(operationFingerprint),old=readLocalFinalState(await f.store.readMeta(LOCAL_FINAL_STATE_KEY)).deferredMedia[0]!;
    await f.restoreExport(JSON.stringify(await buildPendingWorkExport(f.store)));
    expect((await f.store.list()).map(operationFingerprint)).toEqual(originals);expect(readLocalFinalState(await f.store.readMeta(LOCAL_FINAL_STATE_KEY)).deferredMedia[0]).not.toBe(old);
    expect(await mediaRefs(f,work.id)).toHaveLength(1);await settled(f);expect(f.uploads).toHaveLength(2);
  }finally{f.close();}
});
