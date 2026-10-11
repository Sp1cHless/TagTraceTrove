import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import GalleryApp from '../src/GalleryApp.vue';
import { setLocale } from '../src/i18n.js';
vi.hoisted(async () => {
 const {JSDOM}=await import('jsdom');const window=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://isolated/'}).window;
 for(const key of ['window','document','Element','HTMLElement','SVGElement','Node','localStorage','sessionStorage','MutationObserver','navigator','getComputedStyle'])Object.defineProperty(globalThis,key,{value:key==='window'?window:window[key as keyof typeof window],configurable:true});
});
window.scrollTo=vi.fn();globalThis.addEventListener=window.addEventListener.bind(window);globalThis.removeEventListener=window.removeEventListener.bind(window);
const settle=async()=>{for(let i=0;i<15;i++){await flushPromises();await new Promise(resolve=>setTimeout(resolve,5));}};
import { entryPageQueryRequestSchema, producerPageQueryRequestSchema } from '@t3/shared';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { originalMutationEnvelope } from '../src/offline/sync-mutation-plan.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
const serverModule = async (path: string) => { const target = `../../server/src/${path}.js`; return import(/* @vite-ignore */ target); };
async function fixture(install = true) {
 const { createMigratedMemoryDatabase } = await serverModule('database/testing');
 const { createEntry } = await serverModule('repositories/entry-repository');
 const { createProducer, linkEntryProducer } = await serverModule('repositories/producer-repository');
 const { createApiApp } = await serverModule('http/app');
 const db=createMigratedMemoryDatabase(), root=mkdtempSync(join(tmpdir(),'t3-entry-delete-'));
 const entry=createEntry(db,{title:'Delete this',type:'comic'}), survivor=createEntry(db,{title:'Keep this',type:'comic'});
 const author=createProducer(db,{name:'Retained workless Author'});linkEntryProducer(db,entry.id,author.id);
 const {createSection}=await serverModule('repositories/layout-repository');createSection(db,{entryType:'comic',name:'Tags'});
 const app=createApiApp(db,{assetRoot:root});const indexedDB=new IDBFactory(),name=randomUUID();
 let store=createIndexedDbOfflineStore({indexedDB,databaseName:name});let disconnected=false,loseReplay=false,loseAck=false;
 const bodies:string[]=[], business:string[]=[];
 const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
  const url=new URL(String(input));business.push(url.pathname);
  if(disconnected)throw new TypeError('Known offline');
  if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));
  const response=await app.request(url.pathname+url.search,init);
  if(url.pathname==='/api/sync/replay' && loseReplay && response.ok){loseReplay=false;throw new TypeError('Replay response lost');}
  if(url.pathname.includes('/ack') && loseAck && response.ok){loseAck=false;throw new TypeError('ACK response lost');}
  return response;
 }}));
 if (install) { await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1'); }
 const api=(state?: import('../src/offline/offline-api.js').OfflineApiState)=>createOfflineAwareGalleryApi(online,store,{clientId:'delete-phone',randomUUID,...(state ? {state} : {})});const current=api();
 await current.getSyncCapabilities({replay:false});if (install) await current.preferOfflineSnapshot!();business.length=0;disconnected=install;
 return {db,root,entry,survivor,author,online,current,bodies,business,get store(){return store;},
  connect(){disconnected=false;},disconnect(){disconnected=true;},loseReplay(){loseReplay=true;},loseAck(){loseAck=true;},
  cold(state?: import('../src/offline/offline-api.js').OfflineApiState){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName:name});return api(state);},
  close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}};
}

