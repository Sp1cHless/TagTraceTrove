// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { indexedDB, IDBObjectStore } from 'fake-indexeddb';
import type { GalleryApi } from '../src/api/gallery.js';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { preparePendingWork } from '../src/offline/pending-work-restore.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
import { createMemoryOfflineStore } from '../src/offline/memory-offline-store.js';
const identity = {clientId:'restore-client',libraryId:'11111111-1111-4111-8111-111111111111',syncEpoch:'epoch-1'};
function create() { return createPendingSyncOperation({...identity,entityKind:'entry',entityUid:crypto.randomUUID(),operationKind:'entry.create',baseVersion:0,baseValues:{},payload:{title:'Saved',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false}}); }
function text(operations = [create()], media: unknown[] = []) {return JSON.stringify({format:'t3-pending-work-v1',exportedAt:new Date().toISOString(),operations,media});}
async function setup(databaseName = crypto.randomUUID()) {
 const store = createIndexedDbOfflineStore({indexedDB,databaseName}); const snapshot=offlineSnapshot(); snapshot.header.libraryId=identity.libraryId;
 await store.writeGeneration(1,JSON.stringify(snapshot)); await store.writeMeta('activeGeneration','1');
 const online={assetUrl:(p:string)=>p} as GalleryApi;
 const api=createOfflineAwareGalleryApi(online,store,{clientId:identity.clientId});
 return {store,api,databaseName,snapshot};
}
it('rejects a valid envelope targeting an unknown canonical Entry without restoring unrelated creates', async()=>{
 const {store,api}=await setup();
 const foreign=createPendingSyncOperation({...identity,entityKind:'entry',entityUid:crypto.randomUUID(),operationKind:'entry.update',baseVersion:1,baseValues:{title:'Before'},payload:{title:'After'}});
 await expect(api.restorePendingWork!(text([create(),foreign]))).rejects.toThrow(/owner|item|Entry/i);
 expect(await store.list()).toEqual([]); store.close();
});
it('unified memory adapter restores atomically and preserves live retry state on identical restore',async()=>{
 const store=createMemoryOfflineStore(); const snapshot=offlineSnapshot(); snapshot.header.libraryId=identity.libraryId;
 await store.writeGeneration(1,JSON.stringify(snapshot)); await store.writeMeta('activeGeneration','1');
 const api=createOfflineAwareGalleryApi({assetUrl:(p:string)=>p} as GalleryApi,store,{clientId:identity.clientId});
 const original=create(); const backup=text([original]);
 await api.restorePendingWork!(backup); await store.update(original.opId,{status:'conflict',lastError:'newer live state'});
 await api.restorePendingWork!(backup);
 expect(await store.list()).toEqual([{...original,status:'conflict',lastError:'newer live state'}]);
 const colliding={...original,payload:{...original.payload,title:'changed'}};
 await expect(api.restorePendingWork!(text([create(),colliding]))).rejects.toThrow(/different|newer/);
 expect(await store.list()).toHaveLength(1);
});
it('rejects an unknown Author UUID in a valid relationship envelope for a canonical Entry',async()=>{
 const {store,api,snapshot}=await setup();
 const row=createPendingSyncOperation({...identity,entityKind:'entry',entityUid:snapshot.payload.entries[0]!.syncUid!,operationKind:'entry.authors.set',baseVersion:1,
 baseValues:{producerUids:[]},payload:{producerUids:[crypto.randomUUID()]}});
 await expect(api.restorePendingWork!(text([create(),row]))).rejects.toThrow(/Author|Producer|identity/);
 expect(await store.list()).toEqual([]);store.close();
});
it('Directory restore rejects a known Entry that is not linked to the Directory-set Producer',async()=>{
 const {store,api,snapshot}=await setup(); snapshot.payload.entryProducers=[];
 await store.writeGeneration(1,JSON.stringify(snapshot));
 const row=createPendingSyncOperation({...identity,entityKind:'author_directory_set',entityUid:snapshot.payload.authorDirectorySets![0]!.syncUid,operationKind:'author.directories.set',baseVersion:1,
 baseValues:{directories:[]},payload:{directories:[{syncUid:crypto.randomUUID(),title:'Folder',description:'',sortOrder:0,entries:[{syncUid:snapshot.payload.entries[0]!.syncUid!,sortOrder:0}]}]}});
 await expect(api.restorePendingWork!(text([create(),row]))).rejects.toThrow(/owner|Producer|Directory/);
 expect(await store.list()).toEqual([]);store.close();
});
it('Collection member restore rejects Entry membership in a Producer Collection',async()=>{
 const {store,api,snapshot}=await setup();
 const row=createPendingSyncOperation({...identity,entityKind:'collection',entityUid:snapshot.payload.collections[0]!.syncUid!,operationKind:'collection.entry.set',baseVersion:1,
 baseValues:{entryUid:snapshot.payload.entries[0]!.syncUid!,present:false},payload:{entryUid:snapshot.payload.entries[0]!.syncUid!,present:true}});
 await expect(api.restorePendingWork!(text([row]))).rejects.toThrow(/owner|kind|Collection/);
 expect(await store.list()).toEqual([]);store.close();
});
it('Collection child restore rejects a third level in locally-created folders',async()=>{
 const {store,api}=await setup();
 const folder=(parentUid:string|null)=>createPendingSyncOperation({...identity,entityKind:'collection',entityUid:crypto.randomUUID(),operationKind:'collection.create',baseVersion:0,baseValues:{},payload:{kind:'entry',title:'Folder',description:'',nsfw:false,parentUid,galleryType:'game'}});
 const root=folder(null),child=folder(root.entityUid),grandchild=folder(child.entityUid);
 await expect(api.restorePendingWork!(text([root,child,grandchild]))).rejects.toThrow(/owner|level|Collection/);
 expect(await store.list()).toEqual([]);store.close();
});
it('Collection child restore rejects a different Gallery scope',async()=>{
 const {store,api}=await setup();
 const root=createPendingSyncOperation({...identity,entityKind:'collection',entityUid:crypto.randomUUID(),operationKind:'collection.create',baseVersion:0,baseValues:{},payload:{kind:'entry',title:'Folder',description:'',nsfw:false,parentUid:null,galleryType:'game'}});
 const child={...root,opId:crypto.randomUUID(),entityUid:crypto.randomUUID(),payload:{...root.payload,parentUid:root.entityUid,galleryType:'comic'}};
 await expect(api.restorePendingWork!(text([root,child]))).rejects.toThrow(/owner|scope|Gallery/);
 expect(await store.list()).toEqual([]);store.close();
});
it('Producer rating restore rejects a slot outside the dominant Gallery',async()=>{
 const {store,api,snapshot}=await setup(); const slotUid=crypto.randomUUID();
 snapshot.payload.ratingSlots.push({id:8,syncUid:slotUid,subjectKind:'producer',entryType:'comic',name:'Quality',sortOrder:0});
 await store.writeGeneration(1,JSON.stringify(snapshot));
 const row=createPendingSyncOperation({...identity,entityKind:'producer',entityUid:snapshot.payload.producers[0]!.syncUid!,operationKind:'producer.rating.set',baseVersion:1,baseValues:{slotUid,stars:null},payload:{slotUid,stars:3}});
 await expect(api.restorePendingWork!(text([row]))).rejects.toThrow(/owner|Gallery|slot/);
 expect(await store.list()).toEqual([]);store.close();
});
it('Rating layout restore rejects an existing slot from another layout',async()=>{
 const {store,api,snapshot}=await setup();
 const slot={syncUid:snapshot.payload.ratingSlots[0]!.syncUid!,name:'Quality',sortOrder:0};
 const row=createPendingSyncOperation({...identity,entityKind:'rating_layout',entityUid:snapshot.payload.ratingLayouts![1]!.syncUid,operationKind:'rating-layout.slots.set',baseVersion:1,baseValues:{slots:[]},payload:{slots:[slot]}});
 await expect(api.restorePendingWork!(text([row]))).rejects.toThrow(/owner|layout|slot/);
 expect(await store.list()).toEqual([]);store.close();
});
it('Producer creation restore rejects a UID collision with a canonical Author',async()=>{
 const {store,api,snapshot}=await setup();
 const row=createPendingSyncOperation({...identity,entityKind:'entry',entityUid:snapshot.payload.entries[0]!.syncUid!,operationKind:'entry.author.create-and-link',baseVersion:1,baseValues:{producerUids:[]},payload:{producerUid:snapshot.payload.producers[0]!.syncUid!,name:'Different'}});
 await expect(api.restorePendingWork!(text([row]))).rejects.toThrow(/identity|collision|Author/);
 expect(await store.list()).toEqual([]);store.close();
});
it('Content append restore rejects a UID already owned by another Entry',async()=>{
 const {store,api,snapshot}=await setup(); const parent=create(); const contentUid=crypto.randomUUID();
 snapshot.payload.entryContents=[{id:1,entryId:1,syncUid:contentUid,contentType:'text',content:'Old',sortOrder:0}]; await store.writeGeneration(1,JSON.stringify(snapshot));
 const row=createPendingSyncOperation({...identity,entityKind:'entry',entityUid:parent.entityUid,operationKind:'entry.content.append',baseVersion:0,baseValues:{},payload:{parentCreateOpId:parent.opId,content:{syncUid:contentUid,contentType:'text',content:'New'}}});
 await expect(api.restorePendingWork!(text([parent,row]))).rejects.toThrow(/identity|collision|Content/);
 expect(await store.list()).toEqual([]);store.close();
});
it('restore rejects descending same-owner metadata timestamps within imported work',async()=>{
 const {store,api,snapshot}=await setup(); const entityUid=snapshot.payload.entries[0]!.syncUid!;
 const row=createPendingSyncOperation({...identity,entityKind:'entry',entityUid,operationKind:'entry.update',baseVersion:1,baseValues:{title:'Before'},payload:{title:'After'}});
 const older={...row,opId:crypto.randomUUID(),clientCreatedAt:'2000-01-01T00:00:00.000Z',baseVersion:2,baseValues:{title:'After'},payload:{title:'Last'}};
 await expect(api.restorePendingWork!(text([row,older]))).rejects.toThrow(/order|causal|newer/);
 expect(await store.list()).toEqual([]);store.close();
});
it('restore rejects a same-scope snapshot generation change after preview',async()=>{
 const {store,api,snapshot}=await setup(); const backup=text(); await api.previewPendingWorkRestore!(backup);
 await store.writeGeneration(2,JSON.stringify({...snapshot,header:{...snapshot.header,snapshotSeq:2}}));await store.writeMeta('activeGeneration','2');
 await expect(api.restorePendingWork!(backup)).rejects.toThrow(/changed|preview|refresh/);
 expect(await store.list()).toEqual([]);store.close();
});
it('Collection Producer membership restore rejects a local Entry folder',async()=>{
 const {store,api,snapshot}=await setup();
 const folder=createPendingSyncOperation({...identity,entityKind:'collection',entityUid:crypto.randomUUID(),operationKind:'collection.create',baseVersion:0,baseValues:{},payload:{kind:'entry',title:'Folder',description:'',nsfw:false,parentUid:null,galleryType:'game'}});
 const member=createPendingSyncOperation({...identity,entityKind:'collection',entityUid:folder.entityUid,operationKind:'collection.producer.set',baseVersion:1,baseValues:{producerUid:snapshot.payload.producers[0]!.syncUid!,present:false},payload:{producerUid:snapshot.payload.producers[0]!.syncUid!,present:true}});
 await expect(api.restorePendingWork!(text([folder,member]))).rejects.toThrow(/owner|kind|Collection/);expect(await store.list()).toEqual([]);store.close();
});
it('Collection reorder restore rejects mixed kinds despite known UUIDs',async()=>{
 const {store,api,snapshot}=await setup();
 const folder=createPendingSyncOperation({...identity,entityKind:'collection',entityUid:crypto.randomUUID(),operationKind:'collection.create',baseVersion:0,baseValues:{},payload:{kind:'entry',title:'Folder',description:'',nsfw:false,parentUid:null,galleryType:'game'}});
 const a=snapshot.payload.collections[0]!.syncUid!, b=folder.entityUid;
 const row=createPendingSyncOperation({...identity,entityKind:'collection_order',entityUid:'00000000-0000-4000-8000-000000000001',operationKind:'collection.order.set',baseVersion:2,baseValues:{kind:'entry',collections:[{syncUid:a,syncVersion:1,sortOrder:0},{syncUid:b,syncVersion:1,sortOrder:1}]},payload:{kind:'entry',orderedCollectionUids:[b,a]}});
 await expect(api.restorePendingWork!(text([folder,row]))).rejects.toThrow(/owner|kind|Collection/);expect(await store.list()).toEqual([]);store.close();
});
it('binary aggregate oversize is rejected before any base64 decode or digest allocation',async()=>{
 const parent=create();const media=await image(parent.entityUid);const decode=vi.spyOn(globalThis,'atob');
 try {
  await expect(preparePendingWork(text([parent],Array.from({length:4},()=>({...media,uploadId:crypto.randomUUID(),byteLength:20*1024*1024}))))).rejects.toThrow(/64 MiB/);
  expect(decode).not.toHaveBeenCalled();
 } finally {decode.mockRestore();}
});

