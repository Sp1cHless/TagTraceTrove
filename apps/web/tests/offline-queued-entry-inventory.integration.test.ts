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
import { createOfflineAwareGalleryApi, localCollectionId } from '../src/offline/offline-api.js';
const serverModule = async(path:string) => {const target=`../../server/src/${path}.js`;return import(/* @vite-ignore */ target);};

async function fixture(){
  const {createMigratedMemoryDatabase}=await serverModule('database/testing');
  const {createEntry}=await serverModule('repositories/entry-repository');
  const {createProducer,linkEntryProducer}=await serverModule('repositories/producer-repository');
  const {createSection,createFacet}=await serverModule('repositories/layout-repository');
  const {createEntryRatingSlot}=await serverModule('repositories/rating-repository');
  const {createApiApp}=await serverModule('http/app');
  const db=createMigratedMemoryDatabase(),root=mkdtempSync(join(tmpdir(),'t3-inventory-'));
  try {
  const settled=createEntry(db,{title:'Settled',type:'Comic'});
  const a1=createProducer(db,{name:'Author One'}),a2=createProducer(db,{name:'Author Two'});
  linkEntryProducer(db,settled.id,a1.id);linkEntryProducer(db,settled.id,a2.id);
  const section=createSection(db,{entryType:'Comic',name:'Origin'});
  const facet=createFacet(db,{sectionId:section.id,name:'Manga'});
  const slot=createEntryRatingSlot(db,{entryId:settled.id,name:'Quality'});
  const app=createApiApp(db,{dataDir:root,assetRoot:join(root,'assets')});let disconnected=false;
  const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    if(disconnected)throw new TypeError('Known offline');
    return app.request(new URL(String(input)).pathname+new URL(String(input)).search,init);}}));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();let store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const replayState={mode:'online' as 'online'|'offline',lastFallbackAt:null as string|null,lastReplayError:null as string|null};
  const api=createOfflineAwareGalleryApi(online,store,{clientId:'inventory-phone',randomUUID,state:replayState});
  const queued=async(title:string) => {
    const uid=randomUUID(),localId=localCollectionId(uid);
    await api.enqueueOfflineEntryCreate!({title,type:'Comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null,previewFiles:[],syncUid:uid});
    return {uid,localId};
  };
  return {db,api,settled,a1,a2,facet,slot,get store(){return store;},
    async offline(){await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot!();disconnected=true;},
    reconnect(){disconnected=false;},
    get replayState(){return replayState;},cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'inventory-phone',randomUUID,state:replayState});},
    queued,
    close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}
  };
  }catch(cause){db.close();rmSync(root,{recursive:true,force:true});throw cause;}
}

it('every ordinary gesture the editor offers works on a queued Entry', async () => {
  const f = await fixture(); try {
    await f.offline();
    const {localId} = await f.queued('Queued');
    await f.api.assignEntryTag(localId,{name:'Manga',facetId:f.facet.id});
    const detail = await f.api.getEntry(localId);
    const tagId = detail.sections.flatMap(s=>s.facets).flatMap(r=>r.tags)[0]!.id;
    const content = await f.api.createEntryContent(localId,{contentType:'note',content:'body'});
    const slotId = detail.ratings[0]!.slotId;
    await f.api.updateEntry(localId,{title:'Queued edited'});
    await f.api.recordEntryView(localId);
    await f.api.likeEntry(localId);
    await f.api.addViewLaterEntry(localId);
    await f.api.removeViewLaterEntry(localId);
    await expect(f.api.renameEntryTag(localId,tagId,'Manga x')).resolves.toBeUndefined();
    await expect(f.api.moveEntryTag(localId,tagId,f.facet.id)).resolves.toBeUndefined();
    await expect(f.api.linkEntryAuthor(localId,f.a1.id)).resolves.toBeUndefined();
    await expect(f.api.unlinkEntryAuthor(localId,f.a1.id)).resolves.toBeUndefined();
    await expect(f.api.setEntryRating(localId,slotId,4)).resolves.toMatchObject({stars:4});
    await expect(f.api.updateEntryContent(content.id,{content:'body2'})).resolves.toMatchObject({content:'body2'});
    await expect(f.api.reorderEntryContents(localId,[content.id])).resolves.toBeUndefined();
    await expect(f.api.deleteEntryContent(content.id)).resolves.toBeUndefined();
    const extra = await f.api.createEntryRatingSlot(localId,'Extra');
    const slots = (await f.api.getEntry(localId)).ratings.map(row=>row.slotId);
    await expect(f.api.reorderEntryRatingSlots(localId,[...slots].reverse())).resolves.toBeUndefined();
    await expect(f.api.deleteEntryRatingSlot(localId,extra.id)).resolves.toBeUndefined();
    const collection = await f.api.createCollection({kind:'entry',title:'Shelf',galleryType:'Comic'});
    await f.api.addCollectionEntry(collection.id,localId);
    await f.api.applyEntryLayoutTemplate(localId);
    await f.api.applyEntryTagLayout(localId);
  } finally { f.close(); }
});

