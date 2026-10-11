// Collection03 acceptance only. REAL TLS/pairing/file SQLite; CONTRACT MOCKED business replay, SQL receipts=0.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createTempFileDatabase } from '../../src/database/testing.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createApiApp } from '../../src/http/app.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { collectionCommonTagContext } from '../../src/sync/collection-common-tag.js';
import { collectionDeleteIdentity } from '../../src/sync/collection-delete.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { createCollection, addCollectionEntry } from '../../src/repositories/collection-repository.js';
import { startSecurePairingListener, privateHttpsHost } from '../../src/http/secure-pairing.js';
import { createPendingSyncOperation, type PendingSyncOperationInput } from '../../../web/src/offline/outbox-store.js';
import { mutationQueuePlan, originalMutationEnvelope } from '../../../web/src/offline/sync-mutation-plan.js';
import { syncReplayOperationSchema, syncReplayResultSchema, commonTagCounts, commonTagTargets } from '@t3/shared';
import { validateCommonTagReceipt } from '../../../web/src/offline/collection-common-tag.js';
import { validateCollectionDeleteReceipt } from '../../../web/src/offline/collection-delete.js';
const address=Object.values(networkInterfaces()).flat().find(item=>{if(!item || item.family!=='IPv4' || item.internal)return false;try{privateHttpsHost(item.address);return true;}catch{return false;}})?.address;
if(!address)throw new Error('Actual private IPv4 required');
const directory=await mkdtemp(join(tmpdir(),'t3-c03-'));
const disposable=createTempFileDatabase();const database=disposable.database;applyAllMigrations(database);
const assetRoot=join(directory,'assets');await mkdir(assetRoot);
createSection(database,{entryType:'Comic',name:'Tags'});
const work=createEntry(database,{title:'Target',type:'Comic'});
const independent=createEntry(database,{title:'Independent',type:'Comic'});
const root=createCollection(database,{kind:'entry',title:'Shelf',galleryType:'Comic'});
addCollectionEntry(database,root.id,work.id);
const context=collectionCommonTagContext(database,root.id,'Native tag');
const deletionContext=collectionDeleteIdentity(database,root.id)!;
const workIdentity=database.prepare('SELECT sync_uid AS uid,sync_version AS version FROM entries WHERE id=?').get(work.id) as {uid:string;version:number};
const otherIdentity=database.prepare('SELECT sync_uid AS uid,sync_version AS version FROM entries WHERE id=?').get(independent.id) as {uid:string;version:number};
const app=createApiApp(database,{assetRoot,dataDir:directory});
const identity=getSyncIdentity(database),clientId=randomUUID();
let mode:Record<string,unknown>={},mutations:string[]=[],preflights=0,seq=0;
const receipts=new Map<string,unknown>();
function receiptFor(op:ReturnType<typeof syncReplayOperationSchema.parse>){
 const value:Record<string,unknown>={opId:op.opId,status:'applied',resourceVersion:op.baseVersion+1,serverSeq:++seq,entityId:op.entityKind==='collection'?root.id:independent.id};
 if(op.operationKind==='collection.common-tag.add'){
  const journal=commonTagTargets(op.baseValues).map(row=>({entityKind:'entry',id:work.id,syncUid:row.syncUid,resourceVersion:row.syncVersion+1,serverSeq:++seq}));
  journal.push({entityKind:'collection',id:root.id,syncUid:op.entityUid,resourceVersion:op.baseVersion+1,serverSeq:++seq});
  value.serverSeq=seq;value.collectionCommonTag={tagId:1,tagUid:op.payload.tagUid,...commonTagCounts(op.baseValues),journal};
 }
 if(op.operationKind==='collection.delete')value.collectionDeleteJournal=[{id:root.id,syncUid:op.entityUid,resourceVersion:op.baseVersion+1,serverSeq:value.serverSeq},...op.baseValues.children.map((row,index)=>({id:root.id+index+1,syncUid:row.syncUid,resourceVersion:row.syncVersion+1,serverSeq:++seq}))];
 if(op.operationKind==='collection.delete')value.serverSeq=seq;
 const parsed=syncReplayResultSchema.parse(value);
 if(parsed.status!=='applied')throw new Error('Expected applied');
 if(op.operationKind==='collection.common-tag.add')validateCommonTagReceipt(op,parsed);
 if(op.operationKind==='collection.delete')validateCollectionDeleteReceipt(op,parsed);
 return parsed;
}
const runtime=await startSecurePairingListener({configDirectory:join(directory,'auth'),libraryId:identity.libraryId,hostname:address,advertisedHost:address,port:0,fetch:async(request:Request)=>{
 const path=new URL(request.url).pathname;
 if(path==='/api/sync/capabilities'){
  preflights++;const response=await app.fetch(request);const caps=await response.json() as {featureFlags:Record<string,boolean>};
  if(mode.flag){if(mode.absent)delete caps.featureFlags[String(mode.flag)];else caps.featureFlags[String(mode.flag)]=false;}
  return Response.json(caps,{status:response.status});
 }
 if(path==='/api/sync/replay'){
  const body=await request.text();mutations.push(body);const op=syncReplayOperationSchema.parse(JSON.parse(body));
  const receipt=receipts.get(op.opId)??receiptFor(op);receipts.set(op.opId,receipt);
  const fault=structuredClone(receipt) as Record<string,unknown>;
  if(mode.fault===op.opId){
   if(mode.variant==='foreign')fault.opId=randomUUID();
   else if(mode.variant==='shape')delete fault.collectionCommonTag;
   else fault.collectionCommonTag.journal[0].syncUid=randomUUID();
   return Response.json(fault);
  }
  if(mode.lose===op.opId){delete mode.lose;const bytes=JSON.stringify(receipt);return new Response(bytes.slice(0,8),{headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(bytes)+100),'connection':'close'}});}
  return Response.json(receipt);
 }
 return app.fetch(request);
}});
const output=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');output(runtime.issue());
try{
 for await(const line of createInterface({input:process.stdin})){
  const cmd=JSON.parse(line) as Record<string,unknown>;
  if(cmd.action==='timeline'){
   const common={clientId,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,entityKind:'collection' as const,entityUid:context.syncUid};
   const make=(operationKind:string,baseVersion:number,baseValues:unknown,payload:unknown)=>createPendingSyncOperation({...common,operationKind,baseVersion,baseValues,payload} as PendingSyncOperationInput);
   const entry=createPendingSyncOperation({clientId,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,entityKind:'entry',entityUid:otherIdentity.uid,operationKind:'entry.update',baseVersion:otherIdentity.version,baseValues:{title:'Independent'},payload:{title:'Advanced'}});
   const chain=cmd.kind==='chain';
   // Local-origin timeline is CONTRACT MOCKED: canonical source supplies scope/member/facet identities, not canonical SQL replay.
   const create=make('collection.create',0,{}, {kind:'entry',title:'Shelf',description:'',nsfw:false,parentUid:null,galleryType:'Comic'});
   const member=make('collection.entry.set',1,{entryUid:workIdentity.uid,present:false},{entryUid:workIdentity.uid,present:true});
   const bulk=make('collection.common-tag.add',chain?2:context.syncVersion,context.baseValues,{name:'Native tag',tagUid:context.baseValues.tag?.syncUid??randomUUID()});
   const deletion=make('collection.delete',chain?3:cmd.kind==='bulk'?context.syncVersion+1:deletionContext.syncVersion,deletionContext.scope,{});
   const rows=chain?[create,member,bulk,deletion,entry]:cmd.kind==='delete'?[deletion]:[bulk,deletion,entry];
   const plans=mutationQueuePlan(rows);
   const packets=rows.map(row=>{const op=originalMutationEnvelope(row);syncReplayOperationSchema.parse(op);const plan=plans.get(row.opId)!;if(!plan.eligible)throw new Error('Illegal production plan');return {body:JSON.stringify(op),plan};});
   output({packets,businessReceiptsMocked:true,canonicalContext:context});
  }else if(cmd.action==='mode'){mode=cmd;mutations=[];preflights=0;output({ok:true});}
  else if(cmd.action==='counters')output({mutations,preflights,mockReceipts:receipts.size,sqlReceipts:(database.prepare('SELECT COUNT(*) AS n FROM sync_operation_receipts').get() as {n:number}).n});
  else if(cmd.action==='close')break;
 }
}finally{await runtime.close();disposable.cleanup();await rm(directory,{recursive:true,force:true});}