it.each(['client','library','epoch'])('defensive acceptance: %s identity change between preview and confirmation restores nothing',async(kind)=>{
 const {store,api,snapshot}=await setup();const parent=create();const backup=text([parent],[await image(parent.entityUid)]);
 await api.previewPendingWorkRestore!(backup);
 if(kind==='client') await store.writeMeta('pendingWork.clientId','other-device');
 else {snapshot.header[kind==='library'?'libraryId':'syncEpoch']=crypto.randomUUID();await store.writeGeneration(1,JSON.stringify(snapshot));}
 await expect(api.restorePendingWork!(backup)).rejects.toThrow(/device|changed|match/);
 expect(await store.list()).toEqual([]);expect(await store.listMedia()).toEqual([]);store.close();
});
it.each(['client','library','epoch','snapshot'])('defensive acceptance: peer %s change during image verification restores nothing',async(kind)=>{
 const {store,api,snapshot,databaseName}=await setup();const parent=create();const backup=text([parent],[await image(parent.entityUid)]);
 await api.previewPendingWorkRestore!(backup);const peer=createIndexedDbOfflineStore({indexedDB,databaseName});await peer.list();
 const digest=crypto.subtle.digest.bind(crypto.subtle);let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
 const spy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{entered();await gate;return digest(...args);});
 try {
  const restoring=api.restorePendingWork!(backup);await started;
  if(kind==='client') await peer.writeMeta('pendingWork.clientId','other-device');
  else {if(kind==='snapshot') snapshot.header.snapshotSeq++;else snapshot.header[kind==='library'?'libraryId':'syncEpoch']=crypto.randomUUID();await peer.writeGeneration(1,JSON.stringify(snapshot));}
  release();await expect(restoring).rejects.toThrow(/device|changed|match/);
  expect(await peer.list()).toEqual([]);expect(await peer.listMedia()).toEqual([]);
 } finally {release();spy.mockRestore();store.close();peer.close();}
});
it('defensive acceptance: complete multiple-Entry cover and preview restore survives actual cold reopen byte-for-byte',async()=>{
 const {store,api,databaseName}=await setup();const a=create(),b=create();const operations=[a,b];
 const media=[await image(a.entityUid),{...await image(a.entityUid),kind:'preview',ordinal:0},{...await image(a.entityUid),kind:'preview',ordinal:1},await image(b.entityUid),{...await image(b.entityUid),kind:'preview',ordinal:0}];
 const backup=text(operations,media);await api.previewPendingWorkRestore!(backup);await api.restorePendingWork!(backup);store.close();
 const reopened=createIndexedDbOfflineStore({indexedDB,databaseName});expect(await reopened.list()).toEqual(operations);
 const rows=await reopened.listMedia();expect(rows).toHaveLength(media.length);
 for(const original of media) {const row=rows.find(value=>value.uploadId===original.uploadId)!;const {base64,clientId,...metadata}=original;void clientId;
  expect(row).toMatchObject(metadata);expect([...new Uint8Array(await row.blob.arrayBuffer())]).toEqual([0,255,42]);expect(row.blob.type).toBe(original.mimeType);
  expect(btoa(String.fromCharCode(...new Uint8Array(await row.blob.arrayBuffer())))).toBe(base64);
 } reopened.close();
});
it.each(['applied','sending','receipt'])('defensive acceptance: untrusted imported %s cannot establish server authority',async(kind)=>{
 const {store,api}=await setup();const parent=create();const file=JSON.parse(text([parent]));
 if(kind==='receipt') file.operations[0].receipt={opId:parent.opId,status:'applied',entityId:1,serverSeq:100};else file.operations[0].status=kind;
 await expect(api.restorePendingWork!(JSON.stringify(file))).rejects.toThrow(/fields|file/);expect(await store.list()).toEqual([]);store.close();
});
it('defensive acceptance: covered numeric Entry identity cannot replace a missing original parent envelope',async()=>{
 const {store,api,snapshot}=await setup();const child=createPendingSyncOperation({...identity,entityKind:'entry',entityUid:snapshot.payload.entries[0]!.syncUid!,operationKind:'entry.update',baseVersion:0,baseValues:{title:'Old'},payload:{title:'New',parentCreateOpId:crypto.randomUUID()}});
 await expect(api.restorePendingWork!(text([child]))).rejects.toThrow(/original.*parent.*export|export.*original.*parent/i);expect(await store.list()).toEqual([]);store.close();
});