it('converts a queued Entry to multiple author and settles to one Author', async () => {
  const f = await fixture(); try {
    await f.offline();
    const {uid,localId} = await f.queued('Queued');
    await f.api.linkEntryAuthorByName(localId,'Author One');
    await f.api.linkEntryAuthorByName(localId,'Author Two');
    const result = await f.api.convertEntryAuthors(localId);
    expect(result.multiAuthorName).toBe('multiple author');
    expect(result.convertedAuthors.map(row=>row.name).sort()).toEqual(['Author One','Author Two']);
    expect((await f.api.getEntry(localId)).producers.map(row=>row.name)).toEqual(['multiple author']);
    // Both names already exist in the catalog, so they link; only the
    // multiple-author Author is created.
    expect((await f.store.list()).map(row=>row.operationKind))
      .toEqual(['entry.create','entry.authors.set','entry.author.create-and-link','entry.authors.set']);

    const cold = f.cold(); await cold.preferOfflineSnapshot!();
    expect((await cold.getEntry(localId)).producers.map(row=>row.name)).toEqual(['multiple author']);
    f.reconnect(); await cold.getSyncCapabilities({replay:false}); await cold.flushOfflineOutbox!();
    expect(await f.store.list()).toEqual([]);
    const entryId = f.db.prepare('SELECT id FROM entries WHERE sync_uid=?').pluck().get(uid) as number;
    expect(f.db.prepare('SELECT p.name FROM entry_producers ep JOIN producers p ON p.id=ep.producer_id WHERE ep.entry_id=?').pluck().all(entryId))
      .toEqual(['multiple author']);
  } finally { f.close(); }
});

it('cancels an unsubmitted queued Entry and its unobserved drafts without creating it on the server', async () => {
  const f = await fixture(); try {
    await f.offline();
    const {localId,uid} = await f.queued('Doomed');
    await f.api.assignEntryTag(localId,{name:'Manga',facetId:f.facet.id});
    await f.api.deleteEntry(localId);
    expect(await f.store.list()).toEqual([]);expect(await f.store.listMedia()).toEqual([]);
    await expect(f.api.getEntry(localId)).rejects.toThrow();
    expect(f.db.prepare('SELECT count(*) FROM entries WHERE sync_uid=?').pluck().get(uid)).toBe(0);
  } finally { f.close(); }
});

it('allows local images and removal on a queued Entry while still requiring two Authors for conversion', async () => {
  const f = await fixture(); try {
    await f.offline();
    const {localId} = await f.queued('Queued');
    await f.api.uploadEntryMedia(localId,'cover',new File(['x'],'c.png',{type:'image/png'}) as unknown as globalThis.File);
    expect((await f.api.getEntry(localId)).coverRef).toContain('#t3-upload=');
    await f.api.setEntryMediaOrder!(localId,[]);
    expect((await f.api.getEntry(localId)).coverRef).toBeNull();expect(await f.store.listMedia()).toEqual([]);
    await expect(f.api.convertEntryAuthors(localId)).rejects.toThrow(/at least two Authors/iu);
  } finally { f.close(); }
});

