// Bounded Author02 Worker fixture. Real TLS/pairing/temp migrated SQL; BUSINESS REPLAY RECEIPTS MOCKED.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createTempFileDatabase } from '../../src/database/testing.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createApiApp } from '../../src/http/app.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { startSecurePairingListener, privateHttpsHost } from '../../src/http/secure-pairing.js';
import { createPendingSyncOperation } from '../../../web/src/offline/outbox-store.js';
import { mutationQueuePlan, originalMutationEnvelope } from '../../../web/src/offline/sync-mutation-plan.js';
import { syncReplayOperationSchema, syncReplayResultSchema } from '@t3/shared';
const address=Object.values(networkInterfaces()).flat().find(item=>{if(!item || item.family!=='IPv4' || item.internal)return false;try{privateHttpsHost(item.address);return true;}catch{return false;}})?.address;
if(!address)throw new Error('Actual private IPv4 required');
const directory=await mkdtemp(join(tmpdir(),'t3-author-timeline-'));
const disposable=createTempFileDatabase();const database=disposable.database;applyAllMigrations(database);
const assetRoot=join(directory,'assets');await mkdir(assetRoot);
const app=createApiApp(database,{assetRoot,dataDir:directory});
const identity=getSyncIdentity(database),clientId=randomUUID(),producerUid=randomUUID(),directoryUid=randomUUID(),collectionUid=randomUUID(),entryUid=randomUUID();
let mode:Record<string,unknown>={},mutations:string[]=[],preflights=0;
const receipts=new Map<string,unknown>();
const runtime=await startSecurePairingListener({configDirectory:join(directory,'auth'),libraryId:identity.libraryId,hostname:address,advertisedHost:address,port:0,fetch:async(request:Request)=>{
 const path=new URL(request.url).pathname;
 if(path==='/api/sync/capabilities'){
  preflights++;const response=await app.fetch(request);const caps=await response.json() as {featureFlags:Record<string,boolean>};
  if(mode.flag){if(mode.absent)delete caps.featureFlags[String(mode.flag)];else caps.featureFlags[String(mode.flag)]=false;}
  return Response.json(caps,{status:response.status});
 }
 if(path==='/api/sync/replay'){
  const body=await request.text();mutations.push(body);const op=syncReplayOperationSchema.parse(JSON.parse(body));
  // Store genuine strict contract-mock receipt before simulating a lost HTTP response.
  const receipt=receipts.get(op.opId) ?? syncReplayResultSchema.parse({opId:op.opId,status:'applied',resourceVersion:op.baseVersion+1,serverSeq:receipts.size+1});
  receipts.set(op.opId,receipt);
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
   const common={clientId,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch};
   const kind=String(cmd.kind);let first;
   if(kind==='profile')first=createPendingSyncOperation({...common,entityKind:'producer',entityUid:producerUid,operationKind:'producer.update',baseVersion:4,baseValues:{name:'Before'},payload:{name:'After'}});
   else if(kind==='directory')first=createPendingSyncOperation({...common,entityKind:'author_directory_set',entityUid:directoryUid,operationKind:'author.directories.set',baseVersion:71,baseValues:{directories:[]},payload:{directories:[{syncUid:randomUUID(),title:'Ordinary directory',description:'',sortOrder:0,entries:[]}]}});
   else if(kind==='collection')first=createPendingSyncOperation({...common,entityKind:'collection',entityUid:collectionUid,operationKind:'collection.producer.set',baseVersion:91,baseValues:{producerUid,present:false},payload:{producerUid,present:true}});
   else throw new Error('Unknown bounded timeline');
   const deletion=createPendingSyncOperation({...common,entityKind:'producer',entityUid:producerUid,operationKind:'producer.delete',baseVersion:kind==='profile'?5:4,baseValues:{},payload:{}});
   const independent=createPendingSyncOperation({...common,entityKind:'entry',entityUid:entryUid,operationKind:'entry.update',baseVersion:2,baseValues:{title:'Entry before'},payload:{title:'Entry after'}});
   const rows=[first,deletion,independent];
   // Explicit trusted binding supplied to production planner; not UID equality or cross-kind version ordering.
   const directoryOwners=kind==='directory'?new Map([[first.opId,`producer:${producerUid}`]]):new Map<string,string>();
   const plans=mutationQueuePlan(rows,directoryOwners);
   const packets=rows.map(row=>{const op=originalMutationEnvelope(row);syncReplayOperationSchema.parse(op);const plan=plans.get(row.opId)!;if(!plan.eligible)throw new Error('Illegal timeline plan');return {body:JSON.stringify(op),plan};});
   if(!plans.get(deletion.opId)!.dependencies.includes(first.opId))throw new Error('Production planner omitted required predecessor');
   output({packets,directoryOwners:Object.fromEntries(directoryOwners),businessReceiptsMocked:true});
  }else if(cmd.action==='mode'){mode=cmd;mutations=[];preflights=0;output({ok:true});}
  else if(cmd.action==='counters')output({mutations,preflights,mockReceipts:receipts.size,sqlReceipts:(database.prepare('SELECT COUNT(*) AS n FROM sync_operation_receipts').get() as {n:number}).n});
  else if(cmd.action==='close')break;
 }
}finally{await runtime.close();disposable.cleanup();await rm(directory,{recursive:true,force:true});}