it.each(['client','library','epoch','snapshot'].flatMap(kind=>['restore-first','change-first'].map(order=>({kind,order}))))('defensive acceptance: peer $kind transaction serializes $order at the restore commit boundary',async({kind,order})=>{
 const {store,api,snapshot,databaseName}=await setup();const parent=create();const backup=text([parent],[await image(parent.entityUid)]);
 const preview=await api.previewPendingWorkRestore!(backup);const work=await preparePendingWork(backup);work.expectedSnapshot=preview.snapshotIdentity;
 const peer=createIndexedDbOfflineStore({indexedDB,databaseName});await peer.list();
 const change=()=>{if(kind==='client') return peer.writeMeta('pendingWork.clientId','other-device');
  const changed={...snapshot,header:{...snapshot.header}};if(kind==='snapshot') changed.header.snapshotSeq++;else changed.header[kind==='library'?'libraryId':'syncEpoch']=crypto.randomUUID();return peer.writeGeneration(1,JSON.stringify(changed));};
 const results=await Promise.allSettled(order==='restore-first'?[store.restorePendingWork(work,identity.clientId,true),change()]:[change(),store.restorePendingWork(work,identity.clientId,true)]);
 expect(results.map(result=>result.status)).toEqual(order==='restore-first'?['fulfilled','fulfilled']:['fulfilled','rejected']);
 expect(await peer.list()).toEqual(order==='restore-first'?[parent]:[]);expect(await peer.listMedia()).toHaveLength(order==='restore-first'?1:0);store.close();peer.close();
});