it('merges two works that were both created offline, and settles them', async () => {
  const f = await fixture(); try {
    await f.offline();
    const keep = await f.queued('Kept');
    // The absorbed work carries a staged image, which the merge must drop
    // (its media is never copied).
    const absorbUid = randomUUID();
    const absorb = {uid:absorbUid,localId:localCollectionId(absorbUid)};
    await f.api.enqueueOfflineEntryCreate!({title:'Absorbed',type:'Comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,
      coverFile:new File(['x'],'c.png',{type:'image/png'}) as unknown as globalThis.File,previewFile:null,previewFiles:[],syncUid:absorbUid});
    expect(await f.store.listMedia()).toHaveLength(1);
    // A merge is offered from an Author's page, so both works share that Author.
    await f.api.assignEntryTag(keep.localId,{name:'Manga',facetId:f.facet.id});
    await f.api.assignEntryTag(absorb.localId,{name:'Manga',facetId:f.facet.id});
    await f.api.linkEntryAuthor(keep.localId,f.a1.id);
    await f.api.linkEntryAuthor(absorb.localId,f.a1.id);
    const result = await f.api.mergeAuthorEntries({authorId:f.a1.id,keepEntryId:keep.localId,absorbEntryId:absorb.localId,copyTags:true,sourceUrls:[]});
    expect(result.absorbedEntryId).toBe(absorb.localId);
    // The absorbed work disappears from reads immediately.
    await expect(f.api.getEntry(absorb.localId)).rejects.toThrow();
    expect((await f.api.getEntry(keep.localId)).title).toBe('Kept');

    const ops = await f.store.list();
    const mergeIndex = ops.findIndex(row => row.operationKind === 'entry.merge');
    expect(mergeIndex).toBeGreaterThan(0);
    // Every command on either work replays before the merge removes the absorb.
    for (const row of ops.slice(mergeIndex + 1)) expect(row.entityUid).not.toBe(absorb.uid);
    // Staged until the merge lands: cancelling must not lose the image.
    expect(await f.store.listMedia()).toHaveLength(1);
    const merge = ops[mergeIndex]!;
    // Each work is at 3 by then: its create plus its own queued tag and Author
    // commands, all of which replay before the merge.
    expect(merge.baseVersion).toBe(3);
    expect((merge.baseValues as {absorbVersion:number}).absorbVersion).toBe(3);
    expect(merge.entityUid).toBe(keep.uid);

    const cold = f.cold(); await cold.preferOfflineSnapshot!();
    expect((await cold.getEntry(keep.localId)).title).toBe('Kept');
    f.reconnect(); await cold.getSyncCapabilities({replay:false}); await cold.flushOfflineOutbox!();
    expect(await f.store.list()).toEqual([]);
    expect(await f.store.listMedia()).toEqual([]);
    expect(f.db.prepare('SELECT count(*) FROM entries WHERE sync_uid=?').pluck().get(absorb.uid)).toBe(0);
    const keepId = f.db.prepare('SELECT id FROM entries WHERE sync_uid=?').pluck().get(keep.uid) as number;
    expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(keepId)).toBe('Kept');
    expect(f.db.prepare('SELECT count(*) FROM entry_tags WHERE entry_id=?').pluck().get(keepId)).toBe(1);
  } finally { f.close(); }
});

it('links an Author that was created offline onto an existing work', async () => {
  const f = await fixture(); try {
    await f.offline();
    // The Author is created offline (standalone), so it exists only in the
    // queue when the settled work tries to link it.
    const author = await f.api.createAuthor({name:'Fresh offline author',occupation:'',artworkRef:'',content:''});
    expect(author.id).toBeLessThan(0);
    const before = (await f.store.list()).map(row => row.operationKind);
    expect(before).toEqual(['producer.create']);
    await f.api.linkEntryAuthorByName(f.settled.id,'Fresh offline author');
    const rows = await f.store.list();
    expect(rows.map(row => row.operationKind)).toEqual(['producer.create','entry.authors.set']);
    const link = rows[1]!;
    expect(link.payload.producerCreates).toEqual([{producerUid:rows[0]!.entityUid,createOpId:rows[0]!.opId}]);
    expect((await f.api.getEntry(f.settled.id)).producers.map(row=>row.name)).toContain('Fresh offline author');

    f.reconnect(); await f.api.getSyncCapabilities({replay:false}); await f.api.flushOfflineOutbox!();
    expect(await f.store.list()).toEqual([]);
    expect(f.db.prepare('SELECT p.name FROM entry_producers ep JOIN producers p ON p.id=ep.producer_id WHERE ep.entry_id=?').pluck().all(f.settled.id))
      .toContain('Fresh offline author');
  } finally { f.close(); }
});

