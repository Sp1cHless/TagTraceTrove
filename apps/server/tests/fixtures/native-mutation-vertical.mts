import { createRequire } from 'node:module';
import { nativeMutationContract } from '@t3/shared';
import { randomUUID } from 'node:crypto';
import { createProducer } from '../../src/repositories/producer-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createSection, createFacet } from '../../src/repositories/layout-repository.js';
import type { T3Database } from '../../src/database/connection.js';
import type { createApiApp } from '../../src/http/app.js';
export async function createMutationVertical(database:T3Database,app:ReturnType<typeof createApiApp>) {
 createEntry(database,{title:'Seed native Gallery',type:'comic'});
 const producer=createProducer(database,{name:'Independent native Author'});
 const section=createSection(database,{entryType:'comic',name:'Native section'});
 const facet=createFacet(database,{sectionId:section.id,name:'Native facet'});
 const web='../../../web/src/';
 const {createApiClient}=await import(web+'api/client.ts');const {createGalleryApi}=await import(web+'api/gallery.ts');
 const {createOfflineAwareGalleryApi}=await import(web+'offline/offline-api.ts');const {createIndexedDbOfflineStore}=await import(web+'offline/indexeddb-snapshot-store.ts');
 const {createNativeTransfers}=await import(web+'offline/native-background-transfer.ts');
 const require=createRequire(new URL('../../../web/package.json',import.meta.url));const {IDBFactory}=require('fake-indexeddb');const indexedDB=new IDBFactory(),name='mutation-native-'+randomUUID();
 let store=createIndexedDbOfflineStore({indexedDB,databaseName:name});const retryBodies:string[]=[];let acks=0;
 const online=createGalleryApi(createApiClient({baseUrl:'http://fixture/api/',fetchImplementation:async(input:RequestInfo|URL,init?:RequestInit)=>{
  const request=new Request(input,init);if(request.url.endsWith('/sync/replay'))retryBodies.push(await request.clone().text());if(request.url.endsWith('/sync/ack'))acks++;return app.fetch(request);
 }}),'http://fixture');
 await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot({media:'none'})));await store.writeMeta('activeGeneration','1');await store.writeMeta('snapshotMediaMode','none');
 const baseline=(await store.captureSnapshot()).active.snapshot.payload;
 const api=createOfflineAwareGalleryApi(online,store);await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot();
 await api.enqueueOfflineEntryCreate({title:'Native dependent owner',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});
 const local=(await api.listPendingOfflineEntryCreates())[0].localKey;
 await api.enqueueOfflinePendingEntryMetadata(local,{title:'Native edited owner',uploadDate:null,pageCount:null});
 await api.enqueueOfflinePendingEntryAuthorCreate(local,'Native new Author');
 await api.enqueueOfflinePendingEntryFacetCreate(local,'New native Facet',section.id);
 await api.enqueueOfflinePendingEntryTagCreate(local,'New native Tag',facet.id);
 await api.updateAuthor(producer.id,{name:'Independent native Author edited'});
 await api.createAuthorDirectory(producer.id,{title:'Native Directory'});
 await api.createCollection({kind:'entry',title:'Native Collection'});
 const jobs:Array<Record<string,unknown>>=[];
 await createNativeTransfers(store,{async call(method:string,args:Record<string,unknown>){if(method==='status')return {protocolVersion:1,planVersion:1,operationKinds:Object.keys(nativeMutationContract)};if(method==='stageOperation')jobs.push({...args});return {};}}).handoff();
 const pending=await store.list();if(jobs.length!==pending.length)throw new Error('Not every real facade operation handed off: '+jobs.length+'/'+pending.length);
 return {payload:{jobs,pendingOperations:pending.length,kinds:pending.map((row:{operationKind:string})=>row.operationKind)},async foreground(){
  store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName:name});const before=await store.list();const cold=createOfflineAwareGalleryApi(online,store);await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox();
  const active=(await store.captureSnapshot()).active;const after=await store.list();
  return {baselineProducerCount:baseline.producers.length,baselineFacetCount:baseline.tagGroups.filter((row:{groupKind:string})=>row.groupKind==='facet').length,beforeOperations:before.length,afterOperations:after.length,originalUnchanged:JSON.stringify(before)===JSON.stringify(pending),originalBodyRetry:retryBodies.length===jobs.length && retryBodies.every((body,index)=>body===jobs[index].body),acks,pendingAck:await store.readMeta('pendingSnapshotAck'),kinds:pending.map((row:{operationKind:string})=>row.operationKind),ownerTitle:active.snapshot.payload.entries.find((row:{title:string})=>row.title==='Native edited owner')?.title,producerCount:active.snapshot.payload.producers.length,facetCount:active.snapshot.payload.tagGroups.filter((row:{groupKind:string})=>row.groupKind==='facet').length,tagCount:active.snapshot.payload.tags.length,collectionCount:active.snapshot.payload.collections.length,directoryCount:active.snapshot.payload.authorDirectories.length};
 },close(){store.close();}};
}