it('standalone Author actual form creates a durable workless detail, cold edits and links an existing work with exact replay retry',async()=>{
 const f=await fixture();try{
  const {default:AddAuthorPage}=await import('../src/AddAuthorPage.vue');
  let created:Awaited<ReturnType<typeof f.current.createAuthor>>|undefined;
  const page=mount(AddAuthorPage,{props:{submitting:false,onSubmit:async draft=>{created=await f.current.createAuthor(draft);}}});
  await page.get('input[name="name"]').setValue('Standalone');await page.get('input[name="occupation"]').setValue('Artist');
  await page.get('input[name="artworkRef"]').setValue('https://example.invalid/artwork.webp');await page.get('textarea').setValue('Profile');await page.get('form').trigger('submit');await settle();page.unmount();
  expect(created?.name).toBe('Standalone');expect(f.business).toEqual([]);
  const id=created!.id;expect(id).toBeLessThan(0);expect((await f.store.list())[0]?.operationKind).toBe('producer.create');
  const backup=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany((await f.store.list()).map(row=>row.opId));
  const cold=f.cold();await cold.restorePendingWork!(backup);await cold.preferOfflineSnapshot!();
  expect(await cold.getAuthor(id)).toMatchObject({occupation:'Artist',content:'Profile',artworkRef:'https://example.invalid/artwork.webp'});expect((await cold.queryProducerPage(producerPageQueryRequestSchema.parse({}))).items).toEqual([expect.objectContaining({id:f.author.id})]);
  await cold.updateAuthor(id,{content:'Edited profile'});await cold.linkEntryAuthor(f.survivor.id,id);
  const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();f.loseReplay();await cold.flushOfflineOutbox!();
  expect(f.db.prepare("SELECT count(*) FROM producers WHERE name='Standalone'").pluck().get()).toBe(1);
  const retry=f.cold();f.loseAck();await retry.flushOfflineOutbox!();expect((await f.store.list()).length).toBeGreaterThan(0);
  await retry.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  const numeric=Number(f.db.prepare("SELECT id FROM producers WHERE name='Standalone'").pluck().get());
  expect(numeric).toBeGreaterThan(0);expect((await f.online.getAuthor(numeric)).content).toBe('Edited profile');
  expect(f.db.prepare('SELECT count(*) FROM entry_producers WHERE entry_id=? AND producer_id=?').pluck().get(f.survivor.id,numeric)).toBe(1);
  expect(f.bodies.map(body=>JSON.parse(body)).filter(body=>body.opId===originals[0]!.opId)).toEqual([originals[0],originals[0],originals[0]]);
 }finally{f.close();}
});
it('retained Author API origin supports direct ordinary editing and cold replay exact originals',async()=>{
 const f=await fixture();setLocale('en');let wrapper:ReturnType<typeof mount>|undefined;
 try{
  const apiCreated=await f.current.createAuthor({name:'Cold standalone',occupation:'Artist',artworkRef:'https://example.invalid/new.webp',content:'Created content'});
  const {default:AuthorDetailPage}=await import('../src/AuthorPage.vue');wrapper=mount(AuthorDetailPage,{props:{api:f.current,authors:[],initialAuthorId:apiCreated.id}});await settle();
  const created=(await f.store.list()).find(row=>row.operationKind==='producer.create')!;expect(created).toBeDefined();const uid=created.entityUid;
  const detail=wrapper.get('[data-testid="author-information-board"]');expect(detail.text()).toContain('Cold standalone');await wrapper.get('[data-testid="start-author-editing"]').trigger('click');
  await wrapper.get('input[name="authorName"]').setValue('Cold renamed');await wrapper.get('input[name="authorOccupation"]').setValue('Writer');await wrapper.get('input[name="authorArtwork"]').setValue('https://example.invalid/edited.webp');await wrapper.get('textarea[name="authorContent"]').setValue('Edited content');await wrapper.get('.author-edit-form').trigger('submit');await settle();
  const authorId=apiCreated.id;wrapper.unmount();wrapper=undefined;
  expect(authorId).toBeLessThan(0);const cold=f.cold();await cold.preferOfflineSnapshot!();
  const {default:AuthorPage}=await import('../src/AuthorPage.vue');wrapper=mount(AuthorPage,{props:{api:cold,authors:[],initialAuthorId:authorId}});await settle();await wrapper.get('[data-testid="start-author-editing"]').trigger('click');
  await wrapper.get('[data-testid="author-tag-row"] .add-button').trigger('click');await wrapper.get('input[name="authorTagName"]').setValue('New own tag');await wrapper.get('input[name="authorTagName"]').trigger('keydown',{key:'Enter'});await settle();expect((await cold.getAuthor(authorId)).tags.map(row=>row.name)).toEqual(['New own tag']);
  await wrapper.get('[data-testid="finish-author-editing"]').trigger('click');await settle();await wrapper.get('[data-testid="author-view-later-button"]').trigger('click');await settle();expect(wrapper.get('[data-testid="author-view-later-button"]').attributes('aria-pressed')).toBe('true');expect((await cold.getViewLaterState()).producerIds).toContain(authorId);expect((await cold.queryProducerPage(producerPageQueryRequestSchema.parse({}))).items.map(row=>row.id)).not.toContain(authorId);
  await cold.setAuthorGalleryAnchor(authorId,'comic');
  const slot=await cold.createAuthorRatingSlot(authorId,'New works rating');await cold.setAuthorRating(authorId,slot.id,4);
  const self=await cold.createAuthorRatingSlot(authorId,'New self rating','author_self');await cold.setAuthorRating(authorId,self.id,3.5);
  await cold.linkEntryAuthor(f.survivor.id,authorId);wrapper.unmount();wrapper=undefined;
  const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();f.loseReplay();await cold.flushOfflineOutbox!();expect(f.db.prepare('SELECT count(*) FROM producers WHERE sync_uid=?').pluck().get(uid)).toBe(1);
  const retry=f.cold();f.loseAck();await retry.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  const numeric=Number(f.db.prepare('SELECT id FROM producers WHERE sync_uid=?').pluck().get(uid));expect(numeric).toBeGreaterThan(0);const after=await final.getAuthor(numeric);expect(after).toMatchObject({name:'Cold renamed',occupation:'Writer',artworkRef:'https://example.invalid/edited.webp',content:'Edited content',galleryType:'comic'});expect(after.tags.map(row=>row.name)).toEqual(['New own tag']);expect(after.ratings[0]?.stars).toBe(4);expect(after.authorSelfRatings?.[0]?.stars).toBe(3.5);expect((await final.getViewLaterState()).producerIds).toContain(numeric);expect((await final.queryEntryPage({...entryPageQueryRequestSchema.parse({}),authorIds:[numeric]})).items.map(row=>row.id)).toEqual([f.survivor.id]);
  for(const original of originals){const bodies=f.bodies.filter(body=>JSON.parse(body).opId===original.opId);expect(bodies.length).toBeGreaterThanOrEqual(2);expect(new Set(bodies).size).toBe(1);expect(JSON.parse(bodies[0]!)).toEqual(original);}
 }finally{wrapper?.unmount();f.close();}
});
it('mixed Author profile anchor tag rating and viewlater edits settle only behind verified final deletion',async()=>{
 const f=await fixture();try{
  await f.current.updateAuthor(f.author.id,{content:'Before delete'});
  await f.current.setAuthorGalleryAnchor(f.author.id,'comic');
  await f.current.assignAuthorTag(f.author.id,'Owned tag');
  const slot=await f.current.createAuthorRatingSlot(f.author.id,'Self');
  await f.current.setAuthorRating(f.author.id,slot.id,4);
  await f.current.addViewLaterAuthor(f.author.id);
  await f.current.deleteAuthor(f.author.id);
  const originals=(await f.store.list()).map(originalMutationEnvelope);
  f.connect();f.loseAck();const retry=f.cold();await retry.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(0);
  expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);
  await retry.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(2);
 }finally{f.close();}
});
it('Author deletion waits for a held referencing Entry while an independent Entry progresses',async()=>{
 const f=await fixture();try{
  await f.current.linkEntryAuthor(f.survivor.id,f.author.id);
  const held=(await f.store.list())[0]!;await f.store.update(held.opId,{status:'conflict',lastError:'Held reference'});
  await f.current.deleteAuthor(f.author.id);
  await f.current.updateEntry(f.entry.id,{title:'Independent progressed'});
  const originals=(await f.store.list()).map(originalMutationEnvelope);
  f.connect();await f.current.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(1);
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe('Independent progressed');
  expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals.slice(0,2));
  await f.store.update(held.opId,{status:'pending',lastError:null});await f.current.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(0);
 }finally{f.close();}
});
it('actual Author Directory create move rename then ordinary delete cascades only owned relationships',async()=>{
 const f=await fixture(false);setLocale('en');vi.stubGlobal('scrollTo',vi.fn());let wrapper:ReturnType<typeof mount>|undefined;
 try{
  const peer=await f.online.createAuthor({name:'Other Author',occupation:'',artworkRef:'',content:''});
  await f.online.linkEntryAuthor(f.entry.id,peer.id);await f.online.linkEntryAuthor(f.survivor.id,peer.id);await f.online.linkEntryAuthor(f.survivor.id,f.author.id);
  const peerDir=await f.online.createAuthorDirectory(peer.id,{title:'Other Directory',entryIds:[f.survivor.id]});
  const existing=await f.online.createAuthorDirectory(f.author.id,{title:'Old Directory'});
  for(let i=0;i<6;i++)await f.online.updateAuthorDirectory(existing.id,{title:'Old Directory '+i});
  await f.online.assignAuthorTag(f.author.id,'Owned tag');await f.online.assignAuthorTag(peer.id,'Other tag');
  await f.online.setAuthorGalleryAnchor(f.author.id,'comic');await f.online.setAuthorGalleryAnchor(peer.id,'comic');
  const slot=await f.online.createAuthorRatingSlot(f.author.id,'Shared slot');await f.online.setAuthorRating(f.author.id,slot.id,4);await f.online.setAuthorRating(peer.id,slot.id,3);
  await f.online.addViewLaterAuthor(f.author.id);await f.online.addViewLaterAuthor(peer.id);
  const collection=await f.online.createCollection({kind:'producer',title:'Shared collection'});await f.online.addCollectionProducer(collection.id,f.author.id);await f.online.addCollectionProducer(collection.id,peer.id);
  const before=await f.online.fetchSyncSnapshot();await f.store.writeGeneration(2,JSON.stringify(before));await f.store.writeMeta('activeGeneration','2');await f.current.preferOfflineSnapshot!();f.disconnect();f.business.length=0;
  wrapper=mount(GalleryApp,{props:{api:f.current}});await settle();await wrapper.get('.author-link').trigger('click');await settle();await wrapper.get(`[data-author-id="${f.author.id}"]`).trigger('click');await settle();await wrapper.get('[data-testid="start-author-editing"]').trigger('click');await settle();
  await wrapper.get(`[data-author-work-id="${f.entry.id}"]`).trigger('dragstart');await wrapper.get(`[data-author-work-id="${f.survivor.id}"]`).trigger('drop');await settle();
  const directory=(await f.current.getAuthor(f.author.id)).directories.find(row=>row.id!==existing.id)!;expect(directory).toBeDefined();
  await wrapper.get(`[data-author-directory-id="${directory.id}"] [data-directory-open]`).trigger('click');await settle();await wrapper.get('[data-testid="start-directory-editing"]').trigger('click');await wrapper.get(`[data-entry-id="${f.entry.id}"]`).trigger('click');await wrapper.get('[data-testid="directory-remove-target"]').trigger('click');await settle();await wrapper.get('input[name="directoryTitle"]').setValue('Renamed Directory');await wrapper.get('[data-testid="finish-directory-editing"]').trigger('click');await settle();
  const back=wrapper.findAll('button').find(row=>row.text().includes('Back to'));expect(back).toBeDefined();await back!.trigger('click');await settle();
  if(!wrapper.find('[data-testid="delete-author"]').exists()){await wrapper.get('[data-testid="start-author-editing"]').trigger('click');await settle();}
  await wrapper.get(`[data-entry-id="${f.entry.id}"]`).trigger('click');await settle();await wrapper.get(`[data-move-work-to-directory-id="${directory.id}"]`).trigger('click');await settle();
  await wrapper.get('[data-testid="delete-author"]').trigger('click');await wrapper.get('[data-testid="delete-author"]').trigger('click');await settle();wrapper.unmount();wrapper=undefined;
  const originals=(await f.store.list()).map(originalMutationEnvelope);expect(originals.filter(row=>row.operationKind==='author.directories.set')).toHaveLength(4);
  expect(originals[0]!.baseVersion).toBeGreaterThan(originals.at(-1)!.baseVersion);expect(f.business).toEqual(['/api/navigation-counts','/api/navigation-counts']);
  const cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.queryProducerPage(producerPageQueryRequestSchema.parse({}))).items.map(row=>row.id)).toEqual([peer.id]);expect((await cold.getAuthor(peer.id)).directories.map(row=>row.id)).toEqual([peerDir.id]);expect(await cold.listCollectionsForProducer(peer.id)).toEqual([collection.id]);expect((await cold.getViewLaterState()).producerIds).toEqual([peer.id]);expect((await cold.queryEntryPage(entryPageQueryRequestSchema.parse({entryType:'comic'}))).total).toBe(2);expect((await cold.queryEntryPage({...entryPageQueryRequestSchema.parse({entryType:'comic'}),producerDirectoryId:directory.id})).total).toBe(0);
  f.connect();f.loseAck();await cold.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);
  const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  const after=await f.online.fetchSyncSnapshot();expect(after.payload.entries.map(({syncVersion,updatedAt,...row})=>{void syncVersion;void updatedAt;return row;})).toEqual(before.payload.entries.map(({syncVersion,updatedAt,...row})=>{void syncVersion;void updatedAt;return row;}));for(const entry of after.payload.entries)expect(entry.syncVersion).toBe(before.payload.entries.find(row=>row.id===entry.id)!.syncVersion!+1);expect(after.payload.ratingSlots).toEqual(before.payload.ratingSlots);expect(after.payload.ratingLayouts).toEqual(before.payload.ratingLayouts);
  for(const key of ['producers','producerTagAssignments','authorDirectories','authorDirectorySets','producerRatingValues','viewLaterProducers'] as const)expect(after.payload[key]).toEqual(before.payload[key]!.filter(row=>('producerId' in row?row.producerId:'subjectId' in row?row.subjectId:row.id)!==f.author.id));
  expect(after.payload.authorDirectoryEntries).toEqual(before.payload.authorDirectoryEntries);expect(after.payload.collectionMembers.map(({position,...row})=>{void position;return row;})).toEqual(before.payload.collectionMembers.filter(row=>!('producerId' in row)||row.producerId!==f.author.id).map(({position,...row})=>{void position;return row;}));expect(after.payload.collections.map(row=>row.id)).toEqual(before.payload.collections.map(row=>row.id));
  for(const original of originals)expect(f.bodies.map(body=>JSON.parse(body)).filter(body=>body.opId===original.opId)).toEqual([original,original]);
 }finally{wrapper?.unmount();f.close();vi.unstubAllGlobals();}
});
it('held Collection Producer membership blocks Author delete but independent Entry progresses',async()=>{
 const f=await fixture(false);try{
  const collection=await f.online.createCollection({kind:'producer',title:'Held membership'});await f.store.writeGeneration(2,JSON.stringify(await f.online.fetchSyncSnapshot()));await f.store.writeMeta('activeGeneration','2');await f.current.preferOfflineSnapshot!();f.disconnect();
  await f.current.addCollectionProducer(collection.id,f.author.id);const held=(await f.store.list())[0]!;await f.store.update(held.opId,{status:'conflict',lastError:'Held Collection'});await f.current.deleteAuthor(f.author.id);await f.current.updateEntry(f.survivor.id,{title:'Collection independent'});
  const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();await f.current.flushOfflineOutbox!();expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(1);expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.survivor.id)).toBe('Collection independent');expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals.slice(0,2));
  await f.store.update(held.opId,{status:'pending',lastError:null});f.loseAck();await f.current.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals.slice(0,2));const cold=f.cold();await cold.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);expect((await f.online.listCollections('producer')).map(row=>row.id)).toEqual([collection.id]);expect(await f.online.listCollectionsForProducer(f.author.id)).toEqual([]);
 }finally{f.close();}
});
for(const mode of ['wrong UUID','noncausal seq','unknown scope'] as const)it(`Directory deletion settlement retains originals for ${mode}`,async()=>{
 const f=await fixture();try{
  await f.current.createAuthorDirectory(f.author.id,{title:'Receipt boundary'});await f.current.deleteAuthor(f.author.id);const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();
  if(mode==='unknown scope'){
   f.loseAck();await f.current.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);await f.store.writeMeta('authorDirectoryScope.'+originals[0]!.opId,JSON.stringify({nativeReceipt:{producerUid:originals[1]!.entityUid}}));
  }else{
   const replay=f.online.replaySyncOperation!.bind(f.online);f.online.replaySyncOperation=async operation=>{const receipt=await replay(operation);return operation.operationKind==='author.directories.set' && receipt.status==='applied'?{...receipt,...(mode==='wrong UUID'?{opId:randomUUID()}:{serverSeq:Number.MAX_SAFE_INTEGER})}:receipt;};
  }
  const cold=f.cold();await cold.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);
 }finally{f.close();vi.restoreAllMocks();}
});
it('held owned Directory blocks Author deletion while independent owner progresses then settles exact ACK retry',async()=>{
 const f=await fixture();try{
  await f.current.createAuthorDirectory(f.author.id,{title:'Owned',entryIds:[f.entry.id]});
  const held=(await f.store.list())[0]!;expect(held.entityUid).not.toBe(f.author.syncUid);
  await f.store.update(held.opId,{status:'conflict',lastError:'Held Directory'});
  await f.current.deleteAuthor(f.author.id);await f.current.updateEntry(f.survivor.id,{title:'Independent Directory owner'});
  const originals=(await f.store.list()).map(originalMutationEnvelope);
  f.connect();await f.current.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(1);
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.survivor.id)).toBe('Independent Directory owner');
  expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals.slice(0,2));
  await f.store.update(held.opId,{status:'pending',lastError:null});f.loseAck();const retry=f.cold();await retry.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(0);
  expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals.slice(0,2));
  const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  for(const original of originals.slice(0,2))expect(f.bodies.map(body=>JSON.parse(body)).filter(body=>body.opId===original.opId)).toEqual([original,original]);
 }finally{f.close();}
});
it('actual GalleryApp Author delete preserves works and cold absence then exact receipt and ACK retry',async()=>{
 const f=await fixture();setLocale('en');vi.stubGlobal('scrollTo',vi.fn());const wrapper=mount(GalleryApp,{props:{api:f.current}});
 try{
  await settle();await wrapper.get('.author-link').trigger('click');await settle();
  await wrapper.get(`[data-author-id="${f.author.id}"]`).trigger('click');await settle();
  const edit=wrapper.findAll('button').find(button=>button.text()==='Edit');expect(edit).toBeDefined();await edit!.trigger('click');await settle();f.business.length=0;const button=wrapper.get('[data-testid="delete-author"]');await button.trigger('click');expect(await f.store.list()).toEqual([]);
  await button.trigger('click');await settle();expect((await f.store.list()).map(row=>row.operationKind)).toEqual(['producer.delete']);expect(f.business).toEqual([]);
  const cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.queryProducerPage(producerPageQueryRequestSchema.parse({}))).total).toBe(0);
  expect((await cold.queryEntryPage(entryPageQueryRequestSchema.parse({entryType:'comic'}))).total).toBe(2);
  const original=originalMutationEnvelope((await f.store.list())[0]!);f.connect();f.loseReplay();await cold.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(0);expect(f.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(2);
  const retry=f.cold();f.loseAck();await retry.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);await retry.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.bodies.map(body=>JSON.parse(body)).filter(body=>body.opId===original.opId)).toEqual([original,original,original]);
 }finally{wrapper.unmount();f.close();vi.unstubAllGlobals();}
});

