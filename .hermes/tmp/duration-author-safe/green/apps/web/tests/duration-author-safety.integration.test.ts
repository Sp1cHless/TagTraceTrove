import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import type { SyncSnapshot } from '@t3/shared';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { downloadOfflineSnapshot } from '../src/offline/offline-sync.js';
import { readActiveSnapshot } from '../src/offline/snapshot-store.js';
import { cacheSnapshotMedia, mediaRefsToRevalidate } from '../src/offline/offline-media.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
const serverModule = async (path: string) => { const target = `../../server/src/${path}.js`; return import(/* @vite-ignore */ target); };
async function setup() {
 const { createMigratedMemoryDatabase } = await serverModule('database/testing');
 const { createEntry } = await serverModule('repositories/entry-repository');
 const { createProducer } = await serverModule('repositories/producer-repository');
 const { setProducerGalleryAnchor, createProducerRatingSlot } = await serverModule('repositories/rating-repository');
 const { buildSyncSnapshot, buildSyncCapabilities } = await serverModule('sync/sync-service');
 const { createApiApp } = await serverModule('http/app');
 const db=createMigratedMemoryDatabase(), root=mkdtempSync(join(tmpdir(),'t3-duration-safety-'));
 const indexedDB=new IDBFactory(), name=randomUUID();
 let store=createIndexedDbOfflineStore({indexedDB,databaseName:name});
 const entry=createEntry(db,{title:'Existing',type:'comic',durationSeconds:470});
 createEntry(db,{title:'Film',type:'film'});
 const author=createProducer(db,{name:'No works'}); setProducerGalleryAnchor(db,{producerId:author.id,galleryType:'comic'});
 const slot=createProducerRatingSlot(db,{producerId:author.id,name:'Self',kind:'author_self'});
 const app=createApiApp(db,{assetRoot:root}); const bodies:string[]=[]; let ackLoss=false;
 const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
  const url=new URL(String(input)); const response=await app.request(url.pathname+url.search,init);
  if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));
  if(url.pathname.includes('/ack') && ackLoss && response.ok){ackLoss=false;throw new TypeError('ACK response lost');}
  return response;
 }}));
 await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot())); await store.writeMeta('activeGeneration','1');
 const api=()=>createOfflineAwareGalleryApi(online,store,{clientId:'safety-phone',randomUUID});
 const current=api(); await current.getSyncCapabilities({replay:false}); await current.preferOfflineSnapshot!();
 return {db,entry,author,slot,online,current,bodies,buildSyncSnapshot,buildSyncCapabilities,
  get store(){return store;},api,loseAck(){ackLoss=true;},cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName:name});return api();},
  close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}};
}
it.each([undefined,'producer'] as const)('rejects self write without correct %s class marker at actual replay',async marker=>{
 const h=await setup();try {
  await h.current.setAuthorRating(h.author.id,h.slot.id,3.5); const row=(await h.store.list())[0]!;
  const body=JSON.parse(JSON.stringify(row)); delete body.status;delete body.lastAttemptAt;delete body.lastError;delete body.payload.subjectKind;
  if(marker!==undefined)body.payload.subjectKind=marker;
  const result=await h.online.replaySyncOperation!(body);expect(result.status).toBe('failed');
  expect(h.db.prepare('SELECT count(*) FROM producer_rating_values WHERE producer_id=?').pluck().get(h.author.id)).toBe(0);
 }finally{h.close();}
});
const input={title:'Pending',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null};
it.each([false,undefined])('actual facade persists %s extensions and refuses duration/self/anchor/delete with no queue',async value=>{
 const h=await setup(); try {
  const caps=h.buildSyncCapabilities(h.db); for(const flag of ['offlineEntryDuration','offlineAuthorSelfRatings','offlineRatingSlotDelete']) {
   if(value===undefined)delete caps.featureFlags[flag];else caps.featureFlags[flag]=value;
  }
  h.online.getSyncCapabilities=async()=>caps; await h.current.getSyncCapabilities({replay:false});
  const api=h.cold();await api.preferOfflineSnapshot!();
  for(const flag of ['offlineEntryDuration','offlineAuthorSelfRatings','offlineRatingSlotDelete'])expect(await h.store.readMeta(`capability.${flag}`)).toBe('0');
  await expect(api.updateEntry(h.entry.id,{durationSeconds:0})).rejects.toThrow();
  await expect(api.enqueueOfflineEntryCreate!({...input,durationSeconds:0})).rejects.toThrow();
  await expect(api.createAuthorRatingSlot(h.author.id,'New','author_self')).rejects.toThrow();
  await expect(api.setAuthorRating(h.author.id,h.slot.id,3.5)).rejects.toThrow();
  await expect(api.setAuthorGalleryAnchor(h.author.id,'comic')).rejects.toThrow();
  await expect(api.deleteAuthorRatingSlot(h.author.id,h.slot.id)).rejects.toThrow();
  expect(await h.store.list()).toEqual([]);
 } finally {h.close();}
});
it('duration create/preset/pending metadata and all new author envelopes export and restore exactly, retaining old absence',async()=>{
 const h=await setup(); try {
  const {localKey}=await h.current.enqueueOfflineEntryCreate!({...input,durationSeconds:0});
  await h.current.enqueueOfflinePendingEntryMetadata!(localKey,{title:'Pending',pageCount:null,uploadDate:null,durationSeconds:null});
  expect((await h.current.listPendingOfflineEntryCreates!())[0]).toMatchObject({durationSeconds:null});
  const newSlot=await h.current.createAuthorRatingSlot(h.author.id,'Voice','author_self');
  await h.current.setAuthorRating(h.author.id,newSlot.id,3.5);
  await h.current.deleteAuthorRatingSlot(h.author.id,h.slot.id);
  await h.current.setAuthorGalleryAnchor(h.author.id,'comic');
  const old=await h.current.enqueueOfflineEntryCreate!({...input,title:'Legacy'});
  const before=await h.store.list();const backup=JSON.stringify(await buildPendingWorkExport(h.store));
  expect(before.find(row=>`local:${row.entityUid}`===old.localKey)!.payload).not.toHaveProperty('durationSeconds');
  await expect(h.current.restorePendingWork!(backup.replace('Voice','Corrupt'))).rejects.toThrow();
  expect(await h.store.list()).toEqual(before);
  await h.store.removeMany(before.map(row=>row.opId));
  const cold=h.cold();await cold.restorePendingWork!(backup);
  expect(await h.store.list()).toEqual(before);
  await cold.preferOfflineSnapshot!(); expect((await cold.listPendingOfflineEntryCreates!())[0]).toMatchObject({durationSeconds:null});
  await cold.flushOfflineOutbox!();expect(await h.store.list()).toEqual([]);
  expect(h.db.prepare("SELECT duration_seconds FROM entries WHERE title='Pending'").pluck().get()).toBeNull();
  // An uncertain online command must retain its original timestamp/body, not inject extension defaults.
  const create=before.find(row=>row.operationKind==='entry.create' && row.payload.title==='Pending')!;
  await cold.enqueueOfflineEntryCreate!({...input,presetCreateOperation:JSON.parse(h.bodies.find(body=>JSON.parse(body).opId===create.opId)!)});
  expect((await h.store.list())[0]!.payload).toEqual(create.payload);
 } finally {h.close();}
});
it('same-field duration conflict stays queued; an independent owner still settles',async()=>{
 const h=await setup();try{
  await h.current.updateEntry(h.entry.id,{durationSeconds:0});await h.current.setAuthorRating(h.author.id,h.slot.id,3.5);
  const {updateEntry}=await serverModule('repositories/entry-repository');updateEntry(h.db,h.entry.id,{durationSeconds:9});
  await h.current.flushOfflineOutbox!();const rows=await h.store.list();expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({operationKind:'entry.update',status:'conflict',payload:{durationSeconds:0}});
  expect(h.db.prepare('SELECT stars FROM producer_rating_values WHERE producer_id=? AND slot_id=?').pluck().get(h.author.id,h.slot.id)).toBe(3.5);
 }finally{h.close();}
});
it('legacy missing duration is unknown and pending capability downgrade refuses additional edits',async()=>{
 const h=await setup();try{
  const snapshot=h.buildSyncSnapshot(h.db);delete snapshot.payload.entries.find((row:{id:number})=>row.id===h.entry.id)!.durationSeconds;
  await h.store.writeGeneration(2,JSON.stringify(snapshot));await h.store.writeMeta('activeGeneration','2');
  const cold=h.cold();await cold.preferOfflineSnapshot!();await expect(cold.updateEntry(h.entry.id,{durationSeconds:null})).rejects.toThrow(/unknown|Refresh/i);expect(await h.store.list()).toEqual([]);
  const legacy=await cold.enqueueOfflineEntryCreate!(input);await expect(cold.enqueueOfflinePendingEntryMetadata!(legacy.localKey,{title:'Pending',uploadDate:null,pageCount:null,durationSeconds:0})).rejects.toThrow(/unknown/i);
  const known=await cold.enqueueOfflineEntryCreate!({...input,durationSeconds:0});await h.store.writeMeta('capability.offlineEntryDuration','0');const before=await h.store.list();
  await expect(cold.enqueueOfflinePendingEntryMetadata!(known.localKey,{title:'Pending',uploadDate:null,pageCount:null,durationSeconds:null})).rejects.toThrow();expect(await h.store.list()).toEqual(before);
 }finally{h.close();}
});
it('legacy metadata upgrade retains persisted capabilities and unchanged cached Entry bytes',async()=>{
 const h=await setup();try{
  const active=await readActiveSnapshot(h.store);const old=structuredClone(active!.snapshot);old.header.sqliteSchemaVersion=28;
  for(const row of old.payload.entries)delete row.durationSeconds;for(const row of old.payload.producers)delete row.galleryAnchor;
  await stamp(old);await h.store.writeGeneration(2,JSON.stringify(old));await h.store.writeMeta('activeGeneration','2');
  await h.store.writeMeta('user-kept','retain');const result=await downloadOfflineSnapshot({api:h.online,store:h.store});expect(result.ok).toBe(true);
  expect(await h.store.readMeta('user-kept')).toBe('retain');expect(await h.store.readMeta('capability.offlineEntryDuration')).toBe('1');
  const upgraded=(await readActiveSnapshot(h.store))!.snapshot;expect(upgraded.payload.entries.find(row=>row.id===h.entry.id)!.durationSeconds).toBe(470);
  const ref=`/api/assets/entries/${h.entry.id}/cover.webp`;old.payload.mediaRefs=[ref];upgraded.payload.mediaRefs=[ref];
  const cached=new Response('retained-picture');let fetches=0,puts=0;
  const resultMedia=await cacheSnapshotMedia([ref],{assetUrl:(ref)=>`http://isolated${ref}`,cacheStorage:{open:async()=>({match:async(request)=>String(request).includes('/api/thumbnails/') ? new Response(null,{status:302,headers:{location:'http://isolated/immutable.webp'}}) : cached,put:async()=>{puts++;}})},fetcher:async()=>{fetches++;throw new Error('Unchanged media must not download');},revalidateRefs:mediaRefsToRevalidate(old,upgraded)});
  expect(resultMedia.failed).toBe(0);expect(fetches).toBe(0);expect(puts).toBe(0);expect(await cached.text()).toBe('retained-picture');
 }finally{h.close();}
});
async function stamp(snapshot:SyncSnapshot) {
 const {checksum,...header}=snapshot.header;void checksum;
 const bytes=new TextEncoder().encode(JSON.stringify(header)+JSON.stringify(snapshot.payload));
 const hash=await crypto.subtle.digest('SHA-256',bytes);snapshot.header.checksum=[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');return snapshot;
}
it.each(['duration-missing','duration-wrong','self-value','self-class','anchor'] as const)('does not cleanup receipts on authoritative %s snapshot; exact retry recovers',async fault=>{
 const h=await setup();try {
  if(fault.startsWith('duration'))await h.current.updateEntry(h.entry.id,{durationSeconds:0});
  else if(fault==='anchor')await h.current.setAuthorGalleryAnchor(h.author.id,'film');
  else await h.current.setAuthorRating(h.author.id,h.slot.id,3.5);
  const before=await h.store.list();
  // Disable delta only in this adversarial snapshot test: use real server snapshot bytes, mutate one field, restamp.
  delete h.online.fetchSnapshotDelta;
  const fetch=h.online.fetchSyncSnapshot.bind(h.online);
  h.online.fetchSyncSnapshot=async()=>{
   const snapshot=await fetch();
   if(fault==='duration-missing')delete snapshot.payload.entries.find(row=>row.id===h.entry.id)!.durationSeconds;
   if(fault==='duration-wrong')snapshot.payload.entries.find(row=>row.id===h.entry.id)!.durationSeconds=9;
   if(fault==='self-value')snapshot.payload.producerRatingValues.find(row=>row.slotId===h.slot.id)!.stars=1;
   if(fault==='self-class')snapshot.payload.ratingSlots.find(row=>row.id===h.slot.id)!.subjectKind='producer';
   if(fault==='anchor')snapshot.payload.producers.find(row=>row.id===h.author.id)!.galleryAnchor='comic';
   return stamp(snapshot);
  };
  await h.current.flushOfflineOutbox!(); expect(await h.store.list()).toHaveLength(before.length);
  h.online.fetchSyncSnapshot=fetch; await h.cold().flushOfflineOutbox!();expect(await h.store.list()).toEqual([]);
  expect(h.bodies[0]).toBe(h.bodies[1]);
 }finally{h.close();}
});
it('durable ACK loss retains duration/self exact originals until cold retry and successful ACK',async()=>{
 const h=await setup();try {
  await h.current.updateEntry(h.entry.id,{durationSeconds:0});await h.current.setAuthorRating(h.author.id,h.slot.id,3.5);
  const before=await h.store.list();h.loseAck();await h.current.flushOfflineOutbox!();expect(await h.store.list()).toHaveLength(before.length);
  await h.cold().flushOfflineOutbox!();expect(await h.store.list()).toEqual([]);expect(h.bodies.slice(0,2)).toEqual(h.bodies.slice(2,4));
 }finally{h.close();}
});