it('defensive acceptance: abort after the third successful media insert rolls back a complete multi-Entry restore',async()=>{
 const {store,api,snapshot}=await setup();const a=create(),b=create();const media=[await image(a.entityUid),{...await image(a.entityUid),kind:'preview',ordinal:0},await image(b.entityUid),{...await image(b.entityUid),kind:'preview',ordinal:0}];
 const add=IDBObjectStore.prototype.add;let inserted=0;
 const spy=vi.spyOn(IDBObjectStore.prototype,'add').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['add']>){
  const request=add.apply(this,args);if(this.name==='mediaOutbox') request.onsuccess=()=>{inserted++;if(inserted===3)this.transaction.abort();};return request;
 });
 try {await expect(api.restorePendingWork!(text([a,b],media))).rejects.toThrow();expect(inserted).toBe(3);expect(await store.list()).toEqual([]);expect(await store.listMedia()).toEqual([]);expect(await store.readGeneration(1)).toBe(JSON.stringify(snapshot));}
 finally {spy.mockRestore();store.close();}
});


it('restores a valid child Collection whose null Gallery scope inherits its local parent',async()=>{
 const {store,api}=await setup();const folder=(parentUid:string|null,galleryType:string|null)=>createPendingSyncOperation({...identity,entityKind:'collection',entityUid:crypto.randomUUID(),operationKind:'collection.create',baseVersion:0,baseValues:{},payload:{kind:'entry',title:'Folder',description:'',nsfw:false,parentUid,galleryType}});
 const root=folder(null,'game'),child=folder(root.entityUid,null);await api.restorePendingWork!(text([root,child]));expect(await store.list()).toEqual([root,child]);store.close();
});