it('edits the profile of an Author that was created offline', async () => {
  const f = await fixture(); try {
    await f.offline();
    const {localId} = await f.queued('Work');
    // The Author arrives through an Entry's create-and-link, which is the shape
    // the profile updater used to miss.
    await f.api.linkEntryAuthorByName(localId,'Brand new author');
    const rows = await f.store.list();
    const createOp = rows.find(row => row.operationKind === 'entry.author.create-and-link')!;
    const producerUid = (createOp.payload as {producerUid:string}).producerUid;
    const author = (await f.api.getEntry(localId)).producers.find(row => row.name === 'Brand new author')!;
    expect(author.id).toBeLessThan(0);

    await f.api.updateAuthor(author.id,{name:'Renamed offline author',occupation:'Chef',artworkRef:null,content:'bio'});
    expect((await f.store.list()).map(row => row.operationKind))
      .toEqual(['entry.create','entry.author.create-and-link','producer.update']);
    expect((await f.api.getEntry(localId)).producers.find(row => row.id === author.id)!.name).toBe('Renamed offline author');

    f.reconnect(); await f.api.getSyncCapabilities({replay:false}); await f.api.flushOfflineOutbox!();
    expect(await f.store.list()).toEqual([]);
    expect(f.db.prepare('SELECT name FROM producers WHERE sync_uid=?').pluck().get(producerUid)).toBe('Renamed offline author');
    expect(f.db.prepare('SELECT occupation FROM producers WHERE sync_uid=?').pluck().get(producerUid)).toBe('Chef');
  } finally { f.close(); }
});

it('places a tag into every kind of Facet of a queued Entry, including a queued Section default', async () => {
  const f = await fixture(); try {
    await f.offline();
    const {localId} = await f.queued('Work');
    const section = await f.api.createSection({entryType:'Comic',name:'Cuisine'});
    await f.api.createFacet({sectionId:section.id,name:'Style'});
    const facets = (await f.api.getEntry(localId)).sections.flatMap(s=>s.facets);
    expect(facets.length).toBeGreaterThan(2);
    // A settled Facet, an offline-created Facet and the default Facet of an
    // offline-created Section must all accept a tag.
    for (const facet of facets) {
      await expect(f.api.assignEntryTag(localId,{name:'Manga',facetId:facet.id}), facet.name || 'default').resolves.toBeDefined();
    }
    const rows = await f.store.list();
    const last = rows.at(-1)!;
    expect(last.operationKind).toBe('entry.tags.set');
    const tag = (last.payload as {tags:Array<{facetId?:number;facetUid?:string}>}).tags[0]!;
    // The target is named by uid whenever it is not a settled row of the copy.
    expect(tag.facetUid ?? tag.facetId).toBeDefined();
    const projected = (await f.api.getEntry(localId)).sections.flatMap(s=>s.facets).flatMap(r=>r.tags);
    expect(projected.map(row=>row.name)).toEqual(['Manga']);
  } finally { f.close(); }
});

it('places a tag into a Facet that a queued layout template owns', async () => {
  const f = await fixture(); try {
    await f.offline();
    const {localId} = await f.queued('Work');
    // "Save as template" rewrites the type's groups with fresh identities, so
    // every Facet the editor then shows comes from that queued original.
    await f.api.applyEntryLayoutTemplate(localId);
    const facets = (await f.api.getEntry(localId)).sections.flatMap(s=>s.facets);
    expect(facets.length).toBeGreaterThan(0);
    for (const facet of facets) {
      await expect(f.api.assignEntryTag(localId,{name:'Manga',facetId:facet.id}), facet.name || 'default').resolves.toBeDefined();
    }
    expect((await f.api.getEntry(localId)).sections.flatMap(s=>s.facets).flatMap(r=>r.tags).map(row=>row.name)).toEqual(['Manga']);
    // The command replays after the template that owns the Facet identity.
    const rows = await f.store.list();
    const template = rows.findIndex(row => row.operationKind === 'entry.layout-template.apply');
    const tagSet = rows.findIndex(row => row.operationKind === 'entry.tags.set');
    expect(template).toBeGreaterThanOrEqual(0);
    expect(tagSet).toBeGreaterThan(template);
  } finally { f.close(); }
});