it('retained Author API Directory seed survives actual cold Directory gestures restore SQL response and ACK loss',async()=>{
 const f=await fixture();setLocale('en');let wrapper:ReturnType<typeof mount>|undefined;
 try{
  const apiCreated=await f.current.createAuthor({name:'Seed Author'});const id=apiCreated.id;const create=(await f.store.list())[0]!;
  expect(create.payload.directorySetUid).toEqual(expect.any(String));expect(create.payload.directorySetUid).not.toBe(create.entityUid);
  await f.current.linkEntryAuthor(f.entry.id,id);await f.current.linkEntryAuthor(f.survivor.id,id);
  let cold=f.cold();await cold.preferOfflineSnapshot!();const {default:AuthorPage}=await import('../src/AuthorPage.vue');wrapper=mount(AuthorPage,{props:{api:cold,authors:[],initialAuthorId:id}});await settle();await wrapper.get('[data-testid="start-author-editing"]').trigger('click');await settle();await wrapper.get(`[data-author-work-id="${f.entry.id}"]`).trigger('dragstart');await wrapper.get(`[data-author-work-id="${f.survivor.id}"]`).trigger('drop');await settle();
  const directory=(await cold.getAuthor(id)).directories[0]!;expect(directory).toBeDefined();await wrapper.get(`[data-author-directory-id="${directory.id}"] [data-directory-open]`).trigger('click');await settle();await wrapper.get('[data-testid="start-directory-editing"]').trigger('click');await wrapper.get(`[data-entry-id="${f.entry.id}"]`).trigger('click');await wrapper.get('[data-testid="directory-remove-target"]').trigger('click');await settle();await wrapper.get('input[name="directoryTitle"]').setValue('Seed renamed');await wrapper.get('[data-testid="finish-directory-editing"]').trigger('click');await settle();wrapper.unmount();wrapper=undefined;
  const originals=(await f.store.list()).map(originalMutationEnvelope);expect(originals.filter(row=>row.operationKind==='author.directories.set')).toHaveLength(3);const exported=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany(originals.map(row=>row.opId));cold=f.cold();await cold.restorePendingWork!(exported);await cold.preferOfflineSnapshot!();expect((await cold.getAuthor(id)).directories[0]).toMatchObject({title:'Seed renamed',entryCount:1});
  await cold.updateAuthorDirectory(directory.id,{title:'Restored continued'});const finalOriginals=(await f.store.list()).map(originalMutationEnvelope);f.connect();f.loseReplay();await cold.flushOfflineOutbox!();f.loseAck();cold=f.cold();await cold.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(finalOriginals);cold=f.cold();await cold.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  const snapshot=await f.online.fetchSyncSnapshot();const owner=snapshot.payload.producers.find(row=>row.syncUid===create.entityUid)!;expect(owner.id).toBeGreaterThan(0);expect(snapshot.payload.producers.filter(row=>row.syncUid===create.entityUid)).toHaveLength(1);expect(snapshot.payload.authorDirectorySets!.find(row=>row.producerId===owner.id)!.syncUid).toBe(create.payload.directorySetUid);expect((await f.online.getAuthor(owner.id)).directories[0]).toMatchObject({title:'Restored continued',entryCount:1});
  for(const original of finalOriginals)expect(new Set(f.bodies.filter(body=>JSON.parse(body).opId===original.opId)).size).toBe(1);
 }finally{wrapper?.unmount();f.close();}
});