it('defensive acceptance: retained Tag and Facet creation origins need not equal cached canonical UUIDs',async()=>{
 const {store,api,snapshot}=await setup();const sectionUid=crypto.randomUUID(),facetUid=crypto.randomUUID(),tagUid=crypto.randomUUID();
 snapshot.payload.tagGroups=[{id:2,syncUid:sectionUid,entryType:'game',name:'Tags',groupKind:'section',parentId:null,sortOrder:0},{id:3,syncUid:crypto.randomUUID(),entryType:'game',name:'Mood',groupKind:'facet',parentId:2,sortOrder:0}];
 snapshot.payload.tags=[{id:10,syncUid:crypto.randomUUID(),name:'Bright',normalizedName:'bright'}];
 snapshot.payload.entryTagLayouts=[{entryType:'game',syncUid:crypto.randomUUID(),syncVersion:4}];await store.writeGeneration(1,JSON.stringify(snapshot));
 const parent=create();const facet=createPendingSyncOperation({...identity,entityKind:'entry_facet',entityUid:facetUid,operationKind:'entry.facet.create',baseVersion:4,baseValues:{entryType:'game',sectionUid},payload:{entryType:'game',sectionUid,name:'Mood'}});
 const tag=createPendingSyncOperation({...identity,entityKind:'entry_tag',entityUid:tagUid,operationKind:'entry.tag.create',baseVersion:0,baseValues:{},payload:{name:'Bright'}});
 const child=createPendingSyncOperation({...identity,entityKind:'entry',entityUid:parent.entityUid,operationKind:'entry.tags.set',baseVersion:0,baseValues:{tags:[]},payload:{parentCreateOpId:parent.opId,tags:[{name:'Bright',tagUid,facetUid}],tagCreates:[{tagUid,createOpId:tag.opId}],facetCreates:[{facetUid,createOpId:facet.opId}]}});
 await api.restorePendingWork!(text([parent,facet,tag,child]));expect(await store.list()).toEqual([parent,facet,tag,child]);store.close();
});
it.each(['pending','failed','conflict'] as const)('defensive acceptance: identical restore preserves live %s status and attempt/error metadata',async(status)=>{
 const {store,api}=await setup();const original=create(),backup=text([original]);await api.restorePendingWork!(backup);
 const state={status,lastAttemptAt:'2026-10-01T00:00:00.000Z',lastError:'live retry detail'};await store.update(original.opId,state);
 await api.restorePendingWork!(backup);expect(await store.list()).toEqual([{...original,...state}]);store.close();
});

