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
import { createOfflineAwareGalleryApi, localCollectionId } from '../src/offline/offline-api.js';
const serverModule = async(path:string) => {const target=`../../server/src/${path}.js`;return import(/* @vite-ignore */ target);};

async function fixture(){
  const {createMigratedMemoryDatabase}=await serverModule('database/testing');
  const {createEntry}=await serverModule('repositories/entry-repository');
  const {createProducer}=await serverModule('repositories/producer-repository');
  const {createSection,createFacet}=await serverModule('repositories/layout-repository');
  const {createEntryRatingSlot}=await serverModule('repositories/rating-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-pending-gestures-'));
  try {
  const existing=createEntry(db,{title:'Existing work',type:'Comic'});
  const producer=createProducer(db,{name:'Existing author'});
  const section=createSection(db,{entryType:'Comic',name:'Origin'});
  const facet=createFacet(db,{sectionId:section.id,name:'Manga'});
  const slot=createEntryRatingSlot(db,{entryId:existing.id,name:'Quality'});
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false;
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    const url=new URL(String(input));if(disconnected)throw new TypeError('Known offline');
    return app.request(url.pathname+url.search,init);
  }}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();let store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const replayState={mode:'online' as 'online'|'offline',lastFallbackAt:null as string|null,lastReplayError:null as string|null};
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'pending-gestures-phone',randomUUID,state:replayState});
  return {db,root,existing,producer,facet,slot,api,online,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;},
    reconnect(){disconnected=false;},
    get replayState(){return replayState;},cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'pending-gestures-phone',randomUUID,state:replayState});},
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}

it('every ordinary Entry gesture is reachable on a queued (offline-created) Entry and settles', async () => {
  const f = await fixture(); try {
    await f.offline();
    const uid = randomUUID();
    const localId = localCollectionId(uid);
    await f.api.enqueueOfflineEntryCreate!({title:'Queued work',type:'Comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null,previewFiles:[],syncUid:uid});
    await f.api.assignEntryTag(localId,{name:'Manga',facetId:f.facet.id});
    // Rename the assignment through the ordinary gesture the editor calls.
    const detail = await f.api.getEntry(localId);
    const tagId = detail.sections.flatMap(s=>s.facets).flatMap(r=>r.tags).find(tag=>tag.name==='Manga')!.id;
    await f.api.renameEntryTag(localId, tagId, 'Manga renamed');
    await f.api.linkEntryAuthor(localId, f.producer.id);
    await f.api.createEntryContent(localId, {contentType:'note', content:'hello'});
    await f.api.setEntryRating(localId, f.slot.id, 4);
    await f.api.addViewLaterEntry(localId);
    await f.api.likeEntry(localId);
    await f.api.recordEntryView(localId);

    const kinds = (await f.store.list()).map(row => row.operationKind);
    expect(kinds).toEqual([
      'entry.create','entry.tag.create','entry.tags.set',
      // The rename adds the new name and replaces the assignment.
      'entry.tag.create','entry.tags.set',
      'entry.authors.set','entry.content.append','entry.rating.set','entry.view-later.set','entry.usage','entry.usage',
    ]);
    // Everything but the create rides the pending machinery (parent) or a base
    // of exactly 1 frozen on the create's single revision.
    const entry = f.db.prepare('SELECT id FROM entries WHERE sync_uid=?').pluck().get(uid) as number | undefined;
    expect(entry).toBeUndefined();

    const cold = f.cold(); await cold.preferOfflineSnapshot!();
    expect((await cold.getEntry(localId)).title).toBe('Queued work');
    f.reconnect(); await cold.getSyncCapabilities({replay:false}); await cold.flushOfflineOutbox!();
    expect(await f.store.list()).toEqual([]);

    const entryId = f.db.prepare('SELECT id FROM entries WHERE sync_uid=?').pluck().get(uid) as number;
    expect(f.db.prepare("SELECT count(*) FROM entry_tags WHERE entry_id=?").pluck().get(entryId)).toBe(1);
    expect(f.db.prepare("SELECT name FROM tags WHERE id=(SELECT tag_id FROM entry_tags WHERE entry_id=?)").pluck().get(entryId)).toBe('Manga renamed');
    expect(f.db.prepare('SELECT count(*) FROM entry_producers WHERE entry_id=?').pluck().get(entryId)).toBe(1);
    expect(f.db.prepare('SELECT content FROM entry_contents WHERE entry_id=?').pluck().get(entryId)).toBe('hello');
    expect(f.db.prepare('SELECT stars FROM entry_rating_values WHERE entry_id=?').pluck().get(entryId)).toBe(4);
    expect(f.db.prepare('SELECT count(*) FROM view_later_entries WHERE entry_id=?').pluck().get(entryId)).toBe(1);
    expect(f.db.prepare('SELECT like_count FROM entry_usage WHERE entry_id=?').pluck().get(entryId)).toBe(1);
  } finally { f.close(); }
});