it('standalone Directory seed gates preserve legacy absence and original bytes',async()=>{
 const f=await fixture();try{
  const {requiredMutationCapabilities}=await import('../src/offline/sync-mutation-plan.js');
  for(const value of ['0',null]){
   await f.store.writeMeta('capability.offlineStandaloneAuthorDirectorySeed',value ?? '0');const author=await f.current.createAuthor({name:'Legacy '+value});const row=(await f.store.list()).at(-1)!;expect(Object.hasOwn(row.payload,'directorySetUid')).toBe(false);expect(requiredMutationCapabilities(originalMutationEnvelope(row))).not.toContain('offlineStandaloneAuthorDirectorySeed');
   await expect(f.current.createAuthorDirectory(author.id,{title:'Unavailable'})).rejects.toThrow(/Directory|offline/);expect(f.business).toEqual([]);
  }
  await f.store.writeMeta('capability.offlineStandaloneAuthorDirectorySeed','1');const author=await f.current.createAuthor({name:'Seed gate'});const create=(await f.store.list()).at(-1)!;await f.current.linkEntryAuthor(f.entry.id,author.id);await f.current.createAuthorDirectory(author.id,{title:'Gate',entryIds:[f.entry.id]});const originals=(await f.store.list()).map(originalMutationEnvelope);expect(requiredMutationCapabilities(originalMutationEnvelope(create))).toContain('offlineStandaloneAuthorDirectorySeed');
  await f.store.writeMeta('capability.offlineStandaloneAuthorDirectorySeed','0');await expect(f.current.updateAuthorDirectory((await f.current.getAuthor(author.id)).directories[0]!.id,{title:'Refused'})).rejects.toThrow(/not available under offline/);
  f.connect();await f.current.flushOfflineOutbox!();expect(f.bodies.map(body=>JSON.parse(body).opId)).not.toContain(create.opId);expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals.filter(row=>row.opId===create.opId || row.operationKind==='entry.authors.set' || row.operationKind==='author.directories.set'));
 }finally{f.close();}
});
it('Directory seed collision and foreign Producer origin fail without consuming original queue',async()=>{
 const f=await fixture();try{
  const author=await f.current.createAuthor({name:'Collision'});const row=(await f.store.list())[0]!;const foreign=f.db.prepare('SELECT sync_uid FROM author_directory_sets WHERE producer_id=?').pluck().get(f.author.id) as string;
  const body=originalMutationEnvelope(row);const collision={...body,opId:randomUUID(),payload:{...body.payload,directorySetUid:foreign}};f.connect();const receipt=await f.online.replaySyncOperation!(collision as typeof body);f.disconnect();expect(receipt.status).toBe('failed');expect(f.db.prepare("SELECT count(*) FROM producers WHERE name='Collision'").pluck().get()).toBe(0);expect(originalMutationEnvelope((await f.store.list())[0]!)).toEqual(body);
  await f.current.linkEntryAuthor(f.entry.id,author.id);await f.current.createAuthorDirectory(author.id,{title:'Own',entryIds:[f.entry.id]});f.connect();await f.current.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  const op={...originalMutationEnvelope(row),opId:randomUUID(),entityKind:'author_directory_set',entityUid:foreign,operationKind:'author.directories.set',baseVersion:Number(f.db.prepare('SELECT sync_version FROM author_directory_sets WHERE sync_uid=?').pluck().get(foreign)),baseValues:{directories:[]},payload:{directories:[{syncUid:randomUUID(),title:'Foreign attempt',description:'',sortOrder:0,entries:[]}],producerCreates:[{producerUid:row.entityUid,createOpId:row.opId}]}};
  expect((await f.online.replaySyncOperation!(op as never)).status).toBe('failed');
 }finally{f.close();}
});
it('Directory seed doctor and isolated database probe require new migration invariants',async()=>{
 const {inspectDatabase}=await serverModule('database/doctor');const {runDatabaseProbe}=await serverModule('database/probe');const f=await fixture();try{
  expect(runDatabaseProbe().ok).toBe(true);f.db.exec('DROP TRIGGER producers_directory_seed_immutable');expect(inspectDatabase(f.db).ok).toBe(false);
 }finally{f.close();}
});