async function image(entryUid:string) {
 const bytes=new Uint8Array([0,255,42]); const hash=await crypto.subtle.digest('SHA-256',bytes);
 return {uploadId:crypto.randomUUID(),...identity,clientId:undefined,entryUid,kind:'cover',ordinal:0,mimeType:'image/png',byteLength:3,
 sha256:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join(''),status:'pending',lastAttemptAt:null,lastError:null,base64:'AP8q'};
}
it.each(['invalid envelope','hash','foreign client','foreign library','foreign epoch','unknown fields','invalid base64','length','mime','duplicate image','missing bytes'])('defensive acceptance: rejects %s before publishing any rows',async(kind)=>{
 const {store,api}=await setup(); const original=create(); const media=await image(original.entityUid);
 const backup=JSON.parse(text([original],[media]));
 if(kind==='invalid envelope') backup.operations[0].payload.title=null;
 if(kind==='hash') backup.media[0].sha256='0'.repeat(64);
 if(kind==='foreign client') backup.operations[0].clientId='other';
 if(kind==='foreign library') backup.operations[0].libraryId=crypto.randomUUID();
 if(kind==='foreign epoch') backup.operations[0].syncEpoch='other';
 if(kind==='unknown fields') backup.snapshot={};
 if(kind==='invalid base64') backup.media[0].base64='!!!!';
 if(kind==='length') backup.media[0].byteLength=2;
 if(kind==='mime') backup.media[0].mimeType='text/plain';
 if(kind==='duplicate image') backup.media.push({...backup.media[0]});
 if(kind==='missing bytes') delete backup.media[0].base64;
 await expect(api.restorePendingWork!(JSON.stringify(backup))).rejects.toThrow();
 expect(await store.list()).toEqual([]); expect(await store.listMedia()).toEqual([]); store.close();
});
it('defensive acceptance: original bytes and live operation/media retry state remain unchanged on identical import',async()=>{
 const {store,api}=await setup(); const original=create(); const backup=text([original],[await image(original.entityUid)]);
 await api.restorePendingWork!(backup);
 await store.update(original.opId,{status:'conflict',lastError:'new state'});
 const upload=(await store.listMedia())[0]!; await store.updateMedia(upload.uploadId,{status:'failed',lastError:'new image state'});
 const result=await api.restorePendingWork!(backup);
 expect(result).toMatchObject({addedOperations:0,addedMedia:0,identicalOperations:1,identicalMedia:1});
 expect(await store.list()).toEqual([{...original,status:'conflict',lastError:'new state'}]);
 expect((await store.listMedia())[0]).toMatchObject({status:'failed',lastError:'new image state'}); store.close();
});
it('defensive acceptance: real transaction abort after an insert leaves operations, media and snapshot unchanged',async()=>{
 const {store,api,snapshot}=await setup(); const original=create(); const backup=text([original,create()],[await image(original.entityUid)]);
 const add=IDBObjectStore.prototype.add; let inserts=0;
 const spy=vi.spyOn(IDBObjectStore.prototype,'add').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['add']>){
  const request=add.apply(this,args);
  if(this.name==='outbox') inserts++;
  if(this.name==='mediaOutbox') request.onsuccess=()=>this.transaction.abort();
  return request;
 });
 try {
  await expect(api.restorePendingWork!(backup)).rejects.toThrow();
  expect(inserts).toBe(2); expect(await store.list()).toEqual([]); expect(await store.listMedia()).toEqual([]);
  expect(await store.readGeneration(1)).toBe(JSON.stringify(snapshot));
 } finally {spy.mockRestore();store.close();}
});
it.each(['restore-first','enqueue-first'])('defensive acceptance: two-instance collision serializes %s against the latest queue',async(order)=>{
 const {store,databaseName}=await setup();
 const peer=createIndexedDbOfflineStore({indexedDB,databaseName}); await peer.list();
 await store.bindPendingWorkClient(identity.clientId);
 const original=create(); const changed={...original,payload:{...original.payload,title:'live changed'}};
 const independent=create(); const work=await preparePendingWork(text([original,independent]));
 const promises=order==='restore-first'
  ? [store.restorePendingWork(work,identity.clientId,true),peer.enqueue(changed)]
  : [peer.enqueue(changed),store.restorePendingWork(work,identity.clientId,true)];
 const results=await Promise.allSettled(promises);
 expect(results.map(result=>result.status)).toEqual(['fulfilled','rejected']);
 const rows=await peer.list();
 expect(rows).toEqual(order==='restore-first'?[original,independent]:[changed]);
 expect(await peer.listMedia()).toEqual([]); store.close();peer.close();
});
it('defensive acceptance: refuses orphan and out-of-order creation dependencies across the whole union',async()=>{
 const {store,api}=await setup(); const parent=create();
 const child=createPendingSyncOperation({...identity,entityKind:'entry',entityUid:parent.entityUid,operationKind:'entry.update',baseVersion:0,
 baseValues:{title:'Saved'},payload:{title:'Edited',parentCreateOpId:parent.opId}});
 await expect(api.restorePendingWork!(text([child,parent]))).rejects.toThrow(/parent/);
 await expect(api.restorePendingWork!(text([child]))).rejects.toThrow();
 await api.restorePendingWork!(text([parent,child])); expect(await store.list()).toEqual([parent,child]); store.close();
});
it('defensive acceptance: restores complete new Tag/Facet dependent placement and rejects foreign-kind dependencies',async()=>{
 const {store,api,snapshot}=await setup();
 const sectionUid=crypto.randomUUID(); const facetUid=crypto.randomUUID(); const tagUid=crypto.randomUUID();
 snapshot.payload.tagGroups=[{id:2,syncUid:sectionUid,entryType:'game',name:'Tags',groupKind:'section',parentId:null,sortOrder:0}];
 snapshot.payload.entryTagLayouts=[{entryType:'game',syncUid:crypto.randomUUID(),syncVersion:4}];
 await store.writeGeneration(1,JSON.stringify(snapshot));
 const parent=create();
 const facet=createPendingSyncOperation({...identity,entityKind:'entry_facet',entityUid:facetUid,operationKind:'entry.facet.create',baseVersion:4,baseValues:{entryType:'game',sectionUid},payload:{entryType:'game',sectionUid,name:'Mood'}});
 const tag=createPendingSyncOperation({...identity,entityKind:'entry_tag',entityUid:tagUid,operationKind:'entry.tag.create',baseVersion:0,baseValues:{},payload:{name:'Bright'}});
 const child=createPendingSyncOperation({...identity,entityKind:'entry',entityUid:parent.entityUid,operationKind:'entry.tags.set',baseVersion:0,
 baseValues:{tags:[]},payload:{parentCreateOpId:parent.opId,tags:[{name:'Bright',tagUid,facetUid}],tagCreates:[{tagUid,createOpId:tag.opId}],facetCreates:[{facetUid,createOpId:facet.opId}]}});
 const bad={...child,payload:{...child.payload,tagCreates:[{tagUid,createOpId:facet.opId}]}};
 await expect(api.restorePendingWork!(text([parent,facet,tag,bad]))).rejects.toThrow(/parent/);
 expect(await store.list()).toEqual([]);
 await api.restorePendingWork!(text([parent,facet,tag,child]));expect(await store.list()).toEqual([parent,facet,tag,child]);store.close();
});
it('defensive acceptance: empty files are explicit harmless no-ops and unsupported composed stores expose no restore methods',async()=>{
 const {store,api}=await setup(); expect(await api.restorePendingWork!(text([]))).toMatchObject({addedOperations:0,addedMedia:0,scope:expect.stringMatching(/Empty/)});
 const unsupported=createOfflineAwareGalleryApi({assetUrl:(p:string)=>p} as GalleryApi,{readMeta:store.readMeta,writeMeta:store.writeMeta,readGeneration:store.readGeneration,writeGeneration:store.writeGeneration,deleteGeneration:store.deleteGeneration,listGenerationIds:store.listGenerationIds},{clientId:identity.clientId});
 expect(unsupported.restorePendingWork).toBeUndefined(); store.close();
});

